/**
 * The Graph transport — the only module that reads the mail credential.
 * email-send-tool · US1, US4 · plan.md Decision 1
 *
 * ⚠ **Zero real network calls.** `guardedFetch` is mocked, and every assertion is
 * about what we would have sent and how we read what came back. A suite that
 * reached Microsoft would need admin consent to run at all, so it would be
 * skipped, so it would rot — the one manual real send is T043's job and it is
 * recorded by hand.
 *
 * The most valuable assertions here are the negative ones:
 *
 *  - a `200` from Graph is **not** success (`sendMail` answers `202`),
 *  - an unconfigured deployment names **every** missing variable at once,
 *  - `MAIL_ENABLED=false` is a **different** answer from unconfigured,
 *  - and the failure detail **never** carries the request body or the secret.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ⚠ `config` is a frozen literal read at import time, so the mail block has to be
 * mocked rather than mutated. `vi.mock` is hoisted above the imports; the factory
 * reads `mailConfigOverride`, which each test sets before calling in.
 */
let mailConfigOverride: Record<string, unknown> = {};

vi.mock("../config/index.js", () => ({
  get config() {
    return {
      parentApiKey: "test-parent-key",
      mail: {
        tenantId: "tenant-guid",
        clientId: "client-guid",
        clientSecret: "client-secret-value",
        senderUpn: "automation@example.com",
        allowedDomains: ["example.com"],
        enabled: true,
        maxBodyBytes: 262_144,
        maxRecipients: 10,
        selfBase: "http://localhost:4000",
        configured: true,
        missing: [] as string[],
        ...mailConfigOverride,
      },
    };
  },
}));

const guardedFetch = vi.hoisted(() => vi.fn());
vi.mock("@foundry/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@foundry/shared")>();
  return { ...actual, guardedFetch };
});

const { mailService, resetMailTokenCache } = await import("./mail.service.js");

/** A token response Graph would accept. */
const tokenOk = (expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: "graph-token-abc", expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** `sendMail` success: 202 Accepted, EMPTY body, correlation id in the headers. */
const sendAccepted = (requestId = "req-id-123") =>
  new Response(null, {
    status: 202,
    headers: { "request-id": requestId, "client-request-id": "client-req-456" },
  });

const MESSAGE = {
  subject: "Q3 close summary",
  body: "line one\nline two",
  to: ["her@example.com"],
  cc: [] as string[],
};

beforeEach(() => {
  mailConfigOverride = {};
  guardedFetch.mockReset();
  resetMailTokenCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("US4 — an unconfigured deployment says so, and never reports a false green", () => {
  it("refuses with 424 naming EVERY missing variable at once", async () => {
    // ⚠ Naming only the first missing one sends an operator round the loop once
    // per variable. FR-008 requires all of them in one refusal.
    mailConfigOverride = {
      tenantId: "",
      clientSecret: "",
      configured: false,
      missing: ["MAIL_GRAPH_TENANT_ID", "MAIL_GRAPH_CLIENT_SECRET_VALUE"],
    };

    const r = await mailService.send(MESSAGE);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(424);
    expect(r.detail).toMatchObject({
      missing: ["MAIL_GRAPH_TENANT_ID", "MAIL_GRAPH_CLIENT_SECRET_VALUE"],
    });
    // And it did not dial anything to find that out.
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("gives MAIL_ENABLED=false a DISTINCT answer from unconfigured", async () => {
    // Two different fixes: one is "add the variables", the other is "you turned
    // it off". Collapsing them sends someone hunting for a credential they have.
    mailConfigOverride = { enabled: false };

    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(409);
    expect(r.message).toMatch(/MAIL_ENABLED/);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("checks disabled BEFORE unconfigured, so a switched-off deployment is not told to configure", async () => {
    mailConfigOverride = { enabled: false, configured: false, missing: ["MAIL_SENDER_UPN"] };
    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(409);
  });
});

describe("US1 — the token exchange", () => {
  it("sends `scope=https://graph.microsoft.com/.default`", async () => {
    // ⚠ THE reason `resolveOAuth2Bearer` could not be reused: it sends
    // grant_type/client_id/client_secret and NO scope, and Graph's
    // client-credentials grant requires the scope. Without this line the token
    // exchange fails and no amount of correct recipient policy matters.
    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());

    await mailService.send(MESSAGE);

    const [url, init] = guardedFetch.mock.calls[0];
    expect(String(url)).toBe("https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token");
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(body.get("client_id")).toBe("client-guid");
    expect(body.get("client_secret")).toBe("client-secret-value");
  });

  it("dials both hosts through guardedFetch under STRICT, not PERMISSIVE", async () => {
    // Both are external, so this follows ops-proxy's posture rather than the tool
    // path's. PERMISSIVE allows loopback and RFC1918 — meaningless for Microsoft,
    // and a hole if either URL ever became configurable.
    const { STRICT } = await import("@foundry/shared");
    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());

    await mailService.send(MESSAGE);

    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(guardedFetch.mock.calls[0][2]).toBe(STRICT);
    expect(guardedFetch.mock.calls[1][2]).toBe(STRICT);
  });

  it("maps a token-exchange failure to 502 without echoing the request body", async () => {
    // ⚠ The detail-narrowing rule copied from resolveOAuth2Bearer: a broken
    // provider echo must not carry a client secret into a log line.
    guardedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: "AADSTS7000215: Invalid client secret provided",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(502);
    expect(r.detail).toMatchObject({ status: 401, graphError: "invalid_client" });
    const serialised = JSON.stringify(r);
    expect(serialised).not.toContain("client-secret-value");
    expect(serialised).not.toContain("line one"); // the body never travels into an error
  });

  it("maps a transport throw to 502 rather than crashing the request", async () => {
    guardedFetch.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND login.microsoftonline.com"));
    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(502);
  });

  it("treats a 200 with no access_token as a failure, not a token", async () => {
    guardedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ token_type: "Bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(502);
  });
});

describe("US1 — the token cache", () => {
  it("exchanges once across two sends", async () => {
    guardedFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(sendAccepted())
      .mockResolvedValueOnce(sendAccepted());

    await mailService.send(MESSAGE);
    await mailService.send(MESSAGE);

    const tokenCalls = guardedFetch.mock.calls.filter(([u]) =>
      String(u).includes("login.microsoftonline.com"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("re-exchanges when the provider's expiry is inside the safety margin", async () => {
    // A provider answering `expires_in: 5` yields a negative TTL, so the entry is
    // already expired and every call re-exchanges. That is the SAFE failure mode —
    // never present a token we suspect is dying — not a bug to clamp away.
    guardedFetch
      .mockResolvedValueOnce(tokenOk(5))
      .mockResolvedValueOnce(sendAccepted())
      .mockResolvedValueOnce(tokenOk(5))
      .mockResolvedValueOnce(sendAccepted());

    await mailService.send(MESSAGE);
    await mailService.send(MESSAGE);

    const tokenCalls = guardedFetch.mock.calls.filter(([u]) =>
      String(u).includes("login.microsoftonline.com"),
    );
    expect(tokenCalls).toHaveLength(2);
  });

  it("resetMailTokenCache() gives a suite a cold cache", async () => {
    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());
    await mailService.send(MESSAGE);

    resetMailTokenCache();

    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());
    await mailService.send(MESSAGE);

    const tokenCalls = guardedFetch.mock.calls.filter(([u]) =>
      String(u).includes("login.microsoftonline.com"),
    );
    expect(tokenCalls).toHaveLength(2);
  });
});

describe("US1 — the sendMail call", () => {
  beforeEach(() => {
    guardedFetch.mockResolvedValueOnce(tokenOk());
  });

  it("posts to /users/{senderUpn}/sendMail with the bearer token", async () => {
    guardedFetch.mockResolvedValueOnce(sendAccepted());
    await mailService.send(MESSAGE);

    const [url, init] = guardedFetch.mock.calls[1];
    expect(String(url)).toBe(
      "https://graph.microsoft.com/v1.0/users/automation@example.com/sendMail",
    );
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer graph-token-abc");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("defaults to contentType `Text` when the caller does not ask for HTML", async () => {
    // ⚠ The default is the safe one. A caller that does not think about content
    // type gets plain text — the thing that stops unvetted upstream content
    // rendering as markup in a recipient's client (spec.md Edge Cases).
    guardedFetch.mockResolvedValueOnce(sendAccepted());
    await mailService.send(MESSAGE);

    const sent = JSON.parse(String((guardedFetch.mock.calls[1][1] as RequestInit).body));
    expect(sent.message.body.contentType).toBe("Text");
    expect(sent.message.body.content).toBe("line one\nline two");
    expect(sent.message.subject).toBe("Q3 close summary");
    expect(sent.saveToSentItems).toBe(true);
  });

  it("sends contentType `HTML` only when the caller asks for it", async () => {
    /**
     * ⚠ The ONE legitimate producer of that flag is `mail-report.ts`, which
     * escapes every value it interpolates. This asserts the flag is honoured
     * rather than that HTML is generally safe — the safety lives in the renderer
     * and in `mail-report.test.ts`.
     */
    guardedFetch.mockResolvedValueOnce(sendAccepted());
    await mailService.send({ ...MESSAGE, body: "<table></table>", contentType: "HTML" });

    const sent = JSON.parse(String((guardedFetch.mock.calls[1][1] as RequestInit).body));
    expect(sent.message.body.contentType).toBe("HTML");
    expect(sent.message.body.content).toBe("<table></table>");
  });

  it("shapes recipients as Graph expects and omits an empty cc", async () => {
    guardedFetch.mockResolvedValueOnce(sendAccepted());
    await mailService.send({ ...MESSAGE, to: ["a@example.com", "b@example.com"], cc: [] });

    const sent = JSON.parse(String((guardedFetch.mock.calls[1][1] as RequestInit).body));
    expect(sent.message.toRecipients).toEqual([
      { emailAddress: { address: "a@example.com" } },
      { emailAddress: { address: "b@example.com" } },
    ]);
    expect(sent.message.ccRecipients ?? []).toEqual([]);
  });

  it("includes cc when there is one", async () => {
    guardedFetch.mockResolvedValueOnce(sendAccepted());
    await mailService.send({ ...MESSAGE, cc: ["c@example.com"] });

    const sent = JSON.parse(String((guardedFetch.mock.calls[1][1] as RequestInit).body));
    expect(sent.message.ccRecipients).toEqual([{ emailAddress: { address: "c@example.com" } }]);
  });

  it("treats 202 as success and returns the correlation id from the headers", async () => {
    // Graph answers with an EMPTY body — there is no provider message id, so the
    // id we return is the correlation id a support case is opened against.
    guardedFetch.mockResolvedValueOnce(sendAccepted("the-request-id"));
    const r = await mailService.send(MESSAGE);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.messageId).toBe("the-request-id");
  });

  it("falls back to client-request-id when request-id is absent", async () => {
    guardedFetch.mockResolvedValueOnce(
      new Response(null, { status: 202, headers: { "client-request-id": "only-client-id" } }),
    );
    const r = await mailService.send(MESSAGE);
    if (!r.ok) throw new Error("unreachable");
    expect(r.messageId).toBe("only-client-id");
  });

  it("does NOT treat a 200 as success", async () => {
    // ⚠ `sendMail` answers 202. A 200 means something else answered — a proxy, a
    // captive portal, a misrouted URL — and accepting it would report a send that
    // never happened. This is the false-green assertion.
    guardedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const r = await mailService.send(MESSAGE);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(502);
  });

  it("maps a 403 to 502 carrying Graph's error code — the admin-consent case", async () => {
    // The most likely real failure: a valid credential with no admin consent, or
    // no application access policy for this mailbox. The detail has to name it,
    // because from Foundry's side the credential looks perfect.
    guardedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "ErrorAccessDenied", message: "Access to OData is disabled." },
        }),
        { status: 403, headers: { "content-type": "application/json", "request-id": "rq-403" } },
      ),
    );

    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(502);
    expect(r.detail).toMatchObject({ status: 403, graphError: "ErrorAccessDenied", requestId: "rq-403" });
  });

  it("never puts the message body into a failure detail", async () => {
    guardedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "ErrorInternalServerError" } }), { status: 500 }),
    );
    const r = await mailService.send({ ...MESSAGE, body: "SENTINEL-BODY payroll 3184.22" });
    if (r.ok) throw new Error("unreachable");
    expect(JSON.stringify(r)).not.toContain("SENTINEL-BODY");
    expect(JSON.stringify(r)).not.toContain("3184.22");
  });
});

describe("US1 — throttling", () => {
  it("retries a 429 exactly ONCE, honouring Retry-After, then fails", async () => {
    // Once, not a backoff loop: a step is already inside a request with a timeout,
    // and a long retry chain turns a throttle into a hung flow. Two attempts total.
    vi.useFakeTimers();
    try {
      guardedFetch
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }))
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }));

      const promise = mailService.send(MESSAGE);
      await vi.runAllTimersAsync();
      const r = await promise;

      if (r.ok) throw new Error("unreachable");
      expect(r.status).toBe(502);
      const sendCalls = guardedFetch.mock.calls.filter(([u]) =>
        String(u).includes("graph.microsoft.com"),
      );
      expect(sendCalls).toHaveLength(2); // the original and one retry, no more
    } finally {
      vi.useRealTimers();
    }
  });

  it("succeeds when the retry is accepted", async () => {
    vi.useFakeTimers();
    try {
      guardedFetch
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "1" } }))
        .mockResolvedValueOnce(sendAccepted("after-retry"));

      const promise = mailService.send(MESSAGE);
      await vi.runAllTimersAsync();
      const r = await promise;

      if (!r.ok) throw new Error(`expected success, got ${r.status}`);
      expect(r.messageId).toBe("after-retry");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps an absurd Retry-After rather than sleeping for an hour", async () => {
    // A provider is allowed to say 3600. A request handler is not allowed to wait
    // that long, so the wait is capped and the send fails fast instead of hanging.
    vi.useFakeTimers();
    try {
      guardedFetch
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(
          new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
        )
        .mockResolvedValueOnce(sendAccepted());

      const promise = mailService.send(MESSAGE);
      await vi.advanceTimersByTimeAsync(30_000);
      const r = await promise;
      expect(r.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("attachments reach Graph as base64 fileAttachments", () => {
  it("encodes the bytes as base64, with the name and the checked content type", async () => {
    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());

    const csv = "name,city\nZoë,Pune\n";
    await mailService.send({
      ...MESSAGE,
      attachments: [{ name: "report.csv", contentType: "text/csv", data: Buffer.from(csv, "utf8") }],
    });

    const [, init] = guardedFetch.mock.calls[1];
    const sent = JSON.parse(String(init.body)) as {
      message: { attachments?: Array<Record<string, string>> };
    };
    expect(sent.message.attachments).toEqual([
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "report.csv",
        contentType: "text/csv",
        contentBytes: Buffer.from(csv, "utf8").toString("base64"),
      },
    ]);
    // Round trip — the recipient opens exactly the bytes the server built,
    // UTF-8 included.
    expect(Buffer.from(sent.message.attachments![0].contentBytes, "base64").toString("utf8")).toBe(csv);
  });

  it("passes a generated .xlsx through byte-for-byte — binary is not re-encoded", async () => {
    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());

    // A minimal PK zip header stands in for the workbook; what is pinned is
    // that bytes in are the same bytes (base64'd) out.
    const workbook = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    await mailService.send({
      ...MESSAGE,
      attachments: [
        {
          name: "report.xlsx",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          data: workbook,
        },
      ],
    });

    const [, init] = guardedFetch.mock.calls[1];
    const sent = JSON.parse(String(init.body)) as {
      message: { attachments?: Array<Record<string, string>> };
    };
    expect(sent.message.attachments![0].contentBytes).toBe(workbook.toString("base64"));
    expect(
      Buffer.from(sent.message.attachments![0].contentBytes, "base64").equals(workbook),
    ).toBe(true);
  });

  it("THE CONTROL — no attachments means no `attachments` key at all", async () => {
    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());
    await mailService.send(MESSAGE);
    const [, init] = guardedFetch.mock.calls[1];
    expect(JSON.parse(String(init.body)).message).not.toHaveProperty("attachments");
  });
});

/**
 * A message past ~3.5 MB cannot go in one `sendMail` request (Graph caps it at 4 MB), so it is saved as a draft,
 * each large file goes up through an upload session in pieces, and the draft is sent (2026-10-12).
 */
describe("a large message: draft, upload, send", () => {
  const big = { name: "LOP report.xlsx", contentType: "application/vnd.ms-excel", data: Buffer.alloc(9 * 1024 * 1024, 7) };
  const small = { name: "notes.csv", contentType: "text/csv", data: Buffer.from("a,b\n1,2\n") };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("saves a draft, adds the small file, uploads the large one in 320 KiB-multiple pieces, then sends", async () => {
    guardedFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(json(201, { id: "draft-1" }))
      .mockResolvedValueOnce(json(201, {}))
      .mockResolvedValueOnce(json(200, { uploadUrl: "https://outlook.office.com/upload/abc" }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(201, {}))
      .mockResolvedValueOnce(new Response(null, { status: 202, headers: { "request-id": "r-9" } }));
    const out = await mailService.send({ ...MESSAGE, attachments: [small, big] });
    expect(out).toMatchObject({ ok: true, messageId: "r-9" });

    const calls = guardedFetch.mock.calls.slice(1) as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toMatch(/\/users\/automation@example\.com\/messages$/);
    expect(JSON.parse(String(calls[0]![1].body))).not.toHaveProperty("attachments");
    expect(calls[1]![0]).toMatch(/\/messages\/draft-1\/attachments$/);
    expect(calls[2]![0]).toMatch(/\/messages\/draft-1\/attachments\/createUploadSession$/);
    const puts = calls.slice(3, 6);
    const chunk = 12 * 320 * 1024;
    expect(puts.map(([, init]) => (init.headers as Record<string, string>)["content-range"])).toEqual([
      `bytes 0-${chunk - 1}/${big.data.length}`,
      `bytes ${chunk}-${2 * chunk - 1}/${big.data.length}`,
      `bytes ${2 * chunk}-${big.data.length - 1}/${big.data.length}`,
    ]);
    // The upload address carries its own credential; presenting the bearer too is refused by Graph.
    for (const [, init] of puts) expect(init.headers).not.toHaveProperty("authorization");
    expect(calls[6]![0]).toMatch(/\/messages\/draft-1\/send$/);
  });

  it("a size the tenant refuses is a 413 in plain words, and the draft is deleted", async () => {
    guardedFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(json(201, { id: "draft-2" }))
      .mockResolvedValueOnce(json(200, { uploadUrl: "https://outlook.office.com/upload/x" }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(201, {}))
      .mockResolvedValueOnce(json(413, { error: { code: "ErrorMessageSizeExceeded", message: "too big" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const out = await mailService.send({ ...MESSAGE, attachments: [big] });
    expect(out).toMatchObject({ ok: false, status: 413 });
    expect((out as { message: string }).message).toMatch(/^your mail server refused an email this size \(9\.0 MB\)/);
    const last = guardedFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(last[1].method).toBe("DELETE");
    expect(last[0]).toMatch(/\/messages\/draft-2$/);
  });

  it("a small message still goes in one sendMail request", async () => {
    guardedFetch.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(sendAccepted());
    await mailService.send({ ...MESSAGE, attachments: [small] });
    expect((guardedFetch.mock.calls[1] as [string])[0]).toMatch(/\/sendMail$/);
  });
});
