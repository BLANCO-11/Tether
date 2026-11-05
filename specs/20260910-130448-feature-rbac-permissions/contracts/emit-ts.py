"""Emit packages/server/src/auth/route-permissions.ts from map.json.

⚠ The map is GENERATED, never transcribed. 196 routes hand-copied is 196 chances
to be wrong, in the one file whose only value is being exactly right — and the
hand-written markdown version drifted in six places in two days. Re-run this
after `gen-map.py`; see contracts/README.md for the whole procedure.
"""
import json, sys

SP = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
OUT = sys.argv[2]
m = json.load(open(SP + "/map.json"))
WS = "/api/workspaces/:workspaceId/"

# Deployment entries whose value is prose rather than a platform permission.
IDENTITY_ONLY = {"requireIdentity", "requireIdentity (unchanged)"}
FILTERED = "requireIdentity + filtered by grant (FR-015)"
BY_ID = "flows.read in :id"

ws_entries, plat_entries, ident_entries, exempt_entries = [], [], [], []

for key, perm in sorted(m["W"].items()):
    method, tail = key.split(" ", 1)
    full = WS + tail
    if perm.startswith("—"):
        ident_entries.append((method, full, perm.split("(", 1)[1].rstrip(")") if "(" in perm else "own data"))
    else:
        ws_entries.append((method, full, perm, "workspaceId"))

for key, perm in sorted(m["D"].items()):
    method, full = key.split(" ", 1)
    if perm.startswith("—"):
        # Identity-only with its own reason, written "— (reason)" — the same form a workspace entry uses.
        ident_entries.append((method, full, perm.split("(", 1)[1].rstrip(")") if "(" in perm else "own data"))
    elif perm in IDENTITY_ONLY:
        ident_entries.append((method, full, "signed in; no further permission"))
    elif perm == FILTERED:
        ident_entries.append((method, full, "signed in; the LIST ITSELF is filtered per grant (FR-015)"))
    elif perm == BY_ID:
        ws_entries.append((method, full, "flows.read", "id"))
    else:
        plat_entries.append((method, full, perm))

for key, reason in sorted(m["EX"].items()):
    method, full = key.split(" ", 1)
    exempt_entries.append((method, full, reason))

def rows(entries, fmt):
    return "\n".join(fmt(*e) for e in entries)

body = f'''import type {{ PlatformPermission, WorkspacePermission }} from "./permissions.js";

/**
 * Which permission each mounted route requires.
 *
 * ⚠ **THIS FILE IS GENERATED. DO NOT EDIT IT BY HAND.**
 * Regenerate with the procedure in
 * `specs/20260910-130448-feature-rbac-permissions/contracts/README.md`:
 * `dump-routes.mts` walks the live Express stack, `gen-map.py` carries the only
 * hand-authored part (the assignment table) and fails loudly on any unmapped route or
 * stale entry, and `emit-ts.py` writes this file.
 *
 * The hand-written version of this map drifted in six places in two days, and the route
 * surface moved twice in four days — `beta-1.1.0` added ten routes mid-session.
 * Regenerating costs one command; transcribing 196 routes is 196 chances to be wrong in
 * the one file whose only value is being exactly right.
 *
 * ## ⚠ Completeness is checked against the STACK, never against source
 *
 * `route-permissions.test.ts` walks the same `createApp()` this was generated from and
 * requires every `(method, path)` to appear here or in `EXEMPT`. A regex over route
 * files reports nine false positives on `local-users.ts` alone, which is guarded at the
 * router rather than per handler (research M-5).
 *
 * The check runs in ONE direction: **routes are checked against the map, never the map
 * against routes.** A permission with no route is legal — `roles.write` guards routes
 * this feature adds. A route with no permission is not.
 *
 * ## ⚠ Scope is declared, never inferred from the parameter's presence
 *
 * `GET /api/workspaces/:id` is workspace-scoped and its parameter is `:id`.
 * `PUT /api/local-users/:id/access/:workspaceId` is **deployment-level** and carries a
 * `:workspaceId`. Inferring scope from "does this path contain :workspaceId" gets one of
 * those wrong in each direction, so every workspace entry names its parameter.
 *
 * Counts at generation time: **{len(m["ws"]) + len(m["dep"]) + len(m["ex"])} mounted routes** —
 * {len(ws_entries)} workspace-scoped, {len(plat_entries)} platform, {len(ident_entries)} identity-only,
 * {len(exempt_entries)} exempt. ⚠ Read these from the exported arrays, never from this comment.
 */

export type RouteRequirement =
  /** Answered against `(person, workspace)`. `param` names where the workspace id is. */
  | {{ kind: "workspace"; permission: WorkspacePermission; param: string }}
  /** Answered against a person alone — no workspace in the question. */
  | {{ kind: "platform"; permission: PlatformPermission }}
  /**
   * Signed in, and nothing more.
   *
   * ⚠ NOT the same as exempt, and the difference is the point. These routes answer
   * about the caller themselves — their own attendance, their own permissions, the
   * workspaces they can see — so requiring a permission to reach them would be a
   * bootstrap nobody can escape: you would need access in order to discover you have
   * none. `GET /api/workspaces` is the sharpest case: it is identity-only AND the list
   * it returns is filtered per grant, so the authorisation is in the *contents*, not in
   * reaching it.
   */
  | {{ kind: "identity"; why: string }}
  /**
   * No identity at all, with a stated reason.
   *
   * ⚠ Every entry carries a REASON string, so an exemption is something somebody
   * decided rather than something nobody noticed (FR-005). An exemption with no reason
   * is indistinguishable from an oversight, and both look like a passing test.
   */
  | {{ kind: "exempt"; reason: string }};

/** `"METHOD /full/path"` → what it requires. */
export const ROUTE_PERMISSIONS: ReadonlyMap<string, RouteRequirement> = Object.freeze(
  new Map<string, RouteRequirement>([
    // ── workspace-scoped ─────────────────────────────────────────────────────
{rows(ws_entries, lambda mth, p, perm, par: f'    ["{mth} {p}", {{ kind: "workspace", permission: "{perm}", param: "{par}" }}],')}

    // ── platform tier ────────────────────────────────────────────────────────
{rows(plat_entries, lambda mth, p, perm: f'    ["{mth} {p}", {{ kind: "platform", permission: "{perm}" }}],')}

    // ── identity only ────────────────────────────────────────────────────────
{rows(ident_entries, lambda mth, p, why: f'    ["{mth} {p}", {{ kind: "identity", why: "{why}" }}],')}
  ]),
);

/**
 * Routes that require no identity at all, each with the reason it does not.
 *
 * ⚠ These are the routes an unauthenticated caller can reach, so this is the shortest
 * and most security-relevant list in the feature. Six are step callbacks carrying an
 * execution token, three are the engine's execution lifecycle, two are liveness probes,
 * two are public receivers whose credential is the token in the URL, one is the mail
 * key, one is a test surface blocked at the proxy, and one answers before anybody has a
 * session — which is what mints one.
 */
export const EXEMPT: ReadonlyMap<string, {{ reason: string }}> = Object.freeze(
  new Map<string, {{ reason: string }}>([
{rows(exempt_entries, lambda mth, p, reason: f'    ["{mth} {p}", {{ reason: "{reason}" }}],')}
  ]),
);

/** `"METHOD /path"`, the key shape both maps use. */
export function routeKey(method: string, path: string): string {{
  return `${{method.toUpperCase()}} ${{path}}`;
}}

export function requirementFor(method: string, path: string): RouteRequirement | undefined {{
  const key = routeKey(method, path);
  const exempt = EXEMPT.get(key);
  if (exempt) return {{ kind: "exempt", reason: exempt.reason }};
  return ROUTE_PERMISSIONS.get(key);
}}
'''

open(OUT, "w").write(body)
print(f"wrote {OUT}: ws={len(ws_entries)} platform={len(plat_entries)} identity={len(ident_entries)} exempt={len(exempt_entries)}")
