# Contract: the step-callback body limit, and the two step-time warnings

**Feature**: [20260819-045902-step-payload-bounds](../spec.md) · **Plan**: [plan.md](../plan.md)

This file is the **only** place a byte count becomes a sentence. Every string below is asserted by a
test; none of them is composed at a call site.

---

## 1. The limit ladder

A payload too large *for the tool it is addressed to* must always be refused by that tool, not by
transport. So the caps are ordered, and the ordering is the contract:

| # | Cap | Bytes | Owner | Configurable by |
|---|---|---|---|---|
| 1 | `llm_complete`'s `input` | 32,000 **chars** | ops-api | `OPS_LLM_MAX_INPUT_CHARS` |
| 2 | `foundry_email_send`'s `body` | 262,144 | server | `MAIL_MAX_BODY_BYTES` |
| 3 | **a step callback's whole body** | **5,242,880** | server (new) | `STEP_CALLBACK_MAX_BYTES` |
| 4 | every other route's body | 2,097,152 | server | — (literal `"2mb"`) |

⚠ **Invariant: 3 > 2 > 1, by a wide margin.** If `STEP_CALLBACK_MAX_BYTES` is ever lowered below cap 2,
an oversize mail body starts reporting as a transport failure and the mail cap's own message — which
names the UTF-8-bytes-not-characters rule — becomes unreachable. A test asserts the default is at least
8× the largest per-parameter cap.

⚠ **Cap 4 is not raised.** The two public receivers, the flow-model routes and everything else keep 2 MB.

---

## 2. `413 callback_payload_too_large`

Emitted by `callbackBodyLimit`, mounted on `/api/steps` and `/api/executions` **above** their JSON
parsers.

### Trigger

`Content-Length` is present, finite, and **greater than** `STEP_CALLBACK_MAX_BYTES`. The body is not
buffered, not parsed and not read.

### Response

```json
{
  "error": "callback_payload_too_large",
  "message": "this run sent a 8,401,233-byte step callback; the limit is 5,242,880 bytes. A step parameter is carrying a whole upstream response — reduce it with a transform step (or a code step if the report needs totals) before passing it on.",
  "requestId": "3f1c…",
  "actualBytes": 8401233,
  "limitBytes": 5242880,
  "flowExecutionId": "05aca859-91df-4472-be95-edcd7e0d967b"
}
```

| Field | Rule |
|---|---|
| `error` | Exactly `callback_payload_too_large`. ⚠ **Never `request_error`** — that name is already produced by body-parser's own 413, by a `ZodError`, and by every 4xx a service throws, and a caller cannot switch on a name four unrelated causes share. Stable; never rephrased. |
| `message` | One sentence, both numbers, and the remedy. ⚠ It names a **transform step** specifically, because that is the only reduction that runs inside Kestra with no network and no I/O. |
| `requestId` | Always present. `X-Request-Id` carries the same value. |
| `actualBytes` / `limitBytes` | Always present. The caller may not have to parse the sentence to act. |
| `flowExecutionId` | Present on `/api/steps/*` only, where `requireStepToken` has already resolved it from the execution token. **Absent on `/api/executions/*`** — mixed per-route auth, so the guard there has no execution to name, and the message reads *"a step callback"* rather than *"this run"*. |

### Log line

Exactly one, at `error`, before the response:

```
[413] [<req.id>] callback body 8401233 > 5242880 on POST /api/steps/tool execution=05aca859-…
```

The `execution=` clause is omitted when there is none. ⚠ **No part of the body is logged** — it is
tenant data and, at 8 MB, a log line nobody can read.

### What is deliberately NOT in the response

- **The step id.** It lives in the body, which is deliberately never parsed. See plan Decision 3 — the
  failing taskrun is already identified in the run view from Kestra's record.
- **Any echo of the payload.**

### The chunked-body gap, stated

A request with no `Content-Length` (chunked transfer encoding) is not caught by this guard. It is still
bounded — the per-router `express.json({ limit })` rejects it — but the refusal is body-parser's own
`{"error":"request_error","message":"request entity too large"}`, now at least carrying `requestId`
(plan Decision 4).

⚠ **This is accepted, not overlooked.** Kestra's `io.kestra.plugin.core.http.Request` sends a string
body with a declared length, so every callback this feature exists for takes the guarded path. Closing
the chunked path means counting bytes in a stream handler — real cost, for a caller that does not exist
here. A test pins the coarse path's behaviour so nobody later reads it as the good one.

---

## 3. Step-time warnings

Both are entries in `StepBatchResult.warnings`. **Neither fails the step**, and neither truncates
anything.

### ⚠ Both also reach the all-failed `502` — amended 2026-08-24

A tool batch where **every** call failed throws `502 tool "<name>": all N call(s) failed` instead of
returning. Until this amendment the two remarks were built below that `throw`, so the run that most
needed §3b — the one where nothing worked at all — was the only run that never got it.

Both remarks are now produced by a single `payloadRemarks()` and carried on **both** exits:

| Exit | Where the remarks are |
|---|---|
| normal return | `StepBatchResult.warnings`, as before — byte-for-byte unchanged. |
| all-failed `502` | `detail.warnings`, **added beside `detail.results`**. |

| Rule | Why |
|---|---|
| `detail.results` is **unchanged** on that 502 | It is the field a caller reads to decide what is safe to retry (`step-execution.test.ts`' own header states the retry argument). The fix ADDS a key; it does not move or reshape that one. |
| `detail.warnings` is **absent, not `[]`**, when there is nothing to say | A field that is an empty list on every unremarkable 502 gets rendered once and ignored — and then the day it has something in it is the day nobody reads it. |
| §3a is measured on **failing** responses too | A `503` answering with a megabyte of HTML is exactly the payload that breaks whatever step passes it on, and the failing path is where those bodies live. |
| one function, two call sites | Two copies would become two different pieces of prose about the same payload, and the failing one would be the copy nobody reads until it is wrong. A test asserts the succeeding path still emits the same sentence. |

### 3a. An oversize tool response

Fires when a single item's response body exceeds `TOOL_RESPONSE_WARN_BYTES` (default 1,048,576).

```
BTO_tool returned 7,539,026 bytes; its largest array has 4,722 entries. Kestra stores this in the
execution record, and any step that passes it on whole will exceed its own limit.
```

| Part | Rule |
|---|---|
| tool name | The `ref` as called. |
| byte count | UTF-8 bytes of the response body, as measured — not the parsed size. |
| `its largest array has N entries` | Mechanical: array payload → its length; object payload → the length of its longest array-valued property; anything else → **the clause is omitted entirely**. ⚠ Never guessed and never a row *estimate*. |
| the consequence | Named, because *"7 MB"* alone does not tell an operator that Kestra is now storing it or that the next step will fail. |

### 3b. A tool that declares no parameters

Fires when `tools.params_schema` is `NULL` or empty **and** the step sent at least one parameter key.

```
BTO_tool declares no parameters, so `period` was sent as a query parameter and the endpoint is free to
ignore it. Register the parameters it accepts so a flow can narrow the read.
```

| Part | Rule |
|---|---|
| the parameter names | Listed, backticked, comma-separated. ⚠ **Names only — never values.** A parameter value can be tenant data. |
| `as a query parameter` / `in the JSON body` | Whichever the method actually used, per [step-execution.service.ts:464-467](../../../packages/server/src/services/step-execution.service.ts#L464). |
| the remedy | Register the schema. This is the sentence that would have ended execution `05aca859-…`'s investigation in five seconds. |

⚠ **One warning per step, not per item.** A batch of 200 items against an undeclared-params tool
produces one sentence, or the warnings array becomes the oversize payload.

---

## 4. `checkBulkToolInput`'s finding

One string, from `flow-output-shape.ts`, reported through `pureModelFindings` in both generation and
refine.

```
step "report".paramsExpr binds `input` to the entire response of "fetch" and serialises it whole, with
no filtering or projection. `llm_complete` accepts 32,000 characters and a tool response is bounded by
nothing, so this works or fails depending on how much the endpoint happens to return — execution
05aca859 sent 8,010,000 characters and the run failed. If the report needs fewer rows or columns of the
same shape, add a `transform` step that keeps only the rows and columns the report names, and pass the
transform's output to `input`. If it needs counts, totals, rankings or per-group figures, add a `code`
step whose Python computes those figures and pass its small output to `input` — arithmetic is not the
model's job.
```

⚠ **The second sentence of the remedy was added on 2026-08-20**, when Decision 9 landed after this
section was first written. This block used to name only the `transform`, and §2's message above already
carried *"(or a code step if the report needs totals)"* — so the contract disagreed with itself about
whether the aggregate case had an answer. The failure mode of the shorter version is specific: a model
that has been told only about projection, and needs a total, reaches for a bigger `input` rather than for
a step it has not been told exists. `flow-model-findings.test.ts` asserts both halves of this string.
⚠ It also names **no chunk-and-summarise option**, and that omission is asserted (D-34).

| Rule | Why |
|---|---|
| The remedy is the **positive** form — *add a transform, pass its output* | *"a rule that forbids one of two adjacent errors moves the model to the other"* ([flow-model-findings.ts:108](../../../packages/server/src/services/flow-model-findings.ts#L108)). A prohibition alone pushes the model back into I-119. |
| It names the **32,000** ceiling | The drafter cannot infer the bound from the tool description alone, and the number is the reason the check is decidable for this one parameter. |
| It cites the measured run | Same idiom as `checkPluckedThenJq` and `checkTextToolInput`, both of which quote an execution id. A finding backed by a real failure is one a model and a person both act on. |
| `checkTextToolInput`'s remedy is edited to match | It currently recommends the very form this refuses. Two rules with contradicting remedies is a loop. |
| It names **both** remedies, with the rule for choosing | Decision 9. A projection cannot produce a total, so a model told only about `transform` and asked for a ranking reaches for a bigger `input`. |
| It never offers **chunk-and-summarise** | D-34 — it makes `llm_complete` output load-bearing, and it is ~236 calls for the measured payload. Asserted as a negative, because it is the most plausible-sounding wrong answer. |

### The corridor, as a test

| Fixture | `checkTextToolInput` | `checkBulkToolInput` |
|---|---|---|
| a 204-char sentence, no `tostring` (I-119) | **fires** | silent |
| `results[0].data \| jq('tostring \| @json') \| first` (this run) | silent | **fires** |
| `results[0].data \| jq('map({name, rate}) \| tostring \| @json') \| first` | silent | silent |
| `results[0].data.text \| jq('tostring \| @json') \| first` | silent | silent — `checkPluckedThenJq`'s case |

⚠ Row 3 is the contract. If a future edit makes it fire from either side, the two checks have closed
onto each other and there is no expression a drafter can write.
