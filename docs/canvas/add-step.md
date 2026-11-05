# Add Step (Status DRAFT 2026-09-09)

> **⚠ Describes the compiled builder's canvas (React Flow), which now opens only for flows not built by Forge.**
> The current builder is specified in [`README.md`](README.md) beside this file; kept for that history.

## 1. Purpose

How steps enter the canvas: the entry points a person uses to grow a flow (palette drag, card-corner add, right-click Add menu, inline `+` on wires, Duplicate), what `dependsOn` rewrites each one performs, how a step's kind is changed after placement, and the guards that bound growth (50-node execution-path limit, paste scope, serial/parallel arrangement). This doc proposes no model change: every add is `blankStep` + `addStep` + (`connect`/`disconnect`) through the pure ops in `packages/flow-edit/src/index.ts`, and every claim below names the op it runs.

## 2. Dify behavior

What we steal (from `agent://CanvasBehaviors` §1, orchestrate section):

- Right-click Add Node > category > kind: the canvas offers every kind inline at the click point, grouped by category.
- Palette drag: drag a component from the picker onto the canvas; it lands where dropped.
- Copy/paste any node except Start within/across workflows and across instances: paste carries node config; workflow resources (variables) and workspace resources (integrations, knowledge bases) are re-evaluated at the destination. Cross-instance paste requires HTTPS or loopback (`localhost`/`127.0.0.1`).
- 50-node execution-path limit: a single execution path supports up to 50 nodes.
- Serial vs parallel arrangement: serial siblings run in sequence and each node can read vars from ANY earlier node in the chain; parallel siblings run simultaneously and CANNOT read each other — only a downstream convergence node can read from all branches. This is an execution rule, and the connections doc renders it.

What we skip:

- Cross-instance paste (config travels across deployments with resource re-evaluation) — out of scope; see §8 for the staged paste scope.
- Dify's category taxonomy verbatim (our palette groups are catalogue-driven Tools / Data sources / Named queries / DB operations / Triggers + From scratch, per `StepPalette.tsx` / `palette.ts`).
- Snippets and any Dify change-node-type mechanic (Dify documents none on this page) — Change Node below (§3.6) is our own proposal, not parity.

## 3. Model mapping

No new kind, no new stored field, no `flow-expr` allowlist change. This section is the interaction/wiring rules: each entry point named as the pure-op sequence it runs. All ops return a NEW flow and refuse with a spoken error (never a half-written graph); `addStep` refuses duplicate/invalid/reserved ids (`isValidStepId`, `RESERVED_STEP_IDS` = `begin`, `complete`).

### 3.1 Palette drag (keep)

A palette row carries `application/x-foundry-step` (`{ kind, ref }` via `setPaletteDrag`/`readPaletteDrag` in `lib/palette-drag.ts`); the canvas is a drop target only when the surface hands it `onDropStep` (`FlowCanvas.tsx`, `dropEffect: "copy"` — the row stays where it is). Drop delivers `(kind, ref, x, y)` (`FlowCanvas.c2.test.tsx` pins the triple). The page then runs `addStep(flow, blankStep(kind, uniqueStepId(flow, kind), null, ref ?? ""))` — unconnected (`after: null`, no `dependsOn`), positioned at the drop point. Callable rows (`tool`/`datasource`/`query`) arrive complete because the ref comes from the catalogue; From-scratch rows (`palette.ts` `FROM_SCRATCH`: `code`, `transform`, `approval`, `branch`, …) arrive as their `blankStep` blank (§3.7). Surfaces that save every gesture (`FlowReview`, chat workbench) pass `{ persistable: true }` so `condition`/`branch` blanks start always-true (`{{ 1 }}`) instead of staging an intentionally-invalid blank the save would refuse.

### 3.2 Card-corner / node "Add step after" (keep)

The node context menu's "Add step after" drills into the kind chooser (every palette kind; `FlowCanvas.test.tsx:913` pins the drill-down) and reports `(stepId, kind, ref?)` via `onAddStepAfter`. The page runs `addStep(flow, blankStep(kind, id, stepId, ref ?? ""))` — the fresh step depends on the source step alone. Branch exception (existing rule, `FlowReview.tsx addStepAfter` + chat workbench `addStepFromCanvas`): a `branch`/`condition` guards what runs AFTER it, so "add after X" for a guard splices between X and its single successor (the successor is re-pointed at the new guard, §3.5). Zero successors → spoken refusal ("nothing runs after X — insert it between two steps instead"); several successors → spoken refusal ("runs into several steps … insert it on the edge"). Never an unguarded guard.

### 3.3 Right-click canvas Add menu (keep and extend)

Right-click (or double-click) on the empty pane opens "Add a step" offering every palette kind inline (`FlowCanvas.test.tsx:864`, `:1167`; the kind chooser scrolls under a sticky header). The pick reports through `onAddAt`; the page runs `addStep(flow, blankStep(kind, id, null, "", { persistable: true }))` and records the pane point as the saved position (`putRow`). Unconnected by construction — placement first, wiring by drag. Extension proposed (no new op): the pane menu gains the same ref second-step the chat canvas already uses for callables (a callable arrives complete or not at all — `NEEDS_REF` kinds with `ref: ""` are a refused save on per-gesture surfaces, `flow-authoring.ts` docblock), and a "Paste here" item when the clipboard holds a step (§8).

### 3.4 Inline `+` on wires (keep)

Every edge carries a mid-edge `+` (`onInsertStep(from, to, kind)`; `FlowCanvas.tsx` docblock). The page runs the splice as ONE `applyAuthored` unit (`FlowReview.tsx insertStepOnEdge`, mirrored in the chat workbench):

1. `addStep(f, blankStep(kind, id, from, ref ?? "", { persistable: true }))` — the fresh step depends on `from`;
2. `connect(added.flow, id, to)` — the fresh step runs before `to`;
3. `disconnect(linked.flow, from, to)` — the old link is dropped.

One unit so a refused op persists nothing: failure never leaves a half-spliced step behind. `connect` refuses self-links, duplicate links, unknown ends, and cycles (`reaches(flow, to, from)` → "that would make a loop"). Net `dependsOn` effect: `to.dependsOn = (to.dependsOn − {from}) ∪ {id}`, `new.dependsOn = [from]`, all other steps untouched. Arm edges are not spliceable targets: inserting onto an arm-membership edge keeps the `dependsOn` rewrite but the new step does NOT join the arm (arm membership is `dependsOn` on an arm record, D-123 — the connections doc owns that rendering).

### 3.5 Wire behavior on add (exact `dependsOn` rules)

- Palette / pane-menu add: no wire touched. `new.dependsOn = []` (pane) or `[after]` (node menu, §3.2).
- Edge splice (§3.4): `new.dependsOn = [from]`; `to.dependsOn = (to.dependsOn − {from}) ∪ {id}`. If `to` named `from` twice (never produced by `connect`, possible in hand-edited stored flows), only one occurrence is removed — the rewrite is `filter(d => d !== from)` then push `id`, matching the implemented code.
- Gate splice (`spliceApproval`, the "Require approval before this step" button): the gate takes the target's full dependency list and the target is repointed to depend on the gate alone (`target.dependsOn = [gateId]`). This is the ONLY add that steals all of a step's upstreams, and it is allowed to because a gate inserted after its target stops nothing.
- Duplicate (`duplicateStep`, context-menu "Duplicate"): the copy keeps every field of the original — kind, ref, expressions, params, `dependsOn` — under `uniqueStepId(flow, stepId)`. Downstream steps are NOT rewired: they keep depending on the original. A duplicate is a copy of the step, never a silent re-parenting of its successors.
- Arm add (`addArm(flow, branchId, terminal)`): appends another `else if` (or the terminal `otherwise`) as a `branch` record chained with `elseOf` off the chain head — the linked-list rule (`human-input.md` §8 uses the same chain for button arms). Chain membership only; no `dependsOn` is rewritten by `addArm` itself.

### 3.6 Change Node type via right-click (new — proposed)

No caller uses `replaceStep` for kind changes today (the inspector edits fields in place; rename is the only id change). Proposed: a right-click "Change to …" submenu on a node that runs `replaceStep(flow, stepId, next)` where `next` keeps `id` and `dependsOn` and rebuilds kind fields. `replaceStep` takes the whole step (never a patch — a partial merge would leave `paramsExpr` on a step that is now a `transform`) and keeps position. Allowed-switch matrix (proposed; alternatives: allow all switches with field reset, or defer Change Node entirely — marked open in §9.2):

- Lossless (all fields carry over, only the kind tag changes): `transform` ↔ `calculate` (both `{ expr }`); `condition` ↔ `branch` (both `{ conditionExpr }`, same `elseOf` chain role).
- Callable group (`trigger` / `datasource` / `tool` / `query` / `action` / `notify` / `report` / `end`, all `{ ref, paramsExpr }`): switches keep `paramsExpr` but MUST re-pick `ref` through the catalogue picker for the new kind — a `tool` ref is meaningless on a `datasource` step, so carrying it over would stage a refused save. Until the re-pick completes the step renders with `ref: ""` and the existing `NEEDS_REF` refusal, never a guessed ref.
- Cross-shape (any other pair, e.g. `tool` → `transform`, `approval` → `code`, anything → `merge`): kind fields reset to the `blankStep` blank for the new kind (same `persistable` rule as §3.1); `id`, `dependsOn`, label (`name`/`description`), and saved position are kept.
- Wire effects: plain `dependsOn` wires are kind-independent and ALWAYS kept. Kind-attached wiring is dropped with a STATED warning (never silent): `elseOf` is dropped unless both old and new kinds are `branch`/`condition` ("no longer in the arm chain — downstream arm members now depend on nothing"); `merge.sources` is dropped unless the new kind is `merge` (a merge's sources must already exist and be ≥2 — there is no neutral value to carry over, `blankStep` docblock); arm-member steps depending on a de-chained arm record keep their `dependsOn` (D-123: membership is just `dependsOn`) and the panel's Connections section flags the now-plain dependency. Downstream expressions bound to the old kind's outputs (`outputExpr` over renamed/removed fields) become `unknown` ("set in the expression") per the StepIO idiom — never rewritten, never silently rebound.

### 3.7 What a fresh step contains (`blankStep(kind, id, after, ref)`)

Every field present, none guessed: callables `{ ref, paramsExpr: "[{}]" }`; `transform`/`calculate` `{ expr: "{{ 1 }}" }`; `code` `{ inputExpr: "{}", contract: { purpose: "", input: [], output: [{ name: "result", type: "object" }] } }` — empty CONTRACT and no code field whatsoever (the server's `flowModelSchema` requires a body, so a blank `code` step is refused at save until the inspector's generation route writes it); `approval` `{ summaryExpr: JSON.stringify("Approve this?"), awaitSeconds: 86_400 }`; `condition`/`branch` `{ conditionExpr: "" }` staged (`{ persistable: true }` → `"{{ 1 }}"`); `merge` `{ sources: [] }` with no `persistable` escape (refused save on every surface until ≥2 real sources are picked). `dependsOn` is `[after]` when placed after/spliced, absent when placed unconnected. `NEEDS_REF` (exactly the eight kinds whose blank carries `ref: ""`: `trigger`, `datasource`, `tool`, `query`, `action`, `notify`, `report`, `end`) is derived from `blankStep` itself and pinned by `flow-authoring.test.ts` — a kind added to the first `case` group without joining the set is offered as complete when it is not.

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Fixed geometry is reused, never grown (`canvas-layout.ts`: `heightFor`/`widthFor`, invisible input dots via `inputHandleTop`). A freshly added step has no earned description, so its card shows header + pill only until the author writes one:

- Pill rule: `KIND_LABEL[kind]` (`StepInspector.tsx`: `trigger` → "trigger", `datasource` → "named query", `query` → "DB operation", `tool` → "tool call", `transform` → "transform", `calculate` → "calculate", `condition` → "condition", `action` → "action", `code` → "generated code", `approval` → "waits for a person", `notify` → "notify", `report` → "report", `end` → "end", `branch` → `BRANCH_LABEL` ("only if"), `merge` → "continues either way"). The pill is the KIND_LABEL fallback by default — never a fabricated summary of an unconfigured step.
- Description-line rule (earned): the step's own text only; a fresh step shows no description line, same as every undescribed kind.
- Freshly added steps are selected on add (`setSelected(id)` in every add gesture) so the inspector sits on the unconfigured step — the blank's invalid state (empty `conditionExpr`, `ref: ""`, empty `merge.sources`) is the first thing seen, and the refused save names it.

## 5. Panel

Fixed section order is reused, never reordered: Step → Description → Inputs → Kind editor (titled "Parameters") → Outputs → Behavior → Connections → Try this step → Raw → Remove. An add gesture lands the inspector on the fresh step; per-section content for a fresh step:

1. **Step** (open) — kind chip (`KIND_LABEL` + `--k-*` hue) + step id + `name`. The inline card rename (double-click title) is the same `replaceStep` edit as this section's Step ID field.
2. **Description** — the single earned line; empty on a fresh step.
3. **Inputs** (open, count) — `StepInputs` rows for whatever the blank binds (`paramsExpr`/`expr`/`inputExpr` references); a fresh callable shows its required params unbound, each source picker the Dify-style `Set variable` grey well. Allowlist unchanged.
4. **Parameters** (open, count) — the per-kind form body. This is where a fresh step becomes valid: ref picker (callables), condition builder (`condition`/`branch`), contract editor (`code`), sources picker (`merge`, ≥2 from `MERGE_SOURCE_KINDS`), mode/cap/error-mode (`iteration`, when that kind lands).
5. **Outputs** — `StepOutputs` + `StepShape` rename idiom. Headed "Outputs", never the same word as any other head.
6. **Behavior** — `StepBehaviour` + "Require approval before this step" (hidden for `approval` itself). Retry is refused on non-`RETRYABLE_KINDS` (`tool`, `datasource`, `query`, `code`) with the per-kind reason.
7. **Connections** (Dependencies) — the `dependsOn` list editor (§3.5's rewrites are all visible here); the non-drag path for every wiring change.
8. **Try this step** — only when `onTryStep`.
9. **Raw** — escape hatch, collapsed by default. Never a second write path (see `StepRaw`).
10. **Remove** (danger) — `removeStep` unlinks the step AND strips it from every dependent's `dependsOn` (dropping the step alone would leave dependents pointing at nothing — the compiler's `depends on unknown step` about a step the person did not touch).

## 6. Outputs

An add gesture produces no runtime output; this section names what each add hands downstream work:

- Palette / pane-menu / node-menu add: hands the inspector a selected blank (`focusStepId` → shell selects it, `BuilderShell.tsx`) and the canvas a saved position (`putRow`: drop point, pane point, or one card below the source). Nothing else.
- Edge splice: hands the same, plus the §3.4 `dependsOn` rewrite. The spliced step can immediately bind the upstream step's outputs (standard source picker, `outputs.<from>.<field>` roots) — serial rule (§7) guarantees readability.
- Duplicate: hands a complete step (as complete as its original) one card below the source (`src.y + NODE_H + 24`); downstream expressions are NOT copied — the copy's own outputs are bound by its own id.
- Change Node (§3.6): hands the same `id` with rebuilt kind fields; downstream bindings to surviving output names keep working, bindings to removed fields render `unknown`, never silently rebound.
- `removeArm` (the inverse add): relinks the `elseOf` chain around the removed arm; arm members' `dependsOn` is untouched.

## 7. Failure behavior

- Refused saves (spoken, never silent): duplicate id ("this flow already has a step called …"), invalid id (lower-case letters/digits/underscores, leading letter), reserved id (`begin`/`complete` — the engine emits those tasks), self-link, duplicate link, unknown link end, cycle ("that would make a loop"), branch-with-nothing-to-guard (zero/several successors), gate-in-front-of-gate, unconfigured `merge` (no neutral sources value exists), blank `code` (no body until generation), empty `conditionExpr` on staged surfaces, `ref: ""` on `NEEDS_REF` kinds. On per-gesture surfaces a refusal means nothing is added at all — Duplicate is the reliable add there because a copy is as complete as its original (`FlowReview.tsx` docblock).
- Cycle rule: `connect` refuses any link where `reaches(flow, to, from)` — the refusal happens in the pure op (a dragged cycle looks fine; the server's compile error would name the wrong thing).
- Serial/parallel execution rule (stated; rendered by the connections doc): serial steps run in sequence and each step MAY read any earlier step's outputs; parallel siblings (steps sharing an upstream with no `dependsOn` between them) run simultaneously and MUST NOT read each other — a binding to a parallel sibling's output is an authoring error the panel flags, not a value that arrives late. A downstream convergence step (depending on all branches) MAY read from every branch. Nesting (repeat-per-item / until-condition) lives inside Iteration/Loop container frames, never as ad-hoc wiring — see `iteration.md` / `loop.md` for the boundary (per-item vars cross the frame only as the single `results` array).
- No retries at add time: a failed add is a refusal with a message, not a retried op; step runtime retry (`StepRetry` on `RETRYABLE_KINDS`) is Behavior's job, not this doc's.

## 8. Migration/compat

- Additive only: no stored shape changes, no migration of existing revisions, no rename. Every `dependsOn` rewrite above (§3.5) is already the implemented behavior of `FlowReview`/`ChatWorkbench`/`flow-edit` — this doc pins it, it does not change it.
- 50-node guard (adopt Dify's limit as the stated guard): a single execution path supports up to 50 nodes. Client warns (a `localFindings`-style non-blocking finding on the 51st path node naming the path head), server enforces — exact enforcement point (save refusal vs deploy refusal) is an OPEN question (§9.3). Counting rule: longest `dependsOn` chain through the flow (arm records count; Iteration/Loop children count inside their frame when those kinds land). Existing flows over the limit keep running; the guard applies to new adds only.
- Paste scope (staged, stated order): Stage 1 — same-flow Duplicate, which exists today (`duplicateStep`: keeps fields + `dependsOn`, new id, no successor rewiring). Stage 2 (later) — cross-flow paste within the instance: serialize the step (kind fields + label, WITHOUT `id`/`dependsOn`/saved position), assign `uniqueStepId` at the destination, re-evaluate refs against the destination flow's catalogue (a `tool` ref absent at the destination arrives as `ref: ""` + the `NEEDS_REF` refusal, never a guessed binding) and upstream bindings against the destination flow's steps (bindings naming steps absent at the destination render `unknown`, never rebound). Cross-instance paste (config travels across deployments with HTTPS-or-loopback transport) is OUT of scope — stated, not scheduled.
- `START_ID` (`__start__`) / `END_ID` (`__end__`) boundaries are never pasted, duplicated, or change-typed: they are derived every render from model inputs/output, never stored on a revision.
- Unlisted kinds (`UNLISTED_KINDS`, today empty): the palette filter is offer-time only — an existing step of an unlisted kind still renders its card and panel with the unlisted reason shown. Change Node never offers an unlisted kind as a target.

## 9. Open questions

1. Pane-menu ref second step (§3.3): steal the chat canvas's two-step ref picker for callables on the manual builder, or keep single-pick + inspector re-pick (blank arrives with `ref: ""` and the refusal names it)?
2. Change Node matrix (§3.6): is the proposed three-tier matrix (lossless / callable re-pick / cross-shape reset) the right boundary, or should every switch be allowed with full field reset (simpler rule, more rework per change), or is Change Node deferred entirely (delete + re-add covers it)?
3. 50-node guard enforcement: save-time refusal, deploy-time refusal, or warn-only forever? And does the longest-path count include arm records and container children?
4. Cross-flow paste (Stage 2, §8): clipboard shape (full step JSON minus identity vs a compact transfer type), and does paste carry the saved position offset or always land one card below the drop/selection point?
5. Should edge splice offer `approval` (a gate spliced mid-edge takes the upstream's place like `spliceApproval`, not the plain §3.4 rewrite — which semantic wins when both could apply)?

## 10. Non-goals

- No new step kind, no stored-field change, no `flow-expr` allowlist change — `{{…}}` refs use the served roots; anything else stays `unknown`.
- No canvas geometry change — fixed card, `inputHandleTop` dots, `portTop` arm handles, no wire text labels (per the 09-09 lock).
- No palette-hue or dark-mode token work.
- No cross-instance paste, no paste of Start/End boundaries, no snippets library.
- No server/compiler design (how blanks validate, where the 50-node guard enforces) — interaction stops at the refused save and the open question (§9.3).
- No run/debug surface (single-step try-run, variable inspector) — those belong to the run/debug doc, not this one.
