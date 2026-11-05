---
description: "Implementation session log — read this FIRST when resuming RBAC work in a new session"
---

# Session notes — feature-level RBAC implementation

⚠ **THIS FILE IS THE RESUME POINT.** If a session ended, a context window filled, or a
different account picked the work up, read this file before reading anything else. It
records what is done, what is in flight, what was decided and what has already been
learned the hard way. It is appended to at the end of every phase and whenever a
non-obvious decision is taken.

## How to resume in one minute

```bash
cd /home/mayank/foundry_beta/foundry
git branch --show-current          # expect: 20260910-130448-feature-rbac-permissions
git log --oneline -15              # one commit per phase; the last one names the phase
cat specs/20260910-130448-feature-rbac-permissions/SESSION-NOTES.md   # this file
```

Then open [tasks.md](./tasks.md) and find the first unticked `- [ ]` task. The **Phase
status** table below is authoritative over the checkboxes if the two ever disagree —
the checkboxes are ticked as work lands, the table is written deliberately.

## ⚠ WHERE TO PICK UP — all eight phases are DONE; four tasks remain

**115 of 119 tasks complete.** The feature is implemented, enforced and measured. What is
left is deliberately-scoped UI breadth plus one command:

| Task | What | Why it is left |
| :--- | :--- | :--- |
| **T092** | Affordance gating on the remaining client pages | The primitives exist (`Can`, `useCan`, `PermissionGate`) and are used on the surfaces Phase 6 touched. The rest rely on the server refusing — correct, but not the same as an affordance that matches. ⚠ **34 pages, not 36.** |
| **T087** | Audit the six `listWorkspaces` consumers individually | The shell-level redirect is in and the list is server-filtered. |
| **T089** | The Topbar's switcher explaining state | The list it reads is already filtered; it has no explaining state of its own. |
| **T108** | `/speckit-comply` | Needs the spec-kit command. |

⚠ **Nothing security-relevant is outstanding.** Every route is guarded, every guard is
mounted, and both verifiers pass. T092 is about what a person is *offered*, never about
what they are *allowed* — hiding is never the enforcement.

**Before touching anything**: re-run the route map generator
([contracts/README.md](./contracts/README.md)). The surface moved three times during this
feature; `route-permissions.test.ts` will go red if the map and the stack disagree.

**Read order for a cold start**: this file → [plan.md](./plan.md) → [tasks.md](./tasks.md)
→ [data-model.md](./data-model.md) (the catalogue, presets and resolution algorithm) →
[contracts/route-permissions.md](./contracts/route-permissions.md) (the generated map).

## Ground rules held throughout

- **Branch**: `20260910-130448-feature-rbac-permissions`. Created 2026-09-12 off
  `fix/resource-detail-schema-and-operations` at `6ff72f8`. Constitution Article I wants
  the branch named for the feature directory; it is.
- **One commit per phase**, message `rbac(phase N): <what>`. A phase that had to be split
  says so in the table below.
- **Tests ship with behaviour, never after** (Constitution Article II). Every control gets
  a perturbation — remove the control, watch a named test go red. FR-039 makes that an
  acceptance requirement, and T103 collects all 15 at the end.
- **Do not report Phase 2 as progress.** It produces a catalogue nothing enforces, which
  is exactly the state `workspace_member_capabilities` is in today and exactly what this
  feature exists to end. Progress starts at the Phase 3 checkpoint.
- **Re-run the route map generator before writing `route-permissions.ts`** — see
  [contracts/README.md](./contracts/README.md). The surface moved twice in four days
  (research M-9); the hand-written version was wrong three times.

## Phase status

| Phase | Tasks | Status | Commit |
| :--- | :--- | :--- | :--- |
| 1 Setup | T001–T004 | **DONE** 2026-09-12 | see log |
| 2 Foundational ⚠ not shippable | T005–T025 | **DONE** 2026-09-13 | see log |
| 3 US1+US2 🎯 MVP | T026–T055 | **DONE** 2026-09-13 — SC-001/SC-002 at 142/142 | see log |
| 4 US3 custom roles | T056–T061 | **DONE** 2026-09-13 | see log |
| 5 US4 platform tier | T062–T078 | **DONE** 2026-09-13 — SC-010/SC-015 hold | see log |
| 6 US5 UI | T079–T093 | **MOSTLY DONE** 2026-09-13 — T087/T089/T092 open | see log |
| 7 US6 audit | T094–T099 | **DONE** 2026-09-13 | see log |
| 8 Polish | T100–T108 | **DONE** 2026-09-13 except T108 | see log |

## Decisions already taken — do not re-litigate

These were settled with the user during the spec audit (2026-09-12/13) and are recorded
in [spec.md](./spec.md). They are listed here because each one is a place where the
obvious implementation is the wrong one.

| # | Decision | Consequence in code |
| :--- | :--- | :--- |
| **D-4** | An **approver may arm**. | `role-presets.ts` gives `approver` `flows.arm`. This is a **widening**, not a carry-forward — the server's `ROLE_CAPS` gives `approver` no `publish` and the client's disagrees. The comment must say so. |
| **D-5** | The zero-member state is **accepted**, not fixed. | Day one, all 8 workspaces refuse every non-super-admin. `SUPER_ADMIN_EMAILS` is the only way in. Stated in four places rather than discovered. |
| **D-6** | The browser stops deciding access questions. | `packages/client/src/lib/capabilities.ts` is **deleted** (T092a), not re-pointed. |
| **D-7** | `runs.replay` belongs to **approver**. | It was assigned to nobody in the first draft of the presets. |
| **D-8** | Sensitive reads move to **admin**; `author` gets 13 of 16 reads. | `secrets.read`, `audit.read`, `budget.read` are admin-only. |
| **D-9** | A **platform** permission confers workspace permissions. | `PLATFORM_CONFERS` in `auth/platform-conferral.ts`, keyed on the **permission** never the role name. Exactly one entry: `platform.members.grant → {members.read, members.grant}`. |

### The D-9 bound, and the sentence to use

The conferral is **exactly two permissions**. INV-18 asserts the map's image **equals**
`{members.read, members.grant}` — **set equality, not a subset**, because a subset
assertion passes while somebody adds `flows.read` and that one number is the entire bound.

> **A platform administrator cannot see a tenant's data, but can give themselves the
> ability to, and doing so leaves an audit entry naming them.**

Never the unqualified *"a platform admin cannot access tenant data"* — it is false.

## Measured facts about this deployment

Re-measure rather than quote; CLAUDE.md has been wrong about this twice. As of 2026-09-12:

| | |
| :--- | :--- |
| Mounted routes | **196** — 142 workspace-scoped, 38 deployment-level, 16 exempt |
| Guarded today | **36** of 142. The other **106** are the gap this feature closes. |
| `workspace_members` rows | **0** |
| `workspace_member_capabilities` rows | **0** |
| `platform_users` rows | **7** ⚠ (spec said 2 — 5 are test debris) |
| Live workspaces | **8** |
| Migrations | **62 applied == 62 journal entries**; watermark `1789100000000` |

⚠ **Zero members makes SC-003 vacuous.** "Nobody's access changed" is trivially true when
nobody has any. Every task that leans on a before/after diff says so; do not tick one on
a run that had nothing to examine.

## Traps already hit — do not rediscover these

- **`app.use("/api", guard)` is forbidden.** It attaches to every `/api/*` request reaching
  the line and silently puts the Kestra callbacks behind the parent key — after which every
  flow dies at `begin` with no `flow_executions` row (I-65). The guard is spliced **per
  handler at boot** by walking the router stack, the shape `wrapAsyncRoutes` already uses.
- **A router-level middleware cannot do this job.** It runs before Express matches the
  sub-route, so `req.route` is empty; it would have to re-implement `path-to-regexp` and
  route ordering (`GET /generate/jobs` vs `GET /:flowId` are separated by registration
  order alone).
- **Walk the stack, never grep source.** A regex reports 7 false positives on
  `local-users.ts`, which is guarded at the router (research M-5).
- **Dedupe on `(method, resolved path)`.** `GET /flows/:flowId/phases` is registered twice
  and `releaseGatesRouter` is mounted twice.
- **Migration `when` must exceed `1789100000000`.** Assert the *relationship*, never a
  literal — pinning the literal is what made T003's first version fail on a healthy
  database and misdiagnose it as the 0033 re-run condition.
- **A count floor without a positive control proves nothing.** "Refuse everything" scores
  100% on every refusal test. Every verifier reports permitted and refused separately and
  fails when permitted is zero.

## Work log

Appended as work lands. Newest last.

### 2026-09-12 — session 1

- Created branch `20260910-130448-feature-rbac-permissions` off `6ff72f8`.
- Created this file.
- **Phase 1 complete — T001, T002, T003, T003a, T004.**
  - Baseline in [baseline-pre-change.txt](./baseline-pre-change.txt), access snapshot in
    [baseline-access.json](./baseline-access.json), `packages/server/src/auth/README.md` created.
  - **Baseline is NOT green, and that is recorded rather than fixed.** 5 server tests,
    3 client tests and 1 e2e hard failure are red *before* this feature. Four of the five
    server failures and the e2e failure share one root cause — step properties (`elseOf`,
    `failureMode`) stripped by the storage schema, so `branch` steps are partly broken on
    this branch. **Not ours.** A *sixth* server failure later is ours.
  - `ui-honesty-check.sh` is **229 PASS / 0 FAIL**. ⚠ CLAUDE.md says "212 PASS / 12 FAIL" —
    stale. Diff against 229.
  - `e2e:ui` is **66 MATCH · 1 MISMATCH · 0 GAP · 4 NOTE · 1 FAIL**.
  - Migration preconditions hold: **62 applied == 62 journal**, watermark
    `1789100000000`. Not the 0033 condition. T016–T020's `when` values all exceed it.

#### Corrections to the spec found while measuring — apply these, do not re-derive them

1. **T092 says 36 client pages. There are 34.** `admin/downtime` and `admin/policies` do
   **not** exist; they survive only in stale `.next/types`, which is also the entire
   content of the client's "4 typecheck errors". The real 34 are listed in
   `baseline-pre-change.txt` §4.
2. **`platform_users` is 7, not 2**, and 5 are test debris (`test-sub-123/456/789`,
   `ordinary@example.com`, `super@example.com`). The two real subjects are
   `mayank.lohani@microland.com` (Entra OID `51d5d879-…`) and `local-admin`.
3. **`workspaces` count MOVES while the test suite runs** — read 10 mid-run, 8 idle.
   `datasource-target.test.ts` creates and deletes throwaway workspaces. Measure idle.
4. **`grep` silently reports nothing on the test-output files** — vitest writes NUL bytes,
   grep treats the file as binary and skips it with exit 0. Use `grep -a`. This is the
   same class CLAUDE.md already warns about for `ci/secret-policy.sh`, and it reads
   exactly like "no matches".
5. **`pnpm -r test` stops at the first failing package**, so the client suite does not run
   in the same invocation as the server's. Run it with `--filter @foundry/client`.

### 2026-09-12 — Phase 2, part 1: the catalogue and the storage

**Done: T005 T006 T007 T008 T008a T008b T015 T016 T017 T018 T019 T020.**
**Still open in Phase 2: T009–T014 (resolver, guard, route map), T021–T025 (repos, audit).**

- `src/auth/permissions.ts` — 49 entries, **38 workspace + 11 platform**, frozen, with
  `isPermission` / `isWorkspacePermission` / `isPlatformPermission` and
  **`permissionCheckSql(column, tier)`**, which GENERATES the SQL CHECK body.
- `src/auth/role-presets.ts` — 19 / 23 / 38, **built by union rather than transcribed**, so
  INV-4's containment is true by construction. `DECLARED_WIDENINGS` exports the one
  exception (`approver` + `flows.arm`) so the test can spell it out instead of folding it
  into an expected set.
- `src/auth/platform-conferral.ts` — `PLATFORM_CONFERS`, one key, `CONFERRABLE`, and
  `conferredByPlatform()`. INV-12 is asserted **through that function**, never by
  inspecting a role's own list.
- Migrations **0062–0065** applied. Database now **66 migrations == 66 journal entries**,
  watermark `1789500000000`. Six new tables; three built-in platform roles seeded
  (`platform-admin` 11 perms, `support` 4, `auditor` 1).

#### Two things proven rather than assumed

1. **The INV-2 parity control fires.** Typo `'gates.read'` → `'gates.reed'` in 0062 and
   `permissions.test.ts` goes red naming `gates.reed` as *unknown in the file*. Restored,
   green. (Perturbation 1 of T103's fifteen.)
2. **INV-8 and INV-2 are enforced by POSTGRES, with a positive control.** Against the live
   database: `platform.members.grant` into `workspace_role_permissions` → refused;
   `flows.superuser` → refused; **`flows.read` → accepted**; `flows.read` into
   `platform_roles.permissions` → refused. Probe rows deleted; the cascade took the
   permission row with the role.

#### Decisions taken while implementing

- **`permissionCheckSql` generates the constraint text; the migrations paste it.** The
  `FOUNDRY_EMITS` idiom applied to SQL. The alternative — typing 49 strings into four
  migrations — is how the database and the code come to disagree about what a permission
  is, and the disagreement surfaces as a failed INSERT in production rather than as a red
  test.
- **The parity test matches `IN (…)` AND `<@ ARRAY[…]`, but NOT a bare `ARRAY[…]`.**
  0063's seeded built-in roles are *data*: `auditor` legitimately holds one permission and
  `support` four. A parity check that held those to the whole catalogue would fail on
  correct rows — a guard that cries wolf gets widened, and the widening permits the defect
  (I-62).
- **The INV-5 fixture in `role-presets.test.ts` was wrong on first writing and is fixed.**
  I mapped the legacy `approve` capability to `approvals.decide`; migration 0065 maps it
  to **`flows.approve`**. The corrected fixture also pins 0065's whole rename table, so
  that migration and that test cannot drift.
- **0065 ran over ZERO rows and its own comment says so.** A green migration log is not
  evidence the rename works; the mapping is proven against a fixture in
  `role-presets.test.ts` instead, which runs whether or not the table ever held anything.

#### ⚠ A trap worth keeping

**`grep` silently skips vitest output files** — they contain NUL bytes, so grep treats them
as binary and exits 0 having matched nothing. It reads exactly like "no failures". Use
`grep -a`. Strip ANSI with `sed -r 's/\x1B\[[0-9;]*[mGKHfJ]//g'` first.

### 2026-09-13 — Phase 2, part 2: the resolver, the guard and the route map

**Phase 2 is COMPLETE — T009–T014 and T021–T025 on top of part 1.**
⚠ **Still not shippable and still not progress.** Nothing is enforced; the guard exists
and is mounted on nothing. Enforcement is Phase 3.

| File | What |
| :--- | :--- |
| `repositories/workspace-role.repo.ts` | Rows only. No `delete` at all — INV-7's retire is the only removal. |
| `repositories/platform-role.repo.ts` | `rolesFor` is keyed on subject alone, which is what P-5's cache exploits. |
| `repositories/platform-audit.repo.ts` | No `update` that rewrites a decision; `bumpRepeat` changes a count, never a fact. |
| `services/effective-permissions.service.ts` | The union resolver + `PlatformRoleCache`. |
| `middleware/require-permission.middleware.ts` | `requirePermission(p, {param})`, three outcomes. |
| `auth/route-stack.ts` | The Express-internals walker, shared by the checker and the generator. |
| `auth/route-permissions.ts` | **GENERATED** — 142 workspace · 26 platform · 12 identity · 16 exempt. |
| `services/access-audit.service.ts` | Grants, revocations, refusals. Swallows its own failures. |

**Server suite: 2747 passed / 5 failed — the same 5 as the baseline.** +97 tests.

#### Four things that were found by running, not by reading

1. ⚠ **MY OWN MIGRATION 0065 WAS BROKEN, AND IT RAN GREEN.** It added the new CHECK
   without dropping 0042's old one, leaving **two mutually exclusive CHECKs** on
   `workspace_member_capabilities` — the table became completely unwritable, and the
   UPDATEs would have failed on any deployment that had ever granted a capability. It
   passed because the table held zero rows, which is exactly what that migration's own
   comment predicted. Caught by the resolver test, not by reading.
   - **Then proven properly**: rolled 0065 back, planted **one row per legacy value**,
     re-ran. Result: 5 renamed (`flows.write` `flows.arm` `flows.approve` `resources.read`
     `realdata.use`), 2 dropped (`admin`, `platform-admin` — INV-10), old constraint gone.
   - **And the loud-failure guard proven**: planted `some-unmapped-capability`, ran, got
     *"holds value(s) this rename does not map: some-unmapped-capability"* and a refusal
     to add the CHECK. Fixture removed; database clean at 66 migrations.
2. ⚠ **`err.expose` IS ALREADY TAKEN, AND TAKING IT BROKE A 413.** I carried the refusal
   envelope on `err.expose`; `http-errors` (which `body-parser` throws) sets that name to
   a **boolean**. `{ ...true }` spreads to `{}`, so every 4xx through that path lost its
   `error` field and became a bare `{requestId}`. Caught by
   `steps-body-limit.test.ts`'s control — **the sixth server failure the baseline was
   written to make identifiable.** Now `Symbol.for("foundry.error.responseBody")` plus a
   `typeof === "object"` check, with `withResponseBody()` as the only way to set it.
3. ⚠ **`asyncHandler` ERASES A GUARD'S NAME, so `requireWorkspaceRole` IS INVISIBLE to a
   stack walk.** It returns an anonymous arrow. A mount assertion written against handler
   NAMES finds 5 of 142 (`requireSuperAdmin`, which is not wrapped) and would report 137
   routes as unguarded. **This would have made Phase 3's T027 pass over an empty set.**
   `requirePermission` therefore tags itself with a `Symbol.for("foundry.rbac.guard")`
   marker carrying `{permission, param}`, and `mountedRoutes` reads it — so T027 can check
   that the guard mounted on each route declares the **same permission the map does**,
   not merely that some guard is present.
4. ⚠ **"142 workspace routes" is two different sets and they differ by two.** The
   MAP's 142 ≠ the 142 under the `/api/workspaces/:workspaceId/` prefix: `me/attendance`
   and `me/exceptions` sit under that prefix but are identity-only, while
   `GET /api/workspaces/:id` and `/:id/manifest` are workspace-scoped on `:id`. Two out,
   two in — and the pair leaving carries `requireIdentity` while the pair arriving is
   bare, so **both counts move by two in opposite directions** (109 bare, not 107; 33 with
   `requireIdentity`, not 35). Counting by path prefix instead of by the map reports a
   discrepancy that is not one.

#### The route map was regenerated, and it had NOT drifted

`rows=196 ws=142 dep=38 exempt=16`, zero unmapped, zero stale — unchanged since the spec.
⚠ **A fourth generator, `contracts/emit-ts.py`, now emits `route-permissions.ts` from the
same `map.json`.** 196 routes transcribed by hand is 196 chances to be wrong in the one
file whose only value is being exactly right.

#### Perturbations proven so far (T103 wants 15)

1. `'gates.read'` → `'gates.reed'` in migration 0062 → `permissions.test.ts` red, naming
   `gates.reed` as *unknown in the file*.
2. INV-8 / INV-2 at the database, both directions **with a positive control**:
   `platform.members.grant` and `flows.superuser` into `workspace_role_permissions`
   refused, **`flows.read` accepted**, `flows.read` into `platform_roles` refused.
3. FR-003's control is a test rather than a manual perturbation: a synthetic router with
   one undeclared handler is caught, and a declared one on the same router is not.

#### Open questions carried into Phase 3

- **T027's mount assertion should compare the marker's permission against the map**, not
  merely count guards. The marker exists for this; use it.
- The `elseOf` / `failureMode` stripping defect is **still red and still not ours** — but
  Phase 3 touches route files, so keep checking that the failure list stays at those 5.

### 2026-09-13 — Phase 3, part 1: the guard is mounted and the routes are closed

**Done: T026, T027, and the route sweep T028–T042 / T045 / T045a.**
**Still open in Phase 3: T043/T044 (search), T046–T050 (rewire), T051–T055 (scripts).**

⚠ **THIS IS WHERE THE FEATURE STOPS BEING A DOCUMENT.** Measured at the wire, in process,
with a validly signed identity that holds no grant anywhere:

```
403  GET    /api/workspaces/:ws/flows                      not_a_member
403  DELETE /api/workspaces/:ws/flows/:id                   not_a_member   ← the biggest gap
403  GET    /api/workspaces/:ws/secrets                     not_a_member
403  GET    /api/workspaces/:ws/datasources                 not_a_member
403  POST   /api/workspaces/:ws/flows/:id/test-run          not_a_member
200  GET    /api/health                                     (still exempt)
401  POST   /api/executions/begin                           (its own callback secret, NOT a permission refusal)
```

`mountPermissionGuards(app)` walks the mounted stack in `createApp()` and splices each
route's declared guard in front of its handlers. Boot log:
`[server] permission guard active on 141 workspace-scoped routes`.

#### ⚠ Read the two counts correctly — 141 spliced, 143 registrations, 142 distinct

They are all correct and they mean three different things.
- **143 workspace route REGISTRATIONS** exist, because `releaseGatesRouter` is mounted
  **twice** — the same layer objects appear twice in the walk.
- **141 splices**, because the second visit finds the handler already guarded.
- **142 distinct `(method, path)`**, because `mountedRoutes` dedupes.

**All 143 registrations verified**: first handler guarded, declared permission equal to
the map's, `bad: 0`. That is the property that matters — Express runs the *first* matching
registration, so guarding only a later one would be worthless.

#### ⚠ Two more wrapper-erasure bugs, same family as Phase 2's

3. (cont.) **`wrapAsyncRoutes` REPLACES `layer.handle`, erasing the RBAC marker.** It runs
   after the splice, so the mount assertion saw **0 markers on 196 routes**. Fixed by
   making `wrapHandler` carry the marker across, with a comment saying a wrapper must not
   destroy what it wrapped was carrying. **This is the third time in this feature that a
   wrapper silently ate the thing a control reads.**
4. **The splice targets the first handler CARRYING THAT METHOD**, not `stack[0]`, so a
   path registered for two verbs with different permissions guards each correctly.

#### Perturbation 4 — the mount assertion fires

Replaced `mountPermissionGuards(app)` with `0` in `createApp`. Result:
*"142 workspace-scoped route(s) declare a permission and do not carry its guard. They are
OPEN to anybody who can sign in."* Restored, green.

#### Why the sweep tasks T028–T042 changed no route files

The splice reads the map, so wiring is central. What those tasks actually needed was
**verification that the assignments are right**, which the generator cannot give —
completeness is generated, correctness is a judgement. `auth/route-assignments.test.ts`
pins the twenty-one cells where a reasonable person would have chosen differently:
`POST /datasources/:dsId/test` is a **write** (it dials the tenant's database),
`POST /tools/probe` is a **write**, deleting a *revision* is `flows.approve` (it can unmake
an approval) while deleting the *flow* is `flows.write`, firing a trigger is `flows.run`
while creating one is `flows.arm`, instantiating a template is `flows.write`, D-115's two
model settings stay two permissions, and the local-account access routes take
`platform.members.grant` rather than a third access-granting permission.

⚠ **Two of my assumed paths were wrong and the test caught them**: the trigger fire is
`flows/:flowId/triggers/:tid/fire` (not `/triggers/:triggerId/fire`) and there is no
`/api/ops/outbox` — it is four separate sub-resources.

**Server suite after mounting: 2755 passed / 5 failed — still exactly the baseline five.**

### 2026-09-13 — Phase 3 COMPLETE: the MVP ships

**T043–T055 on top of part 1. 🎯 This is the first phase that is progress.**

```
rbac:verify — 142 workspace-scoped routes × 4 probes
SC-001  a person with no grant is refused everywhere    refused    142 / 142
SC-002  a grant in A is not a grant in B                refused    142 / 142
CONTROL an admin of A is PERMITTED there                permitted  142 / 142
        an allowlist holder passes with no membership    permitted  142 / 142
```

**Server suite 2794 passed / 5 failed — still exactly the baseline five.** Typecheck clean.

#### ⚠ THE AND/OR CONTRADICTION IS RESOLVED, AND `rbac:verify` IS WHAT FOUND IT

The first verifier run reported **137 / 142** on the positive control. The five refusals
were the membership routes: they carried `requireSuperAdmin` **and** now
`requirePermission("members.grant")`, which is **AND** — so a workspace administrator
could not manage their own workspace, and a platform administrator would have been
refused at the one route D-9 exists to reach.

**Resolved to OR, which is spec behaviour change 3 and a deliberate WIDENING.**
`requireSuperAdmin` is **removed** from `members.ts` and `member-capabilities.ts` rather
than kept beside the permission guard. `members.grant` alone already yields the OR,
because `config.isSuperAdmin` short-circuits the resolver to the entire catalogue before
any row is read — so an allowlist holder still passes with no membership row anywhere
(verified: 142/142).

⚠ **`requireSuperAdmin` is now on ZERO workspace-scoped routes**, and there is a named
test that goes red if somebody re-adds it "for safety", explaining that doing so makes it
AND again.

#### T049's grep test was REWRITTEN, and the old form would now be wrong both ways

`describe("every route that assigns membership … carries requireSuperAdmin")` grepped for
a literal string that is now deliberately absent. It asserts the **permission map**
instead — stronger and mechanical, since a middleware NAME could never tell you whether
the guard was actually mounted. **Its control is kept**, plus a new assertion that
workspace create/rename/delete stay on the PLATFORM tier (a workspace permission cannot
authorise creating a workspace — there is no workspace to hold it in yet).

#### Search — the one route the map cannot secure alone (T043/T044)

`searchService.index` gained a **required** third argument. ⚠ **Required, not optional** —
an optional authorisation argument is how one consumer silently gets less checking than
another (I-127, and `expressionsBlock`'s five-line summary). Six kinds filter by six
permissions; `resource` is two sources (datasources ∪ tools) filtered **separately**,
because one coarse permission would leak whichever half it covered.
**Perturbation 5**: `may()` → `true` turns 4 tests red naming the leaked kind.

#### The capability service is now a VIEW, not a second model

`CAPABILITIES` **is** `WORKSPACE_PERMISSIONS`; `getCapabilities` delegates to the
resolver. Its three readers (break-glass, `routes/me.ts`, `catalogue.service.ts`) all
follow. `RANK` is **deleted** — ordering is set containment (INV-4), with a new CONTROL
that an author does *not* satisfy approver, since `containsAll` returning `true`
unconditionally would otherwise pass everything.

#### ⚠ Three things measured that contradict earlier notes — re-measure, do not quote

1. **`workspace_members` is 2 now, not 0.** My own Phase 1 `e2e:ui` baseline run created
   them (`author@`/`approver@acme-hr.example` in the real HR workspace, granted by
   `local-admin`). `baseline-access.json` was true when taken. **Left in place** — they
   are the harness's state, not junk this feature may delete.
2. **A leftover `zrbacsearch workspace` from a failed test run was deleted.** Live
   workspaces are back to 8.
3. ⚠ **`rbac:backfill`'s "today" column is NOT what those people could reach**, and the
   report now says so in a banner. "today" is what the **capability model** answered, and
   that model gated exactly two consumers. 106 routes had no check at all, so effective
   access "today" was closer to *everything*. A long `+` list is mostly the permission
   model naming things the capability model had no word for — in almost every case a
   **narrowing**, not a grant of new power.

#### Perturbations proven so far (T103 wants 15): 5 of 15

1. Migration CHECK typo → `permissions.test.ts` red naming the key.
2. INV-8/INV-2 at the database, both directions, with a positive control.
3. FR-003: an undeclared synthetic route is caught; a declared one is not.
4. `mountPermissionGuards` → `0` → *"142 routes … are OPEN to anybody who can sign in."*
5. Search's `may()` → `true` → 4 red, naming the leaked kind.

### 2026-09-13 — Phase 4: custom roles

**T056–T061.** `workspace-role.service.ts` + `routes/roles.ts` (8 endpoints), mounted at
`/api/workspaces/:workspaceId/roles`. **39 tests across the two files.**
Server suite **2833 passed / 5 failed** — the baseline five.

⚠ **The completeness check caught the 8 new routes the moment they were mounted**:
*"8 mounted route(s) declare no permission and no exemption. A route nobody declared
ships OPEN."* Added to `gen-map.py`, regenerated: **204 routes = 150 workspace + 26
platform + 12 identity + 16 exempt**, zero unmapped, zero stale. That is the control
paying for itself on its first real use.

#### The assignments, and why they are not all `roles.write`

- **reading** a role is `members.read` — seeing which roles exist and who holds them is
  part of knowing who has access.
- **authoring** one is `roles.write`.
- **assigning** one is `members.grant` — it changes what a person can do, which is the
  same act as adding them to the workspace, reached by a different door.

#### Two things the tests found

1. ⚠ **MY FR-009 TEST HAD THE WRONG PREMISE.** I asserted an `author` posting a role
   containing `secrets.read` gets `role_exceeds_granter`. They get
   `missing_permission: roles.write` — the ROUTE GUARD stops them first, because
   `roles.write` is admin-only. The real FR-009 case needs a caller who **may author
   roles and still does not hold everything**: an author granted `roles.write`
   individually. That is exactly the situation per-feature granting creates, and the one
   where role authoring would otherwise be privilege escalation with extra steps. Both
   are now tested, with a control that the same caller CAN author from what they hold.
2. ⚠ **The error middleware's 4xx branch drops everything but `message`**, so
   `assignees: 1` never reached the body and a client had prose with no number to render.
   Service refusals now go through `withResponseBody` — the same symbol-keyed envelope
   from Phase 2 — so `reason`, `permission` and `assignees` survive. contracts/api.md §E.

#### Invariants, each with a positive control

- **INV-6** preset names and live-name collisions refused; a RETIRED name frees up again.
- **INV-7** retire is a timestamp — the row survives for the audit, and stops conferring
  immediately. Retiring a held role is a 409 **carrying the count**, because "Are you
  sure?" with no number is a dialog people learn to click through.
- **INV-8** `platform.*` refused with an explanation rather than a database error.
- **INV-9** an assignee must already be a member; a role ADDS to a membership.
- **FR-009** enforced at authoring, at editing **and at assignment** — otherwise "who may
  grant X" has two answers depending on which door X came through, and the role door is
  the unguarded one.
- **FR-025** every schema `.strict()`: `subject`, `grantedBy`, `workspaceId`,
  `bySuperAdmin` and a smuggled `permissions` on assign are all **400**, with a control
  that the same bodies without the extra field succeed.

The Story 3 independent test runs end to end at the wire: two permissions → assigned →
one removed → **refused on the next request with no sign-out** → retired, with the rest of
that person's access untouched.

### 2026-09-13 — Phase 5: the platform tier

**T062–T078.** `requireDeploymentAdmin` is **deleted**.

```
rbac:platform-verify — 150 workspace-scoped routes
SC-010  auditor  workspace routes permitted 0   workspaces visible 0
        support  workspace routes permitted 0   workspaces visible 0
SC-015  platform-admin, member of NOTHING
                 workspace routes permitted 11  (EXACTLY 11, not "at least")
                 workspaces visible         all
        8 / 8 platform read probes correct.                       EXIT 0

rbac:verify — 150 routes × 4 probes    150/150 · 150/150 · 150/150 · 150/150
```

Server suite **2859 passed / 5 failed** — the baseline five. Typecheck clean.

#### ⚠ THE SAME `AND` TRAP, THREE MORE TIMES — and the third one found a bug in MY OWN docblock

Splicing a platform guard beside an existing `requireSuperAdmin` makes the route **AND**,
which is narrower than before and defeats the tier:

1. **`local-users.ts`** had `router.use(requireIdentity, requireSuperAdmin)` — so
   "manage local accounts" and "put somebody in a workspace" were one authority. Now
   three permissions, and keeping the super-admin guard would have refused a platform
   admin at the two `/access/` routes D-9 exists to make reachable.
2. **`platform.ts`** — `requireSuperAdmin` beside `platform.users.read` would refuse an
   auditor and a support role, whose entire purpose is reading who exists.
3. ⚠ **`GET /workspaces/:ws/members` carried `requireWorkspaceRole("author")`**, and
   `rbac:platform-verify` reported **10 of 11** rather than 11. The role guard demands a
   MEMBERSHIP ROW, and a platform admin is conferred `members.read` in every workspace
   and is a member of none.

   **That contradicts what I wrote in the T048 docblock in Phase 3**, which said pairing
   the role guard with a permission is safe "because the permission a role guard's routes
   ask for sits inside that role's preset". True — and **only one direction**. The other
   direction is the one that bites: somebody may hold the PERMISSION without holding a
   ROW. The docblock is corrected, and now says: **before pairing a role guard with a
   permission, ask whether anybody can hold that permission without a membership row.**

#### The splicer now covers both tiers

`mountPermissionGuards` splices `requirePlatformPermission` for `kind: "platform"` too, so
five route files needed no per-handler edits. **All 26 platform routes carry the correct
guard, zero mismatches.** The marker survives `asyncHandler` and `wrapAsyncRoutes` for
both tiers.

#### `pnpm signals` would have broken, and T074 said so

The CLI sent only the API key; with `platform.signals.read` it would 401 → **exit 2**,
which a scheduler reads as *"the system is unreachable"* — paging somebody for a healthy
deployment. It now mints an identity from the first `SUPER_ADMIN_EMAILS` entry (the
`e2e:ui` precedent), and a 401/403 says explicitly that the deployment's health is
**unknown, not bad**.
⚠ **Minting is acceptable here ONLY because this is a READ.** CLAUDE.md's rule against
minting an identity to change a setting from a script is about writes; this records
nothing. Do not copy it into a script that writes.

#### FR-015 / T069a — who sees which workspaces

`GET /api/workspaces` is identity-only and the **list itself is the authorisation**.
A platform admin sees all (conferral), a super admin sees all (short-circuit), an
**auditor sees zero — correct, not a bug**: they read across tenants through
`GET /api/platform/audit`, and the list is tenant metadata they hold no permission for.
One `PlatformRoleCache` per request, or it asks the identical question once per workspace.

#### Perturbations proven so far: 5 of 15 (unchanged — Phase 5 added controls, not perturbations)

The `rbac:platform-verify` "EXACTLY 11" check is itself the D-9 bound guard: written as a
floor it would pass while somebody added `flows.read` to `PLATFORM_CONFERS`.

### 2026-09-13 — Phase 6: the UI stops deciding

**Done: T079–T086, T088, T090, T091, T092a–T092d, T093, and T100/T100a (the honesty
check).**
⚠ **T087 and T092 are PARTLY done and that is stated, not glossed — see "the honest gap".**

Client suite **2511 passed / 4 failed**; `ui-honesty-check.sh` **239 PASS / 0 FAIL**
(baseline 229 — ten new assertions). Server typecheck and client typecheck clean.

#### ⚠ The client's second authority is DELETED

`lib/capabilities.ts` is gone. It held the client's own `ROLE_CAPS` — which **disagreed
with the server's** about whether an `approver` may publish — plus `CAP_NAV` and
`CAP_CONTROLS`, tables claiming which nav sections and controls each capability unlocked.
Those two are gone rather than moved: they were **policy assertions the server never
made**, and they went stale silently whenever a route's permission changed.
`lib/search.ts`'s `filterByCapabilities` went with them — it was decoration (the server
returned every kind to everybody) *and* a second policy in a vocabulary the server had
stopped using.

`MembersPanel` and `LocalAccountAccess` now read `GET /api/permissions/catalogue`. The
six-list change preview is a **two-list** preview: permissions granted and removed, in the
server's own labels. It says less and all of it is true.

#### The three states, everywhere

`lib/permissions.tsx` answers `allowed | denied | **unreadable**`. A failed read
**discards** the answer rather than replacing it with an empty one, because an empty list
renders as *"you may do nothing"* — a claim we are not entitled to make. Outside a
provider it returns `unreadable`, never `denied`, so a forgotten provider does not look
like a correctly-restricted screen.

`Can` does not hide on unreadable. `PermissionGate` keeps the control **visible and
disabled with a reason**, and on unreadable leaves it **enabled** — disabling on a failed
check would refuse on the strength of a network error.

#### ⚠ I-62 caught me twice more, in my own work

1. **`permissions.test.tsx`'s ban matched its own docblock.** The file EXPLAINS why
   `session.user.roles` must never be read, and a bare `/user\.roles/` flagged the
   explanation. Narrowed to a CODE read.
2. **`ui-honesty-check.sh`'s new policy-table ban did the same thing** — the docblocks in
   `permission-catalogue.ts`, `MembersPanel.tsx` and `LocalAccountAccess.tsx` all explain
   why `ROLE_CAPS`/`CAP_NAV`/`CAP_CONTROLS` are gone, and the first version flagged all
   three. Narrowed to an import, an index or a call.

   **State the forbidden thing, not a pattern that resembles it.** Third time in this
   feature.

#### T100a's point, restated because it is easy to lose

The widened session-roles ban **does not cover the real defect**. `lib/capabilities.ts`
read no session at all — it read a *server* answer and applied its *own* policy. That is a
second authority in a permitted shape, and it needs its own assertion, which it now has,
with its own `present_code_in` control.

#### The repo's own conventions caught the new pages

`/no-access` and `/organization/roles` each turned three tests red on arrival: the
reachability scan (*"no page has arrived without a door"*), the rail's
claim-or-exempt-with-a-reason test, and the alpha registry. **All three were satisfied
honestly rather than by exemption where possible**: the app shell now redirects to
`/no-access` when the filtered workspace list comes back EMPTY (never when it FAILS — that
distinction is the whole point), and `/organization` gained a real link to the roles page.

#### ⚠ THE HONEST GAP — what is NOT done in this phase

- **T092 (affordance gating on all 34 pages) is NOT complete.** The infrastructure exists
  (`Can`, `useCan`, `PermissionGate`) and is applied on the surfaces this phase touched —
  the sidebar's admin group, the roles page, the members panel. **The other pages rely on
  the server refusing**, which is correct but not the same as an affordance that matches.
  ⚠ T092's own correction stands: there are **34** pages, not 36 — `admin/downtime` and
  `admin/policies` do not exist.
- **T087's six `listWorkspaces` consumers were not individually audited.** The shell-level
  redirect is in; `LocalAccountAccess` (the super-admin grant form) still sees every
  workspace through the resolver's short-circuit, which is what it needs.
- **T089's Topbar half** (the switcher over the filtered list) is not done; the list it
  reads is already filtered server-side, so it shows the right thing, but it has no
  explaining state of its own.

#### Pre-existing failures, re-verified

`runs/[id]/page.test.tsx` is **FLAKY** — **5 failures on one run and 3 on the next with
identical code**. Root cause is an incomplete `vi.mock` for `@/lib/api` (missing
`emailsForRun`, reached through `ToolActivity.tsx`), and **it is absent from the mock at
`HEAD` too**, so it predates this feature. Same class as `datasource-target.test.ts`.
`workspace-placeholder.test.ts`'s control fails on `['pick']`, not on anything of mine.

### 2026-09-13 — Phase 7: the audit closes

**T094–T099.** Server **2874 passed / 5 failed** (the baseline five), client
**2513 passed / 2 failed**.

#### ⚠ I-120 AGAIN, AND THIS TIME IT WAS MINE

`accessAuditService.recordDenial` was written in Phase 2, tested, and **called by
nothing**. That is the fourth time this repo has met the shape: `shadowedSecretCollisions`
(a refusal living in a function whose only production caller was the audit), the
prompt-boundary detector's `warnings` (computed by `buildAndPersist`, dropped by every
caller), chat's `more` flag (declared, defaulted, read by nobody, so **nobody was ever
asked again**), and this.

In every case the check passed its own tests and **no behaviour depended on the answer** —
which is exactly what makes it invisible when it stops being true. **The detector's own
tests cannot close that gap; only a call site can.**
`middleware/access-audit-wired.test.ts` reads both guards off disk and requires the call.
**Proven by perturbation**: deleting the call turns 4 assertions red.

#### The bound, and why the audit needs one

A refused caller in a retry loop writes one row per attempt — a page polling every two
seconds writes 1,800 an hour. **An audit record an unauthorised caller can flood stops
being readable exactly when it matters**, and the flooding is done by the very person the
refusals are about.

So the **first refusal is written immediately** — the FACT is never delayed — and identical
repeats inside a five-minute window increment a count instead. Identity is
`(subject, permission, workspaceId)` and **deliberately not the route**: two routes needing
the same permission in the same workspace are one refusal to the person hitting them, and
counting them apart would let a loop over ten routes write ten rows for one missing grant.

⚠ **A restart loses a COUNT, never a FACT**, and there is a test that says so. The window
is in memory because persisting it would mean a write per refusal — the thing being
avoided.

⚠ `audit_events` gets **no `repeat_count` column** (INV-16); the count goes in the existing
free-form `raw` JSON.

#### FR-034 at the CALL SITE, not only in the recorder

The route recorded is `req.route.path` — the DECLARED shape — never `req.originalUrl`,
which carries resolved ids and the query string. That is request content and is not ours
to keep. Asserted at the call site, with `req.body` and `req.query` banned there too.

#### SC-014 — `audit_events` is structurally untouched, proven two ways

`audit-untouched.test.ts` asserts (a) **not one of the four RBAC migrations mentions
`audit_events`**, and (b) the LIVE table's CHECK constraints still permit `access` /
`member` / `policy` **and have gained none of the platform vocabulary** (`deny`, `grant`,
`revoke`, `permission`, `platform_role`). Read from `pg_constraint`, not from `schema.ts`
— the question is what the DATABASE permits, the same reason `demo:verify` re-derives
privileges from `pg_catalog`.

#### ⚠ I-62 A FOURTH TIME, again in my own test

`access-audit-wired.test.ts`'s ban on `req.originalUrl` flagged **the comment inside the
call that explains why `req.originalUrl` must not be used**. Bounding the slice did not
help — the comment is *inside* the object literal. Fixed by stripping comments before
scanning: the subject is the CODE.

**Running tally of I-62 in this feature: four.** The lesson is not "be careful with
regexes" — it is that a well-commented control is the single most likely thing to trip its
own guard, because the comment and the violation say the same words.

#### Perturbations proven: 7 of 15

6. Deleting the `recordDenial` call → `access-audit-wired.test.ts` red, 4 assertions.
7. (Implicit in T099) a migration touching `audit_events` → `audit-untouched.test.ts` red.

### 2026-09-13 — Phase 8: polish, and the perturbation sweep

**T101–T107 done. 115 of 119 tasks complete.** Still open: **T087, T089, T092** (the
remaining UI breadth, recorded honestly in Phase 6's entry) and **T108** (`/speckit-comply`,
which needs the spec-kit command).

#### Final numbers

| | baseline (T001) | now |
| :--- | :--- | :--- |
| server tests | 2650 passed / 5 failed | **2874 passed / 5 failed** — the SAME five |
| client tests | 2479 passed / 3 failed | **2510 passed / 5 failed** — same files, flaky |
| `ui-honesty-check.sh` | 229 PASS / 0 FAIL | **239 PASS / 0 FAIL** |
| `e2e:ui` | 66 match · 1 mismatch · 0 gap · 4 note · 1 fail | **67 · 1 · 0 · 4 · 1** |
| route map | 196 routes | **214** = 150 ws + 34 platform + 14 identity + 16 exempt |

#### ⚠ T101 found something the task did not predict, and it is the best find of the phase

Moving the journey's default identity to the allowlist holder made **step 27 — "an author
approving their own work" — return 201**. Nothing was broken: the flow was now *authored by
the super admin*, who is **deliberately exempt from gate 2** (2026-08-21). So the scenario
had **silently stopped existing** while the step still claimed to test it.

Fixed by naming the author explicitly in `createViaCanvas`, with a comment saying why.
**A default identity is not plumbing when a test's subject is who did something.**

#### T103 — 19 perturbations run, all 15 from quickstart covered

| # | Perturbation | Went red |
| ---: | :--- | :--- |
| 1 | migration CHECK typo `gates.read`→`gates.reed` | `permissions.test.ts`, naming the key |
| 2 | `platform.*` / invented permission into a workspace role (DB) | refused, **with a positive control accepting `flows.read`** |
| 3 | undeclared synthetic route | FR-003 control |
| 4 | `mountPermissionGuards` → `0` | *"142 routes … are OPEN to anybody who can sign in"* |
| 5 | search `may()` → `true` | 4 red, naming the leaked kind |
| 6 | delete the `recordDenial` call | `access-audit-wired.test.ts`, 4 red |
| 7 | a migration touching `audit_events` | `audit-untouched.test.ts` |
| 8 | delete a route→permission map entry | completeness, 4 red |
| 9 | permission guard returns `true` | 6 of 12 red |
| 10 | remove the super-admin short-circuit | memberless-assignability |
| 11 | `approver` loses `flows.arm` | declared-widening assertion, 4 red |
| 12 | **third permission in `PLATFORM_CONFERS`** | INV-18 **set equality**, 5 red |
| 13 | `auditor` gains a conferral | INV-12, 5 red |
| 14 | drop INV-8's CHECK (DB) | `platform.*` accepted — constraint restored from the catalogue |
| 15 | `session.user.roles` in a component | widened ban |
| 16 | re-introduce a client policy table | ⚠ **only the T100a ban fired, NOT the session-roles one** — which is exactly T100a's point, proven |
| 17 | un-filter `GET /api/workspaces` | `rbac:platform-verify`: *"auditor can see 9 and must see none"* |
| 18 | remove `requireProvenanceAuthority` | ⚠ **DID NOT FIRE — see below** |
| 19 | add a deny path to the resolver | P-1, 3 red |

#### ⚠ PERTURBATION 18 FOUND A WEAKNESS IN AN EXISTING CONTROL

`revision-provenance.test.ts`'s mount scan was
`src.includes("requireProvenanceAuthority")` — **which the IMPORT LINE satisfies**. The
guard could be commented out of the route and the test stayed green.

**This is the mirror of I-62.** I-62 warns against a pattern so broad it flags the
*explanation*; this was a pattern so broad it accepted the *mention* in place of the
thing. Both are fixed the same way: name what must be true, which here is a **call**.
Strengthened, re-perturbed, now red. **Found only by removing the control and watching
nothing happen** — which is the whole argument for doing this sweep by hand.

#### Documentation

`.specify/memory/security.md` §2 rewritten + new **§2.1** with the **eight** behaviour
changes; `standards-history.md` appended; `archive/GAPS.md` §1.1 **extended** (not
re-closed) with the enforcement half and the measured narrowness; `.env.example`'s
`SUPER_ADMIN_EMAILS` note extended; `CLAUDE.md` gained a full section.

---

## ⚠ 2026-09-13 — THE PLATFORM TIER HAD NO UI, AND NEITHER DID CUSTOM ROLE ASSIGNMENT

Reported from use: *"logged in as super admin … there's only admin approver and author,
there's no platform roles available at any place."* Correct, and broader than reported.
**Neither gap was in the 119 tasks**, so this was an unrecorded omission rather than a
deferred one — these notes previously listed four remaining tasks and this was not among
them.

**Measured by tracing every client method to its callers:**

| Method | Callers before |
| :--- | :--- |
| `listPlatformRoles` · `listPlatformRoleAssignments` | **0** |
| `assignPlatformRole` · `unassignPlatformRole` | **0** |
| `assignWorkspaceRole` · `unassignWorkspaceRole` | **0** |

So the only roles appointable through the product were the three workspace presets — both
member panels hardcode `ROLES = ["author", "approver", "admin"]` — and a custom role
composed on `/organization/roles` could be given to nobody. T080 shipped the methods, T091
built role *authoring*; nothing built assignment for either tier.

⚠ **This is the repo's own recorded failure, at the largest scale it has appeared:** *a
field only a seed script can write is a field the product does not have.* The server half
being correct is exactly what hid it — `rbac:platform-verify` passed throughout, every
route refused correctly, and the roles had no holders because nobody could create one.
**Nothing about it was a security hole**; it was a capability that did not exist.

### What was built

| | |
| :--- | :--- |
| `lib/permissions.tsx` | **`canPlatform()`** — the platform tier read. ⚠ `can()` answers from `data.permissions`, the workspace union, so `can("platform.roles.write")` returns **denied for a super admin holding all eleven**. Gating the new page on it would have shipped it still unreachable, with every test green. `canPlatform` reads `data.platformPermissions`, which the server has always sent on the same payload — the other half of one answer, not a second computation. |
| `components/access/Can.tsx` | `useCanPlatform()`. A separate hook, not a flag on `useCan`, so the wrong one is a different call rather than a forgotten argument (I-127). |
| `app/(app)/organization/platform-roles/page.tsx` | The tier's first screen: roles, holders, assign, unassign. |
| `components/access/RoleHolders.tsx` | Who holds one custom workspace role, with add and remove. |
| `app/(app)/organization/roles/page.tsx` | Mounts `RoleHolders` per custom role. |
| `app/(app)/organization/page.tsx` | The second door. Both role surfaces are reached from here; neither is a rail destination, which `Sidebar.test.tsx` already recorded as deliberate. |

### ⚠ Three decisions worth keeping

- **A custom role is ADDITIVE, so it is NOT a fourth entry in the member panel's
  dropdown.** The resolver is a union: a membership row carries exactly one preset and
  custom roles are held alongside it. One dropdown would say they are alternatives — a
  person given a custom role would look like they had lost their preset, and somebody
  would "fix" that by switching them back, silently removing the custom role. The dropdown
  writes `workspace_members.role`; the holder list writes `workspace_role_assignments`.
- **Assignment is role-centric because there is no "roles of a member" read.** The server
  offers `GET …/roles/:roleId/members` and nothing in the other direction. A member-centric
  view would need one request per role per member; if it is ever wanted, the honest way is
  a server-side read, not a client fan-out.
- **The conferral sentence renders only for a role that carries
  `platform.members.grant`.** Printing it beside `auditor` would teach that every platform
  role reaches tenant data — the opposite of true. A CONTROL test pins the absence.

### ⚠ Two things the repo's own guards caught, that reading did not

- **`alpha-registry.ts` refused the new page** for having no entry — and the entry it
  already held for `/organization/roles` listed *"Assigning a role to somebody from here"*
  under **`soon`**, which this change made false. Both fixed; the claim moved to `real`.
- **`ui-honesty-check.sh` refused `max-w-prose`** on the new page — `<Page measure>` owns
  width. Removed. The check is back to **239 PASS / 0 FAIL**, the branch baseline exactly.

### Verification

Client **2543 passed**, the only 2 failures being the baseline pair
(`runs/[id]/page.test.tsx`, documented flaky, and `workspace-placeholder.test.ts`) — both
in `baseline-pre-change.txt`. Typecheck clean apart from the four known stale `.next/types`
artefacts. **Seven perturbations, seven red runs**: `canPlatform` reading the workspace
set, the assignments error rendering as an empty list, the conferral note shown for every
role, `RoleHolders` offering "add" for a built-in preset, a retired role still taking
holders, the holders error reading as "nobody holds it", and the platform-roles door
removed. ⚠ One of the seven (the retired-role branch) had a **wrong anchor on the first
attempt and did not modify the file** — its green run was meaningless, not a pass, and it
was redone against the real line.

### ⚠ Still not done

- **Composing a CUSTOM platform role has no form.** `POST /api/platform/roles` and
  `platform.roles.write` exist; only the three built-ins can be assigned through the UI.
- The four tasks above (T087, T089, T092, T108) are unchanged.
