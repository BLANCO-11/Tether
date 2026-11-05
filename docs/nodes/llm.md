# LLM (status: DRAFT — 2026-09-09)

## 1. Purpose

Invoke a configured language model as one workflow step: render a role-based prompt from upstream variables, call the model, and expose its answer (plus optional reasoning trace and schema-shaped fields) to downstream steps.

## 2. Dify behavior

What we steal: model picker with shared-config variable; temperature / top-p / frequency / presence penalties with Precise / Balanced / Creative presets; role-based prompt (system / user / assistant) with `{{variable}}` substitution plus a Jinja2 mode; context wired in from a retrieval node's output by reference; structured output (visual field list first); per-node memory toggle for chat continuity; vision detail High / Low; reasoning-tag separation (`text` vs `reasoning_content`); streaming on by default; retries (count + interval + backoff) with fallbacks (default values, error routing, alternative models). Outputs: `text`, `reasoning_content`, schema-shaped fields, file outputs.

What we skip: the AI-generated-schema tab (visual field list only for now — §10 open question covers raw JSON Schema); file-output saving during streaming (no stored affordance for it yet — open question); auto citation tracking for retrieval context (no `citations` output until a consumer needs it); completion-model plain-text prompt mode (chat roles only; completion models are picked by naming a completion model, the prompt blocks still render in order).

## 3. Model mapping

New stored step kind `llm` — a new `AuthoredStep` union variant in `packages/flow-edit/src/index.ts` (alongside `code`, `approval`, …), a new `StepKind` member in `packages/client/src/lib/canvas-model.ts` (`STEP_KINDS`), and a new `blankStep` case in `packages/client/src/lib/flow-authoring.ts`. Stored fields (all new except `retry`, `name`/`description`):

| Stored field | Type | Default | Validation |
|---|---|---|---|
| `model` | string (provider/model id, e.g. `openai/gpt-4o`) | none — required | must name a model the workspace's AI-models page configures; empty refuses save |
| `modelVar` | string \| null (name of an LLM-type shared-config variable, when the picker is in variable mode) | `null` (literal mode) | when set, `model` is ignored; binding resolves server-side. Exact storage shape (name vs id) is an open question (§9) |
| `tempPreset` | `"precise" \| "balanced" \| "creative" \| "custom"` | `"balanced"` | presets write fixed parameter sets (see below); `custom` keeps hand-edited values |
| `temperature` | number 0–1 | per preset (`precise` 0.1 / `balanced` 0.7 / `creative` 1.0) | clamped 0–1; switching preset overwrites all four params |
| `topP` | number 0–1 | per preset (`precise` 0.9 / `balanced` 1.0 / `creative` 1.0) | clamped 0–1 |
| `frequencyPenalty` | number | 0 | server-bounded; client passes through |
| `presencePenalty` | number | 0 | server-bounded; client passes through |
| `promptBlocks` | `Array<{ role: "system" \| "user" \| "assistant"; text: string }>` | `[{ role: "user", text: "" }]` | at least one block with non-empty `text` or the save is refused; `text` carries `{{var}}` references and inline variable pills (§5) |
| `jinja2` | boolean | `false` | when true, block texts render as Jinja2 (loops/conditionals). **Allowlist-affecting — called out here, not designed here** (see §9) |
| `contextStepId` | string \| null (id of the retrieval step whose output is context) | `null` | when set, must name a step in this flow; the reference itself is spelled `{{outputs.<id>.result}}` (or the catalogue's `outputExpr` for that kind) inside a prompt block — `contextStepId` is only the picker's memory of where it came from, mirroring how `conditionExpr` is built by `lib/flow-expr.ts`, never typed |
| `outputFields` | `Array<{ name: string; type: "string" \| "number" \| "boolean" \| "array" \| "object"; required: boolean; description: string }>` (visual structured-output list; mirrors `ContractFieldType` subset) | `[]` (plain-text answer, no schema) | names unique, valid identifiers; empty list = no schema sent |
| `memoryEnabled` | boolean | `false` | chat flows only; no effect in run-once flows (panel says so) |
| `visionDetail` | `"high" \| "low"` | `"low"` | only read when a prompt block references a file variable; otherwise ignored |
| `reasoningSeparated` | boolean | `false` | off = `reasoning_content` stays empty and `<think>` content remains inside `text` |
| `retry` | existing `StepRetry` (count + interval + backoff) | unset (server default) | same editor and semantics as every other retryable kind (`StepBehaviour`) |

NOT stored (deliberately): streaming (runtime default-on, no per-step toggle — matches Dify); citations (no consumer yet); fallback target (open question, §9).

Expr forms: prompt `{{var}}` references compile to the same `outputs.<id>.<field>` / `inputs.<id>` roots `lib/flow-expr.ts` already builds — no new root, no allowlist change in this doc. Jinja2 mode is the one exception and stays an open question (§9).

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Never grows; reuses `heightFor`/`widthFor` like every other kind.

- Pill rule: `` `${shortModel} · ${tempPreset}` ``, where `shortModel` is the model id after the last `/` (`openai/gpt-4o` → `gpt-4o`) or, in variable mode, the variable name prefixed `$` (e.g. `$house-llm · balanced`); `tempPreset` renders `precise` / `balanced` / `creative` / `custom`. If neither `model` nor `modelVar` is set, fall back to `KIND_LABEL` (`"LLM"` — new entry, see §8), never a fabricated model name.
- Description-line rule: the step's own `description` (`StepLabel.description`) only. No per-kind sentence — an undescribed LLM step shows no description line, same as every other kind.

## 5. Panel

Fixed order (Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove). Per-section fields:

1. **Step** (open) — kind chip (`KIND_LABEL["llm"] = "LLM"` + `--k-*` hue) + step id + `name` (unchanged idiom).
2. **Description** — the single earned `description` line (purpose/summary, e.g. "Summarise the overdue invoices for the cover email").
3. **Inputs** (open, count) — every `{{var}}` referenced by `promptBlocks` plus the `contextStepId` source, one row each (NAME · SOURCE · TYPE idiom, `StepIO` input table). Each row's source picker is the Dify-style `Set variable` grey well reusing the existing `ParamRow`/`Select` options — `flow-expr` allowlist unchanged. File variables (vision) appear here as rows bound to file-type upstream outputs when present.
4. **LLM editor** (open, count) — the "what it does" body: model picker (literal ↔ `$variable` toggle) → preset segmented control (Precise / Balanced / Creative / Custom) + four numeric params (custom enabled only on `custom`) → role prompt blocks (System / User / Assistant add-remove-reorder; each block a textarea with inline variable pills, `{{var}}` inserted by the upstream-output picker, matching the panel-idiom direction) + Jinja2 mode toggle (with the allowlist warning label, §9) → context picker (retrieval step, writes `contextStepId` + inserts the reference) → structured-output visual field list (name / type / required / description rows; mirrors the `code` contract editor idiom) → memory toggle → vision detail segmented (High / Low) → reasoning-separation toggle.
5. **Outputs** — `text`, `reasoning_content`, plus one row per `outputFields` entry; `StepIO` output table + `StepShape` rename idiom ("Rename what it returns"). Headed "Outputs".
6. **Behavior** — `StepBehaviour` (`retry` count + interval + backoff, timeout) + "Require approval before this step" button (unchanged).
7. **Connections** (Dependencies) — `dependsOn` editor (unchanged).
8. **Try this step** — only when `onTryStep` (unchanged).
9. **Raw** — escape hatch, collapsed by default (unchanged).
10. **Remove** (danger, unchanged).

## 6. Outputs

Named vars, read downstream through the existing `outputs.<id>.*` roots (`lib/step-io.ts` `IoOutput` + readers `→ step/field`):

| Var | Shape | When |
|---|---|---|
| `text` | string — the answer; includes `<think>` reasoning unless separation is on | always |
| `reasoning_content` | string — thinking only | only when `reasoningSeparated` is true, else empty |
| `<field>` | per `outputFields` entry type | only when `outputFields` is non-empty; the server shapes the model reply to the schema |
| `citations` | not emitted (skipped, §2) | — |

Single exit — no arms/conditions. Downstream `tool`/`transform`/`code` steps bind these via the standard source picker; `stepIo` treats `llm` as a producing kind (add to the producer set alongside `code`/`tool`, never a guessed field list — only the four rows above).

## 7. Failure behavior

`retry` (count + interval + backoff multiplier) via `StepBehaviour`, same semantics as other retryable kinds; attempts surface in the existing `attempt`/retry-policy card facts. Model errors (unknown model, provider outage, schema non-conformance on a model without native JSON support — schema injected into prompt, results vary) fail the step after retries exhaust. Fallback strategies (default values, error routing, alternative models) have NO stored field in this doc — open question (§9); until then authors branch on failure with `condition` arms or duplicate the step.

## 8. Migration/compat

- **Existing `llm_complete` flows → rewrite, not shim.** Every `tool` step with `ref: "llm_complete"` is rewritten to an `llm` step: `model` ← the workspace default model (or the shared-config variable if one exists), one `user` prompt block ← the call's user text, `temperature`/params ← carried values or `balanced` defaults, `retry` ← carried `retry`. Recommend rewrite + backfill (a one-shot `speckit-backfill`-style migration pass over stored flows) because a compat shim would keep two spellings of "call a model" in the compiler, the palette, and `seamOf` — the exact synonym drift the `merge`-kind rule forbids.
- **Catalogue removal.** Delete the `llm_complete` entry from the workspace-tools catalogue so the tool palette and `blankStep("tool", …, "llm_complete")` path stop offering plain model calls; workspace tools cover the remaining tool surface. `LLM_TOOL_REF` and the `seamOf` `tool`+`llm_complete` clause are removed with it, and the seam badge's `SEAM_CAVEAT` wording is updated (the marker becomes "`llm`-kind steps send data to a model" — a kind check, no ref comparison, so it cannot fail closed on a renamed ref ever again).
- **blankStep/palette.** Add the `llm` case to `blankStep` (literal-mode `model: ""`, one empty `user` block, `balanced` preset, everything else defaults — an unconfigured LLM step refuses save on empty model/prompt, same rule as an empty `condition`); add the LLM tile to the palette/chat-workbench add menus with `KIND_LABEL` "LLM"; remove the `llm_complete` tool tile. `NEEDS_REF` is untouched (`llm` carries `model`, not `ref`).

## 9. Open questions

1. Jinja2 mode needs `{% %}` / loop-filter syntax the D-22 allowlist does not serve today — what is the smallest allowlist extension that admits Jinja2 control tags without admitting arbitrary calls? (Called out, not designed.)
2. Raw JSON Schema tab for nested objects/arrays/enums (Dify's second tab) — visual list first; is raw schema a second stored field or a second rendering of `outputFields`?
3. `modelVar` storage shape — variable name or id, and what renders when the variable is deleted?
4. Fallback storage — `fallback: { kind: "default" | "model"; value?; model? }` on the step, or expressed as ordinary downstream `condition` arms (no new field)?
5. Memory template (`USER` template override) — stored per step or workspace-level?
6. File/vision input wiring — a dedicated stored field or just `{{file-var}}` rows in Inputs (§5 assumes the latter; confirm with the runtime owner)?
7. `shortModel` for provider ids without a `/` — full id or a display-name table?

## 10. Non-goals

- No `agent` kind (autonomous tool-calling loop) — this doc is single model call only.
- No `flow-expr` allowlist change (Jinja2 stays a question, §9.1).
- No server/compiler design (how `llm` compiles to a task, which provider gateway serves `model`) — model mapping stops at the stored shape.
- No AI-generated-schema tab, no file-output rows, no `citations` output.
- No palette/builder implementation — talk-phase artifact only, no code.
