# Component model gaps — Dify (`workflow-component-behaviour.md`) vs the repo at `3a5a637`

> **⚠ Describes the compiled builder's step panel, which now opens only for flows not built by Forge.**
> The current rules for panes, pages and components are in [`README.md`](README.md); kept for that history.

The reference the component-model plan implements against. Per gap: what the md
requires, what the code does, the anchor for both, and the stage that closes it.
"md" below is `workflow-component-behaviour.md` at the repo root; section numbers
are its `§` headings.

| # | The md requires | What the code does | Closed by |
|---|---|---|---|
| 1 | Node type declares its properties (§26, §39) | four hand-synced kind tables; per-kind hand-written forms (`FlowCanvas.tsx:147-175`, `StepInspector.tsx:122-165`, `FlowReview.tsx:72-75`, `ChatWorkbench.tsx:127-149`; `StepInspector.tsx:446-790` switches on `step.kind` into `CallInputs` / `TransformNeeds`+`RawExpression` / `CodeNeeds`+`CodeBody` / `ApprovalForm` / `BranchForm` / `MergeForm`) | Stages 2, 5 |
| 2 | Properties are typed values — static / variable / template / collection / output-definition (§9) | one opaque expression string per step (`paramsExpr`, `inputExpr`, `expr`, `conditionExpr`, `summaryExpr`); `parseParams` (`client/src/lib/flow-params.ts`) returns `null` for anything the builder did not write | Stage 3 |
| 3 | Store a reference, not a value (§31) | `paramsExpr` is a Pebble+jq program; the panel guesses and refuses (`EXPRESSION_REFUSAL`, `client/src/lib/step-binding.ts:43`, renders "set in the expression") | Stage 3 |
| 4 | Inputs are typed ports with a source selector (§33, §37) | `paramsExpr` / `inputExpr` strings; bindings recovered heuristically by `flow-params.ts` and `step-io.ts` (`client/src/lib/step-io.ts`, 545 lines: bound/unset/unknown/whole/self + editable) | Stage 3 |
| 5 | Outputs are declared, named and typed (§35) | `code` only (`contract.output` in `step-contract.service.ts`); every other kind's shape comes from the catalogue's caution text (`flow-output-shape.ts`, read through `outputSummary()`) | Stages 2, 4 |
| 6 | Edges are control flow, selectors are data flow (§6) | true already — `dependsOn` vs read expressions (`canvas-model.ts`); the panel's Connections section is the gap | Stage 5 |
| 7 | Type compatibility is validated (§7, §28) | no type system on the client; server has shape checks keyed to a kind's output segment only (`flow-validator.service.ts`: `OUTPUT_STEP_KINDS`, `EXPECTABLE_KINDS`) | Stages 2, 3 |
| 8 | A registry lets the frontend render the panel (§39) | no registry anywhere; `StepKind` is duplicated in `client/src/lib/canvas-model.ts:53` and `flow-edit/src/index.ts:50` | Stage 2 |
| 9 | A component that cannot run is not offered | `notify`/`action`/`report`/`end`/`trigger` are authorable by the drafter (`flow-step-shapes.ts:95` teaches `notify`; `flow-drafted-shape.ts:134` accepts the aliases) and unemittable (compiler throws `step kind "…" is not emittable`, `flow-compiler.service.ts:899-905`; `routes/steps.ts:33` calls `notify` "the one kind still unimplemented") | Stages 2, 3 |
| 10 | The panel is Basic / Inputs / Behavior / Outputs / Advanced (§8) | About this step / What it needs / What it does / Outputs / What happens on failure / Connections / Verify / Raw / Remove (`StepInspector.tsx:446-790`) | Stage 5 |
| 11 | Any property is settable from chat | `set_field` with 13 string names (`flow-edit/src/ops.ts:78-90`); `model`, `temperature`, `url`, `method`, `headers` exist nowhere in the model | Stage 6 |

## Drift notes (recorded, not re-researched)

**Four kind tables.** `StepKind` metadata is hand-synced across `FlowCanvas.tsx`,
`StepInspector.tsx`, `FlowReview.tsx` and `ChatWorkbench.tsx`, and they have already
drifted (`branch`'s colour differs between the canvas and the inspector). Stage 2.4
collapses all four into reads of `NODE_TYPES`.

**Dead surface.** `Bot` is imported and unused in the canvas module; `--k-agent` in
`globals.css` has no consumer; `TASK_TYPE_FALLBACK` (`FlowCanvas.tsx`) displays engine
task types the runtime will not emit — the compiler (R8) owns that mapping, and a client
table claiming one is a claim the runtime may not honour. Stage 2.4 deletes all three.

## Wave boundary (locked)

Wave 1 (this plan): `llm`, `http`, `transform` + `mode:"template"`, `branch` (typed
test, labelled "If / Else"), flow-level End/Output rows, and today's `tool` /
`datasource` / `query` / `code` / `approval` / `merge` carried into the registry.
Wave 2: human-input form/buttons/delivery (wave 1 keeps today's `approval` gate
fields), classifier, parameter extractor, list operator. Wave 3: iteration, loop,
per-step failure handling. Registry entries for waves 2–3 exist with
`runtime: null` — declared, never offered, refused at save by name.

## Deferred doc-table items (recorded 2026-09-10, Stage 2)

- `llm.modelVar` (variable-mode model picker) and `llm.jinja2`: open questions in
  `docs/nodes/llm.md` §9 with no decided shape — omitted from the registry until
  wave 2. The save refuses nothing over them; there is simply no field to set.
- `http` file outputs (`files`): no end-to-end file plumbing exists — moved to
  wave 2 with the doc's §9 entry.
- `docs/nodes/output.md` proposed extending the `end` step kind; the plan's
  flow-level-rows decision (Stage 4.5) supersedes it — no `end` kind, one
  declaration. `docs/nodes/merge.md` additive fields (`sourceVars`, `groups`,
  `varType`) are wave-2+; the registry `merge` entry keeps today's `sources`.

## Manual walkthrough log

- 2026-09-11, dev client (`next dev`, current tree) + rebuilt current server,
- admin login, manual builder on a new flow ("Manual pass llm check"):
- palette offers the LLM row (registry-driven); placing it worked only after
- fixing `blankStep` (it threw "declared but not runnable yet" for llm/http —
- Stage 4 wired the emitters but never the blank).
- LLM panel sections in order: Step/Basic → Inputs → Behavior → Outputs →
- Advanced → Connections → Try → Remove. Behavior controls render from the
- registry (Model picker lists the deployment's real models; Creativity,
- Temperature, Top P, Prompt, Context step, Structured output).
- Model → `gpt-5.6-luna`, Temperature → 0.3, prompt text: saved ("Build this
- flow" needed a flow name first — button stays disabled without one, correct),
- reloaded `/flows/<id>/builder`, reselected the step: values persisted
- (verified in revision JSON, not just on screen).
- A blank prompt correctly blocks save ("Still needed" findings, no error).
- End boundary card opens Returned values; adding a row, naming it
- `escalations`, binding source llm → text (the picker lists the registry
- outputs `text`/`reasoning_content` only after the candidateFields fix —
- before it the field list was empty for registry kinds): dirty flag rises,
- Save draft persists revision 3 with the row (verified in revision JSON).
- Two crashes fixed along the way, both new-panel-meets-old-shape: the model
- picker crashed on a server predating `models` (now a staleness sentence),
- and `authoredToStoredFlow` threw for llm/http (now written typed) and
- dropped flow-level `output` on write while `authoredFromModel` dropped it
- on read (both now round-trip, pinned by tests).
- Chat-side End selection initially rendered the Start panel
- (`ChatWorkbench` passed `START_ID` for any boundary); fixed to pass the
- selected boundary through. Start boundary still shows its read-only report.
- NOT covered by hand: placing http/branch/approval/transform/code/merge in
- the UI (palette rows verified present; placement + key writes covered by
- unit tests, and the chat harness built http end-to-end with url/method/
- headers sets, compile, try-step, publish and run). Participants: automated
- browser walkthrough, headless.

## Verification notes

- Stage-4 integration (2026-09-10): unit gates green (`pnpm -r typecheck`,
  full `pnpm -r test`, golden-YAML byte proof for the wave-1 fixture).
  `kestra:verify`/`kestra:phase3` NOT run — the engine API is unreachable from
  this shell (`foundry-kestra` healthy on `infra_kestra-net`, but
  172.20.0.2:8080 times out and nothing listens on localhost:8080; the port
  is not published to the host). Prerequisite for Stage 7: fix the network
  path (publish the port or run harnesses inside the compose network).
