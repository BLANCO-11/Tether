# Quickstart: proving Builder Delta Intelligence offline

Proves all six slices without UI or live model calls, using stored flow `73f11284` as replay fixtures.

## Prerequisites

- Branch `20261007-184817-builder-intelligence`, clean tree
- `pnpm --filter @foundry/server test` green on touched files (baseline)
- Flow `73f11284` revisions + thread `0b79cbbc` present in local Postgres (or JSON snapshots under `specs/20261008-021250-builder-delta-intelligence/contracts/fixtures/`)

## Steps

1. **Snapshot fixtures**: dump revisions 1–3 goal_specs + turns 1–7 into `contracts/fixtures/` (script in tasks.md). Verify snapshots match DB byte-for-byte.
2. **S1 bands**: run `bandArmsFromGoal` matrix — stored absence goal → expect 3 contiguous arms incl. 9.5 floor; A01/A02/non-attendance controls → byte-identical to today. Emit SQL → assert no overlapping `<=`/`>=` on one boundary.
3. **S2 patch**: replay turn 7 against revision-3 spec — expect applied patch, email sink byte-identical, no refusal string.
4. **S3 router**: replay turns 4–5 — "employee details" re-routes as new intent with subject still open; fitting reply captures.
5. **S4 drafts**: replay turn 3 — one confirm carrying goal-derived body/subject with drafted provenance; reject path → open ask.
6. **S5 verification**: replay turn 6 — answer quotes 0.5 band with yes; neutral question → today's summary.
7. **S6 delta soak**: apply 10 sequential stored updates — assert zero settled-anchored questions; final spec equals single-goal equivalent; correction re-opens exactly its word.
8. **Regression**: full `builder/` suite — only intended-behaviour deltas change; all controls green.

## Expected outcomes

- Fixed cases change (assertions above), control cases byte-identical.
- Any re-ask of settled info, any dropped sink, any silent guess = slice fails.
- Green proof → `/speckit-tasks` → implement; red → revise plan, never the fixtures.
