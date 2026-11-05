# Plan — super-admin workspace assignment

Six phases, server before client, each independently testable. Every phase names
the perturbation that proves its control fires — the repo's standing rule that a
control which cannot fail is worse than none (I-38).

## Decisions taken up front

**D-1 — One super-admin predicate, in `config`.** `config.isSuperAdmin({subject,
email})` rather than `config.superAdminEmails.has(subject)` at each call site.
Two call sites appear in this feature (`check`, `requireSuperAdmin`) plus
`requireDeploymentAdmin`; three copies of a membership test on an env allowlist
drift in the direction where the untested one stops matching. The `Set` stays
exported for the test that asserts an empty allowlist grants nothing.

**D-2 — `platform_users` is written from `resolveIdentity`, not from Auth.js.**
The client's `events.signIn` fires in the Next process, which holds no database
credential and would need a new write route — a route that records a person on
the caller's word. `resolveIdentity` has already verified the signature against
`RUNTIME_JWT_SECRET`, so the write is a side effect of a check that already
happened. Cost: a user appears only once they make an API call, not at the
instant of sign-in. That is the honest shape — the list is *identities seen by
this API*, which is exactly what it will be used to assign.

**D-3 — The upsert must never fail a request.** It is a `catch`-and-log around a
single `ON CONFLICT (subject) DO UPDATE`, throttled in memory (one write per
subject per 60s) so a polling dashboard does not write per poll. An
authorisation path that can 500 because a bookkeeping table is unavailable is a
worse outcome than a stale list.

**D-4 — `requireSuperAdmin` is a new middleware beside `requireWorkspaceRole`,
not a fourth role.** Same reasoning `deployment-admin.middleware.ts` already
wrote down for itself: `requireWorkspaceRole` answers *"may this person act in
this workspace"* and treats a missing `:workspaceId` as a 500 wiring bug.
Super admin is a deployment-level question with no workspace in it. Two
questions, two guards. It lives in `middleware/super-admin.middleware.ts`.

**D-5 — Assignment reuses `grant()`.** No `assign()`. `grant()` already holds the
last-admin refusal, the subject-keying and the upsert-vs-insert branch; a second
writer would be a second place for those rules to disagree. What changes is the
guard on the route and the default role in the form.

**D-6 — The last-admin refusal stays, and is now reachable differently.** With
claim gone, a super admin can always re-grant, so the refusal is no longer
protecting against an unrecoverable state for a super admin — but it still is for
every deployment with an empty allowlist, and demoting the last admin of a
workspace still breaks `requireDeploymentAdmin` for its members. Keep it; a
super admin is not exempted.

## Phase 1 — Super-admin identity (server)

* `config/index.ts`: keep `superAdminEmails`; add `isSuperAdmin({subject, email})`
  matching subject exactly **or** email case-insensitively, and
  `superAdminConfigured` (`size > 0`). Rewrite the docblock — it currently
  describes subject-only matching, which is the bug FR-8 closes.
* `workspace-member.service.ts`: `check()` calls `isSuperAdmin` with both fields.
  ⚠ `check()`'s signature takes `subject: string | undefined` only — it gains an
  `identity` parameter (`{subject, email}`) and `requireWorkspaceRole` passes
  `req.user`. Every other caller is a test.
* `middleware/super-admin.middleware.ts`: `requireSuperAdmin`, three outcomes —
  401 no identity, 403 with the *configured* message, 403 with the *unconfigured*
  message naming `SUPER_ADMIN_EMAILS`.
* `middleware/deployment-admin.middleware.ts`: super admin passes first; both
  messages stop naming `claim` (FR-9).

**Proves it fires:** an email-listed super admin against a subject-only match
(red before, green after); an empty allowlist still grants nothing (the existing
test at `workspace-member.test.ts:203`).

## Phase 2 — `platform_users` (server)

* `drizzle/00XX_platform_users.sql` + `db/schema.ts`. ⚠ Its `when` in
  `_journal.json` must exceed every applied `created_at` — CLAUDE.md's migration
  trap. Nothing is backfilled: there is no source to backfill *from*, and an
  invented row is a person this deployment never saw.
* `services/platform-user.service.ts`: `seen(identity)` (throttled upsert),
  `list()` ordered by `last_seen_at desc`.
* `resolveIdentity`: fire-and-forget `seen()` after a successful verify, before
  `next()`, never awaited into the response path.
* `routes/platform-users.ts` → `GET /api/platform/users`, `requireIdentity +
  requireSuperAdmin`. Mounted in `app.ts`.

**Proves it fires:** a request with a valid token creates exactly one row and a
second request within the throttle window creates none but moves `last_seen_at`
no further; a request with a *bad* token creates none (the write must sit after
the verify, not before it).

## Phase 3 — Route gating (server)

* `routes/members.ts`: `POST /` and `DELETE /:subject` → `requireIdentity +
  requireSuperAdmin`. `GET /` unchanged. Delete `POST /claim`.
* `routes/workspaces.ts`: create / rename / delete → `requireIdentity +
  requireSuperAdmin`. **MEASURED, not assumed:** no harness creates a workspace
  over HTTP. `e2e:ui` only `GET /workspaces` and resolves the existing `HR` by
  name (`e2e-ui-journey.ts:401`); every seed and `kestra:*` harness calls the
  services directly, which is why the role checks live at the route. So this
  gate touches nothing.
* ⚠ **`e2e:ui` DOES break, at one step.** `e2e-ui-journey.ts:1047` claims the
  workspace and then grants a member, as `approver@acme-hr.example` — an
  identity it mints itself. Claim is gone and grant is super-admin-only, so that
  step must be rewritten: the harness mints a SUPER identity (added to
  `config.superAdminEmails` for the run, the same way `workspace-member.test.ts`
  already does) and the step records the assignment rather than the claim. It is
  the harness noticing exactly what it exists to notice; do not route around it
  by relaxing the gate.
* `workspace-member.service.ts`: delete `claim()`; keep `BOOTSTRAP_GRANT`.
  Rewrite the "Zero members is a REFUSAL" docblock — the refusal stands, but the
  fix it names is now "a super admin assigns you", not `claim`. `check()`'s
  zero-member message changes with it.
* `workspace-member.test.ts`: the claim describe blocks go; the route-tree grep
  gains an assertion that no route file mentions `claim`, and that every
  member-writing route carries `requireSuperAdmin` — with a control that the grep
  can find those routes at all (the existing idiom at line 237).

**Proves it fires:** a signed-in non-super-admin gets 403 from each of the five
routes; a super admin gets through on a workspace with zero members.

## Phase 4 — `/api/me` (server + client seam)

* `routes/me.ts` → `GET /api/me`, `requireIdentity` only (no super-admin gate —
  a non-super-admin needs the `false`). Returns
  `{ subject, email, name?, superAdmin, superAdminConfigured }`.
* `foundry-client.ts`: `me()`, `listPlatformUsers()`; drop `claimWorkspace`.
  ⚠ `app/api/foundry/[...path]/route.ts` denies three segments — confirm
  `me` and `platform` are not caught by it.
* `lib/api.ts` + `lib/types.ts`: `Me`, `PlatformUser`; drop `claimWorkspace`.

## Phase 5 — Client (the Manage Workspaces tab)

* `components/shell/Sidebar.tsx`: the `/organization` row renders only when
  `me.superAdmin`. ⚠ While `me` is loading, render **nothing** rather than the
  link — a link that appears and disappears is worse than one that arrives late,
  and this is the one row whose presence is a claim about authority.
* `app/(app)/organization/page.tsx`: gate the whole page on `me`. Three states —
  super admin (today's page plus the new panel), not a super admin (a refusal
  naming who can help), no super admin configured (a refusal naming
  `SUPER_ADMIN_EMAILS`). ⚠ `me` failing to load is a **fourth** state and must
  not read as either answer — `listPromptBoundaryWarnings`' rule: unreadable
  renders as unreadable.
* `components/workspace/MembersPanel.tsx`: delete the Claim button and its
  `claimWorkspace` import; keep the `bootstrap` → "claimed" badge and add a
  sentence explaining it names a pre-existing row from the removed self-claim
  path. Default the grant form's role to `admin`. The free-text `subject` +
  `email` inputs become a **picker over `platform_users`**, with the free-text
  pair kept as a disclosed fallback for a user who has never called the API —
  because the picker cannot list somebody it has never seen, and refusing that
  case would make the panel unable to onboard the first user on a fresh
  deployment.
* `components/workspace/PlatformUsersPanel.tsx`: the signed-in list —
  email, subject, first seen, last seen, and an "Assign to <workspace>" action.
  ⚠ Its foot carries the same bound as `MembersPanel`'s: this is *identities that
  have signed in*, not verified people, and not accounts.
* Tests: `MembersPanel.test.tsx` loses its claim assertions and gains the picker;
  new `PlatformUsersPanel.test.tsx` (rows, empty, unreadable); `organization`
  page test gains the four `me` states; `Sidebar` test asserts the row is absent
  for a non-super-admin **and present for one** (a hidden-always link passes a
  one-sided test).

## Phase 6 — Docs, env, honesty checks

* `.env.example`: rewrite the `SUPER_ADMIN_EMAILS` block — it is now
  **load-bearing rather than optional** (empty ⇒ nobody can manage workspaces),
  and it accepts subject *or* email.
* `scripts/ui-honesty-check.sh`: assert no `claimWorkspace` in the client, and
  that the two new panels carry their bound sentences. Its assertion count moves;
  it derives the page count from the filesystem, so no page was added or removed.
* `CLAUDE.md`: the GAPS §1.1 bullets state *"Every existing workspace has ZERO
  members and refuses approvals until claimed"* and name `claim` as its own
  endpoint. Correct them in place rather than deleting — the reasoning for why
  backfilling was refused still holds, and the answer changed, not the question.

## Risks

| Risk | Mitigation |
| :--- | :--- |
| Empty `SUPER_ADMIN_EMAILS` + claim removed = an unmanageable deployment. | FR-7's `superAdminConfigured`, surfaced on the page and in both 403s; Phase 6's env note. |
| `e2e:ui` or another HTTP harness creates workspaces or grants members. | Phase 3's first task is to grep for it before gating; the gate moves rather than the harness being routed around. |
| Entra subject-vs-email confusion re-appearing. | One predicate (D-1) plus the regression at Phase 1. |
| `platform_users` read as a user directory. | Named `platform_users`, never `users`; bound sentence on the panel, asserted by `ui-honesty-check.sh`. |
| A super admin reads as separation of duties. | Unchanged approval gates, and the existing docblock language reused verbatim. |

## Outcome (2026-08-20)

Built and verified at the wire; see CLAUDE.md's "The super-admin workspace assignment" for the
load-bearing facts and the measurements. Server 1458 passed / 23 skipped · client 739 passed ·
both typechecks clean · `ui-honesty-check.sh` 196 PASS / 0 FAIL.

**Three plan decisions were changed by measurement, not by argument** — all three are in `tasks.md`'s
"Landed beyond the plan". The sharpest is **D-6, which was wrong**: keeping the last-admin refusal
absolute made a mis-assignment irreversible.

**Not run: `e2e:ui`.** Its membership step was rewritten (T3.7) but the harness authors flows into the
shared deployment, so it is left for a deliberate pass rather than run as a side effect of this work.
