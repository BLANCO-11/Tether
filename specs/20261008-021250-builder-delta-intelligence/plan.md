# Implementation Plan: Builder Delta Intelligence

**Branch**: `20261007-184817-builder-intelligence` | **Date**: 2026-10-08 | **Spec**: specs/20261008-021250-builder-delta-intelligence/spec.md

**Input**: Feature specification (6 user stories: bands, patch-edits, router validation, drafted defaults, spec-grounded verification, delta-scoped questions).

## Summary

Model proposes intent, code proves structure. Six slices move decisions from code-guess to model-propose-then-code-verify, each paired with its existing verifier: contiguous band partition (`bandArmsConsistent` + `bandEmitProves` refuse-gates stay), patch-first edits (revision-hash pin + rebuild fallback), validate-then-capture routing (pure validation, one bounded extra call), drafted email defaults (confirm gate + open-ask fallback), spec-grounded verification answers (code reads spec, model phrases), delta-scoped unclear (exact-norm settled ban-list at question emission). No verifier deleted, no bound widened, no new loop.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22, ESM (`"type": "module"`)

**Primary Dependencies**: zod (validation), drizzle-orm + pg (Postgres `foundry_parent`), gateway inference (`gpt-6-luna` via `modelChooser`), `@foundry/flow-edit` (workspace:*)

**Storage**: Postgres — `flows` (goalSpec/revisions), `flow_chat_threads` / `flow_chat_turns` (transcript + findings), `flow_revisions` (model_json/goal_spec/build_trace)

**Testing**: Vitest per package, colocated `*.test.ts`; offline replay fixtures from stored flow `73f11284` revisions/turns (no live model calls for proof)

**Target Platform**: Linux server (Docker `infra-server`), Next.js client on :4002 unaffected

**Project Type**: web-service (Express API + compiled builder pipeline)

**Performance Goals**: plan turns stay within today's latency envelope; staged path (+10–15s decode) unchanged; router adds at most one bounded call on validation mismatch only

**Constraints**: MAX_ROUNDS=3, MAX_CLARIFY_ROUNDS=5, unclear array cap 4, one re-understanding per round — all unchanged

**Scale/Scope**: 6 slices, ~5 source files touched (`plan.ts`, `band-read.ts`, `conversation.ts`, `chat-route.ts`, `build.ts`/`delivery.ts`, `chat-answers.ts`), proof-first then implement

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Spec-First**: spec written (`spec.md` + checklist); plan here; tasks next; no source touched yet. PASS.
- **II. Test-First**: every slice proved by offline replay tests before implementation; control fixtures must be byte-identical. PASS (by construction).
- **III. Review**: `/speckit-comply` before merge; CRITICAL findings first. PENDING (at implement time).
- **IV. Simplicity**: no new deps, no new layers; each slice is a narrowed rule inside existing files (~10–40 lines each). New prompt text and one ban-list filter justified in research. PASS.
- **V. Observability**: replay fixtures log which gate fired per case; inference labels unchanged. PASS.
- **VII. Docs currency**: spec/plan/tasks + builder docs updated in same PR. PENDING (at implement time).

## Project Structure

### Documentation (this feature)

```text
specs/20261008-021250-builder-delta-intelligence/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (replay fixture schemas)
└── tasks.md             # Phase 2 output (NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
packages/server/src/services/builder/
├── plan.ts              # S1 contiguous partition + S6 settled ban-list
├── band-read.ts          # S1 emit alignment (no new logic expected)
├── conversation.ts       # S2 patch-first + delta-scoped question emission
├── chat-route.ts         # S3 validate-then-capture
├── chat-edit.service.ts  # S2 patch path (carryOut scoping)
├── build.ts / delivery.ts# S4 drafted defaults + confirm
├── chat-answers.ts       # S5 spec-grounded verification
└── goal-spec.ts          # S6 narrowed never-unclear rule + exact-match drops
```

**Structure Decision**: Existing builder slice layout kept; no new packages or directories. Proof fixtures live under the feature dir as JSON snapshots of stored revisions/turns.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | All slices narrow existing rules; no new abstraction | N/A |
