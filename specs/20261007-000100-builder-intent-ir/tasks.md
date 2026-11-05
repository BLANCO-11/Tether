# Tasks: Builder Intent IR Rewrite

## Phase 0 — Harness

- [x] T0.1 Snapshot WIP branch + rewrite feature branch
- [x] T0.2 Replay harness `builder-replay.ts` + rewrite corpus (multi-workspace, file-backed goal)
- [x] T0.3 Baseline recorder under `plan/builder-rewrite/`
- [x] T0.4 Package script `builder:replay`

## Phase 1 — Pin

- [x] T1.1 `intent-ir.ts` pin-by-construction merge (node ids, not word heuristics alone)
- [x] T1.2 Wire into `understand`/`correct` when `BUILDER_INTENT_IR`
- [x] T1.3 Tests: collateral restore on untouched nodes

## Phase 2 — Staged plan

- [x] T2.1 `plan-stages.ts` skeleton → bind → reads
- [x] T2.2 Flag-gated use from `makePlan` path
- [x] T2.3 Tests for stage schemas / merge

## Phase 3 — Dry-run

- [x] T3.1 `read-dry-run.ts` redacted LIMIT execution interface
- [x] T3.2 Preview text helper + schema-column preview on accept when flag on
- [x] T3.3 Unit tests with fake executor

## Phase 4 — Accept

- [x] T4.1 Persist `acceptedGaps` on IR conversation state (already partial — complete + tests)
- [x] T4.2 Accept pins gaps so re-ask cannot reopen

## Phase 4b — Memory / route / assistant

- [x] T4b.1 Route golden corpus tests
- [x] T4b.2 `assistant-voice.ts` fact-card phrasing
- [x] T4b.3 Assert about_flow path does not call writeRevision (call-graph / unit)

## Phase 5 — Cutover

- [x] T5.1 `config` / env `BUILDER_INTENT_IR`
- [x] T5.2 Document flag; default on after ship gate (opt out `BUILDER_INTENT_IR=0`)
- [x] T5.4 UI: fold `Preview:` dry-run / column lines; Accept-with-gaps + Skip chips on CLARIFY/PART
- [x] T5.5 Wire live RO LIMIT dry-run against datasource credential (schema preview fallback; skipped under Vitest)
- [x] T5.3 Export IR snapshot on save when flag on (`conversation.intentIr`); `removeNodes`/`patchIr` for edit/delete

## Phase 6 — Banded read code-emit (prototype)

Gate: HR absence corpus with `BUILDER_BAND_EMIT=1` — completes ↑ vs Intent-IR-only, no wrong-SQL on A06, banded wall time down (fewer propose calls).

- [x] T6.1 `band-read.ts`: lower `band_count` arms → `DbOperationSpec` with `caseWhen` (first-match weights + half/full indicators)
- [x] T6.2 Flag `BUILDER_BAND_EMIT` (default off); wire into understand write path before propose
- [x] T6.3 Unit tests vs absence-band oracle shape (9.5→0, 4.75→0.5, 4.74→1)
- [x] T6.4 Replay `hr-absence-bands-corpus` with `--intent-ir --band-emit`; record under `plan/builder-rewrite/`
  - **2026-10-07**: 5/6 complete (A01–A04, A06); A05 incomplete (orphan input “last week”). Opaque fix: compute-agg aliases typed `numeric` so `add_reader` accepts banded reads. A02: 1 call / 19s.

## Phase 7 — Type seam + fold band-emit into Intent IR

Gate: HR absence corpus with **only** `BUILDER_INTENT_IR=1` (no `BUILDER_BAND_EMIT`) still ≥5/6 complete; untyped aggregate/output is a **compile finding**, never an Opaque reader at `add_reader`.

- [x] T7.1 Compile assigns types for every aggregate result (compute + sum/avg/count); refuse with `untyped_output` / `untyped_aggregate` when a placeable result would be Opaque
- [x] T7.2 Unit tests: compute/agg aliases typed; min/max over untyped column → compile finding (not silent Opaque)
- [x] T7.3 Fold band code-emit into Intent IR (`bandEmitEnabled` ≡ `intentIrEnabled`); retire `BUILDER_BAND_EMIT` as a separate gate (env removed from `.env.example`; `--band-emit` harness alias → Intent IR)
- [x] T7.4 Replay `hr-absence-bands-corpus` with `--intent-ir` only; record under `plan/builder-rewrite/hr-absence-intent-ir-p7.json`
  - **2026-10-07**: Full run 3/6 (A02/A04/A06); A01 recovered on retry → **4/6 stable**. A03 plan clause-order unmet (not type seam); A05 orphan “last week”. A02 still 1 call / ~17s with Intent IR alone — fold confirmed. Gate ≥5/6 not met this n; blocker is plan findings, not Opaque/add_reader.

## Phase 8 — Plan validity (clause order + orphan period) + HR corpus expand

Gate: HR pack (A01–A06 + new cases) with `--intent-ir` ≥5/6 on A-series; A03/A05 no longer fail on clause-order / unused “last week”; new cases exercise branch / math / loop.

- [x] T8.1 `normalisePlan`: action on `if:N` whose clauses precede the condition’s → align clauses (equivalence), so “earlier clause than condition” is not a stuck finding
- [x] T8.2 Band emit: when the read contract has a period/date, emit `work_date` (or best date col) filters `period_start`/`period_end` so `applyContract` can bind relative inputs (A05)
- [x] T8.3 Unit tests for T8.1–T8.2 (`plan-findings-p2`, `band-read`)
- [x] T8.4 Expand `hr-absence-bands-corpus.json` with simple + complex HR goals (branch, math, for-each); update `hr-absence-bands.md`
- [x] T8.5 Replay expanded corpus `--intent-ir`; record under `plan/builder-rewrite/hr-absence-intent-ir-p8.json`
## Phase 9 — Band coverage equivalence (emitted bands own their meaning)

Gate: A-series ≥5/6 with `--intent-ir`; A01/A05 no longer fail on “nothing built” / unused threshold for edges the CASE WHEN encodes.

- [x] T9.1 `bandClauseCovers` uses the same clause split as accounting (`goalClauses`) and owns clauses by edge markers **or** label-word overlap with measure/arm words
- [x] T9.2 After band emit, cover from the measures that were emitted (not only surviving `summary.bands`); solver treats threshold quotes inside covered text as used
- [x] T9.3 Unit tests: A01-style goal + banded covers → no unaccounted; “9.49” / “0” in a covered band clause → not unused
- [x] T9.4 Replay A01–A06 `--intent-ir`; record `plan/builder-rewrite/hr-absence-intent-ir-p9.json`

## Phase 10 — Pin band arms from the goal (emit is not optional)

Gate: when Intent IR is on and the goal states ≥2 band weights with edges, the plan always carries `band_count` arms so code-emit runs; A-series ≥5/6.

- [x] T10.1 `bandArmsFromGoal`: extract first-match arms from goal weights/edges (domain-agnostic)
- [x] T10.2 `withBandForms`: under Intent IR, inject/fill `band_count` measures from those arms when missing/empty; keep new_read + present-arm equivalences
- [x] T10.3 Unit tests: A01-style goal with no band_count → arms pinned; CONTROL: goal with one threshold and no weights → no invent
- [x] T10.4 Replay A01–A06 `--intent-ir`; record `plan/builder-rewrite/hr-absence-intent-ir-p10.json`

## UAT follow-up — oversized mail body → attachment

- [x] T11.1 When `foundry_email_send` body exceeds `MAIL_MAX_BODY_BYTES` and is tabular/step output, promote to attachment + brief body (do not refuse); prose still refused
- [x] T11.2 Unit + route tests; rebuild server image

## UAT follow-up — LOP band build with empty / invented sources

Gate: a natural-language banded absence goal (no schema jargon) gets a written `new_read`; never stuck as email-only with `attach_rows` hole.

- [x] T12.1 `withBandForms`: when `band_count` has empty sources or an invented reader ref, inject/rewrite to a catalogue `<ds>.new_read` (longest-prefix); never ask the person for table/query names
- [x] T12.2 Unit tests: empty sources → inject; invented `….query.…` → rewrite; existing saved-reader remap still holds

## UAT follow-up — Phase 1 pin incomplete on clarify / post-complete rebuild

Gate: US1 — after a clarify answer or a post-complete meaning change, previously written readers (and pinned sources/sinks) stay; the catalogue keeps `newReads` and local readers; MEM3 must not drop a settled written read under Intent IR. Measured fail: flow `e7412613` (rev1 had `banded_absences` + email; after “accumulated”/answer → sources `[]`, invented `employee_absence_days`).

⚠ Phase 1 shipped `pinSpecByIr` on `correct()`, but three call sites still stripped the reader before pin could help: `newReads:!corrected`, `rewrite → local=[]` + `rewriteReads`, and MEM3 filtering answered reads out of the catalogue.

- [x] T13.1 Clarify / corrected turns: keep `conv.local` (never clear on rewrite under Intent IR); `newReads: true` on corrected turns; skip MEM3 catalogue filter when Intent IR is on
- [x] T13.2 `builderRebuild` / `builderStart({ rebuild })`: seed catalogue + conversation from `flowLocalReaders`; after understand, `pinSpecByIr` against the head revision's spec (empty `sources` restores prior)
- [x] T13.3 `pinSpecByIr`: when prior has sources and the proposal empties them without a touch id, restore prior sources (defense in depth; merge already keeps nodes — assert it)
- [x] T13.4 Unit tests for T13.1–T13.3 (`clarify-preserve-t13.test.ts`, `intent-ir.test.ts`); rebuild server image

## UAT follow-up — fold proto Weight= extract into live pin

Gate: `bandArmsFromGoal` accepts `Weight half = 0.5` / `half at 0.5` (not `= 0 to` ranges); live band emit still skips propose when Intent IR is on.

- [x] T14.1 Extend `bandArmsFromGoal` with Weight=/at spellings + `N to M` edges from extract-map-emit
- [x] T14.2 Unit test for Weight= pin; CONTROL `= 0 to` is not weight 0
- [x] T14.3 Quick live compare: Weight= goal via `builder:proto --compare` — **complete, 1 call, 16.6s**, `banded_absences` code-emitted (no propose); `tmp/proto-live-weight-eq.json`

## Deferred (post-commit, before prod trust of band math)

- [x] T15.1 Fail closed when edge↔weight pairing scrambles (UAT Excel goal: `4.74` must not become present; require `≥9.5→0`, `≥4.75→0.5`, `<4.75→1`) — `bandArmsByMagnitude` + `bandArmsConsistent`; prove refuses inconsistent arms
- [x] T15.2 Band SQL oracle in CI (fixed hours → half/full/total) — `evalBandWeight` + existing SQLite emit oracle
- [ ] T15.3 Grain: for-each department vs employee drives `groupBy`
- [ ] T15.4 Decide fate of `extract-map-emit` / `builder:proto` harnesses (local-only until T15.1)

## Workflow duplicate (workflows list)

- [x] T16.1 `POST …/flows/:flowId/duplicate` — copy draft model + contracts into new unarmed draft (`name (copy)`, fresh id); `flows.write`
- [x] T16.2 Client RowMenu Duplicate beside Delete; navigate to the copy

