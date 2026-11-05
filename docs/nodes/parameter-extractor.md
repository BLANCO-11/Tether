# Parameter Extractor (Status DRAFT 2026-09-09)

## 1. Purpose

Turn unstructured natural-language text into structured parameters for downstream tools/APIs/nodes: read one input text with a model, fill a declared parameter schema, and expose one variable per parameter plus a success flag downstream.

## 2. Dify behavior

What we steal (from `agent://AiNodes` § Parameter Extractor):

- Input Variable (required): the text to extract from — user input, an LLM response, or another node's output.
- Model (required): an LLM with strong structured-output capabilities (context understanding + JSON generation).
- Parameter schema (required, list): per parameter — name (key in the output JSON), type (string/number/boolean/array/object), description (guides the LLM), required status. Manual definition, or quick-import from an existing tool to mirror downstream requirements.
- Extraction instructions (required): what/how to extract and format; examples recommended for complex params.
- Inference modes (2 options): Function Call / Tool Call (the model's structured-output features; reliable, strong type compliance) vs Prompt-based (pure prompting; for models without function calling, or when it performs better).
- Memory toggle (optional): include conversation history for context in interactive dialogues.
- Outputs: one variable per defined parameter (named per schema, usable downstream) plus built-ins `__is_success` (`1` success / `0` failure) and `__reason` (error description on failure).
- Branching: single exit — success/failure is distinguished by the `__is_success` value, not by separate exits.

What we skip:

- Nothing structural. The retry-on-failed-extraction counts/intervals/fallback routing the Dify page does not document are open questions here (§9), not decided behavior.

## 3. Model mapping

New stored kind `extract` — a new `AuthoredStep` union variant in `packages/flow-edit/src/index.ts`, a new `StepKind` member in `packages/client/src/lib/canvas-model.ts` (`STEP_KINDS`), and a new `blankStep` case in `packages/client/src/lib/flow-authoring.ts`. Stored fields (all new except `retry`, `name`/`description`):

| Stored field | Type | Default | Validation |
| :--- | :--- | :--- | :--- |
| `inputSource` | string (upstream text variable address, e.g. `outputs.<id>.<field>`) | none — required | must resolve against the served `flow-expr` allowlist; unresolvable renders as `unknown`, never silently rewritten — **no allowlist change in this doc** |
| `model` | string (provider/model id, e.g. `openai/gpt-4o`) | none — required | must name a model the workspace's AI-models page configures; empty refuses save |
| `modelVar` | string \| null (name of an LLM-type shared-config variable, when the picker is in variable mode) | `null` (literal mode) | when set, `model` is ignored; binding resolves server-side. Same storage shape as the `llm` doc (§3 there); exact shape (name vs id) is that doc's open question, reused here, not re-decided |
| `params[]` | `Array<{ name: string; type: "string" \| "number" \| "boolean" \| "array" \| "object"; description: string; required: boolean }>` (mirrors the `llm` doc's `outputFields` row shape) | `[]` | names unique per step, valid identifiers (downstream reads each as a variable); ≥1 entry required before the step is valid; empty list refuses save |
| `instructions` | string (what/how to extract and format, with examples for complex params) | `""` | required non-empty before the step is valid; `{{…}}` refs inside it MUST validate against the served `flow-expr` allowlist — **no allowlist change in this doc** |
| `inferenceMode` | `"function_call" \| "prompt"` | `"function_call"` | required; stored as intent until per-model support is declared (§9) — the panel never hides the picker based on a client-side capability guess |
| `memoryEnabled` | boolean | `false` | chat flows only; no effect in run-once flows (panel says so, same wording as the `llm` doc) |
| `retry` | existing `StepRetry` (count + interval + backoff) | unset (server default) | same editor and semantics as every other retryable kind (`StepBehaviour`) |

Import-from-tool affordance: picking a downstream tool pre-fills `params[]` from that tool's signature as a **one-shot copy, not a live link** — after import, editing the tool's signature or the step's `params[]` does not update the other side. The panel labels the button "Import from tool" and prints the copy-not-link caveat beside it, because a live link would let a catalogue edit silently rewrite a step's output contract.

Expr forms: `inputSource` and any `{{…}}` refs in `instructions` compile to the same `outputs.<id>.<field>` / `inputs.<id>` roots `lib/flow-expr.ts` already builds — no new root, no allowlist change in this doc.

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Never grows; reuses `heightFor`/`widthFor` like every other kind.

- Pill rule: `` `extract · ${params.length} param${s}` `` (e.g. `extract · 3 params`, `extract · 1 param`); `params.length === 0` (unconfigured) → `extract`. If `params` is unreadable, fall back to `KIND_LABEL` (`"Extract"` — new entry, see §8), never a fabricated parameter list.
- Description-line rule: the step's own `description` (`StepLabel.description`) only. No per-kind sentence — an undescribed extractor step shows no description line, same as every other kind.

## 5. Panel

Fixed order (Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove). Per-section fields:

1. **Step** (open) — kind chip (`KIND_LABEL["extract"] = "Extract"` + `--k-*` hue) + step id + `name` (unchanged idiom).
2. **Description** — the single earned `description` line (e.g. "Pull vendor, date, and total out of the invoice email").
3. **Inputs** (open, count) — the `inputSource` row (NAME · SOURCE · TYPE idiom, `StepIO` input table). The source picker is the Dify-style `Set variable` grey well reusing the existing `ParamRow`/`Select` options — `flow-expr` allowlist unchanged.
4. **Extractor editor** (open, count) — the "what it does" body, in this order: model picker (literal ↔ `$variable` toggle, same idiom as the `llm` doc) → `params[]` table (name / type / required / description rows; mirrors the `code` contract editor idiom; "Import from tool" button with the copy-not-link caveat) → `instructions` textarea with examples hint (variable-insert limited to allowlist-valid refs, by construction never typed raw) → inference-mode segmented control (Function call / Prompt) → memory toggle (with the chat-flows-only note).
5. **Outputs** — one row per `params[]` entry + `__is_success` + `__reason`; `StepIO` output table + `StepShape` rename idiom ("Rename what it returns"). Headed "Outputs".
6. **Behavior** — `StepBehaviour` (`retry` count + interval + backoff, timeout) + "Require approval before this step" button (unchanged).
7. **Connections** (Dependencies) — `dependsOn` editor (unchanged).
8. **Try this step** — only when `onTryStep` (unchanged).
9. **Raw** — escape hatch, collapsed by default (unchanged).
10. **Remove** (danger, unchanged).

## 6. Outputs

Named vars, read downstream through the existing `outputs.<id>.*` roots (`lib/step-io.ts` `IoOutput` + readers `→ step/field`):

| Var | Shape | When |
| :--- | :--- | :--- |
| `<param.name>` | per `params[]` entry type | one row per entry; absent/empty on extraction failure (see §7) |
| `__is_success` | `1` (success) / `0` (failure) | always |
| `__reason` | string — error description | on failure; empty on success |

Downstream steps bind these via the standard source picker; `stepIo` treats `extract` as a producing kind (add to the producer set alongside `code`/`tool`/`llm`, never a guessed field list — only the rows above). Branching on the outcome uses **ordinary `condition` arms testing `__is_success`**, built by the existing `buildCondition` over the extractor step (allowlist-valid by construction, round-trippable by `parseCondition`) — no separate success/failure exits on the step itself (Dify parity, §2).

## 7. Failure behavior

- **Extraction failure:** the step completes (it does not throw) with `__is_success: 0`, `__reason` describing the error, and param vars absent/empty. Routing on failure is an ordinary downstream `condition` arm on `__is_success == 0` (§6) — the step itself has a single exit.
- **`retry` (count + interval + backoff multiplier)** via `StepBehaviour`, same semantics as other retryable kinds; whether a retry re-invokes the model before `__is_success: 0` is reported is §9.2 (retry-on-failed-extraction counts).
- **Unconfigured step:** `params[]` empty, `inputSource` unset, `model`/`modelVar` unset, or `instructions` empty each refuse save with the same per-field validation wording as the `llm`/`code` editors — the failure surface is the panel, not the run.
- **Type non-conformance:** in `function_call` mode the schema is enforced by the model's structured-output feature; in `prompt` mode the schema is injected into the prompt and results vary (same caveat as the `llm` doc's structured output).

## 8. Migration/compat

- **New kind, no rewrite:** no existing step rewrites to `extract`. `blankStep("extract", …)` starts with `inputSource: ""`, literal-mode `model: ""`, `params: []`, `instructions: ""`, `inferenceMode: "function_call"`, `memoryEnabled: false` — an unconfigured extractor step refuses save (same rule as an empty `condition`).
- **Palette:** add the Extract tile to the palette/chat-workbench add menus with `KIND_LABEL` `"Extract"`. `NEEDS_REF` is untouched (`extract` carries `model`, not `ref`).
- **Canvas compat:** single exit, no arms — `branchArms`/`collapseArms`/`portTop` need no changes. `seamOf` gains an `extract` clause (sends data to a model, same wording family as the `llm` marker); `outputHandlesOf` stays `code`-only (one source handle per contract output field is a `code` rule, not reused here — extractor outputs are bound by name through the source picker).
- **Caps:** the catalogue's step caps count `extract` steps under their own entry; no shared budget with `llm` or `tool`.

## 9. Open questions

1. **Function-call vs prompt availability per model (biggest):** who declares which models support `function_call` — the workspace AI-models page, the catalogue, or the compiler at run time? Until declared, the panel stores `inferenceMode` as intent (§3) and never gates the picker on a client-side guess; the run surface must say when a model cannot honor `function_call`.
2. **Retry-on-failed-extraction counts:** does `retry` re-invoke the model on `__is_success: 0` (a soft outcome, §7), or only on transport/model errors? Dify's page documents neither counts nor routing — needs a runtime-owner decision before the panel promises it.
3. **`modelVar` storage shape:** shared with the `llm` doc's open question (§3) — name vs id, and what renders when the variable is deleted. Decided once there, reused here.

## 10. Non-goals

- No `flow-expr` allowlist change — `inputSource`/`instructions` refs use the served roots; anything else stays `unknown`.
- No live link between a tool's signature and `params[]` — import is a one-shot copy (§3), never a subscription.
- No separate success/failure exit arms on the step — branching is via ordinary downstream `condition` arms on `__is_success` (§6).
- No server/compiler design (how `extract` compiles to a task, which provider gateway serves `model`) — model mapping stops at the stored shape.
- No raw JSON Schema tab for nested params (visual list only, same scope as the `llm` doc's first pass).
- No palette/builder implementation — talk-phase artifact only, no code.
