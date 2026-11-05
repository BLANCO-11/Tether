# Run and debug (Status DRAFT 2026-09-09)

> **⚠ Describes the compiled builder's canvas (React Flow), which now opens only for flows not built by Forge.**
> The current builder is specified in [`README.md`](README.md) beside this file; kept for that history.

## 1. Purpose

Let an author trial-run one step with values in front of them, see what each step actually produced on the last run, and walk a flow forward one step at a time — without re-running the whole flow to test one change. This doc upgrades the existing `Try this step` panel section and `lastRunOutputs` read into a per-node Run affordance plus a bottom Variable Inspector and a run-history list. Talk-phase artifact only, no code.

## 2. Dify behavior

What we steal (from `CanvasBehaviors` step-run + variable-inspect sections):

- Single-node trial run: select any node, provide test input in its settings panel, click Run; see the output without running the whole workflow. After the test, a "Last run" record shows execution details — inputs, outputs, timing, error messages.
- Step-by-step run: run nodes one at a time through the workflow; each node's outputs are cached in the Variable Inspector and feed the next node.
- Variable Inspector (bottom-of-screen panel): captures inputs AND outputs from each node after they run; click any variable for full content. Most values are editable — downstream runs use the edited values (e.g. edit LLM-generated SQL, then re-run just the DB node, no full re-run).
- Per-variable reset (revert icon restores the original) plus "Reset all" clearing all cached variables. Editing an inspector value does NOT alter the originating node's "Last run" record.
- Execution history: every execution creates a record; "Last run" on any node shows the most recent inputs/outputs/duration.

What we skip:

- No previous-step mock picker beyond what exists: Dify's "provide test input in its settings panel" plus editable cached upstream vars covers scenario simulation. We do not design a separate mock-output picker — the inspector edit IS the mock mechanism.
- No retry counts/intervals or error-branch/fail-branch design here — failure handling stays in the `Behavior` section (`StepBehaviour`); this doc only reads errors into the Last Run record.
- No Dify image-asset or demo-video behavior.

## 3. Model mapping

No new stored step fields. No `flow-expr` allowlist change in this doc (called out explicitly, not smuggled). Interaction/wiring rules only:

- Run eligibility: every `StepKind` in `packages/client/src/lib/canvas-model.ts` (`STEP_KINDS`) is runnable per-node EXCEPT the exit kinds — `end`, and any `output`/`answer`-equivalent exit node if one is later added. This mirrors Dify's Answer/End exclusion: an exit node declares the flow's result (`endOutputFrom`), it performs no call, so there is nothing to trial-run. The per-node Run section renders nothing for exit kinds (same conditional-mount idiom as `TryStepPanel` today: absent `onTryStep` ⇒ no section).
- Test inputs source: the run form offers exactly the two honest sources `TryStepPanel` already uses — hand-typed values plus offers from connected upstream steps' last recorded outputs (`lastRunOutputs` keyed by step id, via `fieldSources` in `lib/step-try`). Re-running everything upstream is not a preview of one step, it is the flow — out of scope.
- Which kinds are tryable is READ from the catalogue (`tryable.kinds` / `tryable.reasons`), never decided client-side — unchanged rule.
- Run-scoped state (cached inspector overrides, history records, Last Run views) is NOT stored on the step, the revision, or the flow. Candidate runtime shapes below are open runner questions (§9), not stored fields: `lastRun: { inputs, outputs, durationMs, error }`, `inspectorOverride: { stepId, field, value }`, `executionRecord: { id, at, inputs, outputs, durationMs }`. Nothing here reaches `authoredToStoredFlow`, `structureHash`, or the compiler.
- `dependsOn` edge-only drag semantics unchanged; step-by-step order follows the existing topological order (`dependsOn`), never a new stored order field.

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Reuses `heightFor`/`widthFor`; never grows for run state.

- Run state does NOT add card rows, badges, or facts: no "last ran …" line, no duration chip, no error banner on the card. Run visibility lives in the panel (§5) and the inspector/history surfaces, not on the card.
- Status dot/tone (`STATUS_LABEL`, `STATUS_TONE`) unchanged — a failed trial run does not invent a new status; the Last Run record (§5) carries the error text.
- Pill rule unchanged per kind; where no pill data exists, fall back to `KIND_LABEL`, never fabricated text.

## 5. Panel

Fixed order (Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove). This doc touches section 8 only, in place:

1. **Step** (open) — unchanged.
2. **Description** — unchanged (earned line only).
3. **Inputs** (open, count) — unchanged; the run form in §8 reads these rows but does not duplicate them.
4. **Kind editor** (open, count) — unchanged.
5. **Outputs** — unchanged (`StepIO` output table + `StepShape` rename idiom); the place a reader learns what the step SHOULD produce, before running it below.
6. **Behavior** — unchanged (`StepBehaviour` + approval gate).
7. **Connections** (Dependencies) — unchanged; wiring first, then the run that answers "what does this actually produce?".
8. **Run this step** (only when `onTryStep`; exit kinds excluded, §3) — the upgrade of today's `Try this step`, keeping its position:
   - Input form: the component's own declared parameters (`catalogue.entries[ref].params`, via `lib/step-try` `TryParam`), each typed by hand or offered from a connected upstream step's last recorded output. Keeps the `TRY_DIALS_LIVE` warning above the button and the `TRY_NOT_THE_EXPRESSION` honesty sentence verbatim — a green run is evidence the component works, not that the flow's expression feeding it is right.
   - Last Run record view: after a run, inputs used, outputs returned, duration, and error text when failed — the existing `TryResult` rendering extended with duration. Editing inspector values never rewrites this record (it is the origin's history, §6).
   - Step-by-step affordance (proposed, runner-dependent — §9): a "Run next" control that runs the topologically-next step fed by cached outputs; marked open, not designed.
9. **Raw** — unchanged, collapsed by default.
10. **Remove** (danger) — unchanged.

## 6. Outputs

No new bindable outputs. Run visibility reads through existing roots only:

- Per-node Last Run: `inputs` (the values the run actually used — hand-typed or upstream-offered), `outputs` (the payload, dug out of the Foundry envelope the same way `lastRunOutputs` in `builder/page.tsx` does today), `durationMs`, `error` text. Displayed in the panel section (§5.8) and the history list; never a guessed field list — one `response` row plus the expression to read it for catalogue kinds, per the data-kinds rule.
- Variable Inspector (bottom panel): per-node in/out capture after each run; click any variable for full content. Reads the same Last Run records — a second rendering of one computation, not a second opinion.
- **Inspector edits are run-scoped overrides, never stored.** Editing a cached value changes what the NEXT downstream trial run receives; it never writes back to the step, the flow inputs, the revision, or the originating node's Last Run record.
- Per-variable revert icon restores the original captured value; "Reset all" clears all cached overrides (captured records stay — reset clears overrides, not history).

## 7. Failure

- A failed trial run fails the record, not the flow: the Last Run view shows inputs, the error text, timing, and no outputs. Nothing routes, retries, or branches from here — `Behavior` (`StepBehaviour` retry/timeout) owns failure policy; this surface only reports.
- `TRY_DIALS_LIVE` stays: a `tool` run dials the registered URL with the stored credential, and whatever effect that has, happens. No dry-run mode — a dial that pretends is the probe that returns green for a tool which 401s in a real run.
- A green run is evidence the COMPONENT works, not that the flow feeds it the right thing (the `TRY_NOT_THE_EXPRESSION` rule) — unchanged.
- Step-by-step stops at the first failed node (proposed; runner-dependent, §9). Upstream of the design: Dify's Iteration `terminate` default is the analogy, not a stored field.

## 8. Migration/compat

- Current `Try this step` behavior unchanged until the runner lands: same mount condition (`onTryStep`), same catalogue-read tryability, same warnings, same `lastRunOutputs`-keyed upstream offers. This doc renames nothing in code and moves no section.
- Panel order never reordered (component-panel rule): section 8 keeps its position after Connections; the inspector and history surfaces are additive mounts, not section moves.
- Card geometry untouched: no run-state rows on the card, so `heightFor`/`bodyHeight`/`portTop` need no change.
- No `flow-expr` allowlist change ships with this doc; step-by-step variable threading uses existing `outputs.<id>.*` / `inputs.<id>` roots. Anything needing new roots (e.g. `items`/`index`-style scoped vars) is an explicit allowlist call-out, never smuggled.

## 9. Open questions

Runner/server-dependent pieces — isolated here, not designed above:

1. Step-runner endpoint: what API executes one step with supplied test inputs (shape of request/response, auth, credential use)? `TryStepPanel`'s `onTry` prop is the seam; the endpoint behind it is the runner owner's design.
2. Record storage: where do execution history records live (per flow? per step? per workspace?), and what is the retention policy (how many records, for how long)?
3. Step-by-step availability per kind: can every runnable kind participate in ordered runs, or are some (e.g. `approval` waits, `trigger` entry) excluded beyond the exit kinds?
4. Inspector edit audit: are run-scoped overrides logged anywhere (who edited what before a downstream run), or purely ephemeral client state?
5. Duration source: does timing come from the runner response envelope or client-measured wall clock?
6. Concurrent runs: what happens when two trial runs overlap (per-step locking, last-write-wins records)?

## 10. Non-goals

- No new stored step fields, no new `StepKind`, no palette change.
- No `flow-expr` allowlist change (step-by-step threading reuses existing roots).
- No failure-policy design (retry/timeout/error-branch stay in `Behavior` and their own docs).
- No server/compiler design (runner endpoint, record storage, retention) — §9 names the questions, this doc answers none of them.
- No card change (no run-state rows, badges, or facts on the card).
- No palette/builder implementation — talk-phase artifact only, no code.
