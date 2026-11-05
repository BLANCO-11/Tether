# Implementation Plan: Feature-level RBAC — permission catalogue, custom roles, platform tier

**Branch**: `20260910-130448-feature-rbac-permissions` | **Date**: 2026-09-10 |
⚠ **RE-BASELINED 2026-09-12** | **Spec**: [spec.md](./spec.md)

⚠ **THE 2026-09-10 MEASUREMENTS WERE RE-TAKEN ON 2026-09-12 AND SEVERAL HAD MOVED.** About
twenty-five commits landed in between. Every figure below now comes from
`contracts/route-permissions.md`, which is **generated** from the live Express stack rather
than transcribed. What changed is recorded in research **M-1, M-4, M-5** (corrected) and
**M-6, M-7, M-8** (new). Three of those change the shape of the work, not just a number.

**Input**: Feature specification from `/specs/20260910-130448-feature-rbac-permissions/spec.md`

---

## Summary

Close **106** unguarded workspace-scoped routes and replace the three-tier role check with
a code-owned permission catalogue, custom roles, and a real deployment tier.

The approach is **one central route→permission map** consumed by one middleware, rather
than 106 in-line guards (research D-1). That choice is what makes the completeness check
(FR-002) reliable — it is a set difference against the mounted Express router stack, so
it cannot miss a handler it cannoť see — and it keeps the whole authorisation policy
readable as one reviewable document.

Storage extends what exists: `workspace_members` is **untouched** so no existing grant
changes meaning, `workspace_member_capabilities` is reused as the individual-grant store,
and five tables are added. Enforcement stays at the request boundary, so the entire
regression net — which calls services directly and names nobody — is unaffected by
design.

---

## Technical Context

**Language/Version**: TypeScript 5.7.3, strict, across all packages. Node `>=22` (pinned
22.23.2) — below 22 `packages/client`'s `vitest.config.ts` throws, by design.

**Primary Dependencies**: Express 4.21.2 (server), Next.js 14.2.15 App Router + React
18.3.1 (client), Drizzle ORM 0.38.3 / drizzle-kit 0.30.1, Zod 3.24.1, `jose` 5.x,
NextAuth 5.0.0-beta.31. **No new dependency is introduced by this feature.**

**Storage**: PostgreSQL on 5433 (the `+1` offset is load-bearing). `foundry_parent`
holds every table this feature touches. ⚠ **Latest migration `0061_flow_chat_config`,
62 journal entries, watermark `1789100000000`**; this feature adds **`0062`–`0065`**.
Verified at the database: `drizzle.__drizzle_migrations` holds 62 rows, so the journal and
the applied set agree and this is *not* the 0033 re-run condition.

**Testing**: Vitest 2.1.8, `pnpm test` = `pnpm -r test`. Structural checks alongside:
`scripts/ui-honesty-check.sh`. New harnesses `rbac:verify` and `rbac:platform-verify`
follow the existing `kestra:*` harness idiom (exit non-zero on failure, positive control
mandatory).

**Target Platform**: Linux containers via Docker Compose; developed on macOS, where
Kestra-touching harnesses need `./scripts/harness-in-net.sh`.

**Project Type**: Web application — `packages/server` (API :4000) + `packages/client`
(Next :4002), in a seven-package pnpm workspace.

**Performance Goals**: one query shape per (person, workspace) per request — the same
shape as today's member lookup (research R-4). No caching in v1 beyond the client's 60s
affordance view. Measure before optimising.

**Constraints**: a revocation applies within one request server-side and within 60s in
the UI (SC-005). Enforcement at the route only. No new outbound network calls.

**Scale/Scope**: **196 mounted `(method, path)` pairs** — **142** workspace-scoped
(36 guarded, **106 to add**), **38** deployment-level (6 guarded, 32 to add), **16** exempt.
**49 permissions** (38 workspace + 11 platform). 5 new tables, 1 altered, 4 migrations.
**~115 files touched** — inventory below. ⚠ The 2026-09-10 figures (132 / 36 / 11 = 179)
are wrong in every column, and the surface moved **twice** while these artefacts were being
written — `beta-1.1.0` alone added ten routes on 2026-09-13. See research M-1 and M-9.

---

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design — see the bottom of this file.*

| Article | Status | How |
| :--- | :--- | :--- |
| **I. Spec-First (NON-NEGOTIABLE)** | ⚠ **not yet** | `spec.md` → this `plan.md` → `tasks.md` exist. **The branch does not** — the working tree is on `fix/resource-detail-schema-and-operations` and `specs/` is untracked (research M-8). Create the branch and commit the artefacts before any source is touched; until then Articles I and VI are claims, not facts. |
| **II. Test-First** | ✅ | FR-039 makes perturbation proof an acceptance requirement, and `quickstart.md` step 8 lists the ten perturbations with their expected red test. Every task below that adds a control names its test. |
| **III. Code Review** | ✅ | `/speckit-comply` before review. The route→permission map is deliberately one document so a reviewer can read the policy rather than 106 diffs — and it is **generated**, so what is reviewed is what is mounted. |
| **IV. Simplicity** | ⚠ **justified** | Five new tables and a new middleware layer. See Complexity Tracking. **No new dependency.** |
| **V. Observability** | ✅ | Every refusal names the missing permission and the action its reader can take (FR-022). Every refusal is recorded (FR-034). No silent catch-and-continue: an unresolvable permission is a refusal, never a pass. |
| **VI. Branch/Delivery** | ⚠ **not yet** | One feature, one `specs/` directory — but no timestamp branch yet. See Article I. |
| **VII. Documentation Currency** | ✅ | `security.md` §2, `CLAUDE.md` and ⚠ **`archive/GAPS.md`** §1.1 (the file moved — research M-8) are **tasks in this feature**, not follow-ups (research D-7). |
| **VIII. Secrets Hygiene (NON-NEGOTIABLE)** | ✅ | No credential is added, moved or logged. `secrets.read` grants the NAME list only; INV-3 pins that no permission returns a value because no endpoint does. Refusal logs carry the permission and never the resource. `.env.example` already documents `SUPER_ADMIN_EMAILS` at length — F11 is close to a no-op and should say so rather than claim work. |

---

## Project Structure

### Documentation (this feature)

```text
specs/20260910-130448-feature-rbac-permissions/
├── spec.md                          # done
├── plan.md                          # this file
├── research.md                      # done — 5 measurements, 7 decisions
├── data-model.md                    # done — 5 new tables, 17 invariants
├── contracts/
│   ├── api.md                       # done — new + changed endpoints
│   ├── route-permissions.md         # GENERATED — all 196 routes mapped
│   ├── dump-routes.mts              # the stack walker that produces it
│   ├── gen-map.py · emit-md.py      # the assignment table and the emitter
├── quickstart.md                    # done — 8 validation steps
├── checklists/requirements.md       # done — all items pass
└── tasks.md                         # /speckit-tasks
```

### Source code

```text
packages/server/src/
├── auth/                    # NEW directory — the catalogue and the map
├── middleware/              # +2 new guards, -1 deleted
├── services/                # +4 new services
├── repositories/            # +3 new repos
├── routes/                  # +3 new routers, ~32 modified
├── db/schema.ts             # +5 tables
├── drizzle/0062..0065       # 4 migrations (⚠ renumbered — 0061 is taken)
└── scripts/rbac-backfill.ts # NEW — dry-run-first backfill

packages/client/src/
├── lib/                     # permissions client + types + workspace filtering
├── lib/capabilities.ts      # ⚠ DELETED — the client's own ROLE_CAPS (research M-7)
├── components/access/       # NEW — Can, PermissionGate, RoleEditor
├── app/(app)/organization/  # roles + platform tier UI
└── app/(app)/*/             # affordance gating on 36 pages, not 15

scripts/ui-honesty-check.sh  # widened session-roles ban + new assertions
.specify/memory/security.md  # §2 amendment (via /speckit-update-standards)
CLAUDE.md · archive/GAPS.md  # ⚠ the file MOVED — §1.1 extended in place
```

**Structure Decision**: existing two-package web layout, unchanged. The one new
directory is `packages/server/src/auth/`, which exists so the catalogue, the presets and
the route map sit together and can be reviewed as a unit — putting them in `services/`
would scatter the policy across a directory of 60 files.

---

## File-level change inventory

**~110 files.** Grouped by phase. `NEW` = created, `MOD` = modified, `DEL` = deleted.

### Phase A — the catalogue and the guard (no behaviour change yet)

| # | File | | Change |
| :-- | :--- | :-- | :--- |
| A1 | `packages/server/src/auth/permissions.ts` | NEW | Frozen catalogue (**49**: 38 workspace + 11 platform), `Permission` union, `isPermission()`. INV-1. |
| A2 | `packages/server/src/auth/permissions.test.ts` | NEW | INV-2 catalogue/CHECK parity; no duplicates; every entry has a label. |
| A3 | `packages/server/src/auth/role-presets.ts` | NEW | `author`/`approver`/`admin` → permission sets. |
| A4 | `packages/server/src/auth/role-presets.test.ts` | NEW | INV-4 subset ordering; **INV-5 pinned against today's `ROLE_CAPS` + reachable routes**. This is what makes SC-003 provable. |
| A5 | `packages/server/src/auth/route-permissions.ts` | NEW | The map from `contracts/route-permissions.md` — **196 entries: 142 workspace + 38 deployment + 16 `EXEMPT`**, each exempt entry with a reason string. |
| A6 | `packages/server/src/auth/route-permissions.test.ts` | NEW | FR-002 completeness over the mounted router stack + **FR-003 control** on a synthetic undeclared route. ⚠ **Dedupe on `(method, resolved path)`** — `GET /flows/:flowId/phases` is registered twice and `releaseGatesRouter` is mounted twice. |
| A7 | `packages/server/src/services/effective-permissions.service.ts` | NEW | The union resolver + provenance (P-1…P-6). ⚠ Reads platform-role conferral through `PLATFORM_CONFERS` (A11) — the platform read is keyed on subject alone, so it is one read per request regardless of how many workspaces it answers for. |
| A11 | `packages/server/src/auth/platform-conferral.ts` | NEW | ⚠ **D-9.** `PLATFORM_CONFERS` — which workspace permissions a **platform** permission grants in every workspace. Exactly one key today: `platform.members.grant → [members.read, members.grant]`. Keyed on the permission, never on a role name. |
| A12 | `packages/server/src/auth/platform-conferral.test.ts` | NEW | **INV-18**: the map's image equals `{members.read, members.grant}` **as a set, not a subset** — a subset assertion passes while somebody adds `flows.read`, and the whole cost of D-9 is bounded by that number. **INV-12**: `auditor`'s conferred set is empty, computed through this map rather than by inspecting the role's own list. |
| A8 | `packages/server/src/services/effective-permissions.service.test.ts` | NEW | Union, order-independence, empty-means-empty, super-admin short-circuit, provenance. ⚠ **INV-19**: a conferred permission's provenance is `{ via: "platform", role }` and **never** `{ via: "preset" }` (FR-020, which had no subject before D-9). |
| A9 | `packages/server/src/middleware/require-permission.middleware.ts` | NEW | `requirePermission()`; 500 on missing `:workspaceId` (FR-024); refusal envelope (contract §E). ⚠ **Takes the workspace parameter NAME explicitly** — `workspaces.ts` uses `:id`, and `local-users.ts` is a *deployment* route that carries a `:workspaceId`. Scope cannot be inferred from the presence of the parameter. |
| A10 | `packages/server/src/middleware/require-permission.test.ts` | NEW | Both refusal kinds distinguishable; wiring-defect 500; never a silent pass. |

### Phase B — storage

| # | File | | Change |
| :-- | :--- | :-- | :--- |
| B1 | `packages/server/src/db/schema.ts` | MOD | +`workspaceRoles`, `workspaceRolePermissions`, `workspaceRoleAssignments`, `platformRoles`, `platformRoleAssignments`, `platformAuditEvents`. ⚠ `workspaceMembers` and `auditEvents` untouched (INV-16). |
| B2 | `packages/server/drizzle/0062_workspace_roles.sql` | NEW | 3 tables + indexes. `when` `1789200000000`. |
| B3 | `packages/server/drizzle/0063_platform_roles.sql` | NEW | 2 tables + 3 seeded built-in rows. `1789300000000`. |
| B4 | `packages/server/drizzle/0064_platform_audit.sql` | NEW | 1 table + 2 CHECKs. `1789400000000`. |
| B5 | `packages/server/drizzle/0065_capability_rename.sql` | NEW | Rename 7 values → catalogue names; CHECK added **VALID** after verifying rows (the 0038 precedent). ⚠ Fails loudly on an unmapped value. ⚠ **Operates on ZERO rows on this deployment** (M-6), so the CHECK must be proven against a fixture, not against the live table. `1789500000000`. |
| B6 | `packages/server/drizzle/meta/_journal.json` | MOD | 4 entries, each `when` above **`1789100000000`** (the 0033 incident). ⚠ **RENUMBERED 2026-09-12** — `0061` and `1789100000000` are taken by `flow_chat_config`. |
| B7 | `packages/server/src/repositories/workspace-role.repo.ts` | NEW | |
| B8 | `packages/server/src/repositories/platform-role.repo.ts` | NEW | |
| B9 | `packages/server/src/repositories/platform-audit.repo.ts` | NEW | |

### Phase C — services

| # | File | | Change |
| :-- | :--- | :-- | :--- |
| C1 | `packages/server/src/services/workspace-role.service.ts` | NEW | Custom-role CRUD. INV-6 name collision, INV-7 soft retire, INV-8 no `platform.*`, INV-9 member-first, FR-009 cannot exceed granter. |
| C2 | `packages/server/src/services/workspace-role.service.test.ts` | NEW | Each invariant, each with a positive control. |
| C3 | `packages/server/src/services/platform-role.service.ts` | NEW | INV-12 (empty **conferral** for `auditor`), INV-13 no super-admin path, INV-14 last platform admin, INV-15 built-ins immutable, ⚠ **INV-20**: the last-**workspace**-admin refusal's exemption does **not** extend to the platform tier — `config.isSuperAdmin` keeps it alone, because a platform admin always has an allowlist holder above them to undo a mis-assignment, which is the condition that created the exemption. |
| C4 | `packages/server/src/services/platform-role.service.test.ts` | NEW | |
| C5 | `packages/server/src/services/access-audit.service.ts` | NEW | Grant/revoke/denial recording; the bounded dedupe (research D-3); routes workspace events to `audit_events` (**no migration needed** — `access`/`member`/`policy` are already permitted values, research M-2) and platform events to `platform_audit_events`. |
| C6 | `packages/server/src/services/access-audit.service.test.ts` | NEW | Dedupe bound; **no protected data in a refusal entry**. |
| C7 | `packages/server/src/services/workspace-member.service.ts` | MOD | `check()` delegates to the resolver. `RANK` deleted; the ordering becomes set containment (INV-4). Last-admin refusal and its super-admin exemption **unchanged**. |
| C8 | `packages/server/src/services/workspace-member-capabilities.service.ts` | MOD | `CAPABILITIES`/`ROLE_CAPS` re-expressed over the catalogue; `getCapabilities` delegates to the resolver so there is one computation. ⚠ **`approver` gains `flows.arm`** — the one declared preset change (data-model §2). ⚠ **THREE readers, not one**: `break-glass.ts`, `routes/me.ts` and `catalogue.service.ts` (research M-7). |
| C9 | `packages/server/src/services/search.service.ts` | MOD | ⚠ **The one route the map cannot secure alone.** `index(workspaceId, q)` takes **no viewer at all** and the route has no `requireIdentity`. Filter each of the six result kinds by the caller's permission. ⚠ The kinds are `workflow · step · run · resource · approval · person` — **there is no secrets kind and no audit kind**, so the earlier note named the wrong exposures. The real ones are `flows.read`, `runs.read`, `datasources.read`/`tools.read`, `approvals.read` and `members.read`. |
| C10 | `packages/server/src/services/search.service.test.ts` | MOD | Per-kind filtering, with a control that an entitled caller still sees each kind. |
| C11 | `packages/server/src/services/catalogue.service.ts` | MOD | ⚠ **Second undocumented reader of the capability store.** Its `real-data` gate becomes `realdata.use`; a named test pins that it still refuses without it, beside break-glass's. |

### Phase D — routes

| # | File | | Change |
| :-- | :--- | :-- | :--- |
| D1 | `packages/server/src/app.ts` | MOD | Mount `requirePermission` per workspace router; mount `rolesRouter`, `platformRolesRouter`, `permissionsRouter`. ⚠ At each router's **exact path**, never `app.use("/api", …)` — that form put the Kestra callbacks behind the parent key and every flow died at `begin` (I-65). |
| D2–D31 | 30 workspace route files | MOD | See `contracts/route-permissions.md`. Most change by **zero lines** (the map does it); those with per-handler exceptions get one. Files: `approval-requests` `approvals` `attendance` `audit-events` `bootstrap` `break-glass` `catalogue` `credentials` `datasources` `email-box` `flow-chat` `flow-executions` `flow-flags` `flow-phases` `flow-positions` `flow-scenarios` `flow-templates` `flows` `incidents` `members` `next-fires` `pins` `release-gates` `resources` `search` `step-approvals` `step-try` `tools` `triggers` `workspace-secrets`. |
| D32 | `packages/server/src/routes/roles.ts` | NEW | Workspace custom-role CRUD (contract §B). `.strict()` schemas, no `subject`/`permissions` self-naming (FR-025). |
| D33 | `packages/server/src/routes/roles.test.ts` | NEW | |
| D34 | `packages/server/src/routes/platform-roles.ts` | NEW | Contract §C, incl. `GET /platform/audit` union (INV-17). |
| D35 | `packages/server/src/routes/platform-roles.test.ts` | NEW | |
| D36 | `packages/server/src/routes/permissions.ts` | NEW | `GET /api/permissions/catalogue`. |
| D37 | `packages/server/src/routes/me.ts` | MOD | +`platformRoles`, `platformPermissions`. Existing keys keep meaning and position. |
| D38 | `packages/server/src/routes/attendance.ts` | MOD | +`GET /me/permissions` on the existing `/workspaces/:ws/me` mount (contract §A). |
| D39 | `packages/server/src/routes/workspaces.ts` | MOD | **FR-015 filtering** on `GET /`; `flows.read` on `GET /:id` and `/:id/manifest`; `requireSuperAdmin` → `platform.workspaces.write` on the three lifecycle routes. |
| D40 | `packages/server/src/routes/generation-provider.ts` | MOD | `requireDeploymentAdmin()` → `requirePlatformPermission("platform.generation.write")`. |
| D41 | `packages/server/src/middleware/deployment-admin.middleware.ts` | **DEL** | Research D-6 — its own docblock names this as the fix. Deleting it stops there being two answers to "who may change a deployment setting", the weaker of which takes no argument. |
| D42 | `packages/server/src/middleware/platform-permission.middleware.ts` | NEW | `requirePlatformPermission()`. Two distinguishable refusals (FR-022). |
| D43 | `packages/server/src/middleware/platform-permission.test.ts` | NEW | |
| D44 | `packages/server/src/routes/local-users.ts` | MOD | ⚠ **9 handlers, not 7.** Six are local-account management → `platform.localusers.write`. ⚠ **Three are workspace-membership access**: `GET /:id/access` → `platform.users.read`, and `PUT|DELETE /:id/access/:workspaceId` → **`platform.members.grant`**, not `platform.localusers.write` — a third permission that grants workspace access is the duplication D-6 deletes `requireDeploymentAdmin` to avoid. `localAuthRouter` untouched (exempt). |
| D45 | `packages/server/src/routes/platform.ts` | MOD | `platform.users.read`. |
| D46 | `packages/server/src/routes/ops-proxy.ts` | MOD | ⚠ **NOT one permission for all ten.** Six outbox/status reads → `platform.ops.read`; **four `llm_complete` tool-model handlers** → `platform.toolmodel.read`/`.write`. D-115 keeps the tool model and the generation model deliberately separate and it has confused a user twice; one permission would merge them at the authorisation layer. |
| D47 | `packages/server/src/routes/signals.ts` | MOD | +**`platform.signals.read`**, not `platform.audit.read` — signals answers *"is the system still doing its job"*, not audit history. ⚠ Keep the CLI working — `pnpm signals` presents an allowlisted identity (R-2's shape). |
| D48 | `packages/server/src/routes/engine-plugins.ts` | MOD | +`requireIdentity`. |
| D49 | `packages/server/src/middleware/identity.middleware.ts` | MOD | `requireWorkspaceRole` **kept** and re-expressed over the resolver, so the 36 guarded handlers keep working. ⚠ **Two route-tree assertions go red — see D50.** Docblock corrected. |
| D50 | `packages/server/src/services/workspace-member.test.ts` | MOD | Extend the route-tree scan to the permission map. ⚠ **TWO EXISTING ASSERTIONS GO RED AND MUST BE REWRITTEN, NOT KEPT.** (1) `describe("every route that assigns membership or creates a workspace carries requireSuperAdmin")` greps `workspaces.ts` for the literal `requireSuperAdmin`, which D39 removes — it becomes "carries the platform permission", with its control. (2) `it("an admin satisfies every lower role — the ranking is ordered, not a set")` names the mechanism `RANK`, which C7 deletes — the *property* survives under set containment and the test keeps it; the name and the comment must change with it. Every other assertion in the file does still hold. |

### Phase E — client

| # | File | | Change |
| :-- | :--- | :-- | :--- |
| E1 | `packages/client/src/lib/foundry-client.ts` | MOD | 14 methods (contract §F). No access logic. |
| E2 | `packages/client/src/lib/types.ts` | MOD | `Permission`, `WorkspaceRole`, `PlatformRole`, `MyPermissions`. |
| E3 | `packages/client/src/lib/permissions.tsx` | NEW | Provider + `usePermissions()`. **Three states: allowed / denied / unreadable.** 60s bound (SC-005). |
| E4 | `packages/client/src/lib/permissions.test.tsx` | NEW | The unreadable state renders as neither answer (FR-032). |
| E5 | `packages/client/src/components/access/Can.tsx` | NEW | Renders children only on a server answer. |
| E6 | `packages/client/src/components/access/PermissionGate.tsx` | NEW | Disabled + reason + who can grant. |
| E7 | `packages/client/src/components/access/RoleEditor.tsx` | NEW | Catalogue-driven role authoring. |
| E8 | `packages/client/src/components/access/*.test.tsx` | NEW | Three render tests each, incl. the unreadable state. |
| E9 | `packages/client/src/lib/workspace.tsx` | MOD | Filtered list; handle the active workspace disappearing on revocation (edge case). ⚠ **`listWorkspaces` has SIX consumers, not two**: `shell/Topbar.tsx`, `lib/workspace.tsx`, `data-sources/page.tsx`, `data-sources/[id]/page.tsx`, `admin/incidents/page.tsx` and `workspace/LocalAccountAccess.tsx` — the last being the super-admin grant form, which must keep seeing every workspace. |
| E10 | `packages/client/src/lib/workspace-choice.ts` | MOD | No-grants → the explaining state, never an empty picker. |
| E11 | `packages/client/src/lib/workspace-resolve.test.ts` | MOD | |
| E12 | `packages/client/src/components/shell/Sidebar.tsx` | MOD | Nav rows by permission. ⚠ An empty **group** must not render its heading — the 2026-08-21 fix; per-group filter, both directions asserted. |
| E13 | `packages/client/src/components/shell/Topbar.tsx` | MOD | Switcher over the filtered list. |
| E14 | `packages/client/src/components/shell/Sidebar.test.tsx` | MOD | |
| E15 | `packages/client/src/app/(app)/organization/page.tsx` | MOD | Roles + platform tier. ⚠ Keeps its four states incl. "could not be checked". |
| E16 | `packages/client/src/app/(app)/organization/page.test.tsx` | MOD | |
| E17 | `packages/client/src/app/(app)/organization/roles/page.tsx` | NEW | Role list/editor. |
| E18 | `packages/client/src/app/(app)/organization/roles/page.test.tsx` | NEW | |
| E19 | `packages/client/src/app/(app)/no-access/page.tsx` | NEW | FR-016 / SC-013. |
| E20 | `packages/client/src/app/(app)/no-access/page.test.tsx` | NEW | |
| E21–E33 | 13 pages under `app/(app)` | MOD | Affordance gating: `dashboard` `flows` `data-sources` `tools` `keys` `triggers` `resources` `approvals` `runs` `history` `live` `incidents` `email-box` `admin` `ai-provider`. Controls absent or disabled with a reason; **never hidden as the enforcement**. |
| E34 | `packages/client/src/app/routes.smoke.test.tsx` | MOD | +2 pages (`no-access`, `organization/roles`). ⚠ `ui-honesty-check.sh` derives the page count by walking the filesystem, so it follows automatically. |
| **E35** | `packages/client/src/lib/capabilities.ts` | **DEL** | ⚠ **THE CLIENT'S OWN `ROLE_CAPS`, AND IT DISAGREES WITH THE SERVER'S** (research M-7). A second authority deciding access questions, which FR-031 forbids — and the widened session-roles ban (F5) does **not** catch it, because it reads a server answer and then applies its own policy. Deleting it is the whole point; `CAP_LABEL` survives as labels only, moved beside `RoleEditor`. |
| **E36** | `packages/client/src/components/shell/Sidebar.tsx` | MOD | Remove `me.data?.capabilities?.includes("admin")` at line 379; gate on `usePermissions()`. Listed separately from E12 because it is a *deletion of an existing decision*, not the addition of a new one. |
| **E37** | `packages/client/src/lib/search.ts` | MOD | Delete `filterByCapabilities()`. Filtering moves to the server (C9). A client filter over a server list that was never filtered is decoration; leaving both is two answers. |
| **E38** | `packages/client/src/components/admin/MembersPanel.tsx` · `components/workspace/LocalAccountAccess.tsx` | MOD | Both render role→capability bundles from the deleted module. They read the catalogue and the presets from `GET /api/permissions/catalogue` instead. |
| **E39** | `packages/server/src/routes/me.ts` | MOD | ⚠ **Remove `capabilities[]` from `GET /api/me`.** It is a fourth answer to "what may this person do here", superseded by `/me/permissions`. A client-visible contract change with four consumers — do it *after* E36–E38, or the sidebar loses its gate before it gains the new one. |

### Phase F — harnesses, checks, docs

| # | File | | Change |
| :-- | :--- | :-- | :--- |
| F1 | `packages/server/src/scripts/rbac-backfill.ts` | NEW | Dry-run by default; `--apply` to write. Per-person `today`/`after`/`diff` (FR-029, research D-5). |
| F2 | `packages/server/src/scripts/rbac-verify.ts` | NEW | Every handler × 3 identities. **Positive control mandatory** — all-refused must fail. |
| F3 | `packages/server/src/scripts/rbac-platform-verify.ts` | NEW | SC-010 **and SC-015**. Asserts `auditor`'s conferred set is empty **directly** (INV-12), and that a `platform-admin` who is a member of nothing is permitted **exactly 2** workspace-scoped routes — the member list and the member write — and refused every other. ⚠ **Exactly 2, not "at least 2"**: a floor passes while the conferral silently widens. |
| F4 | `packages/server/package.json` | MOD | `rbac:backfill`, `rbac:verify`, `rbac:platform-verify`. ⚠ `pnpm --filter @foundry/server …`, not root — none of these is a root script. |
| F5 | `scripts/ui-honesty-check.sh` | MOD | Widen the line-2083 session-roles ban to `app/` + `components/`, keep `superadmin` in the pattern, add a `present_code_in` positive control (research M-3). +assertions for the three-state gate and the no-access page. |
| F6 | `packages/server/src/kestra/e2e-ui-journey.ts` | MOD | Present an allowlisted identity for the now-filtered list (R-2); **NOTE, not MISMATCH**, when unset. |
| F7 | `.specify/memory/security.md` | MOD | §2 rewritten via `/speckit-update-standards`. Records the two widenings and the one narrowing. |
| F8 | `.specify/memory/standards-history.md` | MOD | Append-only entry. |
| F9 | `CLAUDE.md` | MOD | New section; correct "22 of 43 route files" to the handler-level numbers. |
| F10 | ⚠ **`archive/GAPS.md`** | MOD | ⚠ **The file moved 2026-09-11 (`fb5eac7`); `docs/GAPS.md` no longer exists.** §1.1 is already marked CLOSED for the role half — this **extends** it with the enforcement half, per that file's convention. |
| F11 | `.env.example` | MOD | Document `SUPER_ADMIN_EMAILS` as load-bearing (no value — Article VIII). |

---

## Behaviour changes — stated, not absorbed

⚠ **Eight, not four.** Each is intended; each must appear in the standards amendment.

1. **106 routes stop being reachable without a grant.** The point of the feature.
2. **`GET /api/workspaces` is filtered** (FR-015). People will see fewer workspaces and the
   first person to notice will report it as a regression. Six client call sites.
3. **⚠ WIDENING — `POST|DELETE /workspaces/:ws/members` becomes reachable by a workspace
   admin**, not only a super admin. Deliberate: Story 3 is unusable if every assignment
   needs a platform administrator. This is one of two places the feature *loosens* a
   control, and it is one a reviewer should look at hardest.
   - ⚠ **`contracts/api.md` §D and this list disagreed on what "and" meant.** §D said it
     *stays* `requireSuperAdmin` **and** additionally accepts `members.grant`; this list
     said it *becomes* admin-reachable, **not only** super-admin. Those are AND and OR.
     **Resolved: OR** — super admin **or** `members.grant`, which is what makes Story 3 work.
     §D is corrected to say so.
4. **⚠ NARROWING — changing the generation model needs an explicit platform grant**, not
   "admin in any workspace" (research D-6). ⚠ On this deployment the backfill will report
   **zero** people losing it, because nobody holds `admin` anywhere (M-6). The narrowing is
   real in the code and invisible in the data; do not read the empty report as evidence it
   is harmless elsewhere.
5. **⚠ WIDENING — an `approver` gains `flows.arm`.** The second place this feature loosens a
   control, and it arrives disguised as a carry-forward. Two `ROLE_CAPS` exist and disagree
   on exactly this cell (M-7): the server gives `approver` no `publish`, the client gives it
   one, and the preset table agrees with the client. **Decided: an approver may arm.** So
   FR-006's *"the presets reproduce today's roles exactly"* is **false for this one cell**,
   and saying otherwise would hide a widening inside a migration.
6. **⚠ ON THIS DEPLOYMENT, EVERY WORKSPACE BECOMES UNUSABLE TO EVERY NON-SUPER-ADMIN THE DAY
   THE MVP SHIPS.** `workspace_members` holds **zero** rows against **eight** workspaces
   (M-6). P-2 (empty means empty) and FR-012 (absence of configuration is not permission)
   are both correct and both bite at once. **Accepted, not fixed**: only `SUPER_ADMIN_EMAILS`
   holders can use the product until somebody assigns members through `/organization`. There
   is deliberately no backfill-everyone-as-admin step — that is the shape migration `0027`
   refused. The requirement is that this is **stated**: in this list, in the quickstart's
   first step, and in the standards amendment. A pre-flight task prints the member count
   before the guard is mounted, so the deployer sees it rather than the first user does.
7. **⚠ The client stops deciding access questions.** `lib/capabilities.ts` is deleted, the
   sidebar's `capabilities.includes("admin")` goes, `filterByCapabilities()` goes, and
   `GET /api/me` stops returning `capabilities[]`. Four surfaces change what they render
   from. This is FR-031 being satisfied for the first time — it was written as a rule the
   codebase already followed, and it did not.
8. **⚠ WIDENING — a platform administrator can see and change the member list of every
   workspace** (D-9). The third and last place this feature loosens a control, and the one
   with the widest blast radius: `platform.members.grant` confers `members.read` +
   `members.grant` everywhere, so a platform admin can **assign themselves `admin` in any
   workspace** and from there reach that tenant's data.
   - It exists because the alternative was a dead end: a platform admin could create a
     workspace and then put nobody in it, themselves included.
   - ⚠ **The bound is the number two.** The conferral is those two permissions and nothing
     else — not `flows.read`, not `secrets.read`. Reading a tenant's automations requires
     *first* granting themselves a role, and that grant is a write on the record (FR-033).
   - ⚠ **The sentence to use**: *a platform administrator cannot see a tenant's data, but
     can give themselves the ability to, and doing so leaves an audit entry naming them.*
     **Never** the unqualified *"a platform admin cannot access tenant data"*.
   - `auditor` and `support` confer **nothing** and are unaffected.

**Not changed, and each pinned by a surviving test**: gate 2's self-approval refusal;
`requireProvenanceAuthority`; `requireNotRunRequester`; the super-admin exemptions from
both, with `flow_approvals.self_approved_override` still recording gate 2's; the
allowlist as an un-grantable root; approval binding to a revision;
`flow-approval.service.ts` as the only writer of the live namespace.

---

## Complexity Tracking

*Article IV requires justification for new layers.*

| Violation | Why needed | Simpler alternative rejected because |
| :--- | :--- | :--- |
| 5 new tables | Custom roles, a platform tier and a platform audit record have no home in the existing schema. | **Reuse `workspace_member_capabilities` for everything**: it has no role concept, so every custom role would be re-expanded into per-person rows — editing a role would mean rewriting every assignee's rows, and Story 3 scenario 2 (a permission removed applies on the next request) becomes a fan-out write that can partially fail. |
| A new `auth/` directory | The catalogue, presets and route map are one policy and are reviewed together. | **Put them in `services/`**: 60 files deep, the policy stops being findable, and the map's value is that a reviewer reads it as a document. |
| A central map rather than in-line guards | Makes FR-002's check a set difference against the mounted router stack rather than a regex over source. | **In-line `requirePermission()` on 106 handlers**: the completeness check degrades to grepping source, which this repo has been bitten by three times (I-38; 21 client render files green while not running; `ui-honesty-check.sh` satisfied by files that never executed). Research M-5 is the concrete case — a regex reports **9** false positives on `local-users.ts`, which is guarded at the router. |
| A **generated** map rather than a written one | The hand-written version drifted in six places in two days, in the one document whose only value is being accurate. | **Keep writing it by hand and rely on the completeness check to catch drift**: the check does catch it — at implementation time, after a reviewer has already approved a policy document describing routes that do not exist. The review is the point of the document, and a reviewer cannot review a map against a stack they are not holding. |
| Splicing the guard per handler at boot rather than one middleware per router | A router-level middleware runs before Express matches the sub-route, so it cannot know which handler will run. | **Re-match `req.method` + `req.path` against the map inside the middleware**: that is re-implementing `path-to-regexp` and route ordering, and it will disagree with the router on exactly the cases nobody tested (`/generate/jobs` vs `/:flowId`). `wrapAsyncRoutes` already walks and splices on this codebase, with a count floor. |
| A second audit store | `audit_events.workspace_id` is `NOT NULL` with an FK and a cascade. | **Relax it to nullable**: every existing audit query must then be re-verified for a filter it may not have, and a missing one surfaces platform events inside a tenant's view. **Attribute to a nominated workspace**: needs no schema change and makes the audit assert something untrue. |
| A backfill script rather than a migration | FR-029 requires the carried-forward state to be reviewable before it applies. | **Backfill inside `0064`**: applied and then discovered. The repo's own idiom is dry-run-first (`slate:plan`, `kestra:plugins --dry-run`, `backup:verify`). |

---

## Phase ordering and independent shippability

| Phase | Delivers | Ships alone? |
| :--- | :--- | :--- |
| A | Catalogue, resolver, guard, completeness check | No — no route uses it yet |
| A+B+C7/C8/C11+D1–D31+D49/D50 | **US1 + US2 — the security fix** | ✅ **Yes. This is the MVP.** ⚠ **And on this deployment, shipping it takes the product away from everyone who is not in `SUPER_ADMIN_EMAILS`** until members are assigned — behaviour change 6. That is accepted; it is not a surprise to be discovered. |
| B+C1/C2+D32/D33+E7/E17 | US3 — custom roles | ✅ after the MVP |
| B+C3/C4+D34/D35+D39–D48 | US4 — platform tier | ✅ after the MVP |
| E | US5 — affordances | ✅ after the MVP; a 403 on click is ugly, not unsafe |
| C5/C6+F | US6 — audit, harnesses, docs | ✅ |

⚠ **A alone is not shippable and must not be reported as progress.** A catalogue nothing
enforces is exactly the state `workspace_member_capabilities` is in today: correct, well
tested, read by one route. That is the shape this feature exists to end.

---

## Post-Design Constitution Re-check

| Article | Re-check | Finding |
| :--- | :--- | :--- |
| I | ⚠ | Artefacts complete and re-baselined. **The branch still does not exist** and `specs/` is untracked — this is the one gate that is currently unmet, and it is met by one `git checkout -b` and one commit. |
| II | ✅ | Every control in the file inventory has a paired test file; quickstart step 8 lists 10 perturbations with expected reds. |
| III | ✅ | The largest single review artefact is `contracts/route-permissions.md`, deliberately one document — and now a **generated** one, so what a reviewer approves is what is mounted. |
| IV | ⚠ → ✅ | Five entries in Complexity Tracking, each with the rejected alternative and the measurement behind it. No new dependency. |
| V | ✅ | Refusal envelope (contract §E) carries reason, permission and requestId. `search.service.ts` C9 is the one place a silent under-report was possible; it has a task and a control. |
| VI | ⚠ | One directory; no branch yet. See Article I. |
| VII | ✅ | F7–F11 are tasks, not follow-ups. ⚠ F10's target moved: `docs/GAPS.md` → **`archive/GAPS.md`**, whose §1.1 is already marked CLOSED for the role half; the task **extends** that entry rather than closing it again. |
| VIII | ✅ | No credential added, moved or logged. INV-3 pins that no permission returns a secret value. `.env.example` gets a name, never a value. |

**Gate: PASSED on content, BLOCKED on Article I/VI.** No unjustified violations. Create the
feature branch and commit these artefacts, then `tasks.md` is ready to execute.
