# Implementation Plan: Builder Intent IR Rewrite

**Branch**: `20261007-000100-builder-intent-ir` | **Date**: 2026-10-07

## Summary

Replace the chat builder control loop with Intent IR (model = meaning, code = bookkeeping/verification), evidence-gated behind `BUILDER_INTENT_IR`, server-first.

## Technical Context

- **Stack**: existing `@foundry/server` builder under `packages/server/src/services/builder/`
- **Entry**: `conversation.ts` / `flow-chat-builder.ts`
- **Substrate kept**: catalogue, DbOperationSpec→compileOperation, flow-edit, canvas
- **Flag**: `BUILDER_INTENT_IR` enables new path; **default on** after ship gate (opt out with `=0`)

## Architecture

See programme plan (Strategy B). Modules:

| Module | Role |
| :--- | :--- |
| `intent-ir.ts` | IR types, merge/pin by node id |
| `plan-stages.ts` | staged skeleton/bind/reads when flag on |
| `read-dry-run.ts` | LIMIT dry-run redacted preview |
| `assistant-voice.ts` | fact card → friendly phrasing |
| `route-corpus` tests | confusable route golden set |
| `scenarios/builder-replay.ts` | Phase 0 harness |

## Phases

P0 harness → P1 pin → P2 stages → P3 dry-run → P4 accept → P4b memory/route/assistant → P5 flag cutover wiring → P6 band code-emit prototype → P7 type seam + fold band-emit into Intent IR → **P8 plan validity (clause order + orphan period) + HR corpus expand**.

### Phase 7 (architecture, not patches)

- **Type seam**: `compileOperation` must type every aggregate / placeable result column. `null` → Opaque → `add_reader` refuse is a compile finding at emit time, not a silent solver failure.
- **One flag**: banded CASE WHEN emit runs when `BUILDER_INTENT_IR` is on. Drop the second gate (`BUILDER_BAND_EMIT`); do not stack more flags for the same write path.

### Phase 8 (plan validity)

- **Clause order**: `normalisePlan` realigns an action on `if:N` whose clauses precede the condition's — equivalence, not a stuck re-ask (A03).
- **Orphan period**: band emit adds `work_date` (or best date col) `period_start`/`period_end` filters when the read contract has a period/date, so `applyContract` + solver can bind "last week" (A05).
- **Corpus**: expand HR pack with simple list/filter/avg and complex branch / loop / math / schedule cases.

### Phase 9 (band coverage equivalence)

- A written banded read **owns** the goal clauses its arms encode — same split as accounting (`goalClauses`), markers from edges/weights **or** label-word overlap with measure/arm words. Not string suppression for A01/A05.
- Threshold values whose quote sits inside those covered clauses are used (solver), so upper bounds like `9.49` next to arm edge `9.5` are not “unused”.

### Phase 10 (pin band arms)

- When Intent IR is on and the goal states band **weights** with **edges**, code extracts arms and ensures `band_count` is on the plan — emit is not optional when the model omits them.
- Domain-agnostic extraction (count-as / equals / between / at-least); no HR vocabulary in the pin.

## Testing

Colocated vitest + `builder:replay` script. No live default without harness before/after.
