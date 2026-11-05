/**
 * A flow step really does email the person who started the run.
 * email-send-tool · T041, T042 · SC-002
 *
 * ── Why this test is worth having on top of the other five ───────────────────
 *
 * Every layer is already proved in isolation: the policy (`mail-recipients.test.ts`),
 * the transport (`mail.service.test.ts`), the endpoint (`routes/mail.test.ts`), the
 * registration (`platform-tool-catalogue.test.ts`). What none of them proves is
 * that the **seam between the executor and the endpoint** holds — and that seam
 * carries two facts that exist nowhere else:
 *
 *  1. `invokeTool` sends `x-foundry-run`. The entire requester default depends on
 *     that header arriving. It is set at `step-execution.service.ts:446` for
 *     ops-api's benefit, and this feature is its second consumer — a change made
 *     for ops-api's sake could remove it and every other test here would still
 *     pass while "email me the result" silently became "422, no recipient".
 *  2. `applyAuth` presents `FOUNDRY_MAIL_KEY` in the `X-Foundry-Mail-Key` header,
 *     from the workspace secret the registration stored, in the style the tool row
 *     declares. Get any of those three wrong and every email step 401s.
 *
 * So this drives the **real** `stepExecutionService.tool` against the **real**
 * mounted route over **real** HTTP. Only the Graph transport is stubbed.
 *
 * ⚠ The tool row's `url` is repointed at the test server's ephemeral port. In a
 * deployment it is `config.mail.selfBase`, which no test can bind.
 *
 * ── ⚠ HOW A REFUSED EMAIL SURFACES: the step THROWS ─────────────────────────
 *
 * `invokeTool` returns per-item results and tolerates partial failure — the
 * worked example requires an unmailable employee to surface "as a `send` warning,
 * not a crash". But when **every** item in the batch fails it throws
 * `StepError(502)` instead (`step-execution.service.ts:510`), because that means
 * something is wrong with the tool rather than with individual inputs.
 *
 * An email step is a batch of one. So a refused email **fails the step**, and that
 * is the correct outcome, not an inconvenience to assert around: a flow whose email
 * was refused must not report success. These tests therefore expect a throw on
 * every refusal path — and still assert, after catching, that the transport was
 * never called and the refusal was recorded.
 *
 * A missing `FOUNDRY_MAIL_KEY` throws earlier still, `StepError(424)` from
 * `applyAuth`, before any HTTP call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { flows, flowExecutions, tools, workspaces } from "../db/schema.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { requestId } from "../middleware/request-id.middleware.js";

/** The only stub. Everything between the executor and here is real. */
const send = vi.hoisted(() => vi.fn());
vi.mock("./mail.service.js", () => ({
  mailService: { send },
  resetMailTokenCache: () => {},
}));

const { mailRouter } = await import("../routes/mail.js");
const { requireMailKey } = await import("../middleware/mail-key.middleware.js");
const { stepExecutionService } = await import("./step-execution.service.js");
const { workspaceService } = await import("./workspace.service.js");
const { emailSendRepo } = await import("../repositories/email-send.repo.js");
const { EMAIL_TOOL_NAME } = await import("./platform-tool-names.js");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(requestId);
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
  send.mockResolvedValue({ ok: true, messageId: "graph-req-1", requestId: "graph-req-1" });
});

/**
 * A workspace with the platform tool registered (by `workspaceService.create`),
 * repointed at this test's server, plus a flow and a run started by a person.
 */
async function setup(opts: { requestedBy: string | null; requestedByKind: string | null }) {
  const ws = await workspaceService.create({ name: `E2E mail ${opts.requestedByKind}-${Date.now()}` });
  createdWorkspaces.push(ws.id);

  // ⚠ Repointed directly through the table: `toolService.update` refuses this row
  // (the T046 reserved-name guard), which is the guard doing its job.
  await db
    .update(tools)
    .set({ url: `${base}/api/mail/send` })
    .where(eq(tools.workspaceId, ws.id));

  const [flow] = await db
    .insert(flows)
    .values({ workspaceId: ws.id, name: "E2E mail flow", kestraFlowId: "e2e-mail", status: "draft" })
    .returning();

  const [execution] = await db
    .insert(flowExecutions)
    .values({
      workspaceId: ws.id,
      flowId: flow.id,
      kestraNamespace: "foundry.test.e2e",
      kestraFlowId: "e2e-mail",
      kestraExecutionId: `e2e-${flow.id}`,
      status: "running",
      requestedBy: opts.requestedBy,
      requestedByKind: opts.requestedByKind,
    })
    .returning();

  return { workspaceId: ws.id, executionId: execution.id };
}

describe("T041 — a two-step flow's email step reaches the requester", () => {
  it("resolves the recipient from the run, with no address anywhere in the step", async () => {
    /**
     * ⚠ THE headline assertion of the whole feature. The step's params carry
     * `subject` and `body` and **no recipient at all** — the address is derived
     * server-side from who started the run. That is the form in which the model
     * never has to produce an address and therefore cannot get one wrong.
     */
    const { workspaceId, executionId } = await setup({
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });

    const result = await stepExecutionService.tool(
      workspaceId,
      {
        ref: EMAIL_TOOL_NAME,
        params: [{ subject: "Q3 close summary", body: "the script output, line one" }],
      },
      executionId,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].data).toMatchObject({
      status: "sent",
      recipients: ["asked.person@example.com"],
      resolved_from: "requester",
      message_id: "graph-req-1",
    });

    // The transport was handed the resolved list, not the step's params.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: ["asked.person@example.com"],
      subject: "Q3 close summary",
    });

    // And the evidence row exists, attributed to this execution.
    const rows = await emailSendRepo.listByExecution(workspaceId, executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "sent",
      recipients: ["asked.person@example.com"],
      resolvedFrom: "requester",
      graphMessageId: "graph-req-1",
    });
  });

  it("proves the executor's `x-foundry-run` header actually arrives", async () => {
    // The same call without a run id must refuse — which is what makes the test
    // above evidence that the header travelled, rather than evidence that the
    // endpoint guessed correctly.
    const { workspaceId } = await setup({
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });

    await expect(
      stepExecutionService.tool(
        workspaceId,
        { ref: EMAIL_TOOL_NAME, params: [{ subject: "no run", body: "x" }] },
        undefined, // no execution — the header is not sent
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(send).not.toHaveBeenCalled();
  });

  it("proves the derived credential is presented — the step is authenticated", async () => {
    // If `FOUNDRY_MAIL_KEY` were missing from the workspace, or the tool declared
    // the wrong auth style, this would be a 401 rather than a send. Asserted by
    // the success above; asserted HERE by removing the secret and watching it fail.
    const { workspaceId, executionId } = await setup({
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });

    const { workspaceSecretService } = await import("./workspace-secret.service.js");
    const secrets = await workspaceSecretService.list(workspaceId);
    const mailKey = secrets.find((s) => s.name === "FOUNDRY_MAIL_KEY");
    expect(mailKey).toBeTruthy();
    await workspaceSecretService.remove(workspaceId, mailKey!.id);

    // ⚠ 424, not 401 — `applyAuth` refuses before dialling, distinguishing "you
    // have not configured this" from "the provider rejected you". That is the
    // distinction `secrets/audit` exists for, and it holds for this tool too.
    await expect(
      stepExecutionService.tool(
        workspaceId,
        { ref: EMAIL_TOOL_NAME, params: [{ subject: "unauthenticated", body: "x" }] },
        executionId,
      ),
    ).rejects.toMatchObject({ status: 424 });

    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a scheduled run with no recipient, loudly", async () => {
    // US3 through the real executor. A nightly job that emails whoever last
    // touched the flow is the failure this refusal prevents.
    const { workspaceId, executionId } = await setup({
      requestedBy: "trigger:nightly-close",
      requestedByKind: "schedule",
    });

    await expect(
      stepExecutionService.tool(
        workspaceId,
        { ref: EMAIL_TOOL_NAME, params: [{ subject: "nightly", body: "x" }] },
        executionId,
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(send).not.toHaveBeenCalled();

    const rows = await emailSendRepo.listByExecution(workspaceId, executionId);
    expect(rows[0].outcome).toBe("refused");
  });
});

describe("T042 / SC-002 — a non-allowlisted recipient sends NOTHING", () => {
  it("refuses, dials zero times, and records the refusal naming the address", async () => {
    /**
     * ⚠ The proof that matters most. `mailService.send` is the only path to
     * Microsoft, so **zero calls** to it is the whole claim: not "we refused after
     * sending", not "we sent and reported a problem" — nothing left the building.
     */
    const { workspaceId, executionId } = await setup({
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });

    await expect(
      stepExecutionService.tool(
        workspaceId,
        {
          ref: EMAIL_TOOL_NAME,
          params: [
            {
              subject: "Q3 close summary",
              body: "the script output",
              to: ["stranger@definitely-not-allowlisted.example"],
            },
          ],
        },
        executionId,
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(send).toHaveBeenCalledTimes(0);

    const rows = await emailSendRepo.listByExecution(workspaceId, executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("refused");
    expect(rows[0].recipients).toEqual([]);
    expect(rows[0].failureReason).toMatch(/definitely-not-allowlisted/);
  });

  it("refuses the WHOLE call when one of three recipients fails", async () => {
    // FR-007 end to end: no partial send, so no caller can believe two of three
    // people were emailed.
    const { workspaceId, executionId } = await setup({
      requestedBy: "asked.person@example.com",
      requestedByKind: "user",
    });

    await expect(
      stepExecutionService.tool(
        workspaceId,
        {
          ref: EMAIL_TOOL_NAME,
          params: [
            {
              subject: "Q3",
              body: "x",
              to: [
                "asked.person@example.com",
                "stranger@definitely-not-allowlisted.example",
                "asked.person@example.com",
              ],
            },
          ],
        },
        executionId,
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(send).toHaveBeenCalledTimes(0);
  });
});
