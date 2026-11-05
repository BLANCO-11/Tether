# Card and container (Status DRAFT 2026-09-09)

> **⚠ Describes the compiled builder's canvas (React Flow), which now opens only for flows not built by Forge.**
> The current builder is specified in [`README.md`](README.md) beside this file; kept for that history.

## 1. Purpose

One place that says what every canvas card shows, where each affordance sits, and when a step is a container frame instead of a diet card. Readers: the per-kind node docs (each owns its §4 pill rule; this doc aggregates them), the renderer pass (StepNode + canvas-layout), and reviewers checking cross-doc consistency.

Scope: diet-card rendering rules for every kind, badge positions, handle visibility rules, the iteration/loop container-frame exception, card state tints, and dark/light separation. No model changes, no panel order changes, no expression changes.

## 2. Dify behavior

What we steal: the Dify node read — header (icon + name + status) → one config pill naming the concrete thing → one description line. One pill, one line, never a stack of facts. Container nodes (Dify's Iteration/Loop) render as frames holding their child workflow, not as cards.

What we skip: Dify's per-kind card illustrations and inline mini-forms on the card; our card is text-only (header → pill → description). Dify's wire text labels — this pass draws no text on wires (09-09 lock, §8); arm identity reads beside the source dot, not on the edge.

## 3. Model mapping

No new stored data. Every rule here reads stored fields that already exist (or that a sibling node doc proposes and owns):

- Header: `CanvasNode.label ?? id`, kind icon/rail (`KIND` table in `FlowCanvas.tsx` + `--k-*` hues), status (`STATUS_LABEL` / `STATUS_TONE` in `canvas-model.ts`).
- Pill: per-kind derived text (§4 table) or `flag`, which outranks everything (stored `CanvasNode.flag`).
- Description: `step.question ?? purpose` (the `purpose` fact), i.e. the step's own text only — `question` for agent-ish kinds, `contract.purpose` for `code`, `description`/`formMarkdown` first line for the new kinds per their docs.
- Badges/handles: `seamOf` (`Seam`), `flagCount`, `attempt`, `inputHandles`, `arms`, `outputHandles`, `wholeFrom` — all existing `CanvasNode` fields.
- Containers: `children: AuthoredStep[]` nested on the parent step (owned by `docs/nodes/iteration.md` and `docs/nodes/loop.md`); parent id is the only saved-positions unit (`dropOrphaned`/`rekeyPosition`).

`flow-expr` allowlist: unchanged by this doc. No new roots, no new callables.

## 4. Card

Diet card, every leaf kind: header row (icon + name + status) → one config pill → one earned description line. Fixed geometry (`heightFor`/`widthFor` in `canvas-layout.ts`); the card NEVER grows for inputs, question, ref, flag, meta, or arm text. Body is `PAD_Y 16 + ROW_TITLE 20 + ROW_CAPTION 18` (header text + one caption row); ports add height only for `arms.length > 1` and `outputHandles.length`.

Description-line rule (earned, stated once): the step's own text or nothing — never a per-kind sentence. Sources: `question` (agent-ish kinds), `contract.purpose` (`code`), `description` (new kinds), first text line of `formMarkdown` else parsed `approvalQuestion(summaryExpr)` (`approval`). An undescribed step shows no description line.

Pill table — one row per kind (pill rule + fallback). `flag` outranks every row below. Fallback is always `KIND_LABEL`, never fabricated text:

| Kind | Pill rule | Fallback |
|---|---|---|
| `trigger` | `KIND_LABEL` word (`"trigger"`) — entry schedule reads on the Start boundary (`describeStartEntry`), not on a trigger card | `KIND_LABEL["trigger"]` |
| `datasource` | `named query · <ref>` (today's `k.label · ref` idiom) | `KIND_LABEL["datasource"]` (`"named query"`) |
| `query` | `DB operation · <ref>` | `KIND_LABEL["query"]` (`"DB operation"`) |
| `tool` | `tool call · <ref>` (the named endpoint) | `KIND_LABEL["tool"]` (`"tool call"`) |
| `transform` | `step.ref` or short derived summary when present | `KIND_LABEL["transform"]` |
| `calculate` | `step.ref` or short derived summary when present | `KIND_LABEL["calculate"]` |
| `code` | `step.ref` or short derived summary (purpose stays on the description line, not in the pill) | `KIND_LABEL["code"]` (`"generated code"`) |
| `condition` | arm summary (`arms.map(label).join(" / ")`, `describeStartEntry`-style plain text); single arm → `BRANCH_LABEL` (`"only if"`) | `KIND_LABEL["condition"]` |
| `branch` | same arm idiom as `condition` (elseOf chains per `docs/nodes/human-input.md` §8); single arm → `BRANCH_LABEL` | `KIND_LABEL["branch"]` (`BRANCH_LABEL`) |
| `merge` | `KIND_LABEL` word (`"continues either way"`) — a join names no thing | `KIND_LABEL["merge"]` |
| `action` | `step.ref` (the named thing) | `KIND_LABEL["action"]` |
| `notify` | `step.ref` | `KIND_LABEL["notify"]` |
| `report` | `step.ref` | `KIND_LABEL["report"]` |
| `approval` | `waits for a person · N choices` (`buttons.length`; legacy gate with no buttons → bare `waits for a person`); timeout appends `· 3d timeout` when set and unnamed by an arm (owns `docs/nodes/human-input.md` §4) | `KIND_LABEL["approval"]` |
| `end` | boundary card (`END_KIND` `"exit point"`), not a diet card — no pill | — |
| `llm` | `` `<shortModel> · <tempPreset>` `` (`openai/gpt-4o` → `gpt-4o`; variable mode → `$<varName>`; preset `precise`/`balanced`/`creative`/`custom`) (owns `docs/nodes/llm.md` §4) | `KIND_LABEL` (`"LLM"`, new entry) |
| `http` | `` `<METHOD> <host>` `` (`www.` stripped, path dropped: `POST api.example`) (owns `docs/nodes/http-request.md` §4) | `KIND_LABEL` (`"HTTP"`, new entry) |
| `classifier` | PROPOSED (sibling doc owns): category-arm summary (`arms.map(label).join(" / ")`, same arm idiom as `condition`); single/unconfigured → `KIND_LABEL` | `KIND_LABEL` (`"classifier"`, new entry) |
| `extract` | PROPOSED (sibling doc owns): `<N> fields` where N = extracted-field count (`3 fields`); zero/unreadable → `KIND_LABEL` | `KIND_LABEL` (`"extract"`, new entry) |
| `listop` | PROPOSED (sibling doc owns): operation word (`sort` / `filter` / `join` / …); unreadable → `KIND_LABEL` | `KIND_LABEL` (`"list op"`, new entry) |
| `iteration` | container frame, not a diet card (§7): frame header pill `over <step>/<field> · <sequential\|parallel ×N> · <error-mode short label>` (owns `docs/nodes/iteration.md` §4) | `KIND_LABEL` (`"iteration"`) |
| `loop` | container frame, not a diet card (§7): collapsed pill `loop ×<maxCount>`, or `loop until <test>` when `conditionExpr` is set (owns `docs/nodes/loop.md` §4) | `KIND_LABEL` (`"loop"`) |

New-kind rows marked PROPOSED defer to their sibling docs on landing; on conflict the sibling doc wins and this table is re-pinned. Until a new `KIND_LABEL` entry lands, its pill renders the raw kind word.

## 5. Panel

No panel changes in this doc. Panel order is never reordered here — the fixed order (Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove, per `StepInspector.tsx`) is restated only so card/panel consistency checks have one anchor: the card's pill names the concrete thing, the panel's kind editor owns configuring it; the card's description line echoes the panel's Description section read-only.

## 6. Outputs

The card shows no outputs. Output identity on canvas is conveyed by source dots (§7: one per arm, one per `code` output field), never by a field list on the card. What each kind produces is owned by its node doc's §6; catalogue-backed kinds show one `response` row plus the read expression in the panel, never a guessed column list on either surface.

## 7. Failure

Badges (keep positions — `FlowCanvas.tsx` StepNode):

- Seam badge: absolute top-right (`right-1.5 top-1.5`), icon + `model` / `?` text (`seamOf`, `SEAM_CAVEAT`). Shape and text, never colour alone.
- Flag-count dot: absolute `-right-1 -top-1`, numbered (`data-testid="flag-badge"`). `flag` text outranks the pill (§4).
- Status: header-right uppercase word (`STATUS_LABEL`) in its tone (`STATUS_TONE`); `attempt > 1` renders a `try N` chip beside it.
- Edit affordances (`＋ input` / `＋ output` bottom corners, delete-on-select) unchanged.

Handles (when each shows):

- Invisible input dots: one target `Handle` per `inputHandles` entry at `inputHandleTop(step, i)` — fixed 12px pitch below the header, clamped to the card edge (crowd, never resize). Invisible at rest (hover/select reveal); tone still carries bound (`step`) / literal / unset. No text rows beside them — binding reads in the panel.
- `PARAMS_HANDLE` card-level target: whenever `inputHandles.length > 0` (drawn regardless of `wholeFrom`) or as the `wholeFrom` single-target fallback; centred at `headerHeight + PORT_LANDING/2` so it never stacks onto a named dot. The honest landing place for whole-object feeds.
- Per-field source dots (`code` contract outputs): one source `Handle` per `outputHandles` entry at `portTop(step, i)` (22px row grid), label floating beside the dot. Dragging one creates a plain edge — the handle names a field, not a step, so no `sourceHandle` persists.
- Arm exits (`condition`/`branch` chains, `approval` button arms): one source `Handle` per arm at `portTop(step, i)` when `arms.length > 1`, label floating beside the dot. Arm ids ARE persisted (`elseOf` chain records).
- No named ports and no `wholeFrom`: single unnamed target + single unnamed source (connectable, unbound).
- Start/End boundaries: one handle each (Start = source only, End = target only).

Container frame spec (`iteration` / `loop` — the deliberate diet exception):

- Frame header: same header idiom (icon + name + status) + the §4 container pill + earned description line. The frame is a bigger box, NOT `heightFor`/`widthFor`.
- Children layout: the same dagre pass lays children out inside the frame at a smaller rank scale; child positions offset into the frame. Parent-only saved positions (`dropOrphaned`/`rekeyPosition` key on the parent id; child ids never appear in the saved-positions table).
- Edges: top-level edges attach to the container; child steps never appear as flow-level edge endpoints. `dependsOn` edge-only drag semantics unchanged.
- Hover highlight coupling: `connectedTo` expands through the frame — hovering the frame highlights children and vice versa.
- Collapsed vs expanded: open question (§9, shared with `docs/nodes/iteration.md` Q4).

Card state tints (proposed tokens, not hues — the 09-03 lock is layout, not palette; hues stay in `--k-*` / `STATUS_TONE`):

- Selected: `border-accent ring-1 ring-accent/40` (today's rule, kept).
- Running/trying: `node-testing-pulse` class (today's rule, kept).
- Failed: status ring from `STATUS_TONE` (`s.ring`, today's rule, kept).
- Proposal: if tints need tokens, add `--card-selected-*` / `--card-failed-*` role tokens following the existing `--card-*` pattern (dark base + `--l-*` counterparts, byte-identical apply lists per `theme.test.ts`) — token names are an open question (§9).

Dark/light separation: card and step pane read the existing `--card-bg` / `--card-border` / `--card-shadow` role tokens (`.node-card`, `.step-pane` in `globals.css`), with `--l-card-*` light counterparts applied through both the OS-preference and explicit-attribute lists. Border + surface-2 contrast does the segmentation; no palette re-key.

## 8. Migration/compat

- Locks restated (09-09): (a) fixed geometry for diet cards — inputs, question, ref, flag, meta, arm text never grow the card; crowding via `inputHandleTop`, not resize; (b) no wire text labels this pass — arm identity reads beside the source dot; (c) `KIND_LABEL` fallback — a pill that cannot derive its thing renders the kind word, never a fabricated summary.
- Additive: the pill table's new-kind rows and the container spec add rendering rules; existing cards render exactly as today until their kind docs land.
- `heightFor`/`widthFor`/`headerHeight`/`portTop`/`inputHandleTop` stay the single sizing authority shared by dagre, `stepNodes`, and the card style (I-66: three places agree or edges misattach silently).
- Saved positions: parent ids only for containers; no backfill of child positions.

## 9. Open questions

1. Collapsed-container default: do `iteration`/`loop` frames render expanded always, or collapsed to a diet card until opened? (Shared with `docs/nodes/iteration.md` Q4 — decide once, apply to both.)
2. State-tint token names: are `--card-selected-*` / `--card-failed-*` role tokens wanted, or do the current utility classes (`border-accent`, `s.ring`, `node-testing-pulse`) suffice permanently?
3. PROPOSED pill rows (`classifier`, `extract`, `listop`): confirm or correct when the sibling docs land; this table re-pins to them.
4. Arm-label overflow: a 5+-arm chain crowds source dots past `MAX_NODE_H` — crowd further or truncate labels with a `+N` overflow marker?

## 10. Non-goals

- No model changes: no new stored fields, no `flow-expr` allowlist change, no server-owned output-shape change.
- No panel reorder, no new panel sections, no editor idioms (owned by node docs + StepIO).
- No palette-hue work, no wire text labels, no card growth for any leaf kind.
- No container collapse implementation, no nested-container (loop-in-iteration) layout rules beyond loop doc Q5.
- Talk-phase artifact only — no code.
