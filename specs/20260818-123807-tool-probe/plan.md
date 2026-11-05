# Implementation Plan: "Test this tool" — a probe for an onboarded tool/API

**Branch**: `20260818-123807-tool-probe` | **Date**: 2026-08-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260818-123807-tool-probe/spec.md`

## Summary

Add one button to the tool onboarding form (and the same one to each catalogue row) that dials the
endpoint the person just described and says, in one sentence, what happened — reachable or not,
credential accepted or rejected or missing, status code, elapsed time, a redacted slice of the
response.

The whole design turns on one property: **the probe must dial exactly the way a `tool` step dials, or
a green probe is worse than no probe.** So this feature adds no new HTTP client. It extracts the
credential-resolution and dial code that already exists inside
[`invokeTool`](../../packages/server/src/services/step-execution.service.ts#L340) into a module both
callers import, and the probe service is then a thin thing that chooses a mode, calls that module
once, and maps the outcome to words.

The second design driver is that a tool call is not necessarily safe to make. `GET` is probed live;
`POST`/`PUT`/`PATCH`/`DELETE` default to a **reachability** probe that does not invoke the operation
and says so in those words, with a live invocation one confirmed press away and refused outright for
platform-managed tools.

**Shape of the change**: **18 files** — 8 new, 10 edited — across 1 new service, 1 new route on an
existing router, 1 extracted module (the only edit to `step-execution.service.ts`) and 1 new pure
client module. **No migration and no new npm dependency.**

## Technical Context

**Language/Version**: TypeScript 5, Node ≥ 22, ESM (`"type": "module"`)

**Primary Dependencies**: express, drizzle-orm, zod, `@foundry/shared` (`guardedFetch`, `PERMISSIVE`),
`@foundry/redact` (`redactSecrets`, `redactJsonString`). Client: Next.js app router, existing
`components/ui` set (`Button`, `StatusPill`, `Notice`, `Confirm`, `Field`). **No new dependency** —
the probe is one `guardedFetch` behind existing code.

**Storage**: **none — no table, no column, no migration** (signed off 2026-08-18). The tested marker
lives in a module-level `Map` in the API process; see Decision 8. ⚠ Do not add a migration to this
feature: the current head is `0039_bright_thundra`, and a `0040` appearing here means the sign-off was
walked back without anyone saying so.

**Testing**: `vitest`. New server suites: `tool-probe.service.test.ts`, `routes/tools-probe.test.ts`,
`tool-invoke-single-dial.test.ts` (a grep test in the style of
`mail-secret-single-reader.test.ts`). New client suite: `lib/tool-probe.test.ts`, plus additions to
`app/(app)/tools/page.test.tsx`. One new expectation in `scripts/ui-honesty-check.sh`.

**Target Platform**: Linux server (Foundry API container) + Next.js client.

**Project Type**: Web application (pnpm monorepo: `packages/server`, `packages/client`,
`packages/shared`, `packages/redact`).

**Performance Goals**: one probe = at most two HTTP round trips (the `HEAD`→`GET` fallback, or an
OAuth2 exchange plus the call). Hard 10 s deadline per attempt via `AbortSignal.timeout`.

**Constraints**: no credential value in any request or response body; egress profile identical to
execution (`PERMISSIVE`, D-32 — not widened, not narrowed); **nothing persisted at all**; no manifest
fingerprint may move.

**Scale/Scope**: one endpoint, two modes, six verdicts, one modal panel, one row panel.

## Constitution Check

| Gate | Status |
|---|---|
| **UI honesty** — no UI state a server did not produce | **PASS by construction.** Every field the panel renders comes from the probe response; the client computes no verdict of its own. Pinned by a new `ui-honesty-check.sh` expectation and by the page test asserting rendered text tracks the mocked response. |
| **A control carries a fact or does not exist** (the deleted "Used by" column, `PLATFORM_MANAGED_TOOLS`) | **PASS.** The live control is *absent* for platform-managed tools rather than present-and-refused; the reachability result is never labelled "working". |
| **Secrets are referenced, never returned** | **PASS.** Probe input takes env-var names; probe output carries the credential's *placement* only. `query`-style auth values are redacted out of the echoed URL. |
| **One reader per credential / one dial site** | **PASS, and strengthened.** After the extraction there is exactly one `guardedFetch` for tool HTTP in the server, asserted by a grep test. |
| **No fingerprint moves silently** | **PASS, trivially.** The probe writes nothing to the database at all, so there is nothing a fingerprint could hash. The in-process marker is dropped when a dialled field moves. |
| **Egress control** (FR-008 of the egress port) | **PASS.** Same profile as execution, re-resolved immediately before dialling because that is what `guardedFetch` does. |
| **New outbound capability** | **JUSTIFIED, see Decision 4.** A workspace member could already create a tool and run it; the probe is the same authority with a shorter path, so it is rate-limited and time-bounded. |

## Project Structure

### Documentation (this feature)

```text
specs/20260818-123807-tool-probe/
├── spec.md
├── plan.md              # this file
├── tasks.md
└── contracts/
    └── tool-probe.md    # the endpoint contract, verdict table, redaction rules
```

### Source Code

```text
packages/server/src/
├── services/
│   ├── tool-invoke.ts                      # NEW — the extracted dial: resolveToolCredential + dialTool
│   ├── tool-probe.service.ts               # NEW — mode choice, verdict mapping, redaction of the result
│   ├── tool-probe.service.test.ts          # NEW
│   ├── tool-invoke-single-dial.test.ts     # NEW — grep: one guardedFetch for tool HTTP
│   ├── step-execution.service.ts           # EDIT — applyAuth/secret/oauth2 move out; invokeTool imports them
│   ├── tool.service.ts                     # EDIT (P3 only) — attach `lastProbe` on list; drop it on a dialled-field update
│   └── platform-tool-names.ts              # (read only — `PLATFORM_TOOL_NAMES` / `isPlatformToolName`)
├── routes/
│   ├── tools.ts                            # EDIT — POST /probe
│   └── tools-probe.test.ts                 # NEW — contract, refusals, rate limit
└── (db/schema.ts and drizzle/ are UNTOUCHED — see Decision 8)

packages/client/src/
├── lib/
│   ├── tool-probe.ts                       # NEW — pure: default mode, verdict copy, pre-flight findings
│   ├── tool-probe.test.ts                  # NEW
│   ├── foundry-client.ts                   # EDIT — probeTool()
│   ├── api.ts                              # EDIT — probeTool() adapter (no fallback, no catch-to-mock)
│   └── types.ts                            # EDIT — ToolProbe, ToolProbeMode, ToolProbeVerdict
├── app/(app)/tools/
│   ├── page.tsx                            # EDIT — Test panel in ToolFormModal; Test in the row detail
│   └── page.test.tsx                       # EDIT — mode default, confirm gate, renders server verdict
└── components/ui/                          # (read only — Button, StatusPill, Notice, Confirm, Field)

scripts/ui-honesty-check.sh                 # EDIT — one expectation
```

**Structure Decision**: nothing new at the package level and nothing in `drizzle/`. The probe is a service + a route on the
existing `toolsRouter` (already mounted behind `requireApiKey` at
[app.ts:218](../../packages/server/src/app.ts#L218), so tenancy and auth come free and come from the
same place tool CRUD gets them).

---

## Decisions

### Decision 1 — The probe does not own a `fetch`. The dial is extracted and shared.

`invokeTool` currently holds, inline: the shadowed-secret collision refusal
([:405](../../packages/server/src/services/step-execution.service.ts#L405)), the decrypt
([:424](../../packages/server/src/services/step-execution.service.ts#L424)), the OAuth2 exchange
([:436](../../packages/server/src/services/step-execution.service.ts#L436) →
[`resolveOAuth2Bearer`:223](../../packages/server/src/services/step-execution.service.ts#L223)),
`applyAuth` ([:120](../../packages/server/src/services/step-execution.service.ts#L120)), the
GET-params-vs-JSON-body rule, and the `guardedFetch`
([:490](../../packages/server/src/services/step-execution.service.ts#L490)).

New module `services/tool-invoke.ts` exports:

```ts
/** Everything needed to sign one call, resolved once. Never contains a value the caller may echo. */
export interface ResolvedToolAuth {
  /** The style actually presented — `oauth2_client_credentials` becomes `"bearer"` here, as at execution. */
  style: string | null;
  paramName: string | null;
  /** ⚠ The secret. Present only inside this process, on this call. */
  value: string | undefined;
  /** Where it will land, for reporting: "header:x-api-key" | "query:api_key" | "authorization" | null */
  placement: string | null;
}

export function applyAuth(url: URL, headers: Record<string, string>, style: string | null,
                          paramName: string | null, value: string | undefined): void;

/** Collision refusal (409) + decrypt + OAuth2 exchange (424 on either miss). Throws StepError. */
export async function resolveToolAuth(workspaceId: string, tool: Tool): Promise<ResolvedToolAuth>;

/** One HTTP call, auth applied, egress-guarded. The ONLY tool dial in the server. */
export async function dialTool(args: {
  tool: Tool; auth: ResolvedToolAuth; method: string;
  params: Record<string, unknown>; runId?: string; timeoutMs?: number;
}): Promise<{ status: number; statusText: string; contentType: string | null; text: string; durationMs: number }>;
```

`invokeTool` keeps its batching, its per-item partial-failure rule, its `EMPTY_BATCH` short-circuit
and its "all items failed → 502", and loses only the six blocks above. `StepError` moves nowhere —
`tool-invoke.ts` imports it from `step-execution.service.ts` to avoid a cycle, or both import it from
a tiny `step-error.ts`; **pick the second**, since a service importing an error class from the service
that imports it back is the cycle that will bite the next person.

⚠ **The behaviour of a tool step must not change.** The existing suites are the control here, not
the new ones: `step-execution.test.ts`, `mail-end-to-end.test.ts` and `egress-parity.test.ts` must
pass untouched. If a test needs editing to accommodate the extraction, that is a signal the
extraction changed semantics, not a signal to edit the test.

**Rejected**: a `fetch` in `tool-probe.service.ts`. It is three lines and it is the entire bug class
this feature is meant to remove — a probe that presents auth slightly differently from execution
produces a green result for a tool that 401s in a run, which is precisely the confusion WS-B.4 and the
424 exist to end. A grep test (`tool-invoke-single-dial.test.ts`) pins it: exactly one
`guardedFetch(` under `packages/server/src` reachable from tool code.

### Decision 2 — Two modes, chosen from the method, stated on the button.

```ts
export type ToolProbeMode = "reachability" | "live";
export const defaultModeFor = (method: string): ToolProbeMode =>
  ["GET", "HEAD"].includes(method.toUpperCase()) ? "live" : "reachability";
```

* **live** — `dialTool` with the tool's real method and the sample params (`{}` for a `GET` with no
  values typed). Identical to one item of a `tool` step.
* **reachability** — `dialTool` with method `HEAD`, no params, auth applied. On **405** exactly one
  retry with `GET` (reported as `fellBackToGet: true`), because a great many APIs reject `HEAD`
  wholesale and a 405 on `HEAD` would otherwise read as a failure when it is in fact proof the host
  answered. `invoked: false` on the response, always.

Verdict mapping is in the [contract](./contracts/tool-probe.md) and is the *only* place a status code
becomes a word. The client renders the word; it does not derive one.

**Rejected**: `OPTIONS` (widely unimplemented or 405'd, so the same fallback problem with less
signal); host-classification-only (proves DNS and egress policy, proves nothing about the path,
TLS chain, or credential — three of the five things that actually break); and probing mutating tools
live by default (a Test button that files a ticket on every press is a button people learn not to
press).

### Decision 3 — A draft is probeable; a credential is not sendable.

Request body is a discriminated pair — `{ toolId }` for a saved row, `{ draft }` for what is in the
form right now — because "know before you save" is the actual request. The draft is validated by the
**same** rules `createToolSchema` enforces (share the `superRefine`, do not restate it: the client
already mirrors it once in `lib/tool-edit.ts`'s `authFindings`, and a third copy would be the one
that drifts). A draft that could not be *created* cannot be *probed*.

The draft carries `secretEnvName` / `clientIdSecretRef` / `clientSecretSecretRef` — **names**. There
is no field for a value, and adding one is refused: a probe authenticated by a value the workspace
does not hold produces a green result no later run can reproduce, and it would put a plaintext
credential in a request body on a route that logs request ids. The consequence is an ordering the UI
must state rather than hide: **store the credential, then test.** The modal already has that path —
`CurlPastePanel` calls `createSecret` ([tools/page.tsx:924](../../packages/client/src/app/(app)/tools/page.tsx#L924)).

**Rejected**: the datasource pattern (create the row first, then test it by id —
[data-sources/new/page.tsx:199](../../packages/client/src/app/(app)/data-sources/new/page.tsx#L199)).
It is the right shape *there* because a datasource must exist to be read-privilege-checked at
registration, and a failed test leaves a visible, fixable row. Here it would leave a junk `tools` row
per failed attempt in a catalogue the drafter reads as its prompt — the drafter would see, and be
willing to compose, tools nobody finished onboarding.

### Decision 4 — The route is a bounded, rate-limited dialer, on the same profile as execution.

* **Profile**: `PERMISSIVE`, byte-identical to execution's choice and for the same reason (D-32:
  this deployment's registered tools live on private docker addresses; `STRICT` would reject every
  real tool). Link-local — the cloud-metadata SSRF vector — stays denied because `PERMISSIVE` denies
  it. **The probe does not get its own profile.** A test path with looser network rules than the
  execution path is a test path that lies.
* **Authority**: `requireApiKey` + workspace-scoped router. A member who can call this could already
  `POST /tools` and run a flow, so no new authority is granted — but the shorter path deserves two
  bounds:
  * **Rate limit**: in-memory, per workspace, **20 probes / minute**, `429` with `retryAfterSec`. In
    memory rather than in Postgres deliberately: this bounds abuse of a process, and losing the
    counter on restart is not a security property anyone is relying on (same reasoning as
    `request-policy.service.ts`'s proposal map).
  * **Deadline**: `AbortSignal.timeout(10_000)` per attempt, reported as verdict `timeout`.
* **Redirects**: left at `fetch`'s default (follow), because that is what execution does; `res.url` is
  reported when it differs from the requested URL, so a probe that succeeded *somewhere else* says so.

⚠ **Recorded, not fixed**: execution's `guardedFetch` has no timeout at all
([step-execution.service.ts:490](../../packages/server/src/services/step-execution.service.ts#L490)) —
a hung tool hangs a step. The probe adding one is not a divergence in *dialling* (same client, same
profile, same auth), but it is a divergence, and the honest resolution is a follow-up that gives
execution a deadline too. Out of scope here.

### Decision 5 — An upstream "no" is a successful probe.

HTTP 200 with `{ probe: { verdict: "auth_rejected", status: 401, … } }`. Non-200 is reserved for
Foundry's own inability to attempt, reusing the statuses execution already speaks so that the two
surfaces cannot disagree about what a number means:

| Status | Meaning | Source |
|---|---|---|
| 400 | draft invalid | shared `createToolSchema` rules |
| 404 | `toolId` not in this workspace | `toolRepo.get` |
| 409 | shadowed credential collision | `shadowedSecretCollisions` |
| 424 | declared credential has no stored value / OAuth2 refs missing | `resolveToolAuth` |
| 429 | probe rate limit | this route |
| 200 | the probe ran — read `verdict` | — |

Collapsing 401 into a 4xx of our own would recreate exactly the ambiguity `applyAuth`'s 424 was built
to remove, one layer up.

### Decision 6 — Nothing that leaves the endpoint can carry a credential.

* **URL**: echoed as a *rendered string*, and when `authStyle === "query"` the auth parameter's value
  is replaced with `[redacted]` before rendering. (This is why the response carries `urlShown` and not
  the URL it dialled.)
* **Auth**: `authPresented: { style, placement }` — e.g. `{ style: "header", placement: "x-api-key" }`.
  Placement, never value. Nothing anywhere returns the value; there is deliberately no endpoint in
  this product that returns a secret.
* **Response headers**: not echoed at all. `www-authenticate`, `set-cookie` and vendor debug headers
  can carry tokens, and there is no key-name rule that catches all of them. Only `status`,
  `statusText` and `content-type` cross the boundary.
* **Body**: JSON → `redactJsonString`; anything else → raw text, and **because key-name redaction
  cannot see inside non-JSON text**, that path is truncated harder (512 chars vs 2048) and the panel
  says the body was not JSON so redaction did not apply. Both carry `truncated: boolean`.
* **Logs**: the probe writes no log line containing the URL's query string.

### Decision 7 — Platform-managed tools get reachability only.

`PLATFORM_MANAGED_TOOLS` (the CLIENT's mirror) already exists client-side
([tools/page.tsx:321](../../packages/client/src/app/(app)/tools/page.tsx#L321)) mirroring the server's
`platform-tool-names.ts` — whose real exports are **`PLATFORM_TOOL_NAMES`** and
**`isPlatformToolName(name)`**, not the client's spelling; use the server's names on the server. The
server refuses `mode: "live"` for those names with 409
`platform_managed_live_probe`; the client hides the control, following the rule that page already
states — a button the API will always refuse reads as a broken page, not as a rule.

⚠ **Since 2026-08-18 this refusal is reachable in EVERY workspace, which it was not when it was written.**
`db/seed-platform-tools.ts` now runs from `migrate.ts`, so `foundry_email_send` is registered everywhere
rather than only in workspaces created after the feature — measured before that change, HR, Finance and the
alt rehearsal workspace all carried **zero** rows for it. A refusal that used to fire almost nowhere now
fires on a row every workspace has.

⚠ **And the share of the catalogue that must not be probed live went UP the same week.** The legal demo
domain (2026-08-19) adds `ticket_create` (POST), `ticket_update` (PATCH), `chat_post_message` (POST) and
`mail_send` (POST). Note the distinction the refusal list gets right: `mail_send` is the **simulated**
ops-api tool that writes a row to `mail_outbox`, so a live probe of it is harmless and is correctly
offered; only `foundry_email_send` delivers real mail and is refused.

Two independent reasons, and the second matters more: a live probe of `foundry_email_send` would
deliver a real email; and it would fail anyway, because that tool points at Foundry's own
`/api/mail/send`, which resolves its recipient from the `x-foundry-run` header a probe has no run to
supply. A green/red result there would be a statement about the probe, not about the tool.

### Decision 8 — A tested marker in the process, NOT a column. (Signed off: no migration.)

Review's answer was *"for now just add a tested marker, no new migration should be done"*, so
persistence is out and **nothing in this feature touches the schema** (FR-010).

The marker is a module-level `Map` in `tool-probe.service.ts`, keyed `(workspaceId, toolId)`:

```ts
interface ToolProbeMark { at: string; verdict: ToolProbeVerdict; mode: ToolProbeMode; status: number | null }
```

* **Written** only for a probe of a **saved** tool. A draft has no id, so a draft probe marks nothing —
  which is correct: the row it would describe does not exist yet.
* **Read** by `toolService.list`, which attaches `lastProbe` to each tool exactly the way it already
  attaches `usedBy` — one place, so the catalogue and the row detail cannot disagree.
* **Dropped** by `toolService.update` when the payload moves a dialled field (`url`, `method`,
  `authStyle`, `authParamName`, `secretEnvName`, `tokenUrl`, either client ref) and by
  `toolService.remove`. Same rule the persisted version would have needed, and cheaper here.
* **Bounded**: entries are tiny and there is one per tool per workspace, so no eviction policy — the
  same reasoning `oauth2TokenCache` states for its own unbounded map in `step-execution.service.ts`.

⚠ **What this costs, stated rather than discovered later.** The marker dies with the process and is
per-container on a multi-instance deployment, so a tool tested through container A reads as untested
through container B. That is acceptable **only because absence renders as absence**: no marker means no
claim, and the UI shows nothing rather than an "unknown" badge. The failure direction is a missing
fact, never a false one — which is the property a `last_probe_status` column could not have offered,
since a stale green tick in the database outlives the URL that earned it.

⚠ **This is not a step toward a column.** If someone later wants durable probe history, that is a
feature with its own honesty questions (age display, invalidation, multi-instance writes), not a
migration bolted onto this map. Do not "upgrade" it quietly.

### Decision 9 — `step-payload-bounds` lands FIRST, and `dialTool` must not lose the byte count

`specs/20260819-045902-step-payload-bounds` T16 adds a per-item response size and two step-level warnings
**inside `invokeTool`** — the same function Decision 1 takes the dial out of. Both plans carry the identical
"these four suites must pass unedited" gate on the same files, so whichever lands second looks like it
broke the first.

**That feature goes first.** It is a live production incident (a 413 on a real run, execution
`05aca859-…`); this one is a new button nobody is waiting on. Two consequences for the work here:

1. **`dialTool`'s return must carry the raw response `text` and its UTF-8 byte length**, so `invokeTool`
   keeps computing `StepItemResult.bytes` after the extraction. T02 already returns `text`; the byte length
   is added rather than recomputed by two callers, since two computations of one number is how they come to
   disagree.
2. **The probe response gains `body.bytes`**, for the same reason and from the same source. A person testing
   a tool that returns 7 MB should see the size in the panel, not discover it in a failed run — which is the
   cross-link `step-payload-bounds` Decision 8 already makes to this feature.

⚠ If the order is reversed for any reason, T02/T03 must re-apply that feature's warnings to the slimmer
`invokeTool` **in the same commit** as the extraction. Do not leave it to be noticed by a test.

### Decision 10 — P4: the probe is where a tool's RESPONSE SHAPE becomes knowable. Recorded, not planned.

The gap, stated plainly: **Foundry knows a datasource's shape and knows nothing about a tool's response
shape.** A datasource is introspected at registration into `schemas` (entities, columns, types). The `tools`
table has `url`, `method`, `description`, `params_schema` and the auth fields — `params_schema` describes
what goes **in**, and there is no column anywhere for what comes **out**.

That absence is upstream of three separate incidents already on record:

* the 413 — the drafter wrote `json(outputs.fetch.body).results[0].data` and passed it whole because it had
  **no way to know** that was 4,722 rows × 50 columns;
* the drafter prompt teaches that blind envelope access as its canonical example, because there is nothing
  better to teach;
* **I-119** — *"a flow fed the model a description of the data instead of the data"* — the same blindness
  from the other side.

⚠ **And it cannot be closed by forensics.** The one-off fix for `05aca859-…` is to read the field names out
of the stored 8.4 MB execution record (still there — retention is 30 days). That works once, for an API that
has already broken a run. It is not a technique: **no onboarded tool should have to fail an execution before
Foundry knows its shape.**

The probe is the one moment in the product where a real response from that endpoint exists **at onboarding
time, before any flow is drafted against it**. Hence P4 — and four constraints that are the reason it is a
separate phase rather than a field bolted onto P1:

1. **Shape, never values.** Key paths, types, array lengths, total bytes. A captured sample carries tenant
   rows — names, salaries — and storing them would quietly create a copy of tenant data in Foundry's
   database. `redactSecrets` does not help: the problem is not credential-shaped keys, it is the rows.
2. **A sample is not a schema and must never render as one.** One call, one moment, one set of parameters.
   A different period changes the cardinality; a different tenant changes the keys. It carries "observed
   once, at T" or it becomes the unverified-claim-as-fact pattern this product keeps removing.
3. **It needs storage, which reopens a signed-off decision.** Decision 8 committed to no schema change and
   ends with *"this is not a step toward a column"*. A response shape is durable data with retention and
   redaction questions. **This is the feature that note pointed at** — it does not get to arrive as a
   migration inside P4 without its own sign-off.
4. **If the shape ever reaches the DRAFTER, the fingerprint must be measured first.** Putting it in a tool's
   manifest entry is exactly I-40's change: rendering more of `params_schema` moved the manifest's own hash
   (correct — a new version) and **zero** ref fingerprints (measured across all workspaces). Get that wrong
   and the staleness sweep unarms every armed flow everywhere, on a later poll tick, invisibly.

**P4 is therefore blocked on the storage decision in constraint 3**, and is listed in `tasks.md` with no
task numbers for exactly that reason. P1–P3 do not depend on it.

---

## Phasing

**P1 — the button, honestly (no schema change).**
Extract `tool-invoke.ts`; add `tool-probe.service.ts` + `POST /probe`; reachability and live-for-GET;
the Test panel in `ToolFormModal`; `lib/tool-probe.ts` + copy; server and client tests; the
`ui-honesty-check.sh` expectation. Shippable alone: it already answers "does this URL + credential
work?" for every GET tool and "is this host reachable and does it know this path?" for every other.

**P2 — live invocation of a mutating tool.**
Sample-params form in the panel, `Confirm` naming method + host, platform-managed refusal both sides,
`invoked: true` reporting. Shippable alone.

**P3 — the tested marker (still no schema).**
The in-process map, `lastProbe` attached by `toolService.list`, the row-detail line with age and mode,
the drop-on-dialled-field-edit rule, and the tests for both. Shippable alone; nothing in P1 or P2
depends on it.

## Risks

| Risk | Handling |
|---|---|
| The extraction changes tool-step behaviour | Existing suites are the control and must pass **unedited**; `egress-parity.test.ts` and `mail-end-to-end.test.ts` cover the two most sensitive paths. A test that needs changing means the extraction is wrong. |
| A person reads "reachable" as "working" | The word "working" appears nowhere in the reachability copy; `invoked: false` renders as its own sentence naming the un-sent method. Pinned by a client test asserting the copy for a `POST` draft. |
| The probe becomes an internal scanner | 20/min/workspace, 10 s deadline, `PERMISSIVE` (link-local denied), and the same workspace-scoped API key as tool CRUD. No new authority. |
| A credential leaks through a response body | Four rules in Decision 6, tested in `tool-probe.service.test.ts` — including the `query`-auth URL redaction, which is the one a reviewer is most likely to miss. |
| The tested marker misleads | Age + mode always rendered, dropped on any dialled-field edit, and **absent** rather than "unknown" when the process has no record — so a restart or a second container costs a missing fact, never a false one. |
| `HEAD`→`GET` fallback double-charges a metered API | Only on a 405, only one retry, and only in reachability mode; reported as `fellBackToGet` so the two calls are visible rather than inferred. |
