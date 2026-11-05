# Implementation decisions — Kestra migration

Decisions taken **during implementation** that refine, deviate from, or resolve something the pinned
design left open. Numbered `D-nn`, append-only.

The design docs 01–10 are **pinned and not edited by implementation work** ([README](../README.md):
"Amend, don't rewrite" applies to design changes agreed with the user — this file is for the smaller
calls made while building). If a decision here contradicts a pinned doc, say so explicitly and name
the section.

---

## D-01 — Kestra pinned to `v1.3.29`, full image (not `-no-plugins`)

> ### ⚠ SUPERSEDED — see **D-01 AMENDED** below. The full image would not stay up (I-05).
> Kept as written because the reasoning is still the right reasoning; only the outcome was wrong.

| | |
| :--- | :--- |
| **Phase** | 0 |
| **Refines** | [09 §O1](../09-risks-and-verification.md) ("pin an exact Kestra version") |

`v1.3.29` is what both `latest` and `latest-lts` resolved to on 2026-07-28. It is pinned to the patch
version, not `v1.3`, per O1.

**Full image over `-no-plugins`** (3.2 GB vs 229 MB). Phase 1 needs only
`io.kestra.plugin.core.http.Request`, which ships in the core and is present in both. But Phase 4
needs `io.kestra.plugin.scripts.python.Script` and
`io.kestra.plugin.scripts.runner.docker.Docker`, which are **not** core. Taking `-no-plugins` would
mean installing that plugin separately and therefore pinning a *second* version — a plugin version
that can drift from the engine version. One pin is the point of O1.

Revisit if image size becomes an operational problem; the tradeoff is one pin vs ~3 GB.

---

## D-02 — Progress tracking is per phase, not per design doc

| | |
| :--- | :--- |
| **Phase** | 0 |

The request was a tracking file "for each migration file". Design docs 01–10 are organised by
**topic**; the work is organised by **phase** ([08 §10](../08-scale-and-phasing.md)), and phases are
what can be started, finished, and resumed. A per-doc file would have no natural completion state —
`02-rules.md` is never "done", it is a constraint on everything.

Each phase file names the design sections it implements, so a `§` reference resolves in both
directions.

---

## D-03 — `tenant_budgets` is keyed by **workspace**; the per-tenant ceiling is deferred

| | |
| :--- | :--- |
| **Phase** | 0 |
| **Refines** | [07 §7.4](../07-refactor-inventory.md) vs [03 §5.0](../03-architecture.md) |

The two design docs ask for slightly different things and it is worth naming the gap rather than
silently picking one:

- [07 §7.4](../07-refactor-inventory.md) specifies `tenant_budgets` with columns
  `workspace_id`, `max_concurrent_executions`, `max_agent_runs_per_day`.
- [03 §5.0](../03-architecture.md) says budgets need **two levels** — per workspace (shares one
  credential, so shares its rate limit) *and* a per-tenant ceiling (the commercial contract is with
  the tenant).

**Built: workspace-keyed only**, per §7.4. The per-tenant ceiling needs a `tenants` table, and this
schema has none — `workspaces` carries a `tether_tenant_id` but that is the Tether *secret-injection*
boundary, a different scope (which is exactly why `tenant-mapper.service.ts` exists). Inventing a
tenant table in Phase 0 to satisfy a ceiling nothing enforces yet is the wrong order.

**Consequence to remember:** with one workspace per tenant these coincide, so the gap is invisible
today and will surface the first time one tenant owns two workspaces — each gets a full budget and
the tenant's effective ceiling silently doubles. Add the tenant level before that, not after.

The table name stays `tenant_budgets` to match §7.4 and the `M3` references throughout the docs.

---

## D-04 — An unconfigured workspace gets **finite** defaults, not unlimited

| | |
| :--- | :--- |
| **Phase** | 0 |
| **Refines** | [08 §M3](../08-scale-and-phasing.md) |

`tenant_budgets` has no row for any existing workspace, so `resolve()` has to decide what an absent
row means. Three candidates:

| Option | Rejected because |
| :--- | :--- |
| **Unlimited** | Makes M3 opt-in. The workspace that starves the shared instance is precisely the one nobody configured — an opt-in runaway guard protects nobody. |
| **Deny** | Fails closed on a *fairness* control, not an authz control. Every existing workspace would stop being able to run flows the moment the table lands, for no security gain. |
| **Finite config defaults** ✅ | 5 concurrent executions, 50 agent runs/day, token metering off (`null`). Overridable per workspace and per deployment. |

Related: `budgetSchema` requires **positive** integers, so a budget cannot be set to `0` and silently
refuse every execution. Clearing the row is how you return to defaults. And `maxTokensPerDay: null`
means *not metered*, deliberately distinct from `0`, which would refuse everything.

---

## D-01 AMENDED — use `v1.3.29-no-plugins`, and pin the scripts plugin separately in Phase 4

D-01 chose the **full** image so there would be one version to pin rather than two. The reasoning was
sound; the outcome was wrong. The full image registers **1404 plugins from 201 groups** and the
engine would not stay up — 2.6 GiB and 199% CPU with zero flows, then `OutOfMemoryError`. See
[ISSUES.md](ISSUES.md) I-05 for the measurements.

`v1.3.29-no-plugins` runs the same workload at **417–487 MiB and ~2% CPU**.

**Consequence to carry into Phase 4:** `io.kestra.plugin.scripts.python.Script` and
`io.kestra.plugin.scripts.runner.docker.Docker` are **not** in the core set, so `code` steps will need
that plugin installed and pinned explicitly. That is the second pin D-01 tried to avoid. Accepted:
one extra pin is cheaper than an engine that does not run, and pinning it deliberately is closer to
O1's intent than inheriting 1403 plugins we never audited.

---

## D-05 — `flow_step_runs` stores pointers only; the pinned design contradicts itself here

| | |
| :--- | :--- |
| **Phase** | 1 |
| **Resolves** | [08 §10](../08-scale-and-phasing.md) vs [07 §7.4](../07-refactor-inventory.md) + assertion 26 |

Two pinned statements cannot both hold:

- Phase 1's exit criterion: *"`flow_step_runs` holds per-step I/O."*
- §7.4: *"**Do not store** status, timing, inputs or outputs"*, and assertion 26 asserts exactly that.

**§7.4 wins**, because it agrees with **R6** (one system of record per concept), and R6 is a rule
while an exit criterion is a checkpoint. Duplicating status into Foundry would diverge the first time
Kestra retries a task.

The exit criterion is read as **"per-step I/O is RETRIEVABLE via the pointer"** — which it is:
`flow_step_runs.kestra_taskrun_id` joins to the taskrun, and `GET /executions/{id}` returns each
task's `outputs`, state history and timing. Verified in the Phase 1 run.

---

## D-06 — Execution tokens are single-use per EXECUTION, not per request

| | |
| :--- | :--- |
| **Phase** | 1 |
| **Refines** | [07 §7.4](../07-refactor-inventory.md) ("`execution_tokens` … single use") |

Read literally, single-use is unimplementable: **one token authenticates every step callback of an
execution**, so burning it on first use would 401 step 2. The Phase 1 flow makes seven calls with one
token.

So: minted once by `POST /api/executions/begin`, burned when the execution completes. `consumedAt`
marks the whole execution's token set, not an individual request. Expiry still bounds a leaked token
independently (default 6h).

**Assertion 7** ("tokens are single-use and expire") should be tested against this reading: a token
is rejected *after its execution completes*, not after its first use.

---

## D-07 — `begin`'s response body is persisted in Kestra, so the step-graph UI must redact it

| | |
| :--- | :--- |
| **Phase** | 1, binding on Phase 2 |

Kestra persists task outputs in its execution context, which is in its database. The `begin` task's
output is an `http.Request` body — and that body contains the **execution token**.

This does not violate R2: R2 forbids a *tenant credential* in Kestra, and an execution-scoped,
short-TTL token that grants nothing outside its own execution is precisely the substitute R3
prescribes. The design already anticipates Kestra persisting what it is given.

It *does* create a Phase 2 obligation. `StepDetail.tsx` renders `taskrun.outputs` — so rendering the
`begin` step naively would print a live bearer token into a client-facing UI.

**Required in Phase 2:** the adapter redacts the `begin` step's response body. Do not rely on the
token having expired; a UI opened during a long execution shows a valid one.

---
## D-08 — the three scenarios are reconstructed by SHAPE, not recovered

| | |
| :--- | :--- |
| **Phase** | 1 |
| **Forced by** | [ISSUES.md](ISSUES.md) I-08 — `PRODUCTION_DRY_RUN.md` is unrecoverable |

The original three prompts are gone. Reconstructing three plausible prompts would have produced
three variations on one shape — the screening query with different filters — which would score 3 of 3
while proving almost nothing: a shared bug would pass all three.

So they are chosen to be **structurally different**, each aimed at a specific measured failure mode:

| | Shape | Aimed at | The trap in the dataset |
| :--- | :--- | :--- | :--- |
| **A** screening | fan-**out**, N rows → N emails | fabricated dates; missing `COALESCE` | #14 at 80.95%, ENG bar 85 |
| **B** escalation | fan-**in**, N rows → M tickets | invented joins; N→N when the answer is N→M | 11 flagged → **10** tickets; manager 2 owns two |
| **C** roll-up | **aggregate**, all rows → one message | divide-by-zero; dropping the empty group | Legal has nobody: `null`, not `0`, and not absent |

The dataset was built for exactly these — the roster comments name "manager escalation" and the empty
department names "division-by-zero / empty-result handling". B is also the only scenario that
exercises `ticket_create`, the workspace's **one authenticated tool**, and therefore the server-side
`applyAuth()` path.

**Scored three ways**, because a flow that grades its own homework is the failure this replaces:

1. against an oracle written independently of the flow (`expectedEscalation`, `expectedRollup` —
   separate functions in a separate file, following the `hr_demo_alt` rule that a shared oracle lets a
   shared bug agree with itself);
2. against the `stub_*` side-effect tables, which the flow does not write to directly;
3. at **three periods** (`2026-04/05/06`), which is what caught I-09 and I-10.

**The honesty constraint.** "3 of 3 versus 1 of 3" is not like-for-like — different prompts. See I-08;
do not quote the two numbers together without it.

---

## D-09 — `foundry.system` is a namespace with no tenant segment, and that is the security property

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.3) |
| **Refines** | [03 §5.0](../03-architecture.md) namespace layout |

Foundry needs operational flows of its own — retention today, more later. They could have gone in a
tenant namespace, or in Kestra's default one.

`<prefix>.system` is chosen because it is **two segments, not three**, and
`resolveWorkspaceFromNamespace` requires three. A system flow therefore cannot resolve to a workspace,
so `POST /api/executions/begin` refuses it and it can never obtain an execution token — on the same
instance, through the same API, holding the same callback secret. It needs no tenant credential, so
under R2 it must not be able to get one, and the namespace shape is what enforces that rather than a
check someone has to remember.

Two consequences:

- `namespaceFor()` now **rejects `system` as a tenant slug**. Without that, a tenant slugged `system`
  would deploy into `foundry.system.<ws>`, which has three segments and resolves — placing tenant
  flows inside the operational tree.
- The guarantee is a property of the namespace *shape*, so a change to `KESTRA_NAMESPACE_PREFIX` or to
  the parser could break it silently. `pnpm kestra:verify` asserts the 403 rather than trusting it.

**R8 is not violated.** R8's three-task-type allowlist constrains what the **compiler** emits for a
tenant. `retention.flow.yml` is Foundry-authored infrastructure deployed by `pnpm kestra:system`,
never by a compiler and never by a client, and it uses purge tasks no tenant flow may use.

---

## D-10 — retention is 30 days, and that number is also the replay window

| | |
| :--- | :--- |
| **Phase** | 1 (task 1.3) |
| **Implements** | [09 §O4](../09-risks-and-verification.md) |

Kestra OSS has no declarative `kestra.retention.*`; purging is a task you schedule. That is arguably
better — the policy is visible, versioned and auditable like everything else.

`PurgeExecutions` (executions + logs + metrics + storage) plus `PurgeStorage` and `PurgeLogs` for what
outlives an execution record, nightly at 03:00, **30 days**, all overridable via
`KESTRA_RETENTION_DAYS` / `KESTRA_PURGE_CRON`.

**`states` is restricted to the terminal ones.** `RUNNING`, `PAUSED` and `QUEUED` are excluded
deliberately: a human-approval `Pause` (§6.4) can legitimately sit for days, and purging it destroys a
live execution.

**The tension to know about: 30 days is also the replay window.** Phase 6 is replay, and replaying an
execution needs its inputs and outputs to still exist. Shortening retention on a disk-constrained host
shortens replay by the same amount. That trade is not visible from either feature alone.

**Verified to DELETE, not merely to run.** The first manual run reported
`{executionsCount: 0, logsCount: 0}` and SUCCESS — nothing was 30 days old. A purge job that matches
nothing while reporting success is the same shape as the script that emailed 0 of 11 and reported
`tests_passed=true`. `pnpm kestra:verify` now creates three throwaway executions and purges them with
`endDate = now` scoped to that flow: measured `3 → 0`.

---

## D-11 — host-run Kestra scripts read their env from the running server container

| | |
| :--- | :--- |
| **Phase** | 1 |

The Kestra credentials are declared in `infra/docker-compose.yml` under the server service, not in the
repo-root `.env`. A script run on the host therefore got none of them, and
`config.kestra.callbackSecret` read as empty — at which point `begin` refuses everything and the
failure looks like a broken boundary rather than a missing variable.

Rejected: copying the values into `.env`. Two copies of a shared secret disagree eventually, and the
disagreement presents as a 401 from the wrong layer.

`scripts/kestra-env.sh` reads `KESTRA_*` out of the **running server container**, so whatever the
server actually has is what the script uses, by construction. `KESTRA_BASE_URL` is the deliberate
exception — inside the container it is `http://kestra:8080`, which the host cannot resolve, and Kestra
publishes no ports (I-03), so the host reaches it at the container IP, resolved fresh each run.

---
## D-12 — the step graph ships as `/runs/[id]`, not as a rebuilt automation page

| | |
| :--- | :--- |
| **Phase** | 2 |
| **Defers** | phase-2.md task 2.5 |

2.5 says to rebuild `app/(app)/automations/[id]/page.tsx` around the step graph. Right destination,
wrong time:

- A step graph belongs to an **execution**, not to an automation. The automation page would host one,
  but the component's natural home is a run.
- That page is built on `scripts`, `script_versions` and `execution_results` — all deleted in Phase 4.
  Rebuilding it now means writing against a model that is going away, which the CLAUDE.md rule *"do
  not invest in code that is being deleted"* exists to prevent.
- There is no `flows` table yet. Phase 3 creates it. An automation page rebuilt before then would have
  to invent the model it renders.

So the graph shipped as `app/(app)/runs/[id]`, reachable from History. It is finished and in use now,
and 2.5 becomes *"embed `<StepGraph/>`"* once `flows` exists — a smaller task than it started as.

**The 2.0 correction is the bigger note.** phase-2.md lists only client tasks, but the assembly cannot
live in the client: R5 keeps Kestra off any client-reachable network, and D-07 requires the execution
token to be stripped before the payload leaves the server — redacting in a browser would be theatre,
the token having already crossed the wire. `services/flow-visibility.service.ts` and
`routes/flow-executions.ts` are that work. `adapters.ts` remains the seam 2.3 describes; it maps a
Foundry response instead of a Kestra one.

---

## D-13 — every UI decision reads `engineStatus`, never Foundry's `status`

| | |
| :--- | :--- |
| **Phase** | 2 |
| **Follows from** | [ISSUES.md](ISSUES.md) I-10 |

Two status fields exist and they legitimately disagree. Foundry's `flow_executions.status` is written
by the flow's own `complete` **task**, so a failed execution never reaches it and the row stays
`running` for ever. Kestra's state is always current.

So: `runFromFlowExecution`, the poller in `/runs/[id]`, and the status pill all read `engineStatus`.
Reading Foundry's field would render a failed run as still going and would leave the poller running
until the tab closed.

The corollary is that Foundry's `status` is a **cache**, and this is where it is refreshed:
`flowVisibilityService.get()` has just asked Kestra for the state, so it closes a stale `running` row
in the same request. The I-10 budget leak now heals the moment anyone *looks* at a run, instead of at
the moment `begin` refuses the next one. Kestra's status is copied, never inferred (R6).

**Do not "simplify" this by picking one field.** Deleting `engineStatus` loses correctness; deleting
`status` loses the M3 budget's cheap local count, which would then need a Kestra round trip per row.

---

## D-14 — `Run.outcome` gains a third value, and success rate divides by settled runs

| | |
| :--- | :--- |
| **Phase** | 2 (task 2.6) |
| **Refines** | [08 §10 "Phase 2"](../08-scale-and-phasing.md) — "repoint `lib/stats.ts`" |

`Run.outcome` was `"done" | "stopped"`. Everything not finished was therefore reported as **stopped**:
the dashboard counted in-flight runs as failures, the 14-day trend drew them as red bars, "needs a
person" announced `N of M runs stopped` including them, and History offered **Fix & retry** on a run
that was still working.

It was invisible for a reason worth recording: every flow in Phase 1 finishes in about a second, so a
list is almost never rendered mid-run. Phase 4 changes that permanently — an `agent` step decodes for
5–6 minutes (CLAUDE.md, measured) and a human approval `Pause` can sit for days, so at any moment
several runs are live.

The fix is a third value plus one rule: **rates divide by SETTLED runs, never by all of them**
(`stats.settled()`). Counting a live run in the denominator makes the rate sag while work happens and
recover when it finishes, which reads as an incident that resolved itself. The trend chart gained a
third segment for the same reason — painting a live run as either finished or stopped states
something untrue.

The same defect existed on the script path (`runFromExecution`) and was fixed there too, even though
Phase 4 deletes it: both backends land in **one** History list and **one** set of aggregates until
then, so leaving it would have kept the wrong number on the page.

---

## D-15 — the progress socket is authorised by a single-use ticket, not by an execution id

| | |
| :--- | :--- |
| **Phase** | 2 (task 2.8) |
| **Implements** | [08 §10 "Phase 2"](../08-scale-and-phasing.md) — `ws/progress-server.ts` |
| **Upholds** | R5 · [D-07](#d-07--redaction-is-server-side) |

phase-2.md 2.8 says "per-step progress from Kestra polling" and does not say how the channel is
authorised. It matters more than it looks, because of how this app authenticates:

**the browser never holds `PARENT_API_KEY`.** It calls a same-origin Next route
(`app/api/foundry/[...path]/route.ts`) which injects the key server-side. A WebSocket cannot go
through that proxy. So a socket taking `?executionId=` would have been the **only unauthenticated read
path in the product**, carrying exactly the data the API-key-gated REST route carries.

Rejected alternatives: the key as a query param (URLs are logged, and it is the *parent* key — total
compromise, not scoped); the key as a `Sec-WebSocket-Protocol` value (obscures rather than scopes);
leaving it open because the ids are UUIDs (that is not an authorisation).

So watching is a handshake. `POST …/flow-executions/:id/watch` is API-key authenticated and calls the
**same `flowVisibilityService.get()`** that serves the REST view — so it 404s for another workspace
before minting anything. The ticket is 256 CSPRNG bits, single-use, 60s, bound to one
(workspace, execution). A captured socket URL is worthless the moment the page has used it.

**Tickets live in memory on purpose.** The socket is served by this process, so a ticket can only ever
be valid in this process. A table would advertise a durability the socket cannot honour and would
accumulate a row per page view.

Two further properties the tests pin (`flow-progress.service.test.ts`, 11 tests):

- **One poll per execution, not per viewer.** Three engineers on the same broken run cost what one
  costs. A late subscriber is sent the last snapshot immediately rather than joining a diff stream
  that has already said everything it is going to say.
- **A step is sent when it CHANGES.** The fingerprint includes the error and the response code, not
  just the status — Kestra sets `FAILED` before the error log is queryable, and fingerprinting on
  status alone would leave a red step with no reason, which is precisely what the exit criterion
  needs.

**Polling is kept as the fallback**, chosen per connection: the socket needs `:4001` reachable from
the browser and `FOUNDRY_WS_URL` set, and where it is not, `/runs/[id]` polls the REST endpoint as
before. Both paths read the **same** server-side assembly, so no view is reachable through one and not
the other.

---

## D-16 — the flow compiler lands in Phase 3, not Phase 5, and only half of it

| | |
| :--- | :--- |
| **Phase** | 3 |
| **Deviates from** | [08 §10](../08-scale-and-phasing.md), which schedules `flow-compiler.service.ts` with Phase 5 |

Phase 5 is deferred for a good reason — *"there are currently zero flows in existence; building a
flow editor plus untrusted-input hardening before knowing what flows look like is backwards."* That
argument is about **authoring**. The emitter is a different thing and Phase 3 cannot proceed without
it:

- A **Kestra Schedule trigger is part of the flow definition**, not a separate API object. §5.4's
  "approval deploys the trigger, revocation removes it" therefore means the live and draft YAML are
  the same model compiled twice — once with a `triggers:` block, once without. With one stored YAML
  blob per revision the only way to do that is string surgery on YAML, which is exactly the ad-hoc
  emission R8 forbids.
- **Approval binds to a revision**, so promoting one has to deploy *that revision's* content.

So the split is: **the emitter is Phase 3, the untrusted-input machinery is still Phase 5.**
`flow-validator.service.ts`, the bounded redraft loop and the caps are not built.

**The boundary, stated so it is not crossed by accident.** `paramsExpr` and `transform.expr` are
**opaque strings emitted verbatim** into a JSON body. That is safe while every model is written by a
Foundry engineer (which is what 08 §Phase 5 prescribes for the first ~10 flows) and it is **not safe
for client-authored models** — an expression can read any prior step's output. Before any route
accepts a model from a client, those two fields must become a structured expression tree, or
`flow-validator` must constrain them. There is no route that does this today: `POST /flows` is behind
`PARENT_API_KEY`.

What does NOT depend on that boundary, because it is structural rather than a check:

| | |
| :--- | :--- |
| Task types are chosen by the compiler from a fixed set | no model can name a Kestra task type |
| Every URI is `{{ vars.foundry }}<path>` | no model can name a host, so the one-host egress allowlist holds |
| Free text is re-indented into a block scalar | ending a block requires *dedenting*; nothing can emit less indent than it is given |

The third is why there is no "does the expression contain `type:`" check — that check would be the
weaker version of a thing re-indentation already makes impossible. A test drives a
`scripts.python.Script` task through `expr` and asserts it comes out as text.

**Falsified, not asserted.** `pnpm --filter @foundry/server kestra:phase3` compiles Phase 1's
screening flow from a MODEL (`kestra/hr-screening.model.ts`), runs it, and scores it against
`expectedScreening` — the same oracle the hand-written YAML beat. A compiler that emits deployable
YAML computing the wrong answer would pass every other assertion in the phase.

---

## D-17 — the staleness sweep runs on the poll loop, so `begin` re-checks the fingerprint

| | |
| :--- | :--- |
| **Phase** | 3 |
| **Resolves** | [08 §10](../08-scale-and-phasing.md) "Scheduler checks approval validity + staleness each tick" vs [03 §5.4](../03-architecture.md) |

Two pinned statements are in tension. §5.4 moves schedule firing to Kestra; 08 §10 says the
**scheduler** checks approval validity and staleness each tick. After §5.4 there is no scheduler tick
per flow — Kestra fires, and Foundry finds out at `begin`.

**Built: the sweep runs on the surviving poll loop** in `trigger-scheduler.ts` (every third 20s tick),
and `begin` independently re-checks the fingerprint before handing over a token.

The difference this makes, stated because it is a real behavioural change rather than a refactor:

| | Design as written | As built |
| :--- | :--- | :--- |
| When divergence is noticed | before the next firing | within a tick (≤60s) |
| What stops the run in between | the check | **`begin` refuses, so the execution fails at step 1** |

So a schedule *can* fire against a changed manifest — and the execution dies immediately with
`not_approved` and nothing downstream having run. That is the same outcome the design wanted, reached
one step later and visibly, rather than the schedule silently not firing.

Two rules that fell out of building it:

- **`begin` must not suspend.** It is on the execution path; a Kestra redeploy inside a callback whose
  failure mode is a retry puts a control-plane write behind a retry storm. It refuses; the sweep
  suspends.
- **Suspend Kestra first, mark stale second.** If removing the trigger fails, the approval is left
  open deliberately — reporting a suspended schedule that is in fact still firing is worse than
  either state on its own.

---

## D-18 — a flow's schedule lives on its model; Foundry has no `schedule` trigger row for a flow

| | |
| :--- | :--- |
| **Phase** | 3 (task 3.6) |
| **Implements** | [03 §5.4](../03-architecture.md) "schedule triggers move to Kestra" |

`triggers.type` still accepts `schedule` for a **script**-bound trigger, and `createForFlow` refuses
it for a flow-bound one with an explanation. The cron lives on `flow_revisions.model_json.schedule`
and is deployed by approving a revision.

The alternative — a Foundry `triggers` row as the source of the cron — was rejected because it is a
**second way to fire a flow on a timer that no approval covers.** Gate 2 asks "may this revision run
unattended"; a schedule row that could be enabled independently answers it a different way, and the
one that says yes wins.

Consequences worth knowing:

- A flow-bound trigger can only be `manual`, `poll` or `webhook`, and **all three fire the approved
  live revision or nothing** (`assertMayRunLive` first). A webhook that quietly ran the draft would be
  an approval bypass with a public URL on it.
- Trigger **inputs come from `triggers.config.inputs`, never from a webhook body.** The webhook
  receiver is unauthenticated by design, and flow inputs are interpolated into step params. The body
  is recorded on the `trigger_fires` row for the audit trail and is not handed to the engine.
- The fire row is written **before** the execution starts, because its id is stamped on the Kestra
  execution as a label and `begin` reads it back to link the two. Writing it afterwards races: `begin`
  is the flow's first task and can complete before `startExecution` returns.

---

## D-19 — a `code` step is a function BODY, not a program

| | |
| :--- | :--- |
| **Phase** | 4 (tasks 4.2, 4.4) |
| **Implements** | [04 §5.3.2](../04-generation-model.md) "stdin JSON in, stdout JSON out — ⚠ pin this in Phase 4" |

§5.3.2 asks for stdin-in / stdout-out and flags the choice as one to pin. **Stdin is not reachable**:
Kestra's script tasks run `python <file>` with nothing attached to stdin, and there is no option to
change that. So the wire format is pinned as:

```
input   inputFiles: { "input.json": <expression> }   read by the wrapper
output  ::{"outputs": {"result": …}}::               printed by the wrapper
```

The more consequential half is *who does the reading and printing*. The generated fragment defines
`run(payload)` and nothing else; a **fixed, compiler-emitted wrapper** owns all the I/O, checks the
declared output keys, enforces the size cap, and prints the marker.

That was not the obvious shape — asking the model to emit a whole program is simpler to build — and
it is worth the extra piece because of what it makes impossible rather than unlikely:

- a fragment **cannot pick an output channel**, half-write one, or print a marker with the wrong
  shape, so "the step produced nothing" stops being a failure mode;
- the **contract is checked in the container**, before the value crosses back, so a violation is a
  named failure at the step that caused it instead of a `KeyError` three steps downstream;
- the R9 guarantees are checkable by **reading one function** rather than every fragment ever
  generated.

`validateFragment` rejects `print()` for the same reason: stdout belongs to the wrapper.

## D-20 — one output channel, with the cap as an explicit failure

| | |
| :--- | :--- |
| **Phase** | 4 (task 4.4) |
| **Implements** | [04 §5.3.2](../04-generation-model.md) "large payloads go to internal storage" |

§5.3.2 says two things that pull apart: *"pick one [output channel], encode it in the compiler, never
mix"*, and *"step outputs above ~1 MB are written to internal storage and passed by reference"*.
Implementing both is by definition mixing.

**Pinned: the output marker is the only channel**, and the 1 MB cap is enforced in the wrapper as a
named failure (`output_too_large`) that says which step and by how much. Triage routes it to a
**flow redraft**, not a fragment regeneration — a step carrying too much data is a decomposition
problem, and regenerating it would produce the same volume.

The cost is honest and bounded: a step that outgrows the cap fails loudly on the day it does, rather
than silently truncating or quietly working until the dataset grows. Internal-storage pass-by-
reference becomes a real second channel when a real workload needs it, at which point the choice is
per-step and visible, not implicit.

## D-21 — the agent step's wait lives in Kestra's database

| | |
| :--- | :--- |
| **Phase** | 4 (tasks 4.5, 4.6) |
| **Implements** | [05 §6.2](../05-lifecycle-and-flows.md) · M2 · phase-4 exit criterion |

An `agent` step compiles to **two** tasks — an `http.Request` that starts the Tether run and returns
in milliseconds, and a `core.flow.Pause` that holds the execution. The alternative, one HTTP call
held open for the length of an agent run, puts the wait **in a socket**; a socket does not survive a
Foundry restart, a Kestra worker restart, or a proxy idle timeout, and when it dies the Tether run
carries on with nothing left that knows what it was for.

Three consequences that are load-bearing:

- **The exit criterion becomes a property of the engine.** "Kill Foundry mid-agent-step, restart, and
  the execution still resumes" is true because the pause is a row in Kestra's database, not because
  Foundry stayed up.
- **The poller's work list is a QUERY** — `tether_run_id IS NOT NULL AND resumed_at IS NULL` — so
  `reattachAll()` on boot finds exactly the runs the dead process was watching. Selecting on the fact
  rather than on a status string is I-14's lesson applied before it could bite twice.
- **Every exit path resumes, including the deadline.** A poller that gives up silently leaves the
  execution paused, and a paused execution holds an M3 concurrency slot — five of them would brick a
  workspace through a *fairness* control, which is exactly the shape of I-10. Tether's missing boot
  reconciliation (`agent-backend/server.js:1500`) makes an orphaned `running` run a real case, and
  `AGENT_RUN_DEADLINE_MS` is what stops it costing more than one execution.

`onResume` inputs are posted as **multipart**, not JSON. Kestra accepts a JSON body with a 2xx and
silently drops the inputs, which surfaces later as a downstream step reading `null` — a failure with
no error attached to it.

---

## D-22 — a generated expression is allowlisted before it reaches the compiler

| | |
| :--- | :--- |
| **Phase** | 4 (task 4.10) |
| **Implements** | [02 R8](../02-rules.md) · supersedes the precondition in D-16 |

D-16 recorded that the compiler is safe for a structural reason — task types and the one reachable
host are chosen by the compiler, and free text is re-indented into a block scalar — and then stated
the precondition that made the remaining hole acceptable:

> `paramsExpr` is an opaque string emitted verbatim; it is safe only while models are
> **Foundry-authored**.

**Task 4.10 ends that, and it turns out it had already ended.** A drafting model now authors those
expressions from a goal the tenant wrote — and `POST /api/workspaces/:ws/flows` has accepted a full
model, expressions included, from a client since Phase 3. With one shared `PARENT_API_KEY` and no
user model (I-13), "client" means the tenant. So the precondition was false before 4.10 was written;
4.10 is what made it visible.

**The exposure, concretely.** These strings land inside Pebble templates that Kestra evaluates, and
Pebble is a function language. Kestra's secret store holds `KESTRA_CALLBACK_SECRET`, so
`{{ secret('FOUNDRY_CALLBACK') }}` in a `paramsExpr` posts that secret to a tool endpoint the tenant
controls. A **draft** run is enough — the draft namespace is deliberately exempt from the approval
gate (§5.4), because a draft run is how gate 1 gets satisfied in the first place.

**`services/flow-expression.service.ts` is an allowlist, and that is the whole design.** An
expression may read five variable roots (`inputs`, `outputs`, `trigger`, `flow`, `execution`) and
call seven functions (`json`, `jq`, `first`, `tostring`, `tonumber`, `length`, `not`). Everything
else fails **by name**. A blocklist of `secret(`, `kv(`, `read(`, `fileURI` would be defeated by the
next Kestra release adding a function nobody here has heard of; the allowlist rejects it on the day
it ships with no edit to this file. A test asserts exactly that, using `fileURI` — a name that
appears nowhere else in the codebase.

Two placement decisions:

- **The check is in `flowService.writeRevision`, not on the routes.** That is the one function every
  revision passes through, whoever authored the model, so a new route cannot forget it.
- **Hand-written Foundry models are inside the boundary, not exempt from it.** `hr-screening.model.ts`
  passes the allowlist unchanged — verified, including the two I-11 traps in `NOTIFY_PARAMS_EXPR` —
  so there was no need for an exemption and therefore no exemption exists.

The quoted-string handling is the one subtle part: a jq program's literals are blanked before the
expression is mined for identifiers, so `jq('[.[] | {sender: "a@b.example"}]')` does not report
`sender` as an unknown root, and a literal containing the word `secret` is not read as a call.

---

## D-23 — one Tether session per fragment, never a reused one

| | |
| :--- | :--- |
| **Phase** | 4 (task 4.10) |
| **Implements** | [04 §5.3](../04-generation-model.md) · assertion 18 |

Foundry's rule everywhere else is **session = automation (durable), run = version**: reuse the
session across regenerations so a retry costs ~800 chars against a cached prefix instead of ~10 KB.
That rule is right for a monolithic script and **exactly wrong for a fragment.**

A session carries its history. Generate fragment A in a session and then fragment B in the same
session, and B's context contains A's contract and A's code — so B can reference a sibling step it
was never told about, and the isolation `buildFragmentPrompt` exists to guarantee is defeated
**downstream of the prompt**, where no prompt test would see it. Worse, it would be defeated
*helpfully*: B would produce plausible code that happens to agree with A, which is indistinguishable
from B being correct until A changes.

So `InferenceClient.complete()` **has no `sessionId` parameter**. Statelessness is a property of the
interface rather than a discipline at each call site, and no caller can reuse a session even by
accident. The cost is a cold prefill per fragment — measured at ~1.4 s against ~5–6 min of decode.

The same interface is what makes assertions 18 and 19 checkable at all. Both are statements about
*calls* — "three code steps produce three separate inference calls", "regenerate B and A and C stay
byte-identical" — and neither is visible in the generated code. A live model could produce three good
fragments while the harness leaked all three contracts into one prompt, and any output-based test
would pass. A recording client counts the calls and diffs the prompts that were actually sent.

---

## D-24 — the CONTRACT travels; the code does not

| | |
| :--- | :--- |
| **Phase** | 6 (task 6.2) |
| **Implements** | [04 §5.2](../04-generation-model.md) · [08 §10](../08-scale-and-phasing.md) |

§5.2 rules that generated code is stripped from an export and a `code` step imports as
`needs_regeneration`. It does not say **what replaces it**, and the answer turns out to be the whole
design.

Strip the code and drop the contract and the import is not a recipe — it is a flow that can never be
cooked. `regenerateStep` refuses a step with no stored contract (`no_contract`, 409) and it must,
because the alternative is inventing the standard a fragment is judged against. `flowCompiler` then
rejects the `needs_regeneration` placeholder by name (assertion 30), so the imported flow cannot even
be deployed. A bundle carrying structure alone would import to a permanently dead step.

So **the contract is the portable artefact and the code is a local build of it.** That inverts which
half looks important and it is the right way round: the contract is what a human reviews and approves,
and the code is re-derivable from it for one inference call.

### §5.2's stated reason for stripping is now false, and the conclusion survives anyway

§5.2 justifies stripping as *"a fragment generated against one schema is wrong against the other"*.
After Phase 4 that premise **cannot be true**: a fragment never sees a schema. `buildFragmentPrompt`
is the contract and nothing else — no manifest, no goal, no sibling (assertion 18) — so a fragment is
not "generated against" `hr_demo` any more than against `hr_demo_alt`.

Schema coupling did not disappear in Phase 4. It **moved**, out of the fragment and into two places
that are tenant-local by construction:

| Where | What it absorbs |
| :--- | :--- |
| the named **query** | reviewed SQL, per tenant. `presence_rate` being a 0–1 fraction is absorbed here. |
| the **contract** | authored by a drafter that DID see the manifest, so its field descriptions carry the units the fragment then obeys. |

Which yields the honest statement of what an import can promise, and both halves are load-bearing:

- **CAN** — every ref exists in the importing tenant and its call signature matches what the flow
  sends. Mechanical and complete.
- **CANNOT** — tell whether the importing tenant's query returns the same COLUMNS in the same UNITS.

The second is measured rather than asserted: `kestra:phase6` imports the same bundle twice against two
queries differing only in a `×100`, and **both import with zero findings**. Only the oracle separates
them. **An import is a structural check, not a correctness check.**

---

## D-25 — a ref's portable INTERFACE is not its fingerprint

| | |
| :--- | :--- |
| **Phase** | 6 (task 6.3) |
| **Implements** | [04 §5.2](../04-generation-model.md) · refines D-17 |

`manifestBuilderService.refFingerprints` includes a named query's `sql_text`, and D-17's reasoning for
that is sound: an approver signed off on what the flow *does*, so editing the SQL of a query an
approved flow calls must invalidate the approval. Correct **within** one tenant.

Across tenants it is exactly wrong, because the SQL is what is *supposed* to differ. Comparing
fingerprints at import would report "every ref changed" for two workspaces that are both correctly
configured — a check that fires always and therefore says nothing, which is worse than no check
because it trains people to click through it.

So `refInterfaces()` is a second, deliberately different notion: the **call signature** — parameter
names, in order for a positional query, sorted for a named tool — and nothing else. That is what an
export records and an import compares. Same data source, two concepts, and the docblock on each says
why treating them as one breaks the other.

Import then distinguishes three outcomes, and only the first two block:

| Finding | Meaning |
| :--- | :--- |
| `unknown_ref` | the name does not exist here. Message lists what does. |
| `param_removed` / `param_added` | it exists and takes different parameters. |
| `signature_reordered` | same parameters, different order. A **warning** — params bind by name. |

---

## D-26 — replay has two modes, because a partial replay does not run `begin`

| | |
| :--- | :--- |
| **Phase** | 6 (task 6.1) |
| **Implements** | [05 §6.3](../05-lifecycle-and-flows.md) |

§6.3 draws replay as one operation: `POST /executions/{id}/replay {taskRunId}`. Building it produced a
**measured** fact that splits it in two — `kestra:phase6` asserts it directly:

> A partial replay does **not execute `begin`.** Its taskrun is copied like any other upstream step.
> The replay's Foundry row therefore holds **zero** execution credentials of its own.

`begin` is where the approval gate runs, where the execution credential is minted, and where the
`flow_executions` row is created. Skipping it has four consequences, none visible from outside:

1. **The approval gate is not re-applied.** Replaying from step 2 of a live execution whose approval
   has since been revoked would execute unapproved behaviour — approval bypass by replay, needing no
   privilege beyond pressing a button that already exists.
2. **The execution credential is reused**, from the rehydrated `outputs.begin`. A credential is burned
   at terminal state, so a *succeeded* run can never be partially replayed — correctly, and
   permanently.
3. **No Foundry row is created**, so the replay is invisible in history and spends no M3 budget.
4. **An `agent` step at or after the replay point HANGS** — see I-18.

So the two modes are different operations rather than one with a parameter:

| Mode | |
| :--- | :--- |
| **full** (default) | `begin` re-runs, so the gate, a fresh credential and the budget all re-apply on their normal paths. Unconditionally safe. |
| **from a step** | Foundry performs 1, 2 and 3 itself and **refuses** for 4. Every refusal names the alternative, because "replay the whole thing" is always available. |

**The client names a STEP, never a taskrun.** §6.3's diagram ends in a Kestra identifier; a client
does not hold one and must not learn one (R5), so the API takes `{ fromStepId }` from Foundry's model
and resolves the taskrun server-side.

`downstreamOf` is computed from `dependsOn`, **not from ordinal position.** Ordinals agree with
dependencies right up until a flow branches, and the set it returns is what decides whether an agent
step is inside the replay — so on a branching flow an ordinal version would both refuse safe replays
and permit hanging ones.

---

## D-27 — a template is a SNAPSHOT, and instantiating one is an import

| | |
| :--- | :--- |
| **Phase** | 6 (task 6.4) |
| **Implements** | [08 §10](../08-scale-and-phasing.md) |

`flow_templates.bundle_json` stores the exported bundle, not a reference to a flow. A template
pointing at a live flow would change every time that flow was edited, so "create from template" would
mean *"whatever that automation happens to be right now"* — the same class of mistake as approving a
flow rather than a revision (§6.5). Saving a second template under an existing name is therefore a
**409**, never an upsert: the library has no equivalent of `flow_revisions`, so a silent replace would
change what every future instantiation produces with nothing to notice it by.

Instantiating goes through `flowPortabilityService.importFlow` — the same path a pasted bundle takes,
with the same ref revalidation, the same D-22 expression allowlist and the same generate-before-deploy
ordering. There is deliberately **no second instantiation path**, because the second path is the one
that ends up missing a check.

Both the library and `fragment-candidates` are **per workspace with no cross-workspace listing.** A
template carries ref names and step contracts written against one tenant's data, and a promotion
candidate quotes those contracts' purposes verbatim; a shared listing would leak the origin tenant's
schema vocabulary through autocomplete. Moving a flow between tenants stays an explicit export →
import, by a human, with revalidation.

---

## D-28 — the API server does not hold the host Docker socket, and `kestra:check` asserts it

| | |
| :--- | :--- |
| **Phase** | deployment prep (after 6) |
| **Implements** | [02 §R8/R9](../02-rules.md) · the Phase 4 note in `infra/docker-compose.yml` |

`packages/server` mounted `/var/run/docker.sock` and its Dockerfile installed the static Docker CLI,
both for `execution.service.ts`, which ran every generated script as a sibling container. **Phase 4
deleted that service, and nothing in `packages/server` spawns a subprocess of any kind now** —
checkable in one grep:

```
grep -rn "spawn\|execFile\|child_process" packages/server/src --include=*.ts   # → nothing
```

So what remained was a live path onto the host daemon with no caller, held by the process that
terminates tenant HTTP and holds `PARENT_API_KEY`, `TETHER_API_KEY` and `CREDENTIAL_ENC_KEY`. Anything
that reaches that socket can start a privileged container; the API server is the worst place in the
stack to keep such a route and the only place it was no longer used.

Kestra is now the **sole** holder, which is exactly what the compose note written during Phase 4
predicted would happen. That is a strictly smaller surface for the same capability: Kestra is not
client-reachable (R5) and emits only the task types the compiler chose (R8), so nothing a tenant
supplies reaches the daemon.

Two consequences worth writing down because they look unrelated:

* The build no longer fetches a ~70 MB tarball from `download.docker.com`, so the server image builds
  behind a proxy or on an air-gapped builder.
* `curl` and `ca-certificates` went with it, so the compose healthcheck for `server` uses `node -e`
  with `fetch()`. Re-adding a package for a healthcheck would undo the point.

**Asserted, not merely deleted.** `kestra:check` now fails if `foundry-parent-server` mounts a socket.
"Nobody re-adds a volume mount" is not a control, and `-v /var/run/docker.sock` is the obvious fix the
next time something server-side wants to run one container — which is a design question (*why is this
not a Kestra task?*) before it is a Dockerfile question.

---

## D-29 — the fragment base image is built by the stack, not by a comment

| | |
| :--- | :--- |
| **Phase** | deployment prep (after 6) |
| **Implements** | [09 O2](../09-risks-and-verification.md) · [04 §5.3.2](../04-generation-model.md) |

`foundry/fragment-base:py3.12-pandas2.2.3` existed only as a `docker build` line in a **comment** in
`infra/fragment-base/Dockerfile`. Nothing built it — not compose, not a package script, not CI.

The failure that makes this worth a decision entry is the shape of it, not the omission. A fresh host
came up **entirely green**: compose healthy, `kestra:check` 13/13, the engine serving, every REST call
answering. Then every `code` step failed at execution with an image-not-found — a missing build
artefact discovered *after approval, inside a run,* surfacing as a Docker error in a task log. The
stack's own health signals were all true and all irrelevant.

So `fragment-base` is now a one-shot compose service in the same shape as `migrate` and
`kestra-db-init`: `docker compose build` produces it, `up` fails at **deploy** time if it cannot, and
`kestra` depends on its successful completion even though it does not need it to boot. Compose builds
into the host daemon — the same daemon Kestra's sibling containers use through the mounted socket — so
this is exactly the image a `code` step resolves. `kestra:check` asserts its presence on the host as a
14th boundary check.

`network_mode: none` on the build service's one-shot run, matching how a fragment actually executes
(R9/V1). If that trivial `import pandas, numpy` ever needs egress, that is a finding rather than a
config problem.

**Rebuilding is safe; re-tagging is not.** The base is digest-pinned and the pip versions are pinned,
so an unchanged Dockerfile is reproducible and the layer cache makes a re-build a no-op. What is unsafe
is *editing* the image under the same tag — every existing fragment was generated against this import
set, and the tag names both versions for that reason. Bump it; never re-point it.

---

## D-30 — the client renders server state or an error, never a fallback

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 1 |
| **Implements** | [02 rules](../02-rules.md) — the honesty rules the whole programme rests on |

`packages/client` had a localStorage mock database behind 66 of the 71 exported functions in
`lib/api.ts`, and — worse — a helper called `faFallback` wrapping ten call sites that **returned
fabricated rows on any server error**, logging a `console.warn`. In a demo you could not tell whether
you were looking at the product or at a browser cache.

That is the same class as `llmConnected: true` and as the audit marking a broken script `clean`: a
signal that is green because nothing checked, not because something worked. It is worse than those
two, because it is the surface a person is *looking at* while forming a judgement.

Both are deleted, and the deletion is guarded rather than trusted. `scripts/ui-honesty-check.sh` is
21 assertions covering: the mock modules are absent, nothing imports them, `faFallback` is neither
defined nor called, browser storage is allowlisted to one UI-preference module, and **every
`useAsync` consumer reads `error`** — because a page that cannot report failure will render an empty
list instead, which is the same lie with fewer steps.

Comments are excluded from the pattern checks on purpose: every removed name is *discussed* in the
comment explaining its removal, and a check that forbade naming them would push those explanations
out of the code.

**Proven able to fail** by planting a file containing a `faFallback` definition — 2 assertions FAIL,
exit 1.

⚠ **One non-obvious consequence.** Dropping `tools.is_dummy` looked cosmetic and was not: `isDummy`
sits inside `refFingerprints()`'s hash payload, and a fingerprint change routes `checkStaleness` →
`markStale` → `status: "suspended"`, which **unarms the flow and removes its Kestra schedule**.
Dropping the key would have suspended every armed flow in every workspace, reporting "the shape
changed" for a capability nothing ever used. `manifest-builder.service.ts` therefore emits a
hardcoded `isDummy: false` and the manifest keeps a literal `kind="real"`. **Do not tidy that away** —
it was verified by rebuilding all three workspaces' manifests and getting byte-identical hashes.

---

## D-31 — gate 3 is a STEP KIND, not a check

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 3 |
| **Implements** | [04 §5.3](../03-architecture.md) · [05 §6.5](../05-lifecycle-and-flows.md) |

`flow-approval.service.ts:32` described a third gate — a human approving one execution — in a
comment. It did not exist. Step kinds were `tool|datasource|transform|code|agent`.

It is now `approval`, and the shape is deliberately **identical to `agent`** (D-21): two tasks, where
`<id>` registers the request and `<id>_await` is a `core.flow.Pause`. The wait therefore lives in
**Kestra's database**, which is the whole reason it is a step: a person takes hours, and an in-process
wait does not survive a deploy. Killing the API server mid-pause and restarting still resumes.

Three things are load-bearing:

- **Placement is the mechanism.** Kestra runs tasks in emission order, so a gate emitted before the
  send makes the send unreachable until the Pause resolves. `e2e:ui` asserts the outbox has not moved
  while the run is paused — a gate that paused *after* the send would satisfy every other check.
- **Rejecting KILLS the run**; it does not resume it with a "no". Resuming would execute the send
  task, which is the one thing the gate exists to prevent. There is no undo, and a second decision is
  a 409.
- **`onResume` is posted MULTIPART.** Kestra accepts JSON with a 2xx and silently drops the inputs
  (D-21). Assert the value *arrived*, never the 2xx.

A new kind has to be written down in every per-kind list or it silently fails to travel:
`flowModelSchema`, `KINDS`, `bundleStep`'s allowlist (D-24), the expression allowlist (D-22),
`downstreamOf`'s replay refusal, `flow-visibility.service.ts` redaction, and `StepDetail.tsx`.

⚠ **The approver is SELF-ASSERTED** — one shared `PARENT_API_KEY`, no user model (I-13). Self-approval
is refused against the recorded requester and that is all. **Never describe gate 3 as separation of
duties either.**

---

## D-32 — runtime retry is opt-in per step, and refused for three kinds

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 4 |
| **Implements** | [02 R8](../02-rules.md) — the compiler is the sole YAML emitter |

The compiler emitted no `retry:` block at all, so a transient 503 killed a run permanently. This was
the one genuinely missing loop; array-shaped fan-out (M1) and the redraft loop already existed.

The emitted shape was **measured against v1.3.29 with negative controls** before a line was written —
`maxAttempt` and `maxAttempts` both validate and neither is flagged deprecated, and the engine's own
constraint violation names the plural, which is the only evidence available for which one binds.

`behavior: RETRY_FAILED_TASK` is emitted **explicitly**, and `kestra:check` fails if
`CREATE_NEW_EXECUTION` appears anywhere in the emitter. That value starts a fresh execution, which
here means a second `begin`: a second execution token, a second M3 budget slot and a second
`flow_executions` row for one logical run. Five attempts would brick a workspace through a *fairness*
control (I-10) and the symptom would be "the runs list has duplicates".

Retry is refused for `agent` (a retry starts a second Tether run while the first is going, and only
one can resume the single pause), `approval` (a decision is per execution+step and outlives the task)
and `transform` (no network, no I/O — if it failed the expression is wrong and will fail identically).

**What makes `tool` safe is a property, not a hope:** `stepExecutionService.tool` throws only when
EVERY item failed, so the obvious disaster — 7 of 10 emails sent, retry sends all 10 again — is
structurally impossible. That semantic predates retry; `step-execution.test.ts` now pins it *as the
retry-safety argument*, with a positive control that an all-failed batch does throw.

⚠ **The residual, stated rather than hidden:** a call whose *response* was lost had its effect and is
indistinguishable from one that never landed. If all N items fail that way, a retry duplicates all N.
That is why retry is opt-in per step and not a default.

---

## D-33 — the tool layer is a separate process with its own database

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 5 |
| **Implements** | the credential boundary the separate `hr_demo` database already established |

`/stub-api/*` was real HTTP over real SQL, and it ran **inside the parent process** — so a tool call
terminated in the process holding `PARENT_API_KEY`, `TETHER_API_KEY` and `CREDENTIAL_ENC_KEY`, on a
connection to the database holding `workspace_secrets`. A SQL-injection or path-traversal bug in a
mail handler was a bug in the control plane. And 11 of 14 tools were unauthenticated.

`packages/ops-api` on **:4004** is that layer, with its own database, no `CONNECT` on
`foundry_parent`, a read-only `hr_demo` role of its own (`ops_ro`, deliberately **not** `foundry_ro`
— revoking the script credential in an incident must not take the tool layer down), and
authentication on every route across all four auth styles.

Two knobs, and they are two because they answer different questions: `OPS_API_BASE` is **stored on a
tools row** and must resolve for whoever later reads it; `OPS_ADMIN_BASE` is used **immediately** by
the evaluating process, which is a host process for every harness — and `host.docker.internal` does
not resolve on a Linux host.

**`redactSecrets` moved to `@foundry/redact` and the service-key derivation did NOT**, and the
distinction is the point. Redaction drifting is **silent**: each copy keeps passing its own tests
while the two disagree about what a secret looks like. The derivation drifting is **loud**: the two
sides stop agreeing on a value, the first tool call 401s, and the call log names the service. Both
sides re-derive the recipe from `createHmac` in their tests rather than calling the function twice —
a test asserting `f(x) === f(x)` passes through exactly the change that breaks the other process.

---

## D-34 — an LLM tool whose output is terminal, never load-bearing

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 6a |
| **Implements** | a new capability; bounded rather than trusted |

`POST /llm/complete` is ops-api's sixth service: an `instruction` in plain English, an `input` that is
whatever the previous step emitted, and one text field out. It sources nothing and decides nothing.

It is the first **non-deterministic** endpoint in a service whose every other route computes an actual
answer — which is exactly what lets the oracle say "right" rather than "ran". So the rule is not
"reported vs decided": a summary of what a flow found often *is* the deliverable. The rule is whether
anything downstream **consumes** it. Prose into an email body is fine. Parsing it, branching on it,
counting things in it is not. Hence no JSON mode, no structured output, no function calling.

That is also why the regression net survives: `expectedScreening` checks WHICH eleven people were
mailed and never the wording.

⚠ **The rule earned itself on the first real run.** `showcase-llm-digest` produced a digest ranking
`Engineering 91.23%` above `Sales 91.34%` in a list it introduced as descending. Every figure was
correct; the ordering claim was not. A step that parsed that ranking would have been wrong.

Bounded, because it is also the first **outbound** route and the first **billable** credential in a
process whose worst case was previously synthetic data:

- the provider **host is operator-set and never caller-set** — there is no URL parameter on the tool
  route, so it cannot become a general-purpose outbound proxy for anything running inside a flow;
- the model must be on an allowlist chosen from what the gateway advertises, and an unlisted one is
  refused **by name** rather than substituted;
- truncation is a **named failure** (422 `output_truncated`), not a 200 over a half-written document —
  same reasoning as D-20's 1 MB cap. A report is in scope, so `max_tokens` is a real number to pick;
- the call log records **sizes, never the prompt or completion**, via an opt-OUT so a new endpoint
  that forgets still logs its body. The middleware runs **before** `requireKey`, because a 401 is
  logged too and a caller who got the credential wrong has still sent the prompt;
- a rolling per-minute budget counted from the call log, because M1 puts one taskrun in front of an
  array of any length.

**Two credentials in two directions, named apart:** `LLM_TOOL_TOKEN` is what a flow presents to
ops-api (header `X-LLM-Key`); the provider key is what ops-api presents to the gateway
(`Authorization: Bearer`) and is **never** seeded into `workspace_secrets`. The inbound style is
deliberately not `bearer` so a bug confusing the two 401s rather than forwarding a credential.

The provider is configurable — one you can only change by editing compose and recreating a container
is not one an operator can set up. `llm_provider` is a singleton row, the key sealed AES-256-GCM under
a digest of `OPS_API_KEY`. ⚠ Be honest about what that is worth: it protects a database dump, a backup
and a screenshot of a row, and nothing at all against something holding the root key — which is by
construction that process itself.

---

## D-35 — generation speaks to a completion endpoint; Tether runs `agent` steps

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 6b |
| **Refines** | D-23 — one session per fragment, never a reused one |
| **Caused by** | I-24 |

`InferenceClient` had one implementation, `TetherInference`, and its own docblock had already named
the exit: *"Tether is an agent runtime, not a completion API. If a plain completion endpoint ever
appears, it lands as a second implementation of this interface and no generation code changes."*

`kestra:refusal` turned that from a preference into a defect. Every Tether run attaches the mandatory
`script-gen` skill, whose protocol runs further turns **after** the model answers, so `finalMessage`
is the tail of a conversation rather than the answer — and the `insufficient_contract` JSON never
survived. See I-24 for the measurement.

`GatewayInference` is one request and one answer against the OpenAI-compatible gateway. Selected when
one is configured; Tether otherwise.

**D-23 is unaffected and stronger here.** `complete()` still has no `sessionId` and must not gain
one — but a completion carries no history at all, so the guarantee is free rather than enforced.

⚠ **Runtime and generation inference must not be merged.** They share a provider and nothing else:
different credentials, different processes, no shared abstraction. `llm_complete` is a tenant-facing
tool in ops-api behind an allowlist and a budget; the generation seam is control-plane machinery with
no tenant surface. A single "the LLM config" would put a fragment's contract and a tenant's runtime
prompt behind one interface whose entire value is what it cannot see.

Tether remains the transport for `agent` **steps**, which is what an agent runtime is actually for: a
multi-turn task with tools, awaited by pausing the execution.

---

## D-36 — an agent step's outcome has THREE values, and only one fails the step

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 6b |
| **Refines** | D-21 |
| **Caused by** | I-25 |

`agent-run.service.ts` resumed with `status: succeeded | failed` on every path, and **nothing read
it** — so an agent run that did not complete un-paused the flow, handed its error message to the
downstream step as `.result`, and the execution settled SUCCESS (I-25).

An `agent` step now compiles to **three** tasks: `<id>`, `<id>_await`, and `<id>_await_check`, a
`core.execution.Fail` conditioned on the outcome. In the compiler, not per flow, for the reason R8
exists — a flow author remembering to check `.status` is discipline, and the flows that forget are
indistinguishable from the ones with nothing to check.

⚠ **The condition is `== 'failed'`, NOT `!= 'succeeded'`.** Tether derives run status from an
agent-authored `artifacts/RESULT.json`; a run that **answered a question** writes no such file and
lands on `needs_review` *by construction*. The obvious version of this fix would have failed every
correct agent step, and the symptom would be "agent steps never work".

Measured: the same triage prompt run twice gave a correct ranked answer once and a refusal once, and
**both were `needs_review`**. The status distinguishes nothing about answer quality, so reading it as
a verdict on the answer is a category error in either direction.

**And the thing Foundry must not do: judge the text.** A refusal and a good answer are both "the agent
replied", exactly as the LLM tool's output is terminal rather than load-bearing (D-34). A flow that
pipes an agent's prose into a chat message has accepted that; a flow that needs a decision uses a
`code` step.

---

## D-37 — the caps are a whole-flow check, and two of the four listed are elsewhere

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 7 |
| **Implements** | phase-5.md task 5.2 |
| **Extends** | D-16, D-22 |

Phase 5 task 5.2 called for `flow-validator.service.ts` with *"step / fan-out / agent-run /
subflow-depth caps"*, and it was never built because Phase 5 was deferred. Stage 7 makes
`POST /flows/generate` reachable from a browser, so it had to be built first: a 500-step flow or a
10,000-item fan-out authored through the product is a denial of service.

It lives in **`flowService.writeRevision`**, beside D-22's expression allowlist and for the identical
reason — that is the one function every revision passes through, whoever authored the model and
however it arrived (a hand-authored `POST /flows`, a generated draft, an imported bundle, a seed). A
new route cannot forget it. A test creates a flow whose ref does not exist and asserts the 400; the
call was removed to confirm the test goes red.

**The caps, and why each number is a resource rather than a taste:** 64 steps; 16 `code` steps (each
a container start and, at generation, an inference call); **4 `agent` steps** (each a Tether run, and
M4 bounds a *workspace's* daily runs while nothing bounded one execution's); 8 `approval` steps; a
**total pause budget of 7 days**; 256 KB of serialised model.

The pause budget is the one worth arguing for. Per-step ceilings **do not compose**: eight approvals
each individually legal at the 7-day maximum is a 56-day hold on an M3 concurrency slot, and five
such flows brick a workspace through a control whose job is fairness — the I-10 shape exactly. An
omitted `awaitSeconds` counts at the **compiler's default** (agent 3600, approval 86400), or the cap
would be avoidable by leaving the field out, which is the shape every drafted flow actually has.

**Two of task 5.2's four caps are deliberately not here, and saying so is the decision:**

- **Fan-out cannot be checked statically.** A model declares a `paramsExpr`, not an item count; the
  number does not exist until the expression renders. The cap therefore already lived at the only
  place that can see it — `stepBatchSchema.params.max(1000)` on the route Kestra calls back into.
  `flow-validator.test.ts` pins that bound, in the file that explains why it is elsewhere. A second,
  static fan-out check here would be a check that can never fire.
- **Subflow depth has no subject.** There is no `subflow` step kind and the compiler refuses
  everything outside the six by name. A depth check would iterate an empty set for ever, and a test
  that passes over no rows reads exactly like a test that passes. Add the cap **with** the kind, if
  one is ever added.

**The second job is the bigger one, and phase-5.md said so first.** Framing this as a control against
malicious clients is a misread: *"its primary job is catching LLM error"*. Ref validation is the
half that earns that — every `tool`/`datasource` ref must resolve **in this workspace**, and the
finding carries the workspace's actual ref list. Before this, an unknown ref was discovered by
`invokeTool` returning a 404 **mid-execution**, which is late in the way that costs: the steps before
it have already sent mail. Findings are structured (`rule`, `stepId`, `message`, `facts`) and the
error middleware was changed to stop flattening them — `unknown ref "x"` with no list costs a redraft
that cannot succeed.

⚠ It checks that a name resolves and **nothing about what it returns**. A query whose columns or
units differ is invisible here, exactly as at import (D-25), and for the same reason: only that
tenant's oracle can see it.

---

## D-38 — generation is a polled JOB, and the refusal screen has no Retry button

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 7 |
| **Implements** | 06 §6.7 |
| **Related** | D-15, I-24 |

`POST …/flows/generate` holds the request open for the whole of generation. That is right for a
script and wrong for a tab: decode-bound at ~37 tok/s, three inference calls for a five-step flow, so
**minutes is normal** — long enough to die to a proxy timeout, and long enough that a reload loses
work already paid for. So the browser posts to `…/flows/generate/jobs`, gets a row, and polls.

**One path, two transports.** `runGeneration` is the whole of what both routes do; they differ only
in how the answer gets back. A second copy of "draft, then generate fragments, then create unless
refused" would be a second place to get the refusal arm wrong, and the refusal arm is the one that
must not be got wrong.

**Polling rather than a socket, and this is not laziness.** `/ws/generation` did exactly this job and
was authorised by **nothing** — `?scriptId=<uuid>` and you were subscribed. It was deleted with the
monolithic path. Anything socket-shaped here would owe a single-use ticket redeemed from an
API-key-authenticated route (D-15); a polled GET needs no new auth surface at all.

**`insufficient_contract` is its own terminal status, not a flavour of `failed`.** §6.7: a refusal
ends the loop and is never retried. Filing the most useful diagnosis this system produces under
"error" is how a client renders it as a failure and offers a Retry — and the retry is *literally* the
mechanism that converts a correct refusal into an invented `period="2023-10"` on attempt 2.

**So the screen offers "fix the boundary", and the button is disabled until the goal CHANGES.** That
is the rule rather than a nicety: a button that resubmits the identical sentence is a Retry button
with a different label. The panel names the missing values, and the fix is to say where they come
from — a declared flow input, or an upstream step — which `FlowReview`'s "Add an input" does directly.

Measured on the first `e2e:ui` run that used it: 202, ten polls, 50s, and
`insufficient_contract: prepare_emails needs ["template_mapping"]`. The refusals arrive, so the
screen renders them regularly rather than theoretically.

**A `running` row whose process is gone is reconciled on read.** The row is written by the worker, so
a container restart mid-draft strands it — I-10 again, where the thing that would have released it is
downstream of the thing that died. Past 30 minutes a still-`running` job becomes `failed` saying
*nothing was created either way*, and the per-workspace concurrency cap (3) counts the window rather
than the column, so stranded rows age out instead of bricking generation.

---

## D-39 — the identity is a SECOND secret, and the claim has an exact size

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 9.1 |
| **Ends** | the body-supplied half of I-13 |
| **Related** | I-32 |

`lib/auth.tsx` was Auth.js with a real signed-in user, and `app/api/foundry/[...path]/route.ts`
built exactly one header — `x-api-key` — and threw the session away. **The browser knew who you were
and the API never did.** So gate 2 took `approverUserId` from the request body and gate 3 took
`decidedBy` from the request body: both recorded a name and neither could verify one.

The fix was smaller than "build authentication", because the client was already minting the
credential and nobody consumed it. `src/auth.ts` signs a `backendToken` (HS256, 8h, sub/email/name)
at sign-in; the proxy now forwards it as **`x-foundry-identity`** and `identity.middleware.ts`
verifies it against **`RUNTIME_JWT_SECRET`**.

**Two secrets, deliberately, and `kestra:check` asserts they differ.** `PARENT_API_KEY` authorises a
*request*; this one attests a *person*. Collapsing them restores exactly the property being removed.

**State the claim at its real size.** What is true: *holding the API key no longer lets you name a
person* — measured, `e2e:ui` step 26, API key alone → 401 on approve. What is **not** true: that a
browser sent the request. Anything holding the signing secret can mint a token and `e2e:ui`
deliberately does. Do not write "authenticated user".

Four things were decided rather than fallen into:

- **Identity is resolved globally and required per ROUTE.** The same API key authenticates Kestra's
  step callbacks and every harness; a blanket requirement breaks the engine. `requireIdentity` is on
  approve, revoke and decide — everything that writes a name somebody will later be asked to trust.
- **A token that is PRESENT and invalid is a 401, never treated as absent.** The tempting version
  falls back to the API key, and then an expired session records an approval attributed to nobody —
  worse than before, because the field now *looks* verified. The test that keeps this honest is its
  control: an absent header must still pass through.
- **The person fields are REFUSED, not overridden.** `approveSchema` and `decideSchema` are
  `.strict()`, so a body carrying `approverUserId` is a 400 naming the field. A field that is
  accepted and ignored reads, to the next person, as a field that works.
- **`alg` is pinned to HS256 and never read from the token.** A test presents `alg: none` with an
  empty signature.

⚠ **Still not separation of duties, and the wording in `flow-approval.service.ts`, `ApprovalPanel`,
`ApprovalCard` and `kestra:hitl` all say so.** There are no roles: anyone who can sign in can
approve. The self-approval refusal is now verified on the approver side and only as good as
`created_by` on the other (I-32). Gate 3 has no comparison at all, because an execution has no
author — verifying a name makes it true, it does not make it a control.

---

## D-40 — a registered datasource must be read-only, proven by the ABSENT GRANT

| | |
| :--- | :--- |
| **Stage** | away-from-demo-mode 9.2 |
| **Closes** | "still open: a datasource registered by hand carries whatever credential the caller supplies" |
| **Related** | I-27, I-04 |

`foundry_ro`, `ensureReadOnlyRole()` and the twelve privilege tests were wired through **`demo/`
only**. So the credential boundary that protects the demo did not protect a customer, and the
failure was quiet: paste an owner DSN, everything works, and a `datasource` step could satisfy "send
the email" with an `INSERT INTO mail_outbox`.

`datasource-privilege.service.ts` probes at registration and `datasourceService.create/update`
refuse. **Verify-and-refuse rather than derive-a-role**, because deriving requires a credential that
can `CREATE ROLE`, which is the opposite of what should be pasted in.

**⚠ It tests the absent grant, not `default_transaction_read_only`.** I-27 records the day that
confusion made a check pass for the wrong reason: a session setting is a *preference*, and `SET
transaction_read_only = off` turns it back on. There is a test for exactly this — an owner DSN
carrying `options=-c default_transaction_read_only=on` **is still refused** — and it fails against
the naive implementation.

Four questions, because each is a way to write that the others miss: **superuser** (every privilege
check returns true for one, so a table-only check reports an owner DSN as read-only), a write
privilege on any relation in the allowlisted schemas, **CREATE on a schema** (a role that can create
a table owns it, and an owner can write — which is why the demo roles revoke CREATE from `PUBLIC` on
PG ≤14), and CREATE on the database. `has_*_privilege` is used throughout because it resolves grants
held via role membership **and via `PUBLIC`** — the trap that has now bitten this codebase three
times (the demo roles, I-04, and this).

**Catalogue reads, never a trial write.** The obvious implementation attempts an INSERT and expects
it to fail — and writes a row into a customer's database in exactly the case this exists to detect.

Three bounds, stated rather than discovered later:

- **An unreachable database is a REFUSAL, not a deferral.** "Register now, verify when it comes back"
  means the row that exists is the unverified one, and the check runs when nobody is watching.
- **Only `postgres` and `mysql` are gated, and that is the whole write path.** Only those two can be
  introspected, so only they can host a named query, and only a named query is reachable from a
  `datasource` step. A datasource of any other type is inert. Add the check **with** the introspector
  if a third type is supported.
- **The MySQL check is coarser and says so** — it matches privilege words in `SHOW GRANTS`, and an
  empty grant list is a finding rather than a pass, because a check that examined nothing reads
  exactly like a check that found nothing.

`update` re-verifies when the credential **or the allowlist** changes: a role can be read-only in
`public` and an owner in the schema just added, so checking only at creation lets an edit walk past
the gate.

---

## D-41 — an agent's question is an APPROVAL ROW, not a second pause

*Stage 8.1. `services/agent-run.service.ts`, `services/step-approval.service.ts`,
`flow_step_approvals.kind`.*

An `agent` step already opens a Kestra `Pause` (`<id>_await`, D-21). When the agent calls
`ask_questions`, Tether parks the run at `awaiting_input` — and the obvious reading is that Foundry
now owes a second wait, because a person has to answer.

It does not. **The pause is already open**, and it is open for exactly the right reason: the flow
cannot proceed until the agent finishes. A question is not a new thing to wait for; it is a reason
the existing wait is taking longer. So the only thing missing was a place for a person to see it.

That place is `flow_step_approvals`, gate 3's table, with a `kind` column:

| | `gate` | `question` |
| :--- | :--- | :--- |
| what opened the wait | the `approval` step's own Pause | the `agent` step's Pause, already open |
| approving | resumes Kestra | posts answers to **Tether**; Kestra untouched |
| rejecting | **kills** the execution | cancels the agent run, fails **that step** |
| who files the row | the flow, via `POST /api/steps/approval` | the poller, on observing `awaiting_input` |

Three consequences worth stating, because each is a way to get this wrong:

- **`kind` is a COLUMN, not a shape sniffed out of `context`.** The decide path branches on it and
  the branch has to be greppable — this is the I-14 lesson applied to a decision rather than to a
  query. `kestra:check` cannot help here; a reader can.
- **Rejecting a question does not kill the execution.** A gate rejection means *do not do the thing*,
  so killing is the only safe answer (Kestra's Pause has no alternate branch). A declined question
  means *this agent step cannot complete*, which the flow already knows how to handle — the compiler
  emits `<id>_await_check` for exactly that. Killing here would be a heavier act than the one asked
  for, and would take out steps that had nothing to do with the question.
- **Expiry is its own column, not a third `decision` value.** `decision` is what a PERSON said.
  Writing `expired` into it with a `decided_by` of "system" makes the audit trail's central column
  sometimes-not-a-person, which is precisely the property that made `approver_user_id` worth fixing
  in Stage 9.1. `listPending` selects on `decided_at IS NULL AND expired_at IS NULL`.

⚠ **`awaiting_input` must never join the poller's `TERMINAL` set.** It is a third state — not "still
working", not "done" — and the one-line version of this fix is to add it, which resumes Kestra while
the agent is still parked and runs every downstream step against an unanswered question. The
absence has its own test, with the four real terminal states asserted alongside so an emptied set
cannot score green.

---

## D-42 — the agent's tenant is resolved, never read; the fallback announces itself

*Stage 8.2. `services/agent-runtime.service.ts`, `config.tether.apiKey`, `kestra:check`.*

Every workspace's agent step ran under one `TETHER_API_KEY`. That is **not** a credential leak — R2
holds, Tether never receives a Foundry secret — but `inputExpr` serialises upstream step output into
the prompt and a Tether session keeps its history, so one tenant's rows ended up sitting next to
another's. The tenancy Foundry maintains everywhere else stopped at this one call.

`tether-client.service.ts` has threaded an `apiKeyOverride` through every method since Phase 4 and
nothing ever passed one. `agentRuntimeService.resolveKey(workspaceId)` is the caller: a
`TETHER_TENANT_KEY` in `workspace_secrets`, or the shared key.

**The fallback is the dangerous half, and it is the whole decision.** It has to exist — removing it
stops every existing workspace's agent steps on the day this ships. And it silently restores the
behaviour being fixed, which is the false-green shape this programme keeps finding (`faFallback`
returning fabricated rows; `llmConnected: true` from a probe that only lists models). So:

- `resolveKey` returns **`{ key, shared, secretName }`**, never a bare string. `shared` is the entire
  mechanism by which a sharing workspace can say so, and collapsing the return to a key to tidy it
  up removes the feature.
- `GET /api/workspaces/:ws/tether` reports the **effective** tenant, from Tether's own `whoami` under
  that workspace's key. Deriving it from the existence of a secret row would report a *configured*
  tenant rather than the real one, and a key pasted from the wrong tenant is exactly the mistake that
  would then be reported as correct.
- `secrets/audit` gains `agentTenant` as **its own field**, not an entry in `missing`. Nothing
  *declares* this key, and `missing` is computed from declarations — so without it an unconfigured
  workspace audits perfectly clean while sharing a tenant with every other.
- `kestra:check` asserts that `config.tether.apiKey` / `process.env.TETHER_API_KEY` is read in
  exactly three files: `config/index.ts` (defines it), `agent-runtime.service.ts` (decides), and
  `tether-client.service.ts` (constructor default, for health and profile calls). A fourth reader
  would not fail anything — it would work perfectly and report nothing, which is why this is a grep.

⚠ **Two keys differing is not two TENANTS.** Only Tether can say that. The unit test asserts the
comparison it can — two workspaces resolve two different keys, and an unreadable key is refused
rather than downgraded — and the tenant-id half is an operator check, written down as one.

---

## D-43 — a second domain gets its OWN read-only role, not a shared `foundry_ro`

*Programme 3, Stage 1. `demo/finance/seed-finance-db.ts`.*

`hr_demo` and `hr_demo_alt` share `foundry_ro`, and that was right: they are two *shapes* of one
demo, and the swap rehearsal's claim is precisely that only the data changes. Finance is not a shape
of HR — it is a second tenant — so it gets `finance_ro`, with `CONNECT` on `finance_demo` and on
nothing else.

Three reasons, in order of how much they matter:

- **Blast radius.** Revoking one tenant's data credential in an incident must not take the other
  tenant down. This is the same argument that made ops-api's reader `ops_ro` rather than
  `foundry_ro`, and it is the one that would still hold if the datasets were identical.
- **A mis-copied DSN fails loudly.** Two databases behind one role differ only in the path segment of
  the connection string, so a copied DSN with the wrong database name authenticates fine and reads
  the wrong tenant. With two roles it 401s.
- **`verifyFinanceReadOnlyRole` can assert the boundary.** It checks
  `has_database_privilege('finance_ro', 'hr_demo', 'CONNECT')` is **false**, which is a statement
  about isolation that a shared role cannot make about itself.

The grant code is a **deliberate second implementation** rather than a parameterisation of
`ensureReadOnlyRole`, following the precedent `alt/seed-alt-db.ts` already set. That is the one part
worth arguing with — duplicated security code drifts — so the compensating control is that
`finance:verify` re-derives every privilege from `pg_catalog` rather than trusting the grants, and
fails on any write privilege, on `CREATE` in `public`, and on `CONNECT` to the HR database. The
duplication is checked by outcome, not by review.

---

## D-44 — the read-only gate verifies from the REGISTERING process, so it needs `verifyVia`

*Programme 3, Stage 1. `services/datasource.service.ts`. Caused by I-36.*

D-40 refuses to store a datasource credential it cannot prove is read-only, and it proves that by
connecting. The DSN it stores has to resolve for whoever later *reads* it — the API container, which
reaches the demo databases at `host.docker.internal:5433`. The check runs in whoever is *registering*
it, and for every `demo:*` provisioner that is a HOST process, where `host.docker.internal` does not
resolve on Linux. So the gate refused a demonstrably read-only credential and `pnpm demo:seed` failed
outright (I-36).

This is the **same split `OPS_API_BASE` / `OPS_ADMIN_BASE` already exists for**, arriving in a second
place. The fix has the same shape: `create`/`update` take an optional `opts.verifyVia` — the DSN to
*connect with*, while still storing the one given.

Two things keep it from being a hole:

- **`assertSameCredential` requires the two to differ in HOST AND PORT ONLY.** Scheme, user,
  password, database and query parameters must match, and the refusal names the field that differed.
  Postgres and MySQL privileges are properties of `(role, database)` and not of the hostname used to
  reach them, so under that constraint the verdict on one genuinely is the verdict on the other —
  while "point the check at a harmless database" is rejected by name.
- **It is a function argument, never a schema field.** `routes/datasources.ts` passes the zod-parsed
  body and nothing else, so no HTTP caller can reach it. ⚠ Adding `verifyVia` to
  `createDatasourceSchema` would turn the gate off from outside; do not.

---

## D-45 — the Finance tool catalogue is its own module, not a filter over HR's

*Programme 3, Stage 1. `demo/finance/finance-tools.ts`, `finance-tools.test.ts`.*

Finance registers 8 tools against the same ops-api services, with the same credentials and the same
auth styles. The obvious implementation is `demoToolCatalogue().filter(...)`, and it is wrong for two
separate reasons.

**The seven `hr_*` tools must not be registered.** They are HTTP endpoints over the `hr_demo`
database, so a Finance flow holding them could read another tenant's employee directory over the
network — a cross-tenant read that no datasource boundary catches, because it does not go through a
datasource. `finance_ro` stops Finance reaching HR by SQL; leaving these out is the same boundary on
the tool side, and Finance holds no `HR_DIRECTORY_TOKEN` so even a hand-written row would 401.

**The descriptions ARE the interface.** `chat_post_message` lists the HR channels and
`mail_send_template` lists the HR templates; a Finance drafter reading those writes a flow that 404s
or 422s. Finance gets `#finance-ops` / `#ap-alerts` and `invoice_chase` / `expense_over_policy` /
`budget_variance`, all added to ops-api.

What a filter would have given for free is that the two catalogues cannot drift onto different
endpoints, so `finance-tools.test.ts` asserts it instead: for every shared name, identical URL,
method, `secretEnvName`, `authStyle`, `authParamName` and parameter KEYS — and no `hr_*` entry. It
earned its place on the first run by catching a dropped `model` parameter on `llm_complete`.

⚠ **The honest cost, stated rather than engineered around: `bearer` is the HR directory service's
style, so it is the one style Finance does not exercise.** Inventing a Finance directory service to
reach four-out-of-four would be building a service to satisfy a checklist.

---

## D-46

**The canvas has ONE node model, and both views adapt into it.**

`/runs/[id]` draws from Kestra's topology plus `flow_step_runs`; `/flows/[id]` and
`/flows/new` draw from the model's `dependsOn`. Either could have had its own renderer.
They must not: the entire argument for a canvas is that a person understands the
automation from the picture, and two pictures of one flow that colour, order or badge
nodes differently is the disagreement `lib/flow-graph.ts` was extracted to prevent
between the strip and the old column graph.

`lib/canvas-model.ts` is pure — no React, no layout, no DOM — which is what makes the
seam rule testable. `canvas-model.test.ts` asserts that both adapters classify the same
step identically; that test is the whole of the guarantee.

⚠ **Position is derived every render and must never become state.** A flow model has no
coordinates. The moment a node carries an `x`/`y`, layout is a second thing that can
drift from the graph — a step removed from `dependsOn` leaves its box floating, and two
people reviewing one revision see different pictures. `lib/canvas-layout.ts` runs dagre
over the edges, every time.

**The model-seam badge is the one safety claim the canvas makes, and it fails CLOSED.**
`seamOf(kind, ref)` returns `"agent"`, `"llm"`, `null` or **`"unknown"`**. A `tool` step
whose ref could not be read is `unknown`, never safe — a privacy marker that renders "no"
when it means "cannot tell" is worse than no marker. The rule is narrow by construction
(`agent` steps, and `tool` steps whose ref is `llm_complete`) and the legend states that
bound on screen rather than implying coverage it does not have. `ui-honesty-check.sh`
asserts `llm_complete` is *compared* in exactly one file.

This is why **`StepView` grew a `ref` field** (`flow-visibility.service.ts`): without it
the run view could not tell an `llm_complete` call from any other tool, and would have
drawn a clean card over a step posting rows to a provider. It is joined from `flow_steps`
at the execution's **own revision**, never the flow's current draft — approval binds to a
revision, and describing a run with a definition it did not execute is the same class of
error one level along.

## D-47

**Two authoring modes, and OUTLINE is the default.**

`/flows/new` offers *"I'll write the steps"* (default) and *"Design it for me"* (the
existing goal path). In outline mode the person writes the steps, one per line, and the
drafter may only choose the KIND, the REF and the EXPRESSIONS for each — the sequence is
theirs.

Outline is first because it is the mode where a person can predict what they will get. In
goal mode the shape is the model's choice and the reviewer's first sight of it is after
minutes of inference, which is a long way to travel to discover the answer is "not that".
In outline mode the DAG is on screen from the first line typed, **before any inference is
spent**.

⚠ **A prompt rule the model can ignore is not a control.** `OUTLINE_RULES` declares the
steps authoritative; `validateOutline()` is what makes that true. A draft whose step count
does not match the outline is a FINDING, so the redraft loop re-asks with both numbers
named. That is the one thing worth re-asking for — unlike a refusal it is a mechanical
mistake, not a judgement.

Three properties are pinned by tests:

- The outline block is appended **after** GOAL, so a goal-mode prompt remains a literal
  PREFIX of the outline-mode one. Everything above stays byte-identical across the
  workspace, which is the only reason the prefix caches (measured: 292 → 8,322 chars).
- Goal mode gains nothing. Every existing harness and measurement (`kestra:refusal`) ran
  through it, and a leaked block would make those numbers incomparable.
- `validateOutline` checks the COUNT and nothing else. Whether step 3 is *about* line 3 is
  not checkable here, and matching keywords would be a check that fires on wording.

**The refusal arm is untouched.** An outline does not make a contract satisfiable: if a
step needs a threshold nobody supplied, the fragment still refuses and there is still no
Retry button (§6.7, D-38).

Measured by `pnpm --filter @foundry/server outline:measure` — a MEASUREMENT, not a gate,
with a goal-mode control arm. High agreement in the control means the cases are too easy,
not that outline mode works.

## D-48

**Generation progress is advisory, and indeterminate until it can honestly be otherwise.**

`flow_generation_jobs.progress_json` carries `{phase, done, total, stepId}`, written
fire-and-forget from inside `runGeneration`. Three things are load-bearing:

- **`total` is NULL while drafting**, because nobody knows how many fragment calls a flow
  needs until the draft names its `code` steps. The UI renders that as an indeterminate
  sweep with **no percentage**. A bar showing 12% from an invented denominator turns
  "still working" into "stuck" on a five-minute operation — worse than no bar.
- **It never decides anything.** `status` is authoritative. A poller stopping when
  `done === total` would stop before the flow row exists. The column comment says so.
- **`setProgress` filters on `status = 'running'`** — the last fragment's callback and the
  terminal write are microseconds apart, and a progress write must not resurrect a
  finished job as running-looking. The write is also `.catch(() => {})`: losing a bar is
  cheaper than losing minutes of paid inference.

## D-49

**A flow built on the canvas is posted as the DRAFTER'S RESPONSE, through the drafter's
own path — not to a `createFlow` route.**

Programme 3, Stage 5. CLAUDE.md kept `POST /workspaces/:ws/flows` a deliberate GAP twice,
with a precise reason: *"a `createFlow` taking arbitrary JSON would be a step palette by
another route."* Stage 5 builds the step palette, so the reason had to be answered rather
than argued away.

It is answered by where the model goes. `FlowBuilder` emits the shape `draftResponseSchema`
accepts — a `code` step carries a **contract and no code** — and posts it as `authored` to
`POST …/flows/generate/jobs`. `runGeneration` then branches exactly once:

```
authored ? authorFlow(...) : draftFlow(...)   →  generateFragments  →  flowService.create
```

`authorFlow` is `draftFlow` with the inference call removed and nothing else: the same
`parseDraft`, the same `validateModelExpressions` (D-22), the same `splitDraft` — so
`outputKeys` is **derived from `contract.output` and cannot be sent** — the same
`unknownRefs`, the same `validateModel`. Four consequences, all of them the point:

- **A hand-authored model cannot reach a weaker path than a generated one.** Not because
  the canvas is careful, but because there is one path and the branch is above it.
- **`outputKeys` stays underivable from the client.** The one guarantee that would
  otherwise have to be re-argued for hand-authored models: a step declaring one contract
  and enforcing another surfaces as a `contract_violation` blaming the fragment for
  obeying the contract it was handed.
- **A `code` step placed on the canvas is still GENERATED.** There is no code box in the
  inspector and no `code` field in `lib/flow-authoring.ts`; `ui-honesty-check.sh` asserts
  the absence, because a body typed on a canvas is code no contract describes.
- **The refusal arm is shared.** A canvas flow whose contract is insufficient refuses
  exactly as a drafted one does, with the same terminal status and no Retry button.

Two deliberate differences from `draftFlow`. `authorFlow` returns **every finding at
once** and has no retry loop — a model handed six findings fixes the loudest and re-breaks
the rest, but a person at a canvas wants the whole list so the form can mark six fields.
And it runs `flowValidator.checkFlowShape` **before** generation; see I-48.

⚠ The raw `POST /workspaces/:ws/flows` still exists and is what the `kestra:phaseN`
harnesses use. What changed is that it is no longer the only way to create a flow from a
model, so `e2e:ui` stopped recording three GAPs for one fact.

## D-50

**The canvas asks two questions and BUILDS the expression; it does not ask for one.**

`paramsExpr` is a Pebble template wrapping a jq program, and D-22 allowlists what it may
contain: five roots, seven callables, everything else rejected **by name**. That is a good
boundary and a terrible text box, and the evidence is measured rather than supposed —
`outline:measure` had a draft refused for using a jq variable binding. A model hit it.

So `components/flow/StepInspector.tsx` is a **form per kind**. It asks *which upstream
step* and *which of its fields goes into which parameter*, and `lib/flow-expr.ts` turns the
answers into a string that is inside the allowlist **by construction**: every emitted
expression is assembled from `outputs.<id>`, `inputs.<id>`, a literal, and the `json`/`jq`
calls already permitted. No code path writes a function name it was given.

Five things are load-bearing:

- **Input and output are NOT uniformly editable, and pretending otherwise is a lie.**
  Output is editable for `transform` and `code` only. A `datasource` or `tool` step's
  output is the query's columns or the endpoint's response — an editable box there lets
  someone type a shape the call is going to ignore.
- **The per-kind output shapes are DATA, served by the catalogue** — `flow-output-shape.ts`,
  and `flow-output-shape.test.ts` asserts each one appears verbatim in `DRAFT_RULES`. Until
  Stage 5 the knowledge existed only as four lines of English addressed to a model. The
  prompt is deliberately not generated from the table: its bytes are a measured artefact
  (`kestra:refusal`, `outline:measure`), so a test on drift is the cheaper half of the trade.
- **The D-22 allowlist is SERVED, never hardcoded in the browser.**
  `validateAgainstAllowlist` takes the list as an argument and `GET …/catalogue` supplies
  it; `ui-honesty-check.sh` asserts no member is named in `flow-expr.ts`. A client copy
  drifts silently in both directions — a name the server never allowed shows green and
  fails on save, and a missing one refuses valid expressions with the server disagreeing.
- **The date control is I-42 as a checkbox.** `split("T")[0]` is offered per field rather
  than applied automatically, because only the person knows which columns are dates and
  splitting a non-date truncates it silently.
- **A flow input inside a jq program is concatenated with `~`, never interpolated.** I-11:
  Pebble does not re-evaluate `{{ }}` inside a filter argument, so
  `jq('{"p": "{{ inputs.period }}"}')` ships the literal braces. It is also wrong a second,
  quieter way — a nested `{{` truncates the outer template for anything scanning it, so
  D-22's own check reads half an expression. Both found by writing the builder's tests.

## D-51

**Position on the canvas is derived every render, in edit mode too.**

`nodesDraggable` stays false when `editable` is on. A flow model has no coordinates; the
moment a node carries an `x`/`y` the layout becomes state that can drift from the graph,
and then the picture and the flow disagree about which one is the flow. dagre lays it out,
always — the same rule D-46 set for the read-only canvas, kept rather than relaxed when
dragging arrived.

What `editable` actually turns on is connecting and deleting, and neither of them writes:
`FlowCanvas` reports an intent (`onConnectSteps`, `onDisconnectSteps`, `onDeleteStep`) and
the page applies it through the pure functions in `lib/flow-authoring.ts`. That is what
keeps "a cycle is refused", "a deleted step takes its inbound edges with it" and "a gate is
spliced BEFORE its target" properties of tested functions rather than of event handlers.

⚠ `spliceApproval` is now the **only** implementation of gate placement.
`FlowReview` had its own copy for a stage; two implementations of "before, not after" is
one implementation and one bug waiting, and the wrong one compiles, deploys and stops
nothing.

## D-52

**A draft run reads the sandbox because of its NAMESPACE, and there is no flag.**

The exposure this closes was verified in code, not suspected: `resolveRef` had no
draft/live distinction, so a **test** run read the tenant's real database. Gate 1 *requires*
a successful run before a flow may be armed — so a flow with an `agent` step sent real rows
to an external model **before anyone had approved anything**, at the least supervised moment
in the lifecycle.

```
foundry.<tenant>.<ws>.draft  →  sandbox DSN   (fixtures)
foundry.<tenant>.<ws>        →  real DSN      (production)
```

The selector is the execution's Kestra namespace, read off the `flow_executions` row that
`POST /api/executions/begin` wrote **from Kestra's own record of the execution** (I-07).
Not a request parameter, not a header, not a column anyone can toggle: `stepBatchSchema` has
no field for it, so a flow cannot ask, and `routes/steps.ts` is the only caller of
`envForExecution`. Approval already binds to the live namespace and
`flow-approval.service.ts` is its only writer, so this inherits an enforced boundary rather
than adding one.

Four things travel with it.

- ⚠ **A draft run against a datasource with NO sandbox reads production, and says so on
  every batch.** Refusing sounds stronger and is worse: every existing flow, harness and demo
  does its gate-1 test run against a real datasource, so a hard refusal on day one is a change
  everybody routes around — and what gets routed around is the control. The property that
  actually holds is *if a sandbox exists, a draft run reads it, and nothing in a request can
  change that*; when one does not, `StepBatchResult.readFrom` is `production`, a warning names
  the datasource, and the run view and the datasource page both render it.
- **`flow_step_runs.read_from` is PERSISTED, never recomputed.** The answer depends on
  whether a sandbox existed *at the time of the run*, and deriving it later from the
  datasource's current state would rewrite the history of every draft run that read
  production the moment somebody provisions one — turning the record of an exposure into a
  record of there never having been one. Same reason `flow_executions.flow_revision` is
  copied rather than looked up through the flow.
- ⚠ **It fails CLOSED: an unrecognised namespace is `draft`.** The wrong answer in that
  direction reads fixtures on a production run — a wrong result, loudly, on a run somebody is
  watching. The other direction silently ships tenant rows to a model during development.
- **`parseNamespace` is SHARED with `routes/executions.ts`** and counts segments against the
  configured prefix instead of matching a `draft` suffix. Two copies existed and disagreed on
  one case: a workspace whose slug is literally `draft` has the live namespace
  `foundry.default.draft`, which the suffix rule read as a draft run — so a production
  execution would have read the sandbox. Found by `execution-env.test.ts`; see I-55.

**Gate 1 still requires a supervised real run before arming, deliberately.** A sandbox run
proves the flow executes and agrees with its fixture. It cannot prove correctness against
production units, and that is measured rather than cautious — `hr_demo` stores attendance
0–100 and `hr_demo_alt` as a 0–1 fraction, and the swap rehearsal found three real bugs on
its first run. Same rule Phase 6 states for imports: **never describe it as validating a flow.**

## D-53

**The fixture is DATA in `foundry_parent`; the sandbox database is a projection of it.**

The plan asks for fixtures "generated once and frozen, versioned like a `code` fragment", and
a materialised database is the wrong home for that: it is mutable by anything holding its
owner credential, it is outside `pnpm backup`'s core list, and a re-provision that quietly
produced different rows would make yesterday's passing test fail for a reason nobody could
reconstruct.

So `datasource_fixtures` holds the rows, the DDL and the shape fingerprint — insert-only,
versioned, with no update path — and `sandbox:rebuild` replays them byte-identically without
asking a model again. `kestra:sandbox` block 6 asserts exactly that, by digesting every row
in the sandbox before and after a rebuild.

Consequences worth stating:

- **`foundry_sbx_*` is in neither of `backup.sh`'s lists, on purpose**, and that is written
  into the script beside the lists. Restoring `foundry_parent` restores the fixture; one
  command rebuilds the rest. Every other new database still has to go in a list.
- **The sandbox is Foundry-owned because it cannot be anywhere else.** D-40 refuses to
  register a datasource Foundry can write to, so Foundry structurally cannot create these
  tables inside a tenant's database. It is `hr_demo`, generalised.
- **Same schemas, tables, columns and types as the source**, so not one line of named-query
  SQL changes between a draft run and a live one. A query that failed in the sandbox for a
  shape reason would be a test teaching the wrong lesson.
- **Provisioning builds in `<db>_stg` and promotes by `ALTER DATABASE … RENAME`.** See I-54:
  the in-place version replaced the rows *before* the taxonomy check could refuse them.
- ⚠ **Two things the copy does not reproduce, both stated in `shape.notes` rather than
  guessed at:** a view becomes a plain table (introspection records a view's columns, not its
  definition), and UNIQUE constraints are absent (introspection records primary keys only, so
  the sandbox is *more* permissive than production). Inferring either from column names would
  produce constraints production does not have — the same error in the other direction.
- **An unmappable column type is a REFUSAL that names the column**, never a widening to
  `text`. An enum widened to text accepts values the real column rejects, which is the
  "invented enum value" failure mode the migration measured; and `SUM()` over a text column is
  an error at best.

## D-54

**The model writes the fixture; deterministic code decides whether it is good enough.**

`buildTablePrompt` takes a shape and a set of already-generated key values. It has no
database handle, no DSN, no datasource id and no way to obtain one — asserted against the
function's own source in `sandbox-fixture.test.ts`, because the failure would be somebody
adding "a few example rows help the model" and no behavioural test would catch it (the
fixture would still load, and would look *better*).

⚠ **The model must never be shown real rows to imitate.** Not as examples, not summarised.
The moment it is, the fixture is a lossy copy of production and the sandbox stops being a
substitute for it — it becomes a redistribution of it. As written the generator adds **zero**
exposure: the schema is already the largest block of the drafting prompt.

The three named traps, and what answers each:

1. **A self-agreeing oracle.** The model certifies nothing. `verifyTaxonomy` is deterministic
   code running **SQL against the loaded database** — not against the JSON the model returned,
   because `numeric(5,2)` silently rounds 80.955 to 80.96 and a check reading the JSON would
   certify a boundary case the query cannot see. It can and does fail a fixture the generator
   was perfectly happy with. Same argument `demo:rehearse` uses for keeping its oracle a
   separate function.
2. **"Tested on fixtures" ≠ "correct on production."** Nothing claims otherwise; the caveat is
   on the datasource page, on the step, and in `runNamedQuery`'s own warning.
3. **A generated artefact is load-bearing.** D-34 says a model's output must be terminal, and
   a fixture is consumed by every draft run — this deliberately crosses that line. The
   compensating controls are: verified before acceptance, frozen after it, and fingerprinted
   against the shape it was written for.

Three more things are load-bearing:

- ⚠ **Every taxonomy category has a checker and every checker has a category**, asserted by a
  test. A category asked for in the prompt and never verified is a promise nothing checks, and
  on screen it reads exactly like one that was checked.
- **A satisfied category must carry EVIDENCE** naming the table, column and values. A check
  that answers "yes" without saying what satisfied it is unfalsifiable — it reads identically
  whether it looked or not.
- **`duplicate` requires a near-unique column (>70% distinct).** A repeated department name is
  a category, not a duplicate record; without that bound the check passes on every fixture with
  an enum in it, and a control that cannot fail is worse than none.

**MEASURED, 2026-08-02, `google/gemma-4-26B-A4B-it`: 2 of 2 runs passed all seven categories
on the first attempt**, ~256 s over 7 tables (one inference call each) against `hr_demo`'s
shape. Evidence from run 1: `hours_worked` 7.9 and 8.0 straddling 8; `exit_date` NULL in 11 of
12 rows; a department no employee references; dates over two months; `"Jaxon Vane"` twice;
`"Présent"`. Run 2 was after the I-56 date-window fix and its dates landed in
**2026-06 … 2026-08**, which is the point of that fix.

Two runs on one schema on one model is a reading, not a property — and the harness falls back
to an authored fixture and **says so** when the model's is refused, so the structural blocks
never depend on the measurement going well.

---

## D-55 — the draft prompt declares its own schema, and the worked example is tested

**2026-08-03.** Caused by I-58. The drafting prompt described what to build in prose and showed
one worked example, and the model was then marked against a Zod schema it had never been shown.
Every field name it had to get exactly right — `transform.expr`, the closed set of kinds, the
contract type enum, the numeric bounds — was discoverable only by guessing, and a wrong guess
costs a full redraft: ~30 s of decode re-emitting the entire flow.

So `DRAFT_RULES` now carries a `STEP SHAPES` block: all six kinds, their exact fields, and their
bounds. It sits **above** the catalogue and the manifest, so it is inside the byte-identical
prefix and changes nothing about GOAL staying last.

Two things about this are load-bearing beyond the text itself:

- ⚠ **The worked example is run through the drafter's own validators by a test.** A model copies
  the example's shape far more reliably than it follows prose, so an example that
  `validateModelExpressions` / `checkOutputShapes` / `checkJsonPositions` would reject teaches a
  mistake and charges a redraft for it in every workspace, for ever. This is the assertion that
  catches the *next* instance rather than the last five.
- ⚠ **Placeholders in a schema block are values.** The first version wrote `"timeoutSeconds"?:0`
  as a stand-in and the model emitted `0`, which the schema rejects (`min(1)`). The fix
  introduced a new failure class on its first outing. Bounds are now written `<1..3600>`.

**Not done, deliberately: no structural normalisation.** `contractFieldSchema` maps type
**synonyms** (`integer`→`number`) because a type name has exactly one reading. `valueExpr` is
*not* rewritten to `expr`, and `{"kind":"llm_complete"}` is *not* rewritten to
`{"kind":"tool","ref":"llm_complete"}`. Both would be the parser deciding what the drafter meant
about the flow's **shape**, and a wrong guess there produces a step that compiles and does the
wrong thing — which is the failure mode this whole programme is built around.

---

## D-56 — a finding fed back to a redraft is bounded and grouped

**2026-08-03.** `authorFlow`'s docblock already stated the rule — *"a model handed six findings
fixes the loudest and re-breaks the rest"*, which is why a person at a canvas gets every finding
and a model does not. `draftFlow` honoured it **between** classes (it stops at the first check
that fires) and ignored it **within** one: measured, a single rejected draft fed back **22**
findings, and the redraft rewrote every expression it had and broke a different one.

`pickFindings` caps at six, and groups by the lesson with backtick-quoted spans blanked — that
is where the per-step detail lives, and it is exactly what must not make two instances of one
mistake look like two mistakes.

Two details are the difference between this helping and hurting:

- **A grouped finding NAMES every step it applies to.** Dropping the others is the easy version
  and the wrong one: the model fixes the step it was shown, leaves the other three, and the next
  attempt is rejected for the same reason — which is how three attempts get spent on one mistake.
- **The cap is stated, never silent.** *"22 problems, the first 6 below"*. A model told it has a
  sample knows the list is a sample; a silent truncation under the heading "fix exactly these"
  means "and leave the other sixteen".

---

## D-57 — one output-token budget per CALLER, not one per client

**2026-08-03.** `GatewayInference` hardcoded `max_tokens: 4096` for both callers. A fragment is
one Python function; a draft is a whole flow, and `FLOW_CAPS.steps` is 64. A real job in the
table decoded to the ceiling and was discarded whole — **157.7 s for nothing**, reported with a
message that said *"the fragment is incomplete"* on a draft failure.

`complete()` takes `maxTokens`; `DRAFT_MAX_TOKENS` is 8192 and `FRAGMENT_MAX_TOKENS` 4096.

⚠ It is a real trade and it is stated in the code. Truncation is a **total** loss — nothing is
salvaged and `draftFlow` does not re-ask, because an inference failure is infrastructure rather
than a bad draft. A runaway model now decodes for longer before failing. The measured
frequencies decide it: one truncation in six observed drafts, and the six normal ones never came
within 3× of the old ceiling, so the ceiling was only ever reached by an answer still going
somewhere.

---

## D-58 — the generation seam announces it when it falls back to Tether

**2026-08-03.** `inference.ts` resolves to `GatewayInference` when `LLM_BASE_URL` and
`LLM_API_KEY` are both set and to `TetherInference` otherwise, silently.

Unsetting either reinstates **I-24** — Tether's mandatory `script-gen` skill adding turns after
the model answers, so an `insufficient_contract` refusal arrives as *"the drafter returned no
JSON object"* and is retried instead of reported. It fails **asymmetrically**: satisfiable
contracts keep working, so nothing looks broken until the one case the design exists for.

The fallback now logs, once at boot, what it degraded to and what that costs. Same rule the
Kestra section already states for a degrade-gracefully catch: it has to say what it degraded
**from**, or the class presents as "the field is just null sometimes".

`draft:measure` refuses to run at all without the gateway, rather than reporting a number for
the wrong transport.

---

## D-59 — position is derived, and so is graph identity

**2026-08-03.** Caused by I-59. D-51 already said a node must not carry an `x`/`y`. The canvas
obeyed that and then paid for it on every render, because each call site built its `CanvasGraph`
inline in JSX and `FlowCanvas` memoised its layout on **array identity** — which a freshly
constructed graph never shares.

Two rules now, and they are the same rule at two levels:

- **A page memoises its graph.** `ui-honesty-check.sh` fails on an adapter call inside a `graph=`
  prop. Test files are exempt and that is not a loophole — a test renders once.
- **`FlowCanvas` memoises its layout on the TOPOLOGY**, a string of node ids and edge endpoints.
  Not an approximation: `layout()` reads ids, endpoints and two constants. ⚠ If it ever sizes a
  node by its content, that key has to grow the same day; the failure would be silent and would
  look like "sometimes the boxes overlap".

And the third, which is the one people will not expect: **a node's id is not its label.**
`CanvasNode` gained a `label`, because the outline sketch had been using the typed line as the
id — so an edit was a rename, and a rename is an unmount. An id is stable across an edit; the
text is not. Keep them apart.

---

## D-60 — authorship records a KIND, and the refusal deliberately does not read it

`flow_revisions.created_by_kind` is `user` | `system` | `unknown`, NOT NULL with **no default**,
plus a CHECK. No default is the load-bearing half: with one, a future writer that forgets the column
silently acquires a provenance; with neither, `$inferInsert` makes omitting it a compile error and
the database makes it a loud one.

**Three values, because each is a different answer to "was there a person, and did we verify them?"**
`user` is mintable in exactly one place. `system` is a harness, a seed, a CLI, an import run by a
machine — the name is informative and load-bearing for nothing. `unknown` is written by the backfill
and by nothing else.

⚠ **The backfill is `unknown`, not `system`.** The 37 pre-existing rows came from browsers and from
harnesses and nothing distinguishes them — that absence *is* the gap. `user` would manufacture the
verification the column exists to make honest; `system` would assert no person was involved, which
for the browser-authored rows is simply false. Same reasoning as 0025 refusing to backfill
`flow_step_runs.read_from`: a record nobody took must not be invented later.

⚠ **There is deliberately no `import` value.** The column answers whether authorship was *attested*;
importing is a statement about where the bytes came from, a different axis. A bundle imported by a
signed-in person is authored by that person here — they chose it, and they are who gate 2 will
refuse if they then approve it. Calling that `import` would take a real self-approval out of the
comparison. Two axes in one column is how a value gets used for the question it does not answer.

**And the refusal itself is unchanged.** It still compares strings and still fires for a system
author whose name matches. Refusing every system-authored revision breaks `kestra:phase3`, the seeds
and the regression net, all of which arm flows that way — and a control everybody routes around is
not a control (D-52's reasoning, applied to a different subject). What is new is
`flow_approvals.revision_author_kind`: the record, after the fact, that distinguishes *"a second
pair of eyes was possible and happened"* from *"there was nobody to be the first pair"*.

⚠ **Still not separation of duties** (I-13). Never describe it as such.

## D-61 — the read surface stops addressing Kestra, and the slug becomes its own field

Two changes with one shape: what a client is *given* should be what a client can *use*.

**`test-run` and `fire` are stripped at the ROUTE, not in the service.** `kestra:phase3` reads
`testRun.kestraExecutionId`, and it should — a harness importing a service directly is not a client.
Stripping in the service would have broken the harness to fix the product; stripping at the boundary
fixes the product and leaves the harness alone. `e2e:ui` verifies it by **scanning the body for
engine-shaped values** rather than checking two field names, so a third leak under a new name is
caught too.

**`flowId` is the Foundry uuid; the slug is served as `flowName`.** Nullable, because flowless
Phase-1 history exists. Both halves matter — dropping the slug would have silently cost `/runs/[id]`
its page title and `adapters.ts` its automation name, which is a regression delivered as a fix.

⚠ **`executionBase()` is ONE exported function both routes project through.** I-23 was two identical
bugs in `list()` and `get()`, and fixing one alone would have left the routes disagreeing about what
`flowId` means — which is worse than both being wrong, because then only one is trustworthy and
nothing says which.

## D-62 — `/api/health` reports components; only the process's own prerequisites are critical

Five components — database, migration state, Kestra, ops-api, Tether — each with status, latency and
a **caveat**.

**`status` stays `ok` while a non-critical component is down.** Flipping the endpoint to 503 the
moment Kestra becomes unreachable takes the API out of the load balancer — removing the only surface
that could say *why*, while every read, every flow list and the diagnosis itself still work. Only
the process's own prerequisites (its database, its migrations) are `critical`. `serves` answers *can
this process serve requests*; the component list answers *is everything it depends on healthy*, and
one boolean was conflating two different questions.

⚠ **Every caveat is in the PAYLOAD, not in a doc**, because the false green is this endpoint's whole
failure mode. Tether's names itself: *"`llmConnected` is derived from Tether listing models — a
documented FALSE GREEN."* A caveat that lives in a doc is one the person reading the JSON at 3am
does not have.

Every probe is timeout-bounded — a health check that hangs is worse than one that lies — and the
result is cached **with its age in the response**, so "green" always carries how old it is.

## D-63 — one number, one module, and the window is stated beside the run it applies to

`services/retention.ts` reads `config.kestra.retentionDays` and nothing else, holds no database
handle and imports no repository — so `deploy-system-flows.ts` can use it from the host without
pulling in a connection pool. It exports the coupling as **one sentence** every surface quotes, and a
`replayWindow()` that says how much window a *specific* run has left.

⚠ **"Expiring soon" is a FRACTION of the window, never a fixed week.** Seven days against a 4-day
retention warns nobody in time; against a 365-day retention it warns from day 358. Both are the
warning silently losing track of the thing it warns about.

⚠ **The tests read the number back from `retentionDays()` rather than writing `30`.** A deployment
setting `KESTRA_RETENTION_DAYS=7` must not fail the suite — that is exactly what a hardcoded
expectation does, and the fix somebody reaches for is a second default, which is the failure the
single source exists to prevent. The one test that needs a different window moves the single source
and restores it, because `replayWindow` refuses a `days` parameter for the same reason.

---

## D-64 — a datasource is refused for WHERE it points, and the address is not how that is decided

`docs/GAPS.md` §1.3 · `services/datasource-target.service.ts`

D-40 asks *what can this credential do*. It never asked *what is it pointed at*, and those are
independent: a **read-only** credential on `foundry_parent` passes the read-only gate with zero
findings, and it is precisely the credential you would want in order to read every workspace's
secrets, encrypted DSNs, flow revisions and generated fragments. So registration now asks the
second question too, before the first — running the privilege check first produces a clean verdict
on the one target that must never be stored.

**⚠ The host allowlist §1.3 proposed is the WEAKER half, and shipping it alone would have been I-38
twice.** Unset by default it cannot fail, and the deployments that never configure it are exactly
the ones that needed it. Set, it is walked past by spelling the same database differently —
`postgres`, `127.0.0.1`, the container IP, `host.docker.internal:5433`, a pgbouncer, a tunnel. It is
here, opt-in, and **`null` when unset rather than `[]`**, so "this deployment has not expressed an
opinion" is a state the verdict reports instead of a silent pass. `DATASOURCE_HOST_ALLOWLIST`.

**What actually refuses is identity, and it has no address in it.** Two arms, each covering the
other's blind spot:

- **(cluster, database)** — `pg_control_system().system_identifier` plus `current_database()`. Exact,
  and no hostname, proxy or tunnel changes it. ⚠ The **pair**, never the cluster alone: `hr_demo`,
  `hr_demo_alt`, `finance_demo` and the sandbox all live on the same cluster as `foundry_parent`, so
  a cluster-level refusal takes the whole regression net with it. Measured on a genuinely
  low-privilege connection (PG 16.11, a fresh `nosuperuser` role): `system_identifier` reads fine. A
  cluster where it cannot be read records `clusterId: null` — an unanswered question, never a clean
  bill.
- **The table-name signature** — what catches a control plane on a *different* cluster (a second
  deployment, a replica, a restored backup), where arm one has nothing to compare against. The
  parent's signature is **derived from `db/schema.ts`**, so a migration that renames a table updates
  it the same day; a hardcoded list is a second definition of Foundry's schema and drifts in the
  direction that stops matching.

**The thresholds come from a measurement, not a guess.** Every database on the deployment cluster,
scored against all three signatures: `hr_demo`, `hr_demo_alt`, `finance_demo` and
`foundry_sbx_3affba7b…` score **0 / 0 / 0**; `foundry_ops` scores 4 (min 3); `kestra` 8 (min 4);
`foundry_parent` 21 (min 8). Every tenant database is a zero, so the positive control is not a near
miss — and `kestra` and `foundry_parent` each score **2** against the other's signature (`flows`,
`triggers`, names they genuinely share), which is what a threshold of 1 would have turned into a
refusal naming the wrong subject.

**⚠ What was measured about the risk first, because "it would be bad if" is not evidence.**
`foundry_parent`'s ACL is `{=T/foundry, foundry=CTc/foundry}` — CONNECT revoked from PUBLIC, so no
tenant-shaped role reaches it today. That is a property of the **cluster**, not of Foundry, and
nothing re-asserts it. `kestra` and `foundry_ops` have `datacl = NULL`, the default, which grants
CONNECT to PUBLIC: `foundry_ro` connects to both, reads 0 tables and writes 0 tables, so D-40
returns `readOnly: true` and Foundry would store a datasource pointed at the engine's own database.
Harmless in content terms today, and one `GRANT SELECT … TO PUBLIC` away from not being.

**Three things this deliberately does not do.** It is **not a firewall** — nothing here stops the
API container reaching a host; it refuses to *store* a datasource that resolves to one of three
things, and reachability belongs in the network. It says nothing about a **tenant's own** database,
which is §1.3's second half and a product decision that stays open. And a **false positive is
accepted**: a tenant database genuinely containing eight of Foundry's twenty-one table names
together is refused. Co-occurrence is what makes that essentially impossible; matching any single
name would refuse every database with a `tickets` table.

**The test plants the credential it must refuse, and the positive control is the whole tenant set.**
A `nosuperuser` role with CONNECT and no table grants — one D-40 is perfectly happy with —
registered against `foundry_parent` **by a second address for the same cluster**, because a
hostname denylist passes that and asking the cluster who it is does not. All three tenant databases
must be ALLOWED, or `demo:seed`, `demo:seed-alt`, `finance:seed` and `sandbox:provision` break on
their first run. One test asserts the gate is **wired into `datasourceService.create`** rather than
merely correct, and it was proven to fail by removing the call.

---

## D-65 — an agent step DECLARES that it wants an answer, and that is what `profileId` never did

`docs/GAPS.md` §7.1 / §7.2 · upstream `Foundry-Harness@f4ac654` ·
`../Foundry-Harness/plans/agent-step-run-contract.md`

Tether took defects B and C, together and in that order, and the `activeRuns` orphan alongside
them. Foundry's whole side is one field — `agentRunService` sends `expects: "answer"` — but the
reason it matters is the thing 8.3 got wrong and I-34 round 3 corrected.

**`skills: []` could never remove a mandatory skill.** `script-gen` was merged into every run
unconditionally, so an `agent` step asking a question about data was handed a `RESULT.json`
obligation, then nudged one extra turn for failing it — and that nudge is what destroyed the answer
(defect A). 8.3 passed `profileId` (`mode: "chat"`, `skills: []`) and it *looked* protective;
instrumenting Tether withdrew that entirely, with the nudge firing **27 of 27** in both arms.
`expects` is a declaration the merge actually reads. **`profileId` stays** because chat mode is the
honest declaration for a step that asks a question — it is just not the mechanism.

⚠ **Three refusals inside this that are the same rule from different ends.** An unrecognised
`expects` is a **400**, never a silent fall back to `"script"` — a field accepted and ignored reads
to the next person as a field that works. `deriveStatus` treats anything but `"answer"` as
`"script"` as a fail-closed second layer, because the wrong direction to be wrong in is granting
the weaker contract. And an answer-run that completes and says **nothing** is `needs_review`, not
`succeeded`: with no `RESULT.json` to check, the only remaining evidence the agent did the job is
that it spoke.

⚠ **`outcomeOf` deliberately did NOT change, and the branch must stay.** It still maps
`needs_review` to a non-failure. Removing it would be a tidy that introduces a version coupling on
a runtime living in a different repo and a different compose stack — an older Tether ignores
`expects` and returns `needs_review` for every answer run, so every agent step against such a
deployment would become a failed step. And the value now *carries information* on an answer run
rather than being structural, which is the opposite of a reason to collapse it.

**Measured as a matched pair on the live runtime, same prompt and same profile.**
`expects: "answer"` → `succeeded`, contract echoes `expects: "answer"`, `[Run] no nudge` logged.
The control → `needs_review`, `expects: "script"`, nudge logged. Both answered correctly — without
the control the `succeeded` could have come from anywhere.

**The orphan fix travelled with it and is worth knowing for its shape.** A restart used to leave
every in-flight run at `running` for ever. The one-line fix — fail every non-terminal run at boot —
passes the obvious test and, with two processes, kills the runs of the sibling still working on
them. So a run records its owner and every process heartbeats; reclamation touches only owners that
are provably gone, plus rows with no owner at all (nothing can ever claim those, and leaving them
is the bug). **5 real orphans reclaimed on the first boot.** ⚠ It did **not** make Tether
multi-replica — cancel and HITL still need the in-process handle — and that limit is now stated at
the wire (409 naming `ownerInstance`) instead of being implied by a misleading "not in flight".

---

## D-66 — the four things that fail silently get an endpoint, and `unknown` is one of its states

`docs/GAPS.md` §6.1 · `services/operational-signals.service.ts` · `GET /api/signals`

§6.1 named four failure modes and its own evidence was the damning part: *"every failure mode this
repo documents was found by running a harness by hand."* All four are invisible to `/api/health`
(D-62) and not by omission — **none of them is a reachability failure**. Kestra is up, the flow is
armed, and nothing runs. The execution is PAUSED and looks like an agent thinking. The sweep logs
only when it suspends something, so its silence is indistinguishable from success. A workspace is
refused by a fairness control, truthfully.

**⚠ It is AUTHENTICATED and must never be merged into `/api/health`.** `/api/health` is open because
a probe and a status pill need it, and it names nothing — `sanitizeDetail` strips URLs, hostnames and
ids. This route names **workspaces and flows**, which is a description of the customer base. The
merge is the obvious tidy and it either drags tenant names onto an open route or puts the liveness
probe behind a credential.

**⚠ `unknown` is a first-class state and it is the whole difference between this and a dashboard
that lies.** A signal with nothing to go on must not report `ok`. Verified live: immediately after a
restart the rollup is `unknown` — *"the scheduler started recently and has not reached its first
sweep yet"* — and flips to `ok` (*"last sweep 4s ago — checked 4, suspended 0"*) only once one has
actually run. `unknown` deliberately ranks **below** `warn` in the rollup: it means *nobody knows*,
not *something is wrong*, and ranking it above a real warning would bury the warning.

**Three deliberate limitations, each stated in the payload rather than in a comment.**

- **The scheduled-flow period is LEARNED from execution history, never parsed from the cron.**
  Parsing needs a dependency and a timezone-correct evaluator, and it answers the wrong question:
  it tells you what the flow was *configured* to do while the failure sought is a flow not doing it.
  Observed gaps also catch a schedule that has been firing at the wrong cadence since the day it was
  armed, which no parser can. It needs **≥3 runs** (2 gaps) and uses the **widest** gap, not the
  median — a weekday-only schedule has a legitimate 3-day gap every weekend, and a median threshold
  would page somebody every Monday.
- **The agent-poller signal compares this PROCESS's watcher set against the database work list.** The
  interesting number is the difference, not the size: a row in `tether_run_id IS NOT NULL AND
  resumed_at IS NULL` with no watcher is a Kestra execution paused with nobody coming back for it.
  `reattachAll()` makes that set empty at boot and nothing checked afterwards that it stayed empty.
- **The slot signal does NOT ask Kestra.** `reconcileRunning` is the authority and costs one engine
  call per in-flight row; its own docblock says to call it only on the refusal path, and a monitoring
  endpoint polled every 30 s must not be that path. So it reports the *shape* of a leak — old rows,
  at the concurrency cap, which is exactly how I-10 presented — and says plainly it has not asked.

**⚠ A signal that throws becomes an `unknown` entry, never a dropped one.** A report that silently
omits the check that broke is the exact failure this endpoint exists to prevent, one level up.

**⚠ The test drives the sweep signal through EVERY state it claims** — never-started, post-boot
unknown, up-but-never-swept, stopped-sweeping, sweeping-with-errors, and healthy. Four checks that
all report `ok` against a healthy deployment are indistinguishable from four checks that are broken,
and that is I-38 in the one place least likely to be noticed: nobody investigates a green monitor.
The healthy case is included as the positive control, without which "always alarms" scores 100%.

**What this is NOT** is alerting, and §6.1b records that. It gives an alert the answers it would
need; something still has to read it, and choosing what needs a deployment target.

---

## D-67 — roles exist, the check is at the ROUTE, and an unclaimed workspace refuses

`docs/GAPS.md` §1.1 · migration `0027_workspace_members` ·
`services/workspace-member.service.ts` · `middleware/identity.middleware.ts` (`requireWorkspaceRole`)

Gate 2 and gate 3 refused *self*-approval and nothing else. Stage 9 made the approver's NAME
verified; it never made the approver AUTHORISED, so anyone who could sign in could approve
anything, anywhere. `workspace_members` is the roles: `author` | `approver` | `admin`, keyed on the
identity **subject** rather than the email, because an address can be reassigned and a person who
changes theirs must not inherit or lose a role silently.

**⚠ Say this and only this: *a person who has not been granted the approver role in this workspace
cannot approve in it*.** It is still **not** separation of duties (I-13) and the phrase stays
forbidden unqualified — anything holding `RUNTIME_JWT_SECRET` mints any identity, `e2e:ui` does,
and a minted identity with an approver row approves. The bar moved from *"can sign in"* to *"can
sign in AND was granted the role"*; it did not move past the signing secret.

**⚠ The check is at the ROUTE, and that is the opposite of this codebase's usual instinct.**
`flow-approval.service.ts` is "the only module that writes to the live namespace" precisely so the
property is greppable. This is different in kind: it is an authorisation decision about a
**request**, and it needs `req.user`, which a service called from `scenarios:seed` does not have.
In the service it would mean either every harness acquiring a fake privileged identity — a role
model satisfied by a constant — or every harness breaking, which is how a control gets reverted.

The mitigation for the usual objection is a **pair** of tests: one reads the route tree and fails
if any file reaching `flowApprovalService.approve/revoke` or `stepApprovalService.decide` lacks
`requireWorkspaceRole`; the other asserts that scan **finds those call sites at all**, so a rename
cannot leave the first one scanning nothing and reporting green for ever. ⚠ The first is written as
*what must be present*, not as a pattern that resembles a violation — I-62 is the record of the
opposite producing three false positives and zero real ones.

**⚠ Zero members is a REFUSAL and migration 0027 backfills nothing.** Three shapes were considered
and two are traps:

- *Backfill every identity as admin* → a role model that grants the role to everybody, i.e. the
  control it replaces, with a table.
- *No members ⇒ allow* → a control that turns itself off exactly where it was never configured,
  which is everywhere it matters.
- *The first person to approve becomes admin* → a gate that grants the role to whoever arrives.

So claiming is its own endpoint, identity-only (requiring a role to create the first role is a
workspace nobody can ever act in), refused the moment the workspace has **any** member — including
one whose role is only `author`, because "unclaimed" means empty and the other reading lets a
stranger escalate past a workspace's lowest-privileged member. The row records
`granted_by = 'bootstrap'` for ever, so a claim stays distinguishable from a grant. ⚠ **On a
deployment where anyone can sign in, the first person to claim an unclaimed workspace owns it.**
Stated, not hidden.

**The last admin cannot be demoted or removed.** A workspace with members and no admin can never
grant again — `claim` refuses it too, because it has members — and the only repair is a database
edit.

**`e2e:ui` gained two steps rather than routing around the change**, which is its one rule: a
signed-in caller holding no role in the workspace is refused with a 403 that names the next step,
and then the workspace is claimed and the author granted. ⚠ The author is granted **`approver`**,
not `author`: granting the lower role would make the self-approval step refuse for the *role* and
stop exercising the self-approval refusal at all, and the journey has to be able to tell which of
the two controls fired. **60 MATCH · 0 MISMATCH · 0 GAP** (was 58).

**The UI replaced a note that had become false.** `/organization` said *"There are no user accounts
yet … no member list, no roles and no per-person permissions"* — true when written, and a screen
understating what the server does is still a screen that disagrees with it. `MembersPanel` renders
the real list, and inherits the rule that removed the fake: it says a role is **granted access, not
a verified person**, on screen, for the same reason the model-seam badge states its bound there
rather than only in a docblock.

**⚠ What did NOT close.** §1.1b: gate 3 still has nobody to compare a decider against, because an
execution has no author. And §1.2b did **not** unblock as predicted — refusing a `system`-authored
revision would still break `kestra:phase3`, the seeds, the showcase and the scenarios. What changed
there is that a policy is now *expressible*; writing one is a deployment decision, not a defect.

## D-68 — a flow declares what it should produce, and gate 1 checks it

`docs/GAPS.md` §2.3 · migration `0028_flow_expectations` ·
`services/flow-expectation.service.ts` · `pnpm --filter @foundry/server kestra:expect`

Gate 1 required a flow to have completed one successful run before a trigger could be armed.
"Completed" was all it ever meant, and the measured disaster this whole migration exists to fix
walked through it: a script that *"hardcoded `period="2023-10"`, emailed 0 of 11, and still exited 0
with `tests_passed=true` and audit `clean`."* Green run, past the gate, wrong.

A flow can now declare **expectations** — claims about its own steps' output — and gate 1 additionally
requires each one to have held on a successful run. Six things are load-bearing.

**⚠ An expectation is NOT an oracle, and the distinction is the whole honesty of the feature.** An
oracle computes the right answer from the dataset definition, independently of the flow
(`expectedScreening`, `financeOracle`); an expectation is written by the person who wrote the flow
and can be wrong in exactly the same direction. What it catches is a flow drifting from its author's
stated intent — which *is* the hardcoded-date failure — and **not** the units trap, which only an
oracle sees. Every surface says so: the run panel, the editor, the harness's own docblock, and
`ui-honesty-check.sh` fails if either screen drops the caveat. **Never say a passing expectation
means a correct run.**

**A flow that declares nothing is unchanged, deliberately.** Every flow in this deployment predates
the feature. A day-one refusal is a change everybody routes around, and what gets routed around is
the control — the same argument D-52 makes for a draft run against a datasource with no sandbox.
Declaring a claim *is* opting in to having it checked.

**⚠ The gate is keyed on the CLAIM's content, not on the revision.** `expectation_key` is a hash over
`(id, stepId, select, assert)`. Gate 1 has always been per-flow and any-revision on purpose — asking
it per revision re-blocks arming after a one-line edit, and a gate that is friction is a gate that
gets switched off — but "any succeeded run" cannot be right either once a flow can make a claim,
because a run that predates the claim never tested it. Hashing the content is the middle: editing a
step or **rewording a description** moves no key and re-blocks nothing; adding or **changing** a
claim produces a key no run has satisfied, so that one blocks. `description` is excluded from the
hash for exactly that reason.

**⚠ `unevaluable` is a third state and it does not satisfy the gate.** A step whose output could not
be read as rows is a claim *nobody checked*. Folding it into `passed` is I-38 — a control that
cannot fail — and folding it into `failed` blames the flow for the checker's own blind spot. It is
recorded with what was found instead, drawn in its own colour, and gate 1 treats it as unmet.

**The vocabulary is declarative with no escape hatch, and the client must not grow one.** Three
assert types (`rowCount`, `field`, `rows`), nine operators, one optional single-key `select` — no
paths, no regex, no expression. Same reasoning as D-50: D-22's allowlist is a good boundary and a
terrible text box, and an expectation that could express computation would be a second
generated-code surface with none of `code`'s containment. `ExpectationEditor` **builds** a claim from
form fields; `ui-honesty-check.sh` fails if a `JSON.parse` appears in it. A claim this vocabulary
cannot express is a claim for an oracle, not for a widened grammar.

**⚠ Evaluation reads the REDACTED view, and that is a security property rather than a convenience.**
`evaluate()` goes through `flowVisibilityService.get()`, whose outputs have already been through
`redactSecrets`. An expectation is a predicate a tenant can run against a step's output as many
times as it likes — so against unredacted output, `contains` is a binary-search oracle that reads a
credential out one character at a time. Reading the same bytes a person sees makes that
structurally impossible instead of forbidden.

**The verdict is persisted at the run and never recomputed** (the `flow_step_runs.read_from` rule,
D-53): deriving it later from the flow's current claims would rewrite the history of every run that
predates one, turning *"nobody checked this"* into *"this always held"*. Evaluation is eager at
`complete` and lazy on read, so a transient engine outage at completion is a delay rather than a
permanent hole — and it **never throws**, because its eager caller is the callback that burns the
execution token and writes the terminal row. A throw there leaves a `running` row holding an M3 slot
for ever, which is I-10 arriving through a feature with nothing to do with budgets.

**⚠ Claims travel in a bundle, and the import states their bound.** The temptation is to strip them
on §5.2's reasoning — and half of it applies: `rowCount eq 11` is a claim about one tenant's rows,
while "every row has an email" travels perfectly. Stripping drops both halves *silently*, leaving a
flow that arrives looking checked and checks nothing. So both travel, `planImport` warns
non-blocking that they were written elsewhere, and gate 1 holds the imported flow until each passes
**here** — which is the behaviour wanted: the numbers get corrected against the importing tenant's
data by someone who can see both. Same posture as the rest of Phase 6: an import is a **structural**
check, never a correctness one (D-25).

**Measured** — `pnpm --filter @foundry/server kestra:expect`, **26 assertions, green at 2026-06 and
2026-05**, with a negative control per assert type and per output shape, both arms of gate 1, and
the authoring-time refusals. ⚠ Its one N/A is stated rather than skipped: at the empty period
`none … present` over zero rows is vacuously true, so that control cannot fire there and the harness
says so instead of reporting coverage it does not have.

⚠ **The harness caught a real defect on its first run, in itself.** The transform projected `.name`
and `.email`; the query emits `full_name` and `work_email`. Eleven rows of nulls, a green run, and
the only thing that noticed was the expectation under test reporting `0 of 11 rows satisfy name
present`. That is the feature doing exactly its job, on the first flow anybody pointed it at.

## D-69 — a provenance policy that ESCALATES rather than refuses

`docs/GAPS.md` §1.2b · `middleware/revision-provenance.middleware.ts`

D-60 recorded `flow_revisions.created_by_kind` and deliberately refused nothing on it. §1.1 was
named as the unblocker and, on landing, was not sufficient: refusing every `system`-authored
revision still breaks `kestra:phase3`, the seeds, the showcase and the scenarios.

**The policy: an `approver` may approve a revision a person is recorded as having written; approving
one nobody is recorded as having written needs an `admin`.**

The point is that the unattested case does not go away — that would be the day-one refusal everybody
routes around (D-52's argument) — it goes **up**. Somebody with the authority to grant roles has to
be the one who says *"I have read what this flow does and I am arming it anyway"*, which is exactly
the judgement an unattested revision needs and exactly what an approver cannot supply, because there
is nobody for the self-approval refusal to compare them against.

⚠ **At the ROUTE, and that is D-67's argument applied a second time.** It needs `req.user`; every
harness arms flows through `systemAuthor()` and calls the service directly. In the service this
would refuse the entire regression net. What is governed is a person approving through a browser.

⚠ **Revoke does not carry it, and a test pins the absence.** Making an unattested flow harder to turn
*off* would point the control backwards.

⚠ The refusal has its own code (`unattested_revision`) rather than a bare 403 — an approver who
already holds the role would otherwise go and ask for the role again.

## D-70 — an execution records who asked for it, so gate 3 has a subject

`docs/GAPS.md` §1.1b · migration `0029_run_requester` · `services/run-requester.ts` ·
`middleware/run-requester.middleware.ts`

`routes/step-approvals.ts` used to carry a paragraph explaining why gate 3 could have no
self-approval refusal: *"gate 2 has a recorded revision AUTHOR to compare against, and an execution
has no author — it was started by a schedule, a trigger or a test run."* True, and the gap.

`flow_executions` now records the requester. Five things are load-bearing.

**⚠ The person does not travel to Kestra.** A route records a `flow_run_requests` row **before**
`startExecution` and passes its **uuid** as a label; `begin` resolves it and verifies the workspace.
This is the `foundry_trigger_fire` shape, with a sharper reason: a label lives in Kestra's database
and renders in `kestra-ui`, which has no tenant isolation and is documented internal-engineers-only,
so an email or an identity subject in one would push person-data into it. A test greps for exactly
that regression.

**⚠ It compares SUBJECTS, never names.** An email can be reassigned. Gate 2 can only compare names
(I-32) and is the weaker half of the pair for precisely that reason; this half must not copy it.

**⚠ It stands down where there is genuinely nobody** — a schedule, a trigger fire, a harness run, or
a run predating the migration (`unknown`). A refusal firing on `unknown` would block every historical
run's pause on a fact nobody recorded, and what people do to a control like that is delete it (I-38,
by the usual road). `schedule` is inferred from the ABSENCE of a pointer and is the one kind that
never appears in `flow_run_requests`, because a scheduled execution never passes through a Foundry
route.

**⚠ There is no body field for the requester and there must never be one.** D-60's `createdBy` had
to stay on the schema because a harness posting over HTTP has a label worth keeping; here a harness
calls the service directly and passes `systemRequester()` in process, so a body value would be pure
attack surface — a client naming the person gate 3 will refuse to let decide is the refusal switched
off from outside.

**⚠ Still not separation of duties** (I-13). Say: *the person who started a run cannot also approve
its pause.*

## D-71 — `/api/signals` gets two readers, and one of them is not a screen

`docs/GAPS.md` §6.1b · `kestra/signals-check.ts` · `components/ops/SignalsPanel.tsx`

§6.1 built the endpoint and its own residue said *"nothing reads it yet"*. "A reader" is two things:

- **A person**, when they go looking — `SignalsPanel` on `/dashboard`, above the numbers.
- **A machine**, when nobody is looking, which is the entire point: the four signals are *"the four
  things that fail with nothing raising an error anywhere"*. A screen cannot do that.

`pnpm --filter @foundry/server signals` exits **0** on ok/unknown, **1** on warn/alarm, **2** when
the endpoint could not be read.

⚠ **Exit 2 is distinct from exit 1 and that matters more than it looks.** *"The system is
unhealthy"* and *"I could not find out whether it is"* need different responses; collapsing them
makes a monitoring outage read as a product outage, or — far worse — a product outage get
acknowledged as a flaky check.

⚠ **`unknown` exits 0**, matching the server's ranking (D-66). Paging on it produces a permanent
low-grade alarm on every fresh deployment, and a permanent alarm is one people mute — after which
the real one is muted too.

⚠ **No alerting vendor is integrated, deliberately.** Every deployment already has something that
runs a command on a timer and pages on a non-zero exit. Picking one here would be inventing a
deployment this repo does not have, and the wrapper would be the thing nobody wired up.

## D-72 — an address that is never a database

`docs/GAPS.md` §1.3b · `services/datasource-target.service.ts`

§1.3b asks what a tenant may point Foundry at beyond "not at Foundry", and says the policy needs an
answer to what a tenant is (§1.1). That is still true. What needs **no** policy is one class:
nothing legitimate is a Postgres or MySQL server on a **link-local** address. `169.254.169.254` is
the cloud metadata endpoint on AWS, GCP, Azure and DigitalOcean; reaching it is how a
credential-theft chain starts, and it is not a database.

So registration resolves the host and refuses link-local (v4 and v6), unspecified, broadcast and
multicast — on every deployment, allowlist or not. It runs **before** the identity probe, because
running that first would mean Foundry had already made the request being refused.

⚠ **Private ranges and loopback are NOT refused.** That is where this deployment's own demo
databases live (`host.docker.internal:5433`, `localhost:5433` for every host-run harness). Refusing
them breaks `demo:seed`, `finance:seed` and the sandbox on day one — I-36 is the record of the last
time a datasource check did exactly that, and it broke `pnpm demo:seed` outright for two programmes.

⚠ **Any address, not all.** A name resolving to one public address and one link-local one is
refused: the driver takes whichever the resolver hands it first, so "some of its addresses are fine"
is not a property anything can rely on.

⚠ **A host that does not resolve is not refused here** — unreachable is already a refusal one layer
down, and refusing twice would report a DNS outage as an address-policy violation.

⚠ **DNS can move underneath it.** Checked at registration, resolved again by the driver at use.
Closing that needs the resolved address pinned into the DSN every connection path dials, and it is
stated in §1.3b rather than implied.

## D-73 — suggesting a claim is a palette; generating one is grading your own work

`docs/GAPS.md` §2.3b · `suggestExpectations` in `services/flow-expectation.service.ts`

§2.3b named two things. Only one is cheap, and they are not the same kind of thing at all.

**Suggesting** is mechanical: a `datasource` step returns rows, so `rowCount gte 1` follows from the
step's kind; a `code` step declares `outputKeys`, so `field <key> present` inherits the authority of
the contract the fragment was already generated against. No model is involved and none can be.

**Generating** would mean asking the drafter what its own flow should produce. That is
`generation-audit.service.ts` with a new name — the service that marked `clean` a script which
emailed 0 of 11 people, and was deleted for it. It stays open, and if it is ever built the claim must
come from the GOAL a person typed rather than from the flow the model produced, with no shared
context between the two (D-23).

⚠ **Every suggestion is deliberately WEAK, and a test pins it.** `gte 1`, `eq 0` on a failure
counter, `present` on a declared key — never a guessed number. `rowCount eq 11` would be the system
inventing the very fact the claim exists to pin down, and its author would accept it *because it
looks specific*.

⚠ **The route is a GET and applies nothing.** Accepting a suggestion is an ordinary
`POST …/revisions` by the person who read it, through the same `addExpectation` a hand-typed claim
goes through — so a suggestion cannot reach a weaker path than something somebody typed (D-49's
argument). The caveat is served **with** the payload (D-27's rule): a suggestion read as a finding
is the failure mode here.

---

## D-74 — the email tool points at Foundry, not at Microsoft

`specs/20260818-084135-email-send-tool/` · `routes/mail.ts` · `services/mail-recipients.ts`

The first capability in Foundry that leaves the building. Every other tool in the catalogue talks to
`packages/ops-api`, which is a simulation: a wrong recipient there costs a row in `api_call_log`.
Here it is a message in a stranger's inbox, and there is no unsend. Seven decisions follow from that
asymmetry.

**1. A Foundry-owned endpoint, not a tool aimed at Graph.** The obvious shape — register a tool whose
`url` is `https://graph.microsoft.com/v1.0/users/{upn}/sendMail` — cannot work, because Graph
delivers to whatever the request body names. That hands the model the destination, and no recipient
policy can exist anywhere. So the tool points at `POST /api/mail/send`, which reads the
`x-foundry-run` header `invokeTool` already sends and decides the recipients itself. A second,
independent reason: `resolveOAuth2Bearer` sends `grant_type`/`client_id`/`client_secret` and **no
`scope`**, and Graph's client-credentials grant requires `scope=…/.default` — so an
`oauth2_client_credentials` tool would have failed to authenticate regardless.

**2. Raw `fetch` through `guardedFetch(…, STRICT)`, no SDK.** Two calls, both external hosts. STRICT
rather than the tool path's PERMISSIVE, following `ops-proxy`'s posture. The Graph client secret is
read in **exactly one module**, enforced by a grep test (`mail-secret-single-reader.test.ts`) in the
style of the `TETHER_API_KEY`-in-three-files assertion — a second read site is a second place a
credential can be logged, and it is what makes moving off `.env` a one-file change.

**3. The requester is read off `flow_executions`, not joined from `flow_run_requests`.** The row
carries a copy taken at `begin`, and that copy is the fact. Only `user` and `replay` kinds have a
person; `schedule`, `trigger`, `system` and `unknown` have none *by definition* and refuse loudly
rather than falling back. A `user` run whose `requested_by` is an Entra OID rather than an address
also refuses — `requested_by` is `user.email ?? user.subject`, so an identity with no email claim
leaves something that is not a mailbox in a column named like one.

**4. `.env`, not Key Vault — a deliberate, temporary deviation from `FOUNDRY_SECRET_SOURCE`**, asked
for explicitly ("keep all the secrets in the .env file only for now"). Recorded here rather than left
implicit, because it is the kind of thing that becomes permanent by not being written down. Decision
2's single read site is what keeps it cheap to undo. ⚠ `MAIL_ENABLED` **defaults ON** when the four
Graph variables are set: an off-by-default kill switch would have refused every send on a fully
configured deployment, citing a variable the operator was never told to add.

**5. The endpoint has a credential of its own**, `HMAC_SHA256(PARENT_API_KEY, "foundry-mail:v1")`,
derived exactly as `opsServiceKey` derives its five. Deliberately **not** `PARENT_API_KEY`: the step
executor calls this like any other tool, so whatever credential it presents is stored in
`workspace_secrets` and rides along on every email step in every flow. The master credential must not
be that. ⚠ Rotating `PARENT_API_KEY` changes the derived value; `mail:register` re-puts it.

**6. A separate platform catalogue.** `demo/tool-catalogue.ts` is demo data seeded by `demo:seed`; a
workspace without it is simply a workspace with no sample data. Real email delivery is a property of
the **product**, so it lives in `services/platform-tool-catalogue.ts` and is registered by
`workspaceService.create` for every workspace, seed or no seed. It is registered even when Graph is
unconfigured — an absent tool produces "unknown tool" and a wasted redraft cycle, where a
present-but-unconfigured one produces a `424` naming exactly which variables to set.

**7. The two mail tools must not read alike.** `mail_send` and `foundry_email_send` sit in the same
manifest and the names do not carry the difference; the cost of confusing them is asymmetric —
picking the simulated one wastes a redraft, picking the real one emails a stranger. So the real one
opens `REAL DELIVERY to a live mailbox…` and both simulated ones now open
`SIMULATED (demo mail service — nothing is delivered).` First words, not somewhere in the paragraph:
a caveat a model may not weight is not a control.

⚠ **A refusal is total and nothing is dialled before the policy passes.** One bad recipient sends
nothing — there is no partial-send return value, so there is no partial-send path for a later change
to take. `mail-end-to-end.test.ts` asserts **zero** transport calls on every refusal path. The
alternative shape, "we sent to the ones that passed and report the rest", is how a caller ends up
believing eleven people were emailed when three were, which is this programme's founding failure with
a smaller gap.

⚠ **A real send is visible on the run page, and that task was not cuttable.** `ToolActivity` reads
`api_call_log` *through ops-api*; a Foundry route writes no row there, so without a second panel
reading `email_sends` a real message would appear **nowhere**. Shipping an invisible real sender would
restage "emailed 0 of 11 people and reported clean" with a live blast radius.

⚠ **`email_sends` has no body column, deliberately.** The body is the script's output and may carry
tenant PII. The record answers "was a message sent, to whom, and did it work" without it, and a
repository test asserts the body string appears in no column of the inserted row.

⚠ **Health reports `mail` as a CONFIG check, never a probe.** `up` means the variables are set — not
that email works, which needs tenant admin consent on the `Mail.Send` application permission and an
Exchange application access policy, neither visible without sending something. `LLM_CONNECTED_CAVEAT`
in the same file is the documented example of getting this wrong.
