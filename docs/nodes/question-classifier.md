# Question Classifier (Status DRAFT 2026-09-09)

## 1. Purpose

Route text down different paths by meaning, not by keyword: take one upstream text variable, ask a model which of N author-defined classes it belongs to, and resume on the arm for the chosen class. Semantic routing replaces conditional logic — the author writes class specs in prose instead of `condition` chains.

## 2. Dify behavior

What we steal (from `agent://AiNodes` Question Classifier):

- Input Variable (required): what to classify; typically the user query, can be any upstream text variable.
- Model (required): the LLM that classifies; faster models for simple classes, stronger models for nuanced distinctions.
- Class list (required): each class has TWO independent texts — Class description (editor body; what the LLM reads; precise/distinguishing, boundary phrases like "anything related to…" / "excluding…" help on overlap; exposed downstream as `class_name`) + Class title (small heading above the editor; canvas label; double-click default CLASS N to rename; exposed downstream as `class_label`). Title and description edit independently.
- Instructions (optional): detailed guidelines for edge cases, ambiguity, business rules to separate nuanced classes.
- One exit arm per class: each class becomes a connectable output path (e.g. After-sales service / Product usage / Other questions each wired to different downstream nodes).
- Notable behavior: title/description independence is the point — a scannable canvas label vs a long LLM-facing spec.

What we skip:

- Exact-match fast path vs always-LLM: not documented on the Dify page — left as an open question (§9), not a decided optimization.
- Fallback/default arm when nothing matches: not documented on the Dify page — left as an open question (§9).
- Retry counts/intervals, error routing: not documented on the Dify page — failure handling follows our standard `StepBehaviour` (§7).

## 3. Model mapping

New stored kind `classifier` — a new `AuthoredStep` union variant in `packages/flow-edit/src/index.ts` (alongside `code`, `approval`, …), a new `StepKind` member in `packages/client/src/lib/canvas-model.ts` (`STEP_KINDS`), and a new `blankStep` case in `packages/client/src/lib/flow-authoring.ts`. Stored fields (all new except `retry`, `name`/`description`):

| Stored field | Type | Default | Validation |
| :--- | :--- | :--- | :--- |
| `inputSource` | `{ from: "step"; stepId: string; field: string } \| { from: "input"; inputId: string }` (which upstream text feeds the classifier; mirrors `flow-expr` `Source` minus the `literal`/`self` arms) | none — required | must name an existing upstream step + text field, or an existing flow input; the panel refuses save while unbound |
| `model` | string (provider/model id, e.g. `openai/gpt-4o`) | none — required | must name a model the workspace's AI-models page configures; empty refuses save |
| `modelVar` | string \| null (name of an LLM-type shared-config variable, when the picker is in variable mode) | `null` (literal mode) | when set, `model` is ignored; binding resolves server-side — same pattern as `docs/nodes/llm.md` §3 |
| `classes[]` | `Array<{ title: string; description: string }>` | `[]` (blank step starts with two empty classes, `CLASS 1` / `CLASS 2`, so the ≥2 rule is satisfiable by filling in, not by discovering the add button) | ≥2 classes required; `title` unique per step (non-empty, valid identifier — it becomes the arm-test value and the `class_label` value); `description` non-empty (the LLM reads it; an empty description refuses save) |
| `instructions` | string | `""` (optional) | free prose; no validation beyond length cap |
| `retry` | existing `StepRetry` (count + interval + backoff) | unset (server default) | same editor and semantics as every other retryable kind (`StepBehaviour`) |

NOT stored (deliberately): exact-match fast-path flag (§9), fallback-arm flag (§9), streaming, citations.

Expr forms and allowlist — **explicit call-out, not smuggled**: `inputSource` resolves through the existing `outputExpr`/`rowsExpr` tables (`outputs.<id>.<field>` / `inputs.<id>` roots `lib/flow-expr.ts` already builds) — no new root, no new callable, no allowlist change in this doc. The class-arm conditions (§8) are built by the existing `buildCondition` (`field_eq` on `class_name`) — allowlist-valid by construction, round-trippable by `parseCondition`.

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Never grows; reuses `heightFor`/`widthFor` like every other kind; invisible input dots via `inputHandleTop`, arm handles via `portTop`.

- Pill rule: `classify · N classes` where N = `classes.length` (e.g. `classify · 3 classes`). If `classes` is unreadable or empty, fall back to `KIND_LABEL["classifier"]` (`"Classify"` — new entry, see §8), never a fabricated summary.
- Description-line rule: the step's own `description` (`StepLabel.description`) only. No per-kind sentence — an undescribed classifier step shows no description line, same as every other kind. (The class titles/descriptions are canvas arm labels and panel rows, not the card description.)

## 5. Panel

Fixed order (Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove). Per-section fields:

1. **Step** (open) — kind chip (`KIND_LABEL["classifier"] = "Classify"` + `--k-*` hue) + step id + `name` (unchanged idiom).
2. **Description** — the single earned `description` line (e.g. "Route support questions to the right queue").
3. **Inputs** (open, count) — the `inputSource` picker: upstream step + text field (or flow input) in the Dify-style `Set variable` grey well, reusing the existing `ParamRow`/`Select` options. `flow-expr` allowlist unchanged (§3).
4. **Classifier editor** (open, count) — the "what it does" body, in this order: model picker (literal ↔ `$variable` toggle, same component as the LLM node) → class list (one row per class: title input + description textarea, add/remove; double-click renames the title in place per the Dify idiom; titles validated unique, descriptions validated non-empty) → instructions textarea (optional, with the one-line hint "edge cases and tie-breaks between overlapping classes").
5. **Outputs** — `class_name` + `class_label` rows (§6); `StepIO` output table + `StepShape` rename idiom ("Rename what it returns"). Headed "Outputs".
6. **Behavior** — `StepBehaviour` (`retry` count + interval + backoff, timeout) + "Require approval before this step" button (unchanged).
7. **Connections** (Dependencies) — `dependsOn` editor (unchanged).
8. **Try this step** — only when `onTryStep` (unchanged); runs against an authored sample text.
9. **Raw** — escape hatch, collapsed by default (unchanged).
10. **Remove** (danger, unchanged).

`StepBehaviour` keeps the default retryable-kind rule (classifier retries like `llm`: a retry re-runs the classification call; it never re-opens anything a person answered, so no `NO_RETRY_REASON` entry).

## 6. Outputs

Named vars, read downstream through the existing `outputs.<id>.*` roots (`lib/step-io.ts` `IoOutput` + readers `→ step/field`):

| Var | Shape | Meaning |
| :--- | :--- | :--- |
| `class_name` | string — the chosen class's identity (the description-side key the LLM selected) | which class won |
| `class_label` | string — the chosen class's `title` | the scannable label for the same choice |

Title/description split preserved end to end: `description` is what the model reads to decide; `title` is what the canvas shows and what downstream branches test. Downstream steps bind these via the standard source picker; `stepIo` treats `classifier` as a producing kind (add to the producer set alongside `code`/`tool`/`llm`, never a guessed field list — only the two rows above). Arm membership (which downstream runs) is decided by the arm chain (§8), not by reading these vars — the vars are for display and further logic.

## 7. Failure behavior

- **Model errors** (unknown model, provider outage): fail the step after `retry` exhausts, same semantics as the `llm` kind (`StepBehaviour` count + interval + backoff).
- **Validation failures** (fewer than 2 classes, duplicate/empty title, empty description, unbound `inputSource`/`model`): refuse save in the panel; the step never reaches the compiler.
- **Ambiguous input** (text plausibly fits two classes): resolved by the model guided by `instructions` + boundary phrases in the class descriptions — no error, no tie-break arm in this doc (§9 covers whether a fallback arm exists).
- **No retry carve-out:** unlike `approval`, classifier retries are safe and allowed (re-running classification has no human-visible side effect).

## 8. Migration/compat

- **Additive new kind:** existing flows have no `classifier` steps and are unaffected. No migration of stored revisions. `NEEDS_REF` is untouched (`classifier` carries `model`, not `ref`).
- **blankStep/palette:** add the `classifier` case to `blankStep` (unbound `inputSource`, literal-mode `model: ""`, two empty classes `CLASS 1` / `CLASS 2`, `instructions: ""` — an unconfigured classifier step refuses save on empty model/input/description, same rule as an empty `condition`); add the Classify tile to the palette/chat-workbench add menus with `KIND_LABEL` "Classify".
- **Catalogue:** no tool-catalogue entry is added or removed (unlike the `llm_complete` → `llm` rewrite — there is no legacy tool spelling of "classify" to retire). The catalogue's `outputs.classifier` entry must gain a template describing the two-row shape (`class_name`, `class_label`); until the server serves it, the panel shows the rows as **declared by the step's own `classes[]`** (step-owned data, not a guessed shape — consistent with component-panel §6).
- **Canvas compat:** an unrecognized `classifier` kind renders as a diet card with the `KIND_LABEL` pill until the arm renderer lands; `branchArms`/`collapseArms`/`portTop` need no changes (arms are `branch` records, below).

Arms mapped onto our branch idiom (decision, stated — same shape as `docs/nodes/human-input.md` §8): each entry of `classes[]` materializes as a **`branch` step chained with `elseOf` off the classifier head** — the same linked-list chain `addArm`/`removeArm`/`chainOf` already manage. The class-arm branch step carries `conditionExpr` built by the existing `buildCondition` over the classifier step testing `class_name == "<title>"` (`field_eq` on the `class_name` field with the class title as value — allowlist-valid by construction, round-trippable by `parseCondition`). Arm membership for downstream steps is plain `dependsOn` (D-123), and the compiler's existing refusal of `elseOf` + `dependsOn` together applies to arm records unchanged. Adding a class = `addArm`-equivalent (new branch record + condition); removing a class = `removeArm`-equivalent (relink the chain around it). Titles are the test values, so renaming a title rewrites its arm's `conditionExpr` in the same edit — never a stale arm testing the old title.

## 9. Open questions

1. **Exact-match fast path vs always-LLM:** Dify documents neither. Options: (a) always call the model (simplest, predictable cost); (b) exact string match on title/description short-circuits the call (cheaper for keyword-obvious inputs, but silently bypasses `instructions`). Recommendation: (a) now — (b) needs a spec for what "exact" means before it earns a stored flag.
2. **Fallback arm when nothing matches:** Dify documents none. Options: (a) no fallback — the model must pick one of N (validation guarantees ≥2, so there is always a choice); (b) additive opt-in fallback arm (a terminal `else` branch record with no `conditionExpr`, per the branch idiom) for low-confidence inputs. Recommendation: (a) now, (b) as an additive field later — the chain idiom already has a place to put it.

## 10. Non-goals

- No `flow-expr` allowlist change — `inputSource` and the arm conditions use the served roots and `buildCondition` only (§3, §8).
- No canvas geometry change — fixed diet card, `inputHandleTop` dots, `portTop` arm handles, no wire text labels (per the 09-09 lock).
- No parameter-extraction schema (that is the Parameter Extractor node, a separate doc) — this node outputs exactly `class_name` + `class_label`, never per-parameter rows.
- No agent/loop behavior — single classification call only, no tool-calling, no iteration.
- No server/compiler design (how `classifier` compiles to a task, which gateway serves `model`) — model mapping stops at the stored shape.
- No palette/builder implementation — talk-phase artifact only, no code.
