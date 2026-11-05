# Output (end, upgraded)

Status: **DRAFT** — 2026-09-09

## 1. Purpose

Turn the `end` step from an unemittable placeholder into a Dify-style Output step: name the variables the workflow returns to its caller, one `NAME + SOURCE` row each, merged across every Output step into a single result payload. It does not stop execution; it declares what the run hands back.

## 2. Dify behavior

What we steal (from `local://survey-entry-exit.md` §8):

- One Output node carries ≥1 output variable; each is a NAME (becomes the API-response / tool-result key) + SOURCE (any upstream node's output). Multiple vars per node, drag-reorderable.
- Names MUST be unique across ALL Output nodes; a later same-name variable overwrites an earlier one (later-wins).
- Typed variables: `string number integer boolean object file array[string] array[number] array[object] array[boolean] array[file]`.
- Output does NOT stop execution; parallel branches continue after it. Multiple Output nodes combine into one final result — same branch in placement order, parallel branches in completion order (first-executed first).
- Partial-data rule: a branch without Output contributes nothing; a workflow WITHOUT any Output succeeds but returns no data.

What we skip:

- Answer (Chatflow-only streamed chat message, variable-order-controlled streaming — `local://survey-entry-exit.md` §7) is OUT OF SCOPE, not merely deferred design. Reason: we have no chatflow surface — no chat UI to stream into, no staged-delivery semantic anywhere in the product. An `end` step never renders text to a person; it only names return data. Revisit only if a chatflow surface appears (§9).

## 3. Model mapping

Extend the stored kind `end` — no new kind, no rename. Today an `end` step stores (`packages/client/src/lib/flow-authoring.ts` `blankStep`: `{ kind: "end", id, ref, paramsExpr: "[{}]", dependsOn? }`; the `AuthoredStep` call-like variant in `packages/flow-edit/src/index.ts` — `{ kind: "trigger" | "datasource" | "query" | "tool" | "action" | "notify" | "report" | "end"; id; ref; paramsExpr; extraInputs?; dependsOn?; timeoutSeconds?; retry? }`; `StepKind` member + `KIND_LABEL["end"]` in `canvas-model.ts` / `StepInspector.tsx`).

New stored fields on `end`:

| Field | Type | Default | Validation |
| :--- | :--- | :--- | :--- |
| `outputs[]` | `Array<{ name: string; source: OutputSource }>` where `OutputSource = { from: "step"; stepId: string; field: string } \| { from: "input"; inputId: string } \| { from: "literal"; value: string }` (the existing `flow-expr` `Source` shape — no new source vocabulary) | `[]` | `name` unique across ALL `end` steps in the flow (not just per step), valid identifier (`ID_RE`-shaped: `^[a-z][a-z0-9_]{0,62}$` keeps it API-key-safe); `source` must resolve — `stepId` names an existing upstream step and `field` a readable output path on it (compiler checks; panel warns when the shape table says otherwise), `inputId` an existing flow input |
| `type` (per row) | `"string" \| "number" \| "integer" \| "boolean" \| "object" \| "file" \| "array[string]" \| "array[number]" \| "array[object]" \| "array[boolean]" \| "array[file]"` (Dify's list, verbatim) | inferred from the bound source's shape where the panel knows it, else `"string"` | must be one of the eleven; the compiler coerces per Kestra input-type rules — a declared type the value cannot satisfy is a refused save, not a silent truncation |

Field migration (exact):

- `ref` / `paramsExpr` on existing `end` steps: carried over verbatim, then ignored by the new panel — `paramsExpr` stays on the record so old revisions round-trip byte-identical, but the kind editor no longer offers a params form for `end`. No silent rewrite.
- `outputs` starts `[]` on old steps; an `end` step with `outputs: []` contributes nothing to the merged payload (§6) — valid, not an error.
- `blankStep("end", …)` starts with `ref: ""`, `paramsExpr: "[{}]"` (as today) plus `outputs: []` — and the panel requires ≥1 output row before the step counts as configured (same posture as the human-input ≥1-button rule: an Output step naming nothing returns nothing, so say so rather than look configured).
- Multiple `end` steps are allowed and all merge (§6). The model-level `FlowModel.output` pointer (`{ stepId, description }`, drawn as the `__end__` boundary by `withEnd`) is NOT removed by this doc — §8 keeps both and states the precedence.

Expression forms and allowlist — **explicit call-out, not smuggled**: each row's `source` compiles to the existing roots only (`outputs.<stepId>.*` via the catalogue's `outputExpr` table, `inputs.<id>`, literals). **No `flow-expr` allowlist change in this doc** — no new root, no new callable. Sources that fail the allowlist are `unknown` ("set in the expression", never "not set"), never silently rewritten.

## 4. Card

Fixed geometry is reused, never grown (`lib/canvas-layout.ts`: `heightFor`/`widthFor`, invisible input dots via `inputHandleTop`). The card shows header (icon + name + status) → one config pill → one description line.

- Pill rule: `return · N var(s)` where N = `outputs.length` (e.g. `return · 3 vars`, `return · 1 var`); `outputs.length === 0` → `return · no vars` (an Output step naming nothing says so on the card). If `outputs` is unreadable, fall back to `KIND_LABEL["end"]` (`"end"` in `StepInspector.tsx`) — never a fabricated summary.
- Description-line rule (earned, per component-panel §4): the step's own text only (`StepLabel.description` when present), else nothing. Never a per-kind sentence.

## 5. Panel

Fixed section order is reused: Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove. Only the kind editor's interior is new, in this order:

1. **Variables** — `outputs[]` table in NAME · SOURCE · TYPE rows: name (mono, editable — it becomes the API-response key), source (the Dify-style `Set variable` grey well reusing the existing `ParamRow`/`Select` options — upstream step/field, flow input, or literal; `unknown` renders as "set in the expression"), type chip (the eleven-type select). Rows drag-reorderable (order is the same-branch merge order, §6 — the panel says so in one line). Duplicate names across the flow's `end` steps render a blocking-styled warning naming the other step (later-wins applies, but silently shadowing is a bug factory).
2. **Outputs** (the fixed Outputs section, not part of the kind editor) — one row per `outputs[]` entry showing the resolved read expression (`outputExpr` for the bound step + field, `inputs.<id>`, or the literal), so the author sees exactly what the caller receives. Headed "Outputs".
3. Everything else unchanged: `StepBehaviour` (no retry — an Output step performs no call and holds no pause; same posture as `approval`'s no-retry rule, with the per-kind reason), Connections (`dependsOn` — placement in the graph is what fixes same-branch merge order), Try/Raw/Remove unchanged.

## 6. Outputs

Named vars: exactly the `outputs[].name` entries, read by the caller (not by downstream steps — nothing is downstream of a return declaration except via `dependsOn` edges the graph already has).

- Merge rule (Dify parity): same-branch `end` steps merge in placement order; parallel branches merge in completion order (first-executed first); a later same-name variable overwrites an earlier one. A branch with no Output step contributes nothing.
- How the caller reads them: today's only result mechanism is the model-level `FlowModel.output` pointer (`{ stepId, description }` — compiler reads it and emits nothing from it, `flow-compiler.service.ts` §`FlowModel.output`; the value crosses back through `flow-visibility.service.ts`'s redacted view; canvas draws the `__end__` boundary via `withEnd`). Until the compiler emits a merged-payload task, each `outputs[]` row's read expression is resolved through the existing per-kind output shapes (`OUTPUT_SHAPES` — `json(outputs.<id>.body)`, `json(outputs.<id>.value)`, `outputs.<id>.vars.result`) and served from the engine's already-held task outputs. No new output shape is invented client-side: the catalogue's `caution` entries stay, and a row bound to a step the shape table cannot read is refused, not guessed.
- No-Output workflow: succeeds with no data (Dify parity; matches today's "no result declared" boundary state).

## 7. Failure behavior

- **Does not halt:** reaching an `end` step never stops execution — parallel branches continue, downstream `dependsOn` steps still run. This is the Dify rule and the point of the kind: it declares return data, not a stop instruction.
- **Unresolvable source:** a row whose `source.stepId` names no step, or whose field is unreadable on that step's shape, is a refused save (`unknown_output_step`-class finding, same posture as `checkFlowOutput`'s `unknown_output_step` / `output_step_produces_nothing`), naming the step and the permitted shapes. A green run that hands the caller `null` forever is the failure class this repo keeps re-learning — refused at draft time, never shipped.
- **Duplicate names:** later-wins at runtime; at edit time a blocking-styled warning names both steps. Never silently shadowed.
- **Type mismatch:** a declared `type` the bound value cannot satisfy is a refused save, not a coercion surprise.
- **Empty (`outputs: []`):** valid — contributes nothing. An `end` step naming nothing is not an error; a flow with no `end` steps at all succeeds with no data (§6).
- **No retry:** `end` performs no call, so `retry` is refused on it (compiler `RETRYABLE_KINDS` unchanged — this doc adds no kind to it).

## 8. Migration/compat

- **No new kind, no rename:** stored `kind: "end"` is unchanged. What changes is that the kind becomes emittable and editable.
- **Current `end`-step behavior, grounded (not inferred):** today an `end` step never runs — not because it halts, but because it cannot be saved. The compiler's R8 allowlist (`KINDS` in `flow-compiler.service.ts`: `tool, datasource, query, transform, code, approval, branch, merge`) refuses it with `step kind "end" is not emittable`, and `authoredFromModel` (`packages/flow-edit/src/from-model.ts`, `default:` case) refuses to open any stored step whose kind it does not know. So there is no halt-vs-continue behavior to preserve: **no deployed flow contains a running `end` step.** Old revisions carrying one fail closed at edit/compile time today and keep failing closed until authored with `outputs[]`.
- **The `FlowModel.output` pointer stays:** `{ stepId, description }`, the `__end__` boundary node, and `checkFlowOutput` (must exist, must be in `OUTPUT_STEP_KINDS`: `tool, datasource, query, transform, code, merge`) are untouched by this doc. Precedence when both exist (pointer + `outputs[]` rows) is a compiler decision recorded in §9 — this doc does not pick it, so no existing "no result declared" flow changes meaning on the day this lands.
- **Caps:** no new catalogue cap; `end` steps are counted by step count as today.
- **Canvas compat:** no new handles — `end` steps keep their single target handle and dictinct card; `collapseArms`/`portTop` need no changes (no arms on this kind).

## 9. Open questions

1. **Pointer vs rows precedence (biggest):** when a flow has both the model-level `FlowModel.output` pointer and `outputs[]` rows on `end` steps, which one is the caller's result? Options: (a) rows win when any exist, pointer is legacy fallback; (b) pointer wins and rows are ignored until the pointer is cleared; (c) declaring both is a refused save. Recommendation: (a) — it migrates old flows without rewriting them — but the compiler owns this call, not this doc.
2. **Halt-vs-continue if a halt is ever wanted:** Dify says Output never halts, and this doc follows. If a "stop here" semantic is later needed (e.g. early-exit on a guard arm), it is a separate proposal — never a flag on `outputs[]` rows, which would make one row-shape mean two things.
3. **Answer / streaming future:** §2 scopes Answer out for lack of a chatflow surface. If one appears, the streaming unit (variable-order-controlled progressive delivery) needs its own kind or its own doc — an `end` row is a return key, not a chat block, and stretching it to cover both repeats the name-vs-address mistake.
4. **Per-row type enforcement point:** panel-time warning vs compiler refusal vs engine coercion — §3/§7 take the strict line (refuse), but the exact coercion table (e.g. `integer` from a `number` value) is a compiler spec, not this doc.
5. **Try-step for an Output step:** preview the merged payload against a prior run's outputs, or resolve rows live? Undecided — the Try section renders only when `onTryStep` exists, as today.

## 10. Non-goals

- No new step kind; no rename of `end`, `ref`, or `paramsExpr`.
- No `flow-expr` allowlist change — sources use the served roots and callables; anything else stays `unknown`.
- No Answer node, no streaming, no chatflow surface in this doc.
- No halt/stop semantics on `end` — it declares return data; execution continues.
- No canvas geometry change — fixed card, `inputHandleTop` dots, no wire text labels (per the 09-09 lock).
- No palette-hue or dark-mode token work.
- No compiler emission design beyond §6's read-through rule — the merged-payload task (a possible `core.output.OutputValues`, currently absent per `FOUNDRY_EMITS` by design) is a compiler proposal, not this doc.
