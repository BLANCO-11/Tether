# Tasks: an oversize step payload must name itself

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Contract**: [contracts/step-callback-limit.md](./contracts/step-callback-limit.md)

Ordered so each phase ends somewhere shippable. `pnpm typecheck && pnpm test` after every phase.
⚠ **Node 22 or the client render layer silently does not run** — this feature touches no client file, but
the root `pnpm test` still needs it.

⚠ **This feature adds NO migration.** Head is `0039_bright_thundra`; a `0040` appearing here means
somebody decided to persist a byte count without saying so. Nothing touches `db/schema.ts` or `drizzle/`.

⚠ **Before starting**: repoint `.specify/feature.json` at this directory (it still names
`specs/20260818-084135-email-send-tool`), or the agent hooks and the pre-commit gate refuse every source
write in P1 — Constitution Article I.

---

## P0 — the request id, on its own (2 files, no behaviour change beyond an added field)

Shippable alone, and worth it: every 4xx in the product becomes greppable.

### T01 ✅ DONE · `packages/server/src/middleware/error.middleware.ts`
Add `requestId: req.id` to the 4xx branch ([:82-89](../../packages/server/src/middleware/error.middleware.ts#L82)),
matching the `22P02` 400 branch and both 5xx branches. ⚠ Do **not** touch what that branch echoes —
`message` and `findings` both stay; `FlowValidationError`'s structured finding is load-bearing.

### T02 ✅ DONE · `packages/server/src/middleware/error.middleware.test.ts`
One case per existing 4xx shape asserting `requestId` is present, plus a control that the 5xx branches
still omit `message`. ⚠ The suite already pins *"do not narrow that branch back to 4xx"* (I-51) — leave
that assertion alone.

---

## P1 — the transport cap stops being the binding constraint

### T03 ✅ DONE · `packages/server/src/config/index.ts`
```ts
steps: {
  /**
   * A step callback's whole body. ⚠ Deliberately far ABOVE every per-parameter cap
   * in the product (32,000 chars for `llm_complete`'s `input`, 262,144 B for mail),
   * so a payload too large for the TOOL is refused by the tool with its own specific
   * message. This cap only stops a runaway body from being allocated. See
   * specs/20260819-045902-step-payload-bounds/contracts/step-callback-limit.md §1.
   */
  callbackMaxBytes: Number(process.env.STEP_CALLBACK_MAX_BYTES ?? 5_242_880),
},
tools: {
  /** Soft. A response over this adds a WARNING and the step still succeeds — D6. */
  responseWarnBytes: Number(process.env.TOOL_RESPONSE_WARN_BYTES ?? 1_048_576),
},
```
Plus a unit test asserting `callbackMaxBytes >= 8 * MAIL_MAX_BODY_BYTES` — the ladder invariant from the
contract, so lowering it below a per-parameter cap goes red rather than silently making that cap's
message unreachable. (5 MB is 20× the mail cap, so the invariant holds with room; it is stated as `>= 8×`
because that is the margin the contract requires, not the margin this default happens to have.)

### T04 ✅ DONE · New `packages/server/src/middleware/callback-body-limit.middleware.ts`
`callbackBodyLimit(limitBytes)` per plan Decision 2. Reads `Content-Length` only; `next()` when absent,
unparseable or within the limit. On refusal: one `console.error` line, then the contract's 413 body.
⚠ `flowExecutionId` comes from `req.stepAuth` **when present** and is omitted otherwise — never invented,
never read from the body.

### T05 ✅ DONE · New `packages/server/src/middleware/callback-body-limit.test.ts`
Under the limit → `next()` called, no response written. Over → 413, `error: "callback_payload_too_large"`,
both byte fields, `requestId`, and `flowExecutionId` present with `req.stepAuth` / absent without. No
`Content-Length` → `next()`. Non-numeric `Content-Length` → `next()`. One assertion that the handler
never touches `req.body`.

### T06 ✅ DONE · `packages/server/src/app.ts` — the mount order
Per plan Decision 4: `requestId` first; then `/api/steps` (`requireStepToken` → `callbackBodyLimit` →
`express.json({ limit })` → `stepsRouter`) and `/api/executions` (guard → parser → router); then the
process-wide `express.json({ limit: "2mb" })`; then CORS, `resolveIdentity` and everything else unchanged.

⚠ Rewrite the comment at [:37-38](../../packages/server/src/app.ts#L37) rather than moving it verbatim —
it currently claims `requestId` is mounted first, which was the untrue half. Add, beside the callback
mounts, why they sit above the parser and above `resolveIdentity` (neither router reads identity; grep is
empty, and `app.ts` already says a blanket requirement would break them).

### T07 ✅ DONE · New `packages/server/src/routes/steps-body-limit.test.ts`
End to end through `createApp()`, so the **mount order itself** is what is under test:
1. 9 MiB body + valid execution token → 413, contract shape, `flowExecutionId` present.
2. 9 MiB body + **no** token → **401**, not 413 (precedence: an unauthenticated caller learns nothing
   about our limits).
3. **3 MiB** body + valid token → reaches the route (over the old 2 MB, under the new cap) — this is the
   assertion that proves the transport cap is no longer binding.
4. A normal small callback → unchanged behaviour.
5. A `/api/executions/begin` oversize body → 413 with **no** `flowExecutionId` and the *"a step
   callback"* wording.
6. A 3 MiB body to a non-callback route → still 413 from the process-wide parser, now with `requestId`.

### T08 ✅ DONE · `.env.example`
`STEP_CALLBACK_MAX_BYTES=5242880` and `TOOL_RESPONSE_WARN_BYTES=1048576`, each commented with what it
bounds and what it deliberately does not. ⚠ Also add `OPS_LLM_MAX_INPUT_CHARS=32000` — this plan cites it
as the authoritative cap and it is currently undocumented, which is Article VII.

**Phase gate**: POST a **4 MB** `input` to `/api/steps/tool` with a valid execution token and confirm the
failure is now ops-api's **422** naming 32,000 characters — the specific error winning over the transport
one, which is the whole of Decision 1.

⚠ **Do NOT gate on replaying execution `05aca859-…` itself.** Its body was 8,401,233 B and the 5 MB cap
still refuses it, deliberately (plan Decision 1). What that replay must show is the *new* 413 — naming
size, limit, execution and remedy, with a request id — not a 422. Raising the cap until the replay reaches
ops-api inverts the design; the run is made to succeed by P2's `transform`/`code` step, not by a bigger
cap.

---

## P2 — the oversize is refused before it is sent, and measured when it arrives

### T09 ✅ DONE · `packages/server/src/services/flow-output-shape.ts` — `checkBulkToolInput`
Per plan Decision 5, beside `checkTextToolInput` and sharing its `templateSpans` / `JQ_PROGRAM_RE`
machinery. Three conditions, all required: envelope boundary with no plucked leaf; `tostring`/`tojson`
present; **no** reducing operation. Finding text verbatim from the contract §4.

Name the reducing set as a module-level constant with a docblock — it is a list somebody will extend, and
an addition to it *weakens* the check, so it needs to be visible rather than inline in a regex.

### T10 ✅ DONE · `packages/server/src/services/flow-output-shape.ts` — reconcile `checkTextToolInput`'s remedy
Its message currently recommends `` | jq('tostring | @json') | first ``
([:715-719](../../packages/server/src/services/flow-output-shape.ts#L715)) — exactly what T09 refuses.
Change it to the projected form. ⚠ **Same commit as T09**, or the two rules contradict each other and a
model in that loop burns a redraft per turn.

### T11 ✅ DONE · `packages/server/src/services/flow-output-shape.test.ts`
The four-row corridor table from contract §4, asserted from **both** checks. Row 3 (projected *and*
serialised → silent from both) is the contract; label it as such in the test name so a future narrowing
reads as breaking the corridor rather than as an odd expectation. Plus: the slice form `.[0:50]` counts as
a reduction; `first(` counts; the bare Pebble `| first` at the end of the span does **not** (it is the
engine's unwrap, present in every correct expression).

### T12 ✅ DONE · `packages/server/src/services/flow-model-findings.ts`
One **named** entry `{ name: "checkBulkToolInput", run: checkBulkToolInput }` in `SHAPE_CHECKS`
([:95](../../packages/server/src/services/flow-model-findings.ts#L95)), with a comment saying why it is in
SHAPE_CHECKS and not EXPRESSION_CHECKS (**refine must run it** — I-119). ⚠ `flow-model-findings.test.ts`
requires a fixture per name; a check with no fixture must fail rather than pass unnoticed (I-38).

### T13 ✅ DONE · `packages/server/src/services/flow-model-findings.test.ts`
⚠ Assert the finding's remedy names **both** a `transform` and a `code` step and states which is for
which (Decision 9), and that it never suggests chunking the payload through repeated `llm_complete`
calls. Same idiom as `policy-copy.test.ts`: the copy is asserted because the copy is the control.

Its fixture, plus the existing assertion that `PURE_MODEL_CHECKS` is exactly
`EXPRESSION_CHECKS ++ SHAPE_CHECKS` — which should already pass, and which is what stops `draftFlow`'s
staged feedback silently not covering the new check.

### T14 ✅ DONE · `packages/server/src/services/flow-generation.service.ts` — the prompt
[:250-251](../../packages/server/src/services/flow-generation.service.ts#L250) makes the **unbounded**
form the canonical example and the projected form a parenthetical. Swap them: the example is the
projection, and the whole-payload form is named as the mistake with its consequence (the 32,000 ceiling,
and a run that fails on a big month and passes on a small one).

⚠ **Teach BOTH remedies with the rule for picking one** (plan Decision 9), because a model that only
knows `transform` and needs an aggregate reaches for a bigger `input` instead:
* fewer rows or columns of the same shape → a **`transform`** step;
* counts, totals, rankings, per-group figures → a **`code`** step, whose Python computes the numbers and
  whose small output goes to `input`. `finance-budget-variance` is the worked example already in the
  repo: the fragment computes the figures, `llm_complete` writes the narrative as a leaf (D-34).
⚠ Do **not** offer chunk-and-summarise-the-summaries as an option anywhere in the prompt — it makes
`llm_complete` output load-bearing, which D-34 forbids, and costs ~236 calls for the measured payload.

⚠ Keep the I-119 paragraph above it intact — both failures are now taught in one place, which is the
point. And keep the **goal-mode prompt a literal prefix of the outline one**; there is a test on that, and
this edit is above the divergence.

### T15 ✅ DONE · `packages/server/src/services/flow-generation.test.ts`
Assert the prompt's canonical `input` example contains a projection and that the unbounded form appears
only as a named mistake. ⚠ The suite already runs the **worked example through the drafter's own
validators** — that test is now the control for this edit: an example the new check would reject teaches a
mistake and charges a redraft for it in every workspace, for ever.

### T16 ✅ DONE · `packages/server/src/services/step-execution.service.ts` — measure and warn
1. `StepItemResult` gains `bytes?: number` — the UTF-8 length of the response body, on every tool item.
2. After the batch, one warning per condition per **step** (never per item) per contract §3:
   an item over `config.tools.responseWarnBytes`, and a tool with empty `params_schema` called with
   parameter keys.
3. The "largest array" figure is mechanical and the clause is **omitted** when there is no array.

⚠ **Gate**: `step-execution.test.ts`'s existing cases, `mail-end-to-end.test.ts`, `egress-parity.test.ts`
and `tool-auth-schema.test.ts` must pass with **no edits to their assertions** beyond adding the new ones.
A step's success/failure rule, the per-item partial-failure warning, the all-failed 502 and `EMPTY_BATCH`
are all untouched. Editing one of those means this task changed semantics — fix the code, not the test.

### T17 ✅ DONE · `packages/server/src/services/step-execution.test.ts`
Warning fires over the cap and not under; `bytes` present on every tool item; the largest-array clause
present for `{count, data:[…]}`, present for a bare array, **absent** for a scalar payload; one warning
for a 200-item batch, not 200; the undeclared-params warning names keys and **never a value**; a tool
**with** a `params_schema` produces no such warning.

**Phase gate**: a drafted flow with the unbounded `input` form is refused at generation **and** at
refine, and a rerun of `attendance_report_email_2` warns at `fetch`.

---

## P3 — the runbook (data, not code)

⚠ **The shape of the fix, so it is not re-derived.** `attendance_report_email_2` gains a `code` step
between `fetch` and `report`, and `BTO_tool` gains a `params_schema` declaring the period filter (blocked
on the one open clarification about what the endpoint accepts).

```
fetch (tool)  →  reduce (code)  →  report (llm_complete)  →  send
```

The fragment reads `input.json` (staged by **Kestra**, so it receives the whole 7.19 MB with no cap change
anywhere — plan Decision 9), filters to the requested period, aggregates per department, and returns a
small dict whose keys are its declared `contract.output`. `finance-budget-variance` is the worked example
already in the repo: fragment computes the figures, `llm_complete` narrates them as a leaf (D-34).

⚠ **Do NOT fix this by raising `OPS_LLM_MAX_INPUT_CHARS`.** 7,539,026 characters is ≈1.9M tokens, past
every model this gateway serves; the cap is standing in front of a wall no configuration moves (FR-014).

Not source changes; no spec-gate coverage needed. **Blocked on the open clarification** in spec.md.

⚠ **MEASURED 2026-08-20 — THE ENDPOINT NOW ANSWERS 404.** A live call through the rebuilt server,
`{"ref":"BTO_tool","params":[{"period":"2026-06"}]}`, returned
`HTTP 404 {"detail":"Not Found"}` from `GET https://api.ims.bto.apps.askml.ai/ims`. So R01 is blocked
on more than the parameter list: **there is currently no endpoint to register parameters for.** Two
consequences, neither of which changes any code:

* The 7.19 MB payload cannot be replayed here, which is why §3a's over-threshold warning is proven
  in-process only (10 cases) and not at the wire. ⚠ Do **not** manufacture that evidence by lowering
  `TOOL_RESPONSE_WARN_BYTES`.
* Whoever unblocks this needs the endpoint's owner, not just its docs. Ask for the current URL and the
  accepted filter parameters in the same question.

### R01 · Register `BTO_tool`'s real parameters
`tools.params_schema` is `NULL`, which is why the drafter invented `period` and the endpoint discarded it.
Get the accepted filter parameters for `GET https://api.ims.bto.apps.askml.ai/ims` and register them
through the tools page — flat `{name: {type, required, description}}`, **not** a JSON-Schema envelope
(I-39: the envelope renders two nonsense params called `type` and `properties`, and a save that strips
descriptions changes the fingerprint and disarms every flow using the tool).

### R02 · Add a `transform` between `fetch` and `report`
In `attendance_report_email_2` (workspace `hr`, flow `abeaa493-5116-47fb-ad8c-6b8a5366d458`): filter to
the requested period and project only the columns the report names, then bind `report`'s `input` to the
transform's output. A `transform` is evaluated by Kestra with **no network and no I/O**
([flow-compiler.service.ts:595-596](../../packages/server/src/services/flow-compiler.service.ts#L595)), so
the payload never crosses to `server:4000` at all.

⚠ The flow is named *"Untitled flow"* and is at revision 1 in the **draft** namespace. Re-running it needs
a draft run, not an approval.

### R03 · Confirm end to end
Run for `2026-06`: `fetch` narrow, `report` under 32,000 characters, `send` reached, `complete` recorded.

---

## Out of scope, recorded so it is not read as an omission

- **Wiring `triage()`** and giving it an `httpStatus === 413` branch. No production call site exists;
  a correct branch in dead code is I-120's shape. Spec D6 records why this run's `failure_class` is `NULL`.
- **The chunked-body path.** Bounded by the parser, refused with the coarse message, pinned by a test so
  nobody later reads it as the guarded path. Contract §2.
- **Emitting `X-Foundry-Step` from the compiler** so the 413 could name the step. It changes every
  compiled flow's YAML. Plan Decision 3.
- **A response-size field on the tool probe** (`specs/20260818-123807-tool-probe`). One field in that
  feature, not this one. Plan Decision 8.
- **Widening `checkBulkToolInput` beyond `llm_complete`'s `input`.** Only that parameter has a published
  ceiling; elsewhere the check would fire on correct flows and get widened. Plan Decision 5.
