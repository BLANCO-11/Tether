// src/app/api/foundry/[...path]/route.ts — same-origin proxy to the Foundry
// Parent API (packages/server on :4000). The browser talks to this route; this
// route injects `x-api-key: PARENT_API_KEY` server-side so the key never reaches
// the client. Path/query/body/verb/content-type are forwarded verbatim.
//
//   browser  /api/foundry/workspaces/:id/scripts   →  ${PARENT_API_URL}/api/workspaces/:id/scripts
//   browser  /api/foundry/health                    →  ${PARENT_API_URL}/api/health
import { NextRequest } from "next/server";
import { auth } from "@/auth";

const BASE = process.env.PARENT_API_URL ?? "http://localhost:4000";
const KEY = process.env.PARENT_API_KEY ?? "dev-parent-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * First path segments this route will not forward, whatever the caller is.
 *
 * ── Why a short DENY list and not an allowlist ───────────────────────────────
 *
 * An allowlist is the stronger shape and it is the wrong one here: the client's
 * call surface is ~200 paths across `lib/foundry-client.ts`, it grows with every
 * UI feature, and a path missing from a hand-transcribed list is a broken screen
 * with no error that names the list. So this denies the two things that are
 * *documented* as never being browser-reachable, and nothing else — a narrower
 * claim, and one that cannot be walked past by spelling a workspace path
 * differently, because it is checked on the first segment after normalisation.
 *
 * ⚠ What this is NOT: it is not "the browser can only reach what the UI needs".
 * Every `requireApiKey` route stays reachable by any signed-in user, because
 * this route holds the one shared parent key. The control for *that* is the
 * per-workspace role check on the API side (`requireWorkspaceRole`), not here.
 */
const DENIED_SEGMENTS: Record<string, string> = {
  // routes/oracle.ts: "A TEST surface … Nothing in the product may call it."
  // That rule was prose with nothing enforcing it — this route presented the
  // parent key to it for any signed-in caller. `foundryApi.demoOracle` was the
  // one client method that reached it and had no callers; it is deleted with
  // this change rather than left as a method that can only 403.
  "test-oracle": "the correctness oracle is a test surface, not a product one",
  // app.ts: guarded by `requireStepToken` / the Kestra callback secret,
  // "deliberately NOT by the parent key". Forwarding grants nothing (the parent
  // refuses without the right token) — the point is that the parent key is
  // never presented to the engine's callback surface from a browser at all.
  steps: "the engine's step callback surface is not browser-reachable",
  executions: "the engine's execution callback surface is not browser-reachable",
  // app.ts: `/api/mail` is gated by `requireMailKey`, NOT the parent key, so
  // forwarding grants nothing — the route already fails closed for a caller
  // holding only `PARENT_API_KEY`. Listed anyway, alongside the two other
  // documented non-browser surfaces, because this is a **deny** list in front of
  // a proxy that forwards everything else: leaving it out would state that a
  // browser reaching REAL email delivery is fine and merely happens not to work.
  // email-send-tool T048.
  mail: "real email delivery is not browser-reachable; it is called by the step executor",
};

async function forward(req: NextRequest, path: string[]): Promise<Response> {
  // ── Fail closed HERE, not only in proxy.ts ────────────────────────────
  //
  // `proxy.ts` (`middleware.ts` before Next 16) redirects an unauthenticated request to /login, and until
  // this check existed that redirect WAS the whole control on a route holding
  // `PARENT_API_KEY`. Two things were wrong with that. Its matcher is a single
  // negative-lookahead regex, and the idiom every Next codebase reaches for —
  // excluding `api` from it — would have handed the entire parent API to
  // anonymous callers with the root key, silently and with no test failing. And
  // a 302 to an HTML page is the wrong answer for an API path: `foundryApi`
  // parses JSON, so the symptom is a parse error rather than "you are signed
  // out".
  //
  // So: the session is checked in the route that holds the key, and the answer
  // is a 401 with a JSON body.
  const session = await auth();
  if (!session) {
    return Response.json({ error: "not_authenticated" }, { status: 401 });
  }

  const denial = DENIED_SEGMENTS[(path[0] ?? "").toLowerCase()];
  if (denial) {
    return Response.json({ error: "not_proxyable", message: denial }, { status: 403 });
  }

  const search = req.nextUrl.search ?? "";
  const target = `${BASE}/api/${path.join("/")}${search}`;

  const headers: Record<string, string> = { "x-api-key": KEY };
  const ct = req.headers.get("content-type");
  if (ct) headers["content-type"] = ct;
  // A raw file upload names its file here (SQLite files, chat attachments). Just a name — the server sanitises it.
  // It was dropped with every other inbound header, so SQLite uploads lost their names without anyone noticing.
  const fileName = req.headers.get("x-file-name");
  if (fileName) headers["x-file-name"] = fileName.slice(0, 1024);

  // ── Who is asking (Stage 9.1) ──────────────────────────────────────────────
  //
  // This route used to build exactly one header and throw the session away, so
  // the browser knew who you were and the API never did — which is why gate 2
  // and gate 3 both took the approver's name from the request BODY and could
  // not verify it (I-13).
  //
  // `session.backendToken` is an HS256 JWT the sign-in flow already minted
  // (src/auth.ts) and nothing consumed. Forwarding it under its own header —
  // NOT `authorization`, which `requireApiKey` also reads — lets the API verify
  // a person against a secret that is not PARENT_API_KEY.
  //
  // ⚠ Read the session, never a client-supplied header. An inbound
  // `x-foundry-identity` is dropped on the floor by construction: this object is
  // built from scratch, so a browser cannot inject one.
  const identity = (session as { backendToken?: string } | null)?.backendToken;
  if (identity) headers["x-foundry-identity"] = identity;

  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  // ⚠ BYTES, not text. `req.text()` decodes as UTF-8, which is lossless for
  // JSON and silently corrupts a binary body — a SQLite upload arrived with its
  // header intact and every page after it mangled, and failed SQLite's own
  // integrity check. Forwarding the buffer is verbatim for both.
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body, cache: "no-store" });
  } catch (e) {
    return Response.json(
      { error: "upstream_unreachable", message: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  const resHeaders = new Headers();
  const upstreamCt = upstream.headers.get("content-type");
  if (upstreamCt) resHeaders.set("content-type", upstreamCt);
  const cd = upstream.headers.get("content-disposition");
  if (cd) resHeaders.set("content-disposition", cd);

  // ⚠ SSE must stream. Buffering text/event-stream into arrayBuffer() would
  // hold the whole Pi turn and the chat would never show live tool accordions.
  if (upstreamCt?.includes("text/event-stream") && upstream.body) {
    resHeaders.set("cache-control", "no-cache, no-transform");
    resHeaders.set("connection", "keep-alive");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  }

  // Pass the upstream status + body + content-type straight back. This preserves
  // JSON envelopes, 204 (no body), and text/plain (download / requirements).
  const payload = await upstream.arrayBuffer();
  return new Response(payload.byteLength ? payload : null, {
    status: upstream.status,
    headers: resHeaders,
  });
}

// ⚠ `ctx.params` is a PROMISE from Next 15 (the synchronous form was a compatibility shim and is removed in 16). Reading
// `ctx.params.path` off it gives `undefined`, and `forward` would then dial `${BASE}/api/undefined` with the parent key — so
// every verb awaits it, and `proxy.test.ts` hands the handler a Promise-shaped `ctx` for each one.
type Ctx = { params: Promise<{ path: string[] }> };

const handle = async (req: NextRequest, ctx: Ctx) => forward(req, (await ctx.params).path);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
