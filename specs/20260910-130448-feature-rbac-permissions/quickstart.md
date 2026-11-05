# Quickstart — validating feature-level RBAC

**Feature**: Feature-level RBAC · **Date**: 2026-09-10 · ⚠ **RE-BASELINED 2026-09-12**

How to prove this feature works end to end. Every scenario maps to a success criterion.
This is a validation guide, not an implementation guide — the code lives in `tasks.md`.

---

## Prerequisites

```bash
node --version          # must be >= 22 — below that packages/client's vitest throws
pnpm install
docker compose --env-file .env -f infra/docker-compose.yml up -d
pnpm --filter @foundry/server db:migrate      # applies 0062..0065 (⚠ renumbered — 0061 is taken)
```

⚠ **Run compose from the repo root with `--env-file .env`.** Compose interpolates
`${VAR}` from the directory holding the compose file (`infra/`), and there is no
`infra/.env`.

Two environment values matter here and neither is new:

- `SUPER_ADMIN_EMAILS` — must be non-empty, or nothing can be granted at all and every
  scenario below refuses correctly for the wrong reason. `GET /api/me` reports
  `superAdminConfigured` so this is checkable before starting.
- `RUNTIME_JWT_SECRET` — the harnesses below mint identities with it.

---

## ⚠ Step −1 — read the membership count BEFORE anything else

```bash
docker exec foundry-parent-postgres psql -U foundry -d foundry_parent -At -c \
  "select (select count(*) from workspace_members),
          (select count(*) from workspace_member_capabilities),
          (select count(*) from platform_users),
          (select count(*) from workspaces where deleted_at is null);"
```

Measured 2026-09-12: **0 / 0 / 2 / 8**.

⚠ **WITH ZERO MEMBERS, SHIPPING THE MVP TAKES THE PRODUCT AWAY FROM EVERYONE WHO IS NOT IN
`SUPER_ADMIN_EMAILS`.** P-2 (empty means empty) and FR-012 (absence of configuration is not
permission) are both correct and both bite at once, across all eight workspaces. This is
**accepted, not a defect** (research M-6, plan behaviour change 6) — but it is the thing to
know before the guard is mounted, not after the first person signs in.

It also means Step 0 below has no subject matter, and that several success criteria are
**vacuous here rather than met**. Each says so where it applies.

---

## Step 0 — Review the backfill before applying it *(FR-029, SC-003)*

**Do this first and read the output.** It is the only point at which the effect on every
existing person is visible before it is real.

```bash
pnpm --filter @foundry/server rbac:backfill --dry-run
```

Expect one line per (person, workspace) with `today`, `after` and `diff`. **`diff` must
be empty for everybody** except the three known cases, which the report labels:

1. holders of the dropped `admin` / `platform-admin` capability values (INV-10);
2. workspace admins who lose the ability to change the generation model (research D-6);
3. ⚠ **approvers, who GAIN `flows.arm`** — the one declared preset change (data-model §2).

Any fourth kind of difference is a defect in the preset definitions — stop and fix
`role-presets.ts`, do not apply.

⚠ **ON THIS DEPLOYMENT THE REPORT IS EMPTY, AND AN EMPTY REPORT IS NOT A CLEAN ONE.**
There are no members (Step −1). The script prints the row count it read and says *"no
members exist on this deployment; nothing to carry forward"* — read that sentence, not the
absence of differences. "0 differences over 0 people" and "40 people carried forward
perfectly" print almost identically, and that is the failure this repo keeps finding.

```bash
pnpm --filter @foundry/server rbac:backfill --apply
```

---

## Step 1 — The completeness check *(SC-002)*

```bash
pnpm --filter @foundry/server test -- route-permissions
```

Proves every mounted workspace-scoped handler declares a permission, no map entry is
stale, every permission named exists, **and the control fails on a synthetic
undeclared route**. If the control does not fail, the check is scanning nothing and the
green result means nothing.

---

## Step 2 — A workspace is closed *(SC-001, US1)*

```bash
pnpm --filter @foundry/server rbac:verify
```

The feature's own harness. It creates two throwaway workspaces and three identities
(a granted person, an ungranted person, an allowlist holder), then attempts **every
workspace-scoped handler** in both workspaces as each identity.

Expect: **`142 routes × 3 identities`**, with every ungranted attempt refused and every
granted attempt permitted. It exits non-zero on a single unexpected permit.

⚠ **The positive control is the half that matters.** A run where everything is refused
scores 100% on the refusal arm and means the product is broken. The harness reports
permitted and refused counts separately and fails if permitted is zero.

⚠ It creates its own workspaces and deletes them, following
`workspace-member.test.ts`'s reasoning — taking `list()[0]` picks up whatever another
suite created and deletes it out from under them.

---

## Step 3 — A custom role, end to end *(SC-004, US3)*

Signed in as a workspace admin, in the UI:

1. **Roles** → *New role* → name it `Finance Reviewer`, tick `flows.read` and
   `flows.approve`, save.
2. Assign it to a person who is a member with the `author` preset.
3. As that person: the approve control on a draft is now enabled; the *Register
   datasource* control is still absent.
4. Remove `flows.approve` from the role. As that person, refresh: the approve control is
   gone **without signing out** *(SC-005)*.
5. Retire the role. The confirmation states how many people lose access.

Should take under five minutes with no assistance — that is SC-004, and it is a
stopwatch measurement, not a judgement.

Refusals worth provoking:

- Try to give the role a permission you do not hold → `role_exceeds_granter`, naming the
  permission and **not** listing what you hold.
- Try to name it `admin` → `409`, colliding with a preset.
- Try to assign it to somebody who is not a member → `409` naming the missing membership.

---

## Step 4 — The platform tier *(SC-010, US4)*

```bash
pnpm --filter @foundry/server rbac:platform-verify
```

Assigns three throwaway identities, none of them a member of any workspace.

**`auditor`** — audit history readable in **every** workspace; **every** workspace data
read, every write and every membership change refused; and **zero workspaces returned** by
`GET /api/workspaces`. Its **conferred** set must be empty (INV-12) — ⚠ asserted directly
through `PLATFORM_CONFERS`, not inferred from the refusals, because a refusal can also come
from a bug, and **not** by inspecting the role's own permission list, which would pass while
`platform.audit.read` quietly acquired a conferral.

**`support`** — the same, plus the ops-outbox and signals reads.

**`platform-admin`** *(new with D-9, SC-015)* — permitted **exactly two** workspace-scoped
routes in a workspace they are not a member of: `GET /members` and `POST|DELETE /members`.
Every other workspace-scoped route refused. `GET /api/workspaces` returns **all** of them.
⚠ **Exactly two, not "at least two"** — a floor passes while the conferral silently widens,
and the number two is the entire bound on D-9.

Then, by hand, three things:

1. Remove the last platform administrator. Refused unless you are in `SUPER_ADMIN_EMAILS`
   (INV-14).
2. As a `platform-admin`, **create a workspace and give it its first member.** Before D-9
   this was a dead end — `platform.workspaces.write` created a workspace they could put
   nobody into, themselves included.
3. ⚠ As a `platform-admin`, assign **yourself** `admin` in a workspace you are not in, then
   read that workspace's automations. **It works, and that is the accepted cost of D-9.**
   Confirm the grant appears in the audit record naming you — that is the whole bound, and
   the reason the honest sentence is *"a platform administrator cannot see a tenant's data,
   but can give themselves the ability to, and doing so leaves an audit entry naming them"*.

---

## Step 5 — The screen tells the truth *(SC-011, SC-013, US5)*

```bash
pnpm --filter @foundry/client test
bash scripts/ui-honesty-check.sh
```

The honesty check must be **≥ its pre-change count, and byte-identical in its FAIL set** to
the baseline captured in T001 — this repo's own convention, because the check has
pre-existing failures and "0 FAIL" has not been true for a while. It must include the
widened session-roles ban (research M-3) plus its positive control, **and** the separate
`lib/capabilities` ban (T100a) — the widened session-roles pattern does **not** catch the
client's own `ROLE_CAPS`, because that code reads a server answer and then applies its own
policy rather than reading `session.user.roles`.

By hand, three states on one page:

1. **Permitted** — the control is enabled.
2. **Not permitted** — absent, or disabled with the missing permission named.
3. **Unknown** — stop the API server and reload. The page must say *the check could not
   be completed*. **Neither** the permitted nor the forbidden rendering is acceptable
   here; this is the `PromptBoundaryWarnings` rule, and it is the state most likely to
   be got wrong because it is the one nobody demos.

And *(SC-013)*: sign in as somebody with no grant anywhere. Expect a page naming who can
grant access — not an empty workspace switcher, not an error.

---

## Step 6 — Audit *(SC-006, SC-014)*

```bash
pnpm --filter @foundry/server test -- access-audit
```

Then by hand: grant a role, override a permission, revoke both, and attempt one
forbidden action. All five appear in the workspace audit view. Check the refusal entry
carries the person, the permission and the resource **and no part of the protected
resource**.

For the platform tier, `GET /api/platform/audit` returns both records in one time order
(INV-17). Confirm the workspace audit view is **unchanged** — same rows, same order as
before this feature (SC-014's second half; `audit_events` is structurally untouched, so
this is verifiable by comparing a saved response).

Provoke the dedupe: hit a forbidden endpoint 500 times in a loop. Expect one entry with
a count, not 500 entries *(FR-034)*.

---

## Step 7 — Nothing else moved *(SC-009)*

The regression net authenticates as nobody and calls services directly, so it must be
untouched by a route-level change (FR-027). Run it and diff against a pre-change capture:

```bash
pnpm --filter @foundry/server demo:verify
pnpm --filter @foundry/server finance:verify
pnpm --filter @foundry/server legal:verify
pnpm --filter @foundry/server kestra:phase3
pnpm --filter @foundry/server scenarios:verify
pnpm --filter @foundry/server e2e:ui
bash scripts/ui-honesty-check.sh
pnpm test
```

⚠ **`e2e:ui` speaks only HTTP and WILL be affected, and by more than one step.** It
resolves its fixture by listing workspaces, which FR-015 filters (risk R-2) — but with zero
members (Step −1) **every workspace-scoped call it makes refuses without an allowlisted
identity**, not just the listing one. It must present an identity from `SUPER_ADMIN_EMAILS`,
which it already does for its membership step. With the variable unset it records a
**NOTE** naming it rather than a MISMATCH: a harness reporting its own environment as a
product defect is worse than no assertion.

⚠ **The regression net is runnable here — verified 2026-09-12.** All eight workspaces exist
(Finance, HR, HR (alt — swap rehearsal), Legal, IT Operations, Customer Support, Orders &
Fulfilment, Recruitment) and so does every demo database (`hr_demo`, `hr_demo_alt`,
`finance_demo`, `legal_demo`, `itops_demo`, `support_demo`, `orders_demo`, `hiring_demo`).
⚠ **CLAUDE.md's "THIS DEPLOYMENT HAS THREE DOMAINS, NOT SEVEN" is stale** and its advice
still holds: read the workspace ids off the database, never out of a document. Record what
skips in T001's baseline anyway — a harness that skipped before and skips after is not a
regression, and only the baseline can say which.

⚠ Several `kestra:*` harnesses need `./scripts/harness-in-net.sh` on macOS — the host
cannot reach Kestra's container IP.

---

## Step 8 — Perturbation *(SC-008, FR-039)*

The feature is not delivered until each control has a test that goes red when the
control is removed. Verify by actually removing them, one at a time:

| Perturb | Expected red |
| :--- | :--- |
| Delete one entry from the route→permission map | `route-permissions.test.ts` completeness |
| Make the completeness check scan an empty list | its own control (step 1) |
| Return `true` unconditionally from the permission middleware | `rbac:verify` permitted/refused counts |
| Remove the super-admin short-circuit | memberless-workspace assignability test |
| Add a `deny` path to the resolver | the union/order-independence test (P-1) |
| Let `workspace_role_permissions` accept a `platform.*` value | INV-8's CHECK test |
| Give `auditor` one workspace permission | INV-12's empty-intersection test |
| Un-filter `GET /api/workspaces` | FR-015's filtering test |
| Read `session.user.roles` in a component | `ui-honesty-check.sh` widened ban |
| Remove `requireProvenanceAuthority` from approve | its existing test (must still fire) |
| ⚠ Re-introduce `lib/capabilities.ts` and gate a control on it | `ui-honesty-check.sh`'s separate `lib/capabilities` ban (T100a) — **not** the session-roles one, which does not match it |
| ⚠ Give `approver` no `flows.arm` | `role-presets.test.ts`'s declared-exception assertion (T008) |
| ⚠ Return every search kind to an unentitled caller | `search.service.test.ts`'s per-kind filtering, with its entitled-caller control (T044) |
| ⚠ Add a third permission to `PLATFORM_CONFERS` | INV-18's set-equality test (T008b) — a subset assertion would **not** fire, which is why it is written as an equality |
| ⚠ Give `auditor` a conferral | INV-12's empty-conferral test (T008b) and `rbac:platform-verify`'s auditor arm |

Record the count. SC-008 is *controls == tests proven red*, and a control with no
perturbation is not counted as delivered. ⚠ **Fifteen now, not ten.**
