# Implementation Plan: Builder Clarification Loop — Durable Answer State

**Branch**: `20261001-174640-builder-clarify-loop` | **Date**: 2026-10-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/20261001-174640-builder-clarify-loop/spec.md`

## Summary

The chat builder loses the user's answers between clarification rounds because
the Conversation working copy is rebuilt with an empty answer set on every
continuation, question identities are positional (so an answer can no longer be
matched to its question after the spec is re-derived), the planner that raises
"not settled yet" items never receives the reply that is meant to settle them,
and the clarification exchange has no termination bound. The fix makes answer
state **accumulating, identity-stable, delivered to every consumer, and
bounded** — four structural invariants enforced at the state-machine level in
`packages/server/src/services/builder/`, not prompt wording.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, ESM everywhere

**Primary Dependencies**: existing server stack (drizzle-orm + pg, zod);
`@foundry/flow-edit`; no new dependencies

**Storage**: PostgreSQL via drizzle; the conversation already persists inside
the flow's incomplete build record (`flow.build.goalSpec.conversation`,
written by `flowService.saveIncomplete`) — this feature changes what is written,
not where (Spec Assumption)

**Testing**: Vitest, colocated `*.test.ts` next to the source under test;
existing suites `builder/conversation.test.ts`, `builder/build-questions.test.ts`,
`flow-chat-builder.test.ts`, `client ChatPanel.test.tsx`

**Target Platform**: Linux server + web client status rendering

**Project Type**: pnpm monorepo web service (server package is the change surface)

**Performance Goals**: N/A — turn latency is dominated by model calls; code
paths added are O(open-questions) replays already occurring today

**Constraints**: D-294 no-loop invariants (trace checked by `noLoopProblems`,
build.ts:9-13, 432-441) must remain intact; one-question-per-turn UX pinned by
existing tests must be preserved

**Scale/Scope**: one conversation state machine, its seam in
`flow-chat-builder.ts`, defer/answer matching in `normalise-value.ts`, and
status truthfulness in `ChatPanel.tsx`; ~6 source files + tests

## Baseline (T001, recorded on `70f07fa0` before any fix)

`pnpm --filter @foundry/server test`: **3879 passed / 9 failed / 23 skipped
(3911), 4 failed files** (765 s). Not green — pre-existing failures. One known
non-mitigated failure: `src/demo/alt/swap-rehearsal.test.ts`
("dataset-specific knowledge leaked into the platform"). Final per-file
classification deferred to end-of-implementation: every file failing in the
final run is stashed-verified against `70f07fa0` (test file only, tree
pristine) to prove pre-existing, or fixed. The 2 new regression tests
(conversation.test.ts) were written during that run's window and fail by
design until the fix lands.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Gate | Verdict | Evidence |
|------|---------|----------|
| I. Spec-First | PASS | This feature dir has spec.md + plan.md; tasks.md via /speckit-tasks |
| II. Test-First | PASS | Cross-turn loop reproduction tests are the acceptance vehicle (see research.md); all listed in tasks |
| III. Code Review | PASS | /speckit-comply before PR; no bypass |
| IV. Simplicity | PASS | Zero new dependencies; changes are state fields + transitions in existing modules; no new layer/service |
| V. Observability | PASS | Round-bound hits and unmappable replies are stated to the user and logged with conversation context (FR-007, FR-009) |
| VI. Branch Discipline | PASS | Timestamp branch `20261001-174640-builder-clarify-loop` created by the spec-kit hook |
| VII. Documentation Currency | PASS | plan.md + spec.md same PR; agent context (AGENTS.md builder paragraph) updated in implementation |
| VIII. Secrets | PASS | No secrets involved |

No violations → Complexity Tracking table empty (no entries).

## Project Structure

### Documentation (this feature)

```text
specs/20261001-174640-builder-clarify-loop/
├── plan.md              # this file
├── research.md          # Phase 0 — decisions resolving the design unknowns
├── data-model.md        # Phase 1 — Conversation/OpenItem state model
├── quickstart.md        # Phase 1 — runnable validation guide
├── contracts/
│   └── clarification-turn.md  # Phase 1 — turn-level behavioural contract
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
packages/server/src/services/builder/
├── conversation.ts        # turn state machine — answer accumulation, round bound, defer (primary)
├── builder.service.ts     # run() — stable question identity, answer delivery to solver rounds
├── normalise-value.ts     # KEEP_AS_IS defer matching
├── conversation.test.ts   # cross-turn regression tests (primary test surface)
└── build-questions.test.ts
packages/server/src/services/
└── flow-chat-builder.ts   # needs_input truthfulness at the chat seam
packages/client/src/components/flow/
├── ChatPanel.tsx          # status label truthfulness (no model call / needs input)
└── ChatPanel.test.tsx
```

**Structure Decision**: single-package change inside the existing builder
module — no new directories, no new abstractions beyond Conversation fields.
The conversation state machine is the single owner of clarification state
(Constitution IV: three similar lines beat one premature abstraction).

## Phase 0 / Phase 1 outputs

- **research.md** — the four structural decisions with rationale and rejected alternatives
- **data-model.md** — Conversation schema delta, OpenItem states, transition rules
- **contracts/clarification-turn.md** — observable turn contract the tests pin
- **quickstart.md** — the exact repro transcript from the field report as a validation scenario

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | — | — |
