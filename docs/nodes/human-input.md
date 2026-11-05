# Human Input (approval, upgraded)

**Status:** DRAFT — 2026-09-09

## 1. Purpose

Turn the `approval` step from a passive approve/reject gate into a Dify-style Human Input step: display + collect + route in one pause — show a person a form, collect their fields, and resume on the path their button chose.

## 2. Dify behavior

What we steal (from `local://survey-entry-exit.md` §6):

- One pause that does three jobs: a Markdown request form with `{{variable}}` display, collectable fields, and decision buttons that route.
- Fields: Paragraph (optional, pre-fillable), Select (manual options or an `array[string]` variable), Single File / File List. Mandatory fields gate the buttons (disabled until filled).
- Action buttons: each is title + action ID (+ style); one exit arm per button; click exposes `__action_id` + `__action_value` downstream, plus `__rendered_content` (the filled-in form snapshot, files as `[file]` / `[N files]` placeholders).
- Timeout: a duration (default 3 days) plus a dedicated timeout arm; unwired timeout + no response = the run ends.
- First response wins — the request closes after the first response.

What we skip:

- Dify's delivery transports as specified (web-app inline form, email link, Service API lifecycle) — we have no documented web-app surface or email-sending prod path to hang them on. Delivery is the top open question (§9), not a decided transport.
- Preset button styles beyond title + id + style data; style is stored, never behavior.

## 3. Model mapping

No new kind. The stored kind stays `approval`; the new shape is additive fields on it.

Today an `approval` step stores (`packages/client/src/lib/flow-authoring.ts`, `ApprovalForm` in `StepInspector.tsx`):

- `summaryExpr: string` — the question, as a JSON string when there is no evidence step, or a built template via `buildApprovalSummary(shapes, over, text)` when there is one (parsed back by `approvalQuestion()` / `approvalOverId()`).
- `contextExpr?: string` — `{{ <outputExpr of the evidence step> }}` — the single opaque evidence address the approver is shown, never a guessed field list.
- `awaitSeconds?: number` — the pause budget (blank = `86_400` in the form; stored only when set).

New stored fields on `approval`:

| Field | Type | Default | Validation |
| :--- | :--- | :--- | :--- |
| `delivery` | `"inbox" \| "email" \| "both"` | `"inbox"` | required; see §9 — stored as intent until a transport exists |
| `formMarkdown` | `string` | `""` | `{{…}}` refs inside it MUST validate against the served `flow-expr` allowlist — **no allowlist change in this doc** (explicitly: the allowlist is untouched; refs that fail it are `unknown`, never silently rewritten) |
| `fields[]` | `{ name: string; type: "paragraph" \| "select" \| "file" \| "file_list"; required: boolean; prefill?: string; options?: string[] \| { fromVariable: string } }` | `[]` | `name` unique per step, valid identifier (downstream reads it); `select` requires `options` non-empty; `prefill` allowlist-checked like `formMarkdown`; file fields accept no prefill |
| `buttons[]` | `{ id: string; title: string; style: "primary" \| "secondary" \| "danger" }` | `[]` (legacy gate — see §8) | `id` unique per step, valid identifier; ≥1 required for any NEW human-input step (the form validates: a pausing form with no button has no exit) |
| `awaitSeconds` | `number` (existing field, kept) | `259_200` (3 days, Dify parity) for new steps; stored values on old steps untouched | must be > 0 |

Field migration (exact):

- `summaryExpr` → the question text parsed by the existing `approvalQuestion()` becomes the first line (heading) of `formMarkdown`; the evidence step parsed by `approvalOverId()` becomes `contextExpr` unchanged, and its rendered output remains addressable as a `{{…}}` ref inside `formMarkdown`. Nothing is re-derived: the migration reads what is stored.
- `contextExpr` → carried over verbatim.
- `awaitSeconds` → carried over verbatim when stored; unstored (today's implicit 1-day form default) becomes an explicit `259_200` only when the step is next edited as a human-input step — old steps are never rewritten by migration alone (§8).
- New steps (`blankStep("approval", …)`) start with `summaryExpr: JSON.stringify("Approve this?")` as today, `delivery: "inbox"`, `awaitSeconds: 259_200`, `fields: []`, `buttons: []` — and the panel requires ≥1 button before the step is valid.

## 4. Card

Fixed geometry is reused, never grown (`lib/canvas-layout.ts`: `heightFor`/`widthFor`, invisible input dots via `inputHandleTop`). The card shows header (icon + name + status) → one config pill → one description line.

- Pill rule: `waits for a person · N choices` where N = `buttons.length` (e.g. `waits for a person · 2 choices`); `buttons.length === 0` (legacy gate) → `waits for a person`; when a timeout is set and no button arm names it, the pill appends timeout text: `waits for a person · 2 choices · 3d timeout`. If `buttons` is unreadable, fall back to `KIND_LABEL["approval"]` (`"waits for a person"` in `StepInspector.tsx`) — never a fabricated summary.
- Description-line rule (earned, per component-panel §4): the first text line of `formMarkdown`, else the parsed question (`approvalQuestion(summaryExpr)`), else nothing. Never a per-kind sentence.

## 5. Panel

Fixed section order is reused: Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove. Only the kind editor's interior is new, in this order:

1. **Delivery** — `delivery` radio (`inbox` / `email` / `both`) with the §9 caveat printed as a warn-tinted block below the row (a real hazard, per component-panel §3): only `inbox` has a surface today (`/approvals`); `email`/`both` store intent and the run surface must say the request was created but not delivered.
2. **Form** — `formMarkdown` textarea with variable-insert limited to allowlist-valid refs (same picker idiom as the question/evidence fields, built by `buildApprovalSummary`-style construction — by construction, never typed raw).
3. **Fields** — `fields[]` table in NAME · SOURCE · TYPE rows: name (mono, editable — it becomes the output key), source (prefill binding: upstream step/field, literal, or unset; `unknown` renders as "set in the expression", never "not set"), type chip + `req` marker. File rows carry no prefill control (component-panel §8: only offer a control that persists).
4. **Choices (buttons)** — `buttons[]` rows: title + id + style. Headed "Choices", NOT "Outputs" and NOT "Buttons-as-outputs" (component-panel §9: two heads must not say the same word; the Outputs section below owns that word).
5. **Timeout** — the existing "Give up after" select (`awaitSeconds`: 1 hour / 1 day / 3 days / 7 days) plus the timeout-arm wiring hint: which downstream arm (if any) runs on expiry; unwired is an explicit, valid state meaning "the run ends" (§7), not a warning.
6. **Outputs** (the fixed Outputs section, not part of the kind editor) — one row per collected field + `__action_id` + `__action_value` + `__rendered_content` (§6).

`StepBehaviour` keeps the kind's existing rule: no retry, with the per-kind reason (`NO_RETRY_REASON.approval` — a retry would re-open a question somebody already answered). The "Require approval before this step" button stays hidden for this kind (it cannot be gated).

## 6. Outputs

Named vars, all read downstream via the existing `outputs.<stepId>.<name>` expression shape (served by `outputExpr`, never hardcoded):

| Var | Meaning |
| :--- | :--- |
| `<field.name>` | one per `fields[]` entry — the value the person entered/selected/uploaded |
| `__action_id` | the clicked button's `id` |
| `__action_value` | the clicked button's `title` |
| `__rendered_content` | the filled-in form snapshot; file fields render as `[file]` / `[N files]` placeholders |

How downstream reads them: the standard source picker (NAME · SOURCE · TYPE rows in Inputs; `flow-expr` construction by step + field). The catalogue's `outputs.approval` entry must gain a template describing this shape — until the server serves it, `step-io.ts` reports the step's outputs via `outputSummary()` and the panel shows the rows above as **declared by the step's own `fields[]`/`buttons[]`** (step-owned data, not a guessed endpoint shape — consistent with component-panel §6). Server-owned shapes are never invented client-side: no `caution` text is written here; the catalogue's stays.

## 7. Failure behavior

- **Timeout:** on expiry the run takes the timeout arm when wired; when unwired and expired, the run ends (Dify parity). This is a terminal outcome, not an error — no retry, no dead-letter.
- **Reject (legacy gate, `buttons: []`):** rejecting kills the run; it never resumes with a "no" (existing palette/panel wording, unchanged).
- **Mandatory fields:** gate the buttons — a button cannot be clicked until every `required` field is filled. This is enforced by the request surface, not the engine.
- **No retry:** the compiler refuses `retry` on `approval` (existing rule, existing reason).
- **First response wins:** concurrent responses (inbox + email under `both`) — the first recorded response closes the request; later ones are ignored.
- **Undeliverable (`email`/`both` with no transport):** the request is created and visible in the builder/inbox surface but flagged undelivered — never silently dropped, never auto-approved.

## 8. Migration/compat

- **No new kind, no rename:** stored `kind: "approval"` is unchanged. Old revisions validate and run exactly as before.
- **Old passive gates keep working:** `buttons: []` + `fields: []` = legacy gate semantics (approve resumes downstream, reject kills the run, `awaitSeconds` is the pause budget). The panel renders the new sections with empty tables plus the existing question/evidence/timeout controls; it does not force buttons onto an old step until the author edits it as a human-input step.
- **`summaryExpr`/`awaitSeconds` mapping** is §3's table: both fields keep their names and meanings; `formMarkdown` defaults from the stored question on first edit; `awaitSeconds` keeps its stored value (the 1-day→3-day default change applies to new steps only).
- **Caps:** the catalogue's `caps.approvalSteps` continues to count `approval` steps — human-input steps consume the same budget under the same kind.
- **Canvas compat:** button arms are `branch` records (see below), so `branchArms`/`collapseArms`/`portTop` need no changes; old gates (no arms) render exactly as today.

Arms mapped onto our branch idiom (decision, stated): each entry of `buttons[]` materializes as a **`branch` step chained with `elseOf` off the approval head** — the same linked-list chain `addArm`/`removeArm`/`chainOf` already manage. The button-arm branch step carries `conditionExpr` built by the existing `buildCondition` over the approval step testing `__action_id == "<button-id>"` (allowlist-valid by construction, round-trippable by `parseCondition`). The timeout arm is the chain's terminal `else` (a `branch` record with no `conditionExpr`, per the branch idiom). Arm membership for downstream steps is plain `dependsOn` (D-123), and the compiler's existing refusal of `elseOf` + `dependsOn` together applies to arm records unchanged. Adding a button = `addArm` on the chain; removing one = `removeArm` with the same relinking. No new edge semantics, no wire text labels.

## 9. Open questions

1. **Delivery transport (biggest):** we have no web-app surface and no email-sending prod path documented. `delivery: "email" | "both"` currently stores intent with nowhere to send it. Options: (a) **in-builder inbox first** — serve human-input requests through the existing `/approvals` surface (S-37 inbox rebuild exists) and treat `inbox` as the only live transport; (b) **email via the existing mail tool** — send the request link with `mail_send`, reusing a catalogue tool instead of building a sender; (c) Service-API lifecycle later (external clients drive pause/resume, Dify parity). Recommendation: (a) now, (b) as the thin path to `email`, (c) out of scope. Until a transport lands, `email`/`both` MUST render an undelivered flag (§7), never a fake sent state.
2. **Who may respond:** Dify allows workspace members, external addresses, or whole workspace via email link with no account needed. Our approver identity story (the `/approvals` page assumes workspace users) does not cover external respondents — needs a product decision before `email` goes live.
3. **File-field storage:** collected Single File / File List values need a stored location and a size-cap policy (Dify caps 10/15/50/100 MB by type, list ≤ 10 files). Adopting Dify's caps verbatim vs our own limits is undecided.
4. **`__rendered_content` ownership:** snapshot built by the run surface or the engine? The placeholder rule (`[file]` / `[N files]`) is decided; who renders it is not.

## 10. Non-goals

- No new step kind; no rename of `approval`, `summaryExpr`, `contextExpr`, or `awaitSeconds`.
- No `flow-expr` allowlist change — `{{…}}` refs in `formMarkdown`/`prefill`/Select-variable options use the five roots and seven callables as served; anything else stays `unknown`.
- No canvas geometry change — fixed card, `inputHandleTop` dots, `portTop` arm handles, no wire text labels (per the 09-09 lock).
- No palette-hue or dark-mode token work.
- No email infrastructure, web-app request surface, or Service API in this doc — delivery intent is stored (§3) and flagged (§7); transport is §9.
- No retry-on-approval, no multi-responder quorum (first response wins only), no editing a response after submit.
