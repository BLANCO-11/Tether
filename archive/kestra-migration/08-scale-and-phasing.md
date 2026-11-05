## 8. Scale mitigations — build these in from day one

All three are cheap now and expensive retrofits.

### M1 — Step contracts take arrays, not single items

```
POST /api/steps/tool   { tool, params: [ {...}, {...} ] }  →  { results: [ {...}, {...} ] }
```

Each Kestra `ForEach` item is a taskrun, which is a database row. A 10,000-item fan-out means
10,000 taskruns and an unusable UI. Batching (one taskrun per ~100 items, loop inside the step)
keeps the graph readable. Retrofitting this later means rewriting every flow.

### M2 — Any step over ~30s uses pause/resume, not a blocking request

A slow tool endpoint pins a Kestra worker thread for its full duration. The agent step already
uses pause/resume (§6.2); apply the same pattern to any long tool or datasource call. Then the
worker pool never pins and concurrency scales without touching flow definitions.

### M3 — Per-tenant concurrency budget enforced in Foundry at trigger time

Kestra OSS has **no per-tenant resource quotas** (Worker Isolation is EE). On a shared instance one
client's runaway flow starves every other client.

Two complementary controls, and use both:

| Control | Grain | Where |
| :--- | :--- | :--- |
| **Kestra flow-level `concurrency`** (limit + `QUEUE`/`CANCEL`/`FAIL`) | per flow | Emitted by the compiler — ⚠ verify version support |
| **`tenant_budgets`** checked in `POST /api/executions/begin` | **per tenant** | Foundry |

Kestra's per-flow limit stops one flow self-overlapping; only Foundry's per-tenant budget stops one
client starving another. Since schedule firing is now Kestra's (§5.4), the budget check lives in
`begin` — the flow's first task — rather than in the scheduler.

This is the genuine architectural ceiling for a commercial multi-tenant service. Build it at client
#1, not client #20.

---

### M4 — Per-client cost metering

Missing from the original plan entirely. `tenant_budgets` caps *concurrency*, not *spend* — and this
is a commercial service.

**It is also a sellable metric being left on the floor.** The cost shape changes fundamentally:

| | Today | Under flows |
| :--- | :--- | :--- |
| Per generation | 8–10k output tokens | N fragments × ~400 tokens, **once** |
| **Per execution** | **8–10k tokens every run** | **Zero** — except `agent` steps |
| Second run of the same automation | Full cost again | **Free** |

An automation that runs daily costs ~300× less per year under flows, because generation happens once
at author time rather than on every trigger. That is a number worth measuring deliberately and
quoting to clients, not discovering later.

| Component | Addition |
| :--- | :--- |
| `tenant_budgets` | `max_tokens_per_day`, `max_agent_runs_per_day` |
| `flow_step_runs` | `tokens_in`, `tokens_out`, `cost_estimate` — populated for `code`/`agent` steps only |
| `flow_revisions` | `authoring_cost` — total tokens to draft + generate this revision |
| `POST /api/executions/begin` | Refuse when the token budget is exhausted, alongside the concurrency check |

Tether already tracks per-session usage (`readRunUsage` in `agent-backend/server.js`), so the agent
step's cost arrives with the run contract. Fragment generation cost comes from the same path.

## 9. Capability ladder

| Tier | Shape | Example | Status |
| :--- | :--- | :--- | :--- |
| **1 Trivial** | Linear 3–6 steps, hundreds of rows | Mon 09:00 → query employees below threshold → email each. 62 rows, 11 emails, seconds. | Day one |
| **2 Routine** | 8–15 steps, branching, fan-out in tens, one approval gate | Nightly per department: pull attendance → resolve dept policy → route <70% to ticket, 70–85% to email → **pause for HR approval** → send | Comfortable; the multi-hour pause is free and survives restart |
| **3 Substantial** | Subflows, 20–50 steps, fan-out in low thousands, parallel branches with joins, 1–2 agent steps | Monthly compliance close across 12 tenants: 3 datasources each → reconcile → **agent generates exception report** → per-client approval → file a ticket per exception. ~2,400 ticket taskruns; approvals spanning days. | **Design target.** First constraint is Tether: ~6 min/run × ~3 concurrent ⇒ 12 agent steps ≈ 24 min |
| **4 Heavy** | 100+ flows, fan-out 10k+, 15-min triggers, dozens of concurrent executions | Every 15 min poll 40 client ticketing systems → classify → route → SLA-escalate. ~5,000 tickets/day. | Reachable **only with M1–M3**; also needs Kestra executor/webserver/scheduler split |
| **5 Ceiling** | Per-item agentic decisions at volume | 5,000 agent classifications/day | **Not reachable.** Arithmetic, not architecture — see below |

### The three real ceilings

| Ceiling | Cause | Mitigation |
| :--- | :--- | :--- |
| **Agent throughput** | Measured ~37 tok/s decode, 8–10k output tokens ⇒ 5–6 min/run, ~3 concurrent | Agent runs are for **authoring flows and genuinely novel work**, never per-item processing. Anything shaped "one agent run per business entity" caps in the **low hundreds per day**. |
| **No per-tenant quotas** | Kestra OSS gap | M3 |
| **Blocking step calls** | Slow endpoint pins a worker thread | M2 |

---

## 10. Phasing

Each phase is independently shippable and leaves the system working.

### Phase 0 — Prerequisites (no Kestra yet)

- ~~WS-H scheduler durability fix~~ — **dropped.** Kestra Schedule triggers supersede it (§5.4).
  Don't build what you're about to delete.
- `tenant_budgets` table (M3) — the check itself lands in `POST /api/executions/begin` in Phase 1
- Tether boot reconciliation for orphaned runs — **independent work item**, still needed: a Tether
  restart leaves a run at `status:"running"` forever, and Foundry's agent-step poller would poll it
  forever
- ~~Fix the H.1 trigger-type inconsistency~~ — **dropped.** Triggers are being rewritten; don't fix
  the old bug, just don't reproduce it (§7.0)

Ships value with zero migration risk.

### Phase 1 — Prove the loop

- Kestra in `infra/docker-compose.yml`, own database, `kestra-ui` bound to localhost only
- `kestra-client.service.ts`, `execution-token.service.ts`, `step-token.middleware.ts`
- `POST /api/steps/tool` and `/api/steps/datasource` only, **array-shaped** (M1)
- **One hand-written flow YAML**: the HR attendance screening from §6.1
- Assert against `GET /api/demo/oracle` — 11 employees below threshold, 2 excluded, 1 unmailable

Exit criterion: the flow produces the oracle's answer, and `flow_step_runs` holds per-step I/O.

### Phase 2 — Visibility

- `StepGraph.tsx`, `StepDetail.tsx`; `adapters.ts` mapping
- Rebuild `automations/[id]` around the step graph
- Repoint `history`, `dashboard`

Exit criterion: an engineer diagnoses a deliberately broken step from the Foundry UI alone,
without opening `kestra-ui` or reading `stub_call_log`.

### Phase 3 — Triggers, approval, and lifecycle

- `trigger.service.ts` fires Kestra executions against the **live** namespace
- `enableReadiness()` against flow executions
- **`flow-approval.service.ts` + `routes/approvals.ts` + `ApprovalPanel.tsx`** — the §6.5 gate
- Two-namespace split; approval = promote draft → live
- Scheduler checks approval validity + staleness each tick
- Repoint `triggers` page, surfacing approval state

Exit criterion: a new schedule cannot fire until a human approves it, and editing an armed flow does
**not** change what the schedule runs.

### Phase 4 — Code and agent steps

- `POST /api/steps/code` — Docker runner extracted from `execution.service.ts`
- `POST /api/steps/agent` — Tether + pause/resume (§6.2, M2)
- Agent-run poller modelled on `pollRun` (`script-generation.service.ts:612`), **including its
  boot re-attach** — otherwise a Foundry restart pauses a Kestra execution forever
- `flow_step_runs.tether_run_id` unique index — the only join key between the systems
- Per-step audit narrowing in `generation-audit.service.ts`

Exit criterion: kill Foundry mid-agent-step, restart, and assert the Kestra execution still resumes.

### Phase 5 — Client authoring — **DEFERRED, not in v1**

> **Do not build this yet.** There are currently zero flows in existence. Building a flow editor plus
> untrusted-input hardening before knowing what flows look like is backwards.
>
> **Instead:** author the first ~10 flows on clients' behalf. Learn the real step vocabulary, the
> contract shapes that recur, and which caps actually bind. R8's hardening becomes urgent only when
> clients genuinely submit content — and by then you will know what to validate.
>
> The earlier ruling stands: clients *will* author flows. Just not first. Everything below is the
> plan for when that time comes.

Scoped up: clients author, edit and change flows, so this carries the untrusted-input surface.

- `flow-compiler.service.ts` — sole YAML emitter, step allowlist (R8)
- **`flow-validator.service.ts`** — tenant-scoped ref validation; step/fan-out/agent-run/subflow-depth
  caps; **structured LLM-consumable findings**
- **`flow-draft.service.ts`** — the bounded redraft loop (§6.4), capped at 3 attempts
- `FlowEditor.tsx`, `StepPalette.tsx`, `ValidationPanel.tsx`, `RevisionDiff.tsx`
- `flow_revisions` immutability; draft/live promotion wired to Phase 3's approval
- Prompt → flow draft (§6.4); `plan.ts` stops being a simulation

Exit criteria — three, and the first is the product:

1. **A client types a sentence and gets a valid flow without touching structure.** Validator findings
   are resolved by the LLM, not surfaced as work for the user.
2. A hand-crafted malicious model (foreign tool ref, script task, 1M-item fan-out, self-referencing
   subflow) is rejected at validation with a readable reason.
3. A deliberately unsatisfiable prompt exhausts 3 attempts and **escalates** rather than looping.

### Phase 6 — Replay, sharing, migration

- `ReplayControl.tsx` + replay authz
- Flow export/import in **Foundry's model format** (§5.2) — generated code stripped, `code` steps
  import as `needs_regeneration`, every ref revalidated against the importing tenant's manifest
- Per-tenant template library
- Fragment-promotion tracking: surface `code` steps recurring across flows as tool candidates (§5.1)
- ~~Migrate existing `scripts` rows~~ — **dropped.** Tables are deleted outright (§7.0)

Exit criterion: export a flow from the HR workspace, import into `hr_demo_alt`, regenerate its code
steps, and assert it produces the **alt** oracle's answer — proving structure travelled and fragments
refitted (the 0–100 vs 0–1 rate difference is the test that matters).

---

## 11. What retires

| Retires | Replaced by |
| :--- | :--- |
| Whole-script Docker execution (flow automations) | `POST /api/steps/code` per code step |
| Monolithic generated Python as the unit of work | Declared steps + small generated fragments |
| Generation-stage progress events | Per-step progress from Kestra |
| Inferential manifest-compliance audit | Structural compliance for declared steps |
| `planFromPrompt` local simulation | Real flow drafting |
| **Cron/schedule handling in `trigger-scheduler.ts`** | **Kestra Schedule triggers** — including catch-up and overlap policy. WS-H's durability fix becomes unnecessary. |
| Foundry-side timeout construction | Kestra flow-level SLA / max duration |
| Hand-rolled step data passing | Kestra `inputFiles` / `outputFiles` / `WorkingDirectory` |
| Duplicated per-step status/timing in Foundry's DB | Read from Kestra's API (R6) |

**Does not retire:** tools, datasources, manifest, introspection, secrets, tenancy, the demo
dataset and its oracle, `stub_call_log`, Tether's run contract, the `attempted_write` audit check.

---

