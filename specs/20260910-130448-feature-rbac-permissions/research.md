# Phase 0 — Research

**Feature**: Feature-level RBAC · **Branch**: `20260910-130448-feature-rbac-permissions`
**Date**: 2026-09-10 · ⚠ **RE-BASELINED 2026-09-12**

Every number here was measured against this working tree, not estimated. Where a
measurement contradicts something already written down, the contradiction is stated rather
than smoothed over.

⚠ **THE 2026-09-10 MEASUREMENTS WERE RE-TAKEN ON 2026-09-12 AND SEVERAL HAD MOVED.** About
twenty-five commits landed in between (`beta-1.0.0` … `beta-1.0.19`, plus the component-model
stages), and three of them changed the subject of a measurement. Corrected entries carry a
**RE-MEASURED** banner and say what the old reading was, because a number silently replaced
reads as a number that was always right. **M-6, M-7, M-8 and M-9 are new** and each of them
changes a task.

⚠ **AND IT MOVED AGAIN ON 2026-09-13, DURING THE RE-BASELINE ITSELF** — `beta-1.1.0` added
ten routes and four permissions. See **M-9**. Treat every number here as a reading with a
date on it, and re-run `contracts/README.md`'s procedure before implementation starts.

---

## M-1 · The enforcement gap is HANDLER-level, and it is 6× larger than the file count implied

⚠ **RE-MEASURED 2026-09-12 against the live Express stack.** The 2026-09-10 figures below
were taken by reading source and were wrong in four places; ~25 commits have landed since.
The unit is now a mounted `(method, resolved path)` pair read out of `createApp()`, which
is the same thing the FR-002 check reads. `contracts/dump-routes.mts` is that walk,
standalone and repeatable.

The spec's Context section says "18 route modules with no guard", and "43 route modules".
There are **46** modules (44 on 2026-09-12, +2 with `beta-1.1.0`), and the file unit
understates the work 6×. Per mounted route:

| Tier | Routes | Guarded today | To add | Was claimed |
| :--- | ---: | ---: | ---: | :--- |
| Workspace-scoped | **142** | 36 | **106** | 132 / 24 / 108 ❌ |
| Deployment-level | **38** | 6 | 32 | 36 / 17 / 19 ❌ |
| Exempt — must not change | **16** | 0 (by design) | 0 | 11 ❌ |
| **Total** | **196** | | | 179 ❌ |

"Guarded today" for the workspace tier is 21 handlers carrying `requireWorkspaceRole`,
plus 2 carrying `requireSuperAdmin` (`members.ts` POST/DELETE) and 2 carrying
`requireIdentity` alone (`pins.ts`).

Two files remain the largest single contributors, as originally measured:

- **`flows.ts` — 25 reachable routes, 2 guarded.** `DELETE /:flowId/revisions/:revision`
  and `POST /:flowId/save-draft` carry a role. `POST /:flowId/test-run`, `DELETE /:flowId`,
  `POST /generate`, `POST /generate/jobs`, `POST /import`, `POST /:flowId/revisions`,
  `POST /:flowId/refine` and sixteen others carry nothing. A person with no grant in a
  workspace can currently delete its automations and start runs against its real
  datasources. **Verified unchanged on 2026-09-12.**
- **`approvals.ts` — 6 handlers, 3 guarded**, and **`step-approvals.ts` — 3, 1**. Only the
  write paths are guarded. `GET /` (the pending approvals list) and
  `GET /execution/:executionId` are open, so the approvals inbox of any workspace is
  readable by anybody signed in. ⚠ `POST /recheck` is also open **and it can suspend a live
  flow**, which the earlier measurement did not call out.

**Four corrections a reader must carry:**

- ⚠ **`approvals.ts` is 6 handlers, not 5.** `POST /rearm` landed 2026-09-12 (`8e4ab34`),
  already `approver`-guarded. It was absent from the route map entirely.
- ⚠ **`datasources.ts` is 24, not 23.** `POST /:dsId/queries/propose` was unmapped. And the
  map named two paths that do not exist (`POST /operations/check`, `/operations/propose`
  without `/:dsId/`).
- ⚠ **`steps.ts` is 6 exempt handlers, not 4.** `/llm` and `/http` landed with Stage 4
  (`d274caa`, 2026-09-10) — the day the map was written.
- ⚠ **`local-users.ts` is 9 handlers + 1, not 7 + 1.** See M-5.

**Two shadowing facts the check must handle:**

- **`GET /flows/:flowId/phases` is registered twice.** `flows.ts` has the implementation;
  `flow-phases.ts`'s router is a placeholder returning `{ phases: [] }`, mounted at the same
  path and unreachable because `flowsRouter` mounts first. Dead code, found by generating
  the map. The check must dedupe on the resolved path.
- **`releaseGatesRouter` is mounted twice**, at `/release-gates` and at
  `/flows/:flowId/release-gates`. One source handler, two reachable routes.

**Consequence for the plan**: a per-file sweep is the wrong unit and would report itself
complete with `flows.ts` still open. Tasks are per route, and the completeness check counts
mounted routes, deduped.

**`triggers.ts` needs care**: 8 handlers, of which `POST /:token/webhook` and
`POST /:token/api` are the two public receivers and stay exempt. Only 6 are in scope.

---

## D-1 · Where the permission is declared: a central map, not a decorator at each call site

**Decision**: one module, `src/auth/route-permissions.ts`, mapping
`(router, method, path) → Permission`, consumed by a single middleware mounted per
router in `app.ts`. Each route file changes by **at most one line** (or none).

**Rationale**: the alternative — `requirePermission("flows.write")` typed into all 106
handler argument lists — was rejected for three reasons measured in this repo.

1. **FR-002's completeness check becomes reliable.** With a central map the check is a
   set difference between "handlers the Express router tree reports" and "keys in the
   map" — it cannot miss a handler because it cannot see one. Scanning 30 source files
   with a regex for a middleware call is the weaker version, and this repo has already
   been bitten by a scan that found nothing and passed (I-38; and
   `ui-honesty-check.sh`'s "every page has a render test" was satisfied by 21 files that
   never executed).
2. **A reviewer can read the whole authorisation model on one screen.** 106 declarations
   spread across 30 files cannot be reviewed as a policy, and an unreviewable permission
   list is granted by copy-paste (Assumptions, spec).
3. **The diff stays small enough to review.** 106 in-line edits across the route tree is
   a diff nobody reads carefully, in the one change where careless review is most
   expensive.

**Alternative considered and rejected**: per-handler middleware. Its one real advantage
— the permission is visible beside the handler it guards — is recovered by a generated
comment block and by the map being ordered to mirror the route tree.

**Consequence**: `requireWorkspaceRole` is *not* deleted. It stays as the mechanism the
central middleware uses, so the 36 already-guarded handlers keep working unchanged
during the migration and the existing route-tree tests keep passing.

⚠ **THE COST THIS DECISION DID NOT PRICE, AND IT IS THE LARGEST OPEN DESIGN QUESTION.**
"A single middleware mounted per router in `app.ts`" runs **before the router matches its
sub-route**. At that moment `req.route` is empty, so the middleware cannot ask Express
which handler is about to run — it has to match `req.method` + `req.path` against the map
**itself**. That is re-implementing Express routing, and three things follow that the
original decision does not mention:

1. **Order is load-bearing and the map must carry it.** `GET /generate/jobs` and
   `GET /:flowId` both match `/generate/jobs`; only registration order separates them.
   The map must be matched first-wins in the same order the router registers, and the
   generated document must therefore be emitted in registration order or transcribed from
   one that is. The 2026-09-10 map was ordered alphabetically-ish by hand and is not.
2. **Use the router's own matcher, not a hand-rolled one.** `path-to-regexp` is already a
   transitive dependency of Express 4; compiling each map key with it is the only version
   where the map and the router agree by construction. A hand-written matcher is a second
   definition of "which route is this", and it will disagree on the cases nobody tested.
3. **A per-router `router.use()` is the alternative worth costing.** Mounting the guard as
   the router's own first layer does not help — `router.use` runs before the route layer
   too. The version that *does* know the route is a guard installed **per handler** by
   walking the router's stack once at boot and splicing the middleware in, which keeps the
   central map and gets the match for free. It is the shape `wrapAsyncRoutes` already uses
   on this codebase, with a count floor asserted against the real app.

**Recommendation**: option 3 — central map, boot-time splice, no re-implemented matching.
It preserves every argument above (one reviewable document, a set-difference check, a small
diff) and removes the only part that was going to be invented.

---

## D-2 · Storage: extend the two existing tables, add three

**Decision**:

| Table | Status | Why |
| :--- | :--- | :--- |
| `workspace_members` | **unchanged** | Its `role` column keeps holding a built-in preset name. A custom role assignment goes in the new join table, so no existing row's meaning changes and no CHECK constraint has to be relaxed. |
| `workspace_member_capabilities` | **reused, renamed in concept** | Already `(workspace_id, subject, capability, granted_by)` with the right unique index. Its rows become individual permission grants. The 7 existing capability strings are migrated to catalogue names. |
| `workspace_roles` | **new** | Custom role definitions, workspace-scoped. |
| `workspace_role_permissions` | **new** | Which permissions a custom role holds. |
| `workspace_role_assignments` | **new** | Which people hold which custom role. |
| `platform_roles` / `platform_role_assignments` | **new** | The deployment tier. |
| `platform_audit_events` | **new** | D-2 in the spec — see M-2 below. |

**Rationale for not adding a `permissions` table**: the catalogue is code-owned (FR-001).
A table would make it data an administrator could edit, which is the property FR-001
exists to prevent, and it would let a row reference a permission the code does not
implement.

**Rationale for keeping `workspace_members.role`**: making custom roles the only
mechanism would require rewriting every existing member row and relaxing the role CHECK
constraint — a migration that changes what every existing grant means, in exchange for
uniformity. FR-028 (identical effective access on day one) is much cheaper to prove when
the rows are untouched.

---

## M-2 · `audit_events` cannot hold a platform event, confirmed at the schema

`workspace_id` is `uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`. There is
also a CHECK on `operation` (`create update delete publish approve reject access
execute`) and one on `entity` (15 values, including `member` and `policy`).

Two findings for the plan:

- The spec's D-2 (separate `platform_audit_events`) is the only option that needs **no**
  change to either CHECK and leaves the cascade semantics correct per tier. Confirmed.
- **`access` is already a permitted `operation` and `member` and `policy` are already
  permitted `entity` values.** So recording workspace-tier grants, revocations and
  refusals in `audit_events` needs **no migration at all** — only new call sites. This
  was not obvious and is worth knowing: the audit half of this feature is cheaper than
  it looks on the workspace side and costs one new table on the platform side.

---

## D-3 · Refusal recording: dedupe in memory, on a bounded key

**Decision**: FR-034's bound is a per-process in-memory dedupe keyed on
`(subject, permission, workspaceId)` with a time window; the first refusal in a window
is written, subsequent identical ones increment a counter that is flushed on window
close. No new dependency.

**Rationale**: the repo already runs one process with no clustering, and
`auth.middleware.ts`'s throttle is per-process in-memory for exactly this reason, with
the tradeoff written down. Following the established pattern beats introducing a second
one. A restart losing an unflushed counter loses a *count*, never the fact that a
refusal happened, because the first is written immediately.

**Alternative rejected**: writing every refusal. A client polling a forbidden endpoint
produces thousands of identical rows and pushes the grant history out of a reader's
view — the audit becoming unreadable is the same failure as the audit being absent.

---

## D-4 · Client permission delivery: one call per workspace, cached with an explicit bound

**Decision**: `GET /api/workspaces/:workspaceId/me/permissions` returns the effective
permission set plus its provenance. The client fetches it on workspace resolution and
holds it for at most 60 seconds (SC-005).

**Rationale**: SC-005 requires a revocation to apply within one request server-side and
within 60s in the UI. The server is the authority and never caches; only the client's
*affordance* view has a bound, which is why the bound is stated in a success criterion
rather than left implicit.

**Rationale for the path**: it sits under the existing `/workspaces/:ws/me` mount
(`attendance.ts`) which already establishes "per-person, workspace-scoped, subject from
the token and never a query parameter".

**Alternative rejected**: embedding permissions in the sign-in session. It is the
obvious optimisation and it is forbidden — `ui-honesty-check.sh:2083` already bans the
client deciding from session roles, a revocation would not apply until sign-out, and the
session is minted by a process that holds no database credential.

---

## M-3 · `ui-honesty-check.sh`'s session-roles ban must be generalised, not replaced

⚠ **It is at line 2175, not 2083** — re-measured 2026-09-12; the file is 2299 lines. Cite
the assertion text, not the line, or this goes stale again on the next edit above it.

Current assertion:

```
absent_code_in "the workspace page does not read roles off the session" \
  '(user\.roles|session\.user\.roles|superadmin)' "app/(app)/organization"
```

It is scoped to one directory. FR-031 needs the ban across the whole client. Widening
the path is the change; **the pattern must keep `superadmin`**, because the local
credentials account still puts `["superadmin","admin"]` on the session and that is the
value a developer would reach for.

⚠ Widening will produce hits that are *not* violations — `lib/foundry-client.ts` will
legitimately name the new endpoint. The check has `present_code_in`/`absent_code_in`
with per-file scoping already (added for the `/apps` placeholder), so the correct shape
is a widened `absent_code_in` over `app/` and `components/` with `lib/` excluded, plus a
`present_code_in` asserting the one legitimate reader exists. A single widened pattern
with no positive control is how a check gets weakened until it permits the defect (I-62).

---

## M-4 · Migration numbering

⚠ **RE-MEASURED 2026-09-12, AND THE ORIGINAL NUMBERS NOW COLLIDE.** The 2026-09-10 reading
was *"latest `0060_local_users`, watermark `1789000000000`, 61 journal entries"*. Since then
**`0061_flow_chat_config` has landed**, taking the `when` value `1789100000000` — which is
exactly the value the plan assigned to its own `0061`.

Current, verified at the database and at the journal:

| | |
| :--- | :--- |
| Latest migration | **`0061_flow_chat_config`** |
| Journal entries | **62** |
| Journal max `when` | **`1789100000000`** |
| `drizzle.__drizzle_migrations` rows | **62** — they agree, so this is *not* the 0033 condition |

**New migrations are `0062`…`0065`**, with `when` values `1789200000000`, `1789300000000`,
`1789400000000`, `1789500000000`.

⚠ **T003's precondition as written fails, and its instruction is then a misdiagnosis.** It
says to stop if the journal and the applied-row count disagree, "that is the 0033 re-run
condition" — but it also pins the literal watermark `1789000000000`, which has simply moved
on. **Pin the relationship (journal entries == applied rows, and the new `when` exceeds
every applied `created_at`), never the literal value.** Both are true today.

Both existing precedents still apply: CHECK constraints are added **VALID** after verifying
existing rows satisfy them (the `0038` precedent), and the `when` must exceed every applied
`created_at` (the `0033` re-run incident, where a rewritten timestamp made drizzle re-run an
applied migration for ever).

---

## D-5 · Migration order: backfill is a separate, inspectable step

**Decision**: four migrations, and the data backfill is its own **script** producing a
report before it writes (FR-029).

1. `0062` — `workspace_roles`, `workspace_role_permissions`, `workspace_role_assignments`
2. `0063` — `platform_roles`, `platform_role_assignments`
3. `0064` — `platform_audit_events`
4. `0065` — the capability→permission rename inside `workspace_member_capabilities`,
   plus its CHECK

⚠ **Renumbered 2026-09-12 — see M-4.** `0061` is taken by `flow_chat_config`.
⚠ **On this deployment the rename migration and the backfill both operate on ZERO rows.**
See M-6; that does not make them unnecessary, it makes their *dry run* uninformative, and
the plan must say so rather than let an empty report read as a clean one.

**Rationale for the script**: FR-029 requires the carried-forward state to be reviewable
*before* it applies. A backfill inside a migration is applied and discovered; a script
with a `--dry-run` that prints one line per person is reviewed and then applied. This
repo already has the idiom (`slate:plan` before `slate:clear`, `kestra:plugins
--dry-run`, `backup:verify`).

---

## M-5 · `local-users.ts` is guarded at the router, not per handler

`localUsersRouter.use(requireIdentity, requireSuperAdmin)` — ⚠ **9 handlers, not 7**
(re-measured 2026-09-12), all covered. A per-handler regex scan reports it as 9 unguarded,
which is a **false positive** the completeness check must not reproduce.

⚠ **Three of the nine write `workspace_members`**: `GET /:id/access`,
`PUT /:id/access/:workspaceId` and `DELETE /:id/access/:workspaceId`. Mapping the router
wholesale to `platform.localusers.write` would make workspace membership grantable through a
**third** permission, beside `members.grant` and `platform.members.grant` — the exact
duplication D-6 deletes `requireDeploymentAdmin` to avoid. The two writes take
`platform.members.grant`; the read takes `platform.users.read`. See
`contracts/route-permissions.md`.

⚠ **`PUT|DELETE /api/local-users/:id/access/:workspaceId` is also the counter-example to
FR-024.** That requirement makes a *missing* `:workspaceId` a loud 500 on a workspace-scoped
guard. Here is a **deployment-level** route that has one. The guard must take the parameter
name explicitly rather than infer scope from its presence. This is the concrete reason D-1 reads the Express
router stack rather than grepping source: the stack shows the mounted middleware, the
regex shows only what is typed on the same line.

`POST /api/local-auth/verify` on the sibling `localAuthRouter` is genuinely ungated and
must stay so — it answers before anybody has a session, because it is what mints one.
It joins the exempt list with its reason recorded.

---

## D-6 · What happens to `requireDeploymentAdmin`

**Decision**: replaced by `requirePlatformPermission("platform.generation.write")`, and
the middleware file is **deleted**, not left in place unused.

**Rationale**: its own docblock names this as the fix — *"Option (c), a real
deployment-level role table, stays the right answer … this docblock is where to start."*
Leaving it importable would leave two answers to "who may change a deployment setting",
and the weaker one takes no argument so it is the one somebody reaches for.

⚠ **It has a behaviour change that must be called out, not absorbed**: today anybody
holding `admin` in *any* workspace can change the generation model. After this they need
an explicit platform grant. The backfill script (D-5) must report who loses this, and
the standard's §2 amendment must record it.

⚠ **On this deployment, nobody holds it** — `workspace_members` is empty (M-6), so
`requireDeploymentAdmin` currently refuses everyone except an allowlist holder, and the
backfill will report **zero** people losing it. The narrowing is real in the code and
invisible in the data. Do not read the empty report as evidence the narrowing is harmless
on another deployment.

⚠ **`requireDeploymentAdmin` is not the only deployment setting with a model in it.**
`ops-proxy.ts` carries the `llm_complete` **tool** model (`GET|PUT|DELETE /api/ops/llm/*`),
which D-115 keeps deliberately separate from the generation model and which has confused a
user twice. It gets its own `platform.toolmodel.read|write`; folding it into
`platform.generation.write` would merge, at the authorisation layer, the two settings this
codebase separates on purpose.

---

## D-7 · Standards amendment is part of this feature, not follow-up

`.specify/memory/security.md` §2 "Authorization & Access Control" describes the model
this feature replaces — "workspace-scoped RBAC over an ordered rank", the super-admin
allowlist as the only tier above a workspace. Constitution Article VII requires docs to
move in the same PR as the behaviour.

**Decision**: a `/speckit-update-standards` pass amending `security.md` §2 is a task in
this feature, not a follow-up. Same for the CLAUDE.md sections that describe the current
access control, and for ⚠ **`archive/GAPS.md`** §1.1 (the file moved 2026-09-11 — M-8),
which this feature closes and which must be
marked CLOSED **in place** with its evidence, per that file's own convention.

---

## M-6 · ⚠ `workspace_members` IS EMPTY, AND THE MVP LOCKS EVERYONE OUT ON DAY ONE

Measured against the running deployment on 2026-09-12:

| Table | Rows |
| :--- | ---: |
| `workspaces` (not deleted) | **8** |
| `workspace_members` | **0** |
| `workspace_member_capabilities` | **0** |
| `platform_users` | **2** |
| `local_users` | **0** |
| `audit_events` | **0** |

Four consequences, each of which changes a task:

- **The backfill has no subject matter.** `rbac:backfill --dry-run` will print an empty
  report, and `baseline-access.json` will be an empty object. FR-029's "reviewable before it
  applies" is satisfied vacuously, and **an empty report must not be read as a clean one**.
  The task has to say which it is.
- **INV-5 cannot be derived from data.** The preset pinning was to be "the set derived from
  today's `ROLE_CAPS` plus the routes each role can reach today". There are no role holders,
  and today *every* role can reach the 106 unguarded routes, so the second half is
  degenerate. INV-5 reduces to pinning against `ROLE_CAPS` alone — see M-7, where there are
  two of those and they disagree.
- **SC-003 is vacuously true.** "100% of people holding a built-in role today can perform
  exactly the same set of actions after" — there are none. The criterion is still worth
  keeping for other deployments; it proves nothing here.
- ⚠ **The day US1 ships, all 8 workspaces refuse every non-super-admin.** P-2 (empty means
  empty) and FR-012 (an absence of configuration must not read as permission) are both
  correct and both bite at once. The spec's edge case *"a workspace is created and nobody is
  assigned to it — it is inert and says so"* describes the **whole deployment**, not an edge.

**Decision taken 2026-09-12: this is accepted, not fixed.** Only `SUPER_ADMIN_EMAILS`
holders can use the product until somebody assigns members through `/organization`. The
requirement on the plan is that this is **stated** — in the behaviour-change list, in the
quickstart's first step and in the standards amendment — rather than discovered by the first
person who signs in after the deploy. There is deliberately no backfill-everyone-as-admin
step: that is the shape migration `0027` refused, for the reason it recorded.

---

## M-7 · ⚠ THE CLIENT ALREADY DECIDES ACCESS, WITH ITS OWN MAP, AND THE TWO DISAGREE

The spec says the member capability list is *"read by exactly one route"*. It has **three**
readers, and the third is a whole client-side authorisation layer nobody had written down.

**Server readers of `workspaceMemberCapabilitiesService` — three, not one:**

| Reader | What it does |
| :--- | :--- |
| `routes/break-glass.ts` | the `real-data` check (the one that was known) |
| `routes/me.ts` | `GET /api/me?workspaceId=…` **returns `capabilities[]` to the browser** |
| `services/catalogue.service.ts` | gates catalogue items on `real-data` |

**Client readers, none of which the spec mentions:**

| File | What it does |
| :--- | :--- |
| `lib/capabilities.ts` | a **second `ROLE_CAPS`**, plus `CAP_NAV`, `CAP_CONTROLS`, `capsForRole`, `roleForCaps` |
| `components/shell/Sidebar.tsx` | gates a nav row on `me.data?.capabilities?.includes("admin")` |
| `lib/search.ts` | `filterByCapabilities()` — filters search results **in the browser** |
| `components/admin/MembersPanel.tsx`, `components/workspace/LocalAccountAccess.tsx` | render role→capability bundles from the client map |

⚠ **THE TWO `ROLE_CAPS` DISAGREE, AND ON EXACTLY THE PERMISSION IN QUESTION.**

| | `author` | `approver` | `admin` |
| :--- | :--- | :--- | :--- |
| server `workspace-member-capabilities.service.ts` | `edit-workflows` | `edit-workflows`, `approve` | + `publish` `resources` `admin` `real-data` |
| client `lib/capabilities.ts` | `edit-workflows` | `edit-workflows`, **`publish`**, `approve` | + `resources` `real-data` `admin` |

`data-model.md`'s preset table gives `approver` **`flows.arm`** — which is `publish` — so it
agrees with the client and contradicts the server. **INV-5 as written ("pin against today's
`ROLE_CAPS`") is ambiguous: there are two, and they differ here.**

**Decisions taken 2026-09-12:**

- ⚠ **An approver MAY arm.** The preset table and the client map are right; the server's
  `ROLE_CAPS` is the bug. INV-5 pins against the corrected set, and the correction is a
  behaviour change on its own — recorded in the plan's list, not absorbed into the presets.
- ⚠ **`lib/capabilities.ts` is DELETED and every affordance reads the server's answer.**
  FR-031 says the client must not decide an access question; it currently does, from a map
  of its own, and the widened session-roles ban (M-3) would **not** catch it — none of this
  reads `session.user.roles`. It reads a server answer and then applies its own policy to it,
  which is a second authority wearing a permitted shape.
- **`GET /api/me`'s `capabilities[]` is a fourth answer to the same question** and is
  superseded by `GET /workspaces/:ws/me/permissions`. Removing it is a client-visible
  contract change with four consumers; it is a task, not a side effect.

---

## M-8 · Three artefact paths in the plan no longer exist

Measured 2026-09-12. Each is a task that would fail on contact.

- ⚠ **`docs/GAPS.md` is gone.** The docs record was consolidated to `archive/` on
  2026-09-11 (`fb5eac7`); the file is now **`archive/GAPS.md`**, and its §1.1 is already
  marked *"CLOSED 2026-08-03 for the role half"*. Source docblocks already cite
  `archive/GAPS.md §1.1`. The task must target the new path and must extend the existing
  CLOSED entry rather than close it again.
- ⚠ **The `ui-honesty-check.sh` assertion is at line 2175, not 2083.** See M-3.
- ⚠ **The branch `20260910-130448-feature-rbac-permissions` does not exist**, and the
  `specs/` directory is untracked. The current branch is
  `fix/resource-detail-schema-and-operations`. Constitution Articles I and VI are not
  satisfied until the branch is created and the artefacts are committed on it.

---

## M-9 · ⚠ THE SURFACE MOVED AGAIN MID-SESSION, AND THAT IS THE ARGUMENT FOR GENERATING

On **2026-09-13**, hours after M-1 was re-measured, a merge from `release/beta` landed
`beta-1.1.0` — *"admin section goes real: capability grants, incident lifecycle, break-glass
activation, gate toggles, budget routes, admin overview"* — and `beta-1.2.0`.

**Ten new workspace-scoped routes. 186 → 196. Zero removed.**

| Added | Guard it arrived with | Mapped to |
| :--- | :--- | :--- |
| `GET\|PUT\|DELETE /budget` | `admin` | `budget.read` / `budget.write` |
| `GET /member-capabilities` | **super admin** | `members.read` |
| `PUT\|DELETE /member-capabilities/:subject/:capability` | **super admin** | `members.grant` |
| `PATCH /release-gates/:gateId` (×2 mounts) | `admin` | `gates.write` |
| `PATCH /incidents/:id` | `admin` | `incidents.write` |
| `GET /approval-requests/figures` | `author` | `approvals.read` |

Three things follow:

- **Every one arrived already guarded**, so the guarded count went 25 → 36 and the gap
  closed slightly rather than widening. The admin section shipping with its guards on is the
  good news in this delta.
- ⚠ **`member-capabilities` IS THIS FEATURE'S OVERRIDE STORE, SHIPPED AS A PRODUCT SURFACE
  WHILE THE SPEC WAS BEING WRITTEN.** FR-010 describes individual permission grants as
  something this feature adds; there is now a live CRUD surface over
  `workspace_member_capabilities`, super-admin-gated. Mapping it to `members.grant` is
  behaviour change 3 applied consistently — an admin who may grant a **role** but not a
  single permission has it the wrong way round. It also means `workspace_member_capabilities`
  now has a **fourth** reader (`listAll`), on top of M-7's three.
- ⚠ **Four permissions came from the product, not from this spec**: `gates.read`,
  `gates.write`, `budget.read`, `budget.write`. Catalogue 45 → **49**.

**The point**: regenerating the map cost one command. The hand-written version would have
been wrong for the **third time in four days**, and nobody would have found out until
implementation — after a reviewer had approved a policy document describing a surface that
no longer existed. `contracts/README.md` has the regeneration procedure; **run it again
before implementation starts**, because this will happen again.

---

## Open risks carried into the plan

| # | Risk | Mitigation in the plan |
| :-- | :--- | :--- |
| R-1 | 106 route declarations is a large mechanical change; a wrong permission on one route is a silent over- or under-grant. | The map is **generated**, not transcribed (`contracts/route-permissions.md`), and the generator fails on an unmapped or stale entry. ⚠ The backfill report and SC-003 are **not** mitigations here — M-6: there are no members, so both are empty. Review of the generated document is the whole mitigation. |
| R-2 | Filtering the workspace list (FR-015) breaks `e2e:ui`, which finds its fixture by listing. | Named in the spec's Assumptions; a task presents the allowlist identity, matching what that harness already does for its membership step. |
| R-3 | The regression net calls services directly and must stay green. | Enforcement is at the route only (FR-027). A task runs the full net before and after and diffs the results. |
| R-4 | A permission check on every request adds a database read to every request. | The effective-permission resolution is one query per (person, workspace) per request, with the same shape as today's member lookup. Measure before optimising; no cache in v1 beyond the client's 60s affordance view. |
| R-5 | ⚠ **`workspace_member_capabilities` has FOUR readers, not one** (M-7, M-9) — break-glass, `routes/me.ts`, and `catalogue.service.ts`. Repurposing it changes what `GET /api/me` returns to the browser. | `real-data` maps to `realdata.use`, and named tests pin that break-glass **and** the catalogue's `real-data` gate still refuse without it. `GET /api/me`'s `capabilities[]` is superseded by `/me/permissions` and its removal is its own task with its four client consumers named. |
| R-6 | ⚠ **The client has its own `ROLE_CAPS` and it disagrees with the server's** (M-7). Deleting it touches the sidebar, search, two admin panels and `/api/me`'s contract. | `lib/capabilities.ts` is deleted in one task with its consumers; `ui-honesty-check.sh` gains an `absent_code_in` for the module **and** a `present_code_in` control for the single legitimate reader (`getMyPermissions`). The widened session-roles ban does **not** cover this and must not be presented as if it does. |
| R-7 | ⚠ **Nobody holds a grant anywhere** (M-6), so shipping the MVP takes the product away from every non-super-admin. | Accepted, not mitigated — stated in the behaviour-change list, the quickstart's first step and the standards amendment. A pre-flight task prints the member count so the deployer sees it before the guard is mounted, not after. |
| R-8 | The central middleware must resolve `(method, path)` to a map key **before** Express matches the route (D-1). | Splice the guard per handler at boot by walking the router stack, the shape `wrapAsyncRoutes` already uses, with a count floor asserted against the real app. Do not hand-roll a path matcher. |
| R-10 | ⚠ **D-9 gives the platform tier a foothold in every workspace.** A platform administrator can assign themselves `admin` anywhere and reach that tenant's data. | The conferral is **exactly two permissions** (`members.read`, `members.grant`), asserted as a **set equality** rather than a subset — INV-18, with a perturbation that adds a third and turns it red. Reading tenant data therefore needs a prior self-grant, which is a write on the record (FR-033). `rbac:platform-verify` asserts the permitted count is **exactly 2**. The residue is stated, not mitigated: nothing stops the self-grant, only the record of it. |
| R-9 | ⚠ **The route surface moves faster than the spec.** It changed twice in four days while these artefacts were being written, once during the re-baseline itself (M-9). | The map is **generated**, and the generator fails on an unmapped or stale entry — so drift is a failing command rather than a silently wrong document. **Re-run `contracts/README.md`'s procedure immediately before implementation starts**, and treat a non-empty `UNMAPPED` list as a decision to take, not a defect to route around. |
