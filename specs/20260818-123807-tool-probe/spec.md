# Feature Specification: "Test this tool" — a probe for an onboarded tool/API

**Feature Branch**: `20260818-123807-tool-probe` (current branch is
`20260819-080932-legal-contract-demo-domain` — repoint `.specify/feature.json` before implementing)

⚠ **Sequencing, 2026-08-19**: `specs/20260819-045902-step-payload-bounds` edits the same `invokeTool` this
feature extracts, and it is a live production incident (a 413 on a real run). **It goes first**; this
feature then rebases onto the extracted dial. See plan Decision 9.

**Created**: 2026-08-18

**Status**: Planned — the three open decisions were signed off 2026-08-18 (see Clarifications)

**Input**: User description: "in the tools onboarding tab add a button to test whether the
onboarded tool/api is working or not"

**Clarifications taken at review** (2026-08-18):

| Question | Answer |
|---|---|
| Is `HEAD`-then-`GET`-on-405 the right reachability check for a mutating tool? | **Yes.** `OPTIONS` and host-classification-only are both rejected — see plan Decision 2. |
| Is a route that dials a URL straight from the form acceptable? | **Yes** — "before saving the tools, testing it from the form itself is fine". Bounded per plan Decision 4 (same egress profile as execution, 20/min/workspace, 10 s deadline, draft validated by the create rules). |
| Should the last outcome be remembered, at the cost of a migration? | **No migration.** *"For now just add a tested marker."* The marker is **in-process and unpersisted** — plan Decision 8, rewritten. |

---

## Why this is not "already done"

Onboarding a tool today is **write-only**. `ToolFormModal`
([tools/page.tsx:549](../../packages/client/src/app/(app)/tools/page.tsx#L549)) collects a URL, a
method, parameters and one of five auth styles, POSTs it, and the row appears in the catalogue. At no
point does anything dial the endpoint. The first time a registered tool is actually called is inside
a flow run, which is the worst possible place to discover:

* the URL has a typo, or the host is unreachable from this deployment's network;
* the credential name points at a `workspace_secrets` row that has no value — `applyAuth` throws
  **424** ([step-execution.service.ts:120](../../packages/server/src/services/step-execution.service.ts#L120));
* the credential *is* stored but is wrong, or is presented in the wrong place (`X-API-Key` where the
  vendor wants `Authorization: Bearer`) — the upstream answers **401**, and WS-B.4's whole reason for
  existing is that those two are different problems that used to look identical;
* two things in the workspace declare the same env name with different values — `shadowedSecretCollisions`
  refuses with **409** ([step-execution.service.ts:405](../../packages/server/src/services/step-execution.service.ts#L405));
* the `oauth2_client_credentials` token exchange fails against `tokenUrl`;
* the host resolves to something the egress profile denies (`egress_rejected`).

Every one of those is knowable in under a second at onboarding time, and every one of them currently
surfaces as a failed flow run — after a person has drafted a flow, read it, approved it, and pressed
test run. Data sources already close exactly this gap: `POST /workspaces/:ws/datasources/:id/test`
([datasources.ts:67](../../packages/server/src/routes/datasources.ts#L67)) plus a **Test connection**
button that gates the wizard's footer primary
([data-sources/new/page.tsx:199](../../packages/client/src/app/(app)/data-sources/new/page.tsx#L199)).
Tools have no equivalent. This feature is that equivalent, plus the one thing the datasource case
never had to answer: **a tool call can change someone else's data.**

---

## The constraint that shapes the whole feature

A data source test is a read-only probe by construction. A tool test is not. Roughly half the tools
a workspace onboards are `POST`/`PATCH`/`DELETE` — "create a ticket", "post a message", "send the
mail". Pressing a **Test** button on one of those and having it silently do the thing is how a
feature meant to build confidence becomes a feature people are afraid of, and `foundry_email_send`
makes it concrete: a live probe of that row would put a real message in a real mailbox
([platform-tool-catalogue.ts:60](../../packages/server/src/services/platform-tool-catalogue.ts#L60)).

So the probe has **two modes, and the button says which one it is**:

| Mode | What it does | Default for |
|---|---|---|
| **Reachability** | Resolves + egress-classifies the host, then sends `HEAD` (falling back to `GET` on a 405) with the declared auth applied and no parameters. The tool's own operation is **not invoked**. | `POST`, `PUT`, `PATCH`, `DELETE` |
| **Live** | Invokes the tool exactly as a flow step would — real method, real body from sample values the person types. | `GET`, `HEAD` |

Live mode on a mutating verb is reachable in one extra press, behind a confirmation that names the
method and host. It is **refused outright** for platform-managed tools.

⚠ The wording of a reachability result is load-bearing and is specified, not left to the
implementer: *"Reached `api.example.com` — it answered 405. The endpoint exists; your `POST` was not
sent, so this does not prove the call succeeds."* A reachability result rendered as a green
"Working" tick would be a lie of exactly the kind [`ui-honesty-check.sh`](../../scripts/ui-honesty-check.sh)
exists to prevent.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Somebody onboarding a GET tool learns it works before saving (Priority: P1)

A person pastes a curl command for `GET https://api.example.com/v1/tickets`, picks **API key** →
header `X-API-Key`, selects the stored credential `TICKETING_TOKEN`, and presses **Test this tool**
inside the Add-tool modal. Within a second the panel says *"200 OK in 340 ms — the endpoint answered
and accepted the credential"*, with the first lines of the (redacted) response body. They press
**Add tool** knowing the row they just created can actually be called.

**Why this priority**: this is the requested capability in one sentence, and the case with no side
effects to reason about.

**Independent Test**: in a workspace with `TICKETING_TOKEN` stored, open the modal, fill the fields,
press the button, and assert the panel renders the server's `status`, `durationMs` and verdict — and
that `createTool` has **not** been called (testing does not save).

**Acceptance Scenarios**:

1. **Given** a draft with a valid https URL, `GET`, and a credential the workspace holds, **When**
   the button is pressed, **Then** the endpoint is called once with the credential in the declared
   position and the result names the status code and elapsed time.
2. **Given** the same draft, **When** the probe returns, **Then** nothing has been written to
   `tools` — the draft is still a draft, and the modal's own Save is still the only way to store it.
3. **Given** a probe that returns 200, **When** the response body is rendered, **Then** it is
   redacted by key name and truncated, and the panel says it was truncated.

---

### User Story 2 — A wrong credential reads as a wrong credential (Priority: P1)

The same person mistypes the header name (`X-Api-Token` instead of `X-API-Key`). The probe reports
*"Reached the endpoint; it answered **401 Unauthorized**. Foundry presented `TICKETING_TOKEN` as
header `X-Api-Token`. The credential was sent — the endpoint rejected it, so the value or its
position is wrong."* They fix the header name and press the button again.

A second person selects a credential name the workspace has never stored a value for. The probe does
**not** dial at all: *"`TICKETING_TOKEN` has no value in this workspace, so there is nothing to
present. Store it under Credentials, then test again."* (**424**, the same refusal `applyAuth` makes
at run time, in the place where it can be fixed.)

**Why this priority**: WS-B.4 and the `secrets/audit` 424 exist *because* "not configured" and
"rejected" used to be indistinguishable. A probe that collapsed them would re-create the bug it is
meant to retire.

**Acceptance Scenarios**:

1. **Given** a declared credential with no stored value, **When** the probe runs, **Then** no HTTP
   request leaves the process and the result names the missing env var and the fix.
2. **Given** a stored credential the endpoint rejects, **When** the probe runs, **Then** the result
   reports the upstream status and **where** the credential was presented — never its value.
3. **Given** two workspace entries declaring the same env name with different values, **When** the
   probe runs, **Then** it refuses with the collision (**409**) and names both owners, matching
   `shadowedSecretCollisions`.
4. **Given** an `oauth2_client_credentials` tool whose `tokenUrl` refuses the exchange, **When** the
   probe runs, **Then** the result says the token exchange failed and distinguishes that from the
   tool endpoint's own answer.

---

### User Story 3 — A mutating tool can be checked without doing the thing (Priority: P1)

Somebody onboards `POST https://api.example.com/v1/tickets`. The Test panel's button reads **Check
reachability**, with one line under it: *"Your `POST` will not be sent."* Pressing it reports
*"Reached `api.example.com` — 405 Method Not Allowed to `HEAD`. The host answered and knows this
path; the `POST` itself was not attempted."* A second control, **Send a real request**, is present
but not primary; pressing it opens a confirmation naming the method and host, and a small form for
the parameter values to send. Only after confirming does a ticket get created.

**Why this priority**: without this, the button is either useless for half the catalogue or
dangerous for it.

**Acceptance Scenarios**:

1. **Given** a `POST` tool, **When** the default test runs, **Then** `invoked: false` comes back and
   the UI never uses the word "working".
2. **Given** a `POST` tool, **When** **Send a real request** is pressed, **Then** a confirmation
   naming the method and host is shown first, and cancelling it sends nothing.
3. **Given** a confirmed live probe, **When** it runs, **Then** the request body is exactly the
   sample values typed — and those values are not persisted anywhere.
4. **Given** `foundry_email_send`, **When** the panel renders, **Then** the live control is absent
   and one line says Foundry manages this tool and will not send a test message.

---

### User Story 4 — An already-onboarded tool can be re-tested from the catalogue (Priority: P2)

A flow failed last night with a 401 on `create_ticket`. The person opens Tools, expands the row, and
presses **Test** in the row's detail panel — the same probe, against the stored row. The result
appears in the row, and the tool carries a **tested marker** with its age, so "was this ever checked,
and when?" is answerable without opening a flow.

⚠ The marker is **remembered in the API process, not in the database** (signed off 2026-08-18: no
migration). What that costs, stated rather than hidden: it is forgotten on restart, and on a
multi-instance deployment a tool tested through one container reads as untested through another. That
is the acceptable direction of failure — a **missing** marker claims nothing, whereas a persisted
marker outliving the URL it was earned against would claim something false.

**Acceptance Scenarios**:

1. **Given** a saved tool, **When** the row's Test is pressed, **Then** the same endpoint and modes
   apply as in the modal, addressed by `toolId` rather than by a draft.
2. **Given** a tool tested in this process, **When** the row renders the marker, **Then** it is shown
   **with its age and mode** ("tested · reachable · 4 min ago · endpoint not invoked"), never as a
   bare live-health badge and never in a table column.
3. **Given** a tool never tested (or tested before a restart), **When** the row renders, **Then**
   there is **no marker at all** — an absence, not an "unknown" badge, because absence is the one
   thing the process can honestly say.
4. **Given** a tested marker, **When** the tool's URL, method or auth is edited, **Then** the marker
   is dropped — a green result must never outlive the request shape it was earned against.

---

## Requirements *(mandatory)*

### Functional

* **FR-001** The probe MUST dial through the same credential resolution and the same
  `guardedFetch` + egress profile as a `tool` step. A probe that dialled its own way could pass while
  execution fails, which is worse than having no probe.
* **FR-002** The probe MUST work on an **unsaved draft** as well as a saved `toolId`. Testing before
  saving is the requested capability; a create-then-test flow would leave a half-onboarded row behind
  every failed attempt.
* **FR-003** The probe MUST accept credentials **by name only**. No request body may carry a
  credential value, and a name with no stored value MUST be refused (424) rather than dialled
  anonymously.
* **FR-004** Default mode MUST be derived from the method: live for `GET`/`HEAD`, reachability for
  every mutating verb. The control's label MUST state which one it will do.
* **FR-005** A live probe of a mutating tool MUST require an explicit confirmation that names the
  method and the host.
* **FR-006** A live probe MUST be refused for platform-managed tools (currently
  `foundry_email_send`), and the UI MUST NOT offer the control for them.
* **FR-007** No response the probe returns may contain a credential: the rendered URL MUST redact a
  `query`-style auth parameter's value, response headers MUST NOT be echoed, and a JSON body MUST
  pass through `redactSecrets`/`redactJsonString` before it leaves the server.
* **FR-008** An upstream answer — 401, 404, 500 — MUST be reported as a **successful probe** (HTTP
  200 with a verdict). Only Foundry's own inability to attempt (unconfigured 424, collision 409,
  invalid draft 400, unknown tool 404, rate limit 429) MUST be a non-200.
* **FR-009** The probe MUST bound itself in time (≤ 10 s) and MUST be rate-limited per workspace, so
  the endpoint cannot be used as a port scanner or a hang.
* **FR-010** The probe MUST write **nothing to the database** — no new table, no new column, no
  migration. No request bodies, no response bodies, no sample values, no `api_call_log` of its own.
* **FR-011** Nothing about a probe may change a tool's manifest fingerprint or arm/unarm a flow. A
  test is a read of the world, not an edit of the catalogue.
* **FR-012** The tested marker MUST live in the API process only, MUST be rendered with its age and
  mode or not at all, and MUST be dropped when any dialled field changes — `url`, `method`,
  `authStyle`, `authParamName`, `secretEnvName`, `tokenUrl`, or either client ref.

### Key entities

* **Tool probe (transient)** — mode, verdict, `invoked`, method, redacted URL, auth placement,
  status, `durationMs`, content type, truncated redacted body preview, one-sentence message, optional
  remedy. Exists only in a response body.
* **Tested marker (in-process, unpersisted)** — `{ at, verdict, mode, status }` per
  `(workspaceId, toolId)`, held in a module-level `Map` in the API process and attached to each tool
  by `toolService.list` the way `usedBy` already is. Bounded, forgotten on restart, and read as
  absent when unknown. No schema, by decision.

---

## Refusals this feature is defined by

1. **No probe with a typed-in credential value.** You store the credential, then you test. A probe
   authenticated by a value the workspace does not hold proves something no later run can reproduce.
2. **No live probe of a mutating tool without a confirmation.**
3. **No live probe of a platform-managed tool at all.**
4. **No widening of the egress profile.** The probe uses `PERMISSIVE` because that is what execution
   uses (D-32); it does not get its own, looser, profile "for testing".
5. **No green tick for a reachability result.** `invoked: false` renders as its own word, never as
   "Working".
6. **No probe result outliving the request shape it was earned against** — the marker is dropped when
   a dialled field is edited, and it is never rendered without its age.
7. **No database write of any kind, including a migration.** The tested marker is worth having; it is
   not worth a column that can go stale where nobody can see it.

---

## Non-goals

* Scheduled or background health checks, an uptime column, or anything that dials without a person
  pressing a button.
* A probe history or timeline. One in-process marker per tool, with its age, is the whole of the
  memory — and it is deliberately forgotten on restart.
* Response-shape validation, schema inference, or auto-filling `paramsSchema` from a probe.
* Any change to how a `tool` step behaves at run time. (One observed gap is recorded rather than
  fixed here: execution's `guardedFetch` has **no timeout**. The probe adds one for itself; changing
  execution is a separate change with its own blast radius.)
* Probing datasources — that exists.

---

## Decisions taken at review (2026-08-18)

All three open questions are closed; nothing in this spec is awaiting an answer.

1. **Reachability semantics — confirmed.** `HEAD` against the tool's exact URL with auth applied and
   no params, retried once with `GET` on a 405. `OPTIONS` and host-classification-only are rejected
   for the reasons in plan Decision 2.
2. **Probing from the form — confirmed.** Testing a draft before saving is the point of the feature.
   The route stays pinned to execution's egress profile, rate-limited at 20/min/workspace, and
   deadlined at 10 s (plan Decision 4).
3. **Persistence — refused; a tested marker instead.** No migration, no column. The outcome is held
   in the API process per `(workspaceId, toolId)` and rendered only with its age and mode, or not at
   all (plan Decision 8, FR-010, FR-012). The known cost — forgotten on restart, per-container on a
   multi-instance deployment — is accepted because a missing marker makes no claim.
