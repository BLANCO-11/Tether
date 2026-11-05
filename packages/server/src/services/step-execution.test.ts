import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FR-008/User Story 3 (research.md Decision 2) — `tool.url` now goes through
// `guardedFetch(STRICT)`, which resolves the hostname before dialing. Mocked
// so every pre-existing test in this file (which dials the reserved,
// never-resolving `stub.invalid` — RFC 2606) keeps behaving exactly as
// before, against a public address, with no real DNS round trip.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

/**
 * The failure semantics of a tool batch — **as the safety argument for runtime
 * retry**.
 *
 * These assertions look like they are about warnings and they are not. Kestra
 * re-runs a task when the task FAILS, and a tool step is the one kind that sends
 * email and files tickets. So the question "is a retry safe?" reduces to "under
 * what circumstances does this function throw?", and the answer has to be:
 *
 *   throws  ⇔  every item failed  ⇔  nothing can have succeeded
 *
 * That is what makes the obvious duplication impossible rather than unlikely: a
 * batch where 7 of 10 emails went out returns **200 with a warning**, so Kestra
 * never retries it and the 3 failures are handled as data. The behaviour long
 * predates retry (it comes from §14 T5 — the unmailable employee must be a
 * warning, not a crash); what is new is that something now DEPENDS on it, and an
 * innocent-looking "surface failures properly" change would silently make every
 * retried tool step able to double-send.
 *
 * ⚠ The residual is stated here as plainly as in `StepRetry`: a call whose
 * RESPONSE was lost had its effect and is indistinguishable from one that never
 * landed. If all N items fail that way, a retry duplicates all N. Nothing in
 * these tests claims otherwise.
 */

const listByWorkspace = vi.fn();
const getByName = vi.fn();
const collisionsFor = vi.fn();

// No tool here uses a connected service's credential (plugin-credentials.ts reads the connection table).
vi.mock("../repositories/plugin.repo.js", () => ({ pluginRepo: { connectionBySecret: async () => undefined } }));
vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: (...a: unknown[]) => listByWorkspace(...a) },
}));
vi.mock("../repositories/workspace-secret.repo.js", () => ({
  workspaceSecretRepo: { getByName: (...a: unknown[]) => getByName(...a) },
}));
vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: { getByName: vi.fn() },
}));
/**
 * Mocked so this suite stays a unit test. `invokeTool` gained a dependency on
 * `workspace-secret.service.ts` when I-120's refusal got its call site, and that
 * module reaches the workspace and datasource repos — so without this, every
 * assertion above would open a real database pool to answer a question about
 * warning semantics. The real function's own behaviour is verified against a real
 * database in `workspace-secret.test.ts`.
 */
vi.mock("./workspace-secret.service.js", () => ({
  shadowedSecretCollisions: (...a: unknown[]) => collisionsFor(...a),
}));
vi.mock("../utils/encryptor.js", () => ({ decrypt: (s: string) => s }));

const { stepExecutionService, StepError, resetOAuth2TokenCache } = await import(
  "./step-execution.service.js"
);

const TOOL = {
  id: "t1",
  name: "mail_send",
  url: "http://stub.invalid/mail/send",
  method: "POST",
  isActive: true,
  secretEnvName: null,
  authStyle: null,
  authParamName: null,
};

/** One canned HTTP outcome per call, in order. */
function respondWith(statuses: number[]) {
  let i = 0;
  return vi.fn(async () => {
    const status = statuses[i++] ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify({ message_id: `m${i}` }),
    } as unknown as Response;
  });
}

const batch = (n: number) => ({
  ref: "mail_send",
  params: Array.from({ length: n }, (_, i) => ({ to: `p${i}@acme-hr.example` })),
});

/** A tool that declares a credential, which is what makes I-120's check apply. */
const AUTHED_TOOL = {
  ...TOOL,
  secretEnvName: "MAIL_API_KEY",
  authStyle: "header",
  authParamName: "X-API-Key",
};

beforeEach(async () => {
  listByWorkspace.mockResolvedValue([TOOL]);
  getByName.mockResolvedValue(undefined);
  // No collision is the ordinary case; each test that wants one says so.
  collisionsFor.mockResolvedValue([]);
  // The OAuth2 token cache is module-level and survives tests; a suite that
  // exercises the exchange must start cold (see resetOAuth2TokenCache).
  resetOAuth2TokenCache();
  // Default: every tool url in this file resolves to a public address, so
  // every pre-existing assertion is unaffected by the egress check. The one
  // test that wants a private-address refusal overrides this per-call.
  const { lookup } = await import("node:dns/promises");
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a tool batch throws ONLY when every item failed — the retry-safety property", () => {
  it("returns 200 with a warning when SOME items failed, so Kestra never retries it", async () => {
    // The duplication case, and the one that matters: 7 of 10 emails are already
    // out. If this threw, Kestra would re-run the task and send all 10 again.
    vi.stubGlobal("fetch", respondWith([200, 200, 200, 200, 200, 200, 200, 500, 500, 500]));

    const out = await stepExecutionService.tool("ws", batch(10));

    expect(out.succeeded).toBe(7);
    expect(out.failed).toBe(3);
    expect(out.warnings.join(" ")).toMatch(/3 of 10/);
  });

  it("still returns rather than throwing when only ONE of many succeeded", async () => {
    // The boundary. "Almost everything failed" is still not "everything failed",
    // and a threshold — retry if >90% failed, say — would reintroduce exactly the
    // duplication this property removes.
    vi.stubGlobal("fetch", respondWith([500, 500, 500, 500, 200]));

    const out = await stepExecutionService.tool("ws", batch(5));

    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(4);
  });

  it("throws 502 when EVERY item failed, which is what makes a retry possible at all", async () => {
    // The positive control for the three assertions above: without this, they
    // would all pass against a function that never throws — and runtime retry
    // would silently never fire.
    vi.stubGlobal("fetch", respondWith([503, 503, 503]));

    await expect(stepExecutionService.tool("ws", batch(3))).rejects.toMatchObject({
      status: 502,
    });
  });

  it("throws on a single-item batch that failed — the shape a retry demo uses", async () => {
    // `showcase-retry-recovery` sends one item. One item, all failed, so the step
    // fails and the `retry:` block fires. If a one-item batch were special-cased
    // into a warning, that flow would report success while having done nothing.
    vi.stubGlobal("fetch", respondWith([503]));

    await expect(stepExecutionService.tool("ws", batch(1))).rejects.toBeInstanceOf(StepError);
  });

  it("makes ZERO calls for an empty batch, and does not treat that as failure", async () => {
    // The empty case (I-09). At 2026-05 the dataset flags nobody, and a month
    // where nothing needed doing must not fail — nor retry, which would re-run a
    // step that by definition cannot make progress.
    const fetchMock = respondWith([]);
    vi.stubGlobal("fetch", fetchMock);

    const out = await stepExecutionService.tool("ws", { ref: "mail_send", params: [] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.failed).toBe(0);
    expect(out.succeeded).toBe(0);
  });
});

describe("the failures that are systemic, and must NOT look like a transient item failure", () => {
  it("throws 404 for an unknown ref, naming what is available", async () => {
    // Retrying this is pure delay: the tool will still not exist on attempt 3.
    // It is a 404 rather than a 502 so triage routes it to a human (§6.9).
    vi.stubGlobal("fetch", respondWith([]));

    await expect(
      stepExecutionService.tool("ws", { ref: "no_such_tool", params: [{}] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws 409 for an inactive tool rather than calling it", async () => {
    listByWorkspace.mockResolvedValue([{ ...TOOL, isActive: false }]);
    const fetchMock = respondWith([200]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(stepExecutionService.tool("ws", batch(1))).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * WS-B.1's refusal, restored — **the call site is the whole point** (I-120).
 *
 * `CLAUDE.md` and two docblocks said *"a name collision fails the execution (409)
 * rather than last-write-wins"* while nothing in production called the function
 * that computed it: `resolveForExecution`'s only production caller is the audit,
 * and the executor that consumed its output was deleted in Kestra Phase 4. So the
 * documented control did not run, and a shadowed credential was silent — the exact
 * condition those comments say must never hold.
 *
 * ⚠ These assertions are about the CALL SITE, not about collision detection. What
 * counts as a collision is verified against a real database in
 * `workspace-secret.test.ts`, including the case that turned out to be
 * unreachable. Both halves are needed: a correct detector nothing calls is what
 * this issue was.
 */
describe("a shadowed credential refuses the step rather than silently using one of them (I-120)", () => {
  it("throws 409 naming BOTH owners, and makes ZERO calls", async () => {
    // The failure being prevented: two declarations, one wins by ordering, and the
    // resulting 401 from the upstream reads as a wrong key rather than as a
    // misconfiguration — so the person fixes the credential that was correct.
    listByWorkspace.mockResolvedValue([AUTHED_TOOL]);
    collisionsFor.mockResolvedValue([
      'MAIL_API_KEY is declared by datasource "clashing_db" and tool "mail_send" with different values',
    ]);
    const fetchMock = respondWith([200]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(stepExecutionService.tool("ws", batch(1))).rejects.toMatchObject({ status: 409 });

    // ⚠ The load-bearing half. A refusal that fires after the request has gone out
    // is a log line, not a control — the email would already have been sent with
    // whichever credential won.
    expect(fetchMock).not.toHaveBeenCalled();

    // Both owners named: the fix is a rename, so "there is a collision" is not
    // actionable on its own. Which of the two to change is the actual question.
    const err = await stepExecutionService.tool("ws", batch(1)).catch((e: unknown) => e);
    expect((err as Error).message).toContain('datasource "clashing_db"');
    expect((err as Error).message).toContain('tool "mail_send"');
  });

  it("⚠ THE CONTROL: proceeds normally when nothing collides", async () => {
    // Without this, "refuses everything" would satisfy the assertion above, and a
    // check that cannot pass is worse than no check (I-38). This is also the
    // ordinary case for every tool in every workspace, so it is the arm that would
    // take the product down.
    listByWorkspace.mockResolvedValue([AUTHED_TOOL]);
    getByName.mockResolvedValue({ name: "MAIL_API_KEY", valueEnc: "the-key" });
    collisionsFor.mockResolvedValue([]);
    const fetchMock = respondWith([200]);
    vi.stubGlobal("fetch", fetchMock);

    const out = await stepExecutionService.tool("ws", batch(1));

    expect(out.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not even ask when the tool declares no credential", async () => {
    // A tool with `authStyle: none` has no name to shadow, so the query would be
    // pure cost on the commonest path. Asserted rather than assumed because the
    // obvious refactor is to hoist the check above the `if`.
    listByWorkspace.mockResolvedValue([TOOL]);
    vi.stubGlobal("fetch", respondWith([200]));

    await stepExecutionService.tool("ws", batch(1));

    expect(collisionsFor).not.toHaveBeenCalled();
  });

  it("asks about THIS tool's name, not the workspace at large", async () => {
    // Scoped deliberately: a blanket check would refuse a batch for a collision on
    // a credential this step never touches, and would read the workspace's other
    // credentials to do it.
    listByWorkspace.mockResolvedValue([AUTHED_TOOL]);
    getByName.mockResolvedValue({ name: "MAIL_API_KEY", valueEnc: "the-key" });
    vi.stubGlobal("fetch", respondWith([200]));

    await stepExecutionService.tool("ws", batch(1));

    expect(collisionsFor).toHaveBeenCalledWith("ws", "MAIL_API_KEY");
  });
});

/**
 * Phase 7 — `oauth2_client_credentials`. The style does not present a stored
 * value: `resolveOAuth2Bearer` exchanges the client-id/client-secret workspace
 * secrets at `tokenUrl` for a short-lived bearer token, caches it per
 * (workspaceId, toolId), and the batch presents it as style `"bearer"` — so
 * `applyAuth`'s switch never sees the oauth2 style.
 */
const OAUTH2_TOOL = {
  ...TOOL,
  id: "t-oauth2",
  name: "oauth_client",
  authStyle: "oauth2_client_credentials",
  secretEnvName: null,
  tokenUrl: "https://auth.example.com/token",
  clientIdSecretRef: "OAUTH2_CLIENT_ID",
  clientSecretSecretRef: "OAUTH2_CLIENT_SECRET",
};

/** The two secrets, decrypt is identity, so "id"/"secret" are the values. */
const OAUTH2_SECRETS = [
  { name: "OAUTH2_CLIENT_ID", valueEnc: "the-client-id" },
  { name: "OAUTH2_CLIENT_SECRET", valueEnc: "the-client-secret" },
];

/** A batch addressing the oauth2 tool by its own ref (the shared batch() says "mail_send"). */
const oauthBatch = (n: number) => ({
  ref: "oauth_client",
  params: Array.from({ length: n }, (_, i) => ({ to: `p${i}@acme-hr.example` })),
});

/**
 * Routes fetches by URL: the token endpoint answers the canned token body,
 * the tool endpoint answers a canned success — so a test can count exchanges
 * independently of tool calls.
 */
function oauth2Fetch(tokenBody: unknown, toolStatus = 200) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/token")) {
      return { ok: true, status: 200, json: async () => tokenBody } as unknown as Response;
    }
    return {
      ok: toolStatus >= 200 && toolStatus < 300,
      status: toolStatus,
      text: async () => JSON.stringify({ delivered: true }),
    } as unknown as Response;
  });
}

function tokenExchangeCount(fetchMock: ReturnType<typeof oauth2Fetch>): number {
  return fetchMock.mock.calls.filter(([u]) => String(u).includes("/token")).length;
}

function toolCallHeaders(fetchMock: ReturnType<typeof oauth2Fetch>): RequestInit["headers"] | undefined {
  const call = fetchMock.mock.calls.find(([u]) => !String(u).includes("/token"));
  return call?.[1]?.headers;
}

describe("oauth2_client_credentials — exchange, cache and 424 semantics (Phase 7)", () => {
  it("exchanges the two secrets at tokenUrl and presents the token as bearer", async () => {
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockImplementation(async (_ws: string, name: string) =>
      OAUTH2_SECRETS.find((s) => s.name === name),
    );
    const fetchMock = oauth2Fetch({ access_token: "tok-1", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);

    const out = await stepExecutionService.tool("ws", oauthBatch(1));

    expect(out.succeeded).toBe(1);
    expect(tokenExchangeCount(fetchMock)).toBe(1);
    // The exchange body is the RFC 6749 §4.4 grant.
    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/token"))!;
    expect(String(tokenCall[0])).toBe("https://auth.example.com/token");
    expect((tokenCall[1]?.body as URLSearchParams).get("grant_type")).toBe("client_credentials");
    expect((tokenCall[1]?.body as URLSearchParams).get("client_id")).toBe("the-client-id");
    expect((tokenCall[1]?.body as URLSearchParams).get("client_secret")).toBe("the-client-secret");
    expect((tokenCall[1]?.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    // The tool call carries the TOKEN, as bearer.
    expect((toolCallHeaders(fetchMock) as Record<string, string>)["authorization"]).toBe(
      "Bearer tok-1",
    );
  });

  it("caches per (workspaceId, toolId): a second batch within the TTL reuses the token", async () => {
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockImplementation(async (_ws: string, name: string) =>
      OAUTH2_SECRETS.find((s) => s.name === name),
    );
    const fetchMock = oauth2Fetch({ access_token: "tok-1", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);

    await stepExecutionService.tool("ws", oauthBatch(1));
    await stepExecutionService.tool("ws", oauthBatch(2));

    // One exchange, three tool calls (1 + 2 items).
    expect(tokenExchangeCount(fetchMock)).toBe(1);
    expect(fetchMock.mock.calls.filter(([u]) => !String(u).includes("/token")).length).toBe(3);
  });

  it("re-exchanges when the provider's expires_in is shorter than the safety margin", async () => {
    // TTL = min(10s − 30s, 300s) < 0 → the entry is already expired, so the
    // next batch must exchange again. The safe failure mode, asserted directly
    // instead of with fake timers.
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockImplementation(async (_ws: string, name: string) =>
      OAUTH2_SECRETS.find((s) => s.name === name),
    );
    const fetchMock = oauth2Fetch({ access_token: "tok-1", expires_in: 10 });
    vi.stubGlobal("fetch", fetchMock);

    await stepExecutionService.tool("ws", oauthBatch(1));
    await stepExecutionService.tool("ws", oauthBatch(1));

    expect(tokenExchangeCount(fetchMock)).toBe(2);
  });

  it("re-exchanges after the 300s cap, even when the provider grants longer", async () => {
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockImplementation(async (_ws: string, name: string) =>
      OAUTH2_SECRETS.find((s) => s.name === name),
    );
    const fetchMock = oauth2Fetch({ access_token: "tok-1", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    try {
      await stepExecutionService.tool("ws", oauthBatch(1));
      expect(tokenExchangeCount(fetchMock)).toBe(1);

      vi.advanceTimersByTime(301_000);
      await stepExecutionService.tool("ws", oauthBatch(1));

      expect(tokenExchangeCount(fetchMock)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws 424 when a client ref names no stored secret — same semantics as applyAuth", async () => {
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockResolvedValue(undefined); // nothing stored
    const fetchMock = oauth2Fetch({ access_token: "tok-1", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(stepExecutionService.tool("ws", oauthBatch(1))).rejects.toMatchObject({
      status: 424,
    });
    // No exchange, no tool call: the refusal fires before any request goes out.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names ONLY the missing ref when one of the two secrets is absent", async () => {
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockImplementation(async (_ws: string, name: string) =>
      name === "OAUTH2_CLIENT_ID" ? OAUTH2_SECRETS[0] : undefined,
    );
    vi.stubGlobal("fetch", oauth2Fetch({ access_token: "tok-1", expires_in: 3600 }));

    const err = await stepExecutionService.tool("ws", oauthBatch(1)).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(424);
    expect((err as Error).message).toContain("OAUTH2_CLIENT_SECRET");
    expect((err as Error).message).not.toContain("OAUTH2_CLIENT_ID");
  });

  it("throws 502 on a failed exchange — systemic, so the step fails before any item", async () => {
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockImplementation(async (_ws: string, name: string) =>
      OAUTH2_SECRETS.find((s) => s.name === name),
    );
    // Token endpoint answers 401 invalid_client; the tool endpoint would have
    // succeeded — the point is the exchange gates the batch.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/token")) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: "invalid_client", error_description: "bad pair" }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = await stepExecutionService.tool("ws", oauthBatch(1)).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(502);
    expect((err as { detail?: { error?: string } }).detail?.error).toBe("invalid_client");
    expect(fetchMock.mock.calls.filter(([u]) => !String(u).includes("/token")).length).toBe(0);
  });

  it("throws 502 when the token response has no access_token", async () => {
    listByWorkspace.mockResolvedValue([OAUTH2_TOOL]);
    getByName.mockImplementation(async (_ws: string, name: string) =>
      OAUTH2_SECRETS.find((s) => s.name === name),
    );
    vi.stubGlobal("fetch", oauth2Fetch({ expires_in: 3600 })); // 200 but no token

    await expect(stepExecutionService.tool("ws", oauthBatch(1))).rejects.toMatchObject({
      status: 502,
    });
  });
});

/**
 * ── The step's own remarks about its payload — `step-payload-bounds` T17 ──────
 *
 * ⚠ **Both are WARNINGS and that is the design, not a compromise** (plan
 * Decision 6). A tool that answers with 7 MB has not failed; the step that has to
 * pass that on is the one with a limit and a specific message, and Kestra hands a
 * `code` fragment its input as a file with no ceiling at all. Refusing here would
 * break flows that are correct.
 *
 * ⚠ **`TOOL` in this file declares no `paramsSchema`**, so most of the suite
 * above now also carries the §3b sentence. That is the contract read literally —
 * an undeclared tool called with parameter keys is exactly the state
 * `BTO_tool` was in — and it is why every assertion in this file matches on a
 * substring rather than on the whole array.
 */
describe("an oversize tool response is measured and REMARKED ON, never refused", () => {
  /** A response of a given size, optionally wrapped in a paged envelope. */
  const respondWithBody = (payload: unknown) =>
    vi.fn(async () => {
      const text = JSON.stringify(payload);
      return { ok: true, status: 200, text: async () => text } as unknown as Response;
    });

  /**
   * Enough rows to clear the 1 MiB default warn threshold.
   *
   * ⚠ `pad` is explicit because the threshold is real: at 200 bytes a row, 2,500
   * rows is ~700 KB and stays UNDER the cap, so a test asserting a warning on it
   * would be asserting a bug. Row counts here are chosen to match the measured
   * incident (4,722); `pad` is what carries them over the line.
   */
  const bigRows = (n: number, pad = 200) =>
    Array.from({ length: n }, (_, i) => ({
      id: i,
      full_name: `Employee number ${i} of this department`,
      attendance_rate: 0.7 + (i % 30) / 100,
      note: "x".repeat(pad),
    }));

  it("warns over the threshold, names the bytes, and STILL SUCCEEDS", async () => {
    vi.stubGlobal("fetch", respondWithBody({ count: 4722, data: bigRows(4722) }));

    const out = await stepExecutionService.tool("ws", batch(1));

    // ⚠ The step succeeded. A warning that failed the step would be a different
    // feature, and a much worse one.
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(0);

    const warning = out.warnings.find((w) => w.includes("returned"))!;
    expect(warning).toBeDefined();
    expect(warning).toMatch(/returned [\d,]+ bytes/);
    expect(warning).toContain("its largest array has 4,722 entries");
    // The consequence, because a byte count alone tells an operator nothing about
    // what it will cost them.
    expect(warning).toContain("Kestra stores this in the execution record");
  });

  it("says nothing about a response under the threshold", async () => {
    vi.stubGlobal("fetch", respondWithBody({ count: 2, data: bigRows(2) }));
    const out = await stepExecutionService.tool("ws", batch(1));
    expect(out.warnings.filter((w) => w.includes("returned"))).toEqual([]);
  });

  it("puts `bytes` on EVERY tool item, oversize or not", async () => {
    vi.stubGlobal("fetch", respondWithBody({ ok: true }));
    const out = await stepExecutionService.tool("ws", batch(3));
    expect(out.results).toHaveLength(3);
    for (const r of out.results) {
      expect(typeof r.bytes).toBe("number");
      expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify({ ok: true }), "utf8"));
    }
  });

  it("counts UTF-8 BYTES, not characters", async () => {
    // A count taken from `String.length` would under-report a payload of names in
    // any non-ASCII script by up to 3×, which is the one case where the operator
    // most needs the number to be right.
    const payload = { note: "é".repeat(100) };
    vi.stubGlobal("fetch", respondWithBody(payload));
    const out = await stepExecutionService.tool("ws", batch(1));
    const text = JSON.stringify(payload);
    expect(out.results[0]!.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(out.results[0]!.bytes).toBeGreaterThan(text.length);
  });

  it("finds the largest array in a paged envelope — `{count, data:[…]}`", async () => {
    vi.stubGlobal("fetch", respondWithBody({ count: 3000, page: 1, data: bigRows(3000, 600) }));
    const out = await stepExecutionService.tool("ws", batch(1));
    // ⚠ The ARRAY's length, not the `count` field. An endpoint's own `count` can
    // be the total across pages, and a figure the operator cannot reproduce from
    // the body in front of them is worse than none.
    expect(out.warnings.join(" ")).toContain("its largest array has 3,000 entries");
  });

  it("finds the length of a BARE array payload", async () => {
    vi.stubGlobal("fetch", respondWithBody(bigRows(2500, 600)));
    const out = await stepExecutionService.tool("ws", batch(1));
    expect(out.warnings.join(" ")).toContain("its largest array has 2,500 entries");
  });

  /**
   * ⚠ The clause is OMITTED, not zero and not guessed. A big payload with no
   * array in it is a real thing — one enormous string field — and inventing
   * *"0 entries"* or *"about N rows"* for it makes the whole warning unreliable
   * for the cases where the figure IS real.
   */
  it("OMITS the array clause for a payload with no array in it", async () => {
    vi.stubGlobal("fetch", respondWithBody({ report: "x".repeat(2_000_000) }));
    const out = await stepExecutionService.tool("ws", batch(1));
    const warning = out.warnings.find((w) => w.includes("returned"))!;
    expect(warning).toMatch(/returned [\d,]+ bytes\. Kestra stores/);
    expect(warning).not.toContain("entries");
  });

  /**
   * ⚠ **THE PER-STEP PROPERTY.** 200 items over the threshold produce ONE
   * sentence. Per-item warnings would make the warnings array itself the oversize
   * payload it is complaining about (contract §3).
   */
  it("emits ONE warning for a 200-item batch, not 200", async () => {
    vi.stubGlobal("fetch", respondWithBody({ count: 4722, data: bigRows(4722) }));
    const out = await stepExecutionService.tool("ws", batch(200));
    expect(out.succeeded).toBe(200);
    expect(out.warnings.filter((w) => w.includes("returned"))).toHaveLength(1);
  });

  it("reports the LARGEST item's figures, not the first item's", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const payload = call++ === 0 ? { data: bigRows(2) } : { data: bigRows(4722) };
        const text = JSON.stringify(payload);
        return { ok: true, status: 200, text: async () => text } as unknown as Response;
      }),
    );
    const out = await stepExecutionService.tool("ws", batch(2));
    expect(out.warnings.join(" ")).toContain("its largest array has 4,722 entries");
  });
});

describe("a tool that declares no parameters says so — the sentence 05aca859 needed", () => {
  const smallOk = () =>
    vi.fn(async () => ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response);

  it("names the parameter KEYS and how they were sent", async () => {
    vi.stubGlobal("fetch", smallOk());
    const out = await stepExecutionService.tool("ws", {
      ref: "mail_send",
      params: [{ period: "2026-06", department: "eng" }],
    });

    const warning = out.warnings.find((w) => w.includes("declares no parameters"))!;
    expect(warning).toBeDefined();
    expect(warning).toContain("`period`");
    expect(warning).toContain("`department`");
    // `mail_send` here is POST — the clause must follow the method actually used.
    expect(warning).toContain("in the JSON body");
    expect(warning).toContain("Register the parameters it accepts");
  });

  /**
   * ⚠ **NAMES ONLY, NEVER VALUES.** A parameter value can be tenant data — an
   * employee id, an email address, a period nobody outside HR should see — and
   * this string is stored and rendered as a step warning.
   */
  it("never echoes a parameter VALUE", async () => {
    vi.stubGlobal("fetch", smallOk());
    const out = await stepExecutionService.tool("ws", {
      ref: "mail_send",
      params: [{ employee_email: "someone@acme-hr.example" }],
    });
    const warning = out.warnings.find((w) => w.includes("declares no parameters"))!;
    expect(warning).toContain("`employee_email`");
    expect(warning).not.toContain("someone@acme-hr.example");
  });

  it("says nothing when the tool DECLARES a params_schema", async () => {
    listByWorkspace.mockResolvedValue([
      { ...TOOL, paramsSchema: { period: { type: "string", required: true } } },
    ]);
    vi.stubGlobal("fetch", smallOk());
    const out = await stepExecutionService.tool("ws", {
      ref: "mail_send",
      params: [{ period: "2026-06" }],
    });
    expect(out.warnings.filter((w) => w.includes("declares no parameters"))).toEqual([]);
  });

  it("treats an EMPTY schema as no schema — `{}` is not a declaration", async () => {
    listByWorkspace.mockResolvedValue([{ ...TOOL, paramsSchema: {} }]);
    vi.stubGlobal("fetch", smallOk());
    const out = await stepExecutionService.tool("ws", {
      ref: "mail_send",
      params: [{ period: "2026-06" }],
    });
    expect(out.warnings.join(" ")).toContain("declares no parameters");
  });

  it("says nothing when no parameters were sent at all", async () => {
    // Nothing was ignored, so there is nothing to report. A tool called with no
    // parameters and declaring none is simply a tool with no parameters.
    vi.stubGlobal("fetch", smallOk());
    const out = await stepExecutionService.tool("ws", { ref: "mail_send", params: [{}] });
    expect(out.warnings.filter((w) => w.includes("declares no parameters"))).toEqual([]);
  });

  it("emits ONE warning for a 200-item batch and unions the keys across items", async () => {
    vi.stubGlobal("fetch", smallOk());
    const out = await stepExecutionService.tool("ws", {
      ref: "mail_send",
      params: [
        ...Array.from({ length: 199 }, () => ({ period: "2026-06" })),
        { department: "eng" },
      ],
    });
    const matching = out.warnings.filter((w) => w.includes("declares no parameters"));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toContain("`period`");
    expect(matching[0]).toContain("`department`");
  });

  it("says `as a query parameter` for a GET tool", async () => {
    listByWorkspace.mockResolvedValue([{ ...TOOL, name: "BTO_tool", method: "GET" }]);
    vi.stubGlobal("fetch", smallOk());
    const out = await stepExecutionService.tool("ws", {
      ref: "BTO_tool",
      params: [{ period: "2026-06" }],
    });
    // Verbatim the shape of the sentence that would have ended the investigation.
    expect(out.warnings.join(" ")).toContain(
      "BTO_tool declares no parameters, so `period` was sent as a query parameter and the " +
        "endpoint is free to ignore it. Register the parameters it accepts so a flow can " +
        "narrow the read.",
    );
  });
});

/**
 * ── The remarks reach the ALL-FAILED exit too ────────────────────────────────
 * `specs/20260819-045902-step-payload-bounds` · contract §3 · added 2026-08-24
 *
 * ⚠ **The gap this closes.** The two remarks were built inline BELOW the
 * `throw`, so a batch where every call failed threw first and both were computed
 * into a function that had already exited. The run that most needs *"declares no
 * parameters, so `period` was sent … and the endpoint is free to ignore it"* — the
 * one where nothing worked and somebody is staring at a 502 — was the one run that
 * never got it.
 *
 * ⚠ **`results` must not move.** A caller reads `detail.results` to decide what is
 * safe to retry (see this file's own header), so the fix ADDS a key beside it. The
 * first test below asserts both halves: the new `warnings`, and `results` still
 * exactly as long and as shaped as it was.
 */
describe("a batch where every call failed still says what it noticed", () => {
  /** Every call fails, and the failing body is small. */
  const allFail = () =>
    vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: "upstream down" }),
    }) as unknown as Response);

  it("carries the undeclared-parameters remark in the 502's detail", async () => {
    vi.stubGlobal("fetch", allFail());

    const err = await stepExecutionService
      .tool("ws", { ref: "mail_send", params: [{ period: "2026-06" }, { period: "2026-07" }] })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(StepError);
    const detail = (err as { status: number; detail: Record<string, unknown> });
    expect(detail.status).toBe(502);

    const warnings = detail.detail.warnings as string[];
    expect(warnings.join(" ")).toContain("declares no parameters");
    expect(warnings.join(" ")).toContain("`period`");
    // ⚠ NAMES ONLY on this exit as well — the 502's detail is logged and rendered
    // like any other, and a value can be tenant data.
    expect(warnings.join(" ")).not.toContain("2026-06");

    // ⚠ THE OTHER HALF: `results` is untouched. This is the field a retry decision
    // reads, and the point of adding a key rather than moving the block.
    const results = detail.detail.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results[0]!.status).toBe(503);
  });

  /**
   * ⚠ Absent, not empty. A `warnings: []` on every unremarkable 502 is a field
   * that gets rendered as an empty list and then ignored — and once it is ignored
   * the day it has something in it is the day nobody reads it.
   */
  it("adds no `warnings` key when there was nothing to remark on", async () => {
    listByWorkspace.mockResolvedValue([
      { ...TOOL, paramsSchema: { period: { type: "string", required: true } } },
    ]);
    vi.stubGlobal("fetch", allFail());

    const err = await stepExecutionService
      .tool("ws", { ref: "mail_send", params: [{ period: "2026-06" }] })
      .then(
        () => null,
        (e: unknown) => e,
      );

    const detail = (err as { detail: Record<string, unknown> }).detail;
    expect(detail.results).toHaveLength(1);
    expect("warnings" in detail).toBe(false);
  });

  /**
   * ⚠ The size remark reaches this exit too, and it is not a curiosity: a 503 that
   * answers with a megabyte of HTML is exactly the payload that breaks whatever
   * step passes it on, and the failing path is where those bodies live.
   */
  it("carries the size remark for a large FAILING body", async () => {
    // ⚠ `400`, not `200`. At 200 bytes a row, 4,722 rows is ~1.01 MB and lands
    // just UNDER the 1 MiB threshold — measured, this test failed that way first.
    // The same arithmetic trap `bigRows`' docblock above records; asserting a
    // warning under the cap would be asserting a bug.
    const huge = JSON.stringify({
      error: "upstream down",
      data: Array.from({ length: 4722 }, (_, i) => ({ id: i, note: "x".repeat(400) })),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => huge }) as unknown as Response),
    );

    const err = await stepExecutionService
      .tool("ws", { ref: "mail_send", params: [{ period: "2026-06" }] })
      .then(
        () => null,
        (e: unknown) => e,
      );

    const warnings = (err as { detail: { warnings: string[] } }).detail.warnings;
    expect(warnings.join(" ")).toMatch(/returned [\d,]+ bytes/);
    expect(warnings.join(" ")).toContain("its largest array has 4,722 entries");
  });

  /**
   * ⚠ **THE CONTROL for the extraction.** The remarks are now one function called
   * from two exits; if the succeeding path ever stopped calling it, every
   * assertion above would still pass. This asserts the same batch, one call
   * succeeding, produces the same sentence on the normal return.
   */
  it("says the same thing on the succeeding path — one implementation, two exits", async () => {
    vi.stubGlobal("fetch", respondWith([200]));

    const out = await stepExecutionService.tool("ws", {
      ref: "mail_send",
      params: [{ period: "2026-06" }],
    });

    expect(out.failed).toBe(0);
    expect(out.warnings.join(" ")).toContain("declares no parameters");
    expect(out.warnings.join(" ")).toContain("`period`");
  });
});
