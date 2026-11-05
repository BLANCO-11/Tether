/**
 * The proxy route is the one place in `packages/client` that holds
 * `PARENT_API_KEY`, so it is the one place where "who is asking" has to be
 * answered before anything is forwarded.
 *
 * ── What each test here is defending ────────────────────────────────────────
 *
 * Before this file, the route had NO session check of its own. The whole control
 * was the gate's matcher (`proxy.ts`; `middleware.ts` before Next 16) — one negative-lookahead regex — and the
 * standard Next idiom of adding `api` to that exclusion list would have handed
 * the entire parent API to anonymous callers, carrying the root key, with no
 * test going red. So the first test deliberately does not go through the
 * middleware at all: it calls the route handler directly, which is exactly the
 * state the matcher change would create.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

import { GET, POST, PUT, PATCH, DELETE } from "./[...path]/route";
import { dualParams } from "@/lib/test-dual-params";

/** A NextRequest is a Request plus `nextUrl`; the route reads only those. */
function reqFor(path: string, method = "GET", search = "") {
  const url = `http://localhost:4002/api/foundry/${path}${search}`;
  const r = new Request(url, { method, ...(method === "GET" ? {} : { body: "{}" }) });
  Object.defineProperty(r, "nextUrl", { value: new URL(url), configurable: true });
  return r as never;
}

/**
 * ⚠ `params` is handed as a value that reads BOTH ways (see `lib/test-dual-params.ts`): Next 14 passes `ctx.params` as an object,
 * Next 15+ as a Promise. The route's own docblock says the whole control is "the handler reads its path and refuses" — so the
 * way it reads `path` is exactly what the upgrade can break, and these tests must stay green on both sides of it.
 */
const ctx = (path: string) => ({ params: dualParams({ path: path.split("/") }) }) as never;

/** Named so `fetchSpy` can take its type without spelling out fetch's overloads. */
const spyOnFetch = () => vi.spyOn(globalThis, "fetch");
let fetchSpy: ReturnType<typeof spyOnFetch>;

beforeEach(() => {
  authMock.mockReset();
  fetchSpy = spyOnFetch().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

describe("the Foundry proxy refuses before it forwards", () => {
  /**
   * ⚠ THE ONE THAT MATTERS. This is the middleware-bypassed case: the handler is
   * invoked directly, as it would be if `/api/*` were ever excluded from the
   * matcher. It must refuse on its own.
   */
  it("401s an unauthenticated request without dialing the parent API", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(reqFor("workspaces"), ctx("workspaces"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "not_authenticated" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated WRITE too — not just reads", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(
      reqFor("workspaces/abc/flows", "POST"),
      ctx("workspaces/abc/flows"),
    );

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * A 401 with a JSON body, never the 302-to-HTML the middleware would produce:
   * `foundryApi` parses JSON, so a redirect surfaces as a parse error rather
   * than as "you are signed out".
   */
  it("answers JSON, so a signed-out client sees a status and not a parse error", async () => {
    authMock.mockResolvedValue(null);

    const res = await GET(reqFor("health"), ctx("health"));

    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.status).not.toBe(302);
  });
});

describe("the segments the browser may never reach", () => {
  beforeEach(() => authMock.mockResolvedValue({ backendToken: "jwt.for.person" }));

  /**
   * `routes/oracle.ts` says "nothing in the product may call it" and, until this
   * change, nothing enforced that: the proxy presented the parent key to it for
   * any signed-in caller. A flow (or a screen) reading the oracle is grading
   * itself against the answer key.
   */
  it("403s the correctness oracle even for a signed-in user", async () => {
    const res = await GET(reqFor("test-oracle/screening"), ctx("test-oracle/screening"));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "not_proxyable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("403s the engine callback surfaces, so the root key is never presented to them", async () => {
    for (const p of ["steps/batch", "executions/begin"]) {
      const res = await POST(reqFor(p, "POST"), ctx(p));
      expect(res.status, p).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /** Checked on the normalised first segment, so casing is not a way past it. */
  it("is not case-sensitive", async () => {
    const res = await GET(reqFor("Test-Oracle/screening"), ctx("Test-Oracle/screening"));
    expect(res.status).toBe(403);
  });

  /**
   * ⚠ THE CONTROL. A refusal list that refuses everything is not a control, it is
   * an outage — and it would present exactly as "the app is broken" rather than
   * as a security decision. The ordinary workspace path must still forward, with
   * both headers.
   */
  it("CONTROL — an ordinary workspace call still forwards, with the key and the identity", async () => {
    const res = await GET(reqFor("workspaces/abc/flows"), ctx("workspaces/abc/flows"));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(target).toContain("/api/workspaces/abc/flows");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeTruthy();
    expect(headers["x-foundry-identity"]).toBe("jwt.for.person");
  });

  it("forwards a raw upload's bytes and its file name, and no other browser header", async () => {
    const url = "http://localhost:4002/api/foundry/workspaces/abc/pi-builder/sessions/s/attachments";
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
    const r = new Request(url, {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/octet-stream", "x-file-name": "Q3%20report.pdf", "x-foundry-identity": "forged" },
    });
    Object.defineProperty(r, "nextUrl", { value: new URL(url), configurable: true });
    const p = "workspaces/abc/pi-builder/sessions/s/attachments";
    await POST(r as never, ctx(p));
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-file-name"]).toBe("Q3%20report.pdf");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["x-foundry-identity"]).toBe("jwt.for.person");
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(bytes);
  });

  /**
   * A denied segment must not be reachable by burying it deeper either — and
   * equally, a workspace-scoped path that merely CONTAINS the word must still
   * work, or the check is a substring match pretending to be a path check.
   */
  it("matches the first segment only — a workspace-scoped lookalike still forwards", async () => {
    const p = "workspaces/abc/datasources/1/executions";
    const res = await GET(reqFor(p), ctx(p));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("every verb reads its path segments the same way", () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ backendToken: "jwt.for.person" });
    // A fresh Response per call: a body can be read once, and these cases call the route several times.
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
  });

  /**
   * One case per exported verb. A route whose GET was migrated to the awaited form and whose DELETE was not forwards
   * `/api/undefined` for one verb only — the kind of half-migration nothing else would notice.
   */
  it("forwards the path on GET, POST, PUT, PATCH and DELETE", async () => {
    const verbs = { GET, POST, PUT, PATCH, DELETE } as const;
    for (const [method, handler] of Object.entries(verbs)) {
      fetchSpy.mockClear();
      const p = "workspaces/abc/flows";
      await handler(reqFor(p, method), ctx(p));
      expect(fetchSpy, method).toHaveBeenCalledTimes(1);
      const [target] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(target, method).toContain("/api/workspaces/abc/flows");
      expect(target, method).not.toContain("undefined");
    }
  });

  it("refuses each denied segment on every verb, not only GET", async () => {
    const verbs = { GET, POST, PUT, PATCH, DELETE } as const;
    for (const seg of ["test-oracle", "steps", "executions", "mail"]) {
      for (const [method, handler] of Object.entries(verbs)) {
        const res = await handler(reqFor(`${seg}/x`, method), ctx(`${seg}/x`));
        expect(res.status, `${method} ${seg}`).toBe(403);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses the mail surface for a signed-in user (it was the one segment without a case)", async () => {
    const res = await POST(reqFor("mail/send", "POST"), ctx("mail/send"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "not_proxyable" });
  });

  /** The root key is presented UPSTREAM and must never come back to the browser in a header or a body. */
  it("never returns the parent key to the browser", async () => {
    const res = await GET(reqFor("workspaces/abc/flows"), ctx("workspaces/abc/flows"));
    const key = process.env.PARENT_API_KEY ?? "dev-parent-key";
    const headerText = JSON.stringify([...res.headers.entries()]);
    expect(headerText).not.toContain(key);
    expect(await res.text()).not.toContain(key);
  });

  it("CONTROL: the query string is forwarded with the path", async () => {
    const p = "workspaces/abc/flows";
    await GET(reqFor(p, "GET", "?view=live"), ctx(p));
    const [target] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(target).toMatch(/\/api\/workspaces\/abc\/flows\?view=live$/);
  });
});
