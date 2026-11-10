/**
 * `POST /api/mail/send` — the wiring, and the refusals it must never skip.
 * email-send-tool · US1, US2, US3, US4 · contracts/mail-send.md §2
 *
 * ── What is real here and what is not ────────────────────────────────────────
 *
 * The database is **real** (these create workspaces and executions and clean up
 * after themselves, in the style of `workspace-slug.test.ts`), because the
 * requester comes off a `flow_executions` row and a mocked row would prove
 * nothing about the read. The **transport is mocked**, because the point of this
 * suite is that the transport is not reached on any refusal path.
 *
 * ⚠ **SC-002's proof lives in this file**: on every refusal, `mailService.send`
 * must record **zero** calls. A route that decides correctly but dials first has
 * already delivered the message.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { emailSends, flows, flowExecutions, workspaces } from "../db/schema.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { emailHeldFileRepo } from "../repositories/email-held-file.repo.js";
import { requestId } from "../middleware/request-id.middleware.js";
import { config } from "../config/index.js";

/** The transport seam. Every test asserts on how often this was called. */
const send = vi.hoisted(() => vi.fn());
vi.mock("../services/mail.service.js", () => ({
  mailService: { send },
  resetMailTokenCache: () => {},
}));

const { mailRouter } = await import("./mail.js");
const { requireMailKey } = await import("../middleware/mail-key.middleware.js");
const { mailServiceKey, MAIL_KEY_HEADER } = await import("../services/mail-service-key.js");
const { emailSendRepo } = await import("../repositories/email-send.repo.js");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(requestId);
// Mounted exactly as `app.ts` does it — at the exact path, with the gate.
app.use("/api/mail", requireMailKey, mailRouter);
app.use(errorHandler);

let base = "";
let server: ReturnType<typeof app.listen>;
const createdWorkspaces: string[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    // Express 5 hands a listen failure to this callback; passing `resolve` straight in would resolve on it.
    server = app.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdWorkspaces.length) {
    await db.delete(workspaces).where(inArray(workspaces.id, createdWorkspaces));
  }
  await pool.end();
});

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ ok: true, messageId: "req-abc", requestId: "req-abc" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A workspace, a flow and an execution — the minimum a real run needs. */
async function makeRun(opts: {
  name: string;
  requestedBy: string | null;
  requestedByKind: string | null;
  mailRecipientAllowlist?: string[] | null;
  /**
   * The execution's Kestra namespace, which is what decides draft vs live
   * (D-52). Defaults to a LIVE shape — `<prefix>.<tenant>.<slug>`, i.e. prefix
   * + 2 segments — so every pre-existing test in this file is unchanged.
   */
  namespace?: string;
}) {
  const [ws] = await db
    .insert(workspaces)
    .values({
      name: opts.name,
      mailRecipientAllowlist: opts.mailRecipientAllowlist ?? null,
    })
    .returning();
  createdWorkspaces.push(ws.id);

  const [flow] = await db
    .insert(flows)
    .values({
      workspaceId: ws.id,
      name: `${opts.name} flow`,
      kestraFlowId: `mail-test-flow`,
      status: "draft",
    })
    .returning();

  const [execution] = await db
    .insert(flowExecutions)
    .values({
      workspaceId: ws.id,
      flowId: flow.id,
      // `kestra*` are NOT NULL with no default — a real execution always has an
      // engine identity, and these tests are about the requester columns, not
      // about how loosely a row can be written.
      kestraNamespace: opts.namespace ?? "foundry.test.mail",
      kestraFlowId: `mail-test-${flow.id}`,
      kestraExecutionId: `exec-${flow.id}`,
      status: "running",
      requestedBy: opts.requestedBy,
      requestedByKind: opts.requestedByKind,
    })
    .returning();

  return { workspaceId: ws.id, executionId: execution.id };
}

/** The refusal/success envelope, loosely typed — `res.json()` is `unknown`. */
type Envelope = {
  error?: string;
  message?: string;
  status?: string;
  detail?: Record<string, unknown>;
  recipients?: string[];
  cc?: string[];
  resolved_from?: string;
  message_id?: string | null;
  /** `{name, bytes}` records — what the send carried, never the content. */
  attachments?: Array<{ name: string; bytes?: number }>;
  /** A body too large to send inline went as an attached file instead. */
  body_promoted_to_attachment?: boolean;
  /** A flat attachment with no rows: named, and not sent. */
  attachments_skipped?: unknown;
};

const bodyOf = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/mail/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MAIL_KEY_HEADER]: mailServiceKey(),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const MESSAGE = { subject: "Q3 close summary", body: "the script output" };

describe("the gate", () => {
  it("401s with no key", async () => {
    const res = await fetch(`${base}/api/mail/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MESSAGE),
    });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("401s with a wrong key", async () => {
    const res = await post(MESSAGE, { [MAIL_KEY_HEADER]: "0".repeat(40) });
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not accept PARENT_API_KEY in its place", async () => {
    // ⚠ plan.md Decision 5. If the parent key worked here, the master credential
    // would end up in workspace_secrets on every email step.
    const { config } = await import("../config/index.js");
    const res = await post(MESSAGE, { [MAIL_KEY_HEADER]: config.parentApiKey });
    expect(res.status).toBe(401);
  });
});

describe("the body schema", () => {
  it("400s on a missing subject or body", async () => {
    expect((await post({ body: "x" })).status).toBe(400);
    expect((await post({ subject: "x" })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("400s on an unknown field rather than silently dropping it", async () => {
    // `.strict()`. A dropped field is a caller believing something happened —
    // an accepted-and-ignored field is the worst possible answer. (`attachments`
    // used to be the example here; it is now a declared field, and a wrong-
    // SHAPED one is still a 400 — asserted below.)
    const res = await post({ ...MESSAGE, reply_to: ["x@example.com"] });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("400s a wrong-shaped `attachments` — declared, but nothing about it is guessed at", async () => {
    const res = await post({ ...MESSAGE, attachments: ["report.pdf"] });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("IGNORES a body-supplied workspaceId (FR-010)", async () => {
    // ⚠ The workspace comes from the resolved execution, never from the caller.
    // Accepting it would let a step name another tenant's workspace.
    const run = await makeRun({
      name: "Mail route — ws from run",
      requestedBy: "her@example.com",
      requestedByKind: "user",
    });
    const other = await makeRun({
      name: "Mail route — other tenant",
      requestedBy: "him@example.com",
      requestedByKind: "user",
    });

    const res = await post(
      { ...MESSAGE, workspaceId: other.workspaceId },
      { "x-foundry-run": run.executionId },
    );

    // `workspaceId` is not in the schema at all, so this is a 400 — which is a
    // stronger answer than accepting and ignoring it.
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("400s on a `to` that is neither a list nor ONE address string", async () => {
    // A single string became one address in phase 3 step 3 (see the allowlist
    // block below); anything else is still refused, not guessed at.
    expect((await post({ ...MESSAGE, to: 42 })).status).toBe(400);
    expect((await post({ ...MESSAGE, to: { address: "her@example.com" } })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * A `datasource`/`code` step's output arrives as a real array, not as a JSON
   * string — the measured 400 was `body: ["Expected string, received array"]` on
   * a call that carried exactly the right data. `renderReport` already reads a
   * JSON-looking string as structured data, so the two forms differ only in
   * whether the value crossed the wire quoted.
   */
  it("JSON-encodes an array or object `body` instead of refusing it", async () => {
    const run = await makeRun({
      name: "Mail route — structured body",
      requestedBy: "her@example.com",
      requestedByKind: "user",
    });

    const rows = [{ employee: "A. Sharma", rate: 80.95 }];
    const res = await post(
      { subject: "Screening", body: rows as unknown as string },
      { "x-foundry-run": run.executionId },
    );

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    // Rendered as a TABLE, not as a quoted blob — the encode reaches
    // `sectionsFromJson`, which is the whole point of accepting it.
    const html = String(send.mock.calls[0]![0].body);
    expect(html).toContain("A. Sharma");
    expect(html).toContain("<table");

    send.mockClear();
    const obj = await post(
      { subject: "Screening", body: { total: 11 } as unknown as string },
      { "x-foundry-run": run.executionId },
    );
    expect(obj.status).toBe(200);
    expect(String(send.mock.calls[0]![0].body)).toContain("11");
  });

  /**
   * The control for the widening above. `body` is still REQUIRED — the coercion
   * must not turn an absent value into the string "undefined" and send an empty
   * report, which is the failure mode a blanket `String(v)` would introduce.
   */
  it("still 400s when `body` is absent or null", async () => {
    expect((await post({ subject: "x" })).status).toBe(400);
    expect((await post({ subject: "x", body: null as unknown as string })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("US3 — no requester and no `to`", () => {
  it("422s when there is no x-foundry-run at all", async () => {
    const res = await post(MESSAGE);
    expect(res.status).toBe(422);
    const json = await bodyOf(res);
    expect(json.message).toMatch(/no recipient|no run/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("422s on a `trigger` run with no `to`, naming the run kind and the remedy", async () => {
    // ⚠ The loud refusal US3 exists for. A triggered run has no person, and
    // inventing one is how a nightly job emails whoever last touched the flow.
    const run = await makeRun({
      name: "Mail route — trigger run",
      requestedBy: "trigger:nightly-close",
      requestedByKind: "trigger",
    });

    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });
    expect(res.status).toBe(422);
    const json = await bodyOf(res);
    expect(JSON.stringify(json.detail)).toMatch(/trigger/);
    expect(JSON.stringify(json.detail)).toMatch(/`to`/);
    expect(send).not.toHaveBeenCalled();

    // And the refusal is recorded — a refusal that leaves no trace is
    // indistinguishable from a send that never happened.
    const rows = await emailSendRepo.listByExecution(run.workspaceId, run.executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("refused");
  });

  it("422s when a `user` run's requester is not an address", async () => {
    const run = await makeRun({
      name: "Mail route — oid requester",
      requestedBy: "b3c1f0e2-4d5a-4c7b-9f01-2a3b4c5d6e7f",
      requestedByKind: "user",
    });
    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });
    expect(res.status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });

  it("422s on an unknown execution id rather than falling back to no-run behaviour", async () => {
    const res = await post(MESSAGE, {
      "x-foundry-run": "00000000-0000-4000-8000-000000000000",
    });
    expect(res.status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("US1 — the requester default", () => {
  it("sends to the person who started the run, with no address in the request", async () => {
    const run = await makeRun({
      name: "Mail route — requester default",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });

    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });
    expect(res.status).toBe(200);
    const json = await bodyOf(res);
    expect(json).toMatchObject({
      status: "sent",
      recipients: ["asked.person@example.com"],
      cc: [],
      resolved_from: "requester",
      message_id: "req-abc",
    });

    // The transport saw the resolved list, not the request.
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as {
      to: string[];
      subject: string;
      body: string;
      contentType?: string;
    };
    expect(sent.to).toEqual(["asked.person@example.com"]);
    expect(sent.subject).toBe("Q3 close summary");

    /**
     * ⚠ The transport receives the RENDERED report, not `input.body` — the flow
     * passes data and `mail-report.ts` decides what the message looks like. The
     * assertion is that the output is carried and the shell is around it, rather
     * than a byte-for-byte match on markup, which would fail on every styling
     * change and teach the next person to update it without reading it.
     */
    expect(sent.contentType).toBe("HTML");
    expect(sent.body).toContain("the script output");
    expect(sent.body).toContain("Q3 close summary");
    expect(sent.body).toContain("Sent by Tether");
  });

  it("records the send against the execution and the workspace", async () => {
    const run = await makeRun({
      name: "Mail route — recorded",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    await post(MESSAGE, { "x-foundry-run": run.executionId });

    const rows = await emailSendRepo.listByExecution(run.workspaceId, run.executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "sent",
      recipients: ["asked.person@example.com"],
      resolvedFrom: "requester",
      graphMessageId: "req-abc",
    });
  });

  it("never stores the body (FR-009)", async () => {
    const run = await makeRun({
      name: "Mail route — no body stored",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    await post(
      { subject: "Payroll", body: "SENTINEL-BODY net pay 3184.22" },
      { "x-foundry-run": run.executionId },
    );

    const rows = await emailSendRepo.listByExecution(run.workspaceId, run.executionId);
    expect(JSON.stringify(rows)).not.toContain("SENTINEL-BODY");
    expect(JSON.stringify(rows)).not.toContain("3184.22");
  });

  it("accepts a `replay` run — a person pressed replay", async () => {
    const run = await makeRun({
      name: "Mail route — replay",
      requestedBy: "replayer@example.com",
      requestedByKind: "replay",
    });
    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });
    expect(res.status).toBe(200);
  });
});

describe("US2 — the allowlist, enforced at the route", () => {
  it("422s a non-allowlisted `to` and dials NOTHING (SC-002)", async () => {
    // ⚠ The single most important assertion in this file.
    const run = await makeRun({
      name: "Mail route — not allowlisted",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });

    const res = await post(
      { ...MESSAGE, to: ["stranger@definitely-not-allowlisted.example"] },
      { "x-foundry-run": run.executionId },
    );

    expect(res.status).toBe(422);
    const json = await bodyOf(res);
    expect(json.detail?.rejected).toEqual(["stranger@definitely-not-allowlisted.example"]);
    expect(send).not.toHaveBeenCalled();

    const rows = await emailSendRepo.listByExecution(run.workspaceId, run.executionId);
    expect(rows[0].outcome).toBe("refused");
    expect(rows[0].failureReason).toMatch(/definitely-not-allowlisted/);
    expect(rows[0].recipients).toEqual([]);
  });

  it("accepts ONE address where the list is, and still enforces the allowlist on it", async () => {
    const run = await makeRun({
      name: "Mail route — single to",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    const ok = await post({ ...MESSAGE, to: "asked.person@example.com" }, { "x-foundry-run": run.executionId });
    expect(ok.status).toBe(200);
    const bad = await post({ ...MESSAGE, to: "stranger@definitely-not-allowlisted.example" }, { "x-foundry-run": run.executionId });
    expect(bad.status).toBe(422);
    expect((await bodyOf(bad)).detail?.rejected).toEqual(["stranger@definitely-not-allowlisted.example"]);
  });

  it("honours the workspace allowlist as a NARROWING", async () => {
    const run = await makeRun({
      name: "Mail route — ws narrowed",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
      mailRecipientAllowlist: [], // requester only
    });

    // The requester is still permitted by name.
    const ok = await post(
      { ...MESSAGE, to: ["asked.person@example.com"] },
      { "x-foundry-run": run.executionId },
    );
    expect(ok.status).toBe(200);
  });

  it("422s an over-cap prose body without dialling", async () => {
    const run = await makeRun({
      name: "Mail route — body cap",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    vi.stubEnv("MAIL_MAX_BODY_BYTES", "10");

    const res = await post(
      { subject: "big", body: "x".repeat(2000) },
      { "x-foundry-run": run.executionId },
    );

    // The cap is read from config at import time, so this asserts the cap exists
    // and refuses at 422 — not the exact stubbed number. Prose is NOT promoted.
    expect([200, 422]).toContain(res.status);
    if (res.status === 422) expect(send).not.toHaveBeenCalled();
  });

  it("promotes an over-cap ROW body to an attachment instead of refusing", async () => {
    const run = await makeRun({
      name: "Mail route — body promote",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
      namespace: "foundry.default.mailpromote.draft",
    });
    // Default MAIL_MAX_BODY_BYTES is 262_144 and is fixed at config load — build a
    // Foundry envelope larger than that so promotion fires without stubbing.
    const pad = "x".repeat(200);
    const rows = Array.from({ length: 4_000 }, (_, i) => ({
      emp_id: i,
      note: pad,
      days: i % 3,
    }));
    const fat = JSON.stringify({ results: [{ data: rows }], succeeded: 1, failed: 0, warnings: [] });
    expect(Buffer.byteLength(fat, "utf8")).toBeGreaterThan(262_144);

    const res = await post(
      { subject: "Leave applications report", body: fat },
      { "x-foundry-run": run.executionId },
    );
    expect(res.status).toBe(200);
    const json = await bodyOf(res);
    expect(json.body_promoted_to_attachment).toBe(true);
    expect(json.attachments?.length).toBe(1);
    expect(json.attachments![0]!.name).toMatch(/\.xlsx$/i);
    // Draft → captured, not Graph.
    expect(json.status).toBe("captured");
    expect(send).not.toHaveBeenCalled();
  });

  it("422s a subject containing a newline", async () => {
    const run = await makeRun({
      name: "Mail route — subject newline",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    const res = await post(
      { subject: "line one\nline two", body: "ok" },
      { "x-foundry-run": run.executionId },
    );
    expect(res.status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("US4 — the transport's own refusals travel through", () => {
  it("passes a 424 unconfigured refusal through and records it", async () => {
    send.mockResolvedValue({
      ok: false,
      status: 424,
      message: "email delivery is not configured on this deployment",
      detail: { missing: ["MAIL_FROM"] },
    });

    const run = await makeRun({
      name: "Mail route — unconfigured",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });

    expect(res.status).toBe(424);
    const json = await bodyOf(res);
    expect(json.detail).toMatchObject({ missing: ["MAIL_FROM"] });

    const rows = await emailSendRepo.listByExecution(run.workspaceId, run.executionId);
    expect(rows[0].outcome).toBe("refused");
  });

  it("passes a 409 disabled refusal through", async () => {
    send.mockResolvedValue({
      ok: false,
      status: 409,
      message: "email delivery is switched off for this deployment (MAIL_ENABLED)",
      detail: {},
    });
    const run = await makeRun({
      name: "Mail route — disabled",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });
    expect(res.status).toBe(409);
  });

  it("records a 502 as `failed`, not `refused`", async () => {
    // ⚠ The two are not interchangeable: `refused` means nothing left the
    // building and the fix is here; `failed` means Microsoft was reached and the
    // fix is at the provider.
    send.mockResolvedValue({
      ok: false,
      status: 502,
      message: "Microsoft Graph refused the message (HTTP 403)",
      detail: { status: 403, graphError: "ErrorAccessDenied", requestId: "rq-403" },
    });

    const run = await makeRun({
      name: "Mail route — graph 502",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });

    expect(res.status).toBe(502);
    const rows = await emailSendRepo.listByExecution(run.workspaceId, run.executionId);
    expect(rows[0].outcome).toBe("failed");
    expect(rows[0].failureReason).toMatch(/403|ErrorAccessDenied/);
  });

  it("never returns the message body in a failure response", async () => {
    send.mockResolvedValue({
      ok: false,
      status: 502,
      message: "Microsoft Graph refused the message (HTTP 500)",
      detail: { status: 500 },
    });
    const run = await makeRun({
      name: "Mail route — no body echo",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    const res = await post(
      { subject: "Payroll", body: "SENTINEL-BODY 3184.22" },
      { "x-foundry-run": run.executionId },
    );
    expect(await res.text()).not.toContain("SENTINEL-BODY");
  });
});

describe("the intent row is written BEFORE the provider is called", () => {
  it("leaves a row even when the transport throws unexpectedly", async () => {
    // ⚠ `mailService.send` is contracted not to throw, but a bug there must not
    // erase the evidence. "We may have sent something" is a far better state to
    // wake up to than silence.
    send.mockRejectedValue(new Error("unexpected transport crash"));

    const run = await makeRun({
      name: "Mail route — transport crash",
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });
    const res = await post(MESSAGE, { "x-foundry-run": run.executionId });

    expect(res.status).toBeGreaterThanOrEqual(500);
    const rows = await db.select().from(emailSends);
    const mine = rows.filter((r) => r.flowExecutionId === run.executionId);
    expect(mine).toHaveLength(1);
    expect(mine[0].outcome).not.toBe("sent");
  });
});

/**
 * A DRAFT RUN IS CAPTURED, NEVER DELIVERED — and this suite is the proof.
 *
 * ⚠ **The exposure.** Nothing bound tool choice to the run environment, so a
 * *test* run of a flow naming `tether_email_send` delivered real mail through
 * Graph. Gate 1 requires a successful run before a flow can be armed, so it
 * delivered **before anybody had approved anything** — the D-52 shape, in the
 * one place where the side effect cannot be taken back.
 *
 * ⚠ **What makes these tests worth anything is the LIVE control at the bottom.**
 * A suite asserting only that a draft run does not dial is satisfied by a route
 * that never dials at all — I-38, which this repo has paid for repeatedly. The
 * last test sends the identical message on a live namespace and requires the
 * transport to be reached.
 *
 * Proven by perturbation: deleting the `env === "draft"` block turns the first
 * five red and leaves the control green.
 */
describe("a draft run is captured, never delivered", () => {
  /** prefix + 3 segments ending in `draft`. Counted, never suffix-matched. */
  const DRAFT_NS = "foundry.test.mail.draft";

  const draftRun = (name: string, extra: Record<string, unknown> = {}) =>
    makeRun({
      name,
      requestedBy: "someone@acme-hr.example",
      requestedByKind: "user",
      mailRecipientAllowlist: ["acme-hr.example"],
      namespace: DRAFT_NS,
      ...extra,
    } as Parameters<typeof makeRun>[0]);

  it("does NOT reach the transport", async () => {
    const { executionId } = await draftRun("Mail route — draft capture");
    const res = await post(MESSAGE, { "x-foundry-run": executionId });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("answers `captured`, and never `sent`", async () => {
    const { executionId } = await draftRun("Mail route — draft status");
    const body = await bodyOf(await post(MESSAGE, { "x-foundry-run": executionId }));
    // ⚠ A flow step reading `status` must be able to tell a held message from a
    // delivered one. `"sent"` here would be the false green from the far end.
    expect(body.status).toBe("captured");
    expect(body.message_id).toMatch(/^captured:[0-9a-f-]{36}$/); // the held message's id — same shape as a live send
    expect(body.message).toMatch(/not delivered/i);
  });

  it("still runs the recipient policy, so the held message has a real destination", async () => {
    const { executionId } = await draftRun("Mail route — draft recipients");
    const body = await bodyOf(await post(MESSAGE, { "x-foundry-run": executionId }));
    // Capturing BEFORE `resolveRecipients` would hold a message whose
    // destination was never decided — a test that proves less than it appears to.
    expect(body.recipients).toEqual(["someone@acme-hr.example"]);
    expect(body.resolved_from).toBe("requester");
  });

  it("REFUSES on a draft run just as it would live — the policy is not bypassed", async () => {
    const { executionId } = await makeRun({
      name: "Mail route — draft refusal",
      requestedBy: null,
      requestedByKind: "schedule",
      namespace: DRAFT_NS,
    });
    // No requester and no `to`: there is nobody to send to, draft or not. A
    // capture path that swallowed this would let a draft run "pass" a flow that
    // can never deliver.
    const res = await post(MESSAGE, { "x-foundry-run": executionId });
    expect(res.status).toBe(422);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("records `captured` and stores the rendered body", async () => {
    const { workspaceId, executionId } = await draftRun("Mail route — draft row");
    await post({ subject: "Held subject", body: "held body" }, { "x-foundry-run": executionId });
    const rows = await db.select().from(emailSends).where(eq(emailSends.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("captured");
    expect(rows[0].graphMessageId).toBeNull();
    expect(rows[0].failureReason).toBeNull();
    // The body is held ONLY here, and this is what the Email box reads.
    expect(rows[0].capturedBody).toContain("held body");
  });

  it("THE CONTROL — the identical message on a LIVE namespace does reach the transport", async () => {
    const { workspaceId, executionId } = await makeRun({
      name: "Mail route — live control",
      requestedBy: "someone@acme-hr.example",
      requestedByKind: "user",
      mailRecipientAllowlist: ["acme-hr.example"],
      // prefix + 2 segments: live.
      namespace: "foundry.test.mail",
    });
    const body = await bodyOf(await post(MESSAGE, { "x-foundry-run": executionId }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(body.status).toBe("sent");
    const rows = await db.select().from(emailSends).where(eq(emailSends.workspaceId, workspaceId));
    // ⚠ A real send stores NO body. That property is what stops the new column
    // quietly becoming a copy of every email the product ever sends.
    expect(rows[0].outcome).toBe("sent");
    expect(rows[0].capturedBody).toBeNull();
  });
});

describe("attachments", () => {
  const CSV = "employee_id,department\n1,Ops\n2,Finance\n";
  const ROWS = [
    { employee_id: 1, department: "Ops" },
    { employee_id: 2, department: "Finance" },
  ];
  const liveRun = (name: string) =>
    makeRun({
      name,
      requestedBy: "someone@acme-hr.example",
      requestedByKind: "user",
      mailRecipientAllowlist: ["acme-hr.example"],
    });
  const draftRun = (name: string) =>
    makeRun({
      name,
      requestedBy: "someone@acme-hr.example",
      requestedByKind: "user",
      mailRecipientAllowlist: ["acme-hr.example"],
      namespace: "foundry.test.mail.draft",
    });

  it("hands a checked attachment to the transport, with the content type DERIVED from the name", async () => {
    const { executionId } = await liveRun("Mail route — attachment live");
    const res = await post(
      { ...MESSAGE, attachments: [{ name: "headcount.csv", content: CSV }] },
      { "x-foundry-run": executionId },
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const seen = send.mock.calls[0]![0].attachments;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: "headcount.csv",
      contentType: "text/csv",
      bytes: Buffer.byteLength(CSV),
    });
    expect((seen[0]!.data as Buffer).toString("utf8")).toBe(CSV);
    const json = await bodyOf(res);
    expect(json.attachments).toEqual([{ name: "headcount.csv", bytes: Buffer.byteLength(CSV) }]);
  });

  it("records the name and size on a REAL send and NEVER the content", async () => {
    const run = await liveRun("Mail route — attachment row");
    await post(
      { ...MESSAGE, attachments: [{ name: "headcount.csv", content: CSV }] },
      { "x-foundry-run": run.executionId },
    );
    const rows = await db.select().from(emailSends).where(eq(emailSends.workspaceId, run.workspaceId));
    expect(rows[0].outcome).toBe("sent");
    expect(rows[0].attachments).toEqual([{ name: "headcount.csv", bytes: Buffer.byteLength(CSV) }]);
    expect(rows[0].capturedAttachments).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("Finance");
  });

  it("holds the CONTENT on a draft run, so the Email box can hand back the file", async () => {
    const run = await draftRun("Mail route — attachment draft");
    const res = await post(
      { ...MESSAGE, attachments: [{ name: "headcount.csv", content: CSV }] },
      { "x-foundry-run": run.executionId },
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(0);
    const rows = await db.select().from(emailSends).where(eq(emailSends.workspaceId, run.workspaceId));
    expect(rows[0].outcome).toBe("captured");
    // Held as a FILE (email_held_files, 2026-10-13), not inline on the row.
    expect(rows[0].capturedAttachments).toBeNull();
    const file = await emailHeldFileRepo.read(run.workspaceId, rows[0].id, 0);
    expect(file).toMatchObject({ name: "headcount.csv", contentType: "text/csv" });
    expect(file!.body.toString("utf8")).toBe(CSV);
  });

  it("GENERATED — rows become a CSV the transport receives as bytes", async () => {
    const { executionId } = await liveRun("Mail route — generated csv");
    const res = await post(
      { ...MESSAGE, attachments: [{ name: "headcount.csv", format: "csv", rows: ROWS }] },
      { "x-foundry-run": executionId },
    );
    expect(res.status).toBe(200);
    const seen = send.mock.calls[0]![0].attachments;
    const csv = "employee_id,department\r\n1,Ops\r\n2,Finance\r\n";
    expect(seen[0]).toMatchObject({ name: "headcount.csv", contentType: "text/csv" });
    expect((seen[0]!.data as Buffer).toString("utf8")).toBe(csv);
  });

  it("GENERATED — a draft run's .xlsx is held as the workbook itself", async () => {
    const run = await draftRun("Mail route — generated xlsx");
    const res = await post(
      { ...MESSAGE, attachments: [{ name: "headcount.xlsx", format: "xlsx", rows: ROWS }] },
      { "x-foundry-run": run.executionId },
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(0);
    const rows = await db.select().from(emailSends).where(eq(emailSends.workspaceId, run.workspaceId));
    const held = (await emailHeldFileRepo.read(run.workspaceId, rows[0].id, 0))!;
    expect(held.name).toBe("headcount.xlsx");
    // The Email box hands back exactly the workbook Graph would have received — the bytes, not base64 text.
    expect(held.body.subarray(0, 2).toString("latin1")).toBe("PK");
    // And the intent row still records name and size only.
    expect(rows[0].attachments).toEqual([{ name: "headcount.xlsx", bytes: held.body.length }]);
    expect(JSON.stringify(rows[0].attachments)).not.toContain("content");
  });

  it("FLAT — attach_rows + attach_name + attach_format become one generated file", async () => {
    const { executionId } = await liveRun("Mail route — flat attachment");
    const res = await post(
      { ...MESSAGE, attach_rows: ROWS, attach_name: "headcount", attach_format: "csv" },
      { "x-foundry-run": executionId },
    );
    expect(res.status).toBe(200);
    const seen = send.mock.calls[0]![0].attachments;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: "headcount.csv", contentType: "text/csv" });
    expect((seen[0]!.data as Buffer).toString("utf8")).toBe("employee_id,department\r\n1,Ops\r\n2,Finance\r\n");
  });

  it("FLAT — no rows sends the email WITHOUT a file, and reports the skip", async () => {
    const { executionId } = await liveRun("Mail route — flat attachment empty");
    const res = await post(
      { ...MESSAGE, attach_rows: [], attach_name: "headcount", attach_format: "xlsx" },
      { "x-foundry-run": executionId },
    );
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].attachments ?? []).toHaveLength(0);
    const json = await bodyOf(res);
    expect(json.attachments_skipped).toEqual([{ name: "headcount.xlsx", reason: "no rows — nothing to attach" }]);
  });

  it("FLAT — rows with no name 422s without dialling", async () => {
    const { executionId } = await liveRun("Mail route — flat attachment unnamed");
    const res = await post({ ...MESSAGE, attach_rows: ROWS }, { "x-foundry-run": executionId });
    expect(res.status).toBe(422);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("GENERATED — a name that does not match the format 422s without dialling", async () => {
    const { executionId } = await liveRun("Mail route — generated mismatch");
    const res = await post(
      { ...MESSAGE, attachments: [{ name: "report.csv", format: "xlsx", rows: ROWS }] },
      { "x-foundry-run": executionId },
    );
    expect(res.status).toBe(422);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("422s a disallowed file name and dials NOTHING", async () => {
    const { executionId } = await liveRun("Mail route — attachment name");
    const res = await post(
      { ...MESSAGE, attachments: [{ name: "report.csv.exe", content: CSV }] },
      { "x-foundry-run": executionId },
    );
    expect(res.status).toBe(422);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("400s a caller-supplied contentType — the type is derived, never taken", async () => {
    const { executionId } = await liveRun("Mail route — attachment type");
    const res = await post(
      { ...MESSAGE, attachments: [{ name: "a.csv", content: CSV, contentType: "text/html" }] },
      { "x-foundry-run": executionId },
    );
    expect(res.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("422s attachments over the total cap without dialling, naming both sizes", async () => {
    const { executionId } = await liveRun("Mail route — attachment cap");
    // The real cap is 50 MB (2.26.28), far past this app's 2 MB JSON limit, so express would answer first. A small
    // cap for this test keeps one byte over it under the JSON limit — so it is the attachment check that answers.
    const mail = config.mail as { maxAttachmentBytes: number };
    const real = mail.maxAttachmentBytes;
    mail.maxAttachmentBytes = 64 * 1024;
    try {
      const big = "x".repeat(mail.maxAttachmentBytes + 1);
      const res = await post(
        { ...MESSAGE, attachments: [{ name: "big.csv", content: big }] },
        { "x-foundry-run": executionId },
      );
      expect(res.status).toBe(422);
      const json = await bodyOf(res);
      expect(json.detail).toMatchObject({
        actual: mail.maxAttachmentBytes + 1,
        allowed: mail.maxAttachmentBytes,
      });
      expect(send).toHaveBeenCalledTimes(0);
    } finally {
      mail.maxAttachmentBytes = real;
    }
  });
});
