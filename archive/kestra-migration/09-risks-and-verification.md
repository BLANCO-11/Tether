## 12. Risks and open questions

| # | Risk | Severity | Mitigation |
| :--- | :--- | :--- | :--- |
| 1 | **Namespace IDOR** — passing a client-supplied namespace to Kestra leaks other tenants' executions | **Critical** | R4. Inject server-side; add a test that a forged namespace param 403s |
| 1b | **Client-authored flow reaching Kestra as YAML** — arbitrary task types ⇒ RCE in Kestra's container, SSRF to cloud metadata / Foundry admin / Kestra's own API | **Critical** | R8. Compiler is the only emitter; step allowlist; never accept YAML on any client-facing route |
| 1c | **Cross-tenant step reference** — a client's flow naming another tenant's tool or datasource | **Critical** | `flow-validator` resolves every ref against the authenticated tenant's manifest only |
| 1d | **Approval blank cheque** — an approved schedule silently repointed by editing | **High** | §6.5. Approval binds to a revision; live namespace serves only the approved one |
| 1e | **Fan-out / recursion abuse** by a client flow (1M-item `ForEach`, self-referencing subflow) | **High** | Caps at validate time + M3 budget at runtime. `fleet.js`'s `FLEET_DISPATCH_NAMES` recursion guard is prior art |
| 2 | No per-tenant resource quotas in Kestra OSS | **High** | M3 |
| 3 | `kestra-ui` exposure | **High** | R5. Bind to localhost; never proxy or iframe |
| 4 | Flow-definition drift if YAML is stored authoritatively in both places | High | R6. Kestra is SoR; `flows` is a pointer |
| 5 | Agent throughput ceiling misunderstood as a scaling problem | Medium | §9. Never one agent run per business entity |
| 6 | Two-repo coordination (`foundry/` + `Foundry-Harness/`) | Medium | Tether needs zero changes — keep it that way |
| 7 | Trademark | Low | Check Kestra's policy before any "powered by" claim |
| 8 | JVM in a shipped self-hosted bundle | Medium | Accepted cost of the licence choice |

### Decisions — all resolved

1. **§G.7 — may a schedule execute automatically?** **Yes, once approved.** Every new schedule needs
   at least one human approval, bound to a revision. Full lifecycle in §6.5. This supersedes the
   blanket "nothing auto-executes" posture with something enforceable that doesn't require a human
   on every run.
2. **Do clients author flows?** **Yes** — author, edit and change. `FlowEditor` is a full builder
   (§6.4). This is what makes R8 mandatory rather than advisory.

3. **Namespace granularity.** **Per workspace, tenant-prefixed, immutable slugs** —
   `acme.hr` (live) + `acme.hr.draft`. Hierarchy is **tenant ⊃ workspace ⊃ users**; users do not get
   namespaces, since isolation between them is a permissions concern in Foundry. §5.0.
4. **Approver for write-capable steps.** **Separation of duties, not escalation:** the approver must be
   a **workspace admin and a different human than the author**. Cleaner than escalating to a
   Foundry operator, and it holds at any grain. `flow_approvals.approver_kind` is retained for a future
   tightening.
5. **Fragment generation path.** Reuse Tether's existing generate → run → iterate loop rather than
   building a second one (§5.3.1). A ~400-token fragment is ~10–20 s of decode, not 5–6 minutes — the
   measured figure was for 8–10k tokens.
6. **Revoking an approval mid-execution.** **In-flight executions complete; only future firings
   suspend.** Cancelling mid-flight would leave side effects half-applied with no compensation path,
   which is worse than letting an already-approved run finish.
7. **Poll triggers starting a flow at a given step.** **No.** A flow starts at step 1. Entering
   mid-flow bypasses upstream contracts, and replay already covers the legitimate case.

### Open — external verification, not decisions

Two facts could not be confirmed from documentation. Neither blocks the design; both must be tested
rather than debated.

| # | To verify | When | If it fails |
| :--- | :--- | :--- | :--- |
| V1 | Can network be disabled on Kestra's Docker task runner **at the task level**? | Phase 4 | **Not a fallback to Foundry's runner** — decided: Kestra executes all `code` steps. Enforce isolation at the **Docker network level** instead: attach the runner to an internal-only bridge with no egress. |
| V2 | Does the deployed Kestra version support **flow-level `concurrency`** (limit + `QUEUE`/`CANCEL`/`FAIL`)? | Phase 1 | Build per-flow overlap control in Foundry. M3's per-workspace budget is unaffected either way. |

### Operational requirements

Consequences of Kestra becoming a system of record and an execution environment.

| # | Requirement | Why |
| :--- | :--- | :--- |
| **O1** | **Pin an exact Kestra version.** Upgrades are deliberate, tested changes. | V1 and V2 are both version-dependent, and Kestra moves quickly. An unpinned image can silently remove a capability the compiler emits. |
| **O2** | **Pin the `code` step base image** and treat a bump as a versioned change | Every existing fragment was generated against a specific import set (§5.3.2) |
| **O3** | **Back up Kestra's database if execution history is contractual** | See recovery table below |
| **O4** | Kestra's internal storage needs a volume and a retention policy | Large step payloads live there (§5.3.2) |

#### What survives losing Kestra's database

| Asset | Recoverable? | From |
| :--- | :--- | :--- |
| Flow definitions | **Yes** | `flow_revisions.model_json` → recompile → redeploy |
| Approvals, budgets, tenancy | **Yes** | Foundry's Postgres |
| Which revision was armed | **Yes** | `flows.armed_revision` |
| Step-run pointers, audit verdicts, oracle scores | **Yes** | `flow_step_runs` |
| **Per-step inputs, outputs, timings, logs** | **No** | Kestra only |
| **Execution history and replay capability** | **No** | Kestra only |

So a Kestra loss is **recoverable but not lossless**: flows come back, history does not. If clients are
promised an audit trail of what ran, O3 is a contractual requirement, not an ops nicety.

**V1 carries a real security delta, so do not let it slide.** Committing to Kestra's runner means that
if network cannot be disabled *anywhere* in the stack, generated fragments can reach the network — and
R9's guarantee weakens from "cannot" to "should not." Task-level config is preferred; Docker-network
level is an acceptable equivalent; **nothing is not acceptable.** Settle it in Phase 4 with a test that
asserts a fragment's outbound socket fails.

---

## 13. Verification

Extend `pnpm e2e` (currently 10/10) with:

1. Deploy a flow from YAML → assert it exists in the namespace
2. Execute → assert `flow_executions` + one `flow_step_runs` row per step, each with I/O recorded
3. Break step 2 deliberately → assert retries, then `FAILED`, then step 1's output still persisted
4. Replay from step 2 → assert step 1 was **not** re-executed
5. Screening flow output matches `GET /api/demo/oracle` exactly (11 below threshold, 2 excluded,
   1 unmailable, 1 bouncing)
6. **Forge a namespace parameter → assert 403** (risk 1)
7. Assert `execution_tokens` are single-use and expire
8. Exceed a tenant budget → assert the trigger is refused, not queued unbounded
9. `pnpm demo:verify` and `pnpm demo:rehearse` still green — the `hr_demo_alt` rehearsal is the
   regression net; one dataset cannot find shape-assumption bugs

**Approval and client-authoring assertions (Phases 3 and 5):**

10. A new schedule cannot fire before approval → assert the scheduler skips it and the UI states why
11. Approve → schedule fires. **Then edit the flow → assert the next firing still runs the approved
    revision**, not the draft (risk 1d)
12. Change a referenced tool's shape → assert the approval goes stale and the schedule suspends
13. Approve → revoke → assert no further firings, and an in-flight execution still completes (open
    question 7)
14. Submit a model referencing **another tenant's** tool → assert rejected at validation, not at
    execution (risk 1c)
15. Submit a model that would compile to a Kestra **script task** → assert the compiler has no such
    emitter and validation rejects it (risk 1b)
16. Submit a 1M-item fan-out and a self-referencing subflow → assert both hit caps with readable
    reasons (risk 1e)
17. Assert **no client-facing route accepts YAML** on any path — grep-level test plus a request test

**Per-step generation assertions (Phase 4) — these prove decomposition actually happened:**

18. A flow with three `code` steps produces **three separate fragments** from **three separate
    inference calls**, each prompt containing only that step's contract — assert no fragment's prompt
    contains the automation goal, the manifest, or a sibling step
19. Break fragment B → regenerate → assert **A and C are byte-identical** and were not re-inferred
20. Run each fragment as a **unit test**: declared input in, assert declared output shape — no live
    datasource, no network (R9)
21. A fragment attempting network access or a DB connection **fails at execution** — assert the
    container has neither (R9)
22. Assert a `code` step's container receives **no datasource credential**
23. Assert `code` steps run via the **Docker** task runner, never `Process` (R9) — a compiler test
24. **Verify the Docker task runner can disable network.** If it cannot, `code` steps fall back to
    Foundry's runner and R9 is enforced there instead — decide this in Phase 4, don't defer

**Maximise-Kestra assertions (R2):**

25. Revoke an approval → assert the **Schedule trigger is removed from Kestra**, not merely flagged.
    An unapproved flow must have no trigger to fire (§5.4)
26. Assert `flow_step_runs` stores **no** status, timing, input or output — those come from Kestra's
    API. A duplicated field is a divergence waiting to happen (R6)
27. Assert no tenant credential ever appears in a Kestra flow input, flow variable, or execution
    label — Kestra persists all three (R2)
28. Kill `begin`'s response with a 403 → assert the execution fails at step 1 and no downstream step
    runs

**Generation-boundary assertions (§5.3.1):**

29. Assert **no Kestra flow, task, or trigger ever calls an inference endpoint.** The only runtime LLM
    path is the `agent` step via Foundry — a compiler test plus a YAML grep
30. Assert a flow **cannot deploy with an empty `script:` block** — imports must generate first
31. Regenerate a fragment on an approved flow → assert a **new revision** is created and approval goes
    **stale**, rather than the live flow being patched in place

**Sharing assertions (Phase 6):**

18. Export a flow → assert the payload contains **no generated code** and **no secret values**, only
    env-var names (§5.2)
19. Import into a workspace missing one referenced tool → assert rejected with the missing ref named,
    not a partial import
20. Export from `hr_demo` → import into `hr_demo_alt` → regenerate code steps → assert the **alt**
    oracle's answer. The 0–100 vs 0–1 rate difference is the assertion that proves fragments refit
    rather than travel.

### Non-goals for this migration

- Multi-tenant Kestra (EE feature; Foundry provides tenancy)
- Replacing Tether
- Client-facing access to `kestra-ui`
- Kestra plugins or any fork
- Any additional service beyond Kestra (R7)

---

