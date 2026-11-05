# Iteration (container step kind)

Status: **DRAFT** — 2026-09-09

## 1. Purpose

Run the same multi-step sub-workflow once per element of an upstream array, and collect one array of per-item results.

## 2. Dify behavior

What we steal from Dify's Iteration node (see ControlNodes Iteration section):

- Array input: one upstream array variable feeds the node; the node runs its embedded child workflow once per element.
- Embedded child workflow: the processing steps live *inside* the node on canvas (e.g. internal LLM + Answer nodes).
- Scoped per-item vars `items` (current element, typed `items[object]`) and `index` (0-based, typed `index[number]`) available to children.
- Two processing modes: sequential (ordered, streamable via internal Answer nodes, lower memory) vs parallel (up to 10 concurrent, unordered, faster for independent ops).
- Three per-item error modes: terminate on first error; continue-on-error (emit `null` for failed items, e.g. `[result-1, null, result-3]`); remove-failed (compact, e.g. `[result-1, result-3]`).
- Single array output, order-corresponding to input in sequential mode; downstream almost always needs a join (Code `"\\n".join(...)` / Template `{{ x | join }}`).

What we skip:

- No Dify image-asset or demo-video behavior; no parameter-extraction quality caveats (that is an LLM-tool concern, not iteration's).
- No retry counts/intervals (Dify documents none for Iteration).
- No early-exit/break idiom (Dify documents none; skipping is via error modes only — Loop's Exit Loop node is out of scope here).
- No `{{}}` picker syntax: our panel keeps the existing Set-variable well idiom (`flow-expr` allowlist by construction).

## 3. Model mapping

New stored kind `iteration` added to the `StepKind` union in `canvas-model.ts` (alongside `branch`, `merge` — a real kind, not an alias).

Proposed stored shape (fields on the iteration step record):

```ts
type IterationArraySource =
  | { from: "step"; stepId: string; field: string }  // mirrors flow-expr Source
  | { from: "input"; inputId: string };              // flow-level array input

type IterationMode = "sequential" | "parallel";

type IterationErrorMode =
  | "terminate"       // stop on first item error, surface the error
  | "continue-null"   // failed items emit null, array length preserved
  | "remove-failed";  // failed items dropped, array compacted

type IterationStep = AuthoredStep & {
  kind: "iteration";
  arraySource: IterationArraySource;  // (a) which array feeds the loop
  children: AuthoredStep[];           // (b) embedded child steps, NESTED not top-level
  mode: IterationMode;                // (c) default "sequential"
  parallelCap: number;                // (c) default 10, min 1, max 10
  onItemError: IterationErrorMode;    // (d) default "terminate"
};
```

Notes on each field:

- (a) `arraySource` reuses the `paramsExpr` fan-out idiom: a `{from:"step", stepId, field}` source resolves through the existing `outputExpr`/`rowsExpr` tables (whichever yields the array — the panel offers the same upstream-step + field pickers as `buildFanOutParams`'s `over` argument). The `{from:"input"}` arm covers flow-level array inputs (`inputs.<id>`). No literal/self arm: iterating a hand-typed literal list is out of scope.
- (b) `children: AuthoredStep[]` is stored **nested inside the parent iteration step record**, never as top-level steps. Children have ids unique within the parent; `dependsOn` inside children may reference siblings or the parent scope, never top-level steps directly. Top-level edges treat the parent as one node.
- (c) `mode` default `"sequential"`; `parallelCap` default `10`, clamped to 1–10, only meaningful when `mode: "parallel"` (stored always, ignored in sequential mode).
- (d) `onItemError` default `"terminate"`.

Expression forms and allowlist — **explicit call-out, not smuggled**: inside children, `items` and `index` resolve per element. That requires two new `flow-expr` allowlist roots (`items`, `index`) visible **only** in the child scope (the builder emits them by construction; `validateAgainstAllowlist` must accept them there and reject them at top level). No new callables. Everything else children reference (upstream steps, flow inputs) uses the existing roots unchanged.

Scoping rule (explicit): inside `children`, `items`/`index` resolve to the current element and its 0-based position. Children **MAY** read the parent's `arraySource` step, flow inputs, and their own siblings' outputs **within the same element's run**. Children **MUST NOT** reference another element's per-item state — there is no cross-element addressing (no `items[i-1]`, no sibling output from a different index). Iteration carries no accumulator across elements; stateful refinement across cycles is Loop's job, not this kind's.

Validation:

- `arraySource.stepId` must name an existing upstream step (or `inputId` an existing flow input); the referenced field must be array-shaped (compiler checks; panel warns when the shape table says otherwise).
- `children` must be non-empty (≥1 step); child ids unique within the parent; child `dependsOn` must stay inside the parent scope.
- `parallelCap` integer 1–10.
- `mode: "parallel"` + `onItemError: "terminate"` is allowed but racy by definition (first *observed* error wins; order not guaranteed) — the panel says so, one line.

## 4. Card

**Deliberate exception to the diet-card rule:** an iteration parent renders as a **container frame**, NOT a diet card (header + pill + description line). Rationale: it owns visible children on canvas; collapsing it to a 232px card would hide the sub-workflow it exists to show.

- Frame header: icon + name + status (same header idiom as diet cards), plus the config pill: `over <step>/<field> · <sequential|parallel ×N> · <error-mode short label>`; falls back to `KIND_LABEL` ("iteration") when the array source is unbound — never a fabricated summary.
- Description line: the step's own earned text only (same rule as diet cards); never a per-kind sentence.
- Layout consequences (proposed, not finalized): dagre treats the parent as **one node with a larger box** (width/height = fitted frame, not `widthFor`/`heightFor`); children are laid out **inside** by the same dagre pass at a smaller rank scale, positions offset into the frame. `dropOrphaned`/`rekeyPosition` treat the parent id as the unit; child ids never appear in the saved-positions table. `connectedTo` expands through the frame (hovering the frame highlights children and vice versa).

## 5. Panel

Sections in our fixed order (StepInspector), iteration content per section:

1. **Step** (open) — kind chip (`iteration`) + step id + ref. Unchanged.
2. **Description** — single earned line. Unchanged.
3. **Inputs** (open, count) — the array-source picker: upstream step + field (or flow input) in the Dify-style `Set variable` grey well, reusing the existing `ParamRow`/`Select` options. Allowlist unchanged except the explicitly proposed child-scope roots (§3).
4. **Iteration editor** (open, count) — the kind editor: (i) child list editor (add/remove/reorder embedded steps; each child row opens its own mini-editor with the same NAME·SOURCE·TYPE rows, where `items`/`index` appear as bindable sources), (ii) mode radio sequential|parallel + cap stepper (1–10, disabled unless parallel), (iii) error-mode radio (terminate / continue-on-error / remove-failed) with the one-line consequence note from §6.
5. **Outputs** — one `results` array row + the expression to read it (see §6); plus the catalogue `caution` below the rows, never dropped. NOT an editable field list.
6. **Behavior** — `StepBehaviour` + "Require approval before this step". Moved up per the standard order; failure *handling* lives in the kind editor (§5.4), retry/timeout policy lives here.
7. **Connections** (Dependencies) — parent-level `dependsOn` only; child wiring is internal and never appears here.
8. **Try this step** — only when `onTryStep`; runs with a sample array (authored inline, capped at 3 elements).
9. **Raw** — escape hatch, collapsed by default; shows the full nested record.
10. **Remove** (danger) — removes parent + children as one unit.

## 6. Outputs

Named vars: exactly one — `results`, an array with one slot per input element.

- `mode: "sequential"` → order-corresponding to the input array.
- `mode: "parallel"` → order NOT guaranteed.
- `onItemError: "continue-null"` → failed slots are `null`; length preserved (`[result-1, null, result-3]`).
- `onItemError: "remove-failed"` → failed slots dropped; array compacted (`[result-1, result-3]`).
- `onItemError: "terminate"` → no array; the error surfaces instead.

How downstream reads it: the same as any array-shaped output — `outputExpr`/`rowsExpr` on the parent step id (whole-array bind, or fan-out `over` the parent for per-result mapping). Per-element internals (`items`, `index`, child step outputs) are **not** visible outside the parent; only `results` crosses the frame boundary. Downstream almost always needs a join step (code/transform) to turn `results` into text — the Outputs head hint says so in one line.

## 7. Failure behavior

Two levels, kept distinct:

- **Per-item** (inside the frame): governed by `onItemError` — `terminate` stops the whole node on the first item error and surfaces it; `continue-null` emits `null` for failed items and keeps going; `remove-failed` drops failed items and keeps going. No retries at item level (Dify documents none; adding them is a future proposal, not this doc).
- **Whole-node** (the parent as a step): governed by `StepBehaviour` (retry/timeout/approval) like every other kind. A `terminate` item error escalates to a whole-node failure and runs the standard Behavior path.

Parallel + terminate: first *observed* error wins; which item that is depends on scheduling. The panel states this; the model makes no ordering promise.

## 8. Migration/compat

- Additive new kind: existing flows have no `iteration` steps and are unaffected. No migration of stored revisions.
- The existing single-step fan-out (`buildFanOutParams` over rows — one call per row of an upstream array) **stays exactly as is**. Iteration is for multi-step per-item sub-workflows; see §10 for the boundary.
- Server/compiler work (executing nested children, enforcing the 10-cap, scoping `items`/`index`) is downstream of this talk-phase doc; the canvas treats an unrecognized `iteration` kind as a diet card with the `KIND_LABEL` pill until the frame renderer lands.
- Saved positions: parent id only (§4); no backfill needed.

## 9. Open questions

1. Should `parallelCap` be user-settable 1–10, or fixed at 10 with mode as the only toggle (closest to Dify's Settings toggle)?
2. Does `results` need an element-shape declaration (for typed downstream picks), or is it untyped-array until a downstream step narrows it?
3. Try-step sample array: authored inline on the panel, or picked from a prior run's output?
4. Frame collapse affordance on canvas (collapsed diet-card view vs expanded frame) — in scope for the renderer pass or deferred?
5. Should empty-array input produce `[]` or skip downstream (vacuous success vs skip)?

## 10. Non-goals

- **Not a Loop:** no loop variables, no termination condition, no max-count-until-done, no Exit Loop node, no Variable Assigner accumulation idiom. Stateful refinement across cycles is a separate kind with a separate doc.
- **Not a fan-out replacement:** `buildFanOutParams` (single tool/datasource call mapped once per row) stays. Boundary rule: one call per row with a static mapping → fan-out; two or more steps per item, branching per item, or per-item error modes → iteration.
- **Not a new expression language:** no new callables, no inline `{{}}` picker; children bind via the existing Set-variable well plus the two explicitly proposed scope roots (`items`, `index`).
- **Not a palette/canvas-behavior change:** drag semantics (`dependsOn` edge-only), diet cards for all other kinds, and wire rendering are untouched by this doc.
