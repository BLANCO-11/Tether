---
description: "Task list for feature-level RBAC — permission catalogue, custom roles, platform tier"
---

# Tasks: Feature-level RBAC — permission catalogue, custom roles, platform tier

**Input**: Design documents from `/specs/20260910-130448-feature-rbac-permissions/`

⚠ **RE-BASELINED 2026-09-12.** These tasks were written against a 2026-09-10 measurement;
~25 commits landed in between and several tasks named files, migration numbers and handler
counts that had moved. Changed tasks carry a ⚠ note saying what moved. **T003a, T045a,
T047a, T092a–T092d and T100a are new**, and T054 now has a failure mode it did not have.

⚠ **T008a, T008b and T069a were added on 2026-09-13 for spec decision D-9** — platform roles
now confer `members.read` + `members.grant` into every workspace, which they previously did
not, because a platform admin could otherwise create a workspace and put nobody in it.

**Prerequisites**: [plan.md](./plan.md) · [spec.md](./spec.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

**Tests**: Test tasks ARE included and are not optional here. FR-039 makes perturbation
proof an acceptance requirement — *a control with no test that goes red when it is
removed is not delivered* — and Constitution Article II requires tests to ship with the
behaviour, never after.

**Organization**: grouped by user story. Every task names its file. The plan's inventory
labels (A1…F11) appear in each task so the two documents can be read side by side.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no dependency on an incomplete task
- **[Story]**: US1…US6 from [spec.md](./spec.md); Setup/Foundational/Polish carry none

## Path Conventions

Web application, two packages: `packages/server/src/`, `packages/client/src/`. Shell
checks at `scripts/`. Standards at `.specify/memory/`.

---

## Phase 1: Setup

**Purpose**: capture the "before" state, because SC-003 and SC-009 are both *diffs* and
neither is provable without one.

- [x] T001 Capture the pre-change regression baseline to `specs/20260910-130448-feature-rbac-permissions/baseline-pre-change.txt` — run and record verbatim: `pnpm test`, `bash scripts/ui-honesty-check.sh` (PASS/FAIL counts), `pnpm --filter @foundry/server e2e:ui` (MATCH/MISMATCH/GAP/NOTE/FAIL). ⚠ Record failures too — `datasource-target.test.ts` is known flaky and `packages/flow-edit` typecheck has 2 pre-existing errors; a baseline that omits them makes them look like this feature's.
- [x] T002 Capture the pre-change effective-access snapshot for every existing member to `specs/20260910-130448-feature-rbac-permissions/baseline-access.json` — one row per `(workspace_id, subject)` from `workspace_members` and `workspace_member_capabilities`, plus which routes each can reach today. This is the left-hand side of SC-003. ⚠ **On this deployment it will be `{}`** — both tables hold **zero** rows against **eight** workspaces (research M-6). Record the counts in the file, not just the (empty) rows: an empty snapshot and a snapshot nobody took look identical, and only one of them means SC-003 is vacuous.
- [x] T003 Verify migration preconditions. ⚠ **RE-MEASURED — the literal watermark in the original task has moved.** Assert the **relationship**, never the literal: (a) `drizzle.__drizzle_migrations` row count **equals** the `_journal.json` entry count — currently **62 == 62**, so this is *not* the 0033 re-run condition; (b) every new `when` **exceeds** the journal's max, currently **`1789100000000`** (not `1789000000000` — `0061_flow_chat_config` landed after the plan was written). Pinning the literal is what made the original version of this task fail on a healthy database and call it the 0033 condition.
- [x] T003a **[NEW]** ⚠ **Pre-flight: print the membership counts and require them to be read.** `select count(*) from workspace_members`, `workspace_member_capabilities`, `platform_users`, and the count of live workspaces. **Currently 0 / 0 / 2 / 8.** This is behaviour change 6: the day the MVP ships, all eight workspaces refuse every non-super-admin. It is **accepted, not fixed** — but it must be seen before the guard is mounted rather than discovered by the first person who signs in. Record the numbers beside T001's baseline.
- [x] T004 Create the directory `packages/server/src/auth/` with a `README.md` stating that it holds the authorisation policy (catalogue, presets, route map) and why those three live together rather than in `services/`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the catalogue, the resolver, the guard and the storage. **⚠ No user story
work can begin until this phase is complete.**

**⚠ CRITICAL — Phase 2 IS NOT SHIPPABLE AND MUST NOT BE REPORTED AS PROGRESS.** A
catalogue nothing enforces is exactly the state `workspace_member_capabilities` is in
today: correct, well tested, read by one route. That is the shape this feature exists to
end. Progress begins at the Phase 3 checkpoint.

### The catalogue and presets

- [x] T005 [P] **[A1]** Create `packages/server/src/auth/permissions.ts` — the frozen catalogue (**49 entries: 38 workspace + 11 platform**) from [data-model.md](./data-model.md) §1, the `Permission` union type, `isPermission()`, and `PLATFORM_PERMISSIONS`/`WORKSPACE_PERMISSIONS` partitions. INV-1: frozen at module load. ⚠ **Five permissions were added on 2026-09-12** and each closes a wrong assignment: `breakglass.read` (a read was gated on an activation permission), `platform.ops.read`, `platform.toolmodel.read`, `platform.toolmodel.write` (the `llm_complete` tool model is deliberately separate from the generation model — D-115) and `platform.signals.read`.
- [x] T006 [P] **[A2]** Create `packages/server/src/auth/permissions.test.ts` — no duplicate keys, every entry has a label and description, workspace and platform partitions are disjoint and exhaustive, and INV-2 parity between the catalogue and the CHECK constraint text (read from the array, never written down twice — the `FOUNDRY_EMITS` idiom).
- [x] T007 **[A3]** Create `packages/server/src/auth/role-presets.ts` — `author`, `approver`, `admin` as permission sets per [data-model.md](./data-model.md) §2. ⚠ **`approver` gains `flows.arm` and that is a WIDENING, not a carry-forward.** Two `ROLE_CAPS` exist and disagree on exactly this cell (research M-7): the server gives `approver` no `publish`, the client's `lib/capabilities.ts` gives it one, and the preset table agrees with the client. Decided 2026-09-12: **an approver may arm.** FR-006's "reproduce today's roles exactly" is false for this one cell; the code comment must say so rather than let a widening ride inside a preset.
- [x] T008 **[A4]** Create `packages/server/src/auth/role-presets.test.ts` — INV-4 (`admin ⊇ approver ⊇ author` as sets, replacing the deleted `RANK`) and **INV-5**. ⚠ **INV-5 AS ORIGINALLY WRITTEN IS NOT DERIVABLE.** (a) There are two `ROLE_CAPS`; pin against the **server's**, with `flows.arm` on `approver` as the single declared exception, spelled out in the test rather than folded into the expected set. (b) *"the routes that role can reach today"* is degenerate — today every role and every non-member reaches all 106 unguarded routes, so the derived set is the whole catalogue for everybody; drop that half and pin against the 25 guarded routes instead. (c) `baseline-access.json` is `{}` (M-6), so this test cannot read it. ⚠ **Do not describe this test as making SC-003 provable** — with zero members, SC-003 is vacuous on this deployment.

### The resolver

- [x] T008a **[NEW / A11]** ⚠ **[D-9]** Create `packages/server/src/auth/platform-conferral.ts` — `PLATFORM_CONFERS`, which workspace permissions a **platform** permission grants in every workspace. Exactly one key: `platform.members.grant → ["members.read", "members.grant"]`. **Keyed on the permission, never on a role name**, so a custom platform role holding it confers exactly what the built-in one does. This reverses the resolution algorithm's old `(currently: none)` and is what stops a platform admin creating a workspace they cannot put anybody into.
- [x] T008b **[NEW / A12]** ⚠ **[D-9]** Create `packages/server/src/auth/platform-conferral.test.ts` — **INV-18**: the map's image **equals** `{members.read, members.grant}`. ⚠ **As a set, not a subset, and not "does not contain secrets"** — either weaker form passes while somebody adds `flows.read`, and the entire cost of D-9 is bounded by that one number. **INV-12**: `auditor`'s conferred set is empty, computed **through this map**, never by inspecting the role's own permission list — the old form would pass while `platform.audit.read` quietly acquired a conferral.
- [x] T009 **[A7]** Create `packages/server/src/services/effective-permissions.service.ts` — the union resolver from [data-model.md](./data-model.md) "Resolution algorithm", returning permissions **and** provenance in one pass (P-4). One query shape per `(person, workspace)` (P-5).
- [x] T010 **[A8]** Create `packages/server/src/services/effective-permissions.service.test.ts` — P-1 union/order-independence, P-2 empty-means-empty, P-3 super-admin short-circuits **before** the member read (this is what keeps a memberless workspace assignable now that `claim` is deleted), P-4 provenance, and a positive control that a granted person is actually allowed. ⚠ Without the control, "refuse everything" scores 100%. ⚠ **[D-9] Add P-6 / INV-19**: a permission conferred by a platform role carries provenance `{ via: "platform", role }` and **never** `{ via: "preset" }` — FR-020, which had no subject at all before D-9 and is now the thing that lets a screen say *"because they administer the platform"* rather than implying a membership row exists.

### The guard

- [x] T011 **[A9]** Create `packages/server/src/middleware/require-permission.middleware.ts` — `requirePermission(p)`; the refusal envelope from [contracts/api.md](./contracts/api.md) §E; 401 vs 403 distinguishable (FR-022); **500 naming the wiring defect when `:workspaceId` is not in scope, never a pass** (FR-024), matching `requireWorkspaceRole` and `requireProvenanceAuthority`.
- [x] T012 **[A10]** Create `packages/server/src/middleware/require-permission.test.ts` — both refusal kinds, the wiring-defect 500, and that no request field can widen the answer (FR-023).
- [x] T013 **[A5]** Create `packages/server/src/auth/route-permissions.ts` — the map from [contracts/route-permissions.md](./contracts/route-permissions.md) verbatim, ordered to mirror `app.ts`'s mount order, plus `EXEMPT` carrying **a reason string per entry** so an exemption is decided rather than missing (FR-005).
- [x] T014 **[A6]** Create `packages/server/src/auth/route-permissions.test.ts` — walk the mounted Express stack of `createApp()`; every `(method, path)` is in the map or `EXEMPT`; no stale map entries; every permission exists in the catalogue; **plus the FR-003 control**: a synthetic router with one undeclared handler must make the check fail. ⚠ Walk the *stack*, never grep source — research M-5: a regex reports 7 false positives on `local-users.ts`, which is guarded at the router.

### Storage

- [x] T015 **[B1]** Extend `packages/server/src/db/schema.ts` with `workspaceRoles`, `workspaceRolePermissions`, `workspaceRoleAssignments`, `platformRoles`, `platformRoleAssignments`, `platformAuditEvents`. ⚠ **Do not touch `workspaceMembers` or `auditEvents`** — INV-16, and untouched `workspace_members` is what makes FR-028 cheap to prove.
- [x] T016 [P] **[B2]** ⚠ **RENUMBERED — `0061` is taken by `flow_chat_config`.** Create `packages/server/drizzle/0062_workspace_roles.sql` — 3 tables, the partial unique index on `(workspace_id, lower(name)) WHERE retired_at IS NULL`, INV-8's CHECK forbidding `platform.*`.
- [x] T017 [P] **[B3]** Create `packages/server/drizzle/0063_platform_roles.sql` — 2 tables plus the 3 seeded built-in rows (`platform-admin`, `auditor`, `support`) from [data-model.md](./data-model.md) §7.
- [x] T018 [P] **[B4]** Create `packages/server/drizzle/0064_platform_audit.sql` — `platform_audit_events` with its two CHECKs and indexes on `time` and `actor`.
- [x] T019 **[B5]** Create `packages/server/drizzle/0065_capability_rename.sql` — rename the 7 capability values to catalogue names per [data-model.md](./data-model.md) §6; add the CHECK **VALID** after verifying every existing row maps (the 0038 precedent). ⚠ **Fail loudly on an unmapped value** — a NOT VALID constraint would grandfather in exactly the rows it exists to prevent. ⚠ **It operates on ZERO rows here** (M-6): `workspace_member_capabilities` is empty, so a green run proves nothing about the mapping. **Prove the mapping against a fixture**, and say in the migration comment that the live table was empty when it ran.
- [x] T020 **[B6]** Update `packages/server/drizzle/meta/_journal.json` with 4 entries, `when` = `1789200000000`/`1789300000000`/`1789400000000`/`1789500000000`. ⚠ **RENUMBERED** — every value must exceed the **`1789100000000`** watermark verified in T003, which `0061_flow_chat_config` already occupies. The original list started *at* that value.
- [x] T021 [P] **[B7]** Create `packages/server/src/repositories/workspace-role.repo.ts`.
- [x] T022 [P] **[B8]** Create `packages/server/src/repositories/platform-role.repo.ts`.
- [x] T023 [P] **[B9]** Create `packages/server/src/repositories/platform-audit.repo.ts`.

### The audit recorder

- [x] T024 **[C5]** Create `packages/server/src/services/access-audit.service.ts` — record grants, revocations and refusals. Workspace events go to `audit_events` with `operation: "access"` and `entity: "member"|"policy"`; ⚠ **research M-2: no migration is needed for this**, those values are already permitted. Platform events go to `platform_audit_events`.
- [x] T025 **[C6]** Create `packages/server/src/services/access-audit.service.test.ts` — a refusal entry carries person, permission and resource **and no part of the protected resource** (FR-034), with a control that it records anything at all.

**Checkpoint**: catalogue, resolver, guard and storage exist and are tested. **Nothing is
enforced yet and no user-visible behaviour has changed.** Do not report progress here.

---

## Phase 3: User Stories 1 + 2 — a workspace is closed, and access is per feature (Priority: P1) 🎯 MVP

**Goal**: **106** workspace-scoped routes stop being reachable without a grant, and the
grant is per feature rather than per tier.

**Why the two stories ship together**: they share one mechanism. The per-route
declaration US1 needs is the same declaration that makes US2's per-feature granting
expressible; building US1 with a coarse check and retrofitting granularity would mean
declaring every route twice. This is the spec's own reasoning for both being P1.

**Independent Test**: a person with a grant in workspace A and none in B — every
workspace-scoped call against A succeeds, every one against B is refused naming the
missing grant. Remove one permission from an author: exactly one action is refused, all
others still work.

### Mount the guard

- [x] T026 **[D1]** ⚠ **AMENDED — a router-level middleware cannot do this job.** It runs *before* Express matches the sub-route, so `req.route` is empty and it cannot know which handler is about to run; it would have to re-match `req.method` + `req.path` against the map itself, which is re-implementing `path-to-regexp` and route ordering (`GET /generate/jobs` vs `GET /:flowId` is separated by registration order alone). **Instead: splice the guard per handler at boot** by walking the mounted router stack once in `createApp()`, which is the shape `wrapAsyncRoutes` already uses on this codebase — same central map, same set-difference check, no hand-rolled matcher, and it **returns a count** so a walk that spliced nothing fails loudly. ⚠ Whatever the mechanism, **never `app.use("/api", …)`** — that form attaches the guard to every `/api/*` request reaching the line and silently put the Kestra callbacks behind the parent key, after which every flow died at `begin` with no `flow_executions` row (I-65).
- [x] T027 **[A6b]** Extend `packages/server/src/auth/route-permissions.test.ts` with the **mount assertion**: every workspace-scoped route in the live stack actually carries the permission middleware, asserted as a **count floor** against the real app (the `wrapAsyncRoutes` idiom). ⚠ Without this, a complete map plus an unmounted guard passes the completeness check while enforcing nothing — I-38 exactly. ⚠ **Dedupe on `(method, resolved path)`** first: `GET /flows/:flowId/phases` is registered twice (`flows.ts` has the implementation; `flow-phases.ts`'s router is an unreachable placeholder) and `releaseGatesRouter` is mounted twice.

### The route sweep — 106 routes

Each task below verifies the handlers in its file resolve to the intended permission via
the map, and adds a per-handler exception only where [contracts/route-permissions.md](./contracts/route-permissions.md)
names one. Most files change by **zero lines**.

- [x] T028 **[D2]** [US1] [US2] Verify and wire `packages/server/src/routes/flows.ts` — **25 reachable routes** (26 registered; `GET /:flowId/phases` is shadowed by `flow-phases.ts`'s placeholder mount), 23 newly guarded. ⚠ The largest gap: `DELETE /:flowId` and `POST /:flowId/test-run` are open today. Keep `DELETE /:flowId/revisions/:revision` at `flows.approve` (deleting a revision can unmake an approval), not `flows.write`.
- [x] T029 **[D3]** [US1] [US2] Verify and wire `packages/server/src/routes/datasources.ts` — ⚠ **24 handlers, not 23.** `POST /:dsId/queries/propose` was unmapped, and the old map named two paths that do not exist (`POST /operations/check` and `/operations/propose` **without** `/:dsId/`). ⚠ `POST /:dsId/test` is `datasources.write`, not read: it dials the tenant's database with the stored credential.
- [x] T030 [P] **[D4]** [US1] [US2] Verify and wire `packages/server/src/routes/triggers.ts` — 6 in scope. ⚠ `POST /:token/webhook` and `POST /:token/api` stay **exempt**. `POST /:tid/fire` is `flows.run`, not `flows.arm`.
- [x] T031 [P] **[D5]** [US1] [US2] Verify and wire `packages/server/src/routes/workspace-secrets.ts` — 6 handlers. ⚠ `secrets.read` is the NAME list only; INV-3 — no permission returns a value because no endpoint does.
- [x] T032 [P] **[D6]** [US1] [US2] Verify and wire `packages/server/src/routes/flow-templates.ts` — 8 handlers. ⚠ `POST /:id/instantiate` is `flows.write`, not `templates.write` — it creates an automation through `importFlow`.
- [x] T033 [P] **[D7]** [US1] [US2] Verify and wire `packages/server/src/routes/flow-executions.ts` — 6 handlers. `GET /:id/replay` is the plan (read); `POST` executes it.
- [x] T034 [P] **[D8]** [US1] [US2] Verify and wire `packages/server/src/routes/tools.ts` — 6 handlers. ⚠ `POST /probe` is `tools.write` — it dials the endpoint with the stored credential.
- [x] T035 [P] **[D9]** [US1] [US2] Verify and wire `packages/server/src/routes/approvals.ts` — ⚠ **6 handlers, not 5; 3 guarded, 3 new.** `POST /rearm` landed 2026-09-12 (`8e4ab34`), already `approver`-guarded, and was absent from the map entirely — it takes `flows.approve`. ⚠ `POST /recheck` is one of the three that carries **no** guard today **and it can suspend a live flow**. ⚠ `requireProvenanceAuthority()` **stays in addition** on approve (FR-026).
- [x] T036 [P] **[D10]** [US1] [US2] Verify and wire `packages/server/src/routes/flow-chat.ts` — 4 handlers; a turn writes a revision, so it is `flows.write`.
- [x] T037 [P] **[D11]** [US1] [US2] Verify and wire `packages/server/src/routes/catalogue.ts` — 4 handlers, 1 new (`GET /` was open while `GET /items` was guarded).
- [x] T038 [P] **[D12]** [US1] [US2] Verify and wire `packages/server/src/routes/credentials.ts` — 3 handlers.
- [x] T039 [P] **[D13]** [US1] [US2] Verify and wire `packages/server/src/routes/step-approvals.ts` — 3 handlers, 2 new. ⚠ `requireNotRunRequester()` stays in addition.
- [x] T040 [P] **[D14]** [US1] [US2] Verify and wire `packages/server/src/routes/audit-events.ts` and `resources.ts` — 2 handlers each.
- [x] T041 [P] **[D15]** [US1] [US2] Verify and wire `packages/server/src/routes/flow-positions.ts`, `flow-flags.ts`, `flow-phases.ts` — 5 handlers. A drag must still never create a revision.
- [x] T042 [P] **[D16]** [US1] [US2] Verify and wire the single-handler files `packages/server/src/routes/{email-box,bootstrap,next-fires,release-gates}.ts`.
- [x] T043 **[D17/C9]** [US1] [US2] Modify `packages/server/src/routes/search.ts` **and** `packages/server/src/services/search.service.ts` — ⚠ **the one route the map cannot secure alone.** The route has **no `requireIdentity`** and `searchService.index(workspaceId, q)` takes **no viewer at all**, so it must gain both. `search.read` is the floor; the service filters each of the six kinds by the caller's permission for that kind. ⚠ **The kinds are `workflow · step · run · resource · approval · person` — there is no secrets kind and no audit kind**, so the earlier note named the wrong exposures. The real read-arounds are **`flows.read`** (workflow, step), **`runs.read`** (run), **`datasources.read`/`tools.read`** (resource — it is datasources ∪ tools), **`approvals.read`** (approval) and **`members.read`** (person).
- [x] T044 [P] **[C10]** [US1] Modify `packages/server/src/services/search.service.test.ts` — per-kind filtering, with a control that an entitled caller still sees every kind.
- [x] T045 [P] **[D18]** [US1] [US2] Verify the **36** already-guarded handlers in `packages/server/src/routes/{approval-requests,attendance,break-glass,flow-scenarios,incidents,members,pins,step-try}.ts` resolve to permissions equivalent to their current roles. ⚠ No behaviour may change in these — **except `approver` gaining `flows.arm`**, which is declared (T007). ⚠ **SC-003 is vacuous on this deployment** (M-6: zero members), so the equivalence is a code-level argument here, not a measured one.

- [x] T045a **[NEW]** [US1] [US2] ⚠ **`GET /break-glass/active` takes `breakglass.read`, not `breakglass.activate`.** The old map gated a read on an activation permission. `breakglass.read` is in the `admin` preset and nowhere else, so effective access is byte-identical to today's `requireWorkspaceRole("admin")`; only the name changes.

### Rewire the existing role machinery

- [x] T046 **[C7]** [US1] [US2] Modify `packages/server/src/services/workspace-member.service.ts` — `check()` delegates to the resolver; delete `RANK` (ordering becomes set containment, INV-4). ⚠ Keep the last-admin refusal and its measured super-admin exemption exactly as they are.
- [x] T047 **[C8]** [US1] [US2] Modify `packages/server/src/services/workspace-member-capabilities.service.ts` — re-express `CAPABILITIES`/`ROLE_CAPS` over the catalogue; `getCapabilities` delegates to the resolver so there is one computation, not two that can disagree. ⚠ **`approver` gains `flows.arm`** (T007). ⚠ **This service has THREE readers, not the one R-5 names** — `routes/break-glass.ts`, **`routes/me.ts`** (which serves `capabilities[]` to the browser) and **`services/catalogue.service.ts`**. Changing what it returns changes what the sidebar renders.
- [x] T047a **[NEW / C11]** [US1] [US2] Modify `packages/server/src/services/catalogue.service.ts` — its `real-data` gate becomes `realdata.use`. ⚠ **The second undocumented reader of the capability store.** A named test pins that the catalogue still hides real-data items without it, beside break-glass's (T050).
- [x] T048 **[D49]** [US1] [US2] Modify `packages/server/src/middleware/identity.middleware.ts` — re-express `requireWorkspaceRole` over the resolver and **keep it**, so the 36 guarded handlers keep working. ⚠ **Two existing route-tree assertions do NOT keep passing — see T049**. Correct its docblock to describe the permission model.
- [x] T049 **[D50]** Modify `packages/server/src/services/workspace-member.test.ts` — extend the route-tree scan to the permission map. ⚠ **TWO EXISTING ASSERTIONS GO RED AND MUST BE REWRITTEN, NOT KEPT — the original "keep every existing assertion, they still hold" is wrong, and it conflicts with T046 and T069 in this same phase.** (1) `describe("every route that assigns membership or creates a workspace carries requireSuperAdmin")` greps `workspaces.ts` and `members.ts` for the literal string; T069 removes it from `workspaces.ts` entirely and it survives in `members.ts` only as one arm of an OR. Rewrite as "carries the platform permission or the workspace permission", **keeping its existing control**. (2) `it("an admin satisfies every lower role — the ranking is ordered, not a set")` names the mechanism `RANK`, which T046 deletes. The **property** survives under set containment and the test keeps it; the name and the comment must change in the same commit, or the file asserts a mechanism that is gone. ⚠ Every **other** assertion in that file does still hold — the claim-endpoint scan, the member-list gate, the subject-keying test — and those must not be touched.
- [x] T050 **[R-5]** Add named tests pinning that **both** surviving consumers of `real-data` still refuse without `realdata.use`: `packages/server/src/routes/break-glass.test.ts` and the catalogue's real-data gate (T047a). ⚠ **`workspace_member_capabilities` had THREE readers, not the one R-5 names** (research M-7), so a test on break-glass alone leaves the catalogue's gate unproven and `GET /api/me`'s payload unmentioned.

### Backfill and verification

- [x] T051 **[F1]** Create `packages/server/src/scripts/rbac-backfill.ts` — **dry run by default**, `--apply` to write; one line per `(person, workspace)` with `today`, `after`, `diff` against `baseline-access.json`. FR-029. The repo idiom is `slate:plan` before `slate:clear`. ⚠ **It must print the row count it read and must not report success on zero.** On this deployment it reads **0 members and 0 capability rows across 8 workspaces** (M-6), so "0 differences" over 0 people reads exactly like "40 people carried forward perfectly" — the I-38 shape. It exits 0 with *"no members exist on this deployment; nothing to carry forward"*, naming the counts.
- [x] T052 **[F2]** Create `packages/server/src/scripts/rbac-verify.ts` — every one of the **142** workspace-scoped routes × 3 identities (granted, ungranted, allowlist holder) across 2 throwaway workspaces. ⚠ **The positive control is mandatory**: report permitted and refused separately and fail if permitted is zero, or "refuse everything" scores 100%. ⚠ Create and delete its own workspaces — taking `list()[0]` picks up another suite's fixture and deletes it mid-run.
- [x] T053 **[F4]** Modify `packages/server/package.json` — add `rbac:backfill`, `rbac:verify`. ⚠ Not root scripts; they are `pnpm --filter @foundry/server …`.
- [x] T054 Run `pnpm --filter @foundry/server rbac:backfill --dry-run` and record the report. ⚠ **`diff` must be empty for everybody except the THREE known cases**: dropped `admin`/`platform-admin` capability holders; generation-model access; and **approvers gaining `flows.arm`** (T007). A fourth kind of difference is a defect in `role-presets.ts` — fix the presets, do not apply. ⚠ **On this deployment the report is EMPTY, and an empty report is not a clean one.** Record which it is; do not tick this task on a run that had nothing to examine.
- [x] T055 Run `--apply`, then `pnpm --filter @foundry/server rbac:verify`, and confirm SC-001 and SC-002.

**Checkpoint**: 🎯 **MVP complete and shippable.** A workspace is closed to people who
were not given access, and access is granted per feature. Everything below is additive.

---

## Phase 4: User Story 3 — an administrator composes a role for their team (Priority: P2)

**Goal**: named custom roles, authored from the permission catalogue, scoped to one workspace.

**Independent Test**: create a role with two permissions, assign it to a person with no
other grant, confirm they can do exactly those two things, remove one permission and
confirm the action is refused without a sign-out, then retire the role.

- [x] T056 **[C1]** [US3] Create `packages/server/src/services/workspace-role.service.ts` — CRUD enforcing INV-6 (no preset name collision), INV-7 (soft retire, never delete — a deleted role leaves audit entries naming something nobody can look up), INV-8 (no `platform.*`), INV-9 (assignee must already be a member), and FR-009 (cannot grant a permission the granter lacks).
- [x] T057 **[C2]** [US3] Create `packages/server/src/services/workspace-role.service.test.ts` — one test per invariant, each with a positive control.
- [x] T058 **[D32]** [US3] Create `packages/server/src/routes/roles.ts` — the 8 endpoints in [contracts/api.md](./contracts/api.md) §B. ⚠ `.strict()` schemas with **no** `subject` or `permissions` field that could let a caller name their own authority (FR-025), the `approveSchema` rule.
- [x] T059 **[D33]** [US3] Create `packages/server/src/routes/roles.test.ts` — including that `role_exceeds_granter` names the offending permission and **does not list what the caller holds** (FR-021).
- [x] T060 **[D1b]** [US3] Modify `packages/server/src/app.ts` — mount `rolesRouter` at `/api/workspaces/:workspaceId/roles`.
- [x] T061 [P] **[C5b]** [US3] Wire grant/revoke/role-change recording through `accessAuditService` from `workspace-role.service.ts` (FR-033).

**Checkpoint**: custom roles work end to end and every change is on the record.

---

## Phase 5: User Story 4 — the deployment has roles above the workspace (Priority: P2)

**Goal**: a real platform tier, replacing "admin in any workspace" and the
allowlist-as-only-authority.

**Independent Test**: assign `auditor` and nothing else — audit history readable in every
workspace, every workspace data read, write and membership change refused.

- [x] T062 **[C3]** [US4] Create `packages/server/src/services/platform-role.service.ts` — INV-12 (auditor's **conferred** set is empty — the subject moved with D-9), INV-13 (no path from a row to `config.isSuperAdmin`), INV-14 (last platform admin removable only by an allowlist holder), INV-15 (built-ins immutable), ⚠ **INV-20 [D-9]**: the last-**workspace**-admin refusal's exemption does **not** extend to the platform tier. `config.isSuperAdmin` keeps it alone — the measured incident that created it was a super admin making an irreversible mis-assignment with nobody above them; a platform admin always has an allowlist holder above them, so the refusal is recoverable and stays.
- [x] T063 **[C4]** [US4] Create `packages/server/src/services/platform-role.service.test.ts` — ⚠ assert INV-12's empty **conferral** **directly**, not by inferring it from refusals; a refusal can also come from a bug.
- [x] T064 **[D42]** [US4] Create `packages/server/src/middleware/platform-permission.middleware.ts` — `requirePlatformPermission()` with the two distinguishable refusals (FR-022), the fork `requireSuperAdmin` already makes.
- [x] T065 [P] **[D43]** [US4] Create `packages/server/src/middleware/platform-permission.test.ts`.
- [x] T066 **[D34]** [US4] Create `packages/server/src/routes/platform-roles.ts` — [contracts/api.md](./contracts/api.md) §C, including `GET /platform/audit` as the union of both records in one time order (INV-17).
- [x] T067 [P] **[D35]** [US4] Create `packages/server/src/routes/platform-roles.test.ts`.
- [x] T068 **[D36]** [US4] Create `packages/server/src/routes/permissions.ts` — `GET /api/permissions/catalogue`.
- [x] T069 **[D39]** [US4] Modify `packages/server/src/routes/workspaces.ts` — **FR-015 filtering** on `GET /`; `flows.read` on `GET /:id` and `/:id/manifest`; `requireSuperAdmin` → `platform.workspaces.write` on create/rename/delete. ⚠ **These two reads name the workspace `:id`, not `:workspaceId`** — the guard takes the parameter name explicitly (see T011). ⚠ **This turns an existing test red**: `workspace-member.test.ts` greps this file for the literal `requireSuperAdmin` — rewritten in T049, and the two must land together.
- [x] T070 **[D40 + D41]** [US4] Modify `packages/server/src/routes/generation-provider.ts` to use `requirePlatformPermission("platform.generation.write")`, then **delete** `packages/server/src/middleware/deployment-admin.middleware.ts` and its test. ⚠ Deleting is the point — leaving it importable leaves two answers to "who may change a deployment setting", and the weaker one takes no argument.
- [x] T071 [P] **[D44]** [US4] Modify `packages/server/src/routes/local-users.ts` — ⚠ **9 handlers, not 7** (research M-5). Six local-account handlers → `platform.localusers.write`. ⚠ **Three are workspace-membership access and must NOT take that permission**: `GET /:id/access` → `platform.users.read`, and `PUT|DELETE /:id/access/:workspaceId` → **`platform.members.grant`**. They write `workspace_members`; a third permission that grants workspace access is the duplication D-6 deletes `requireDeploymentAdmin` to avoid. ⚠ These two are also the counter-example to FR-024 — a **deployment-level** route carrying a `:workspaceId` — so the guard must take the parameter name explicitly and never infer scope from its presence. `localAuthRouter` is untouched and stays exempt.
- [x] T072 [P] **[D45]** [US4] Modify `packages/server/src/routes/platform.ts` — `platform.users.read`.
- [x] T073 [P] **[D46]** [US4] Modify `packages/server/src/routes/ops-proxy.ts` — ⚠ **NOT one permission for all ten.** The six outbox and status reads take `platform.ops.read`; the **four `llm_complete` tool-model handlers** (`GET|PUT|DELETE /llm/provider`, `POST /llm/models`, `POST /llm/test`) take `platform.toolmodel.read`/`platform.toolmodel.write`. D-115 keeps the tool model and the generation model deliberately separate — it has confused a user twice — and one permission would merge them at the authorisation layer.
- [x] T074 **[D47]** [US4] Modify `packages/server/src/routes/signals.ts` — ⚠ **`platform.signals.read`, not `platform.audit.read`.** Signals answers *"is the system still doing its job"*, not audit history, and its own docblock says it is deliberately off the open health router for a different reason. ⚠ **Keep `pnpm signals` working**: the CLI must present an allowlisted identity, or the scheduler that reads its 0/1/2 exit code breaks.
- [x] T075 [P] **[D48]** [US4] Modify `packages/server/src/routes/engine-plugins.ts` — add `requireIdentity`.
- [x] T076 **[D37]** [US4] Modify `packages/server/src/routes/me.ts` — add `platformRoles` and `platformPermissions`. ⚠ Existing keys keep their meaning and position.
- [x] T077 **[D1c]** [US4] Modify `packages/server/src/app.ts` — mount `platformRolesRouter` and `permissionsRouter`.
- [x] T078 **[F3]** [US4] Create `packages/server/src/scripts/rbac-platform-verify.ts` and add `rbac:platform-verify` to `packages/server/package.json` — **SC-010 and SC-015**. Three identities: `auditor` (reads audit everywhere, refused every workspace route, **sees zero workspaces**), `support` (same, plus the ops and signals reads), and ⚠ **`platform-admin` who is a member of nothing — permitted EXACTLY 2 workspace-scoped routes** (`GET /members`, `POST|DELETE /members`) and refused every other one. ⚠ **Exactly 2, not "at least 2"**: a floor passes while the conferral silently widens, and the number two is the entire bound on D-9.
- [x] T069a **[NEW]** [US4] ⚠ **[D-9]** Modify `GET /api/workspaces`'s filter (T069) to admit a caller holding **any** workspace permission there, conferral included — so a `platform-admin` sees all 8 and an `auditor` sees **none**. ⚠ An auditor seeing zero workspaces is correct, not a bug: they read across tenants through `GET /api/platform/audit`, and showing them the list would be tenant metadata they hold no permission for. A named test asserts both directions.

**Checkpoint**: the platform tier exists; `requireDeploymentAdmin` is gone.

---

## Phase 6: User Story 5 — the screen shows what you can do, honestly (Priority: P3)

**Goal**: affordances that match the server's answer, and a third state for when the
check itself could not run.

**Independent Test**: as a narrowly-granted person, every unavailable control is absent
or disabled with a reason; with the API stopped, the page says the check did not run.

- [x] T079 **[D38]** [US5] Modify `packages/server/src/routes/attendance.ts` — add `GET /me/permissions` on the existing `/workspaces/:ws/me` mount. ⚠ `requireIdentity` only, **no permission required** — needing access to discover you have none is a bootstrap nobody can escape.
- [x] T080 [P] **[E1]** [US5] Modify `packages/client/src/lib/foundry-client.ts` — the 14 methods in [contracts/api.md](./contracts/api.md) §F. No access logic in this file.
- [x] T081 [P] **[E2]** [US5] Modify `packages/client/src/lib/types.ts` — `Permission`, `WorkspaceRole`, `PlatformRole`, `MyPermissions`.
- [x] T082 **[E3]** [US5] Create `packages/client/src/lib/permissions.tsx` — provider and `usePermissions()`. **Three states: allowed, denied, unreadable.** 60s bound (SC-005). ⚠ Never read the sign-in session.
- [x] T083 [P] **[E4]** [US5] Create `packages/client/src/lib/permissions.test.tsx` — the unreadable state renders as **neither** answer (FR-032), the `PromptBoundaryWarnings` rule.
- [x] T084 [P] **[E5/E6]** [US5] Create `packages/client/src/components/access/Can.tsx` and `PermissionGate.tsx` — gate on a server answer; disabled controls name the missing permission and who can grant it.
- [x] T085 [P] **[E7]** [US5] Create `packages/client/src/components/access/RoleEditor.tsx` — catalogue-driven role authoring.
- [x] T086 [P] **[E8]** [US5] Create `packages/client/src/components/access/{Can,PermissionGate,RoleEditor}.test.tsx` — three render tests each, including the unreadable state.
- [ ] T087 **[E9/E10/E11]** [US5] Modify `packages/client/src/lib/workspace.tsx`, `lib/workspace-choice.ts`, `lib/workspace-resolve.test.ts` — the filtered list; the no-grants explaining state; and the active workspace **disappearing** when a grant is revoked mid-session, which must not error. ⚠ **`listWorkspaces` has SIX consumers, not two**: `shell/Topbar.tsx`, `lib/workspace.tsx`, `data-sources/page.tsx`, `data-sources/[id]/page.tsx`, `admin/incidents/page.tsx` and `workspace/LocalAccountAccess.tsx` — the last is the **super-admin grant form** and must keep seeing every workspace, which the super-admin short-circuit (P-3) already gives it. Check each.
- [x] T088 [P] **[E19/E20]** [US5] Create `packages/client/src/app/(app)/no-access/page.tsx` and its test — FR-016 / SC-013: names who can grant access, never an empty picker.
- [ ] T089 **[E12/E13/E14]** [US5] Modify `packages/client/src/components/shell/Sidebar.tsx`, `Topbar.tsx`, `Sidebar.test.tsx` — nav rows by permission; switcher over the filtered list. ⚠ **An empty group must not render its heading** (the 2026-08-21 fix) — filter per group, assert both directions, or a one-sided test passes against a rail that renders nothing.
- [x] T090 [P] **[E15/E16]** [US5] Modify `packages/client/src/app/(app)/organization/page.tsx` and its test. ⚠ Keep all four existing states, including "could not be checked".
- [x] T091 [P] **[E17/E18]** [US5] Create `packages/client/src/app/(app)/organization/roles/page.tsx` and its test.
- [ ] T092 **[E21–E33]** [US5] Add affordance gating to the pages under `packages/client/src/app/(app)/`. ⚠ **THERE ARE 36 PAGES, NOT 15**, and one the original list names (`runs`) has no `page.tsx` at all. The original fifteen: `dashboard` `flows` `data-sources` `tools` `keys` `triggers` `resources` `approvals` `history` `live` `incidents` `email-box` `admin` `ai-provider` `organization`. **The twenty-one it missed**: `admin/audit` `admin/break-glass` `admin/downtime` `admin/gates` `admin/incidents` `admin/members` `admin/policies` `apps` `approvals/[id]` `data-sources/[id]` `data-sources/new` `flows/[id]` `flows/[id]/builder` `flows/[id]/publish` `flows/new` `incidents/break-glass` `resources/[id]` `resources/[id]/impact` `resources/new` `runs/[id]` `runs/[id]/recover`. ⚠ The whole `admin/*` tree is in the missed set, which is where the most privileged controls live. ⚠ **`resources/[id]` needs `datasources.read`, not `resources.read`** — since `050650d` it renders the schema tree and the DB-operations panel by calling the datasources endpoints, so its nav entry and its data requirements now disagree. ⚠ Hiding is **never** the enforcement — the server refuses regardless.
- [x] T092a **[NEW / E35]** [US5] **Delete `packages/client/src/lib/capabilities.ts`.** ⚠ **It is the client's own `ROLE_CAPS`, and it disagrees with the server's on `approver`** (research M-7). A second authority deciding access questions, which FR-031 forbids — and which the widened session-roles ban (T100) will **not** catch, because it reads a server answer and then applies its own policy rather than reading `session.user.roles`. `CAP_LABEL` survives as labels only, moved beside `RoleEditor`.
- [x] T092b **[NEW / E36]** [US5] Modify `packages/client/src/components/shell/Sidebar.tsx` — remove the `me.data?.capabilities?.includes("admin")` gate (line ~379) and gate on `usePermissions()`. Separate from T089 because it is the **deletion of an existing decision**, not the addition of a new one.
- [x] T092c **[NEW / E37]** [US5] Modify `packages/client/src/lib/search.ts` — delete `filterByCapabilities()`. Filtering moves to the server (T043). A client filter over a server list that was never filtered is decoration, and keeping both is two answers to one question.
- [x] T092d **[NEW / E38+E39]** [US5] Move `components/admin/MembersPanel.tsx` and `components/workspace/LocalAccountAccess.tsx` onto `GET /api/permissions/catalogue`, **then** remove `capabilities[]` from `packages/server/src/routes/me.ts`. ⚠ **Order matters**: the server key must go *after* its four consumers move, or the sidebar loses its gate before it gains the new one.
- [x] T093 **[E34]** [US5] Modify `packages/client/src/app/routes.smoke.test.tsx` — cover `no-access` and `organization/roles`. ⚠ `ui-honesty-check.sh` derives the page count by walking the filesystem, so it follows on its own.

**Checkpoint**: the UI matches the server and admits when it does not know.

---

## Phase 7: User Story 6 — every grant, revocation and refusal is on the record (Priority: P3)

**Goal**: complete the audit — denial recording with a bound, and the cross-tier reader.

**Independent Test**: grant, override, revoke both, attempt one forbidden action; all
five appear with actor, subject, before, after, time — and no protected data.

- [x] T094 **[C5c]** [US6] Extend `packages/server/src/services/access-audit.service.ts` with denial recording and the bounded dedupe on `(subject, permission, workspaceId)` — first refusal written immediately, repeats counted and flushed on window close (research D-3). ⚠ A restart loses a *count*, never the fact.
- [x] T095 [P] **[C6b]** [US6] Extend `packages/server/src/services/access-audit.service.test.ts` — 500 identical refusals produce one entry with a count, not 500 (FR-034).
- [x] T096 **[A9b]** [US6] Wire denial recording into `packages/server/src/middleware/require-permission.middleware.ts` and `platform-permission.middleware.ts`. ⚠ **This is the I-120 shape** — a detector computed and discarded. A test must read the middleware off disk and require the recorder call, with a control that the scan can find anything.
- [x] T097 [P] **[D34b]** [US6] Verify `GET /api/platform/audit` unions both records in one time order (INV-17) — two stores is a storage decision, never reader-visible.
- [x] T098 [P] **[E35]** [US6] Add an access-history view to `packages/client/src/app/(app)/admin/audit/page.tsx` — grants, revocations and refusals, filterable by person and permission (FR-038).
- [x] T099 **[SC-014]** [US6] Assert `audit_events` is structurally untouched — compare a saved pre-change response from the workspace audit view against the post-change one; identical rows in identical order.

**Checkpoint**: all six user stories delivered.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [x] T100 **[F5]** Modify `scripts/ui-honesty-check.sh` — widen the session-roles ban from `app/(app)/organization` to `app/` and `components/`, **keeping `superadmin` in the pattern** (the local account still puts it on the session). ⚠ **It is at line 2175, not 2083** — the file is 2299 lines; cite the assertion text, not the line. ⚠ Add a `present_code_in` positive control asserting the one legitimate reader (`getMyPermissions`) exists — a widened pattern with no control is how a check gets weakened until it permits the defect (I-62). Add assertions for the three-state gate and the no-access page.
- [x] T100a **[NEW]** ⚠ **The widened session-roles ban does NOT cover the real defect, and must not be presented as if it does.** Add a **second** `absent_code_in` across `app/` and `components/` for `lib/capabilities` / `ROLE_CAPS` / `CAP_NAV` / `CAP_CONTROLS` / `filterByCapabilities`, landing with T092a–T092d. None of that code reads `session.user.roles`; it reads a *server* answer and applies a *client* policy, which is a second authority wearing a permitted shape. Give it its own `present_code_in` control.
- [x] T101 **[F6]** Modify `packages/server/src/kestra/e2e-ui-journey.ts` — present an identity from `SUPER_ADMIN_EMAILS` for the now-filtered workspace list (risk R-2), matching what it already does for its membership step. ⚠ **It is not only the list step**: the journey exercises workspace-scoped routes throughout, and with zero members (M-6) **every one of them refuses without an allowlisted identity**. Expect the change to be broader than one step. ⚠ With the variable unset, record a **NOTE naming it, not a MISMATCH** — a harness reporting its own environment as a product defect is worse than no assertion.
- [x] T102 Run the full regression net and diff against `baseline-pre-change.txt` (T001): `demo:verify`, `finance:verify`, `legal:verify`, `kestra:phase3`, `scenarios:verify`, `e2e:ui`, `ui-honesty-check.sh`, `pnpm test`. ⚠ SC-009. On macOS the `kestra:*` harnesses need `./scripts/harness-in-net.sh`.
- [x] T103 Execute the **15** perturbations in [quickstart.md](./quickstart.md) step 8 one at a time and record which test turned red for each. ⚠ Three were added on 2026-09-12 (re-introduce `lib/capabilities.ts`; give `approver` no `flows.arm`; return every search kind to an unentitled caller) and **two on 2026-09-13 for D-9** (add a third permission to `PLATFORM_CONFERS`; give `auditor` a conferral). ⚠ SC-008 is *controls == tests proven red*. A control whose perturbation turns nothing red is **not delivered** — that is the one gap this repo has repeatedly found by perturbing rather than reading.
- [x] T104 **[F7/F8]** Amend `.specify/memory/security.md` §2 via `/speckit-update-standards`, and append to `.specify/memory/standards-history.md`. ⚠ **EIGHT behaviour changes, not three** (plan's list): 106 routes closed · the workspace list filtered · **widening** — workspace admins may now grant members (super admin **OR** `members.grant`, resolved from an AND/OR contradiction between two artefacts) · **narrowing** — the generation model needs an explicit platform grant · **widening** — an `approver` gains `flows.arm` · **on this deployment every workspace becomes unusable to every non-super-admin**, accepted and stated rather than fixed · the client stops deciding access questions · ⚠ **widening** — a platform administrator can see and change **every** workspace's member list (D-9), and can therefore assign themselves `admin` anywhere and reach that tenant's data. Record the bound with it: the conferral is **exactly two permissions**, so reading tenant data needs a prior self-grant that lands in the audit record. ⚠ **The sentence to use is *"a platform administrator cannot see a tenant's data, but can give themselves the ability to, and doing so leaves an audit entry naming them"*** — never the unqualified *"a platform admin cannot access tenant data"*. Must keep the "never separation of duties" wording.
- [x] T105 **[F9]** Modify `CLAUDE.md` — new section for this feature. ⚠ Correct the "22 of 43 route files" figure to the **mounted-route** numbers — **196 total: 142 workspace-scoped (36 guarded, 106 added), 38 deployment-level, 16 exempt** — because the file-level count understated the gap 6× and the file count itself was 44, not 43.
- [x] T106 **[F10]** ⚠ **The file MOVED.** Modify **`archive/GAPS.md`**, not `docs/GAPS.md` — the docs record was consolidated to `archive/` on 2026-09-11 (`fb5eac7`), the old path no longer exists, and source docblocks already cite `archive/GAPS.md §1.1`. ⚠ **§1.1 is already marked *"CLOSED 2026-08-03 for the role half"***, so this **extends** that entry with the enforcement half rather than closing it again. Note what closed *narrower* than the entry implied — and it did: with zero members on this deployment, the closure is structural and unmeasured.
- [x] T107 [P] **[F11]** Modify `.env.example` — ⚠ **it already documents `SUPER_ADMIN_EMAILS` at length** (lines ~223–229), including that it is not separation of duties. This is close to a no-op: add only the new fact, that with the 106 routes closed it is the **only** way into a workspace with no members. ⚠ Name only, never a value (Article VIII).
- [ ] T108 Run `/speckit-comply` and resolve every CRITICAL finding before requesting review (Article III).

---

## Dependencies & Execution Order

```
Phase 1 Setup (T001–T004)
    ↓
Phase 2 Foundational (T005–T025)   ⚠ BLOCKING · NOT SHIPPABLE · NOT PROGRESS
    ↓
Phase 3 US1+US2 (T026–T055)        🎯 MVP — shippable
    ↓
    ├─→ Phase 4 US3 custom roles (T056–T061)      ─┐
    ├─→ Phase 5 US4 platform tier (T062–T078)     ─┤ independent of each other
    ├─→ Phase 6 US5 UI (T079–T093)                ─┤ after the MVP
    └─→ Phase 7 US6 audit (T094–T099)             ─┘
    ↓
Phase 8 Polish (T100–T108)
```

**Cross-phase notes**

- Phase 6 (UI) reads endpoints from Phases 4 and 5. It can start against the MVP's
  `/me/permissions` alone; T091 (the roles page) needs Phase 4, T090's platform half
  needs Phase 5.
- Phase 7's recorder (T024/T025) is built in Foundational so Phases 4 and 5 audit their
  grants as they are written rather than having it retrofitted. Phase 7 adds denials,
  the bound and the reader.
- T054 gates T055. **Do not apply the backfill until its dry run is read.**

## Parallel Opportunities

- **Phase 2**: T005+T006 ∥ T016+T017+T018 ∥ T021+T022+T023 — catalogue, migrations and
  repositories touch no shared file.
- **Phase 3**: T030–T042 and T044–T045 are 14 independent route files. T028 and T029
  (`flows.ts`, `datasources.ts`) are the two large ones and are **not** marked `[P]` —
  they carry 49 of the 106 routes between them and want undivided attention.
- **Phase 5**: T071–T075 are five independent route files.
- **Phase 6**: T080+T081, T083–T086, T088, T090+T091 are independent.

## Implementation Strategy

**Ship the MVP first.** Phases 1–3 close the security gap and deliver both P1 stories.
That is a complete, defensible increment: a workspace is closed, and access is per
feature.

**Then add capability in any order.** Custom roles, the platform tier, the UI and the
audit reader are independent of one another.

⚠ **Do not report Phase 2 as progress.** It produces a correct, well-tested permission
catalogue that nothing enforces — precisely the state `workspace_member_capabilities` is
in today, and precisely what this feature exists to end.
