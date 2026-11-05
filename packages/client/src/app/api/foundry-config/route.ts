// src/app/api/foundry-config/route.ts — runtime configuration the browser needs.
//
// WHY A ROUTE RATHER THAN `NEXT_PUBLIC_*`: `NEXT_PUBLIC_` variables are inlined
// into the client bundle at BUILD time, so setting one in compose `environment:`
// has no effect on an already-built image — it would need a Dockerfile ARG and a
// rebuild to change. This route reads the variable server-side at REQUEST time, so
// `docker compose up -d` with a new value is enough.
//
// Currently carries one thing: which workspace the UI binds to. That used to be
// "whichever workspace was created most recently", which meant creating any
// workspace silently repointed Tools, Automations, Triggers, History and Outbox
// (see resolveWorkspaceId in lib/foundry-client.ts).
//
// Contains NO secrets. `PARENT_API_KEY` stays in the proxy route and must never be
// added here.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return Response.json({
    // An exact id wins; a name is friendlier to configure. Either may be unset,
    // in which case the client falls back to the oldest workspace.
    workspaceId: process.env.FOUNDRY_WORKSPACE_ID?.trim() || null,
    workspaceName: process.env.FOUNDRY_WORKSPACE?.trim() || null,
    // Where the browser opens the step-progress socket (phase-2.md 2.8). Not a
    // secret and not proxied: a WebSocket cannot go through the same-origin API
    // proxy above, which is exactly why that channel is authorised by a
    // single-use ticket instead of by the API key. Unset in an environment where
    // :4001 is not reachable from a browser — the run page then polls, which is
    // a slower view of the same data, never a broken one.
    wsUrl: process.env.FOUNDRY_WS_URL?.trim() || null,
  });
}
