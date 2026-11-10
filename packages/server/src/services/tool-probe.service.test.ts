/**
 * The probe's promises, asserted one at a time.
 * `specs/20260818-123807-tool-probe` · T06 · contract §Response / §Verdicts
 *
 * ── What is actually under test here ─────────────────────────────────────────
 *
 * Not "does it make an HTTP call" — `dialTool` does that and has its own control
 * in the four suites that pass unedited across the extraction. What is under test
 * is every promise the BUTTON makes, because each one is a sentence a person will
 * act on:
 *
 *   · a mutating tool's own method is never sent in reachability mode,
 *   · `invoked: false` whenever the operation did not run,
 *   · an upstream "no" is a 200 with a verdict, not a 5xx,
 *   · Foundry refusing to ask is a non-200, and never a verdict,
 *   · and nothing that leaves here carries a credential.
 *
 * ⚠ The last one is the only assertion in this file that is about a leak, and it
 * is asserted three ways (query value, headers, body) because a redaction that
 * covers two of three paths reads as covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same reason as `step-execution.test.ts`: `guardedFetch` resolves the hostname
// before dialing, and these tests use the reserved `stub.invalid` (RFC 2606).
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const get = vi.fn();
const getByName = vi.fn();
const collisionsFor = vi.fn();

vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { get: (...a: unknown[]) => get(...a) },
}));
vi.mock("../repositories/workspace-secret.repo.js", () => ({
  workspaceSecretRepo: { getByName: (...a: unknown[]) => getByName(...a) },
}));
vi.mock("./workspace-secret.service.js", () => ({
  shadowedSecretCollisions: (...a: unknown[]) => collisionsFor(...a),
}));
// No tool here uses a connected service's credential (plugin-credentials.ts reads the connection table).
vi.mock("../repositories/plugin.repo.js", () => ({ pluginRepo: { connectionBySecret: async () => undefined } }));
vi.mock("../utils/encryptor.js", () => ({ decrypt: (s: string) => s }));

const { toolProbeService, defaultModeFor, resetProbeRateLimit } = await import(
  "./tool-probe.service.js"
);
const { StepError } = await import("./step-error.js");
const { markFor, resetProbeMarks } = await import("./tool-probe-mark.js");

/**
 * ⚠ The nullable columns are annotated `as string | null` rather than left to
 * inference. Without it TypeScript widens them to the literal type `null`, and a
 * test that overrides one — which is most of the auth cases below — fails to
 * COMPILE while still passing under vitest, because vitest transpiles without
 * checking. That divergence is worth one annotation.
 */
const GET_TOOL = {
  id: "t-get",
  workspaceId: "ws",
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

const POST_TOOL = { ...GET_TOOL, id: "t-post", name: "ticket_create", method: "POST" };

/** One canned HTTP answer. `headers` is a real `Headers` — the probe reads content-type. */
function answers(...canned: Array<{ status: number; body?: string; contentType?: string }>) {
  let i = 0;
  // ⚠ Typed args, not `async ()`. Without them `mock.calls[n]` is `[]` under
  // `tsc`, so every assertion about WHAT was sent stops compiling — and vitest
  // transpiles without checking, so it would pass here and break the typecheck.
  return vi.fn(async (_url: URL | string, _init?: RequestInit) => {
    const a = canned[Math.min(i++, canned.length - 1)]!;
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      statusText: a.status === 405 ? "Method Not Allowed" : a.status === 401 ? "Unauthorized" : "OK",
      headers: new Headers({ "content-type": a.contentType ?? "application/json" }),
      text: async () => a.body ?? "{}",
    } as unknown as Response;
  });
}

beforeEach(async () => {
  get.mockResolvedValue(GET_TOOL);
  getByName.mockResolvedValue(undefined);
  collisionsFor.mockResolvedValue([]);
  resetProbeRateLimit();
  resetProbeMarks();
  const { lookup } = await import("node:dns/promises");
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the mode is chosen from the method, and a mutating tool is not fired by a Test button", () => {
  it("defaults GET and HEAD to live, everything else to reachability", () => {
    expect(defaultModeFor("GET")).toBe("live");
    expect(defaultModeFor("HEAD")).toBe("live");
    expect(defaultModeFor("POST")).toBe("reachability");
    expect(defaultModeFor("PATCH")).toBe("reachability");
    expect(defaultModeFor("DELETE")).toBe("reachability");
    // A missing method is a GET at execution, so it is a GET here.
    expect(defaultModeFor(null)).toBe("live");
  });

  /**
   * ⚠ **THE INVARIANT THE WHOLE MODE EXISTS FOR** (contract invariant 3). If this
   * ever sends `POST`, pressing "Test" on a ticketing tool files a ticket.
   */
  it("reachability sends HEAD and NEVER the tool's own method", async () => {
    get.mockResolvedValue(POST_TOOL);
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await toolProbeService.probe("ws", { toolId: "t-post" });

    expect(probe.mode).toBe("reachability");
    expect(probe.request.method).toBe("HEAD");
    expect(probe.request.toolMethod).toBe("POST");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("HEAD");
  });

  it("sends no parameters at all in reachability mode", async () => {
    get.mockResolvedValue(POST_TOOL);
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await toolProbeService.probe("ws", {
      toolId: "t-post",
      // Even if a caller supplies them, reachability must not carry them.
      sampleParams: { title: "probe", body: "should not be sent" },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init!.body).toBeUndefined();
    expect((url as URL).search).toBe("");
  });

  it("`invoked` is false on every reachability path, whatever the endpoint said", async () => {
    get.mockResolvedValue(POST_TOOL);
    for (const status of [200, 401, 404, 405, 500]) {
      vi.stubGlobal("fetch", answers({ status }));
      const probe = await toolProbeService.probe("ws", { toolId: "t-post" });
      expect(probe.invoked, `status ${status}`).toBe(false);
    }
  });

  it("a live probe of a POST tool is possible, but only when asked for in as many words", async () => {
    get.mockResolvedValue(POST_TOOL);
    const fetchMock = answers({ status: 201 });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await toolProbeService.probe("ws", {
      toolId: "t-post",
      mode: "live",
      sampleParams: { title: "probe" },
    });

    expect(probe.request.method).toBe("POST");
    expect(probe.invoked).toBe(true);
    expect(probe.verdict).toBe("ok");
    expect(fetchMock.mock.calls[0]![1]!.body).toBe('{"title":"probe"}');
  });

  /**
   * ⚠ P2 · T19. A GET's sample params go in the QUERY STRING, because that is
   * where `dialTool` puts them for a run — the probe has to send the request the
   * run would send, or a green here is about a different call.
   */
  it("a live GET carries its sample params in the query string", async () => {
    get.mockResolvedValue(GET_TOOL);
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await toolProbeService.probe("ws", {
      toolId: "t-get",
      sampleParams: { department: "Finance", limit: 5 },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect((url as URL).searchParams.get("department")).toBe("Finance");
    // ⚠ A non-string is JSON-encoded, exactly as `dialTool` does it for a run.
    expect((url as URL).searchParams.get("limit")).toBe("5");
    expect(init!.body).toBeUndefined();
    expect(probe.invoked).toBe(true);
    // The URL the panel prints is the URL that was dialled.
    expect(probe.request.urlShown).toContain("department=Finance");
  });

  /**
   * ⚠ **`urlShown` must not invent a query string.** A `POST`'s params travel in
   * the body; printing them after a `?` would make the one field the panel shows
   * as *the* record of the request describe a request nobody sent. Latent until
   * T16 gave the panel a way to supply sample params at all.
   */
  it("does not print a POST's body params as a query string", async () => {
    get.mockResolvedValue(POST_TOOL);
    vi.stubGlobal("fetch", answers({ status: 201 }));

    const probe = await toolProbeService.probe("ws", {
      toolId: "t-post",
      mode: "live",
      sampleParams: { title: "probe" },
    });

    expect(probe.request.urlShown).not.toContain("title=probe");
    expect(probe.request.urlShown).not.toContain("?");
  });
});

describe("the 405 fallback — once, to GET, and never to the tool's own method", () => {
  it("retries a HEAD 405 with GET exactly once and says it did", async () => {
    get.mockResolvedValue(POST_TOOL);
    const fetchMock = answers({ status: 405 }, { status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await toolProbeService.probe("ws", { toolId: "t-post" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("HEAD");
    expect(fetchMock.mock.calls[1]![1]!.method).toBe("GET");
    expect(probe.request.fellBackToGet).toBe(true);
    expect(probe.request.method).toBe("GET");
    expect(probe.status).toBe(200);
  });

  /**
   * ⚠ Endpoints that answer 405 to both HEAD and GET exist. A loop, or a second
   * retry with the tool's own method, is how this becomes a mutation.
   */
  it("does not retry a SECOND time when GET also answers 405", async () => {
    get.mockResolvedValue(POST_TOOL);
    const fetchMock = answers({ status: 405 }, { status: 405 });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await toolProbeService.probe("ws", { toolId: "t-post" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(probe.verdict).toBe("reachable");
    expect(probe.status).toBe(405);
  });

  it("does NOT fall back in live mode — a 405 there is the tool's own answer", async () => {
    const fetchMock = answers({ status: 405 }, { status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(probe.request.fellBackToGet).toBe(false);
    expect(probe.verdict).toBe("client_error");
  });
});

describe("the status→verdict map — the only place a code becomes a word", () => {
  const liveVerdict = async (status: number, tool = GET_TOOL) => {
    get.mockResolvedValue(tool);
    vi.stubGlobal("fetch", answers({ status }));
    const probe = await toolProbeService.probe("ws", { toolId: tool.id, mode: "live" });
    return probe;
  };

  it("2xx → ok", async () => {
    expect((await liveVerdict(200)).verdict).toBe("ok");
    expect((await liveVerdict(204)).verdict).toBe("ok");
  });

  /**
   * ⚠ **AN UPSTREAM "NO" IS A SUCCESSFUL PROBE** (plan Decision 5). Foundry asked
   * and got an answer. Reporting this as a 5xx would merge "the API said no" into
   * "Foundry could not ask" — the exact ambiguity `applyAuth`'s 424 exists to
   * remove.
   */
  it("401 → auth_rejected, and the ROUTE still succeeded", async () => {
    const probe = await liveVerdict(401);
    expect(probe.verdict).toBe("auth_rejected");
    expect(probe.status).toBe(401);
    expect(probe.message).toContain("401");
  });

  it("403 with a declared credential → auth_rejected; without one → forbidden", async () => {
    getByName.mockResolvedValue({ valueEnc: "k" });
    const withAuth = await liveVerdict(403, {
      ...GET_TOOL,
      secretEnvName: "API_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });
    expect(withAuth.verdict).toBe("auth_rejected");

    getByName.mockResolvedValue(undefined);
    const without = await liveVerdict(403);
    expect(without.verdict).toBe("forbidden");
    // The two remedies differ, because the two situations do.
    expect(without.remedy).toMatch(/unauthenticated|Declare the auth style/);
  });

  /**
   * ⚠ **FOUND AT THE WIRE, 2026-08-20, not by this suite.** A draft with
   * `authStyle: null` pointed at an endpoint that requires a key produced:
   *
   *   "The credential presented as no credential was rejected."
   *
   * One sentence was serving two different facts. Every `auth_rejected` case here
   * had a credential, and the no-credential case was only covered on **403**
   * (`forbidden`) — so a 401 with nothing presented, which is an ordinary
   * combination, had no test at all.
   */
  it("401 with NO credential declared reads as a sentence, not as a mad-lib", async () => {
    const probe = await liveVerdict(401, { ...GET_TOOL, authStyle: null, secretEnvName: null });

    expect(probe.verdict).toBe("auth_rejected");
    expect(probe.message).toContain("This tool presents no credential");
    expect(probe.message).not.toContain("presented as no credential");
    // And the remedy is the one for that case — declare a style, not "check yours".
    expect(probe.remedy).toMatch(/Declare the auth style/);
  });

  it("401 WITH a credential names its placement", async () => {
    getByName.mockResolvedValue({ valueEnc: "k" });
    const probe = await liveVerdict(401, {
      ...GET_TOOL,
      secretEnvName: "API_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });
    expect(probe.message).toContain("presented as header:x-api-key was rejected");
    expect(probe.remedy).toMatch(/Check the auth style/);
  });

  it("404 → not_found, and the remedy names the PATH rather than the host", async () => {
    const probe = await liveVerdict(404);
    expect(probe.verdict).toBe("not_found");
    // ⚠ The host answered, so "check the URL" advice that does not separate the
    // two halves is what sends someone to look at DNS for an hour.
    expect(probe.remedy).toContain("path");
    expect(probe.remedy).toMatch(/resolved/);
  });

  it("5xx → upstream_error, with NO remedy — there is no action on this side", async () => {
    const probe = await liveVerdict(503);
    expect(probe.verdict).toBe("upstream_error");
    expect(probe.remedy).toBeNull();
  });

  it("other 4xx in live mode → client_error", async () => {
    expect((await liveVerdict(400)).verdict).toBe("client_error");
    expect((await liveVerdict(422)).verdict).toBe("client_error");
  });

  /**
   * ⚠ Reachability answers `reachable` for a 500 too, and that reads wrong for one
   * second. The question this mode asks is *"is there a host, does it know this
   * path, does the network allow it"* — and a 500 answers all three. Calling it a
   * failure would tell someone their configuration is broken when the endpoint is.
   */
  it("reachability → reachable on 2xx, 4xx AND 5xx alike", async () => {
    get.mockResolvedValue(POST_TOOL);
    for (const status of [200, 401, 404, 500]) {
      vi.stubGlobal("fetch", answers({ status }));
      const probe = await toolProbeService.probe("ws", { toolId: "t-post" });
      expect(probe.verdict, `status ${status}`).toBe("reachable");
    }
  });

  it("the reachable sentence names the un-sent method, wherever it is quoted", async () => {
    get.mockResolvedValue(POST_TOOL);
    vi.stubGlobal("fetch", answers({ status: 200 }));
    const probe = await toolProbeService.probe("ws", { toolId: "t-post" });
    // The caveat travels with the message, not with the client that renders it.
    expect(probe.message).toContain("POST");
    expect(probe.message).toMatch(/NOT sent/);
    expect(probe.message).toMatch(/does not prove/);
  });
});

describe("nothing that leaves the probe carries a credential", () => {
  /**
   * ⚠ `query` style puts the secret IN THE URL, so `urlShown` is the one field
   * that can leak by construction. It is rebuilt from the raw URL with the value
   * replaced — not taken from the URL the dial signed.
   */
  it("redacts a `query`-auth value out of urlShown, and keeps the parameter visible", async () => {
    get.mockResolvedValue({
      ...GET_TOOL,
      secretEnvName: "API_KEY",
      authStyle: "query",
      authParamName: "api_key",
    });
    getByName.mockResolvedValue({ valueEnc: "s3cr3t-value" });
    vi.stubGlobal("fetch", answers({ status: 200 }));

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.request.urlShown).toContain("api_key=[redacted]");
    // The name is shown because a person debugging needs to see it was sent.
    expect(probe.request.urlShown).not.toContain("s3cr3t-value");
    expect(probe.request.authPresented).toEqual({ style: "query", placement: "query:api_key" });
  });

  it("reports the PLACEMENT of a header credential, never its value", async () => {
    get.mockResolvedValue({
      ...GET_TOOL,
      secretEnvName: "API_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });
    getByName.mockResolvedValue({ valueEnc: "s3cr3t-value" });
    vi.stubGlobal("fetch", answers({ status: 200 }));

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.request.authPresented.placement).toBe("header:x-api-key");
    expect(JSON.stringify(probe)).not.toContain("s3cr3t-value");
  });

  it("a bearer/basic style reports `authorization`, with no value anywhere", async () => {
    get.mockResolvedValue({ ...GET_TOOL, secretEnvName: "TOK", authStyle: "bearer" });
    getByName.mockResolvedValue({ valueEnc: "tok-abc" });
    vi.stubGlobal("fetch", answers({ status: 200 }));

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });
    expect(probe.request.authPresented.placement).toBe("authorization");
    expect(JSON.stringify(probe)).not.toContain("tok-abc");
  });

  /**
   * ⚠ **NO RESPONSE HEADER IS ECHOED** (contract invariant 2). A response can
   * carry `set-cookie`, a rotated token, or a `www-authenticate` with a realm and
   * a nonce. `contentType` is the one header value that crosses, and it is a
   * declared field rather than a passthrough.
   */
  it("echoes no response header except contentType", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({
          "content-type": "application/json",
          "set-cookie": "session=leaked-cookie-value",
          "www-authenticate": 'Bearer realm="leaked-realm"',
        }),
        text: async () => "{}",
      }) as unknown as Response),
    );

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });
    const serialised = JSON.stringify(probe);

    expect(probe.contentType).toBe("application/json");
    expect(serialised).not.toContain("leaked-cookie-value");
    expect(serialised).not.toContain("leaked-realm");
    expect(serialised).not.toContain("set-cookie");
  });

  it("redacts a JSON body by key name and says it did", async () => {
    vi.stubGlobal(
      "fetch",
      answers({ status: 200, body: '{"id":1,"api_key":"AKIA-leaked","name":"Ada"}' }),
    );
    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.body!.redacted).toBe(true);
    expect(probe.body!.preview).not.toContain("AKIA-leaked");
    // The shape survives — the preview is for reading, not just for safety.
    expect(probe.body!.preview).toContain("Ada");
  });

  /**
   * ⚠ Reported as `redacted: false` rather than silently trusted. Key-name
   * redaction has nothing to work on in an HTML error page, and the caller is
   * told so — the honest answer is "this preview is raw and shorter", not a
   * `redacted: true` that means nothing.
   */
  it("truncates a NON-JSON body harder and flags it as unredacted", async () => {
    const html = `<html><body>${"x".repeat(4000)}</body></html>`;
    vi.stubGlobal("fetch", answers({ status: 500, body: html, contentType: "text/html" }));

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.body!.redacted).toBe(false);
    expect(probe.body!.truncated).toBe(true);
    expect(probe.body!.preview.length).toBe(512);
  });

  /**
   * ⚠ JSON-ness is decided by PARSING, not by the header. An endpoint that labels
   * a JSON body `text/plain` must still be redacted — a redaction skipped because
   * of a header is a leak, not a formatting bug.
   */
  it("redacts a JSON body that the endpoint mislabelled as text/plain", async () => {
    vi.stubGlobal(
      "fetch",
      answers({ status: 200, body: '{"token":"leaked-token"}', contentType: "text/plain" }),
    );
    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.body!.redacted).toBe(true);
    expect(probe.body!.preview).not.toContain("leaked-token");
  });

  it("an empty body is null, not an empty preview", async () => {
    vi.stubGlobal("fetch", answers({ status: 204, body: "" }));
    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });
    expect(probe.body).toBeNull();
  });
});

describe("Foundry refusing to ask is a non-200, never a verdict", () => {
  /**
   * ⚠ **The 424 fires with NO HTTP CALL MADE.** A tool declaring a credential
   * that has no stored value is a misconfiguration, and dialling anyway would
   * report it as the endpoint's 401 — which is the confusion WS-B.4 and this 424
   * exist to end.
   */
  it("424 for a declared-but-unstored credential, and nothing is dialled", async () => {
    get.mockResolvedValue({
      ...GET_TOOL,
      secretEnvName: "MISSING_KEY",
      authStyle: "header",
      authParamName: "X-API-Key",
    });
    getByName.mockResolvedValue(undefined);
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const err = await toolProbeService
      .probe("ws", { toolId: "t-get", mode: "live" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StepError);
    expect((err as InstanceType<typeof StepError>).status).toBe(424);
    // ⚠ The assertion that matters: no call went out.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("409 for a shadowed secret, verbatim from execution, with nothing dialled", async () => {
    get.mockResolvedValue({ ...GET_TOOL, secretEnvName: "MAIL_API_KEY", authStyle: "bearer" });
    collisionsFor.mockResolvedValue([
      'datasource "clashing_db" declares MAIL_API_KEY with a different value',
    ]);
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const err = (await toolProbeService
      .probe("ws", { toolId: "t-get", mode: "live" })
      .catch((e: unknown) => e)) as InstanceType<typeof StepError>;

    expect(err.status).toBe(409);
    // Same sentence a run would produce — two surfaces must not disagree.
    expect(err.message).toContain("clashing_db");
    expect((err.detail as { envName?: string }).envName).toBe("MAIL_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 for a tool in another workspace", async () => {
    get.mockResolvedValue(undefined);
    const err = (await toolProbeService
      .probe("ws", { toolId: "someone-elses" })
      .catch((e: unknown) => e)) as InstanceType<typeof StepError>;
    expect(err.status).toBe(404);
  });

  /**
   * ⚠ Reachable in EVERY workspace since 2026-08-18, which it was not when this
   * rule was written: every workspace is created with its platform tools, so
   * `tether_email_send` is a row everywhere.
   */
  it("409 for a LIVE probe of a platform-managed tool", async () => {
    get.mockResolvedValue({ ...POST_TOOL, name: "tether_email_send" });
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const err = (await toolProbeService
      .probe("ws", { toolId: "t-post", mode: "live" })
      .catch((e: unknown) => e)) as InstanceType<typeof StepError>;

    expect(err.status).toBe(409);
    expect((err.detail as { error?: string }).error).toBe("platform_managed_live_probe");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("but REACHABILITY of a platform-managed tool is allowed", async () => {
    // The refusal is about invoking it, not about looking at it.
    get.mockResolvedValue({ ...POST_TOOL, name: "tether_email_send" });
    vi.stubGlobal("fetch", answers({ status: 200 }));
    const probe = await toolProbeService.probe("ws", { toolId: "t-post" });
    expect(probe.verdict).toBe("reachable");
    expect(probe.invoked).toBe(false);
  });

  it("400 with findings for a draft that could not have been created", async () => {
    const err = (await toolProbeService
      .probe("ws", {
        draft: { name: "bad name with spaces", url: "not-a-url", method: "GET" },
      })
      .catch((e: unknown) => e)) as InstanceType<typeof StepError>;

    expect(err.status).toBe(400);
    const detail = err.detail as { error: string; findings: string[] };
    expect(detail.error).toBe("invalid_draft");
    expect(detail.findings.length).toBeGreaterThan(0);
    // The findings name their fields, so the form can render them where it
    // already renders create findings.
    expect(detail.findings.join(" ")).toMatch(/name|url/);
  });

  it("a VALID draft is probed without being saved", async () => {
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await toolProbeService.probe("ws", {
      draft: {
        name: "create_ticket",
        url: "http://stub.invalid/tickets",
        method: "GET",
        authStyle: null,
      },
    });

    expect(probe.verdict).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // `toolRepo.get` is the only read, and a draft does not use it. Nothing here
    // writes: there is no repo write mocked, so a write would throw.
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a request naming both a toolId and a draft, or neither", async () => {
    const { probeInputSchema } = await import("./tool-probe.service.js");
    expect(probeInputSchema.safeParse({ toolId: crypto.randomUUID(), draft: {} }).success).toBe(
      false,
    );
    expect(probeInputSchema.safeParse({}).success).toBe(false);
    expect(probeInputSchema.safeParse({ toolId: crypto.randomUUID() }).success).toBe(true);
  });
});

describe("the network's own failures become verdicts, and quote what happened", () => {
  it("`egress_rejected` → egress_refused, quoting the classification verbatim", async () => {
    // A private address under the profile's rules — the classification sentence
    // is what lets a person match the message to the policy that produced it.
    const { lookup } = await import("node:dns/promises");
    vi.mocked(lookup).mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    vi.stubGlobal("fetch", answers({ status: 200 }));

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.verdict).toBe("egress_refused");
    expect(probe.message).toContain("169.254.169.254");
    expect(probe.status).toBeNull();
    // ⚠ And it says the run would refuse it too — otherwise this reads as a
    // limitation of the test button.
    expect(probe.remedy).toMatch(/run would refuse/);
  });

  it("a timeout → the timeout verdict, naming the deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        });
      }),
    );

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.verdict).toBe("timeout");
    expect(probe.message).toContain("10 seconds");
  });

  it("a dead host → unreachable, with a remedy about the host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 93.184.216.34:80");
      }),
    );

    const probe = await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });

    expect(probe.verdict).toBe("unreachable");
    expect(probe.message).toContain("ECONNREFUSED");
    expect(probe.remedy).toMatch(/hostname|DNS/);
  });

  it("passes a timeout to the dial — execution passes none, the probe must", async () => {
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the rate limit bounds the dialer", () => {
  it("allows 20 in a window and refuses the 21st with a retryAfterSec", async () => {
    vi.stubGlobal("fetch", answers({ status: 200 }));
    for (let i = 0; i < 20; i++) {
      await toolProbeService.probe("ws", { toolId: "t-get", mode: "live" });
    }
    const err = (await toolProbeService
      .probe("ws", { toolId: "t-get", mode: "live" })
      .catch((e: unknown) => e)) as InstanceType<typeof StepError>;

    expect(err.status).toBe(429);
    const detail = err.detail as { error: string; retryAfterSec: number };
    expect(detail.error).toBe("probe_rate_limited");
    expect(detail.retryAfterSec).toBeGreaterThan(0);
    expect(detail.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("counts per workspace, not globally", async () => {
    vi.stubGlobal("fetch", answers({ status: 200 }));
    for (let i = 0; i < 20; i++) {
      await toolProbeService.probe("ws-a", { toolId: "t-get", mode: "live" });
    }
    // A second workspace is unaffected — a shared counter would let one tenant
    // deny the button to every other.
    await expect(
      toolProbeService.probe("ws-b", { toolId: "t-get", mode: "live" }),
    ).resolves.toMatchObject({ verdict: "ok" });
  });

  /**
   * ⚠ The limit is checked BEFORE the dial and AFTER the subject is resolved, so
   * a 404 does not consume a slot and a refused probe does not dial. Asserted
   * because the ordering is invisible from either component.
   */
  it("does not spend a slot on a tool that does not exist", async () => {
    get.mockResolvedValue(undefined);
    for (let i = 0; i < 25; i++) {
      await toolProbeService.probe("ws", { toolId: "nope" }).catch(() => {});
    }
    get.mockResolvedValue(GET_TOOL);
    vi.stubGlobal("fetch", answers({ status: 200 }));
    await expect(
      toolProbeService.probe("ws", { toolId: "t-get", mode: "live" }),
    ).resolves.toMatchObject({ verdict: "ok" });
  });
});

/**
 * ── The marker is written by a probe, and only for a SAVED tool ─────────────
 * P3 · T20, T23. The DROP side lives in `tool-probe-mark.test.ts`, against a real
 * database, because it is `toolService.update` that decides it.
 */
describe("what a probe remembers", () => {
  it("marks a saved tool with the verdict, mode and status it just measured", async () => {
    get.mockResolvedValue(GET_TOOL);
    vi.stubGlobal("fetch", answers({ status: 200, body: '{"ok":true}' }));

    const probe = await toolProbeService.probe("ws", { toolId: "t-get" });

    const mark = markFor("ws", "t-get")!;
    expect(mark).toBeDefined();
    expect(mark.verdict).toBe(probe.verdict);
    expect(mark.mode).toBe(probe.mode);
    expect(mark.status).toBe(200);
    // ⚠ An instant, so the client renders an AGE. A server-rendered "4 min ago"
    // would be wrong by however long the response sat in a queue.
    expect(Date.parse(mark.at)).not.toBeNaN();
  });

  /**
   * ⚠ **The failures are the ones worth remembering**, so the write lives in the
   * single place a `ToolProbe` is constructed rather than at each `return`. There
   * are five of those, and a marker written at the happy one only would read as
   * "never tested" for exactly the tools that need looking at.
   */
  it("marks a FAILING probe too — a red verdict is a fact about a real call", async () => {
    get.mockResolvedValue(GET_TOOL);
    vi.stubGlobal("fetch", answers({ status: 404 }));

    await toolProbeService.probe("ws", { toolId: "t-get" });

    expect(markFor("ws", "t-get")!.verdict).toBe("not_found");
    expect(markFor("ws", "t-get")!.status).toBe(404);
  });

  it("marks a probe that never got an answer at all", async () => {
    get.mockResolvedValue(GET_TOOL);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); }));

    await toolProbeService.probe("ws", { toolId: "t-get" });

    const mark = markFor("ws", "t-get")!;
    expect(mark.verdict).toBe("unreachable");
    // ⚠ `null`, not 0. Nothing answered; a zero would read as a status code.
    expect(mark.status).toBeNull();
  });

  /**
   * ⚠ **A draft marks NOTHING.** There is no row for the mark to describe, and the
   * draft's synthesised row carries `id: ""` precisely so this cannot happen by
   * accident. A draft probe that marked would attach a verdict about un-saved
   * values to whatever tool the form was opened from.
   */
  it("marks nothing for a draft, even a draft that probed successfully", async () => {
    vi.stubGlobal("fetch", answers({ status: 200 }));

    const probe = await toolProbeService.probe("ws", {
      draft: {
        name: "my_new_tool",
        url: "http://stub.invalid/things",
        method: "GET",
        description: "not saved",
      },
    });

    expect(probe.verdict).toBe("ok");
    // Nothing under any key: the draft has no id to be keyed by.
    expect(markFor("ws", "")).toBeUndefined();
    expect(markFor("ws", "t-get")).toBeUndefined();
  });

  /**
   * ⚠ A refusal that never dialled leaves no mark, and that is the honest
   * outcome: 409 (platform-managed) and 424 (credential not stored) are statements
   * about the CONFIGURATION, not measurements of the endpoint. Remembering one as
   * a probe result would put a verdict on a row nothing was asked about.
   */
  it("marks nothing when the probe was refused before anything was dialled", async () => {
    get.mockResolvedValue({ ...GET_TOOL, name: "tether_email_send" });
    const fetchMock = answers({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      toolProbeService.probe("ws", { toolId: "t-get", mode: "live" }),
    ).rejects.toBeInstanceOf(StepError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markFor("ws", "t-get")).toBeUndefined();
  });

  /**
   * ⚠ `tool-probe-mark.ts` DECLARES its two unions rather than importing them —
   * an import would be the cycle that module exists to break. This is the guard
   * that they have not drifted: a verdict this service can produce but a mark
   * cannot hold would be a `lastProbe` that silently never appears.
   */
  it("the marker's verdict union has not drifted from this service's", async () => {
    const { readFileSync } = await import("node:fs");
    const markSrc = readFileSync(
      new URL("./tool-probe-mark.ts", import.meta.url),
      "utf8",
    );
    const serviceSrc = readFileSync(
      new URL("./tool-probe.service.ts", import.meta.url),
      "utf8",
    );
    const wordsIn = (src: string, typeName: string) => {
      const body = src.slice(src.indexOf(`${typeName} =`));
      return (body.slice(0, body.indexOf(";")).match(/"[a-z_]+"/g) ?? []).sort();
    };
    expect(wordsIn(markSrc, "type Verdict")).toEqual(
      wordsIn(serviceSrc, "export type ToolProbeVerdict"),
    );
    expect(wordsIn(markSrc, "type Mode")).toEqual(
      wordsIn(serviceSrc, "export type ToolProbeMode"),
    );
  });
});
