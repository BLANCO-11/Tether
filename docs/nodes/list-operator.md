# List Operator (Status DRAFT 2026-09-09)

## 1. Purpose

Filter, sort, and select elements from one upstream array, bridging the gap Dify names explicitly: most nodes expect single values, not arrays. One array in; a narrowed array plus its edge elements out.

## 2. Dify behavior

What we steal (see TransformNodes List Operator section):

- Single array input typed `array[string]` / `array[number]` / `array[file]` / `array[boolean]`.
- Optional filter conditions — for file arrays: content props (type = image/document/audio/video, MIME type, extension) and file props (size, name, transfer method local-vs-URL).
- Optional sort: one attribute + direction (ASC smallest→largest / A–Z, DESC largest→smallest / Z–A).
- Selection: Take First N (1–20, applied after filter+sort), First Record, Last Record.
- Three outputs: `result` (complete filtered+sorted array for bulk processing), `first_record` (single element from the beginning — primary/latest), `last_record` (single element from the end — most recent/final). First/Last Record return single values: a type change from array to element.
- The documented pattern: split-by-type → process appropriately → combine (e.g. separate List Operator nodes with `type=image` → vision LLM and `type=document` → Document Extractor route mixed uploads, then combine downstream).

What we skip:

- No in-node fan-out: the node itself has a single exit; routing is by pattern (one List Operator per filter), not by arms.
- No Dify screenshot/interface behavior; no retry/error-routing (Dify documents none — we specify ours in §7 instead of inheriting silence).
- No `{{}}` picker syntax: our panel keeps the existing Set-variable well idiom (`flow-expr` allowlist by construction, except the one explicit no-change call-out in §3).

## 3. Model mapping

New stored kind `listop` added to the `StepKind` union in `canvas-model.ts` (a real kind, not an alias), with a new `blankStep` case in `flow-authoring.ts` and a new `AuthoredStep` union variant in `packages/flow-edit/src/index.ts`.

Why a new kind instead of extending `transform`: `transform` is expression mode — one free-form computation with caller-shaped outputs. `listop` has a distinct input shape (exactly one array source, never a param table) and three FIXED outputs (`result` / `first_record` / `last_record`, §6) that no expression declares. Folding it into `transform` would mean a mode flag plus three reserved output names the expression editor must avoid — a second spelling of "shaped output" nothing keeps in step. A leaf kind with fixed fields is the boring shape.

Proposed stored shape (fields on the `listop` step record):

```ts
type ListOpStep = AuthoredStep & {
  kind: "listop";
  arraySource: IterationArraySource; // REUSED from docs/nodes/iteration.md — NOT redefined here
  filter: { field: string; test: BranchTest; value?: string } | null;
  sort: { field: string; dir: "asc" | "desc" } | null;
  selection: { mode: "all" | "first-n" | "first" | "last"; n: number };
};
```

Notes on each field:

- `arraySource` — REUSE, not redefinition: the exact `IterationArraySource` union from `docs/nodes/iteration.md` (`{ from: "step"; stepId; field }` resolving through the existing `outputExpr`/`rowsExpr` tables, or `{ from: "input"; inputId }` for flow-level array inputs). No literal/self arm (same rule as iteration: a hand-typed literal list is out of scope). The panel offers the same upstream-step + field pickers as iteration's array-source picker.
- `filter` — one optional condition `{ field, test, value }` reusing the `BRANCH_TESTS` vocabulary (`flow-expr.ts`: `BranchTest` / `buildCondition` / `parseCondition` round-trip — the same test list `condition`/`branch` use: `field_eq`, `field_ne`, `field_contains`, `field_starts`, `field_ends`, `field_empty`, `field_present`, `field_gt`, `field_lt`). `null` = no filtering. File-array conveniences (MIME type, extension, size, name, transfer method) are field addresses on the element, not new tests — see §9 open question for which object-array fields are addressable.
- `sort` — one optional `{ field, dir }`; `null` = keep input order. `dir: "asc"` = smallest→largest / A–Z; `"desc"` = largest→smallest / Z–A.
- `selection` — default `{ mode: "all", n: 1 }`. `all` = whole filtered+sorted array; `first-n` = first `n` elements after filter+sort; `first` / `last` = the edge element (still exposes all three outputs per the §6 rule — the outputs don't change shape with the mode, only which are meaningful).

Expression forms and allowlist — **explicit call-out, not smuggled**: NO `flow-expr` allowlist change. Filter compiles through the existing `buildCondition` path (same roots and callables as `condition`); sort/selection are stored-field comparisons, not expressions. Per-element field addressing (`filter.field`, `sort.field`) reads element properties the compiler already resolves — no new root, no new callable.

Validation:

- `arraySource.stepId` must name an existing upstream step (or `inputId` an existing flow input); the referenced field must be array-shaped (compiler checks; panel warns when the shape table says otherwise — same rule as iteration).
- `selection.n` integer 1–20 (Dify's Take-First-N cap); refused save outside the range. Only meaningful when `mode: "first-n"` (stored always, ignored otherwise — same stored-always pattern as iteration's `parallelCap`).
- `filter` when non-null must `parseCondition`-round-trip (or the save is refused); `sort.field` non-empty when `sort` is non-null.

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Never grows; reuses `heightFor`/`widthFor` like every other leaf kind.

- Pill rule: `filter · sort · take N` compressed from set fields only — `filter` present → `filter`, `sort` present → `sort <asc|desc>` (e.g. `sort desc`), `selection.mode: "first-n"` → `take {n}` (e.g. `take 5`); joined with ` · ` (e.g. `filter · take 5`, `sort desc · take 3`, `filter · sort asc`). `mode: "first"` → `first`, `mode: "last"` → `last`, `mode: "all"` with no filter/sort → fall back to `KIND_LABEL` (`listop`). Never a fabricated summary — unconfigured falls back to the kind label word.
- Description-line rule: the step's own earned text only. No per-kind sentence — an undescribed listop step shows no description line, same as every other kind.

## 5. Panel

Sections in our fixed order (`StepInspector.tsx`: Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove):

1. **Step** (open) — kind chip + step id + ref (unchanged).
2. **Description** — single earned line; empty until the author writes one.
3. **Inputs** (open, count) — the array-source picker: upstream step + field (or flow input) in the Dify-style `Set variable` grey well, reusing the existing `ParamRow`/`Select` options. Same picker as iteration's Inputs section. `flow-expr` allowlist unchanged (§3).
4. **List operator editor** (open, count) — the "what it does" body: (i) filter row — field picker + `BRANCH_TESTS` test dropdown + value input (same single-test picker idiom as `condition`), with a clear-to-null affordance; (ii) sort row — field picker + ASC/DESC segmented, with a clear-to-null affordance; (iii) selection radio (all / take-first-N + `n` stepper 1–20 / first / last).
5. **Outputs** — the three fixed rows (§6) + the expression to read each. Headed "Outputs". NOT an editable field list.
6. **Behavior** — `StepBehaviour` + "Require approval before this step". No per-item error mode (unlike iteration — there are no per-item executions, only one array computation).
7. **Connections** (Dependencies) — `dependsOn` upstream + downstream readers (unchanged).
8. **Try this step** — only when `onTryStep`; runs against a sample array (authored inline, capped at 3 elements — same idiom as iteration's Try).
9. **Raw** — escape hatch, collapsed by default.
10. **Remove** (danger) — unchanged.

## 6. Outputs

Named vars: exactly three, fixed regardless of `selection.mode` (the mode changes which are meaningful, not which exist):

| Var | Shape | When meaningful |
|---|---|---|
| `result` | array — the filtered+sorted array (or its `first-n` prefix when `mode: "first-n"`) | always |
| `first_record` | single element (element type, NOT an array) — first of the filtered+sorted array | when `selection.mode` is `first-n`, `first`, or `all` with a downstream single-value consumer; still emitted under `last` but callers should prefer `last_record` (panel hint says so) |
| `last_record` | single element (element type, NOT an array) — last of the filtered+sorted array | when `selection.mode` is `last`, or any mode where the tail matters; still emitted under `first` but callers should prefer `first_record` (panel hint says so) |

Rule (stated once, enforced by hint not by hiding): all three outputs are always emitted; `first_record` / `last_record` are only MEANINGFUL per the selection — under `mode: "all"` with no filter/sort they are just the input's edge elements. The Outputs head hint says which two the current selection intends, in one line.

How downstream reads them: `outputs.<listopId>.result` / `.first_record` / `.last_record` through the existing `outputExpr` shape mechanism (`step-io.ts` `IoOutput` + readers); `listop` joins the producer set alongside `code`/`tool` with these three rows — never a guessed field list. `result` feeds bulk consumers (or fans out via `buildFanOutParams` `over` the parent); `first_record` / `last_record` feed the single-value nodes that motivate this kind (§1).

## 7. Failure behavior

One level only (no per-item executions, so no iteration-style error modes):

- Bad input (array source unbound, or resolves to a non-array at runtime): the step fails with a shape error; standard `StepBehaviour` path (retry/timeout/approval) applies. Panel refuses save while the source is unbound.
- Empty result (filter matches nothing): NOT a failure — the step succeeds vacuously; see §9 open question (shared with iteration Q5) for whether downstream sees `[]`/nulls or skips.
- Whole-node retry/timeout follows `StepBehaviour` like every other kind. No per-element retry (there are no element executions to retry).

## 8. Migration/compat

Additive: new `StepKind` union member (`canvas-model.ts`), new `blankStep` case, new stored-field writers in `flow-authoring.ts`, new `KIND_LABEL` entry — no existing kind, expression, or edge changes. Old flows contain no `listop` steps and are unaffected. `dependsOn` edge-only drag semantics unchanged: one node, ordinary upstream/downstream edges. The split-by-type → process → combine pattern (§2) composes existing edges — no new wiring idiom. Server compile of the filter/sort/selection over the resolved array is backend work outside this doc; the panel refuses to save a listop the compiler cannot yet express (same staged-surface rule as blank `condition`).

## 9. Open questions

1. Object-array field vocabulary: which element fields are addressable in `filter.field` / `sort.field` (top-level props only, or nested `a.b` / file content-props like MIME/extension/size)? Proposed: top-level element props + the Dify file content/file props as reserved field names; confirm with the compiler owner.
2. Empty-result downstream behavior — SHARED with iteration Q5 (`docs/nodes/iteration.md` §9.5: "Should empty-array input produce `[]` or skip downstream (vacuous success vs skip)?"): decide once, apply to both. A listop whose filter matches nothing and an iteration over an empty array must agree on vacuous-`[]` vs skip.
3. `selection.n` ceiling: is Dify's 1–20 cap ours, or do we allow larger takes (e.g. up to 100)? Proposed 1–20 for parity; needs runner input.
4. Multi-filter AND (Dify shows plural "conditions"): one test now, or an AND list from day one? Proposed one test (a `transform`/`code` child can precompute a boolean); shared with the loop/ifelse single-test rule — decide once, apply to all.
5. `first_record` / `last_record` under `mode: "all"`: hint-only (as proposed in §6) or hidden rows? Proposed hint-only — fixed outputs keep downstream refs stable when the author flips the selection.

## 10. Non-goals

- No multi-step per-item sub-workflow (that is iteration); no loop variables, termination condition, or max-count-until-done (that is loop).
- No branching arms on this node — routing is by pattern (one listop per filter), not by exits; convergence of exclusive branches is the aggregator's job, not this kind's.
- No new expression language: no new callables, no new allowlist roots, no inline `{{}}` picker — filter reuses `BRANCH_TESTS`, bindings use the existing Set-variable well.
- No `flow-expr` allowlist change (called out explicitly in §3, not smuggled in).
- No card-geometry change (diet card, fixed `heightFor`/`widthFor`); no panel-order change.
- No palette/builder implementation — talk-phase artifact only, no code.
