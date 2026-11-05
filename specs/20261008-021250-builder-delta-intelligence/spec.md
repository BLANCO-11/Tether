# Feature Specification: Builder Delta Intelligence

**Feature Branch**: `20261007-184817-builder-intelligence`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Make the builder more intelligent and capable in handling user query, context and intent — give the model the right components and architecture to work freely but with right tools and boundaries. Address: wrong comparison operators (<=/>= instead of </>), email body/subject defaults, workflow Q&A failures, edit misreads, missing intent questions when unclear, re-asking settled info on updates. Prove the approach with prototype tests before implementing."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Correct threshold semantics on first build (Priority: P1)

A person states absence rules with strict comparisons ("less than 9.5", "less than 4.75"). The builder produces band boundaries that partition the ranges contiguously with no overlap and no dropped boundary, and asks one bounded question when the stated boundaries under-determine the partition instead of guessing.

**Why this priority**: Wrong operators double-count rows — a correctness bug in emitted SQL, observed live on the absence flow (both bands pinned to 4.75, 9.5 dropped).

**Independent Test**: Can be fully tested by running the band-arm extraction over the stored absence goal plus a unit matrix (A01/A02 oracle goals, non-attendance weights) and delivers correct contiguous arms.

**Acceptance Scenarios**:

1. **Given** the absence goal ("half day = working hours less than 9.5, full day = working hours less than 4.75"), **When** the plan pins band arms, **Then** three contiguous arms result (full below 4.75, half 4.75–9.5, present at/above 9.5) and emitted SQL has no overlapping `<=`/`>=` on one boundary.
2. **Given** a goal with fewer boundaries than weights need, **When** the plan runs, **Then** one bounded unclear question is asked and nothing is built on a guess.
3. **Given** A01/A02 oracle goals and non-attendance weight goals, **When** re-run after the change, **Then** arms are byte-identical to today (no regression).

---

### User Story 2 - Edits fix what changed, keep the rest (Priority: P1)

A person corrects a built automation ("the db step is overlapping … fix that"). A single-step fix patches in place and every untouched step (including the email sink) survives; only multi-step changes trigger a whole replan.

**Why this priority**: The live turn-7 correction was refused wholesale by the lost-actions guard to protect an unmentioned sink — a correct fix blocked by whole-plan comparison.

**Independent Test**: Can be fully tested by replaying turn 7 against the stored revision 3 spec and delivers an applied patch with the sink intact.

**Acceptance Scenarios**:

1. **Given** a single-step correction on a built flow, **When** the edit runs, **Then** the touched step is fixed, all other steps are byte-identical, and no refusal mentions unmentioned steps.
2. **Given** a multi-step change, **When** the edit runs, **Then** the whole-replan path with the existing lost-actions guard applies unchanged.

---

### User Story 3 - Follow-up messages land where meant (Priority: P2)

While a question is pending, a message that does not answer it ("employee details" during a subject ask) is treated as a new intent, not consumed as the answer; a message that does answer it is captured.

**Why this priority**: Turns 4–5 of the live session show capture-swallows-intent: "employee details" became the email subject.

**Independent Test**: Can be fully tested by replaying turns 4–5 against the stored thread state and delivers correct routing in both directions.

**Acceptance Scenarios**:

1. **Given** a pending question and a reply that fails the hole's validation, **When** routed, **Then** the message is re-routed as a new intent and the question stays open.
2. **Given** a pending question and a fitting reply, **When** routed, **Then** the answer is captured exactly as today.

---

### User Story 4 - Sensible email defaults with confirm, not interrogation (Priority: P2)

When the goal adds email delivery without stating body/subject, the builder drafts both from the goal's own content and asks one confirmation ("use this?") instead of two open questions.

**Why this priority**: Turns 3–4 asked body then subject as open questions; the model had zero discretion under the constants rule despite having everything needed to draft.

**Independent Test**: Can be fully tested by replaying turn 3 and delivers one confirm carrying drafted values.

**Acceptance Scenarios**:

1. **Given** an email sink with no stated body/subject, **When** the delivery slice runs, **Then** one confirmation question carries goal-derived drafts marked as drafted.
2. **Given** the person rejects the draft, **When** answered, **Then** the flow falls back to today's open ask with no silent invention.

---

### User Story 5 - Verification questions get evidence, not summaries (Priority: P2)

A person asks whether something already built is right ("are half days counted as 0.5?"). The builder answers from the spec's own bands with a quoted value instead of a generic summary.

**Why this priority**: Turn 6 got "reads a read…" while the spec's bands literally said 0.5 — the answer path never consults the plan.

**Independent Test**: Can be fully tested by replaying turn 6 against revision 1 and delivers a yes/no with quoted band evidence.

**Acceptance Scenarios**:

1. **Given** an about-flow message containing a verifiable numeric/operator claim, **When** answered, **Then** the reply quotes the spec value with yes/no and names the band.
2. **Given** a neutral "what does it do" question, **When** answered, **Then** today's summary path applies unchanged.

---

### User Story 6 - Only the delta is ever asked (Priority: P1)

Across any number of sequential updates, the builder never asks about settled words — questions anchor only to the change. Correcting a settled word re-opens exactly that word, once.

**Why this priority**: Re-asking settled info tells the person nothing they said mattered; edit-storms amplify re-derivation drift into repeated re-asks.

**Independent Test**: Can be fully tested by a soak replay of N sequential updates against stored revisions and delivers zero settled-anchored questions.

**Acceptance Scenarios**:

1. **Given** N sequential updates to a built flow, **When** each rebuilds, **Then** zero questions anchor to settled words.
2. **Given** a correction touching a settled word, **When** rebuilt, **Then** exactly one question covers that word and nothing else re-opens.
3. **Given** mechanical shaping words (sort/limit/group-by when unambiguous), **When** planned, **Then** no question is raised, as today.

---

### Edge Cases

- What happens when the goal states contradictory boundaries (scrambled present ≤ half)? Refuse with reason (existing `bandArmsConsistent` gate), never emit wrong SQL.
- How does the system handle two messages arriving before the first replan lands? Out of scope — needs turn-queueing infrastructure; flagged as the next wall.
- What happens when a patch's pinned revision hash mismatches head? Discard patch, fall back to whole rebuild.
- What happens when a drafted default is rejected twice? Fall back to open ask, then stated unmet — existing bounds hold.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Band capture MUST extract every stated boundary and infer the present floor from the maximum stated ceiling, building contiguous non-overlapping intervals; under-determined partitions MUST ask one bounded question, never guess.
- **FR-002**: Single-step edits MUST patch the touched step in place with revision-hash pinning; untouched steps MUST be byte-identical; hash mismatch MUST fall back to whole rebuild.
- **FR-003**: Router MUST validate a reply against the pending hole before capture; on validation failure it MUST re-route the message as a new intent and keep the question open.
- **FR-004**: Email body/subject slots with no stated values MUST be drafted from goal content, marked as drafted provenance, and confirmed with one question; rejection MUST fall back to the open ask.
- **FR-005**: About-flow messages containing verifiable claims MUST be answered from the spec with quoted evidence; neutral questions MUST keep today's summary path.
- **FR-006**: Rebuild questions MUST anchor only to delta words (goal minus settled quotes, exact-norm match); settled-anchored flags MUST be hard-dropped in code; corrections touching settled words MUST re-open exactly those words.
- **FR-007**: All existing verifier gates (consistency, emit-prove, lost-actions on whole rebuilds, MAX_ROUNDS/MAX_CLARIFY_ROUNDS, one-shot questions) MUST remain in force; no bound widened, no gate deleted.

### Key Entities

- **Band partition**: contiguous non-overlapping intervals derived from stated boundaries plus inferred present floor; owns emitted comparison operators.
- **Settled words**: quotes the head revision placed (sources/sinks/values/bands/groupings); frozen facts on rebuild, never questioned.
- **Delta**: goal words minus settled quotes; the only scope questions may anchor to.
- **Drafted default**: model-proposed slot value with drafted provenance; requires confirmation, never applied silently.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The stored absence goal produces contiguous arms including the 9.5 floor with no overlapping operators, verified in SQL output.
- **SC-002**: Stored turn 7 replay applies the overlap fix with the email sink byte-identical and no refusal.
- **SC-003**: A 10-update soak replay raises zero settled-anchored questions and converges to the same final spec as the equivalent single goal.
- **SC-004**: All control fixtures (A01/A02 oracles, non-attendance weights, pin tests, plan tests) produce byte-identical results after the change.
- **SC-005**: A person correcting a built flow gets a fixed step or one precise question — never a re-ask of settled info and never a refusal protecting unmentioned steps.

## Assumptions

- Stored revisions/turns of flow `73f11284` are retained as offline replay fixtures; no live model calls needed for proof.
- Turn-queueing for concurrent messages is out of scope (infrastructure, next wall).
- The `BUILDER_PLAN_STAGES=1` staged path stays the default; monolith path remains as fallback.
- Per-flow model override and gateway transport are unchanged.
