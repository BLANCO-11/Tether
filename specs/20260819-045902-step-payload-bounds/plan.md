# Implementation Plan: an oversize step payload must name itself

**Branch**: `20260819-045902-step-payload-bounds` | **Date**: 2026-08-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260819-045902-step-payload-bounds/spec.md`

## Summary

Execution `05aca859-…` failed because a tool returned 7.19 MiB and the next step posted all of it back
to `/api/steps/tool`, where a process-wide 2 MB body cap answered *"request entity too large"* — four
words, no request id, no size, no remedy, and two hops upstream of the endpoint that would have said
*"input is 7,539,026 characters; the limit is 32,000. Summarise or filter upstream."*

This feature makes the transport boundary **stop being the binding constraint**, makes its refusal
**diagnosable** when it does fire, refuses the unbounded expression **at authoring time** in both
generation and refine, and **says out loud** when a tool returns a payload of that size. Three phases,
each shippable alone.

**Shape of the change**: **19 files** — 4 new, 15 edited — across 1 new middleware, 1 new pure model
check, 2 new config values, 2 new step-time warnings and one mount-order correction in `app.ts`.
**No migration, no new npm dependency, no change to compiled flow YAML.**

## Technical Context

**Language/Version**: TypeScript 5, Node ≥ 22, ESM (`"type": "module"`)

**Primary Dependencies**: express, zod, `@foundry/shared` (`guardedFetch`, `PERMISSIVE`). **No new
dependency** — the size guard is one header read.

**Storage**: **none — no table, no column, no migration.** ⚠ Do not add one: the current head is
`0039_bright_thundra` (`0038` was the expectation-status CHECK), and a `0040` appearing in this feature
means somebody decided to persist a byte count without saying so.

**Testing**: `vitest`. New server suites: `middleware/callback-body-limit.test.ts`,
`routes/steps-body-limit.test.ts`. Edited: `middleware/error.middleware.test.ts`,
`services/flow-output-shape.test.ts`, `services/flow-model-findings.test.ts`,
`services/flow-generation.test.ts`, `services/step-execution.test.ts`. ⚠ **Node 22 or the client
render layer silently does not run** — irrelevant here (this feature touches no client file) but the
root `pnpm test` still needs it.

**Target Platform**: Linux server (Foundry API container, :4000).

**Project Type**: Web application (pnpm monorepo). **Server only** — `packages/client` is untouched,
so `ui-honesty-check.sh` gains no assertion and needs no run.

**Performance Goals**: the size check is one `Content-Length` parse per callback — no measurable cost.
An oversize body is refused **before allocation**, so the guard is cheaper than the failure it replaces.

**Constraints**: no migration; no compiled-YAML change (so no flow republish and no manifest
fingerprint movement); no silent truncation anywhere; a tool step's existing behaviour unchanged apart
from added `warnings` and `bytes`.

**Scale/Scope**: two config values, one middleware, one model check, two warnings, one prompt paragraph.

## Constitution Check

| Gate | Status |
|---|---|
| **I — Spec-first** | **PASS.** This directory is the feature. ⚠ `.specify/feature.json` still points at `specs/20260818-084135-email-send-tool`; it must be repointed here before `/speckit-implement`, or the agent hooks and the pre-commit gate will refuse the source writes. Deliberately **not** repointed by this plan — flipping the active feature out from under in-flight work is the author's call. |
| **II — Test-first** | **PASS.** Every phase lists its suites, and the two new controls (the 413 shape, the corridor fixture) are written before the code they check. |
| **IV — Simplicity** | **PASS, and it is the reason two obvious things are NOT here.** No `triage()` branch (no production caller — Decision 7). No new abstraction over `express.json`. No fourth concurrency ceiling. |
| **V — Observability** | **PASS, and it is the point of P1.** The refusal names what failed, with what inputs, and what to do; it logs one line against `req.id`; and no branch swallows anything. |
| **VII — Documentation currency** | **PASS.** `.env.example` gains both new variables **and** `OPS_LLM_MAX_INPUT_CHARS`, which this plan cites as the authoritative cap and which is currently undocumented. `CLAUDE.md` gains one paragraph. |
| **No fingerprint moves** | **PASS, trivially.** Nothing here touches `paramsSchema`, manifest XML, `refFingerprints()` or the compiler's emitted YAML. |
| **No silent cap** (`POLL_TRIGGERS_PER_TICK`'s rule) | **PASS.** Both new bounds log or report when they fire; neither truncates. |
| **UI honesty** | **N/A** — no client file changes. |

## Project Structure

### Documentation (this feature)

```text
specs/20260819-045902-step-payload-bounds/
├── spec.md
├── plan.md              # this file
├── tasks.md
└── contracts/
    └── step-callback-limit.md    # the 413 contract, the limit ladder, the warning strings
```

### Source Code

```text
packages/server/src/
├── middleware/
│   ├── callback-body-limit.middleware.ts     # NEW — Content-Length guard, before any parse
│   ├── callback-body-limit.test.ts           # NEW
│   ├── error.middleware.ts                   # EDIT — requestId on the 4xx branch
│   └── error.middleware.test.ts              # EDIT
├── routes/
│   └── steps-body-limit.test.ts              # NEW — the 413 end to end, through the real mount order
├── config/
│   └── index.ts                              # EDIT — steps.callbackMaxBytes, tools.responseWarnBytes
├── services/
│   ├── flow-output-shape.ts                  # EDIT — checkBulkToolInput + reconcile checkTextToolInput's remedy
│   ├── flow-output-shape.test.ts             # EDIT — the new check AND the corridor fixture
│   ├── flow-model-findings.ts                # EDIT — one named entry in SHAPE_CHECKS
│   ├── flow-model-findings.test.ts           # EDIT — its fixture (the module requires one per name)
│   ├── flow-generation.service.ts            # EDIT — the prompt's canonical `input` example
│   ├── flow-generation.test.ts               # EDIT — assert the example is the projected form
│   ├── step-execution.service.ts             # EDIT — bytes on each item, two warnings
│   └── step-execution.test.ts                # EDIT
├── app.ts                                    # EDIT — mount order: requestId, then the callbacks, then express.json
└── (db/schema.ts and drizzle/ are UNTOUCHED)

.env.example                                  # EDIT — two new vars + OPS_LLM_MAX_INPUT_CHARS
CLAUDE.md                                     # EDIT — one paragraph under the Kestra operational facts
```

**Structure Decision**: nothing new at the package level. The guard is a middleware because the thing it
must beat is another middleware; everything else lands in modules that already own the concern
(`config`, `flow-output-shape`, `step-execution`).

---

## Decisions

### Decision 1 — The transport cap must never be the binding constraint

Two limits, and the ordering between them is the whole design:

| Limit | Value | Who says it | What a caller learns |
|---|---|---|---|
| `llm_complete`'s `input` | **32,000 chars** | ops-api, [ops.ts:1358](../../packages/ops-api/src/routes/ops.ts#L1358) | *"input is N characters; the limit is 32,000. Summarise or filter upstream — this step is a text transformer, not a bulk reader."* |
| `foundry_email_send`'s `body` | **262,144 B** | [config/index.ts:576](../../packages/server/src/config/index.ts#L576) | the mail cap, with the UTF-8-bytes-not-characters rule |
| **a step callback's whole body** | **5,242,880 B** (new) | this feature | *"a step parameter is carrying a whole upstream response — reduce it with a `transform` (or `code`) step"* |
| the rest of the app | 2 MB (unchanged) | [app.ts:35](../../packages/server/src/app.ts#L35) | — |

`STEP_CALLBACK_MAX_BYTES` defaults to **5 MB** (5,242,880 B), chosen to sit **above every per-parameter
cap in the product by more than an order of magnitude** (20× the mail cap; ~164× the LLM cap measured in
bytes). That is the requirement, not the number: whenever a payload is too big *for the tool it is
addressed to*, the tool's own specific refusal must be the one that fires. The transport cap exists only
to stop a runaway body from being allocated at all.

⚠ **5 MB, not 8 MiB, and the reported run therefore STAYS REFUSED — deliberately.** The measured body
was **8,401,233 B**, so this cap does not let execution `05aca859-…` through, and it is not supposed to:
that body was addressed to a parameter with a 32,000-character ceiling, so there is no cap at this layer
under which sending it is correct. What P1 buys for that run is a refusal that **names the size, the
limit, the execution and a remedy**, instead of four words. What makes the run *succeed* is P2 — the
`transform`/`code` step that should have been between `fetch` and `report` (Decision 9).

⚠ Consequently **the P1 phase gate in `tasks.md` is a constructed 4 MB body, not a replay of the real
one.** A replay at 8.4 MB correctly still 413s, and asserting ops-api's 422 requires a body that reaches
ops-api. Do not "fix" the gate by raising the cap until the replay passes — that inverts the design.

⚠ **Do not "simplify" this to one global limit.** A single number cannot be both above every parameter
cap (so the specific errors win) and tight enough to protect the rest of the API surface, where 2 MB is
generous. The two-limit shape is the point.

**Memory is bounded and is stated rather than assumed**: the guard reads `Content-Length` and refuses
**before** the body is buffered, so only bodies ≤ 5 MB are ever allocated. Peak additional footprint is
`5 MB × BUDGET_DEFAULT_MAX_CONCURRENT` ([config/index.ts:251](../../packages/server/src/config/index.ts#L251),
default 5) = **~25 MB** per workspace in the worst case — and only for a flow deliberately moving megabytes between
steps, which is a flow that should be using a `transform`.

**Rejected — raise the global 2 MB.** It fixes this run and widens every other route in the process by
4×, including the two public receivers, for a reason that applies to neither.

### Decision 2 — The guard runs on `Content-Length`, before any parse, and answers with its own name

New `middleware/callback-body-limit.middleware.ts`:

```ts
/**
 * Refuse an oversize step callback BEFORE the body is buffered.
 *
 * ⚠ Mounted above the JSON parser deliberately. body-parser's own 413 says
 * "request entity too large" and nothing else — no size, no limit, no step, and
 * (until this feature) no request id. That message is what execution 05aca859
 * got, and it is why the ops-api 422 that would have diagnosed it never ran.
 */
export function callbackBodyLimit(limitBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.header("content-length"));
    if (!Number.isFinite(declared) || declared <= limitBytes) return next();
    // ⚠ Its own machine name. `request_error` is what body-parser's 413 already
    // produced, and a caller cannot switch on a name three unrelated causes share.
    console.error(
      `[413] [${req.id}] callback body ${declared} > ${limitBytes} on ${req.method} ${req.originalUrl}` +
        (req.stepAuth ? ` execution=${req.stepAuth.flowExecutionId}` : ""),
    );
    return res.status(413).json({ error: "callback_payload_too_large", /* … see contract */ });
  };
}
```

The response body is specified in [contracts/step-callback-limit.md](./contracts/step-callback-limit.md)
and is the **only** place a byte count becomes a sentence.

⚠ **A chunked body carries no `Content-Length`.** Those fall through to the per-router
`express.json({ limit })`, which still bounds them — and produces the coarse `request_error` 413. That
asymmetry is **accepted and documented in the contract** rather than papered over: Kestra's
`io.kestra.plugin.core.http.Request` sends a string body with a length, so every callback this feature
exists for takes the good path. Closing the chunked path properly means counting bytes in a stream
handler, which is a real cost for a case that does not occur here.

### Decision 3 — No invented pointer row, and the run view is already right

`recordStepRun` is the first statement in the `/tool` handler, so a refused callback writes no
`flow_step_runs` row — and this feature deliberately does not add one. The step id lives in the body
that is deliberately never parsed, and a row naming the wrong step is worse than no row.

This costs nothing visible: the run view is assembled from Kestra's `taskRunList` plus logs, with
`flow_step_runs` used only as a pointer map
([flow-visibility.service.ts:347-375](../../packages/server/src/services/flow-visibility.service.ts#L347)),
and `responseCodeFor` already lifts `413` out of the error log. Kestra is the record of which taskrun
failed (R6); Foundry's row carries only what Kestra has no concept of.

**Rejected — emit `X-Foundry-Step: <stepId>` from the compiler** so the 413 could name the step. It is
the tempting version and it costs a **change to every compiled flow's YAML**, which means every flow
republished and NFR-002 broken, to improve a message the operator can already pair with a failing
taskrun on screen. Not worth it. ⚠ If a future feature changes compiled YAML for another reason, adding
the header in the same commit is nearly free — revisit it then, not now.

### Decision 4 — `requestId` moves above the parser, and the 4xx branch starts carrying it

[app.ts:39](../../packages/server/src/app.ts#L39) claims `requestId` is *"mounted first, before anything
that could short-circuit"*. It is mounted after `express.json`. The new order is:

```ts
const app = express();

// ⚠ FIRST, and the comment below is now true. `express.json` short-circuits with a
// 413, and until 2026-08-19 that response had no id to grep for — see spec D2.
app.use(requestId);

// The engine callbacks get their OWN, larger body limit and their own guard, and
// they are mounted ABOVE the process-wide parser so that parser never sees them.
// Order inside the mount is load-bearing: requireStepToken reads only headers, so
// it can name the execution in the refusal; the size guard runs before any parse;
// the parser is last.
app.use("/api/steps", requireStepToken, callbackBodyLimit(config.steps.callbackMaxBytes),
        express.json({ limit: config.steps.callbackMaxBytes }), stepsRouter);
app.use("/api/executions", callbackBodyLimit(config.steps.callbackMaxBytes),
        express.json({ limit: config.steps.callbackMaxBytes }), executionsRouter);

app.use(express.json({ limit: "2mb" }));   // everything else, unchanged
// … CORS, resolveIdentity, and the rest of the routers, unchanged
```

Independently, the 4xx branch of
[error.middleware.ts:82-89](../../packages/server/src/middleware/error.middleware.ts#L82-L89) gains
`requestId`, which the 400 (`22P02`) and both 5xx branches around it already carry. Two separate
reasons the observed body had no id; both fixed.

⚠ **Three things about the new mount order, each of which a reviewer will ask about:**

- **`/api/steps` and `/api/executions` now skip CORS and `resolveIdentity`.** Verified safe: neither
  router reads `req.user` or any identity field (grep is empty), and `app.ts`'s own comment already
  states a blanket identity requirement *"would break Kestra's step callbacks and every harness"*.
  These are server-to-server calls from a container; no browser preflights them.
- **`requireStepToken` before the size guard, not after.** It reads only the `authorization` header
  ([step-token.middleware.ts:31](../../packages/server/src/middleware/step-token.middleware.ts#L31)), so
  it is safe pre-parse — and running it first is what lets the 413 name the flow execution. An unsigned
  9 MiB body is a 401, not a 413, which is the right precedence: an unauthenticated caller learns nothing
  about our limits.
- **`/api/executions` keeps mixed per-route auth**, so its guard cannot name an execution and its
  refusal says so. The asymmetry is in the contract.

### Decision 5 — `checkBulkToolInput` closes the other side of I-119's corridor

New pure check in `flow-output-shape.ts`, registered as a **named entry** in `SHAPE_CHECKS`
([flow-model-findings.ts:95](../../packages/server/src/services/flow-model-findings.ts#L95)) so
`refine` runs it too — I-119 is the record of three checks being enforced on a generated model and not
on an edited one.

It fires when, for a step with `kind: "tool"` and `ref: "llm_complete"`, the `paramsExpr` span whose
nearest preceding key is `"input"`:

1. references the **envelope boundary** `results[0].data` (or `.vars.result`) with **no plucked leaf** —
   a plucked leaf is `checkPluckedThenJq`'s business, not this one's; **and**
2. its jq program contains `tostring` or `tojson` — so it *is* the data, not I-119's description; **and**
3. its jq program contains **no reducing operation**: none of `map(`, `select(`, `limit(`, `group_by(`,
   `add`, `length`, `del(`, `to_entries`, `sort_by(`, `unique`, `first(`, or a slice `.[`…`:`.

Located through `templateSpans`, never a regex of our own — same reason `checkTextToolInput` gives
([:690-695](../../packages/server/src/services/flow-output-shape.ts#L690)): a jq program building an
object ends in `}}` and a non-greedy match reads a truncated program.

⚠ **This check and `checkTextToolInput` define a CORRIDOR, and the corridor is the design.**
`checkTextToolInput` forbids a jq program with **no** `tostring`/`tojson` (a sentence where the data
belonged); this one forbids `tostring` with **no reduction** (the whole dataset where a slice belonged).
Condition 2 is what keeps them from overlapping. The lesson being obeyed is written down at
[flow-model-findings.ts:108-112](../../packages/server/src/services/flow-model-findings.ts#L108):
*"a rule that forbids one of two adjacent errors moves the model to the other."* So:

- **The remedy is stated in the positive form** — *"add a `transform` step that keeps only the rows and
  columns the report needs, and pass the transform's output to `input`"* — never *"don't pass the whole
  response"*.
- **`checkTextToolInput`'s remedy text is edited in the same commit.** It currently recommends
  `` | jq('tostring | @json') | first `` ([:715-719](../../packages/server/src/services/flow-output-shape.ts#L715)),
  which is precisely what the new check refuses. Two rules whose remedies contradict each other is a
  loop, and a model in that loop burns a redraft per turn.
- **One test fixture must satisfy BOTH** (projected *and* serialised) and produce zero findings from
  either. That fixture is the corridor, and it is the assertion that fails if a future edit narrows one
  side onto the other.

**Scoped to `llm_complete`'s `input` alone**, exactly as `checkTextToolInput` is, and for a reason that
is decidable rather than aesthetic: that parameter has a **published 32,000-character ceiling**, so
binding an unbounded payload to it is unverifiable at author time in a way that `mail_send`'s `body` and
a generic tool's parameters are not. ⚠ **Do not widen it to all tool params.** Passing a small tool
response whole is legitimate and common, the check cannot know the size at authoring time, and a finding
that fires on correct flows gets widened — I-62 by another road.

### Decision 6 — The runtime measures and WARNS. It never refuses and never truncates

In `invokeTool`, after the dial, each item gains its response size and two warning conditions are
evaluated:

```
"BTO_tool returned 7,539,026 bytes; its largest array has 4,722 entries. Kestra stores this in the
 execution record, and any step that passes it on whole will exceed its own limit."

"BTO_tool declares no parameters, so `period` was sent as a query parameter and the endpoint is free
 to ignore it. Register the parameters it accepts so a flow can narrow the read."
```

Both go in `StepBatchResult.warnings`, which exists for exactly this
([step-execution.service.ts:66-68](../../packages/server/src/services/step-execution.service.ts#L66)),
and **the step still succeeds**. `TOOL_RESPONSE_WARN_BYTES` defaults to **1 MiB**.

The "largest array" figure is mechanical, not a guess: if the parsed payload is an array, its length; if
an object, the length of its longest array-valued property; otherwise omitted. For this run that reads
4,722 from `data`, which is the number an operator needs.

⚠ **Rejected — a hard cap on a tool response.** A large read followed by a reducing `transform` is a
correct flow, and refusing it breaks automations that work today. Had a hard cap existed on
2026-08-18 the run would have failed at `fetch` with a better message — and a legitimate bulk-read flow
would have failed with the same one.

⚠ **Rejected — truncate the payload, or truncate `input` at 32,000 characters.** Both are the failure
this codebase refuses everywhere: a run that silently reports on 0.4% of the data and exits 0 is I-119
with new arithmetic. Nothing here truncates anything (FR-012).

### Decision 7 — `triage()` gets no 413 branch, and the spec says why

`failure-triage.service.ts` already has `output_too_large` → `flow_redraft` with the right sentence, and
**no production call site** — grep finds `triage(` only in its own definition and tests, which is why
this run's `failure_class` and `triage_route` are `NULL`. Adding an `httpStatus === 413` branch would be
a correct branch in dead code, and *"a correct detector nothing calls"* is the shape I-120 records.

**Wiring the ladder is its own feature.** Recorded in spec D6 so the empty columns are not misread as
triage having looked and found nothing.

### Decision 8 — The BTO tool and this flow are fixed as DATA, in a runbook, not in code

P3 is `params_schema` on `BTO_tool` plus a `transform` step in `attendance_report_email_2`. Neither is a
source change and neither is in `tasks.md`'s code phases — it is a runbook section, blocked only on the
one open clarification about what `https://api.ims.bto.apps.askml.ai/ims` actually accepts.

⚠ **Cross-link, not a dependency**: `specs/20260818-123807-tool-probe` adds a probe that dials an
onboarded tool exactly the way a `tool` step dials. Once P2 lands, that probe is the natural place to
show a response size and a missing `params_schema` **before** a flow is ever drafted against the tool —
one field on its result, in that feature, not this one.

### Decision 9 — When the report genuinely needs all the rows: a `code` step, not a bigger prompt

Decision 5 refuses the unbounded expression and its remedy names a `transform`. That is right for the
common case — the report needs 300 rows of one month and the flow was handed 4,722 of all time. But it
does not answer the case where somebody genuinely wants a report over the whole dataset, and leaving that
unanswered is how the refusal gets argued away later. The answer is **already built and needs no new
surface**:

```
fetch (tool)  →  code (Python: filter + aggregate)  →  llm_complete (prose over the aggregate)  →  send
```

⚠ **The strongest reason for the `code` step is structural, not stylistic: its input never passes through
Foundry.** The compiler emits the fragment's data as `inputFiles: input.json`
([:1317](../../packages/server/src/services/flow-compiler.service.ts#L1317)), which **Kestra** renders and
writes into the container. A `tool` step's parameters, by contrast, are POSTed to `/api/steps/tool` — the
hop that answered 413. So a fragment can be handed the whole 7.19 MB **today, with no cap change
anywhere**, and the only bound on that path is `FRAGMENT_MAX_OUTPUT_BYTES` (1 MB) on what it returns,
which an aggregate clears by three orders of magnitude. The reduction is therefore not a workaround for a
limit — it is the one path in the product that the limit does not sit on.

A `code` step runs a generated Python fragment in `foundry/fragment-base:py3.12-pandas2.2.3` with **no
network, no credentials** and a checked output contract. So the filtering and every number is computed by
deterministic code that a person can read, and the model receives a small aggregate and writes sentences
about it — which is `llm_complete`'s declared role (D-34: terminal, never load-bearing). This is not a new
pattern to invent: **`finance-budget-variance` already does exactly this** — the fragment computes the
figures, the model writes the narrative as a leaf.

**Choosing between the two remedies is decidable, so the remedy text names both:**

| The report needs | Use | Because |
|---|---|---|
| fewer rows / fewer columns of the same shape | `transform` | a projection, no arithmetic, runs in the engine with no credentials |
| counts, totals, rankings, per-group figures | `code` | arithmetic must not be done by a model, and a fragment's output is contract-checked |

⚠ **Rejected — map-reduce summarisation (chunk the rows, summarise each chunk, summarise the
summaries).** Three reasons, in order of severity:

1. **It breaks D-34 by construction.** The mini-summaries become the *input* to the final summary, which
   makes `llm_complete` output load-bearing — the one thing that rule forbids. D-34 was earned, not
   theorised: a digest whose figures were all correct ranked two departments in an order its own numbers
   contradicted. Aggregating numbers through a model is the documented failure mode in this repo.
2. **The arithmetic is prohibitive.** 7,539,026 characters ÷ 32,000 = **~236 `llm_complete` calls** for
   one report, on a decode-bound path measured at ~20–30 s per call, plus a taskrun per fan-out item —
   the exact row explosion M1's batching exists to prevent.
3. **It answers the wrong question.** The request was for **one month**. Map-reduce would faithfully
   summarise 4,722 rows nobody asked for.

   It remains the right tool for a genuinely different problem — many long free-text documents, where
   there is no arithmetic to get wrong and no reduction available. That is not this case.

⚠ **Rejected — EXTERNAL object storage plus an external code-interpreter service** (S3/GCS/Blob + a
hosted "advanced data analysis" model). The instinct is right — code should read the data, not a prompt —
and this codebase already satisfies it with `code` steps. What is rejected is the *transport*: it imports a
cloud credential and an egress question, and the model doing the analysis would be an outside service
reading tenant rows, for a problem a `transform` or `code` step already solves in-flow.

⚠ **NOT rejected, and do not re-argue it from the wrong premise — KESTRA'S OWN INTERNAL STORAGE IS A
REAL, IN-ARCHITECTURE MECHANISM.** An earlier draft of this decision rejected "a bucket" partly on the
grounds that a fragment has no network and so could not read one. **That reasoning is wrong**, and it was
measured wrong against the running engine (`GET /api/v1/plugins/io.kestra.plugin.scripts.python.Script`):

* `inputFiles` — *"Each file can be defined: Inline with its content; **As a URI, supported schemes are
  `kestra` for internal storage files**, `file` for host local files, and `nsfile` for namespace files."*
* `outputFiles` — *"Declares files produced by the script that should be uploaded to Kestra's internal
  storage."*

Kestra **stages** the file into the container; nothing is fetched over a network, so `networkMode: none`
and internal storage compose without tension. **I-128 does not contradict this**: it is about
internal-storage URIs appearing in step OUTPUTS that Foundry's read surface must render (an R5/R6
question), not about Kestra handing a file to a container it is already starting. And §5.3.2 asks for
exactly this — *"step outputs above a threshold (start at ~1 MB) are written to Kestra's internal storage
and passed by reference"* — with **D-20** declining it for a `code` step's **output** channel only
("pick one and never mix"), which says nothing about inputs.

⚠ **It is nonetheless OUT OF SCOPE HERE, for a scope reason rather than an architectural one.** It does
not fix the reported incident (see the next block), and the tool leg it would have to cover cannot be
reached from where this feature sits: `io.kestra.plugin.core.http.Request` — the task type **every** tool
step compiles to ([:1049](../../packages/server/src/services/flow-compiler.service.ts#L1049)) — has
properties `allowFailed, body, contentType, encryptBody, formData, headers, method, options, params,
pluginDefaultsRef, sslOptions, uri` and **no `store`/`saveAs` of any kind** (measured on the engine). Only
`http.Download` stores (`saveAs` → `uri` + `length`), and it dials a URL itself. So routing a tool
response into internal storage means **Foundry holding the payload and serving it for a Download** — a new
store with retention, tenancy and redaction questions, against R6's "Foundry keeps the pointer, not the
data", and tool calls cannot move into Kestra instead because they need tenant credentials (R2).

**Recorded as its own follow-up** — `specs/20260819-120000-kestra-internal-storage/spec.md` (a STUB, not a
plan) — with the two things it would genuinely buy: the execution-record bloat (this run left
**8,403,023 B** in Kestra's database, re-served on every graph read — exactly what §5.3.2 warns about, and
untouched by this feature) and `code` → `code` chains. It carries the engine measurements, the two
arguments that must not be re-used against it, and five scope questions to answer before planning.

⚠ **Rejected — raise the caps until the whole payload reaches `llm_complete`.** Not a policy objection, an
arithmetic one. The chain would be `OPS_LLM_MAX_INPUT_CHARS` 32,000 → ~7,600,000, then the callback cap to
~10 MB, and then **the model's own context window: 7,539,026 characters is ≈1.9M tokens**, which exceeds
every model this gateway serves (`gemma-4-26B-A4B-it`, `gpt-5.4-mini`, `gpt-5-nano`, `gpt-5.4-nano` — the
four with measured throughput in CLAUDE.md). The 32,000 cap is a guardrail standing well in front of a
wall that no configuration moves. ⚠ Raising it **modestly** (e.g. 100,000) is defensible if real
aggregates are being squeezed, under two rules: it stays far below the callback cap so the specific
refusal keeps winning (Decision 1), and far below the model's window. It is not a path to megabytes.

⚠ **Scope note.** Decision 9 changes **no code on its own** — it is the remedy wording (T10/T12) and the
prompt example (T14), which P2 already touches. What it adds to P2 is that both remedies are taught, with
the rule for picking one, so a model that cannot use a `transform` reaches for a `code` step instead of
for a bigger `input`.

---

## Complexity Tracking

| Decision that adds surface | Why needed | Simpler alternative rejected because |
|---|---|---|
| A second body limit rather than one | The specific per-parameter refusals must win over the transport one (Decision 1) | One global number cannot be both above every parameter cap and tight for the rest of the API |
| Two remedies (`transform` **and** `code`) rather than one | A refusal with no answer for "but I need all the rows" gets argued away (Decision 9) | Naming only `transform` leaves aggregation unanswered; naming only `code` sends a plain projection through a container |
| Nothing added for map-reduce or a bucket + code interpreter | Both were considered and rejected on record (Decision 9) | Map-reduce makes `llm_complete` load-bearing (D-34) at ~236 calls per report; a bucket has no reader in this stack (I-128) and fragments have no network |
| A new middleware rather than `express.json`'s own 413 | body-parser's message names nothing and cannot be configured | Mapping `entity.too.large` in the error middleware still loses the size, the limit and the execution — the parser has already discarded them |
| Mount-order change in `app.ts` | The parser must not see the callback routes at all, and `requestId` must precede it | Leaving the order and only editing the error middleware yields a 413 with an id and still no facts |
| A fifth `SHAPE_CHECKS` entry | Prevention at author time, in generation **and** refine | The prompt alone is what I-118 records failing: *"the prompt is what the model obeys, the check is what catches it when the model does not"* |
