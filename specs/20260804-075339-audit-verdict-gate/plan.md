# Implementation Plan: Audit Verdict as an Asymmetric Gate (Surface C)

**Branch**: `krt/guardrail_validation` | **Date**: 2026-08-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20260804-075339-audit-verdict-gate/spec.md`

## Summary

Three changes, in the order they must land:

1. **One new condition inside the existing gate.** `enableReadiness()` in
   `trigger.service.ts` already decides whether a trigger may be armed. It gains a
   third refusal: the script's most recent audit verdict is `fail`. No new gate
   layer, no new middleware, no new decision point — because a second place that
   decides "may this be armed" is a second place to forget.
2. **An override record** that lets an operator proceed against a verdict they
   have read and judged wrong, on the record. One new table, one migration.
3. **A client surface** for the audit findings, because a refusal nobody can
   inspect is a bug report waiting to be filed. Today nothing in `packages/client`
   reads `auditVerdict` or `auditJson` at all.

The whole feature turns on the asymmetry, which shows up in the code as a single
structural rule: **the verdict may appear in a condition that returns `not
ready`, and must never appear in a condition that returns `ready`.** Design
decision D3 makes that rule mechanically checkable rather than a matter of care.

### The one-line version of the design

`enableReadiness()` is a sequence of refusals with `{ ready: true }` at the
bottom. Adding a refusal is additive and safe. Adding anything to the *bottom* —
any clause of the form "…unless the verdict is clean" — is the forbidden shape.
There is exactly one `return { ready: true, reason: null }` in that function and
this feature must not add a second.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥20, ESM

**Primary Dependencies**: none added. The gate is a comparison; the override is a
row. Article IV is satisfied by adding nothing (Decision D7).

**Storage**: one new table (`audit_overrides`) and one migration, which also adds
the two missing CHECK constraints (D5). No column is added to an existing table.

**Testing**: vitest, `packages/server` and `packages/client`. Service-level tests
for the gate logic; route-level tests against the real `createApp()` for the
wiring, per the standing lesson that a tested unit with untested wiring is a
deletable unit. `db/schema.test.ts` already has the pattern for CHECK-constraint
tests and the new constraints follow it.

**Target Platform**: Linux container, single parent API instance.

**Project Type**: web service (parent API) + Next client.

**Performance Goals**: the gate adds at most one indexed query per readiness
evaluation. `toPublicDetailed()` already issues two queries per trigger, so a
trigger list of *n* goes from 2n to 3n queries; D2 addresses this rather than
leaving it to be discovered.

**Constraints**:

- **Article XV** — a status label states what happened. The gate refuses; it must
  not silently change any stored state (FR-009), and it must not present the
  absence of findings as a pass (FR-017).
- **Article X** — the gate reads the independent audit, never
  `testsPassed`/`syntaxCheckPassed`/the rest of the agent's self-report. The two
  must stay visibly distinguishable on the client (FR-020).
- **FR-021** — nothing that succeeds today may fail after this, except arming a
  `fail`-verdict script. The pre-feature suite is the check.
- **No new gate layer.** Stated as a constraint because the natural instinct is a
  middleware, and a middleware that guards three of four routes is a hole.

**Scale/Scope**: 4 server source areas — `trigger.service.ts`,
`test-result.repo.ts`, `db/schema.ts` + migration, and one new repo for
overrides — plus one route addition and two client surfaces.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Process gates (Articles I–VIII)**

- [x] **I. Spec-First** — spec.md written and validated before this plan.
- [x] **II. Test-First** — every behaviour has a named test in
      [quickstart.md](quickstart.md), enumerated in `tasks.md` before its
      implementation task. Note the specific negative tests this feature needs:
      *warn does not block*, *null does not block*, *clean does not shorten any
      other check*. The third is the one that decays first if unguarded, because
      it looks redundant right up until someone "simplifies" the gate.
- [x] **IV. Simplicity** — no new dependency. One new table, justified below: the
      alternative (a column on `triggers`) is wrong on the merits, not merely
      bigger — see D4.
- [x] **V. Observability** — every refusal is a diagnosable, distinct reason
      string; an unknown verdict value logs as a defect (FR-015) rather than
      failing quietly.
- [x] **VII. Documentation Currency** — `security.md` §8 must be reconciled, but
      **after** this ships, via `/speckit-update-standards`. Recorded in tasks.md
      as a post-merge task, not done inline.
- [x] **VIII. Secrets Hygiene** — no secret is read, written, logged or added. No
      new environment variable, so nothing is owed to `.env.example`.

**Product gates (Articles IX–XV)**

- [x] **X. Generated Code Is Untrusted (NON-NEGOTIABLE)** — the gate's input is
      the parent's own deterministic audit. It reads no field the agent reported
      about itself. FR-020 keeps the client from blurring the two.
- [x] **XI. Least-Privilege (NON-NEGOTIABLE)** — no credential widens. The
      override grants an *action*, never an authority.
- [x] **XII. Workspace Isolation** — every lookup is scoped by workspace; the
      override is keyed to a test result which is keyed to a script which is keyed
      to a workspace.
- [x] **XIII. Manifest Is the Contract** — untouched. This feature reads audit
      output, not the manifest.
- [x] **XV. No Silent Side Effects (NON-NEGOTIABLE)** — the central article here,
      and it cuts **both** ways:
      - the gate must not present `clean` as a pass (FR-017);
      - **and** the gate must not silently disarm a trigger that was armed before
        a regeneration produced a `fail`. Auto-disabling is itself a silent side
        effect — an automation that stops firing for an invisible reason is worse
        than one that keeps firing visibly. The condition is surfaced instead
        (FR-013). This is spelled out because "disable it, obviously" is the
        instinctive answer and it is the wrong one.

**No violations. No Complexity Tracking entries required.**

## Decisions

### D1 — The gate lives inside `enableReadiness()`, not beside it

`enableReadiness(workspaceId, scriptId)` already returns `{ ready, reason }`, is
already called by `assertEnableAllowed()` on the enable path, by `create()` when
`enabled: true`, and by `toPublicDetailed()` to explain a blocked enable in the
UI. Three call sites, one function.

Adding the verdict check inside it means all three inherit it, including the UI
explanation — FR-013's visibility requirement is satisfied by construction rather
than by a second implementation that can drift.

**Rejected**: an Express middleware on the enable route. It would miss
`create({enabled: true})` (FR-002's exact bypass), and it would put a gate
decision somewhere `toPublicDetailed()` cannot reach, so the UI would have to
recompute it. Two implementations of one rule is how the two diverge.

### D2 — Verdict is read from the most recent `test_results` row, via one new repo method

`testResultRepo.listByScript()` already orders `desc(generatedAt)`. Add
`latestForScript(scriptId)` — the same query with `limit(1)`.

**On the query count.** `toPublicDetailed()` already does two queries per
trigger and this adds a third, so a page of *n* triggers costs 3*n*. That is
worse and it is accepted for this feature, because the alternative — caching the
readiness decision — reintroduces exactly the stale-permit path FR-005 exists to
close, and a permission decision that is allowed to be stale is not a permission
decision. If the trigger list becomes slow, the fix is to batch the lookups for
the whole list, not to cache the answer. Recorded here so the next reader does
not "optimise" it into a cache.

**Rejected**: denormalising the verdict onto `scripts`. It creates a second
source of truth for a gate input, which is the failure mode FR-015 and the CHECK
constraints exist to prevent.

### D3 — The asymmetry is enforced structurally, and tested by deletion

The verdict appears in exactly one place: a guard clause that returns
`{ ready: false }`. There is no code path where the verdict's value contributes to
a `ready: true`.

SC-002 tests this the only way it can be honestly tested: **delete the verdict
check entirely and confirm every previously-refused case is still refused for its
original reason.** If deleting the check causes some *other* case to start
passing, the check was load-bearing for a permit somewhere, and the asymmetry is
broken. An assertion cannot find that; a deletion can.

This is also why the check goes near the *end* of the refusal sequence rather
than the start: an earlier refusal must keep winning, so its reason is what the
operator sees. A script that has never run should be told it has never run, not
told about audit findings.

### D4 — The override is keyed to the `test_results` row, not to the trigger and not to the script

This is the decision that makes FR-014 (an override dies when the code changes)
free instead of fiddly.

A `test_results` row is created per generation finalisation and carries the
verdict and findings for **that** generated code. Key the override to
`test_result_id` and:

- regenerating the script produces a new row, so the old override cannot apply —
  no version comparison, no hash, no expiry logic;
- the override is inherently scoped to the findings the operator actually read,
  which is Q3's resolution A;
- it covers every trigger bound to that code, which is also Q3 resolution A;
- deleting a script cascades the test results and the overrides with them.

**Rejected**: a column on `triggers` (wrong grain — the operator judged the code,
not the schedule, and it would need re-consenting per trigger for no gain).
**Rejected**: a column on `test_results` (an override is an event with an author
and a time; folding it into the audited-result row loses that it was a separate
human act, and makes "was this ever overridden, and when" unanswerable after a
second override).

### D5 — The migration adds only the constraints that do not exist

Verified against `db/schema.ts` on 2026-08-04. **Already present, do not touch:**
`chk_scripts_status`, `chk_test_results_audit_verdict`,
`chk_execution_results_status`, `chk_triggers_type`, plus the three ticket
constraints.

**Added by this feature** (FR-016) — the two status-like columns on the gate path
that have no constraint:

| Column | Values | Why it is in scope |
|---|---|---|
| `test_results.overall_status` | the values the finaliser writes | same row the gate reads its verdict from |
| `trigger_fires.fired_by` | `manual`, `schedule`, `poll`, `webhook` | records which trigger type fired; the gate distinguishes exactly these |

**Explicitly not added**: `datasources.test_status`, `schema_entities.entity_type`.
Real gaps, unrelated to this gate, and named in spec.md's Out of Scope so that
"you missed some" has an answer.

A pre-migration data check is required: an existing row outside the allowed set
makes the migration fail on a live database. The task list includes checking
before adding, not after.

### D6 — Client: render the findings, and say what a verdict means

Two surfaces:

- **On the automation / test-result view** — the deterministic findings, each with
  code, severity and detail, clearly labelled as the parent's independent check
  and visually separate from the agent's self-reported checks that
  `buildVerdictFromTests` already renders (FR-020).
- **On the trigger control** — `enableBlockedReason` is already returned by
  `toPublicDetailed()` and already rendered. It gains the audit reason for free
  via D1. The override action lives here.

**`clean` renders as a statement, not a state.** No green check, no score, no
"passed". The copy says what the check actually did — a fixed list of
deterministic checks found nothing — in the same register as V4's
`PROMPT_BOUNDARY_EMPTY` copy, which exists for the same reason.

### D7 — No new dependency

The gate is a string comparison. The override is a row and a non-empty-string
check, which V1's zod primitives already express. Nothing is added.

## Sequencing

Five slices, each independently green and independently committable. The order is
chosen so the gate is never live without a way to see or escape it.

| # | Slice | Contents | Why here |
|---|---|---|---|
| 1 | Verdict reader | `latestForScript()`, verdict typing, fail-closed on unknown (FR-015) | Pure addition. Nothing gates yet. |
| 2 | The gate | verdict refusal inside `enableReadiness()`, covering enable and create-enabled | The feature's core. Blocks arming; blocks nothing else. |
| 3 | Findings on the client | audit findings rendered, honest verdict copy | Ships **before** the override so the operator can see what they would be overriding. Shipping 4 before 3 would produce an override button next to an unexplained refusal. |
| 4 | Override | table, migration (incl. the two CHECK constraints), route, service, visibility of the record | Now escapable, on the record. |
| 5 | Hardening | deletion pass, FR-021 regression check against the pre-feature suite, notes | The last four slices each shipped a wiring point no test covered. |

## Structure

```
foundry/packages/server/src/
  repositories/
    test-result.repo.ts          # + latestForScript()
    audit-override.repo.ts       # NEW
  services/
    trigger.service.ts           # + the verdict refusal in enableReadiness()
    audit-override.service.ts    # NEW — reason validation, record creation
  routes/
    scripts.ts                   # + override endpoint
  db/
    schema.ts                    # + audit_overrides, + 2 CHECK constraints
  drizzle/0012_*.sql             # NEW migration

foundry/packages/client/src/
  components/AuditFindings.tsx   # NEW
  lib/audit-copy.ts              # NEW — the honest verdict strings
  lib/foundry-client.ts          # + types
  lib/proxy-allowlist.ts         # + the override path
```

`audit-override.service.ts` is a separate service rather than more of
`trigger.service.ts` because an override is about a *script's audited code*, not
about a trigger — the same reasoning as D4. Keeping it in `trigger.service.ts`
would make it look per-trigger, which is exactly the model D4 rejected.

## Phase 0 / Phase 1 artifacts

- [research.md](research.md) — the measured facts this plan rests on, and the
  question of what happens to already-armed triggers
- [data-model.md](data-model.md) — `AuditOverride`, the gate decision shape, the
  constraint inventory
- [contracts/gate-decision.md](contracts/gate-decision.md) — the invariants the
  gate must hold, written so they can be read as test names
- [quickstart.md](quickstart.md) — how to verify each of the five slices
