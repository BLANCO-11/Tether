# Tasks: "Test this tool" — a probe for an onboarded tool/API

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Contract**: [contracts/tool-probe.md](./contracts/tool-probe.md)

Ordered so each phase ends somewhere shippable. `pnpm typecheck && pnpm test` after every phase;
`./scripts/ui-honesty-check.sh` after T13 and T14. ⚠ **Node 22 or the client render layer silently does
not run** — `vitest.config.ts` throws below it, and that throw is the reason the throw exists.

⚠ **This feature adds NO migration** (signed off 2026-08-18). Nothing here touches `db/schema.ts` or
`drizzle/`.

⚠ **Before starting — two things, 2026-08-19.**
1. **`specs/20260819-045902-step-payload-bounds` goes first.** Its T16 edits the same `invokeTool` that T02
   and T03 take apart, and it is a live production incident. Land it, then start here; T02 carries the byte
   count forward (plan Decision 9). If the order is reversed, re-apply its warnings to the slimmer
   `invokeTool` **in the same commit** as the extraction.
2. **Repoint `.specify/feature.json`** at this directory — it currently names
   `specs/20260819-080932-legal-contract-demo-domain`, and the speckit skills read it.

---

## P1 — the button, honestly (no schema change)

### T01 ✅ DONE · Extract the dial — `packages/server/src/services/step-error.ts`
Move `StepError` out of `step-execution.service.ts` into its own module and re-export it from
`step-execution.service.ts` so every existing importer is untouched. ⚠ Do this **first**: it is what
keeps `tool-invoke.ts` from importing the service that imports it.

### T02 ✅ DONE · New `packages/server/src/services/tool-invoke.ts`
Move, unchanged in behaviour: `applyAuth`, the OAuth2 token cache + `resolveOAuth2Bearer`, the
collision refusal, the decrypt, the GET-params-vs-JSON-body rule, and the `guardedFetch` call. Export
`applyAuth`, `resolveToolAuth`, `dialTool` per plan Decision 1. `dialTool` takes `timeoutMs?` and
applies `AbortSignal.timeout` only when given one — **execution passes nothing, so execution's
behaviour does not change.**

⚠ **`dialTool` returns the response `text` AND its UTF-8 byte length** (plan Decision 9). By the time this
lands, `step-payload-bounds` T16 will be computing `StepItemResult.bytes` inside `invokeTool` from that same
text — one computation, returned once, rather than two callers each measuring the same string and eventually
disagreeing. The probe reports it as `body.bytes`.

### T03 ✅ DONE · Rewrite `invokeTool` in `step-execution.service.ts` to call T02
Keeps: `EMPTY_BATCH`, per-item results, the partial-failure warning, the all-failed 502, the
`x-foundry-run` header. Loses: the six extracted blocks.
⚠ **Gate**: `step-execution.test.ts`, `mail-end-to-end.test.ts`, `egress-parity.test.ts`,
`tool-auth-schema.test.ts` must pass **unedited**. Editing one of them means T02/T03 changed
semantics — fix the code, not the test.

### T04 ✅ DONE · New `packages/server/src/services/tool-invoke-single-dial.test.ts`
Grep test in the style of `mail-secret-single-reader.test.ts`: exactly one occurrence of
`guardedFetch(` in tool-call code under `packages/server/src`, and it is in `tool-invoke.ts`;
`tool-probe.service.ts` contains neither `fetch(` nor `guardedFetch(`.

### T05 ✅ DONE · New `packages/server/src/services/tool-probe.service.ts`
`probe(workspaceId, input)`:
1. resolve subject — `toolId` via `toolRepo.get` (404) or `draft` via the shared `createToolSchema`
   cross-field rules (400 + `findings`);
2. rate limit (20/min/workspace, in-process map → 429 `retryAfterSec`);
3. refuse `mode: "live"` for a platform tool — `isPlatformToolName(name)` from
   `services/platform-tool-names.ts` (409). ⚠ The server's exports are **`PLATFORM_TOOL_NAMES`** /
   **`isPlatformToolName`**; `PLATFORM_MANAGED_TOOLS` is the client's mirror and does not exist here;
4. `resolveToolAuth` (409/424 pass straight through as `StepError`);
5. mode → method: live = tool method + `sampleParams`; reachability = `HEAD`, no params, one `GET`
   retry on 405 (`fellBackToGet`);
6. `dialTool({ timeoutMs: 10_000 })`, catching `egress_rejected` / abort / network into verdicts;
7. build the response per the contract: verdict map, one-sentence `message` naming host + status,
   `remedy` only when there is a specific action, `urlShown` with a `query`-auth value redacted,
   `authPresented` = style + placement, body via `redactJsonString` (JSON, 2048) or raw truncation
   (non-JSON, 512, `redacted: false`), **no response headers echoed**.

### T06 ✅ DONE · New `packages/server/src/services/tool-probe.service.test.ts`
Covers: verdict map incl. `reachable` on 4xx/5xx in reachability mode; `invoked: false` on every
reachability path; the 405→GET fallback happening exactly once; **`query`-auth value redacted out of
`urlShown`**; JSON body redacted, non-JSON body truncated and flagged `redacted: false`; no header
echoed; 424 for a declared-but-unstored credential with no HTTP call made; 409 collision verbatim;
timeout → `timeout` verdict; `egress_rejected` → `egress_refused` quoting the classification.

### T07 ✅ DONE · `packages/server/src/routes/tools.ts` — `POST /probe`
Zod-parse the discriminated body, call the service, `res.json({ probe })`. Map `StepError.status`
through the same `asyncHandler`/error middleware path the other tool routes use. ⚠ Route order: place
it before `/:toolId` handlers so `probe` is never read as a tool id.

### T08 ✅ DONE · New `packages/server/src/routes/tools-probe.test.ts`
Contract-level: 200 shape; 400 with `findings` for an invalid draft; 404 for a foreign `toolId`; 409
for a live probe of `foundry_email_send`; 429 after the 21st probe in a minute; and **a 401 from the
stubbed endpoint arriving as HTTP 200 with `verdict: "auth_rejected"`**.

### T09 ✅ DONE · `packages/client/src/lib/types.ts`
`ToolProbeMode`, `ToolProbeVerdict`, `ToolProbe`, `ToolProbeDraft` — mirroring the contract exactly.

### T10 ✅ DONE · `packages/client/src/lib/foundry-client.ts`
`probeTool(wsId, body)` beside the other tool calls (~[:1494](../../packages/client/src/lib/foundry-client.ts#L1494)),
typed to `{ probe: ToolProbe }`.

### T11 ✅ DONE · `packages/client/src/lib/api.ts`
`probeTool(input): Promise<ToolProbe>` resolving the workspace the same way `createTool` does
([:120](../../packages/client/src/lib/api.ts#L120)). ⚠ **No `catch`, no fallback, no default probe
object** — a failed probe surfaces as a thrown error the panel renders. That is the `faFallback` rule.

### T12 ✅ DONE · New `packages/client/src/lib/tool-probe.ts` + `tool-probe.test.ts`
Pure, no React: `defaultModeFor(method)`; `probeCopy(probe)` → `{ tone, title, detail }` derived from
server fields only; `preflightFindings(draft, secrets)` → the things worth saying before dialling
("endpoint must start with http(s)", "`X` has no stored value — store it under Credentials, then
test"), reusing `authFindings`/`hasStoredValue` from `lib/tool-edit.ts` rather than re-deriving;
`isLiveProbeOffered(name, method)`. Same rationale as `tool-edit.ts` and `policy-copy.ts` — the copy
is testable and the page holds no rules.

### T13 ✅ DONE · `packages/client/src/app/(app)/tools/page.tsx` — the Test panel
In `ToolFormModal` ([:549](../../packages/client/src/app/(app)/tools/page.tsx#L549)), after the
credential block and before the footer, a bordered panel mirroring
`data-sources/new`'s section 3 ([:458](../../packages/client/src/app/(app)/data-sources/new/page.tsx#L458)):
* primary `Button` labelled from the mode — **Test this tool** (live) / **Check reachability**
  (mutating), disabled while probing or while `preflightFindings` block it, with the findings rendered
  beside it;
* on return, a `StatusPill` with the server's verdict word plus the server's `message`; status,
  `durationMs`, the method actually sent, and the auth placement as a small detail line; the body
  preview in a `<pre>` with the truncation/redaction note;
* one line under a reachability button: *"Your `POST` will not be sent."*
* ⚠ Testing must not save: `createTool`/`updateTool` are untouched by this path, and the panel's state
  is local to the modal.

### T14 ✅ DONE · `scripts/ui-honesty-check.sh` — one expectation
Assert `tools/page.tsx` renders probe state only from the API response: no literal "Working" string,
and no assignment of a verdict/tone in the page that is not read off the probe object. Same shape as
the existing `usedBy` pin.

### T15 ✅ DONE · `packages/client/src/app/(app)/tools/page.test.tsx` — additions
Mock `probeTool` in the existing whole-module `vi.mock` (⚠ an omitted export comes back `undefined`
and crashes every test in the file — the trap that file's header already documents). Cover: the
button's label follows the method; a `GET` draft probes live; a `POST` draft's copy names the un-sent
method and never says "working"; the rendered text tracks the mocked response; pressing Test does not
call `createTool`.

---

## P2 — live invocation of a mutating tool

### T16 ✅ DONE · Sample-params form in the Test panel
Inputs generated from the draft's `params` (names + types are already in form state). Values are
local, sent once, never stored. Empty is allowed — some endpoints need nothing.

Landed as `sampleParamsToSend` in `lib/tool-probe.ts` (the page decides nothing, as with every other
rule in this panel) plus a `sampleValues` state map in `ToolFormModal`, keyed by parameter name and
**deliberately not part of `payload`**. Three properties beyond the task's wording, each with its own
test: blank sends **no key** (`{"since":""}` is a different request from `{}`); values are coerced by
the declared `dataType` (a JSON body is where `5` and `"5"` stop being the same value); and a value
that cannot be its type **blocks** the press instead of being dropped — dialling without what somebody
typed and then reporting the endpoint's complaint would be a red verdict Foundry manufactured. A
*required* parameter left blank is reported and does not block.

### T17 ✅ DONE · The confirmation
`Confirm` (danger) naming the method and host: *"This sends a real `POST` to `api.example.com`. If
this endpoint creates or changes data, it will."* Cancelling sends nothing. Same gate shape as the
existing unarm confirmation in this modal.

⚠ **Reached by a second button, not a mode toggle.** A mutating tool shows `Check reachability` *and* a
`danger` `Send a real POST`, and the second one's label IS the consequence. A sticky toggle would be
Decision 2's rejected option with one extra step: after the first live press it stays live, and the
next press looks identical to a reachability check. The sentence is `liveConfirmBody(...)` — method,
host, parameter **keys** (never a value: a confirmation gets screenshotted into tickets) — and it
promises nothing about what the endpoint will do, which `tool-probe.test.ts` asserts.

### T18 ✅ DONE (in P1) · Platform-managed refusal, both sides
Server 409 `platform_managed_live_probe` via `isPlatformToolName` (T05 step 3), plus hiding the control
client-side for `PLATFORM_MANAGED_TOOLS` ([:321](../../packages/client/src/app/(app)/tools/page.tsx#L321))
with one line saying why — Foundry manages this tool and will not send a test message.

⚠ **Verification subjects, now that there are three demo domains.** `ticket_search` (GET) is a safe live
probe; `ticket_create` (POST) must default to reachability; `foundry_email_send` must offer no live control
at all. ⚠ **`mail_send` is NOT one of them** — it is the *simulated* ops-api tool that writes a
`mail_outbox` row, so a live probe of it is harmless and is correctly offered. Only `foundry_email_send`
delivers real mail.

### T19 ✅ DONE · Tests
Server: live mode sends the tool's method and the sample params, and `invoked: true`. Client: the
confirm gates the call; cancelling calls nothing; the live control is absent for
`foundry_email_send`.

Server +2 (a live `GET`'s params land in the **query string**, as `dialTool` does it for a run; and a
`POST`'s body params are **not** printed as a query string — see the defect note below). Client +21 in
`tool-probe.test.ts`, +12 in `page.test.tsx`. Eight perturbations turned red and were restored.

⚠ **Two defects found here, both outside this task list.** (1) `urlShown` merged `params` into the URL
for every method, so a live `POST`'s panel would print `…?title=probe` for a request that carried them
in the body — latent until T16 gave the UI any way to supply sample params. (2) `Modal` hardcoded
`aria-labelledby="modal-title"`, so with a `Confirm` open over a form modal the id existed twice and a
screen reader announced *"This sends a real POST"* under the title **Add tool**; now `useId()` per
instance, which touches every modal in the client. Both have controls and perturbations; see
`specs/20260819-045902-step-payload-bounds/SESSION-NOTES.md`.

---

## P3 — the tested marker (no schema; signed off 2026-08-18)

### T20 ✅ DONE · The in-process marker — **`tool-probe-mark.ts`, not `tool-probe.service.ts`**
Module-level `Map<string, ToolProbeMark>` keyed `` `${workspaceId}:${toolId}` ``, holding
`{ at, verdict, mode, status }`. Written **only** after a probe of a saved tool — a draft probe marks
nothing, because the row it would describe does not exist. Export `markFor(workspaceId, toolId)`,
`dropMark(workspaceId, toolId)`. ⚠ **No migration, no column, no table** — if a `drizzle/0040_*.sql`
appears in this branch, the sign-off was walked back without anyone saying so. *(Migration head is still
`0039_bright_thundra`.)*

⚠ **The marker had to move to its own module, and T21's premise below is wrong.** Holding it in
`tool-probe.service.ts` is a **cycle**: that service imports `createToolSchema` from `tool.service.ts`
(Decision 3 — a draft that could not be created cannot be probed), so `tool.service.ts` importing the
marker back closed the loop. `draftSchema` evaluated to `undefined` and **every draft probe answered
`500 internal_error`** — while the service's own 43 unit tests stayed green, because they import the
service directly and the loop never forms. `routes/tools-probe.test.ts`, which drives real HTTP through
the real app, is what caught it. Same extraction, same reason, as `step-error.ts` in T01.

`setMark` is called from **the one place a `ToolProbe` is constructed** rather than at each `return` —
there are five (ok, the 405 retry, timeout, egress refusal, network failure), and a marker written at
the happy one only would read as "never tested" for exactly the tools worth looking at. A refusal that
never dialled (409, 424) marks nothing: those are statements about the configuration, not measurements
of the endpoint.

### T21 ✅ DONE · Attach on list, drop on edit — `tool.service.ts`
`list()` attaches `lastProbe` to each tool the way it already attaches `usedBy`, so the row detail and
any later surface read one source. `update()` calls `dropMark` when the payload moves a dialled field
(`url`, `method`, `authStyle`, `authParamName`, `secretEnvName`, `tokenUrl`, `clientIdSecretRef`,
`clientSecretSecretRef`); `remove()` drops it unconditionally.
⚠ ~~Import direction: `tool.service.ts` reads the marker from `tool-probe.service.ts`, and
`tool-probe.service.ts` already reads tools through `toolRepo` — not through `tool.service.ts` — so
there is no cycle. Keep it that way.~~ **Wrong, and it ships as a 500 — see T20.** True of the tool
ROWS, false of the schema. The marker lives in `tool-probe-mark.ts`, which imports neither side.

⚠ **"Moves a dialled field" is decided by comparing the row BEFORE the write to the row AFTER it**, not
by inspecting the PATCH body. Two reasons, and the second is the load-bearing one: a body that re-sends
`method: "GET"` on a tool already `GET` has moved nothing (dropping there would make "tested" vanish
when somebody fixed a typo in a description); and `update` derives the OAuth2 trio from the STYLE rather
than from the payload, so a switch away from `oauth2` clears `tokenUrl` and both refs without the body
ever naming them — a dial that genuinely moved and that a body check would miss. `paramsSchema` is
deliberately NOT a dialled field: a probe's verdict is about the endpoint and the credential, and a
live probe's sample values are typed into the panel for one press and never stored.

⚠ `existing` is now read UNCONDITIONALLY, where it used to be read only on the non-platform path — a
platform update is precisely the one that repoints a URL (`mail:register`), so exempting it would leave
the stalest mark of all.

### T22 ✅ DONE · Render it with its age
In the row's expanded detail ([`toolRow`:324](../../packages/client/src/app/(app)/tools/page.tsx#L324)),
one line — `tested · reachable · 4 min ago · endpoint not invoked` — plus a **Test** button that runs
the same probe against `toolId`. ⚠ **No marker ⇒ render nothing.** Not "unknown", not a grey pill: the
process genuinely has no record after a restart or on another container, and absence is the only honest
rendering of that. And never a table column — a column of mostly-absent health words is the deleted
"Used by" mistake with a tick on it.

Landed as `markLine` + `agoWords` in `lib/tool-probe.ts` (the row derives no words), rendered in the
expanded detail beside a **Test** / **Check reachability** button that probes `toolId` in
`defaultModeFor(the STORED method)`. Three rules beyond the task's wording:

* **the age is computed on the CLIENT**, from an ISO instant — a server-rendered *"4 min ago"* is wrong
  by however long the response sat in a queue and never ages while the page is open. One `Date.now()`
  for the whole render, because twelve rows each calling it can straddle a minute boundary;
* **`probeMarkFromWire` refuses a verdict word this build does not know**, answering `null` — otherwise
  a newer server's eleventh verdict reaches `TITLE[…]` and renders the literal `undefined` in a pill on
  every affected row. Its verdict list is `Object.keys(TONE)`, not a second literal;
* **no live escalation from a row.** A stored `POST` gets reachability only: the live confirmation names
  the sample parameters it is about to send, and a row has none to name.

### T23 ✅ DONE · Tests
Server: a probe of a saved tool marks it and `list` returns it; a draft probe marks nothing; an edit
that moves a dialled field drops it while a description-only edit does not; `remove` drops it.
Client: the line renders age + mode from the API field; a tool with no `lastProbe` renders nothing at
all (assert the absence, with a control that the line appears when the field is present — otherwise the
test passes over an empty set).

Server: 11 new in `tool-probe-mark.test.ts` (against a **real database** — `update`'s whole job here is
the before/after comparison, and a mocked repo would assert my own arithmetic) + 6 in
`tool-probe.service.test.ts`, including *"marks nothing when the probe was refused before anything was
dialled"* and a guard that the marker's two unions have not drifted from the service's. Client: 15 in
`tool-probe.test.ts`, 6 render tests. **Seven perturbations** turned red and were restored, including
the two controls that matter — dropping on every update turns *"KEEPS it across a description-only
edit"* red, and rendering *"never tested"* for an absent marker turns the absence test red.

---

## P4 — a tool's response SHAPE, captured at onboarding (BLOCKED — no task numbers on purpose)

Plan Decision 10. **Do not start this as part of P1–P3.** It is listed here so the gap is not rediscovered
as an omission, and it carries no task numbers because it is blocked on a decision nobody has taken.

**The gap**: Foundry introspects a datasource's shape at registration and stores it; it knows **nothing**
about a tool's response shape — `params_schema` describes what goes in, and no column anywhere describes
what comes out. That absence is upstream of the 413 (the drafter passed `results[0].data` whole because it
could not know it was 4,722 × 50), of the prompt teaching that blind access, and of I-119.

**Why the probe is the right place**: it is the one moment a real response from that endpoint exists, at
onboarding time, before any flow is drafted against it.

**Why it is not P1**: reading the shape out of a stored execution record works once, for an API that has
already broken a run — it is forensics, not a technique. Doing it properly needs four things settled first:

1. **Shape, never values** — key paths, types, array lengths, byte size. A sample carries tenant rows;
   storing them would create a copy of tenant data in Foundry's database, and `redactSecrets` does not help
   because the problem is the rows, not credential-shaped keys.
2. **A sample is not a schema** — it renders as "observed once, at T", or it becomes an unverified claim
   presented as fact.
3. **It needs storage, and that reopens the no-migration sign-off** (Decision 8's closing note points
   exactly here). Requires its own sign-off; it does not arrive as a migration inside this phase.
4. **If the shape reaches the drafter, measure the fingerprint first** — I-40's exact change. Rendering more
   of a tool's manifest entry moved the manifest hash (correct) and **zero** ref fingerprints (measured). Get
   it wrong and the staleness sweep unarms every armed flow, invisibly, on a later tick.

**Blocking question**: does the probe persist anything at all? P1–P3 answer "no". P4 cannot be built until
that answer changes deliberately.
