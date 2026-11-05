# Phase 1 — Prove the loop

**Status:** ✅ **DONE — the gate PASSED. 3 of 3 scenarios, at three periods, 2026-07-29.**
**Implements:** [08 §10 "Phase 1"](../08-scale-and-phasing.md) · [03 §4](../03-architecture.md) · [02 R3/R4](../02-rules.md) · [05 §6.1](../05-lifecycle-and-flows.md) · [08 §M1](../08-scale-and-phasing.md)

> ## ⚠ This phase is the decision point for the entire plan.
>
> [README](../README.md): *"Rebuild the three measured scenarios as flows and score them against
> `GET /api/demo/oracle`. **If per-step generation does not clearly beat 1-of-3, the thesis is
> wrong.**"*
>
> **If it fails, stop and report.** Do not proceed to Phase 2. The fallback is smaller: keep Tether's
> monolithic generation and adopt Kestra only for per-step visibility on the deterministic steps.
> Standing Kestra up as an act of faith is the failure mode this gate exists to prevent.

## Tasks

| # | Task | Status |
| :--- | :--- | :--- |
| 1.1 | `kestra` service in `infra/docker-compose.yml`; **own `kestra` database** on the existing Postgres :5433 | ✅ |
| 1.2 | `kestra-ui` unreachable from off-host (R5) — never proxied, never iframed | ✅ |
| 1.3 | Kestra internal-storage volume **+ a retention policy** (O4) | ✅ `foundry.system/retention`, verified to DELETE (D-10) |
| 1.4 | Network policy: Kestra may reach Foundry `:4000` and its own DB, **nothing else** ([03 §4](../03-architecture.md)) | ✅ |
| 1.5 | `services/kestra-client.service.ts` — mirrors `tether-client.service.ts` shape (`KestraClient` / `KestraError`). **Always injects the namespace server-side (R4).** | ✅ |
| 1.6 | `services/execution-token.service.ts` — mint / validate / **burn** execution-scoped tokens (R3). Store **hashes**, never raw. | ✅ |
| 1.7 | `middleware/step-token.middleware.ts` — validates the token on `/api/steps/*`, **resolves tenancy from the token** | ✅ |
| 1.8 | `POST /api/steps/tool` and `POST /api/steps/datasource` — **array-shaped from day one** (M1: `params[] → results[]`) | ✅ |
| 1.9 | `POST /api/executions/begin` — approval freshness, manifest fingerprint, tenant budget → token or 403 | ✅ budget + R4 namespace authority (I-07) + budget reconciliation (I-10); approval/fingerprint are **Phase 3** |
| 1.10 | DB: `flow_executions`, `flow_step_runs`, `execution_tokens` ([07 §7.4](../07-refactor-inventory.md)) | ✅ + `datasource_queries`, workspace slugs |
| 1.11 | **Hand-written flow YAML** — HR attendance screening from [05 §6.1](../05-lifecycle-and-flows.md), plus scenarios B and C | ✅ three flows |
| 1.12 | Score against `GET /api/demo/oracle` | ✅ **3 of 3**, at `2026-04/05/06` |
| 1.13 | **V2** — does `v1.3.29` support flow-level `concurrency` (limit + `QUEUE`/`CANCEL`/`FAIL`)? | ✅ **yes** — validates, round-trips, and holds at limit 1 |

## Traps to avoid

- **`flow_step_runs` stores pointers + Foundry-only metadata only.** No status, no timing, no inputs,
  no outputs — those are Kestra's, read via API (R6, assertion 26). A duplicated field is a
  divergence waiting to happen.
- **No tenant credential may ever appear in a Kestra flow input, variable, or execution label** (R2,
  assertion 27). Kestra persists all three in its database.
- The flow YAML in this phase is **hand-written**, deliberately. `flow-compiler.service.ts` is Phase 5.
  Do not build the compiler early to emit this one flow.

## Exit criterion

The flow produces the oracle's answer — **11 below threshold, 2 excluded, 1 unmailable, 1 bouncing,
employee #14 @ 80.95% included** — and `flow_step_runs` holds one row per step with per-step I/O
retrievable.

## Verification (from [09 §13](../09-risks-and-verification.md))

1, 2, 5, 6 (forge a namespace param → **403**), 7 (tokens single-use and expiring), 9 (`demo:verify`
+ `demo:rehearse` still green), 26, 27, 28 (403 from `begin` → execution fails at step 1, no
downstream step runs).

**All green.** `pnpm kestra:verify` runs 6, 7, 28, V2 and O4 as executable assertions — see the work
log. 6 is the one that mattered: it found **I-07**, a real R4 hole that the obvious version of the
same test passed.

## Work log

- **2026-07-28 — 1.1/1.2/1.4 done.** Kestra `v1.3.29` running: 53 Flyway migrations, 107 core + 1404
  total plugins, Postgres repository and queue, zero error lines in the boot log.

  Three issues found and fixed, all recorded in [ISSUES.md](ISSUES.md):
  **I-02** basic auth 401s everything unless the username is an **email**, and fails *silently* —
  no log line, only `isBasicAuthInitialized:false` on the one endpoint that stays public.
  **I-03** `internal: true` makes Docker discard published ports without warning, so R5's
  "bind to localhost" was a no-op; the internal bridge turns out to be a stronger boundary anyway.
  **I-04** Kestra held the Postgres **superuser** credential, so `workspace_secrets` was one query
  away and the step API was optional rather than mandatory. Now on a dedicated `kestra` role.

  New: `scripts/kestra-boundary-check.sh` (`pnpm kestra:check`) — 10 assertions covering egress,
  the database boundary, API auth, and that no port is published. `pnpm kestra:ui` prints the
  UI URL, which is a container IP rather than a fixed port.

  **Still open on 1.3:** the storage volume exists, the **retention policy does not**. Without it,
  large step payloads accumulate indefinitely — the recurrence condition for I-01.

- **2026-07-28 — 1.5–1.12 done. THE GATE PASSED.**

  ```
  per-step records (Kestra taskruns):
    ✓ begin          SUCCESS   807ms      ✓ partition   SUCCESS   108ms   (native, in Kestra)
    ✓ fetch_policy   SUCCESS   165ms      ✓ notify      SUCCESS   273ms
    ✓ screen         SUCCESS   207ms      ✓ complete    SUCCESS   113ms
    ✓ excluded       SUCCESS   125ms
  oracle comparison (period 2026-06):
    PASS  below threshold                    11
    PASS  exact employee ids                 3,9,14,20,26,30,38,41,45,52,60
    PASS  unmailable (NULL email)            1
    PASS  #14 @ 80.95% included (ENG bar 85) present
  ```

  Side effects verified independently of the flow's own report — `stub_mail_outbox` holds
  **10 sent + 1 bounced**, `stub_call_log` **9×201 + 1×202**. So: 11 flagged, 10 mailed, 1 skipped
  for a NULL email, 1 hard bounce. That is the oracle exactly, and it is the direct counterpart of
  the measured failure where a script reported `tests_passed=true` having emailed **0 of 11**.

  Whole deterministic run: **~1.8s**.

  Built: `kestra-client.service.ts` (branded `NamespaceRef` makes an R4 IDOR a *compile* error —
  no public method accepts a namespace string), `execution-token.service.ts` (sha256 at rest,
  constant-time compare), `step-token.middleware.ts` (deliberately does NOT accept the parent API
  key — see the file for why), `step-execution.service.ts`, `routes/steps.ts`,
  `routes/executions.ts`, `datasource_queries` + `hr-screening.queries.ts`,
  `hr-screening.flow.yml`, and `pnpm kestra:prove`.

  Two more issues, both recorded: **I-05** (the full image's 1404 plugins OOM'd the engine — image
  changed, **D-01 amended**) and **I-06** (`PUT` to a non-existent flow never responds; undici's
  5-minute default made it look like a network fault).

  Four decisions logged: **D-05** the pinned design contradicts itself on whether `flow_step_runs`
  holds I/O (§7.4 wins over the Phase 1 exit criterion, because it agrees with R6); **D-06** tokens
  are single-use per *execution*, not per request; **D-07** `begin`'s output contains the token and
  Kestra persists task outputs, so **Phase 2's step-graph UI must redact that step's body**.

  **What this run does NOT establish.** It is one scenario, hand-written, with zero `code` steps and
  zero generation. The thesis it supports is *"a flow of declared steps produces the oracle's
  answer"* — not that per-step **generation** beats 1-of-3. The README asks for **three** scenarios;
  this is one. Do not quote it as the thesis being proven.

## Work log — 2026-07-29 · Phase 1 closed

**3 of 3 scenarios, scored, at three periods.** The gate is met.

```
A  screening   fan-out    11 flagged → 10 mailed + 1 unmailable + 1 bounce
B  escalation  fan-IN     11 flagged → 10 tickets  (manager 2 owns two reports)
C  roll-up     aggregate  7 departments → 1 chat message, LEG present with null

periods 2026-04 · 2026-05 · 2026-06     3 of 3 at each
```

Every scenario is scored three ways: against an oracle written independently of the flow, against the
`stub_*` side-effect tables, and at three periods. See DECISIONS.md **D-08** for why these three
scenarios and what the "3 of 3 vs 1 of 3" comparison does and does not mean (ISSUES.md **I-08** — the
original prompts are unrecoverable).

**Built since the 2026-07-28 entry:**

| | |
| :--- | :--- |
| `demo/scenario-oracles.ts` | `expectedEscalation` + `expectedRollup`, in a NEW file — `hr-dataset.ts` is not to be edited, and separate functions are the `hr_demo_alt` rule anyway |
| `kestra/hr-scenarios.queries.ts` | the recursive nearest-active-manager walk, and the LEFT-JOIN-from-departments roll-up |
| `kestra/hr-escalation.flow.yml`, `hr-rollup.flow.yml` | scenarios B and C |
| `kestra/phase1-verify.ts` (`pnpm kestra:verify`) | assertions 6, 7, 28, V2, O4 as executable checks |
| `kestra/retention.flow.yml` + `deploy-system-flows.ts` (`pnpm kestra:system`) | O4, in `foundry.system` |
| `scripts/kestra-env.sh` | host-run scripts read their env from the server container (D-11) |

**Five issues, and four of them were only findable by not stopping at one green run.**

| | |
| :--- | :--- |
| **I-07** | `begin` **trusted the namespace in the request body** — a flow in one workspace could claim another and receive its token. Measured 200-with-a-token before the fix. The namespace is now read from Kestra, which the flow cannot lie to. Found by asking what assertion 6 was actually testing; the obvious version of that test passed. |
| **I-09** | An empty step batch was a 400, so a screening flow **worked in a bad month and broke in a good one**. Only visible at a second period. |
| **I-10** | A failed execution held its M3 budget slot for ever; five failures bricked the workspace via a *fairness* control. `begin` now reconciles against Kestra before refusing. |
| **I-11** | Two Kestra templating traps that fail silently — nested `{{ }}` inside a filter argument, and `\| first` unwrapping a jq string. Both will be hit again by the Phase 5 compiler. |
| **I-08** | `PRODUCTION_DRY_RUN.md` is unrecoverable, so the three scenarios are reconstructed. `ACCEPTED`, with the honesty constraint written down. |

Four decisions logged: **D-08** (scenarios chosen by shape), **D-09** (`foundry.system` has no tenant
segment, and that IS the security property), **D-10** (retention is 30 days and that is also the replay
window), **D-11** (host scripts read env from the container).

**Regression net, after all of it:**

```
pnpm test                 130 passed (6 files)
pnpm demo:verify          exit 0 — 186 monthly rollups agree with 4019 daily rows
pnpm demo:rehearse        30 / 30
pnpm kestra:check         10 / 10 boundary assertions
pnpm kestra:verify        all assertions passed (6, 7, 28, V2, O4)
pnpm kestra:prove         3 of 3 at 2026-04, 2026-05, 2026-06
```

### What this still does NOT establish

Unchanged from the first entry and worth repeating, because the number is now more quotable:

- **Zero `code` steps and zero generation.** All three flows are hand-written. The thesis these support
  is *"a flow of declared steps produces the oracle's answer"*. That per-step **generation** beats
  1-of-3 is Phase 4's claim, not this one.
- **Not like-for-like against the baseline** — different prompts (I-08).
- One dataset, one workspace, one engine instance.

## Exit criterion — met

The flows produce the oracles' answers, and `flow_step_runs` holds one pointer row per credentialed
step with per-step I/O retrievable through it (D-05 reads the criterion this way, and §7.4 forbids
storing the I/O itself).
