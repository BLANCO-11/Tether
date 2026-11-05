# Tasks: Builder Clarification Loop — Durable Answer State

**Input**: Design documents from `/specs/20261001-174640-builder-clarify-loop/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/clarification-turn.md, quickstart.md

**Tests**: Included — required by constitution II (every behaviour change ships
with tests) and the spec's acceptance scenarios; contracts C1–C9 are the test
targets.

**Organization**: Tasks grouped by user story (US1/US2/US3 from spec.md).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

**Purpose**: baseline + failing reproductions that pin the field bug before any fix

- [X] T001 Run `pnpm --filter @foundry/server test` and `pnpm --filter @foundry/client test` on commit `70f07fa0`; record green baseline (any pre-existing failure documented in plan.md before proceeding)
- [X] T002 [P] Write failing regression tests for contract C1/C2 in `packages/server/src/services/builder/conversation.test.ts`: (a) answers survive a CLARIFY continuation round (invariant I1), (b) an answered unclear question is never re-asked in a later turn of the same build (field-transcript scenario: "relevant body message" asked once) — confirm both FAIL on current code
- [X] T003 [P] Write failing regression test for contract C6 in `packages/server/src/services/builder/conversation.test.ts`: bare `leave` defers any pending question (draft kept, question closed, no re-ask) — confirm FAILS on current code (`KEEP_AS_IS` at `normalise-value.ts:119` misses bare "leave")

---

## Phase 2: Foundational (Blocking)

**Purpose**: shared primitives every story needs

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T004 Add stable-id normalisation helper (reuse the existing `norm`/`quoted` normalisation in `packages/server/src/services/builder/goal-spec.ts` — export it if currently private; NO second normalisation implementation) with unit tests for casefold/whitespace/quote-stripping
- [X] T005 Extend `Conversation` interface in `packages/server/src/services/builder/conversation.ts` with `clarifyRounds?: number` and `deferred?: string[]` per data-model.md; ensure both ride through the existing `saveIncomplete`/`convOf` persistence round-trip (add a persistence round-trip assertion in `packages/server/src/services/builder/conversation.test.ts` — contract C9)
- [X] T006 Add `MAX_CLARIFY_ROUNDS = 5` constant beside `MAX_ROUNDS` in `packages/server/src/services/builder/build.ts` (research.md D4)

**Checkpoint**: shared primitives ready — user stories can proceed

---

## Phase 3: User Story 1 — An answer once given is never lost (Priority: P1) 🎯 MVP

**Goal**: `answers` accumulate across all turns; question identity is
content-keyed so stored answers match regenerated questions (D1+D2, FR-001/003)

**Independent Test**: scripted 3-question build (quickstart §1, contract
C1/C2/C3) — every prior answer present in state, zero re-asks

### Tests for User Story 1

- [X] T007 [P] [US1] Contract test C3 in `packages/server/src/services/builder/builder.service.test.ts` (or existing unclear-question test file): re-deriving the spec with reordered/renumbered `spec.unclear` yields identical hole ids (content-keyed); also assert `questionIdOf()` output stays a valid panel id (flow-chat-builder contract)
- [X] T008 [US1] Test invariant I6 in `packages/server/src/services/builder/conversation.test.ts`: `asks`/`needs_input` emitted iff an unanswered, non-deferred, non-bound question remains

### Implementation for User Story 1

- [X] T009 [US1] Change unclear hole ids from `unclear:${i}:${about}` to content-keyed `unclear:<norm(quote)>:<about>` at the construction site in `packages/server/src/services/builder/builder.service.ts` (`run()` round-1 unclear questions); audit every reader of that id format (`questionsFor`, `answer()`, `replyOf`, trace checks in `noLoopProblems`, `u.answered` set) and update each — incl. `scenarios/builder-slots.ts` slot regex
- [X] T010 [US1] Make `Conversation.answers` append-only: eliminate every `answers: {}` construction over a non-empty map in `packages/server/src/services/builder/conversation.ts` (`continueBuild` fresh Conversation, settle-persistence sites in `step`, KEEP_AS_IS path) — carry `{ ...prev.answers, ...new }` per research.md D1
- [X] T011 [US1] Enforce no-re-ask at pending-question selection in `step()` (`packages/server/src/services/builder/conversation.ts`): skip question ids that have a stored answer or appear in `deferred` (invariant I2)
- [X] T012 [US1] Make T002 tests pass; run `pnpm --filter @foundry/server vitest run src/services/builder/` — no regressions in `conversation.test.ts`, `build-questions.test.ts`, `builder.service.test.ts` (31 files / 404 tests green)
- [X] T031 [US1] Paraphrase-tolerant identity (contracts C2/C3, found by T029's live field replay): the model re-quotes a re-derived unclear question with an article dropped ("the relevant body message" → "relevant body message") — match stored answers/deferrals by normalised WORDS with a single-candidate rule (`answerFor`/`deferredFor` in `conversation.ts`), regression test in `conversation.test.ts`

**Checkpoint**: US1 fully functional — answers durable, identity stable, no re-asks

---

## Phase 4: User Story 2 — Objections are answered by the answer (Priority: P1)

**Goal**: a CLARIFY reply reaches both consumers in the same turn; open items
recompute deterministically and shrink (D3, FR-002/004/007/009)

**Independent Test**: seed build with open items O1/O2, reply resolving O1 →
next round's list contains only O2 with a reason (contract C4/C5)

### Tests for User Story 2

- [X] T013 [P] [US2] Contract test C4 in `packages/server/src/services/builder/conversation.test.ts`: pending `clarify:unsettled` reply is stored in `answers` under addressed stable ids AND passed to re-understanding in one turn
- [X] T014 [P] [US2] Contract test C5 (invariant I5) in `packages/server/src/services/builder/conversation.test.ts`: reply resolving nothing produces a turn stating the specific remaining item + reason — never a byte-identical re-ask presented as new; reply resolving an item closes it without another user turn (FR-004) — closure pinned by the pre-existing "reply re-understands and finishes it" test

### Implementation for User Story 2

- [X] T015 [US2] In `continueBuild` (`packages/server/src/services/builder/conversation.ts`): record the clarifying reply into `answers` under the stable ids of `conv.unsettled`'s addressed items, increment `clarifyRounds`, and keep `wasUnsettled` handling for wording (research.md D3)
- [X] T016 [US2] Implement code-side open-item closure: after the re-derived `run` in `step()`, recompute `unmet` against the updated spec + stored answers; remove satisfied items, restate retained ones with reason (data-model.md lifecycle; FR-004/FR-009) — recompute rides the existing replay (answerer returns stored answers every round); deferred owners filtered by `deferredGap`
- [X] T017 [US2] Unmappable-reply path (FR-007): when a CLARIFY reply changes nothing (no item closed, spec unchanged), respond naming which open item blocked it instead of regenerating the same question (contract C5); log actionable context per constitution V
- [X] T018 [US2] Make T013/T014 pass; run server builder suites

**Checkpoint**: US1+US2 — the field transcript's core loop is dead

---

## Phase 5: User Story 3 — The clarification loop terminates (Priority: P2)

**Goal**: bounded loop, real defer handling, truthful status (D4+D5,
FR-005/006/008)

**Independent Test**: unhelpful-answers script reaches terminal offer at round
5; bare `leave` at any question defers; statuses truthful (C6/C7/C8)

### Tests for User Story 3

- [X] T019 [P] [US3] Contract test C7 (invariant I4) in `packages/server/src/services/builder/conversation.test.ts`: at `MAX_CLARIFY_ROUNDS` the turn asks nothing and offers accept-or-stop; after accept/stop no further questions in that build
- [X] T020 [P] [US3] Contract test C8 (invariant I6) in `packages/server/src/services/flow-chat-builder.test.ts`: code-replay turns file truthful status — `needs_input` only with a real open question; distinguish "answered, 0 model calls" from stuck
- [X] T021 [P] [US3] Panel tests in `packages/client/src/components/flow/ChatPanel.test.tsx`: "Needs your input" never shown for a turn with no open question; 0-call answered turn renders as answered (FR-008)

### Implementation for User Story 3

- [X] T022 [US3] Broaden `KEEP_AS_IS` in `packages/server/src/services/builder/normalise-value.ts` to bare `leave`, `skip`, `ok`, `stop` and "it/this" forms (research.md D4); keep existing matched phrases working — ok/okay left to `CONFIRMS` (assumption confirmation never defers)
- [X] T023 [US3] Honor defer for ANY pending question in `builderAnswer` (`packages/server/src/services/builder/conversation.ts`) — not only `pending === CLARIFY`: add id to `deferred`, close question, keep draft, no model call (contract C6)
- [X] T024 [US3] Enforce `MAX_CLARIFY_ROUNDS` in `step()`/`continueBuild` (`packages/server/src/services/builder/conversation.ts`): terminal offer listing open items with proposed defaults, accept-or-stop; state persists `clarifyRounds` (contract C7)
- [X] T025 [US3] Truthful status at the seam: adjust `BUILDER_STATUS`/`builderTurnPatch` filing in `packages/server/src/services/flow-chat-builder.ts` and the render branch in `packages/client/src/components/flow/ChatPanel.tsx` so `needs_input` ⇔ real open question (contract C8) — no code change needed: once `step` stops filing phantom asks, existing filing/render is truthful; pinned by T020/T021 tests
- [X] T026 [US3] Make T003, T019, T020, T021 pass; run client + server suites (conversation 11/11, seam 19/19, panel 74/74)

**Checkpoint**: all three stories functional

---

## Phase 6: Polish & Cross-Cutting

- [X] T027 [P] Update builder paragraph in `AGENTS.md` (Chat builder: one-op/single-turn note) and `docs/` as affected by clarification-state behaviour; changelog entry (constitution VII — same PR) — AGENTS.md "Compiled builder" bullet added; repo has no CHANGELOG
- [X] T028 Remove scaffolds/throwaway scripts from implementation; confirm no dead code left from old positional-id path — probe file removed; `view2` fetch gone; only `builderStart` keeps a fresh empty `answers: {}` (correct: new build)
- [X] T029 Run quickstart.md end-to-end: field-transcript replay (§2), restart durability (§3), gates `node scripts/e2e-smoke.mjs`, `bash scripts/ui-honesty-check.sh`, `pnpm -r test && pnpm -r typecheck` — LIVE E2E done (HR-1/2/3 + field replay v1/v2 with bodyAskCount=1 + server-restart continuity); suites: builder 408/408, seam 19/19, panel 74/74, server tsc clean; ALL failures classified pre-existing (stash/checkout-verified): server 4 files/9 tests, client 3 files (flaky), client tsc MockPanel WIP, ui-honesty EngineCanvas legend WIP, e2e-smoke script sends no identity header (auth drift, feature untouched)
- [X] T030 Run `/speckit-comply`; resolve CRITICAL findings before declaring done

---

## Dependencies & Execution Order

### Phase Dependencies
- **Setup (P1)**: no dependencies
- **Foundational (P2)**: depends on P1; BLOCKS all user stories
- **US1 (P3)**: depends on P2 — must precede US2 (open-item closure reads accumulated answers)
- **US2 (P4)**: depends on US1 (stable ids + append-only answers are its substrate)
- **US3 (P5)**: depends on US1 (defer uses `deferred` + no-re-ask); independent of US2
- **Polish (P6)**: all desired stories complete

### Parallel Opportunities
- T002, T003 (different test concerns, same file → sequential edits, but independent authorship possible)
- T007, T008 parallel; T013, T014 parallel; T019, T020, T021 parallel (three different files)
- T027 parallel with T029

### Within Each Story
Tests first (must fail pre-fix), then implementation, then green-run of the story's suites.

## Implementation Strategy

**MVP = US1** (Phase 3): durable answers + stable identity alone eliminate the
repeated-question loop the field report shows. Validate with T002/T007/T012,
then extend.

**Incremental**: P2 → US1 → US2 (kills "did not settle these" repetition) →
US3 (bound + defer + truthful status) → Polish → comply.
