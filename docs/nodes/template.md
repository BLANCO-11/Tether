# Template (transform Jinja2 text mode)

Status: **DRAFT** — 2026-09-09

## 1. Purpose

Give the `transform` step a second mode for rendering free text: today a transform is a single jq/Pebble expression (`expr`) that reshapes data; a template mode renders a Jinja2 text document (`templateText`) with `{{var}}` interpolation plus `{% if %}` / `{% for %}` control flow, and returns the rendered string as its single output. Expression mode stays byte-identical to today; template mode is for composing emails, summaries, prompts, and joined lists without hand-writing jq string assembly.

## 2. Dify behavior

What we steal from Dify's Template node (see TransformNodes Template section):

- Full Jinja2 rendering: `{{ variable }}` interpolation, `{% if %}…{% endif %}` conditionals, `{% for x in list %}…{% endfor %}` loops with `loop.index`, dot/bracket access (`user.name`, `items[0]`), and filters `upper` / `round` / `replace` / `join` / `default`.
- Graceful missing-data authoring pattern: `{{ missing | default("fallback") }}` renders a fallback instead of failing — Dify's documented idiom for optional upstream fields, and ours (§5).
- Single rendered-text output: the node returns one string, not a field list; downstream reads it whole.
- 400k-character output limit: rendered text is capped (server-enforced); over-limit is a step failure, not a truncation.

What we skip:

- Interactive HTML forms are Chatflow-surface and OUT OF SCOPE. Dify's Template node doubles as a form renderer in Chatflow (rendering HTML inputs a person fills in); we have no chat surface, no form-hosting run page, and no field-collection semantics outside `approval`'s human-input step. If form collection is needed, that is the human-input doc's `fields[]`, not this kind. Stating the boundary once: this doc renders text from data; it never renders inputs for a person.

## 3. Model mapping

EXTEND the stored kind `transform` — no new kind. Today a transform stores (`packages/flow-edit/src/index.ts`):

- `{ kind: "transform" | "calculate"; id: string; expr: string; dependsOn?: string[] }` — a single expression string; blank steps start at `expr: "{{ 1 }}"` (`blankStep` in `packages/client/src/lib/flow-authoring.ts`); `localFindings` blocks save when `expr` is empty.

New stored fields on `transform` only (`calculate` is untouched):

| Stored field | Type | Default | Validation |
| :--- | :--- | :--- | :--- |
| `mode` | `"expression" \| "template"` | `"expression"` | required; see §8 — absent means expression |
| `templateText` | `string` (Jinja2 source) | `""` | required non-empty when `mode: "template"`; ignored when `mode: "expression"` (stored always, read only in template mode) |
| `expr` | existing field, kept | `"{{ 1 }}"` (blank default, unchanged) | required non-empty when `mode: "expression"` (existing `localFindings` rule, unchanged); ignored when `mode: "template"` |

Notes on each field:

- `mode` discriminates which of `expr` / `templateText` the compiler renders. Expression mode is byte-identical to today: same builder, same `validateAgainstAllowlist` path, same output. Switching modes never rewrites the other field — an author can toggle back without losing work.
- `templateText` is raw Jinja2 source, stored verbatim. `{{var}}` references inside it MUST validate against the served `flow-expr` allowlist — **no allowlist change in this doc**: refs that fail it render as `unknown` rows in Inputs (§5), never silently rewritten. Which Jinja2 control tags and filters the allowlist admits is the shared open question (§9.1), decided once with the LLM doc.
- Template inputs are every `{{var}}` parsed out of `templateText`, one Inputs row each (NAME · SOURCE · TYPE, Set-variable wells — §5). This is mining for display only, like `TransformForm`'s `readStepId(step.expr, upstream)` today: the template text stays the source of truth; the rows are bindings, not a second copy.

Expression forms and allowlist — **explicit call-out, not smuggled**: template mode uses the existing `outputs.<id>.<field>` / `inputs.<id>` roots for its `{{var}}` bindings (same construction as `buildCodeInput` / `buildSingleParams` — by picker, never typed). `{% if %}` / `{% for %}` / `loop.index` / filters (`upper`, `round`, `replace`, `join`, `default`) are Jinja2 control syntax the D-22 allowlist does not serve today; whether they need an allowlist extension, a template-scoped grammar, or server-side-only validation is §9.1, shared with `docs/nodes/llm.md` §9.1. This doc proposes no allowlist edit.

## 4. Card

Fixed geometry is reused, never grown (`lib/canvas-layout.ts`: `heightFor`/`widthFor`, invisible input dots via `inputHandleTop`). The card shows header (icon + name + status) → one config pill → one description line.

- Pill rule: expression mode keeps today's pill (the derived expression summary / ref the card already shows). Template mode shows `template · N vars` where N = the count of distinct `{{var}}` references parsed from `templateText` (e.g. `template · 3 vars`; N = 0 renders `template`). If `templateText` is unreadable/empty, fall back to `KIND_LABEL["transform"]` (`"transform"` in `StepInspector.tsx`) — never a fabricated summary.
- Description-line rule (earned, per component-panel §4): the step's own `description` only. Never a per-kind sentence, never the first line of the template.

## 5. Panel

Fixed section order is reused: Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove. Only the kind editor's interior is new, in this order:

1. **Mode** — `mode` segmented control (`expression` / `template`). Switching preserves both `expr` and `templateText` (§3); the sections below re-render for the active mode.
2. **Expression editor** (when `mode: "expression"`) — the existing `TransformForm` unchanged (Input picker + raw-expression box + output ref line).
3. **Template editor** (when `mode: "template"`) — `templateText` textarea with variable-insert limited to allowlist-valid refs (same picker idiom as the expression editor's "read a step's output", inserting `{{ outputs.<id>.<field> }}` — by construction, never typed raw). Below the textarea, the `default()` authoring hint in one line: `{{ outputs.<id>.<field> | default("fallback") }}` for optional fields (§2). The `{% if %}` / `{% for %}` / filter syntax is plain text in the textarea; the panel offers no builder for control tags (open question whether it ever should — §9).
4. **Inputs** (the fixed Inputs section, not part of the kind editor) — every `{{var}}` parsed from the active source (`expr` in expression mode via the existing `stepIo` path; `templateText` in template mode), one row each in NAME · SOURCE · TYPE rows with the Dify-style `Set variable` grey well reusing the existing `ParamRow`/`Select` options. `unknown` renders as "set in the expression", never "not set". Loop variables bound by `{% for x in … %}` are template-local and MUST NOT appear as Inputs rows — they are not upstream bindings.
5. **Outputs** (the fixed Outputs section) — a single `result` text row + the expression to read it (§6). NOT an editable field list.

`StepBehaviour` keeps the kind's existing rule (`transform` is pure — retry does nothing; existing `NO_RETRY` wording, unchanged).

## 6. Outputs

Named vars: exactly one — `result`, the rendered string.

| Var | Shape | When |
| :--- | :--- | :--- |
| `result` | string — the fully rendered template | always (template mode) |

How downstream reads it: the standard source picker (`outputs.<stepId>.result` via the served `outputExpr` shape for `transform`, never hardcoded). The catalogue's `outputs.transform` entry must describe both modes (expression shape unchanged; template shape = single text `result`) — until the server serves the template shape, `step-io.ts` reports it as step-declared (the mode flag is step-owned data, not a guessed endpoint shape — consistent with component-panel §6). Server-owned shapes are never invented client-side: no `caution` text is written here; the catalogue's stays.

400k-character cap: enforced server-side at render; over-limit fails the step (§7). The Outputs head hint states the cap in one line.

## 7. Failure behavior

- **Unparseable template (unbalanced `{{ }}` / `{% %}` tags):** the step fails before render. Who validates — client preview (`validateAgainstAllowlist`-style check on save) or server-only at run — is an open question (§9); until decided, the panel refuses save on visibly unbalanced tags (count `{{` vs `}}` and `{%` vs `%}`) and the server is authoritative at run.
- **Missing variable without `default()`:** renders per the Jinja2 engine's unset policy (open question whether unset is empty-string or error — §9); the panel's `default()` hint (§5) is the documented authoring pattern either way.
- **Over-limit output (>400k chars):** step failure, no truncation, no partial `result`. Governed by `StepBehaviour` retry like any other step failure (though retry of a pure render rarely helps — the panel says so in one line).
- **Whole-node:** governed by `StepBehaviour` (retry/timeout/approval) like every other kind.

## 8. Migration/compat

- **No new kind, no rename:** stored `kind: "transform"` is unchanged. `mode` absent = `"expression"` — every existing transform reads as expression mode with its `expr` untouched. No migration of stored revisions; old revisions validate and run exactly as before.
- **`calculate` untouched:** the shared `TransformForm` union member keeps expression-only behavior; the mode control renders for `transform` steps only.
- **`blankStep("transform", …)`** starts `{ mode: "expression", expr: "{{ 1 }}", templateText: "" }` — an unconfigured template step (empty `templateText`) refuses save, same rule as an empty expression.
- **Canvas compat:** no geometry change (diet card, §4); the template pill is text-only. `stepIo` gains the template-`{{var}}` mining path; expression-mode output is byte-identical.
- **Caps:** the catalogue's `caps` counting (if any covers `transform`) counts modes together — template steps consume the same budget under the same kind.

## 9. Open questions

1. **Joint Jinja2 allowlist decision (SHARED with `docs/nodes/llm.md` §9.1 — decide once, apply to both):** template `{% if %}` / `{% for %}` / `loop.index` / filters (`upper`, `round`, `replace`, `join`, `default`) and the LLM doc's `jinja2` prompt-block flag need the same thing — control-tag and filter syntax the D-22 allowlist does not serve today. Reference `docs/nodes/llm.md` §9.1 as the joint tracker: the decision (smallest allowlist extension vs template-scoped grammar vs server-side-only validation with client preview) MUST land in one place and both docs adopt it verbatim. This doc proposes the sharing, not the answer.
2. **Who validates template syntax — client or server?** Options: (a) client preview (tag-balance + allowlist check on save, server authoritative at run); (b) server-only (panel saves anything, run surfaces the parse error). Recommendation: (a) — matches the existing belt-and-braces `validateAgainstAllowlist` arrangement.
3. **Unset-variable policy:** empty string or render error when a `{{var}}` has no binding and no `default()`? (Dify leans graceful-empty; our expression path leans fail-closed — needs a product call.)
4. **Control-tag builder:** does the template editor ever get structured `if`/`for` assistance, or does control syntax stay hand-typed text forever? (This doc: hand-typed; builder is a future proposal.)
5. **Loop-variable scoping in validation:** `{% for x in … %}` binds `x` template-locally — must the allowlist checker understand shadowing (so `{{ x }}` inside the loop is not flagged `unknown`)?

## 10. Non-goals

- No HTML form rendering or collection — Chatflow-surface forms are out of scope, stated with reason in §2. Person-facing field collection is the human-input doc's `approval.fields[]`, not this kind.
- No raw-schema output, no field-list editing on the template result — one text row (§6).
- No `flow-expr` allowlist change — Jinja2 control/filter syntax stays a joint open question (§9.1, shared with the LLM doc).
- No `calculate` mode, no new step kind, no palette-hue or dark-mode token work.
- No server/compiler design (how `templateText` compiles to a render task, which Jinja2 engine serves it) — model mapping stops at the stored shape.
- No palette/builder implementation — talk-phase artifact only, no code.
