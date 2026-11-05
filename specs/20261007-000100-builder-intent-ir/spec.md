# Feature Specification: Builder Intent IR Rewrite (Strategy B)

**Feature Branch**: `20261007-000100-builder-intent-ir`

**Created**: 2026-10-07

**Status**: Active

**Input**: Evidence-gated rewrite of the chat workflow builder: replace inverted meaning/bookkeeping with a domain-agnostic Intent IR pipeline (pin-by-construction, staged meaning calls, dry-run preview, accept-with-gaps, grounded assistant). Server-first; UI polish later. Files are catalogue inputs when present.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Settled decisions do not flip (Priority: P1)

A non-technical user builds an automation in chat. After they answer one clarifying question, previously correct structure (reader, branch, actions, recipients, schedule) does not change unless their answer touches that part.

**Independent Test**: Replay harness measures collateral-change across answer turns on a frozen corpus; pin path keeps unrelated nodes.

### User Story 2 - Preview before production (Priority: P2)

Before the draft is treated as ready, the builder shows what a read will do (row count / shape from a redacted LIMIT dry-run), not only internal wording quizzes.

**Independent Test**: Dry-run module returns count+columns without putting sample row values into prompts.

### User Story 3 - Accept with gaps and ask about the flow (Priority: P3)

The user can accept a draft with named gaps, or ask what the automation does, without those messages being misfiled as answers to an open hole. Assistant answers are friendly and grounded in fact cards from IR+flow+catalogue.

**Independent Test**: Route golden set; accept-with-gaps pins gaps; about_flow does not mutate IR.

## Requirements

- FR-001: Durable Intent IR with pin-by-construction merge
- FR-002: Feature flag for new path; Intent IR default on after ship gate (opt out `BUILDER_INTENT_IR=0`)
- FR-003: Offline/replay harness + frozen corpus including ≥1 file-backed goal
- FR-004: Staged meaning calls (skeleton → bind → read forms) behind flag
- FR-005: Schema-grounded read dry-run (redacted)
- FR-006: Accept-with-gaps terminal
- FR-007: Route corpus + grounded assistant phrasing
- FR-008: Domain-agnostic (catalogue/schema only; no workspace-specific logic)
- FR-009: Compile types every placeable read result (or refuses); never hand Opaque to `add_reader` for aggregates the compiler emitted
- FR-010: Banded-read code-emit is part of Intent IR (one flag), not a second prototype switch

## Success Criteria

- Flip/collateral-change near 0 on pinned answer turns (harness)
- Correct-as-asked improvable and measurable vs baseline
- Assistant invents zero steps/tools not on the fact card
- Server path complete before UI redesign
- HR band corpus ≥5/6 complete with Intent IR alone; untyped aggregate is a compile finding
