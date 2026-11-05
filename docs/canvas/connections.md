# Connections — what every wire means

> **⚠ Describes the compiled builder's canvas (React Flow), which now opens only for flows not built by Forge.**
> The current builder is specified in [`README.md`](README.md) beside this file; kept for that history.

**Status:** DRAFT — 2026-09-09

## 1. Purpose

One wire on the canvas means exactly one model fact — a `dependsOn` entry, a
field binding, or an arm exit. This doc is the taxonomy that makes that true:
which wires exist, where each one anchors, and what the canvas refuses to draw.
It covers the six wire kinds (§3), the render rules (labels live at the source
card only — never mid-wire text, per the 09-09 lock), and the validation table
(rule → panel message, §7).

## 2. Dify behavior

What we steal:

- One link per exit: each branch/button arm gets its own wire out of the
  decision card (human-input doc §8: one button = one arm = one wire).
- Fan-in drawn, not implied: converging arms each draw their own wire into the
  join (our `merge`, via `mergeAwareLinks`).
- Scoped iteration: children wire inside the frame; only the frame's declared
  input/output crosses it (iteration doc §4–§6, loop doc §4–§6).

What we skip:

- Mid-wire text labels. Dify floats condition text along the wire; this pass
  does not (09-09 lock: links = cards + panels only). The arm label reads at
  the source card's handle and in the Connections panel (§4, §5).
- Animated run-state wires and per-wire throughput badges. Status lives on the
  card (`STATUS_LABEL` / `STATUS_TONE`), not on the wire.
- Parallel-execution swimlanes. `mode: "parallel"` (iteration) changes
  scheduling, never wire rendering.

## 3. Model mapping

Interaction and wiring rules. Every claim traces to a stored field or an
explicit open question — nothing here invents model data.

**The edge model** (`packages/client/src/lib/canvas-model.ts`):

- `CanvasEdge = { source, target, sourceHandle? }`. `sourceHandle` is set on
  exactly one wire kind — arm exits redrawn by `collapseArms` (source = chain
  head, `sourceHandle` = arm step id). All other wires carry no handle.
- Topology is `dependsOn`, edited by edge-only drag: a drop onto a card (or
  onto `PARAMS_HANDLE`) travels the `onConnectSteps(from, to)` path; a drop
  onto a named field dot travels `onConnectToField(from, to, field)`. There is
  no other gesture that writes `dependsOn`.
- `mergeAwareLinks(dependsOn, sources)` is drawing-only: a `merge`'s `sources`
  draw incoming wires exactly like `dependsOn` entries, but they confer no arm
  membership (`armMembership` deliberately does not call it).

**The six wire kinds:**

| # | Wire | Source anchor | Target anchor | Model fact |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Single control+data link (default) | card source handle (unnamed) | whole-step target (`PARAMS_HANDLE = "__params__"`, `FlowCanvas.tsx`), styled at `headerHeight + PORT_LANDING/2`; unnamed target when the step has no known fields | one `dependsOn` entry (`onConnectSteps`) |
| 2 | Multi-input links | upstream card source | one invisible-at-rest dot per bound field (`inputHandleTop`: `headerHeight + 8`, 12px pitch, clamped to `heightFor - 12`; tone = bound / literal / unset) | one field binding per wire (`onConnectToField`); unbound fields draw no wire |
| 3 | Arm exits | one handle per arm on the collapsed head (`portTop`: `headerHeight + PORT_LANDING + index*PORT_ROW + PORT_ROW/2`, clamped), labeled by the arm at the source card only | downstream card target | `elseOf` chain membership + the downstream step's `dependsOn` on the arm step (`linkSource` reports the arm id; `collapseArms` redraws the edge from the head with `sourceHandle` = arm id) — covers `branch` chains and human-input button arms (`docs/nodes/human-input.md` §8) |
| 4 | Fail-branch | proposed: one handle on the failing step, orange tone | downstream card target | the error-handling predicate defined by `docs/nodes/error-handling.md` (sibling draft, in flight — this doc proposes rendering only: color + anchor, never the predicate's field names) |
| 5 | Timeout arm | proposed, not finalized: styled as an arm handle with a clock marker (§9) | downstream card target, or unwired (valid: "the run ends", human-input doc §7) | human-input terminal `else` — the `branch` record with no `conditionExpr` at the chain end (human-input doc §8) |
| 6 | Fan-in | one wire per converging arm (each arm's own handle, §3 row 3) | `merge` card target | each wire is its arm's `dependsOn`-via-`sources` entry drawn by `mergeAwareLinks`; N arms = N wires, never one merged wire |

**Rules:**

- A wire always equals a `dependsOn` entry OR a field binding OR an arm. The
  table above enumerates the mapping; there is no fourth kind of wire.
- `code` output-field handles (`outputHandlesOf`: one per contract output key,
  `code` only) are anchors, not edges: a drag from one creates a plain edge
  through `onConnectSteps` with no persisted `sourceHandle` (the handle names a
  field, not a step). Downstream field selection is the target dot's job.
- Dangling or invalid wires are refused with a stated message — never silently
  dropped (§7 table).
- Parallel-sibling reads are refused: a step inside one arm (or one
  iteration/loop child scope) MUST NOT bind a field to a sibling arm's
  per-arm/per-item state. Rendered as a refused connection + validation
  message, never as a wire.
- Frame boundary rule (iteration doc §3–§6, loop doc §3–§6): no wire crosses an
  iteration/loop frame except via the declared crossings — in via `arraySource`
  (iteration) / `loopVars[].initial` (loop), out via `results` (iteration) /
  final loop-var state (loop). Child `dependsOn` stays inside the parent scope;
  the parent id is the only edge endpoint the flow level sees. Internals never
  wire outside.

`flow-expr` allowlist: unchanged by this doc (explicitly — bindings validate
against the served allowlist; failures render `unknown`, never a rewritten
ref).

## 4. Card

Fixed geometry is reused, never grown (`lib/canvas-layout.ts`: `heightFor` /
`widthFor`, invisible input dots via `inputHandleTop`, arm/output dots via
`portTop`).

- Arm labels read at the source card's handle (the floating label beside each
  arm dot), never as mid-wire text — the 09-09 lock. One label per arm handle;
  the wire itself carries no text.
- The card pill fallback is `KIND_LABEL` — never fabricated text. A wire never
  invents a label the model cannot express: an arm with no readable condition
  shows the kind word at the card, and the wire stays unlabeled.
- Timeout arm (proposed): arm handle + clock marker; marker shape is an open
  question (§9). Until decided, a timeout arm renders as a plain arm handle.
- Fail-branch (proposed): orange tone on handle and wire, per the
  error-handling doc predicate. Tone is the only wire color rule in this doc;
  all other wires share the single default tone.
- Card pill and description line are untouched by wiring: header → pill →
  description, as the diet pass defines. Wires attach to dots; dots never buy
  rows.

## 5. Panel

Fixed section order is reused: Step → Description → Inputs → Kind editor →
Outputs → Behavior → Connections → Try → Raw → Remove. Only the Connections
section is new behavior here:

- **Connections (Dependencies)** lists the step's own `dependsOn` upstream
  plus downstream readers, one row per wire in §3 rows 1/3/4/5/6, and one row
  per bound field in §3 row 2 (field name + source step). Unbound fields are
  not rows here — they read in Inputs.
- Child wiring inside an iteration/loop frame is internal and never appears in
  a flow-level Connections section (iteration doc §5.7, loop doc §5.7).
- `merge` rows name `sources` entries as converging arms, visually grouped
  apart from plain `dependsOn` entries.
- Every refused connection (§7) surfaces its message in this section (and, for
  field bindings, beside the offending Inputs row). Refusals are stated where
  the author works, never console-only.

## 6. Outputs

Wires produce no vars. This section exists so the mapping table is checkable:
for each wire kind, what a downstream step may read after it.

| After this wire | Downstream reads |
| :--- | :--- |
| Single link (§3.1) | the upstream step's outputs via the standard source picker (`outputs.<stepId>.<name>` shape) |
| Multi-input link (§3.2) | the bound field's value, in that field only; sibling fields are unaffected |
| Arm exit (§3.3) | the arm step's outputs; for human-input button arms, `<field.name>` values + `__action_id` + `__action_value` + `__rendered_content` (human-input doc §6) |
| Fail-branch (§3.4) | as defined by `docs/nodes/error-handling.md` — not restated here |
| Timeout arm (§3.5) | expiry path: downstream reads whatever the timeout arm's own outputs declare; unwired = the run ends, nothing downstream reads |
| Fan-in (§3.6) | the `merge` step's outputs (whichever arm ran); per-arm internals are not visible past the join |

## 7. Failure

Validation table — each rule → the panel message. Refusals name the step(s);
nothing fails silent.

| Rule | Panel message |
| :--- | :--- |
| Drop onto `PARAMS_HANDLE` that would cycle (`dependsOn` round-trip) | "Connecting <from> after <to> would make a loop — connection refused." |
| Drop onto a named field dot naming an unknown field (`fieldDropTarget` → null path taken as whole-step, or `parseParams` finds no such param) | "There is no input called <field> on <to> — bound as a whole-step link instead." (whole-step link, never a dropped binding) |
| `elseOf` + `dependsOn` together on an arm record (existing compiler refusal) | "An arm cannot also depend on steps directly — move the dependency to the chain head." |
| Parallel-sibling read (field bound to a step in a different arm / a different item scope) | "<to>.<field> cannot read <from>: steps in different arms (or different per-item scopes) share no state — read the branch head or the frame's declared output instead." |
| Frame-crossing wire (child `dependsOn` naming a flow-level step, or a flow-level field binding naming a child id) | "<child> lives inside <frame> — wire to <frame> itself (its <arraySource / results / loopVars>) instead." |
| Dangling endpoint (edge names a step id that no longer exists) | "A wire points at <id>, which no longer exists — remove the wire or re-point it." (edge stays drawn flagged until the author acts; never auto-deleted) |
| Fan-in into non-`merge` (N arm wires into an ordinary step) | "Only a merge joins arms — <to> runs when any upstream finishes, not as a join." (wires stay; semantics stated, not redrawn) |
| Timeout arm wired twice / button arm unwired | Timeout double-wire refused ("<step> already has a timeout path."); an unwired button arm is valid but flagged: "No steps run when <button> is chosen." |

## 8. Migration/compat

- Additive rendering rules only: existing `dependsOn` edges redraw identically
  (single-link wires are today's edges). No stored revision changes.
- `PARAMS_HANDLE`, per-field dots, and `portTop` arm handles already exist in
  `FlowCanvas.tsx`; this doc renames nothing and moves no handle.
- Human-input button/timeout arms reuse the `elseOf` chain idiom (human-input
  doc §8): `branchArms` / `collapseArms` / `portTop` need no changes; old
  passive gates (no arms) render exactly as today.
- Iteration/loop frames: the boundary rule restates the two node docs; no edge
  migration — flows contain no such steps yet.
- Fail-branch and timeout-arm marker are staged surfaces: until the
  error-handling doc lands and the marker shape is decided (§9), failing steps
  draw plain wires and timeout arms draw plain arm handles.

## 9. Open questions

1. **Wire labels at source cards (kind-worded?):** arms show their condition /
   button text today. Should the label be kind-worded when the expression is
   long (e.g. truncate to `only if <test>` in the `describeStartEntry` style
   vs full text)? Proposed: reuse the card pill rule — short derived summary,
   `KIND_LABEL` fallback — but confirm truncation length with the canvas pass.
2. **Timeout-arm marker shape:** clock icon vs `⏱` glyph vs distinct dash
   pattern on the wire? Proposed: clock marker on the source handle, wire
   itself unchanged (keeps the no-mid-wire-text lock trivially true). Needs a
   design decision before finalizing §4.
3. **Fail-branch predicate ownership:** this doc renders the wire; the
   error-handling doc owns the predicate. Confirm the predicate's stored field
   names before §3 row 4 stops saying "proposed".

## 10. Non-goals

- No new step kind, no `dependsOn` semantics change, no edge-only drag change.
- No `flow-expr` allowlist change (called out explicitly in §3, not smuggled).
- No mid-wire text labels (09-09 lock — respected throughout; labels live at
  the source card and the panel).
- No card-geometry change — fixed card, `inputHandleTop` dots crowd, `portTop`
  arm handles, `KIND_LABEL` fallback.
- No palette-hue or dark-mode token work.
- No run-state wire animation, no throughput badges, no parallel swimlanes.
- No email/transport, web-app surface, or Service API (human-input delivery is
  that doc's §9, not this doc's).
