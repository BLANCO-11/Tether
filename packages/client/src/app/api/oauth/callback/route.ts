// src/app/api/oauth/callback/route.ts — where a provider sends the browser back after a person signs in to connect a
// service (plans/plugins-2026-10-27, phase 4). This address is what an administrator registers with the provider:
// `<AUTH_URL>/api/oauth/callback`.
//
// It does one thing: posts the provider's `code` and `state` to the API on the signed-in person's behalf, then sends
// the browser to the connector's page with the outcome. ⚠ It decides nothing — the API checks that the state exists,
// is unused, unexpired, and was started by THIS person in THIS workspace. The workspace rides at the front of the
// state (`<workspace id>.<random>`) only so this route knows which workspace's guard to ask.
import { NextRequest } from "next/server";
import { auth } from "@/auth";

const BASE = process.env.PARENT_API_URL ?? "http://localhost:4000";
const KEY = process.env.PARENT_API_KEY ?? "dev-parent-key";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT = /^[a-z0-9][a-z0-9-]*$/;

function back(req: NextRequest, path: string): Response {
  const origin = (process.env.AUTH_URL ?? req.nextUrl.origin).replace(/\/+$/, "");
  return Response.redirect(`${origin}${path}`, 303);
}

export async function GET(req: NextRequest): Promise<Response> {
  const q = req.nextUrl.searchParams;
  const session = await auth();
  if (!session) {
    // Signed out mid-way: sign in, then come straight back here. The state is good for ten minutes.
    return back(req, `/login?callbackUrl=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`);
  }
  const state = q.get("state") ?? "";
  const workspaceId = state.split(".")[0] ?? "";
  if (!UUID.test(workspaceId)) {
    return back(req, `/apps?oauthError=${encodeURIComponent("The sign-in came back without a usable state. Start it again from the connector's page.")}`);
  }

  const headers: Record<string, string> = { "x-api-key": KEY, "content-type": "application/json" };
  // ⚠ The identity comes from the session, never from the request: the API refuses a state started by anybody else.
  const identity = (session as { backendToken?: string }).backendToken;
  if (identity) headers["x-foundry-identity"] = identity;

  let status = 0;
  let body: { piece?: string; connection?: { id?: string }; message?: string; error?: string } = {};
  try {
    const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/plugins/oauth/callback`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        state,
        code: q.get("code") ?? undefined,
        error: q.get("error") ?? undefined,
        errorDescription: q.get("error_description") ?? undefined,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (e) {
    body = { message: `Tether could not be reached to finish the sign-in (${(e as Error).message}).` };
  }

  const piece = body.piece && SHORT.test(body.piece) ? body.piece : null;
  if (status >= 200 && status < 300 && piece) {
    return back(req, `/apps/${piece}?connected=${encodeURIComponent(body.connection?.id ?? "")}`);
  }
  const why = body.message ?? body.error ?? `Tether answered ${status || "nothing"}.`;
  return back(req, `${piece ? `/apps/${piece}` : "/apps"}?oauthError=${encodeURIComponent(why.slice(0, 400))}`);
}
