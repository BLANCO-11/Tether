# Feature Specification: Audit Verdict as an Asymmetric Gate (Surface C)

**Feature Branch**: `krt/guardrail_validation`

**Created**: 2026-08-04

**Status**: Draft

**Input**: User description: "Audit verdict as an asymmetric gate (roadmap slice V5, surface C). Make the deterministic generation audit able to BLOCK irreversible actions without ever PERMITTING anything. Concretely: a `fail` audit verdict blocks enabling or scheduling a trigger for that script; a `clean` verdict must unlock nothing — absence of findings is not evidence of correctness (constitution Article XV, Article X). Gating must stay asymmetric: findings can block, their absence must not permit. Also in scope: an explicit operator override that records who overrode, when, and a required non-empty reason (no silent side effects), and DB CHECK constraints on `audit_verdict` and the other status enums so a gate cannot be bypassed by an uninterpretable persisted value. The audit verifies plausibility, not correctness — it once marked `clean` a script that emailed 0 of 11 recipients — so no UI or API may present a clean verdict as a correctness guarantee. Branch: this lands on the existing krt/guardrail_validation branch (GIT_BRANCH_NAME=krt/guardrail_validation), no new worktree."

---

## The design rule, stated once, in one sentence

**Findings can block; their absence must not permit.**

Everything else in this document is a consequence of that sentence. If a
reviewer reads only one line of this spec, it should be that one, because the
tempting version of this feature — "make the audit decide whether an automation
is allowed to run" — is the version the constitution forbids, and it is forbidden
for a reason this repository has already measured.

### Why the symmetric version is forbidden

`generation-audit.service.ts` computes `fail` when any finding is `high`, `warn`
when any finding exists, and `clean` when none do. That last branch is the
dangerous one: `clean` does not mean "this automation is correct." It means **no
rule in an 11-code deterministic checklist fired**. The two are wildly different
claims, and the repository has a measurement showing exactly how different.

`trigger.service.ts:40` records it in a comment written before this feature:

> Measured 2026-07-26, a script with `status="completed"`, `tests_passed=true`
> and audit verdict `clean` hardcoded `period="2023-10"` and emailed 0 of 11
> people.

A `clean` verdict on a script that did nothing it was asked to do. Any design
where `clean` unlocks an action would have armed that automation on a schedule.

So the audit gets exactly one new power — **refusal** — and gains no power to
approve. Approval, where it exists at all, continues to come from the evidence
that already gates enabling: a real execution that a human looked at.

### What already exists, and what this feature is NOT rebuilding

The roadmap's V5 section was written before V1 shipped and is out of date in two
places. Verified against the code on 2026-08-04:

| Roadmap claim | Actual state | Consequence for this spec |
|---|---|---|
| "DB CHECK constraints on `audit_verdict` and the other status enums (hole 8)" | **Already shipped.** `chk_test_results_audit_verdict`, `chk_scripts_status`, `chk_execution_results_status`, `chk_triggers_type` all exist in `db/schema.ts`, with tests in `db/schema.test.ts`. | Hole 8 is *mostly* closed. This feature closes only the columns the gate actually reads or writes, and does not re-litigate the rest. See FR-016. |
| "The audit is advisory: it never flips script status" | True, and it stays true. | The gate never writes `scripts.status`. It refuses an action; it does not restate the script's condition. |

Also already present, and load-bearing for this design: `enableReadiness()` in
`trigger.service.ts` already refuses to enable a trigger unless the script is
`completed` **and has at least one succeeded execution**. That function is the
seam this feature extends. It is worth noting that it already embodies the
asymmetry rule — it explicitly refuses to treat `tests_passed=true` plus a
`clean` verdict as sufficient evidence — so this feature is continuing an
existing design decision rather than introducing a new one.

### The gap this feature must also close to be usable at all

**No client surface renders the generation audit.** `auditVerdict` and
`auditJson` are persisted and returned by the tests endpoint, but nothing in
`packages/client` reads either; the UI's pass/fail comes from
`buildVerdictFromTests` (`lib/adapters.ts:410`), which is derived entirely from
the agent's **self-reported** booleans. This was found during V4 (T054) and
recorded there.

That matters here and not merely as tidiness: a gate that blocks an action for a
reason the operator cannot see is a gate that will be worked around, mistrusted,
or filed as a bug. So surfacing the findings that caused a block is **in scope**,
as part of US2 — not as a general "build the audit UI" project, which is not.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A failing audit blocks arming an automation (Priority: P1)

An operator generates an automation. The deterministic audit finds a high-severity
problem — say the code reads an environment variable that appears in no manifest
and no task, or writes to a table the manifest never declared. The operator then
tries to put that automation on a schedule, or to enable a webhook that fires it
without a human present.

Today that succeeds, provided the script is `completed` and has one succeeded
execution. After this feature it is refused, and the refusal names the findings.

**Why this priority**: This is the entire feature. Arming a trigger is the point
at which generated code stops being something a human runs and watches, and
becomes something that runs unattended, repeatedly, with real credentials. It is
the most irreversible action the product offers, and it is the only place where a
deterministic refusal is both defensible and cheap.

**Independent Test**: Generate or fixture a script whose latest audit verdict is
`fail`, give it a succeeded execution so the existing readiness conditions pass,
then attempt to enable a trigger for it. The attempt is refused with a reason that
names the finding codes. No other behaviour changes.

**Acceptance Scenarios**:

1. **Given** a script whose latest audit verdict is `fail` and which has a
   succeeded execution, **When** an operator enables a trigger bound to it,
   **Then** the request is refused, and the refusal states that the audit
   found high-severity problems and lists their codes.
2. **Given** the same script, **When** an operator creates a trigger with
   `enabled: true`, **Then** it is refused identically — creating an armed
   trigger is the same act as arming one, and must not be a way around the gate.
3. **Given** a script whose latest audit verdict is `warn`, **When** an operator
   enables a trigger, **Then** it is **allowed**, because only `fail` blocks.
4. **Given** a script with **no** audit record at all, **When** an operator
   enables a trigger, **Then** the existing readiness rules decide, and the
   absent audit neither blocks nor permits.
5. **Given** a script whose latest audit verdict is `fail`, **When** an operator
   runs it manually once, **Then** the run proceeds — this gate governs *arming*,
   not manual execution, which is exactly the supervised path the existing
   readiness rule wants people to take.

---

### User Story 2 - The operator can see why, in the findings' own words (Priority: P1)

The operator who is refused can see which findings caused the refusal, what each
one means, and which part of the generated code triggered it — without reading
the database or the server log.

**Why this priority**: Equal-first with US1, and deliberately so. A block whose
cause is invisible is indistinguishable from a bug. Since no client surface
renders the audit at all today, shipping US1 alone would produce a product where
arming fails with a message about findings the operator has no way to inspect.

**Independent Test**: With a `fail`-verdict script, open the automation in the UI
and confirm the findings are listed with code, severity and detail; confirm the
trigger control explains the block and points at them.

**Acceptance Scenarios**:

1. **Given** a script with a `fail` verdict, **When** the operator views it,
   **Then** each high-severity finding is shown with its code, its severity, and
   the specific detail that triggered it.
2. **Given** a script with a `clean` verdict, **When** the operator views it,
   **Then** the surface states what `clean` does and does not mean, and **does
   not** present it as a pass, a score, a green check, or a correctness claim.
3. **Given** a script with a `warn` verdict, **When** the operator views it,
   **Then** the findings are shown and it is stated that they do not block
   arming.

---

### User Story 3 - An operator can override a block, on the record (Priority: P2)

The audit is deterministic and therefore sometimes wrong — the comment at
`generation-audit.service.ts:444` records that `invented_endpoint` at severity
`high` once marked a correct script as failing. An operator who has read the
findings and judges them false must be able to proceed, and that judgment must
become a durable record rather than a silent bypass.

**Why this priority**: A gate with no override becomes a gate that gets deleted
the first time it is wrong at an inconvenient moment. But the override is only
safe once US1 and US2 exist, so it is P2 rather than P1.

**Independent Test**: With a `fail`-verdict script, attempt the override without a
reason (refused), then with a reason (allowed), then confirm the record persists
with the reason, the timestamp, the verdict and findings as they stood at the
moment of override, and whatever actor attribution is available.

**Acceptance Scenarios**:

1. **Given** a blocked enable, **When** an operator overrides with a non-empty
   reason, **Then** the trigger is enabled and an override record is persisted.
2. **Given** a blocked enable, **When** an operator attempts to override with an
   empty or whitespace-only reason, **Then** it is refused — a reason field that
   accepts `""` records nothing and is worse than none, because it produces an
   audit trail that looks complete.
3. **Given** an override was recorded, **When** the script is regenerated and a
   new audit produces a new `fail` verdict, **Then** the old override does **not**
   carry over — it applied to the code that was audited, not to the script name.
4. **Given** an override was recorded, **When** anyone views the trigger or the
   script, **Then** the fact that it was overridden, and the reason, are visible —
   an override that is only discoverable in the database is a silent side effect.

---

### Edge Cases

- **A script with several test results.** Which verdict gates? The most recent
  one for that script, by generation time. An older `clean` must never be able to
  outrank a newer `fail`; that would be a permit-by-staleness path.
- **A script regenerated after being armed.** The gate runs at arming time. A
  trigger already enabled when the code is regenerated into a `fail` verdict is
  *not* silently disabled by this feature — silent disabling is itself a side
  effect (Article XV), and an automation that stops firing for an invisible
  reason is a worse failure than one that keeps firing. What must happen is that
  the condition becomes **visible**. See FR-013.
- **An audit that failed to run.** `audit_verdict` is nullable, and the audit is
  wrapped so a crash does not fail generation. A null verdict is "unknown", and
  unknown must neither block nor permit — it falls through to the existing rules.
  Treating unknown as `fail` would make an audit outage into a product outage;
  treating it as `clean` would make crashing the audit into a bypass. It is
  neither, and it is stated in the surface as unknown rather than shown as clean.
- **A persisted verdict outside the known set.** Already impossible for
  `audit_verdict` thanks to `chk_test_results_audit_verdict`. The gate must still
  not treat an unrecognised value as permissive if one ever appears — see FR-015.
- **Manual execution of a `fail` script.** Explicitly still allowed. This gate is
  on arming.
- **A trigger of type `manual`.** A manual trigger fires only when a human presses
  it, so it is not the unattended path. See FR-004 for which trigger types the
  gate covers.

---

## Requirements *(mandatory)*

### The gate

- **FR-001**: The system MUST refuse to enable a trigger whose bound script's
  most recent audit verdict is `fail`.
- **FR-002**: The system MUST apply the same refusal when a trigger is created
  already enabled, so that creation is not a path around the gate.
- **FR-003**: The refusal MUST state that the deterministic audit found
  high-severity findings, and MUST name the finding codes that caused it.
- **FR-004**: The gate MUST apply to trigger types that fire without a human
  present — `schedule`, `poll` and `webhook`. Whether it also applies to `manual`
  is resolved in Q2 below.
- **FR-005**: The gate MUST select the verdict from the **most recent** audit
  record for that script. An older record MUST NOT be able to permit what a newer
  one refuses.
- **FR-006**: A `warn` verdict MUST NOT block. Only `fail` blocks.
- **FR-007**: A `clean` verdict MUST NOT grant, unlock, skip, shorten or weaken
  any other check. Specifically, the existing readiness conditions — script
  `completed`, code present, and at least one succeeded execution — MUST still
  all be required when the verdict is `clean`.
- **FR-008**: A missing or null verdict MUST neither block nor permit; the
  decision falls through to the existing readiness conditions unchanged.
- **FR-009**: The system MUST NOT disable, archive, or alter the status of any
  script or trigger as a result of an audit verdict. The gate refuses an action;
  it changes no stored state of its own accord.

### The override

- **FR-010**: An operator MUST be able to override an audit-verdict block for a
  specific script and its current audited code.
- **FR-011**: An override MUST require a reason of at least one non-whitespace
  character, and MUST be refused without one.
- **FR-012**: An override record MUST persist the reason, the moment it was made,
  the verdict and finding codes it was made against, an identifier for the audited
  code so the record cannot silently transfer to different code, and whatever
  actor attribution the system can honestly provide (see Q1).
- **FR-013**: The override, and the blocking condition itself, MUST be visible on
  the surfaces where the trigger and the script are viewed — including the case
  where a trigger was armed before the code was regenerated into a `fail`.
- **FR-014**: An override MUST apply only to the audited code it was recorded
  against. Regenerating the script MUST require a fresh override.

### Integrity of the gate's inputs

- **FR-015**: If a persisted verdict value is not one of the known values, the
  gate MUST treat it as blocking rather than permitting, and MUST log it as a
  defect. Fail-closed on an uninterpretable gate input is the only safe direction.
- **FR-016**: The system MUST add CHECK constraints to the status-like columns
  the gate reads or writes that do not yet have one, so a gate input cannot be an
  arbitrary string. Columns already constrained MUST NOT be duplicated or
  redefined. (Verified 2026-08-04: `audit_verdict`, `scripts.status`,
  `execution_results.status` and `triggers.type` already have constraints;
  `test_results.overall_status` and `trigger_fires.fired_by` do not.)

### Honesty of the surfaces

- **FR-017**: No surface — API response, UI element, log line or copy string —
  MAY present a `clean` verdict as evidence that the automation is correct, or as
  a pass, score, or green state. The surface MUST state what a clean verdict
  actually means: that a fixed list of deterministic checks found nothing.
- **FR-018**: The client MUST render the audit findings themselves, not a derived
  summary of them, so that a refusal is explicable from the UI alone.
- **FR-019**: Copy describing the gate MUST distinguish blocking from
  disapproving: the audit refused an irreversible action, it did not judge the
  automation wrong.
- **FR-020**: The existing self-reported verdict shown by
  `buildVerdictFromTests` MUST NOT be conflated with the deterministic audit. If
  both are shown, they MUST be distinguishable as agent self-report versus
  independent check (Article X).

### Behaviour preservation

- **FR-021**: No request that succeeds today MUST fail after this feature, except
  precisely the arming of a trigger for a script with a `fail` verdict.
- **FR-022**: Manual, human-initiated execution of a script MUST be unaffected by
  the verdict.

---

## Clarifications

### Q1: What does "who overrode" mean, given the parent API has no user identity?

**Context**: FR-012 requires the override to record an actor. But the parent
API's authentication is `requireApiKey` — a **single shared API key**, verified
in `auth.middleware.ts`. There is no per-user identity at this boundary. The
roadmap records this as `security.md` §9 **R2**: `backendToken` is minted by the
client and never verified, so every guard V2 and V3 added is workspace-level, not
per-user. The client *does* have sessions with roles, but the parent cannot
verify any claim the client forwards.

So "who" cannot be answered honestly with a user identity today, and a field
called `overridden_by` holding a client-supplied string would be an attribution
the system cannot stand behind — the exact kind of unearned signal Article XV
exists to keep out.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Record only what is verifiable: timestamp, request id, and the reason. Name the field so it does not imply identity, and state in the record that the actor is unattributed pending R2. | Honest today. The override trail says "someone holding the API key, at this time, for this reason". Weakest attribution, zero false confidence. |
| B | Record a client-forwarded actor label **explicitly marked unverified**, alongside the verifiable fields. | More useful in practice — most overrides will come through the UI, which does know who is signed in — provided the unverified marking survives into every surface that displays it. Risk: the marking gets dropped by a later reader and the label starts being read as identity. |
| C | Block this feature on fixing R2 (real user identity at the parent API). | Correct end state, but R2 is its own feature — it means verifying `backendToken`, which changes every guard V2 and V3 built. Sequencing V5 behind it delays the gate for a reason unrelated to gating. |

**Resolution**: **A**, proposed. Record only what the system can verify —
timestamp, request id, reason — and name the field so it does not imply identity.
Rationale: B's "unverified" marking is one careless reader away from becoming an
attribution the system cannot support, and the whole point of Article XV is not
to emit signals stronger than the evidence behind them. C sequences a working
gate behind an unrelated feature. **Revisit when R2 lands**: at that point the
override record gains a real actor, and the field added here should be replaced
rather than supplemented, so that no record ever mixes verified and unverified
attribution under one name.

### Q2: Does the gate apply to `manual` triggers?

**Context**: FR-004 covers `schedule`, `poll` and `webhook` — the trigger types
that fire unattended. `manual` fires only when a person presses it, which is the
supervised path the existing readiness rule actively wants people to use, and
which FR-022 keeps open.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Gate only `schedule`, `poll`, `webhook`. `manual` triggers may be enabled regardless of verdict. | Matches the stated rationale — the gate is on *unattended* execution. Keeps the supervised path that the readiness rule depends on fully open. A person pressing a button is present to see what happens. |
| B | Gate all four types uniformly. | Simpler rule, easier to explain and harder to get wrong in code. But it blocks the very act — run it once by hand and look at the result — that the existing readiness gate requires before anything can be armed, which could deadlock a script whose only route to a succeeded execution is a manual trigger. |

**Resolution**: **A**, proposed. Gate `schedule`, `poll` and `webhook` only.
B's deadlock is not hypothetical: `enableReadiness()` already requires a
succeeded execution before anything can be armed, and for a script whose only
trigger is `manual`, gating `manual` would make the succeeded execution
unreachable — the gate would block the only route to satisfying its own
precondition. FR-004 is written to the three unattended types for that reason.

### Q3: Where does the override live — on the trigger, or on the script's audit?

| Option | Answer | Implications |
|--------|--------|--------------|
| A | On the script's audited code: one override covers every trigger bound to that code version. | Matches what is actually being judged — the operator reviewed the *findings about this code*, not a particular schedule. One decision, recorded once. Enabling a second trigger for the same reviewed code does not re-prompt. |
| B | Per trigger: each arming decision is overridden separately. | Every irreversible act gets its own explicit consent, which is the stricter reading of Article XV. Costs repetition, and the repeated reason fields will degrade into "see above" — a trail that looks complete and says nothing. |

**Resolution**: **A**, proposed. Scope the override to the audited code, because
that is what the operator actually reviewed. B's per-trigger consent is the
stricter reading of Article XV on paper, but the predictable outcome is a second
and third reason field reading "as above" — a trail that is formally complete and
carries no information, which is worse than one well-written record. FR-014
preserves the property B is really protecting: the override dies when the code
changes.

---

## Key Entities

- **Audit verdict** — the most recent deterministic assessment of a script's
  generated code: `clean`, `warn`, `fail`, or absent. Already persisted; this
  feature adds a reader, not a writer.
- **Audit finding** — a single deterministic observation with a code, a severity
  and a detail. Already persisted inside the audit record; this feature surfaces
  it.
- **Gate decision** — the outcome of evaluating a script against the arming
  conditions: allowed, or refused with a stated reason. Not persisted; computed
  per request, and already modelled by `EnableReadiness`.
- **Override record** — a durable statement that a named human judged specific
  findings against specific audited code to be acceptable, with a reason and a
  time. New.

---

## Success Criteria *(mandatory)*

- **SC-001**: A script whose latest deterministic audit verdict is `fail` cannot
  be armed for unattended execution without an explicit, recorded override — in
  100% of attempts, across every route that can arm one.
- **SC-002**: No path exists by which a `clean` verdict causes any other check to
  be skipped, shortened or weakened. Demonstrated by deleting the verdict check
  entirely and observing that every previously-refused case is still refused for
  its original reason.
- **SC-003**: An operator shown a block can identify the specific findings that
  caused it, from the UI alone, without consulting the database or server logs.
- **SC-004**: Every override in the system has a non-empty reason. Zero records
  with an empty or whitespace-only reason are creatable through any route.
- **SC-005**: No surface presents `clean` as a correctness claim. Verified by
  review of every string and element that renders a verdict.
- **SC-006**: Every request that succeeds before this feature still succeeds
  after it, except arming a trigger for a `fail`-verdict script. Verified against
  the pre-feature test suite.
- **SC-007**: Each new wiring point survives a deletion pass — deleted
  individually, the suite fails. The last four slices each shipped at least one
  wiring point that did not, so this is a stated criterion rather than an
  assumption.

---

## Assumptions

- The audit continues to run where it runs today, at generation finalisation, and
  this feature adds no new invocation of it.
- `test_results` remains the store of record for verdicts; no new verdict store is
  introduced.
- The existing readiness conditions in `enableReadiness()` remain in force
  unchanged; the verdict check is added alongside them, not in place of them.
- Overrides are rare. No pagination, search or bulk-management surface is
  required for them in this feature.
- The gate is evaluated per request rather than cached. Caching a permission
  decision that is meant to reflect the latest audit would reintroduce the
  stale-permit path FR-005 exists to close.

---

## Out of Scope

- **Making `clean` unlock anything.** Not a simplification to be revisited later;
  it is the rule.
- **Auto-disabling triggers when a regeneration produces a `fail`.** Discussed in
  Edge Cases and deliberately excluded — silent disabling is a side effect. The
  condition is made visible instead.
- **Blocking manual execution.** The supervised path stays open.
- **Building the full generation-audit UI.** This feature renders the findings
  needed to explain a block and to state honestly what a verdict means. A general
  audit console is a separate feature.
- **Fixing R2 (real user identity at the parent API).** Its own feature; Q1
  decides how this one behaves in the meantime.
- **LLM-based assessment of generated code.** Non-deterministic, and cannot be a
  gate under Article X.
- **Reworking `buildVerdictFromTests`.** FR-020 requires the two be
  distinguishable, not that the self-report be removed.
- **Adding CHECK constraints to enum-like columns the gate does not read**
  (`datasources.test_status`, `schema_entities.entity_type`). Real, small, and
  not this feature's business.

---

## Dependencies

- V1's validation kernel, for request-shape validation of the override input.
- V2's role gate on the client, for whichever surface exposes the override.
- The existing `generation-audit.service.ts` and its finding codes.
- The existing `enableReadiness()` seam in `trigger.service.ts`.

---

## Standards impact

`security.md` §8 currently says, in effect, *do not present a signal as a gate*.
This feature makes one signal into a gate — in one direction only. That text must
be **reconciled, not contradicted**: the amendment should say that a finding may
block an irreversible action, and that the absence of findings still permits
nothing. The roadmap already flags V5 as requiring this amendment.

The amendment is made **after** this ships, via `/speckit-update-standards`, per
the cross-cutting rule. It is not part of the implementation.
