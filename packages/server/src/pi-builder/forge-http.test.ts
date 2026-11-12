import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORGE_HTTP_CAPS,
  ForgeHttpError,
  HTTP_CONFIRM_TTL_MS,
  cancelHttp,
  confirmHttp,
  draftOf,
  executeHttp,
  forgeHttpBodySchema,
  guardedTransport,
  httpPolicy,
  prepareHttp,
  resetForgeHttpRateLimit,
  type ForgeHttpContext,
  type ForgeHttpDeps,
  type ForgeHttpRecord,
  type HttpSecret,
  type HttpTransport,
} from "./forge-http.js";

const V = "s3cr3t-value";
const ctx: ForgeHttpContext = { workspaceId: "w", sessionId: "s", chatId: "c", mode: "agent", actor: "me" };
type Reply = Awaited<ReturnType<HttpTransport>>;
type Call = Parameters<HttpTransport>[0];

const reply = (o: Partial<Reply> & { json?: unknown; text?: string } = {}): Reply => ({
  status: o.status ?? 200,
  statusText: o.statusText ?? "OK",
  headers: o.headers ?? { "content-type": "application/json" },
  body: o.body ?? Buffer.from(o.text ?? JSON.stringify(o.json ?? { ok: true })),
  truncated: o.truncated ?? false,
});

const secretOf = (placement: HttpSecret["placement"], hosts = ["api.example.com"]): HttpSecret => ({
  name: "key",
  value: V,
  hosts,
  placement,
});

function setup(replies: Reply[], secret: HttpSecret | null = secretOf({ kind: "header", name: "X-API-Key" }), over: Partial<ForgeHttpDeps> = {}) {
  const calls: Call[] = [];
  const rows: ForgeHttpRecord[] = [];
  let i = 0;
  const markUsed = vi.fn(async () => {});
  const deps: ForgeHttpDeps = {
    webAccess: async () => true,
    secret: async () => secret,
    markUsed,
    transport: async (r) => {
      calls.push(r);
      return replies[Math.min(i++, replies.length - 1)]!;
    },
    record: async (row) => void rows.push(row),
    scrub: (t) => t.split(V).join("[secret:x]"),
    now: () => 1_000_000,
    caps: { ...DEFAULT_FORGE_HTTP_CAPS },
    ...over,
  };
  return { calls, rows, deps, markUsed };
}

const parse = (v: unknown) => forgeHttpBodySchema.parse(v);
const get = (url: string, secret?: string) => parse({ method: "GET", url, ...(secret ? { secret } : {}) });

beforeEach(() => resetForgeHttpRateLimit());

describe("forge http", () => {
  it("(a) injects a header secret and never returns it", async () => {
    const t = setup([reply({ json: { echo: V } })]);
    const p = await prepareHttp(ctx, get("https://api.example.com/v1?a=1", "key"), t.deps);
    const r = await executeHttp(ctx, p, t.deps);
    expect(t.calls[0]!.headers["x-api-key"]).toBe(V);
    expect(JSON.stringify(r)).not.toContain(V);
    expect(r.data).toEqual({ echo: "[secret:x]" });
    expect(t.markUsed).toHaveBeenCalledWith("key");
    expect(JSON.stringify(t.rows)).not.toContain(V);
    expect(t.rows[0]!.ok).toBe(true);
  });

  it("(b) bearer and query placements", async () => {
    const b = setup([reply()], secretOf({ kind: "bearer", name: null }));
    await executeHttp(ctx, await prepareHttp(ctx, get("https://api.example.com/", "key"), b.deps), b.deps);
    expect(b.calls[0]!.headers["authorization"]).toBe(`Bearer ${V}`);

    const q = setup([reply()], secretOf({ kind: "query", name: "key" }));
    const r = await executeHttp(ctx, await prepareHttp(ctx, get("https://api.example.com/x?a=1", "key"), q.deps), q.deps);
    expect(q.calls[0]!.url.search).toContain(`key=${V}`);
    expect(JSON.stringify(r)).not.toContain(V);
    expect(JSON.stringify(q.rows)).not.toContain(V);
  });

  it("(c) refuses another host and never calls the transport", async () => {
    const t = setup([reply()]);
    await expect(prepareHttp(ctx, get("https://other.example.com/", "key"), t.deps)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("only for api.example.com"),
    });
    expect(t.calls).toHaveLength(0);
  });

  it("refuses setting the header the secret fills", async () => {
    const t = setup([reply()]);
    const input = parse({ method: "GET", url: "https://api.example.com/", secret: "key", headers: { "X-Api-Key": "mine" } });
    await expect(prepareHttp(ctx, input, t.deps)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("(d) drops the secret on a cross-host redirect, keeps it on the same host", async () => {
    const t = setup(
      [reply({ status: 302, headers: { location: "https://evil.example.net/x?key=" + V } }), reply()],
      secretOf({ kind: "query", name: "key" }),
    );
    const p = await prepareHttp(ctx, parse({ method: "GET", url: "https://api.example.com/", secret: "key", headers: { Authorization: "x", Cookie: "c=1" } }), t.deps);
    const r = await executeHttp(ctx, p, t.deps);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]!.url.searchParams.has("key")).toBe(false);
    expect(t.calls[1]!.headers["authorization"]).toBeUndefined();
    expect(t.calls[1]!.headers["cookie"]).toBeUndefined();
    expect(r.secretDropped).toBe(true);

    const h = setup(
      [reply({ status: 302, headers: { location: "/next" } }), reply()],
      secretOf({ kind: "header", name: "X-API-Key" }),
    );
    const r2 = await executeHttp(ctx, await prepareHttp(ctx, get("https://api.example.com/", "key"), h.deps), h.deps);
    expect(h.calls[1]!.headers["x-api-key"]).toBe(V);
    expect(h.calls[1]!.url.pathname).toBe("/next");
    expect(r2.secretDropped).toBeUndefined();

    const back = setup(
      [
        reply({ status: 302, headers: { location: "https://evil.example.net/" } }),
        reply({ status: 302, headers: { location: "https://api.example.com/" } }),
        reply(),
      ],
      secretOf({ kind: "header", name: "X-API-Key" }),
    );
    await executeHttp(ctx, await prepareHttp(ctx, get("https://api.example.com/", "key"), back.deps), back.deps);
    expect(back.calls[2]!.headers["x-api-key"]).toBeUndefined();
  });

  it("(e) POST needs confirmation; the draft holds no value; expiry and confirm", async () => {
    const t = setup([reply()]);
    const input = parse({ method: "POST", url: "https://api.example.com/items", secret: "key", json: { a: 1 } });
    const p = await prepareHttp(ctx, input, t.deps);
    expect(await httpPolicy(ctx, { method: "POST", url: p.url, secret: "key" })).toBe("confirm");
    expect(await httpPolicy(ctx, { method: "GET", url: p.url, secret: null })).toBe("direct");
    const draft = draftOf(p, t.deps.now(), t.deps.scrub);
    expect(JSON.stringify(draft)).not.toContain(V);
    expect(draft.secret).toEqual({ name: "key", host: "api.example.com", placement: { kind: "header", name: "X-API-Key" } });

    const late = setup([reply()], undefined, { now: () => t.deps.now() + HTTP_CONFIRM_TTL_MS + 1 });
    const e = await confirmHttp(ctx, draft, late.deps);
    expect(e.outcome).toBe("expired");
    expect(late.calls).toHaveLength(0);

    const ok = await confirmHttp(ctx, draft, t.deps);
    expect(ok.outcome).toBe("done");
    expect(ok.message).toContain("HTTP 200 OK");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.headers["x-api-key"]).toBe(V);
    expect(t.calls[0]!.body?.toString()).toBe('{"a":1}');
    expect(t.calls[0]!.headers["content-type"]).toBe("application/json");

    await cancelHttp(ctx, draft, { label: "Ann" }, t.deps);
    expect(t.rows.at(-1)).toMatchObject({ ok: false, error: "cancelled: Ann pressed Cancel; nothing was sent" });
  });

  it("(f) a POST redirect is not followed", async () => {
    const t = setup([reply({ status: 302, headers: { location: "https://api.example.com/z" } })]);
    const p = await prepareHttp(ctx, parse({ method: "POST", url: "https://api.example.com/", body: "x" }), t.deps);
    const r = await executeHttp(ctx, p, t.deps);
    expect(r.status).toBe(302);
    expect(t.calls).toHaveLength(1);
  });

  it("(g) drops set-cookie and returns a 401", async () => {
    const t = setup([reply({ status: 401, statusText: "Unauthorized", headers: { "content-type": "text/plain", "set-cookie": ["a=1"], "X-Multi": ["a", "b"] }, text: "nope" })], null);
    const r = await executeHttp(ctx, await prepareHttp(ctx, get("https://api.example.com/"), t.deps), t.deps);
    expect(r.status).toBe(401);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.headers["x-multi"]).toBe("a, b");
    expect(r.text).toBe("nope");
  });

  it("(h) web access off and wrong mode are 403", async () => {
    const t = setup([reply()], null, { webAccess: async () => false });
    await expect(prepareHttp(ctx, get("https://api.example.com/"), t.deps)).rejects.toMatchObject({ statusCode: 403 });
    expect(t.rows[0]!.ok).toBe(false);
    await expect(prepareHttp({ ...ctx, mode: "workflow" }, get("https://api.example.com/"), setup([reply()]).deps)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("(i) rate limit", async () => {
    const t = setup([reply()], null);
    t.deps.caps.perMinute = 2;
    await prepareHttp(ctx, get("https://api.example.com/"), t.deps);
    await prepareHttp(ctx, get("https://api.example.com/"), t.deps);
    await expect(prepareHttp(ctx, get("https://api.example.com/"), t.deps)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("(j) the real transport refuses private addresses", async () => {
    const t = setup([reply()], null, { transport: guardedTransport });
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/"]) {
      const err = await executeHttp(ctx, await prepareHttp(ctx, get(u), t.deps), t.deps).catch((e) => e);
      expect(err).toBeInstanceOf(ForgeHttpError);
      expect(err.statusCode).toBe(403);
    }
  });

  it("(k) a missing secret is 404", async () => {
    const t = setup([reply()], null);
    await expect(prepareHttp(ctx, get("https://api.example.com/", "key"), t.deps)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("(l) binary bodies: withheld when they hold the secret, base64 otherwise; truncation noted", async () => {
    const hdr = { "content-type": "application/octet-stream" };
    const a = setup([reply({ headers: hdr, body: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(V)]) })]);
    const ra = await executeHttp(ctx, await prepareHttp(ctx, get("https://api.example.com/", "key"), a.deps), a.deps);
    expect(ra.base64).toBeUndefined();
    expect(ra.text).toContain("withheld");

    const bytes = Buffer.from([0xff, 0xfe, 1, 2]);
    const b = setup([reply({ headers: hdr, body: bytes, truncated: true })]);
    const rb = await executeHttp(ctx, await prepareHttp(ctx, get("https://api.example.com/", "key"), b.deps), b.deps);
    expect(rb.base64).toBe(bytes.toString("base64"));
    expect(rb.note).toContain("larger than 2 MB");
  });

  it("schema refinements", () => {
    expect(forgeHttpBodySchema.safeParse({ method: "GET", url: "https://a.b/", body: "x" }).success).toBe(false);
    expect(forgeHttpBodySchema.safeParse({ method: "POST", url: "https://a.b/", body: "x", json: {} }).success).toBe(false);
    expect(forgeHttpBodySchema.safeParse({ method: "POST", url: "https://a.b/", json: {} }).success).toBe(true);
  });
});
