# Error handling (cross-cutting: upgrades StepBehaviour for all kinds)

**Status:** DRAFT — 2026-09-09

## 1. Purpose

Give every fallible step a single, readable answer to "what happens when this step fails": stop (today's behavior), substitute a typed default and continue, or take a separate error path. This doc upgrades the `Behavior` panel section (`StepBehaviour`: retry + timeout + approval gate) with a `failureMode` control — it does not invent a new panel section, reorder the panel, or change the data model beyond additive fields.

## 2. Dify behavior

What we steal (from `agent://CanvasBehaviors`, error-handling section):

- **Scope:** only four node types support it — LLM, HTTP Request, Code, Tool. Everything else fails the run when it fails.
- **Three modes, default None:** `None` (stop the run, surface the error) / `Default Value` (a type-matched substitute output, run continues) / `Fail Branch` (a separate error flow off the node — notify someone, retry differently, log, call a backup service — rendered as a distinct orange branch).
- **Error vars:** `error_type` + `error_message` are usable under either non-None mode, including inside template conditionals downstream.
- **Container rules:** a Loop child failure always stops the whole loop (no per-cycle catching); Iteration has its own per-item modes — terminate / continue-with-`null` / remove-failed.

What we skip:

- Dify's alternative-model fallback for LLM (our llm doc already parks fallbacks as an open question — this doc does not decide it; a backup model is expressed as an ordinary Fail-Branch arm containing a second `llm` step).
- Dify's per-node retry counts/intervals as part of error handling — retries already exist here (`StepRetry` via `StepBehaviour`) and stay exactly as they are; `failureMode` runs only after retries exhaust.
- Image-asset/demo-video behavior; nothing visual beyond the orange fail-branch arm.

## 3. Model mapping

Additive fields only — on the retryable step records in `packages/flow-edit/src/index.ts` (the same records that already carry `retry?: StepRetry` + `timeoutSeconds?: number`), plus a compiler-mirrored kind gate:

```ts
type FailureMode = "none" | "default" | "fail-branch";

type FailureHandling = {
  failureMode: FailureMode;   // default "none"
  defaultValue?: unknown;     // only meaningful when failureMode === "default"; typed per kind (§6)
};
```

Notes on each field:

- `failureMode` default `"none"` — today's behavior (stop, surface the error) is what every existing flow already has; unset reads as `"none"` (§8).
- `defaultValue` is stored only under `"default"`; switching modes away keeps the last value (panel memory, like `parallelCap` in sequential mode) but the runner ignores it.
- **No new kind, no new edge type.** A fail-branch arm is an ordinary `branch` step record (see predicate form below); arm membership is plain `dependsOn` (D-123), same as the human-input doc's button arms.
- **Kind gate (compiler mirror, same pattern as `RETRYABLE_KINDS`):** `FAILURE_MODE_KINDS` — proposed `["tool", "datasource", "query", "code"]` first, `llm` second (§8). The panel offers the control only on gated kinds; other kinds keep the Behavior section exactly as today.

Expression forms and allowlist — **explicit call-out, not smuggled**: **no new `flow-expr` allowlist roots.** `error_type` / `error_message` are step-scoped pseudo-output fields on the failing step, read through the existing `outputs.<stepId>.<field>` root (`outputExpr` over the failing step with field `error_type` / `error_message`). What *is* needed is a server-owned `OutputShapes` template entry declaring those two fields on gated kinds (server-owned output shapes are never invented client-side — the catalogue serves them; until served, `step-io.ts` reports them as declared-by-the-step, the same rule the human-input doc uses for `__action_id`). `validateAgainstAllowlist` needs no change: `outputs` is already a root. The fail-branch predicate itself is built by the existing `buildCondition` and round-trips through `parseCondition` — by construction, like every other arm predicate.

## 4. Card

Diet card only — header (icon + name + status) → one config pill → one description line. Fixed geometry reused, never grown (`lib/canvas-layout.ts`: `heightFor`/`widthFor`, invisible input dots via `inputHandleTop`).

- Pill rule: unchanged per-kind pills (model, ref, contract summary). When `failureMode !== "none"` the pill appends one suffix word: `· on-error default` or `· on-error branch`. If the mode is unreadable, fall back to `KIND_LABEL` — never a fabricated summary.
- Description-line rule: earned only — the step's own text. Never a per-kind sentence.
- The fail-branch arm itself renders as an ORANGE arm handle/edge — rendering owned by `docs/canvas/connections.md` (reference, not duplicated here).

## 5. Panel

Fixed section order reused (`StepInspector.tsx`: Step → Description → Inputs → Kind editor → Outputs → Behavior → Connections → Try → Raw → Remove). Only the **Behavior** section's interior grows, in this order:

1. **Retry** — existing `StepBehaviour` retry control (count + interval + backoff), unchanged. Runs first; `failureMode` engages only after retries exhaust.
2. **On error** — `failureMode` radio: `Stop the run` (`none`) / `Use a default value and continue` (`default`) / `Take the error branch` (`fail-branch`), with the one-line consequence note from §7 under the selected option.
3. **Default value** — visible only under `default`: one typed input whose shape follows the kind's output (§6). Type-mismatch refuses save (same refuse-before-save rule as `RETRY_BOUNDS`).
4. **Error branch wiring hint** — visible only under `fail-branch`: which downstream arm runs on error; unwired is refused save (an error branch with no arm is a dead promise — unlike approval-timeout's valid unwired state, because timeout ends the run while an error must go somewhere).
5. **Timeout + approval gate** — existing controls, unchanged, below.

`StepBehaviour` keeps every existing per-kind refusal (`NO_RETRY_REASON`: agent/assistant conversation, approval human pause, transform/calculate pure, branch no-op, trigger entry). Failure-mode availability follows the §3 kind gate with its own one-line reasons (§8); a kind refused for retry is refused for failure modes for the same stated reason.

## 6. Outputs

Named vars: the kind's normal outputs (§6 of each kind doc) **plus** two step-scoped pseudo-fields present only when the step failed under a non-`none` mode:

| Var | Shape | When |
| :--- | :--- | :--- |
| `error_type` | string — the failure class (provider outage, schema non-conformance, HTTP status class, tool throw, timeout) | failed step with `failureMode: "default" \| "fail-branch"`; empty/absent otherwise |
| `error_message` | string — the human-readable detail | same as above |

How downstream reads them:

- Under `default`: the step emits its normal output shape with `defaultValue` substituted (§7 typing table); `error_type`/`error_message` are additionally bindable via `outputs.<id>.error_type` so a downstream `condition` or `transform` can log or branch on *what* failed even while the run continues.
- Under `fail-branch`: the normal outputs are absent on the error path; the arm's steps bind `error_type`/`error_message` off the failing step id through the standard source picker (NAME · SOURCE · TYPE rows). Template conditionals (`condition` arms testing `error_type == "…"`) work because the predicate builder already addresses `outputs.<id>.<field>`.
- The Outputs section shows the normal rows plus the two error rows (marked "on error only") — never a guessed field list; the catalogue `caution` stays below the rows.

`defaultValue` typing per kind (proposed; exact bounds are §9):

- `code`: must match the contract output shape (same validator the contract editor uses — a default for a `{ total: number }` contract is an object with a numeric `total`).
- `tool` / `datasource` / `query`: a single `response`-shaped value (these kinds expose one `response` row, never a column list — the data-kinds rule); the panel offers a free-form JSON/text box validated as well-formed, not as a guessed schema.
- `llm` (second rollout): a `text`-shaped string default (substitutes `text`; `reasoning_content` stays empty; schema-shaped `<field>` entries are NOT defaulted — a schema step that fails falls back to plain text, and the panel says so).

## 7. Failure behavior

Order of operations for a gated step, stated once:

1. **Attempt** (with `retry` policy if set — whole-step failure only, the existing `RETRY_CAVEAT` applies unchanged).
2. **Retries exhaust** → `failureMode` engages:
   - `none`: the run stops; the error surfaces (today's behavior, unchanged).
   - `default`: the step emits `defaultValue` in place of its normal output; `error_type`/`error_message` are set and bindable; the run continues to normal downstream steps.
   - `fail-branch`: normal outputs are absent; `error_type`/`error_message` are set; the run takes the error arm (notify / retry-differently / log / backup-service) and skips the normal downstream path.
3. **Predicate form for fail-branch arms (stated):** the error arm is a `branch` step record anchored on the failing step via `dependsOn: [<failingStepId>]`, carrying `conditionExpr` built by the existing `buildCondition(shapes, failingStep, "field_present", "error_type")` — i.e. "the error path runs iff the failing step produced an `error_type`". Further arms (e.g. `error_type == "timeout"` vs otherwise) chain off it with `elseOf` in the standard linked-list idiom (`chainOf`/`addArm`/`removeArm` unchanged; the human-input doc's button-arm mapping is the template). The compiler's existing refusal of `elseOf` + `dependsOn` together applies to these arm records unchanged.
4. **Containers:** Loop children keep loop's rule — a child failure stops the whole loop; loop children can NOT carry their own `failureMode` (the loop doc's §7 stands, referenced not duplicated). Iteration keeps its three per-item modes (`terminate` / `continue-null` / `remove-failed`); a `terminate` item error escalates to a whole-node failure and runs this doc's Behavior path on the parent.

## 8. Migration/compat

- **Existing retry configs keep working:** `retry` / `timeoutSeconds` fields are untouched; `failureMode` unset reads as `"none"`, which is exactly today's stop-and-surface behavior. No migration of stored revisions; no backfill pass.
- **Rollout list (proposed):**
  - **First — `tool`, `code`, `datasource`, `query` (Dify parity for HTTP/Code/Tool):** all four are already in `RETRYABLE_KINDS`, so no compiler retry change is needed; `tool` covers the HTTP-request and tool-call surface, `datasource`/`query` cover retrieval-backed reads, `code` covers transforms-that-can-throw. Only the `failureMode` gate + `OutputShapes` error-field entries are new.
  - **Second — `llm` (Dify parity for LLM):** needs the compiler to accept `retry` on `llm` first (today refused: `RETRYABLE_KINDS` excludes it and the llm doc parks fallbacks as an open question). Land retry-on-llm, then `failureMode` follows the same shape as `code`'s text default.
  - **Excluded with reasons:** `branch`/`condition` (only decides — `NO_RETRY_REASON.branch`, nothing to catch); `merge` (a join point, not an execution); `approval` (a human pause — retry would re-open an answered question, and its timeout arm already covers expiry); `transform`/`calculate` (pure — same answer on re-run, `NO_RETRY_REASON.transform` extends to failure modes: a deterministic step that throws on an input throws on the default path too, so the fix is upstream data, not a fallback); `trigger` (entry point, never fails partway); `iteration`/`loop` containers (own error modes — §7 — a container-level `failureMode` would double-handle what the per-item/child rules already decide).
- **Canvas compat:** fail-branch arms are `branch` records, so `branchArms`/`collapseArms`/`portTop` need no changes; ungated old flows render exactly as today. Orange arm styling is `docs/canvas/connections.md`'s surface.

## 9. Open questions

1. **Combining `default` + `fail-branch` simultaneously (Dify doesn't):** should a step be allowed to substitute a default AND run an error arm (e.g. log the error while continuing)? Proposed: no — one mode, refused save otherwise — but a log-while-continuing idiom (downstream step binding `error_type` under `default`) may already cover the use case. Needs a product call.
2. **Default-value typing per kind:** is the §6 table (contract-shape for `code`, free-form `response` for tool/data kinds, `text`-only for `llm`) the right strictness, or should `tool`/`datasource`/`query` defaults validate against the catalogue's served output template when one exists? Needs compiler-owner input.
3. **`error_type` vocabulary:** free-form string or a closed enum (timeout / provider / schema / http-4xx / http-5xx / thrown)? Closed helps `condition` pickers; free-form survives new failure classes. Proposed: closed set served by the catalogue with an open `other` bucket.
4. **`modelVar`-mode llm failures:** when the model picker names a deleted variable, is that a configuration error (refuse save, never reach `failureMode`) or a runtime error (fail-branch eligible)? Proposed: configuration error — refused before a run.
5. **Fail-branch + approval gate interaction:** "Require approval before this step" gates the attempt; does approval also gate the error arm, or does the arm run ungated once the attempt was approved? Proposed: the gate covers the attempt only; the error arm runs as the attempt's continuation.

## 10. Non-goals

- No new step kind; no rename of `retry`, `timeoutSeconds`, or any `StepKind`.
- No `flow-expr` allowlist change — `error_type`/`error_message` ride the existing `outputs` root; anything else stays `unknown` (called out in §3, not smuggled).
- No canvas geometry change — fixed card, `inputHandleTop` dots, `portTop` arm handles, no wire text labels (per the 09-09 lock); orange fail-branch rendering belongs to `docs/canvas/connections.md`.
- No change to `StepRetry` bounds/semantics, `RETRY_CAVEAT`, or per-kind `NO_RETRY_REASON` wording.
- No alternative-model fallback design for `llm` (backup model = ordinary fail-branch arm with a second `llm` step).
- No palette/builder implementation — talk-phase artifact only, no code.
