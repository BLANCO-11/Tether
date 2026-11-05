# Loop (status: DRAFT — 2026-09-09)

## 1. Purpose

Repeat one embedded child workflow until it is done — each cycle builds on the previous cycle's results.

## 2. Dify behavior

What we steal: loop variables that persist across cycles and stay visible after the loop (`num` counter, `verse` draft); termination as OR-logic — condition true OR max count reached OR an embedded Exit Loop node reached; strictly sequential, stateful execution; canonical uses are refinement / problem-solving / QA (vs Iteration's batch transform).

What we skip: the Variable Assigner node as the state-update idiom (§5 states our simplification); parallel execution (Dify documents no parallel mode for Loop — we offer none); Dify's undocumented failure modes (we specify ours in §7 instead of inheriting silence).

## 3. Model mapping

New stored kind `loop`. Stored fields (all named; no invented model data):

- `loopVars: Array<{ name: string; type: IoType; initial: Source }>` — the loop state. Each entry declares one variable, its type (same `IoType` vocabulary as `step-io.ts`), and its initial value wired from upstream via our existing `Source` union (`flow-expr.ts`: `step` / `input` / `literal` / `self`). Required: at least one loop var; names unique within the step. Rendered in the panel with the same Set-variable well as `StepIO` inputs.
- `children: AuthoredStep[]` — the embedded child workflow, stored inline on the step, never top-level. **Same nesting shape as the iteration doc (`docs/nodes/iteration.md`) proposes — reference that doc, keep the two consistent.** Children are full `AuthoredStep` values (own ids, kinds, expressions); their upstream refs may point at sibling children, at the loop's own `loopVars` (prior-cycle values), or at steps outside the loop. Child ids are unique WITHIN the parent (matching iteration) and resolve parent-scoped, so `dependsOn` edges and `outputs.<id>` refs inside `children` never collide with flow-level steps.
- `conditionExpr: string` — termination condition, reusing our `conditionExpr` / `BRANCH_TESTS` vocabulary (`flow-expr.ts`: `buildCondition` / `parseCondition` round-trip). Exactly ONE test (e.g. `quality_score > 0.9`, `num > 3`). Optional but expected: empty means "run to `maxCount`". No `flow-expr` allowlist change — the expression is assembled from the same roots and callables, so this is called out as explicitly unchanged.
- `maxCount: number` — safety limit. REQUIRED, default `10` (proposed; mirrors Dify's "up to 10" concurrency cap as the one number our users already know). Validation: integer ≥ 1; refused save below 1. With no condition and no exit child, the loop runs exactly `maxCount` cycles.
- Exit-node convention (proposed): a child step carrying `exitLoop: true` ends the loop when reached — the run continues after the loop with current loop-var state. At most one `exitLoop` child per loop (refused save otherwise); an `exitLoop` child MUST be reachable inside `children` (dangling flag refused). This is our equivalent of Dify's Exit Loop node without a new kind.

Defaults: one loop var (`{ name: "count", type: "number", initial: { from: "literal", value: "0" } }` proposed), `conditionExpr: ""` (run-to-max until configured, same blank-until-configured rule as `condition`/`branch`), `maxCount: 10`, `children: []` (refused save — a loop with no children is a refused save, same as an unconfigured `merge`).

Validation summary: ≥1 loop var; unique loop-var names; `maxCount` integer ≥ 1; ≥1 child; ≤1 `exitLoop` child; child ids unique within the parent; `conditionExpr` parses via `parseCondition` or is empty.

## 4. Card

Container exception — same as iteration: the loop draws as an expanded container holding its child workflow on the canvas, NOT as a diet card. (The Step 1 card diet — fixed geometry via `heightFor`/`widthFor` in `canvas-layout.ts` — applies to leaf kinds; containers are the documented exception. New kinds MUST reuse the fixed geometry and never grow the card — this kind is exempt only because it is a container, like iteration.)

- Collapsed pill rule: `loop ×{maxCount}` when no condition (e.g. `loop ×10`); `loop until <test>` when a condition is set, where `<test>` is the plain-text arm summary in the `describeStartEntry` style (reuse, never invent). If neither can be derived, fall back to `KIND_LABEL` (`loop`) — never fabricate.
- Description line: earned only — the step's own text if set, otherwise nothing. Never a per-kind sentence.

## 5. Panel

Sections in our fixed order (`StepInspector.tsx`: Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove):

1. **Step** — kind chip + step id (unchanged).
2. **Description** — single earned line; empty until the author writes one.
3. **Inputs** — one row per loop var: NAME · TYPE · Set-variable well for `initial` (reuses `ParamRow`/`Select` options; `flow-expr` allowlist unchanged, no inline `{{}}` picker).
4. **Loop editor (kind editor)** — the "what it does" body: child-step list (add/remove/reorder, reusing `BranchForm` idioms), per-child `exitLoop` toggle, `conditionExpr` builder (same single-test picker as `condition`), `maxCount` number field.
5. **Outputs** — final loop-variable state, one row per loop var (§6). Headed "Outputs".
6. **Behavior** — `StepBehaviour` + "Require approval before this step". Failure policy is fixed (§7); nothing to configure here.
7. **Connections** — `dependsOn` upstream + downstream readers (child refs are internal and NOT listed as flow connections).
8. **Try this step** — only when `onTryStep`; runs children against initial values.
9. **Raw** — escape hatch, collapsed by default.
10. **Remove** (danger) — removing the loop removes its children with it (confirm names the child count).

State-update idiom (deliberate simplification vs Dify): our `transform`/`code` children write loop vars each cycle — a child whose output binds a loop-var name updates that var for the next cycle. **No separate Variable Assigner kind is needed or proposed.** Dify needs the assigner because its children cannot write loop state directly; ours can, so the extra node would be furniture.

## 6. Outputs

Named vars: exactly the loop-var names, holding their FINAL state when the loop exits (by condition, max count, or exit child). No array output — output is the evolved state, not per-cycle results (the Iteration-vs-Loop contrast: iteration emits an array, loop emits the refined value).

Downstream reads: `outputs.<loopId>.<varName>` per var (same `outputExpr` shape mechanism as other kinds; server-owned output shapes unchanged). The `Outputs` panel section shows one row per loop var plus the expression to read it — never a guessed field list, same rule as catalogue-backed kinds. Intermediate per-cycle values are NOT visible downstream; only the final state escapes the loop.

## 7. Failure behavior

A child failure stops the whole run — the loop does not catch, skip, or retry it, and remaining cycles never execute. This is Dify parity (Dify documents no per-item error mode for Loop) and a deliberate difference from iteration's three modes (terminate / continue-on-error / remove-failed): iteration processes independent items so skipping is meaningful; loop cycles are dependent, so a failed cycle's state is undefined and continuing would refine garbage. Retry/timeout of the loop step itself follows the standard `StepBehaviour` path (the loop is one step to the runner); there is no per-cycle retry.

## 8. Migration/compat

Additive: new `StepKind` union member (`canvas-model.ts`), new `blankStep` case, new stored-field writers in `flow-authoring.ts` — no existing kind, expression, or edge changes. Old flows contain no `loop` steps and are unaffected. `dependsOn` edge-only drag semantics unchanged: edges into/out of the loop attach to the container; child steps never appear as flow-level edge endpoints. Server compile of `children` + loop-var scoping is backend work outside this doc; the panel refuses to save a loop the compiler cannot yet express (same staged-surface rule as blank `condition`).

## 9. Open questions

1. AND-compound conditions (shared with ifelse): should `conditionExpr` grow to an AND of several tests, or stay one test with `transform`/`code` children precomputing a boolean? Proposed: stay one test (children can compute anything); shared with the ifelse doc — decide once, apply to both.
2. `maxCount` default + ceiling: is `10` the right default, and is there an upper bound (e.g. 100) the runner enforces? Needs runner input.
3. Exit-child marking: flag (`exitLoop: true` on a child, as proposed) vs dedicated marker child kind? Proposed the flag — no new kind — but confirm the compiler can express "stop when reached".
4. Mid-loop visibility: should Try show per-cycle loop-var values (cycle debugger), or only final state? Proposed final-state-only for this pass.
5. Nested loops (a `loop` inside `loop.children`): allowed with parent-scoped ids, or refused? Proposed allowed, depth-unlimited, since child ids resolve inside their own parent.

## 10. Non-goals

- No parallel loop execution (sequential stateful only — Dify parity).
- No Variable Assigner kind (transform/code children are the updater — §5).
- No per-cycle output array or per-item error modes (that is iteration).
- No `flow-expr` allowlist change (called out explicitly, not smuggled in).
- No card-geometry change (container exception, same as iteration; leaf diet untouched).
- No new panel section order or new editor idioms beyond reusing `BranchForm`/`StepIO` patterns.
