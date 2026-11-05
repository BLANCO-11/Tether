# Merge (Variable Aggregator upgrade)

Status: DRAFT — 2026-09-09

## 1. Purpose

Converge exclusive `branch`/`condition` arms back into one value so the shared tail is defined once. Without a merge the tail must be duplicated into every arm and the copies drift; with one, each arm's last step feeds the merge and downstream reads a single output whichever arm ran. This doc upgrades the stored `merge` kind into a Dify-style Variable Aggregator: one upstream variable picked per incoming arm, same-type enforced, plus an optional Aggregation Group toggle for multiple independent convergences in one node.

## 2. Dify behavior

What we steal (from `agent://TransformNodes`, Variable Aggregator section):

- Converge exclusive branches into a single output so downstream processing is defined once: per-branch variable list (one variable from each branch), single output carrying whichever branch variable has a value at runtime.
- Same-type enforcement within a group: supported types `string`, `number`, `object`, `boolean`, `array`, `file` — all variables in a group must share one.
- Aggregation Group toggle: multiple independent convergence sets in a single node instance, each producing its own output.
- The before/after canvas idiom: without the aggregator downstream nodes are duplicated per branch; with it there is a single downstream.

What we skip:

- Parallel-merge is explicitly NOT this node: Dify "does NOT combine parallel-branch outputs; docs redirect parallel merge to Code or Template node". We adopt the same boundary (§10).
- Dify documents no retry/error-routing for the aggregator and no gap behavior for "no branch ran / no value" — we specify ours in §7 and park the undecided half in §9 instead of inheriting silence.
- No Dify canvas rendering/label text: card and panel follow our diet-card and fixed-order idioms, not Dify's screenshots.

## 3. Model mapping

EXTEND the stored kind `merge` — no new kind, no rename. Grounding (what exists today, all cited):

- Stored shape (`packages/flow-edit/src/index.ts`, `AuthoredStep` merge variant): `{ kind: "merge"; id: string; sources: string[]; dependsOn?: string[] }`. `sources` is step ids in PRIORITY ORDER — "the first that actually ran wins" — and "the server derives the coalesce from each source's kind, so a merge is never a route by which unvetted Pebble reaches the compiler".
- Allowed source kinds (`MERGE_SOURCE_KINDS` in the same file, mirroring the server's list): `"trigger", "datasource", "query", "tool", "action", "notify", "report", "end", "transform", "calculate"` — i.e. kinds whose output is a JSON value readable as one spelling (`json(outputs.<merge>.value)`). Absent by design: `code` (its `vars.result` is an object, not JSON text), `approval` and `branch` (no output at all), and `merge` itself.
- Opening (`packages/flow-edit/src/from-model.ts`, `case "merge"`): carries `sources` with `?? []` — an empty list opens as an unconfigured merge rather than inventing ids; "writing it back is a refused save".
- Blank (`packages/client/src/lib/flow-authoring.ts`, `blankStep` `case "merge"`): `{ kind, id, sources: [], ...dependsOn }` with NO `persistable` escape — "every source is the id of a step that must already exist, so there is nothing safe to invent", and an unconfigured merge is a refused save on both staged and persistable surfaces. The server's refusal "names the step and says a merge combines two or more".
- Panel today (`MergeForm` in `packages/client/src/components/flow/StepInspector.tsx`): a numbered priority list ("Top of the list wins if more than one produced a result") with up/down reorder, remove, and an add picker filtered by BOTH the kind mirror and position (earlier steps only — "a step later in the flow cannot be a source"); fewer than two sources renders the refused-save warning verbatim ("A merge combines two or more steps — pick the last step of each arm of the condition"); a missing source id renders "not in this flow", never hidden.
- Topology (`mergeAwareLinks` in `packages/client/src/lib/canvas-model.ts`): a merge is the only kind whose topology is not in `dependsOn` — the compiler resolves `sources` itself, so this drawing-only function unions `dependsOn` + `sources` for edges. `armMembership` deliberately does NOT call it: "a merge inherits no arm, and neither does anything after it" — the `armOf` closure stops at a merge.
- Today a merge carries no per-field variable refs: `stepIo` (`packages/client/src/lib/step-io.ts`) gives it no input rows (not `code`, not in `CALL_KINDS`) and one output row via `outputSummary` (the `response`/`value` single row, "not a guessed field list").

New stored fields on `merge` (additive; every name below is new and explicit):

| Field | Type | Default | Validation |
| :--- | :--- | :--- | :--- |
| `sources` | `string[]` (existing — step ids, kept) | `[]` (unchanged) | ≥2 required (existing refused-save rule, unchanged); each must name an earlier `MERGE_SOURCE_KINDS` step (existing rule, unchanged) |
| `sourceVars` | `Array<{ stepId: string; field: string }>` — one upstream variable ref per incoming arm, parallel to `sources` | `[]` (legacy merges) | one entry per `sources` entry (same order); `field` names a readable field of that step; a legacy merge with `sources` but no `sourceVars` keeps today's whole-value coalesce (§8) |
| `groups` | `Array<{ name: string; picks: Array<{ stepId: string; field: string }> }>` — optional named convergence sets (the Aggregation Group toggle) | `[]` (single-group mode) | each group ≥2 picks (same refused-save rule as `sources`); `name` unique per step, valid identifier (it becomes the output key); picks reference earlier producer steps only; empty = single default group |
| `varType` | `"string" \| "number" \| "object" \| "boolean" \| "array" \| "file"` per group (Dify's six) | unset until picks bind | all picks in a group must share it — panel warns on mismatch, compiler refuses (§7) |

Notes on each field:

- `sources` keeps its exact name, meaning, and priority-order semantics: the first source that actually ran wins. `sourceVars` narrows *which variable* of each source step converges (today the server derives the whole-value coalesce from the source kind; the var ref selects the field). `sourceVars[i]` corresponds to `sources[i]`; the panel edits them as one row each (arm step + variable picker), never as two lists that can drift.
- Single-group mode (`groups: []`) is today's merge plus `sourceVars`: one convergence, one output. The Aggregation Group toggle populates `groups`, where each group converges its own pick set and produces its own output — multiple independent convergences in one node, exactly Dify's grouping.
- Expression forms and allowlist — **explicit call-out, not smuggled**: `sourceVars`/`groups` picks are built by the existing step + field picker idiom (`flow-expr.ts` roots `outputs.<id>.<field>` / `inputs.<id>` by construction, round-trippable, never typed). **No `flow-expr` allowlist change in this doc** — the picks resolve through the same roots the `Source` union already serves; refs that fail validation are `unknown`, never silently rewritten.

Same-type enforcement (stated which does what): the panel WARNS (a type-mismatch row renders a warn-tinted block naming the offending pick and the expected type, and the save button stays enabled so half-configured work is never trapped); the compiler REFUSES (a merge whose group mixes types is a refused save naming the step and the group, same as today's fewer-than-two refusal). Panel warns, compiler refuses — never the reverse.

## 4. Card

Fixed geometry is reused, never grown (`lib/canvas-layout.ts`: `heightFor`/`widthFor`, invisible input dots via `inputHandleTop`). The card shows header (icon + name + status) → one config pill → one description line. No new hue: `FlowCanvas.tsx` already pairs merge with the condition hue (`--k-transform`) "on purpose: a merge is meaningless without a branch, and the pair should read as a pair".

- Pill rule: `merge · N branches` where N = `sources.length` (e.g. `merge · 2 branches`); with groups enabled, `merge · N branches · M groups` (e.g. `merge · 3 branches · 2 groups`). When `sources` is empty/unreadable, fall back to `KIND_LABEL["merge"]` (`"continues either way"` in `StepInspector.tsx`) — never a fabricated summary.
- Description-line rule (earned, per component-panel §4): the step's own `description` only, else nothing. Never a per-kind sentence.

## 5. Panel

Sections in our fixed order (`StepInspector.tsx`: Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove). Merge content per section:

1. **Step** (open) — kind chip + step id (unchanged).
2. **Description** — single earned line (unchanged).
3. **Inputs** (open, count) — one row per incoming arm in NAME · SOURCE · TYPE rows: the arm's step id (mono) + the variable picker for that arm's `sourceVars` entry (`Set variable` grey well reusing the existing `ParamRow`/`Select` options; `flow-expr` allowlist unchanged). With `groups` enabled, one well-block per group, each headed by the group name. `unknown` renders as "set in the expression", never "not set".
4. **Merge editor** (open, count) — the "what it does" body, in this order: (i) the existing priority list (`MergeForm` as today — numbered, reorderable, "Top of the list wins" hint, fewer-than-two refused-save warning, "not in this flow" missing rendering); (ii) the same-type badge per group (`string`/`number`/`object`/`boolean`/`array`/`file`) with the mismatch warn block; (iii) the Aggregation Group toggle (off = single group; on = add/remove/rename groups, each with its own pick set). The priority list and the var wells edit the same rows — one row = one arm = one step id + one variable ref.
5. **Outputs** — one row per group (§6). Headed "Outputs".
6. **Behavior** — `StepBehaviour` + "Require approval before this step". No merge-specific retry: merge is a pure convergence (`RETRYABLE_KINDS` in `flow-edit` is `tool`/`datasource`/`query`/`code` only — merge is absent, and this doc does not add it).
7. **Connections** (Dependencies) — `dependsOn` upstream + downstream readers; `sources` edges draw via `mergeAwareLinks` (the canvas/connections doc owns the rendering — referenced here, not re-specified). Child-style internal wiring does not apply (a merge has no children).
8. **Try this step** — only when `onTryStep`; runs the convergence against the first available source value.
9. **Raw** — escape hatch, collapsed by default.
10. **Remove** (danger) — removing the merge never removes its sources (unlike container kinds, whose children go with the parent).

Arm idiom (same as the human-input doc §8): arms are `branch` records chained with `elseOf` off the condition head — the same linked-list chain `addArm`/`removeArm`/`chainOf` manage. A merge's `sources` name the LAST step of each arm; arm membership for those steps is plain `dependsOn` (D-123), and the compiler's existing refusal of `elseOf` + `dependsOn` together applies unchanged.

## 6. Outputs

Named vars, read downstream via the existing `outputs.<mergeId>.<name>` expression shape (served by `outputExpr`, never hardcoded):

- Single-group mode (`groups: []`): exactly one var — `value` (the existing spelling `json(outputs.<merge>.value)` from the `MERGE_SOURCE_KINDS` contract is kept verbatim), carrying whichever branch ran (priority order decides when more than one produced a result).
- Grouped mode: one var per group, named `outputs.<mergeId>.<groupName>` per group `name` (proposed; §9 open question covers naming collisions and case rules).
- How downstream reads them: the standard source picker (NAME · SOURCE · TYPE rows in Inputs; `flow-expr` construction by step + field). The `Outputs` panel section shows one row per group plus the expression to read it — never a guessed field list, same rule as catalogue-backed kinds. Per-arm internals (which branch ran, the unchosen arms' values) are NOT visible downstream; only the converged value(s) cross the join.

## 7. Failure behavior

- **Fewer than two sources / empty group:** refused save naming the step (existing rule, extended to each group). The panel warning is the cheap control; the compiler refusal is the real one.
- **Type mismatch within a group:** panel warns (warn-tinted block on the row), compiler refuses naming the step and group. No silent coercion — a number arm and a string arm do not meet in the middle.
- **Source produced nothing / no branch ran:** the merge emits `null` for the group (proposed; §9 asks whether skip-downstream is the alternative) — it never invents a value from the arms that did not run, and it never fails the run on its own. This is a value outcome, not an error: no retry, no dead-letter.
- **More than one source ran** (non-exclusive use): priority order decides — first source that produced a result wins (existing `sources` semantics, surfaced by the "Top of the list wins" hint). Exclusive-only is the contract (§10); priority order is the backstop, not the feature.
- **No retry on merge:** the compiler refuses `retry` on `merge` (existing `RETRYABLE_KINDS` mirror — merge is absent). A source step's own retry is that step's business; the convergence itself is pure.

## 8. Migration/compat

- **No new kind, no rename:** stored `kind: "merge"` is unchanged. Old revisions validate and run exactly as before.
- **Legacy merges keep working:** `sources` with no `sourceVars` = today's whole-value coalesce (server derives from source kinds). The panel renders the existing priority list plus empty var wells; it does not force variable picks onto an old merge until the author edits it as an aggregator. `blankStep("merge", …)` still starts `{ sources: [] }` — refused save until two arms are picked, now with one var well per arm.
- **`sources` mapping is untouched:** names, priority-order meaning, and `structureHash` behavior (hashed as written, not sorted) carry over verbatim. `sourceVars`/`groups` are additive fields old readers ignore.
- **Canvas compat:** `mergeAwareLinks`/`armMembership`/`collapseArms`/`portTop` need no changes — one wire per arm into the merge node draws exactly as today (fan-in wiring: one edge per `sources` entry; the arm's variable ref is panel data, not an edge). Old merges (no vars, no groups) render exactly as today.
- **Caps:** no new budget surface; a grouped merge counts as one step.

## 9. Open questions

1. **No-branch-ran behavior:** `null` for the group (proposed, §7) vs skip-downstream (the run treats the merge's tail as skipped, like a false guard with no `else`)? Proposed `null` — a merge promises one value downstream, and `null` keeps the tail's contract total — but confirm the runner can express skip if product prefers it.
2. **Group output naming:** `outputs.<mergeId>.<groupName>` as proposed — what are the case/collision rules (group renamed onto another group's name, group named `value` in single-group mode)? Proposed: names unique per step, valid identifiers, refused save otherwise (same rule as `code` contract outputs and human-input fields).
3. **`varType` storage:** stored per group (as proposed) or derived at save from the picks and re-checked at compile? Proposed stored — the panel badge and the compiler refusal should read one field, not two derivations.
4. **Field-vs-whole picks:** may a `sourceVars` entry bind a whole step output (no field) for object-typed groups, or must every pick name a field? Proposed: whole-output allowed when the group type is `object` (mirrors the `wholeFrom` whole-object bind), field required otherwise.
5. **Try-step sample:** authored inline on the panel, or picked from a prior run's arm output?

## 10. Non-goals

- **Not a parallel merge:** exclusive branches only. Quoting the iteration doc's boundary idiom (§10) rather than re-deriving it: "Boundary rule: one call per row with a static mapping → fan-out; two or more steps per item, branching per item, or per-item error modes → iteration." Ours in the same shape — boundary rule: exactly one arm runs per execution → merge; two or more arms' outputs must combine in one run → `code`/`transform` join (Dify's Code-or-Template redirect, adopted verbatim).
- **Not a Loop, not an Iteration:** no loop variables, no termination condition, no per-item error modes, no array output. Stateful refinement across cycles is Loop's job; per-element arrays are Iteration's.
- **Not a new expression language:** no new callables, no new roots, no inline `{{}}` picker; picks bind via the existing Set-variable well.
- **No `flow-expr` allowlist change** (called out explicitly in §3, not smuggled in).
- **No canvas geometry change** — fixed card, `inputHandleTop` dots, `portTop` arm handles, no wire text labels (per the 09-09 lock); fan-in rendering belongs to the canvas/connections doc.
- **No palette-hue or dark-mode token work** (merge keeps the condition hue).
