# Feature Specification: an oversize step payload must name itself

**Feature Branch**: `20260819-045902-step-payload-bounds` (current branch is `20260818-084135-email-send-tool`)

**Created**: 2026-08-19

**Status**: Draft — one open clarification (the BTO endpoint's real filter parameters, see Clarifications)

**Input**: User report: *"check this runs/05aca859-91df-4472-be95-edcd7e0d967b — the BTO tool is giving
the 413 error while running the automation"*

**Clarifications taken at review** (2026-08-19)

| Question | Answer |
|---|---|
| How big should the step-callback limit be? | **5 MB** (5,242,880 B), not 8 MiB. It clears every per-parameter cap by more than an order of magnitude, which is the requirement; the number itself is not the fix. ⚠ **The measured 8,401,233 B body therefore stays refused**, deliberately — see plan Decision 1. |
| What should a flow do when the report genuinely needs all the rows? | A **`code` step** (Python + pandas, no network, no credentials, contract-checked output) computes the aggregate; `llm_complete` writes prose over the small result. ⚠ Its input is staged into the container by **Kestra** and never passes through Foundry's callback, so a fragment takes the whole 7.19 MB **today, with no cap change**. Map-reduce summarisation, **external** object storage + a hosted code interpreter, and raising the caps to fit the payload were all **rejected** — plan Decision 9. |
| Can Kestra's internal storage handle the large payload? | **Yes as a mechanism, no as a fix for this.** `inputFiles` accepts `kestra://` URIs and `outputFiles` writes to internal storage (measured on the engine), so it composes with `networkMode: none` — an earlier draft rejected it on the wrong premise. It is a **follow-up**, because it does not fix this incident and `http.Request` has no store option, so the tool leg would need a Foundry-side payload store (R6). |

**Clarifications needed**

| Question | Who answers | Blocks |
|---|---|---|
| What query parameters does `https://api.ims.bto.apps.askml.ai/ims` actually accept to narrow a read to one period / one department? It ignored `period=2026-06` and returned the whole employee master. | whoever owns the BTO/IMS API | **P3 only** — the runbook data fix. P1 and P2 do not depend on it. |

---

## The measured failure

Execution `05aca859-91df-4472-be95-edcd7e0d967b` (workspace `hr`, flow `abeaa493-5116-47fb-ad8c-6b8a5366d458`,
Kestra execution `1sVK0rpxvRV0UtRWKGawUH` in `foundry.default.hr.draft`, revision 1,
`{"period":"2026-06"}`, 2026-08-18 13:50:00.966Z → 13:50:11.520Z, `failed`).

| Taskrun | State | Outputs |
|---|---|---|
| `begin` | SUCCESS | 768 B |
| `fetch` — `BTO_tool` | **SUCCESS** | **8,403,023 B** |
| `report` — `llm_complete` | **FAILED** | — |
| `send`, `complete` | never created | — |

`BTO_tool` answered `200` with `{"application":"pulse-app","count":4722,"data":[…]}` — **4,722 rows ×
50 columns**. `results[0].data` is **7.19 MiB** minified; JSON-escaped into a string literal it is
**8.01 MiB**.

The compiled `report` step inlines that whole payload into its own request body:

```
"input": {{ json(outputs.fetch.body).results[0].data | jq('tostring | @json') | first }}
```

and POSTs it to `/api/steps/tool`, where the process-wide body cap is 2 MB
([app.ts:35](../../packages/server/src/app.ts#L35)). Kestra's log for taskrun `43cgqz54JH32PQAhAcaOW5`:

```
DEBUG report | Request 'http://server:4000/api/steps/tool' from 'server/172.19.0.4:4000'
              with the response code '413'
ERROR report | Failed http request with response code '413' and body:
              {"error":"request_error","message":"request entity too large"}
```

**The BTO tool did not fail.** It returned 200 and it returned everything, and the step that failed is
the next one.

---

## Why this is a feature and not a one-line limit bump

Raising `express.json`'s limit makes *this* run reach ops-api, which already refuses correctly —
`OPS_LLM_MAX_INPUT_CHARS` is 32,000 and [ops.ts:1358](../../packages/ops-api/src/routes/ops.ts#L1358)
answers **422**: *"input is 7,539,026 characters; the limit is 32,000. Summarise or filter upstream —
this step is a text transformer, not a bulk reader."*

That sentence is the whole diagnosis. It exists, it is good, and **a coarser cap two hops upstream
destroyed it.** So the defect is not "the limit is too low". It is:

### D1 — The transport cap is the binding constraint, so the specific error never runs

2 MB at [app.ts:35](../../packages/server/src/app.ts#L35) is *below* what the tool this body was
addressed to would have said something useful about. Every oversize step payload, whatever its real
cause, collapses into four words.

### D2 — The 413 carries no request id, twice over

[app.ts:39](../../packages/server/src/app.ts#L39) says `requestId` is *"mounted first, before anything
that could short-circuit"*. It is mounted **after** `express.json`, which is precisely a thing that
short-circuits — this 413 is the proof. And independently, the 4xx branch of
[error.middleware.ts:82-89](../../packages/server/src/middleware/error.middleware.ts#L82-L89) omits
`requestId` from its body, unlike the 400 and 5xx branches around it. Two separate reasons the observed
body has no id to grep for.

### D3 — Nothing on the Foundry side can be recorded about the step that failed

`recordStepRun` is the first statement in the `/tool` handler
([steps.ts:71-79](../../packages/server/src/routes/steps.ts#L71-L79)). The body parser rejected the
request before any handler ran, so `flow_step_runs` holds exactly **one** row for this execution —
`fetch` — and none for `report`.

⚠ **This does not make the step invisible.** The run view is assembled from Kestra's `taskRunList` and
logs, with `flow_step_runs` used only as a pointer map
([flow-visibility.service.ts:347-375](../../packages/server/src/services/flow-visibility.service.ts#L347)),
and `responseCodeFor` even lifts `413` out of the error log
([:310](../../packages/server/src/services/flow-visibility.service.ts#L310)). So the operator sees
`report`, sees FAILED, and sees 413. What they get with it is *"request entity too large"* and nothing
else — no request id, no size, no limit, no remedy — and Foundry has no row on which `attempt`,
`failure_class` or `triage_route` could ever be written for this failure. The visible half is Kestra's;
the missing half is ours.

### D4 — Nothing measured 7.19 MiB anywhere, and 7.19 MiB is the actual anomaly

`fetch` succeeded silently. Kestra now stores an 8.4 MB execution record; the API returns it on every
graph read. `StepBatchResult.warnings` exists for exactly this class of remark
([step-execution.service.ts:66-68](../../packages/server/src/services/step-execution.service.ts#L66))
and nothing put anything in it. A one-month attendance request answered with the entire employee master
is a fact worth one sentence at the moment it happens.

### D5 — The drafter was told to write the failing expression

[flow-generation.service.ts:250-251](../../packages/server/src/services/flow-generation.service.ts#L250-L251):

```
  "input": {{ json(outputs.<id>.body).results[0].data | jq('tostring | @json') | first }}
  (or project the fields you want first, then `| tostring | @json`.)
```

The canonical example is the **unbounded** form and the bounded form is a parenthetical. The model
followed the example. `checkTextToolInput`'s own remedy text
([flow-output-shape.ts:715-719](../../packages/server/src/services/flow-output-shape.ts#L715-L719))
recommends the same unbounded form. Two places teach it and no check forbids it.

### D6 — `output_too_large` exists and cannot fire for this

[failure-triage.service.ts:225-234](../../packages/server/src/services/failure-triage.service.ts#L225)
classifies *"a step returned more than the output cap allows"* → `flow_redraft`, with the right words:
*"Split it, or aggregate earlier in the flow."* It is reachable only through a `code` step's
`wrapperFailureClass`; there is no branch on `httpStatus === 413`. And `triage()` has **no call site in
`src` outside its own tests** — which is why this run's `failure_class` and `triage_route` are `NULL`.
Wiring the ladder is **out of scope** here (see plan Decision 7); this spec records why the columns are
empty so the next person does not read that as "triage said nothing was wrong".

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — The run says what happened (Priority: P1)

An operator opens run `05aca859-…`, sees `report` failed with 413, and reads: *"this run sent a
8,401,233-byte step callback; the limit is 5,242,880 bytes. A step parameter is carrying a whole
upstream response — reduce it with a transform step (or a code step if the report needs totals) before
passing it on."* — with a request id that
finds exactly one server log line.

**Why this priority**: today the same operator sees the same 413 and gets four words with it. Everything
else in this feature is prevention; this is the part that makes the *next* unforeseen oversize
diagnosable at all.

**Independent Test**: POST a 9 MiB body to `/api/steps/tool` with a valid execution token; assert
status 413, `error: "callback_payload_too_large"`, a `requestId` present in the body, `limitBytes` and
`actualBytes` named, and one server log line carrying the same id and the execution id.

**Acceptance Scenarios**:

1. **Given** a step callback whose `Content-Length` exceeds the callback limit, **When** it arrives,
   **Then** the response is 413 with `error: "callback_payload_too_large"`, and the body is **never
   buffered or parsed**.
2. **Given** the same request, **Then** the response carries a `requestId` and the server logged one
   line naming that id, the execution id, the path and both byte counts.
3. **Given** a step callback of 3 MB — over the old process-wide 2 MB and under the callback limit —
   **When** it arrives, **Then** it succeeds, because the transport cap is no longer the binding
   constraint.
4. **Given** an 8 MB `llm_complete` `input` that now reaches ops-api, **Then** the step fails with
   ops-api's **422** naming 32,000 characters, not with a 413.
5. **Given** any 4xx produced by the error middleware, **Then** the body carries `requestId`.

---

### User Story 2 — A flow that would send an unbounded payload is refused before it is saved (Priority: P1)

Somebody asks for an attendance report. The drafter writes `input` as the whole of `fetch`'s response.
Generation reports: *"step `report` binds `input` to the entire response of `fetch`. `llm_complete`
accepts 32,000 characters and a tool response is bounded by nothing, so this works or fails depending
on how much the endpoint happens to return. Add a `transform` step that keeps only the rows and columns
the report needs — or a `code` step if the report needs counts or totals — and pass its output."* The
next draft has a `transform` step and runs.

**Why this priority**: I-119 is the record of what happens when the prompt teaches one form and no
check enforces the corridor — *"a rule that forbids one of two adjacent errors moves the model to the
other"* ([flow-model-findings.ts:108-112](../../packages/server/src/services/flow-model-findings.ts#L108)).
`checkTextToolInput` forbids a description with no `tostring`; nothing forbids `tostring` with no
reduction. This closes the other side of the same corridor, and it must land in `SHAPE_CHECKS` so
**refine** runs it too.

**Acceptance Scenarios**:

1. **Given** a drafted step with `ref: llm_complete` whose `input` span pipes `results[0].data` through
   `tostring`/`tojson` with no reducing operation, **Then** `pureModelFindings` reports it, naming the
   step and the remedy in the positive form.
2. **Given** the same expression with a reduction — `map`, `select`, `limit`, `.[0:n]`, `group_by`,
   `add`, `length`, `del`, `to_entries`, `sort_by`, `unique`, `first(` — **Then** there is no finding.
3. **Given** an expression that plucks a leaf (`.text`) rather than the whole payload, **Then** there
   is no finding — that shape is `checkPluckedThenJq`'s business, not this one's.
4. **Given** a fixture that satisfies **both** new and existing checks (projected *and* serialised),
   **Then** neither `checkTextToolInput` nor the new check fires. ⚠ This scenario is the corridor, and
   it is what stops the two rules pushing a model back and forth between two failures.
5. **Given** the drafter prompt, **Then** its canonical `input` example is the **projected** form, and
   `checkTextToolInput`'s remedy text recommends the same form as the new check.
6. **Given** any remedy this feature states, **Then** it names both the `transform` and the `code` route
   with the rule for choosing, and names **no** chunk-and-summarise route (FR-008a, FR-008b).

---

### User Story 3 — A tool that returns 7 MiB says so at the moment it does (Priority: P2)

The operator reruns the flow after the fix. `fetch` succeeds, and the step result carries: *"`BTO_tool`
returned 7,539,026 bytes; its largest array has 4,722 entries. Kestra stores this in the execution
record, and any step that passes it on whole will exceed its own limit."* Beside it: *"`BTO_tool`
declares no parameters, so `period` was sent as a query parameter and the endpoint is free to ignore
it."*

**Why this priority**: both sentences were knowable at 13:50:04 on 2026-08-18 and neither was said.
`BTO_tool.params_schema` is `NULL`, which is why `period` was invented and silently discarded. These
are **warnings, not failures** — a large read followed by a `transform` is legitimate, and a hard cap
would break flows that work today.

**Acceptance Scenarios**:

1. **Given** a tool step whose response exceeds the soft cap, **Then** the step still **succeeds** and
   `StepBatchResult.warnings` carries one sentence naming the tool, the byte count and the largest
   array's length.
2. **Given** a tool with `params_schema` `NULL` called with at least one parameter, **Then** one
   warning names the parameters that were sent and states that the endpoint may ignore them.
3. **Given** a tool response under the soft cap, **Then** no warning is added and `warnings` keeps its
   existing contents unchanged.
4. **Given** any tool step, **Then** each `StepItemResult` carries the response size in bytes.

---

### User Story 4 — This specific automation works (Priority: P3)

`BTO_tool` narrows its read to the requested period, `attendance_report_email_2` has a `transform`
between `fetch` and `report`, and the flow emails the report.

**Why this priority**: it is the customer-visible half, it is **data and not code**, and it depends on
the one open clarification. P1 and P2 ship without it; it ships without them, worse.

**Acceptance Scenarios**:

1. **Given** the real filter parameters registered in `BTO_tool.params_schema`, **When** the flow runs
   for `2026-06`, **Then** `fetch`'s response covers that period only.
2. **Given** a `transform` step between `fetch` and `report`, **Then** `report`'s `input` is under
   32,000 characters and the run reaches `send`.
3. **Given** the flow before either fix, **Then** it fails at `report` with the P1 message — never
   with a bare 413.

---

## Requirements *(mandatory)*

### Functional

- **FR-001** `/api/steps/*` and `/api/executions/*` MUST have their own request-body limit, set from
  configuration, **independent of and larger than** the process-wide limit for the rest of the app.
- **FR-002** That limit MUST be checked against `Content-Length` **before** the body is buffered or
  parsed, and MUST refuse with a distinct, stable machine name — `callback_payload_too_large` — never
  the generic `request_error`.
- **FR-003** The refusal MUST name: the byte count received, the limit, the flow execution (when the
  execution token resolved), the request id, and the remedy in one sentence.
- **FR-004** The callback limit MUST be documented as **deliberately above** every downstream tool's own
  input cap, so a specific refusal (ops-api's 422 at 32,000 chars; `MAIL_MAX_BODY_BYTES` at 262,144)
  always wins over the transport one.
- **FR-005** `requestId` MUST be mounted above the body parser, and the error middleware's 4xx branch
  MUST include `requestId` in its body.
- **FR-006** The refusal MUST **not** invent a `flow_step_runs` pointer row. The step id lives in the
  body, the body is deliberately never parsed, and a row naming the wrong step is worse than no row.
  Kestra remains the record of which taskrun failed (R6) and the run view already reads it — see D3 and
  plan Decision 3.
- **FR-007** A new pure model check MUST report an `llm_complete` `input` bound to a whole tool payload
  with no reducing operation, and MUST live in `SHAPE_CHECKS` so `refine` runs it.
- **FR-008** The drafter prompt's canonical `input` example and `checkTextToolInput`'s remedy text MUST
  both recommend the projected form.
- **FR-008a** Every remedy the product states for an oversize `input` MUST name **both** reductions and
  the rule for choosing: a **`transform`** step for fewer rows or columns of the same shape, a **`code`**
  step when the report needs counts, totals, rankings or per-group figures. A remedy naming only
  `transform` leaves aggregation unanswered, and a model with no answer reaches for a bigger `input`.
- **FR-008b** No surface — prompt, finding, remedy or documentation — may suggest **chunking a payload
  through repeated `llm_complete` calls and summarising the summaries.** That makes `llm_complete` output
  load-bearing, which D-34 forbids, and costs ~236 calls for the measured payload. See plan Decision 9.
- **FR-009** A tool step whose response exceeds a configured soft cap MUST add one warning and MUST
  still succeed.
- **FR-010** A tool with no `params_schema`, called with parameters, MUST add one warning naming them.
- **FR-011** Each `StepItemResult` from a tool step MUST carry the response size in bytes.
- **FR-012** No new limit may **silently truncate** anything. Truncation as a remedy is rejected —
  see plan Decision 6.
- **FR-013** No part of this feature may introduce **external** object storage (S3/GCS/Blob), a file-path
  handoff to an outside service, or an external code-interpreter integration. Data reduction happens
  **in-flow**, in a `transform` or `code` step — see plan Decision 9.
  ⚠ **This is scoped to EXTERNAL storage.** **Kestra's own internal storage is a legitimate, available
  mechanism** — `python.Script`'s `inputFiles` accepts a `kestra://` URI and `outputFiles` writes back to
  it (measured on the running engine), and §5.3.2 asks for exactly that above ~1 MB. It is out of scope
  **here** because it does not fix this incident and because `http.Request` — the task every tool step
  compiles to — has no store option at all, so the tool leg would need a Foundry-side payload store (R6).
  Recorded as a follow-up; do not re-reject it on the false premise that a fragment cannot read one.
- **FR-014** Raising a cap MUST NOT be offered as the remedy for an oversize `llm_complete` input. The
  binding constraint is the model's context window (≈1.9M tokens for the measured payload), which no
  configuration moves; the caps in this feature sit in front of it deliberately. See plan Decision 9.

### Non-functional

- **NFR-001** Peak additional memory is bounded by `callback limit × BUDGET_DEFAULT_MAX_CONCURRENT`
  ([config/index.ts:251](../../packages/server/src/config/index.ts#L251), default 5), because an
  oversize body is refused on its `Content-Length` and never allocated.
- **NFR-002** No migration. No new npm dependency. No change to compiled flow YAML, so no flow needs
  republishing and no manifest fingerprint moves.
- **NFR-003** Existing behaviour of a tool step is unchanged apart from added `warnings` and `bytes`.
  `step-execution.test.ts`, `mail-end-to-end.test.ts` and `egress-parity.test.ts` must pass unedited.

### Out of scope

- Wiring `triage()` to a call site, and adding an `httpStatus === 413` branch to it. The function has no
  production caller; adding a branch to dead code is YAGNI (Constitution IV). Recorded in D6 above so the
  `NULL` columns are not misread.
- Any change to Kestra's own execution-record size, or to how much of a step's output Kestra stores.
- Streaming or file-backed step payloads. If a flow legitimately needs to move megabytes between steps,
  that is a `transform` inside Kestra (no network, no I/O —
  [flow-compiler.service.ts:595-596](../../packages/server/src/services/flow-compiler.service.ts#L595-L596)),
  not a larger callback.

---

## Success criteria

1. Replaying execution `05aca859-…`'s exact shape produces ops-api's 422 naming 32,000 characters —
   or, for a payload larger still, the P1 413 naming both byte counts, the execution and a request id
   that resolves to one log line.
2. A drafted flow with the unbounded `input` form is refused at generation **and** at refine.
3. `BTO_tool` returning 7.19 MiB produces a warning at the step that reads it, and the run still
   succeeds if the flow reduces it.
4. `pnpm typecheck && pnpm test` green, with NFR-003's three suites unedited.
