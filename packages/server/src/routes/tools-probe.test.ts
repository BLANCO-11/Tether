/**
 * `POST /api/workspaces/:workspaceId/tools/probe`, at the route.
 * `specs/20260818-123807-tool-probe` · T08 · contract §Response
 *
 * ── What this file tests that the service's own suite cannot ─────────────────
 *
 * `tool-probe.service.test.ts` asserts every verdict and every refusal. What it
 * cannot see is the wiring, and the wiring is where two specific mistakes live:
 *
 *   1. ⚠ **Route ORDER.** `/probe` declared after `/:toolId` is read as a request
 *      for the tool whose id is the string `"probe"` — which answers 404 and looks
 *      like a missing feature rather than a routing bug.
 *   2. ⚠ **`StepError` translation.** The class carries `status`; the shared error
 *      middleware switches on `statusCode`. A probe that throws 424 and arrives as
 *      **500 internal_error** would tell the person testing a tool that Foundry is
 *      broken, when the honest answer is "you have not stored that credential".
 *
 * And one property that is neither service nor route but the CONTRACT:
 * ⚠ **a 401 from the endpoint is a 200 from this route.** Asserted here, over real
 * HTTP, because that is the shape a client actually receives.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const get = vi.fn();
const getByName = vi.fn();
const collisionsFor = vi.fn();
const list = vi.fn();

vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { get: (...a: unknown[]) => get(...a), listByWorkspace: (...a: unknown[]) => list(...a) },
}));
vi.mock("../repositories/workspace-secret.repo.js", () => ({
  workspaceSecretRepo: { getByName: (...a: unknown[]) => getByName(...a) },
}));
vi.mock("../services/workspace-secret.service.js", () => ({
  shadowedSecretCollisions: (...a: unknown[]) => collisionsFor(...a),
}));
vi.mock("../utils/encryptor.js", () => ({ decrypt: (s: string) => s }));

const { toolsRouter } = await import("./tools.js");
const { errorHandler } = await import("../middleware/error.middleware.js");
const { requestId } = await import("../middleware/request-id.middleware.js");
const { resetProbeRateLimit } = await import("../services/tool-probe.service.js");

const WS = "11111111-1111-4111-8111-111111111111";

const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/workspaces/:workspaceId/tools", toolsRouter);
app.use(errorHandler);

let base = "";
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    // Express 5 hands a listen failure to this callback; passing `resolve` straight in would resolve on it.
    server = app.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const TOOL = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: WS,
  name: "hr_list_employees",
  url: "http://stub.invalid/employees",
  method: "GET",
  isActive: true,
  secretEnvName: null as string | null,
  authStyle: null as string | null,
  authParamName: null as string | null,
  paramsSchema: null as unknown,
  description: null as string | null,
  tokenUrl: null as string | null,
  clientIdSecretRef: null as string | null,
  clientSecretSecretRef: null as string | null,
};

function answers(status: number, body = "{}") {
  return vi.fn(async (_u: URL | string, _i?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "OK",
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => body,
  }) as unknown as Response);
}

/**
 * ⚠ **The real `fetch`, captured before any test stubs the global one.**
 *
 * These tests stub `globalThis.fetch` to fake the ENDPOINT's answer — and the
 * test's own HTTP client is the same global. Without this capture, the client
 * request never leaves the process: it is answered by the endpoint stub, so the
 * assertions read the fake upstream body and every one of them fails in a way
 * that looks like the route echoing the endpoint verbatim. Measured once; the
 * capture is the fix, and the comment is so it is not "simplified" back.
 */
const realFetch = globalThis.fetch;

const probe = (body: unknown) =>
  realFetch(`${base}/api/workspaces/${WS}/tools/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  get.mockResolvedValue(TOOL);
  getByName.mockResolvedValue(undefined);
  collisionsFor.mockResolvedValue([]);
  resetProbeRateLimit();
  const { lookup } = await import("node:dns/promises");
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the probe route answers in the contract's shape", () => {
  it("200 with the probe object for a reachable tool", async () => {
    vi.stubGlobal("fetch", answers(200));
    const res = await probe({ toolId: TOOL.id, mode: "live" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { probe: Record<string, unknown> };
    expect(body.probe).toMatchObject({
      mode: "live",
      verdict: "ok",
      invoked: true,
      status: 200,
    });
    // Every field the contract names is present, so a client can render without
    // optional-chaining through the whole object.
    expect(body.probe).toHaveProperty("request");
    expect(body.probe).toHaveProperty("message");
    expect(body.probe).toHaveProperty("remedy");
    expect(body.probe).toHaveProperty("durationMs");
  });

  /**
   * ⚠ **This assertion was WEAKER than it looked, and the docblock is the fix.**
   *
   * It was written as "the route-order assertion — if `/probe` is declared below
   * `/:toolId` this becomes a 404". **Measured: it does not.** Moving the `/probe`
   * block below the `/:toolId` handlers left all 11 tests green, because Express
   * matches on method AND path and this router has no `POST /:toolId`. A test that
   * cannot fail is worse than no test (I-38), so it is replaced by the assertion
   * that is actually load-bearing: the ordering is safe *because* no such route
   * exists, and this is what says so the day one is added.
   */
  it("no POST /:toolId exists — which is WHY /probe cannot be shadowed", () => {
    const layers = (toolsRouter as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;

    // The control against a vacuous pass: the router really was introspected.
    const paths = layers.map((l) => l.route?.path).filter(Boolean);
    expect(paths).toContain("/probe");
    expect(paths).toContain("/:toolId");

    const postParamRoutes = layers.filter(
      (l) => l.route?.methods.post && l.route.path.startsWith("/:"),
    );
    /**
     * ⚠ If this ever goes red, a `POST /:toolId…` route was added and the DECLARATION
     * ORDER in `tools.ts` becomes load-bearing: `/probe` must stay above it, or a
     * probe request is read as an action on the tool whose id is `"probe"`.
     */
    expect(postParamRoutes.map((l) => l.route!.path)).toEqual([]);
  });

  it("the probe handler is what answers, and it reads the id from the BODY", async () => {
    vi.stubGlobal("fetch", answers(200));
    const res = await probe({ toolId: TOOL.id, mode: "live" });
    expect(res.status).toBe(200);
    // Never `get(WS, "probe")` — the path segment is not a tool id.
    expect(get).toHaveBeenCalledWith(WS, TOOL.id);
  });

  /**
   * ⚠ **THE CONTRACT'S SHARPEST LINE.** "The API said no" and "Foundry could not
   * ask" are different facts and must have different status codes, or the button
   * cannot tell a person which of the two happened — which is the confusion
   * WS-B.4's declared auth styles and `applyAuth`'s 424 exist to remove.
   */
  it("a 401 FROM THE ENDPOINT arrives as HTTP 200 with verdict auth_rejected", async () => {
    getByName.mockResolvedValue({ valueEnc: "k" });
    get.mockResolvedValue({
      ...TOOL,
      secretEnvName: "API_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });
    vi.stubGlobal("fetch", answers(401, '{"error":"unauthorized"}'));

    const res = await probe({ toolId: TOOL.id, mode: "live" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { probe: { verdict: string; status: number } };
    expect(body.probe.verdict).toBe("auth_rejected");
    expect(body.probe.status).toBe(401);
  });

  it("400 `invalid_draft` with findings, in the shape the form renders", async () => {
    const res = await probe({ draft: { name: "not a valid name", url: "nope" } });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; findings: string[]; requestId: string };
    expect(body.error).toBe("invalid_draft");
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.findings.length).toBeGreaterThan(0);
    // P0 of `step-payload-bounds`: every 4xx in this product is greppable.
    expect(typeof body.requestId).toBe("string");
  });

  it("404 for a tool id in another workspace", async () => {
    get.mockResolvedValue(undefined);
    const res = await probe({ toolId: TOOL.id });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
  });

  /**
   * ⚠ This is the case that would have been a **500** if `StepError.status` were
   * left to the shared middleware, which switches on `statusCode`. A person told
   * "internal error" goes looking at Foundry; a person told 424 goes and stores
   * their credential.
   */
  it("424 `credential_not_configured` — not 500 — for an unstored credential", async () => {
    get.mockResolvedValue({
      ...TOOL,
      secretEnvName: "MISSING_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });
    const fetchMock = answers(200);
    vi.stubGlobal("fetch", fetchMock);

    const res = await probe({ toolId: TOOL.id, mode: "live" });

    expect(res.status).toBe(424);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toMatch(/no value in this workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⚠ **FOUND AT THE WIRE, 2026-08-20.** The 424 above arrived as
   * `{"error":"probe_failed"}`, not the contract's `credential_not_configured` —
   * because the 424 that matters most is raised inside the SHARED dial
   * (`applyAuth`) and carries no `detail`, so there was no code to read. The route
   * now derives the code from the status, and this is the assertion that says so.
   *
   * ⚠ Asserted for every row of the contract's status table, because the bug was
   * not "one code was wrong" — it was that a code was only present when a thrower
   * happened to supply one.
   */
  it("every non-200 carries the contract's error CODE, not just a status", async () => {
    // 424 — raised by the shared dial, with no detail of its own.
    get.mockResolvedValue({
      ...TOOL,
      secretEnvName: "MISSING_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });
    vi.stubGlobal("fetch", answers(200));
    await expect((await probe({ toolId: TOOL.id, mode: "live" })).json()).resolves.toMatchObject({
      error: "credential_not_configured",
    });

    // 409 — raised with a detail, and its own code must still win.
    get.mockResolvedValue({ ...TOOL, secretEnvName: "K", authStyle: "bearer" });
    collisionsFor.mockResolvedValue(["datasource \"d\" declares K with a different value"]);
    await expect((await probe({ toolId: TOOL.id, mode: "live" })).json()).resolves.toMatchObject({
      error: "secret_collision",
    });
    collisionsFor.mockResolvedValue([]);

    // 404
    get.mockResolvedValue(undefined);
    await expect((await probe({ toolId: TOOL.id })).json()).resolves.toMatchObject({
      error: "not_found",
    });

    // 400
    await expect((await probe({ draft: { name: "bad name", url: "nope" } })).json()).resolves.toMatchObject(
      { error: "invalid_draft" },
    );
  });

  it("409 `platform_managed_live_probe` for a live probe of tether_email_send", async () => {
    get.mockResolvedValue({ ...TOOL, name: "tether_email_send", method: "POST" });
    const res = await probe({ toolId: TOOL.id, mode: "live" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "platform_managed_live_probe",
      name: "tether_email_send",
    });
  });

  it("409 `secret_collision` carries the envName and the remedy", async () => {
    get.mockResolvedValue({ ...TOOL, secretEnvName: "MAIL_API_KEY", authStyle: "bearer" });
    collisionsFor.mockResolvedValue([
      'datasource "clashing_db" declares MAIL_API_KEY with a different value',
    ]);

    const res = await probe({ toolId: TOOL.id, mode: "live" });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { envName: string; collisions: string[]; remedy: string };
    expect(body.envName).toBe("MAIL_API_KEY");
    expect(body.collisions[0]).toContain("clashing_db");
    expect(body.remedy).toContain("Rename one of them");
  });

  it("429 after the 21st probe in a minute, with retryAfterSec AND a Retry-After header", async () => {
    vi.stubGlobal("fetch", answers(200));
    for (let i = 0; i < 20; i++) {
      const ok = await probe({ toolId: TOOL.id, mode: "live" });
      expect(ok.status).toBe(200);
    }
    const res = await probe({ toolId: TOOL.id, mode: "live" });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe("probe_rate_limited");
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(body.retryAfterSec));
  });

  it("400 when the body names both a toolId and a draft", async () => {
    const res = await probe({ toolId: TOOL.id, draft: { name: "x", url: "http://a.b" } });
    // Zod rejects it at the schema, so this is the middleware's validation_error
    // rather than the service's invalid_draft — both are 400, and the distinction
    // is honest: one is a malformed request, the other a rejected draft.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "validation_error" });
  });

  /**
   * ⚠ Asserted at the route because this is where a body is serialised and sent
   * to a browser. The service suite proves the fields are clean; this proves
   * nothing re-attaches a secret on the way out.
   */
  it("no credential value appears anywhere in the response body", async () => {
    get.mockResolvedValue({
      ...TOOL,
      secretEnvName: "API_KEY",
      authStyle: "query",
      authParamName: "api_key",
    });
    getByName.mockResolvedValue({ valueEnc: "s3cr3t-value" });
    vi.stubGlobal("fetch", answers(200, '{"ok":true,"token":"leaked-token"}'));

    const res = await probe({ toolId: TOOL.id, mode: "live" });
    const raw = await res.text();

    expect(raw).not.toContain("s3cr3t-value");
    expect(raw).not.toContain("leaked-token");
    expect(raw).toContain("[redacted]");
  });
});
