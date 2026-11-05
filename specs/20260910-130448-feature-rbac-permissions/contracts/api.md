# Phase 1 — Interface Contracts

**Feature**: Feature-level RBAC · **Date**: 2026-09-10 · ⚠ **RE-BASELINED 2026-09-12**

Every route below is behind `requireApiKey` like the rest of the parent API, and
additionally behind the guard named in its row. Request bodies are Zod `.strict()`
throughout (FR-025): an unknown key is a 400, never ignored — a caller who sends
`{"permissions": [...]}` to an endpoint that does not take one must learn the field does
not exist rather than watch it be dropped and assume it worked.

---

## A. New — the permission catalogue and a person's own answer

### `GET /api/permissions/catalogue`
Guard: `requireIdentity`.
The fixed catalogue, for rendering a role-authoring form. Static per build.

```jsonc
{ "permissions": [ { "key": "flows.write", "domain": "flows", "action": "write",
                     "label": "Edit automations",
                     "description": "Create, edit, delete and import automations",
                     "tier": "workspace" } ],
  "presets": [ { "key": "author", "label": "Author", "permissions": ["flows.read", "…"] } ] }
```

### `GET /api/workspaces/:workspaceId/me/permissions`
Guard: `requireIdentity`. **No permission required** — a person may always ask what they
themselves may do; requiring one creates a bootstrap where you need access to discover
you have none.

```jsonc
{ "workspaceId": "…",
  "permissions": ["flows.read", "flows.write"],
  "provenance": { "flows.read":  [{ "via": "preset", "name": "author" }],
                  "flows.write": [{ "via": "preset", "name": "author" },
                                  { "via": "role", "id": "…", "name": "Finance Reviewer" }] },
  "superAdmin": false,
  "platformRoles": ["auditor"] }
```

- Returns `200` with `"permissions": []` for a person with **no** grant — that is an
  answer, not an error. FR-030's "the check did not run" state is a transport failure,
  which is a different thing and must render differently.
- `provenance` is computed by the same pass that decides (P-4), never a second one.

### `GET /api/me` — **extended, and one key REMOVED**
Existing `{ superAdmin, superAdminConfigured }` keys keep their meaning and position.
Adds `platformRoles: string[]` and `platformPermissions: string[]`.

⚠ **`capabilities[]` is REMOVED, and it was not in the original contract because nobody had
noticed it.** `GET /api/me?workspaceId=…` returns a workspace-scoped capability list today
(`routes/me.ts` → `workspaceMemberCapabilitiesService.getCapabilities`), and the browser
consumes it — `components/shell/Sidebar.tsx` gates a nav row on
`me.data?.capabilities?.includes("admin")`. It is a **fourth** answer to "what may this
person do here", beside the member row, the capability rows and the new
`/me/permissions`, and it is the one the client currently believes.

It is superseded by `GET /workspaces/:ws/me/permissions`. Removing it is a client-visible
contract change with four consumers (research M-7) and must land **after** they are moved,
not before — the sidebar must not lose its gate one release before it gains the new one.

---

## B. New — workspace custom roles

Mounted `/api/workspaces/:workspaceId/roles`.

| Method | Path | Permission | Notes |
| :--- | :--- | :--- | :--- |
| GET | `/` | `members.read` | Presets and custom roles, each with its permission list and assignee count |
| POST | `/` | `roles.write` | Create |
| GET | `/:roleId` | `members.read` | One role |
| PATCH | `/:roleId` | `roles.write` | Rename, re-describe, change permissions |
| DELETE | `/:roleId` | `roles.write` | Retire (soft — INV-7) |
| GET | `/:roleId/members` | `members.read` | Who holds it |
| POST | `/:roleId/members` | `members.grant` | Assign `{ subject }` |
| DELETE | `/:roleId/members/:subject` | `members.grant` | Unassign |

```jsonc
// POST /roles  — .strict()
{ "name": "Finance Reviewer", "description": "…", "permissions": ["flows.read", "flows.approve"] }
```

Refusals:

- `400` a permission not in the catalogue, naming it.
- `400` a `platform.*` permission (INV-8).
- `403` `role_exceeds_granter` — a permission the caller does not hold (FR-009), naming
  which. **The caller's own set is never listed back**, per FR-023.
- `409` name collides with a live role or a preset (INV-6).
- `409` assigning to a non-member (INV-9), naming the missing membership.
- `409` retiring a role with assignees unless `?confirm=true`; the refusal carries the
  count so the confirmation can state it (Story 3 scenario 4).

⚠ No `subject` in the create body and no `role` in the assign body beyond the role in the
path. FR-025.

---

## C. New — the platform tier

Mounted `/api/platform`, beside the existing `/users`.

| Method | Path | Guard | Notes |
| :--- | :--- | :--- | :--- |
| GET | `/roles` | `platform.users.read` **or** super admin | Built-in and custom |
| POST | `/roles` | `platform.roles.write` | Custom platform role |
| PATCH | `/roles/:key` | `platform.roles.write` | Refuses `builtin` (INV-15) |
| DELETE | `/roles/:key` | `platform.roles.write` | Refuses `builtin` |
| GET | `/role-assignments` | `platform.users.read` | Who holds what |
| POST | `/role-assignments` | `platform.members.grant` | `{ subject, email, roleKey }` |
| DELETE | `/role-assignments/:subject/:roleKey` | `platform.members.grant` | INV-14 applies |
| GET | `/audit` | `platform.audit.read` | Union of both records in one time order (INV-17) |

- **Bootstrap**: with no platform-role assignment anywhere, only an allowlist holder
  passes `platform.members.grant`. The refusal names `SUPER_ADMIN_EMAILS` when the
  allowlist is empty and says "ask a platform administrator" when it is not — the
  two-refusals rule (FR-022), the same fork `requireSuperAdmin` already makes.
- ⚠ **`platform.members.grant` ALSO confers `members.read` + `members.grant` in every
  workspace** (D-9, `data-model.md` §10). It is the only platform permission that confers
  anything into a workspace, and the conferred set is exactly those two — asserted as a set,
  not a subset. So a platform administrator can create a workspace **and** give it its first
  member, which before D-9 they could not.
- **INV-13**: no request body may name a permission that grants super admin, because no
  such permission exists.

---

## D. Changed — existing routes

### `GET /api/workspaces` — **filtered** (FR-015)
Returns only workspaces the caller holds **any** workspace permission in. **Response shape
is unchanged** — same object, fewer elements — so no client parsing changes.

After D-9 that resolves concretely:

| Caller | Sees |
| :--- | :--- |
| super admin (`SUPER_ADMIN_EMAILS`) | all — short-circuits before any read (P-3) |
| `platform-admin` | **all** — `platform.members.grant` confers `members.read` everywhere |
| `auditor`, `support` | **none** — neither confers anything into a workspace |
| a member | the workspaces they hold a grant in |

⚠ An auditor seeing **no** workspaces is correct, not a bug: they read audit history across
tenants through `GET /api/platform/audit`, which is the deployment-level record. Showing
them the workspace list would be tenant metadata they have no permission for, and FR-021
exists to keep those apart.

⚠ `GET /api/workspaces/:id` and `/:id/manifest` become `flows.read`-guarded in that
workspace. Today both are open; leaving them open would make FR-015 cosmetic, since the
id is guessable from any run URL.

### `PUT|DELETE /api/generation/llm/provider`
`requireDeploymentAdmin()` → `requirePlatformPermission("platform.generation.write")`.
Research D-6: this is a real narrowing and the refusal must say so.

### `POST|DELETE /api/workspaces/:ws/members`
⚠ **CORRECTED 2026-09-12 — this sentence and the plan's behaviour-change list disagreed on
what "and" meant.** This file said it *stays* `requireSuperAdmin` **and** additionally
accepts `members.grant`; the plan said it *becomes* admin-reachable, **not only**
super-admin. Those are AND and OR, and they are different controls.

**Resolved: OR.** A caller passes if they are a super admin **or** hold `members.grant` in
that workspace. AND would leave Story 3 exactly as unusable as it is today, which is the
thing this change exists to fix.

⚠ **After D-9 there are three ways to hold `members.grant` here**, and they are deliberately
indistinguishable to the route and deliberately distinguishable on screen (FR-020): the
`admin` preset, a custom role, or **conferral from `platform.members.grant`**. The third is
what lets a platform administrator seed a workspace they just created.

⚠ This is a **widening** of who may grant, and it is deliberate; it is behaviour change 3
in the plan and must appear in the standards amendment.

⚠ **An existing test goes red and must be rewritten, not kept.**
`services/workspace-member.test.ts` has
`describe("every route that assigns membership or creates a workspace carries requireSuperAdmin")`
which greps `members.ts` and `workspaces.ts` for the literal string. `workspaces.ts` loses
it entirely; `members.ts` keeps it as one arm of an OR. The assertion becomes "carries the
platform permission or the workspace permission", with its existing control intact.

### The 106 routes
Each acquires a permission through the central map (research D-1). No route file changes
its response shape, its status codes or its request schema. The full mapping is in
[`route-permissions.md`](./route-permissions.md), which is **generated from the live
Express stack** rather than transcribed.

### `GET|PUT|DELETE /api/ops/llm/*` — ⚠ NOT `platform.audit.read`
The earlier contract gave all ten `ops-proxy.ts` handlers one permission. Four of them are
the **`llm_complete` tool-model setting**, which D-115 keeps deliberately separate from the
generation model and which has confused a user twice. They take
`platform.toolmodel.read`/`platform.toolmodel.write`; the six outbox and status reads take
`platform.ops.read`. Folding them together would merge, at the authorisation layer, the two
settings this codebase separates on purpose.

### `PUT|DELETE /api/local-users/:id/access/:workspaceId` — ⚠ `platform.members.grant`
These two **write `workspace_members`** from a deployment-level router. Mapping
`local-users.ts` wholesale to `platform.localusers.write` would make workspace membership
grantable through a third permission, beside `members.grant` and `platform.members.grant`
— the duplication D-6 deletes `requireDeploymentAdmin` to avoid. `GET /:id/access` takes
`platform.users.read`.

⚠ **D-9 closes the asymmetry this route used to create.** Before it, this was the *only*
way a platform administrator could put somebody in a workspace — and it is scoped by
construction to local accounts, so the same act had two answers depending on whether the
person signs in with a local account or with Entra. `platform.members.grant` now confers
`members.grant` everywhere, so this route and `POST /workspaces/:ws/members` are the same
authority reached two ways.

⚠ **They are also the counter-example to FR-024.** That requirement makes a *missing*
`:workspaceId` a loud 500 on a workspace-scoped guard; here is a deployment-level route
that *has* one. The guard takes the parameter name explicitly and never infers scope from
its presence. `GET /api/workspaces/:id` is the mirror case — workspace-scoped, parameter
named `:id`.

---

## E. Refusal envelope

One shape for every refusal this feature adds, so a client renders them uniformly:

```jsonc
{ "error": "forbidden",
  "reason": "missing_permission" | "not_a_member" | "workspace_unconfigured"
          | "deployment_unconfigured" | "role_exceeds_granter" | "unattested_revision",
  "message": "…names the action the reader can take…",
  "permission": "secrets.write",
  "requestId": "…" }
```

- `401` when no person is named; `403` when a person is named and not permitted — FR-022
  requires these to be distinguishable, and a single 403 for both sends somebody to
  check their session when the answer is that they need a grant.
- `message` never lists who holds the permission (FR-021, and `requireSuperAdmin`'s
  existing rule that a 403 is the last place to publish the accounts worth attacking).
- `500` `misconfigured` when the guard is mounted where `:workspaceId` is not in scope —
  a wiring defect, never a pass (FR-024), matching `requireWorkspaceRole` and
  `requireProvenanceAuthority`.

---

## F. Client surface

`packages/client/src/lib/foundry-client.ts` gains, and nothing else in the client
computes an access answer (FR-031):

```ts
getPermissionCatalogue(): Promise<PermissionCatalogue>
getMyPermissions(workspaceId: string): Promise<MyPermissions>
listWorkspaceRoles(workspaceId): Promise<WorkspaceRole[]>
createWorkspaceRole(workspaceId, input): Promise<WorkspaceRole>
updateWorkspaceRole(workspaceId, roleId, input): Promise<WorkspaceRole>
retireWorkspaceRole(workspaceId, roleId, confirm?): Promise<void>
listRoleMembers(workspaceId, roleId): Promise<Member[]>
assignWorkspaceRole(workspaceId, roleId, subject): Promise<void>
unassignWorkspaceRole(workspaceId, roleId, subject): Promise<void>
listPlatformRoles(): Promise<PlatformRole[]>
listPlatformRoleAssignments(): Promise<PlatformRoleAssignment[]>
assignPlatformRole(input): Promise<void>
unassignPlatformRole(subject, roleKey): Promise<void>
listPlatformAudit(query): Promise<AuditPage>
```

⚠ `getMyPermissions` is the **only** source a component may use to decide an affordance.
`ui-honesty-check.sh` asserts the absence of any other (research M-3), and the proxy's
`DENIED_SEGMENTS` list is unchanged — none of these are non-browser surfaces.

⚠ **THAT IS NOT TRUE TODAY AND THE WIDENED BAN WILL NOT MAKE IT TRUE.** The client already
holds its own authorisation map — `lib/capabilities.ts` (a second `ROLE_CAPS`, disagreeing
with the server's on `approver`), `Sidebar.tsx`'s
`me.data?.capabilities?.includes("admin")`, and `lib/search.ts`'s `filterByCapabilities()`
(research M-7). None of it reads `session.user.roles`, so M-3's widened pattern passes over
every line of it. It reads a *server* answer and then applies a *client* policy to it,
which is a second authority wearing a permitted shape.

So the check needs two assertions, not one:

- `absent_code_in` for `lib/capabilities` / `ROLE_CAPS` / `CAP_NAV` / `CAP_CONTROLS` across
  `app/` and `components/`, **after** the module is deleted;
- `present_code_in` for `getMyPermissions` as the one legitimate reader — a widened ban with
  no positive control is how a check gets weakened until it permits the defect (I-62).
