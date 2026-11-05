## 7. Refactoring inventory

### 7.0 Scope ruling — this is an R&D app, nothing is in production

**No backward compatibility is owed.** Anything made redundant by the flow model is *deleted*, not
retained behind a legacy path. There are no production automations, no client data to migrate, and no
API consumers to keep working.

Two consequences that simplify large parts of this plan:

1. **No data migration.** `scripts` rows are dropped, not converted into single-step flows.
2. **Rewrites, not branches.** Services that change behaviour are rewritten rather than made to serve
   both models. Dual-mode code would be the only thing keeping the old failure modes alive.

**Assumed decision — `datasource` steps use named queries, not generated SQL.** This kills a measured
failure mode (*"missing `COALESCE` to a policy default in hand-written SQL"*) and makes
`generation-audit.service.ts` deletable. Ad-hoc shaping becomes a `code` step over what a named query
fetched — pure, contract-bound, and unable to write. If genuinely ad-hoc SQL is needed later, add a
separate `query` step kind and resurrect the audit for that kind alone.

### 7.0.1 Deletion inventory

| Deleted | Replaced by |
| :--- | :--- |
| `services/execution.service.ts` | Kestra's Docker task runner (§5.3.2) |
| `services/generation-audit.service.ts` + its ~18 tests | Structural manifest compliance + R9 |
| `routes/scripts.ts` | `routes/flows.ts` |
| Monolithic generation path in `script-generation.service.ts` | Fragment generation from step contracts |
| Cron/schedule handling in `trigger-scheduler.ts` | Kestra Schedule triggers (poll loop survives) |
| `lib/plan.ts` local simulation | Real flow drafting |
| Tables `scripts`, `script_versions`, `execution_results`, `test_results` | `flows`, `flow_revisions`, `flow_executions`, `flow_step_runs` |
| `requirements.txt` generation | One pinned base image (§5.3.2) |
| Client mock-only paths (`mockdb.ts`, `mock-rows.ts`, mock delete/toggle/rename) | Implement for real or drop the screen |

**Kept deliberately:** the HR demo dataset, `hr_demo_alt`, `/api/demo/oracle`, `stub_*` tables and
`stub_call_log`. That is the regression net for this migration, not legacy.


### 7.1 Tether — `Foundry-Harness/` — **zero changes required**

This matches the load-bearing decision already recorded in `foundry/CLAUDE.md`: *"Zero required
Tether code changes."* Every integration point is Tether's existing public API.

| File | Action | Note |
| :--- | :--- | :--- |
| `agent-backend/server.js` `startRun` :1529 | **none** | Called via `POST /api/run` as today |
| `agent-backend/routes/run.js` | **none** | `canAccess` :28 unchanged |
| `agent-backend/run-contract.js` | **none** | Contract consumed by Foundry's agent step |
| `agent-backend/harnesses/picode/index.js` :73-120 | **none** | Tenant-scoped MCP composition unchanged |
| `agent-backend/policy-engine.js` | **none** | Per-tool-call, stays inside runs |
| `agent-backend/channel-scheduler.js` | **none** | Independent of Foundry's triggers |

**One independent fix, needed regardless of this migration:**

| File | Issue | Fix |
| :--- | :--- | :--- |
| `agent-backend/server.js` :1500 | `activeRuns` is in-memory with **no boot reconciliation**. A restart orphans runs at `status:"running"` forever. Also `findRunBySession` :1770 and `cancelRun` :1734 need an in-process handle, so HITL and cancel only work on the instance that started the run — meaning Tether cannot run two replicas. | On boot, scan non-terminal `runs` rows and finalize or reconcile. Track as its own work item; do not couple it to this migration. |

### 7.2 Foundry server — `foundry/packages/server/src/`

#### New files

| File | Purpose |
| :--- | :--- |
| `services/kestra-client.service.ts` | Kestra REST client. Mirror the shape of `tether-client.service.ts` — `KestraClient` / `KestraError`. **Always injects the namespace server-side (R4).** |
| `services/flow.service.ts` | Flow CRUD, deploy-to-namespace, revision tracking, validate-before-deploy |
| `services/flow-compiler.service.ts` | Foundry flow model → Kestra YAML. **The only YAML emitter in the system (R8).** Single place that knows the dialect; also the step allowlist. |
| `services/flow-validator.service.ts` | Validates drafted models: every step ref exists in *this tenant's* manifest; step count, fan-out width, agent-run count and subflow depth caps; no cycles. Runs **before** the compiler. **Findings are structured and LLM-consumable** — offending step + rule + the facts needed to fix it (§6.4). Its primary job is catching LLM error; blocking malicious client input is the secondary one. |
| `services/flow-draft.service.ts` | The bounded redraft loop: draft → validate → feed findings back → redraft, capped at 3 attempts, then escalate. Owns the continuation-prompt shape. |
| `services/flow-approval.service.ts` | Approve a revision → compile → deploy to live namespace → **deploy the Kestra Schedule trigger** → record approval. Revoke/stale → **remove the trigger from Kestra** so an unapproved flow structurally cannot fire (§5.4). Staleness by diffing `manifest_refs_json` against the current manifest. |
| `routes/executions.ts` | `POST /api/executions/begin` — every flow's first task. Validates approval freshness, manifest fingerprint and tenant budget; returns the execution token or 403 (§5.4) |
| `services/step-execution.service.ts` | Bodies for the five step endpoints; dispatches to existing tool/datasource/execution/tether services |
| `services/execution-token.service.ts` | Mint / validate / burn execution-scoped tokens (R3) |
| `services/tenant-budget.service.ts` | Per-tenant concurrency budget, checked **at trigger time** (mitigation M3) |
| `routes/steps.ts` | `POST /api/steps/{tool,datasource,code,agent,notify}` |
| `routes/flows.ts` | Flow CRUD, execute, replay, export/import |
| `routes/approvals.ts` | Approve / revoke a revision; list pending; approval history |
| `middleware/step-token.middleware.ts` | Validates the execution token on `/api/steps/*`; resolves tenant |
| `repositories/flow.repo.ts` | `flows`, `flow_steps` |
| `repositories/flow-execution.repo.ts` | `flow_executions`, `flow_step_runs` |

#### Modified files

| File | Change | Size |
| :--- | :--- | :--- |
| `services/trigger.service.ts` | `fire()` starts a **Kestra execution** instead of a script execution. `enableReadiness()` now checks the flow has one succeeded execution. Keep the 409-rethrow behaviour and the `trigger_fires`-written-first ordering. | Moderate |
| `services/trigger-scheduler.ts` | **Mostly retires.** Cron/schedule handling moves to Kestra Schedule triggers (§5.4) — no WS-H durability fix needed, Kestra brings catch-up and overlap policy. What remains: the **poll** trigger loop only (changed-since-hash), which has no Kestra equivalent. | Shrinks |
| `services/trigger.service.ts` *(2nd change)* | `fire()` retained for **manual + webhook + poll** paths. Schedule firing is Kestra's. `enableReadiness()` now gates **whether the Kestra trigger is deployed**, not whether a tick proceeds. | Moderate |
| `services/execution.service.ts` | **DELETE.** `code` steps execute in Kestra's Docker task runner (§5.3.2), so Foundry runs no containers at all. Nothing to retain — there is no production script to keep working. | — |
| `services/step-contract.service.ts` *(new)* | Declares and enforces each step's input/output shape; generates the per-fragment prompt from the contract alone (§5.3); asserts conformance after execution | Moderate |
| `services/script-generation.service.ts` | **Rewrite, not branch.** Becomes flow drafting + per-step fragment generation; the monolithic path is deleted outright. **Preserve the prompt block order — `TASK` last** (measured: shared prefix 4.4% → 95%). | Large |
| `services/tool.service.ts` | Add a **batch** entry point accepting `params[]` → `results[]` (mitigation M1). Preserve `redactSecrets()` and the name-collision 409. | Moderate |
| `services/datasource.service.ts` | Batch query entry point. `foundry_ro` DSN only. | Moderate |
| `services/manifest-builder.service.ts` | Manifest additionally feeds the **flow step catalog** — typed step params so a flow can be validated against available tools/datasources at author time. | Moderate |
| `services/generation-audit.service.ts` | **DELETE** (~18 tests with it), assuming named queries (§7.0). Its purpose was inferring whether a monolithic script stayed inside its manifest. Declared steps make compliance structural, and R9 means a fragment has **no datasource connection**, so `attempted_write` is unreachable by construction. Resurrect only if a generated-SQL `query` step kind is introduced. | — |
| `services/tether-client.service.ts` | Largely unchanged; now called from the agent step handler rather than the generation service. | Small |
| `services/introspect/`, `schema-introspector.service.ts` | **No change.** Keep the `pg_constraint.conkey/confkey` FK query — do not "simplify" it back. | — |
| `services/workspace-secret.service.ts` | **No change.** Still the only secret custodian (R2). | — |
| `services/tenant-mapper.service.ts` | Namespace derivation: tenant+workspace → `<tenant>.<ws>` **and** `<tenant>.<ws>.draft`, from **immutable slugs**. Single source for both names (§5.0). | Small |
| `services/manifest-builder.service.ts` *(2nd change)* | Emit a stable `manifest_refs` fingerprint per tool/datasource shape so approval staleness is detectable (§6.5) | Small |
| `middleware/auth.middleware.ts` | Add the step-token path alongside the existing client-auth path | Small |
| `ws/progress-server.ts` | Stream **per-step** progress from Kestra execution polling, replacing generation-stage events | Moderate |
| `routes/scripts.ts` | **DELETE.** No production automations to serve. | — |
| `routes/triggers.ts` | Repoint to flow executions | Small |
| `db/schema.ts` | New tables — §7.4 | Moderate |
| `config/index.ts` | `KESTRA_BASE_URL`, `KESTRA_AUTH`, `KESTRA_NAMESPACE_PREFIX` | Small |

#### Unchanged

`packages/mcp-bridge` (:3015) is **out of scope** — Tether-facing, unaffected.

`routes/{tools,datasources,workspaces,workspace-secrets,stub-api,stubs,demo,health}.ts`,
`repositories/{tool,datasource,workspace,workspace-secret,manifest,schema}.repo.ts`,
`utils/encryptor.ts`, `middleware/error.middleware.ts`, all of `demo/`.

**Do not touch the demo dataset or `demo/hr-roles.ts`.** `pnpm demo:verify` and `demo:rehearse`
are the regression net for this migration — the `hr_demo_alt` rehearsal found three real bugs on
its first run.

### 7.3 Foundry client — `foundry/packages/client/src/`

The three-layer seam is why this is feasible:

```
pages → lib/api.ts (1130)  →  lib/adapters.ts (445)  →  lib/foundry-client.ts (516)
         UI-shaped types        translation layer         HTTP
```

`adapters.ts` is where Kestra's execution shape becomes the UI's step-graph shape. Pages mostly
don't change to re-point a backend.

#### New files

| File | Purpose |
| :--- | :--- |
| `components/flow/StepGraph.tsx` | Renders nodes + edges + per-step status from `taskRunList` |
| `components/flow/StepDetail.tsx` | Side panel: inputs, outputs, logs, duration, error, audit verdict |
| `components/flow/ReplayControl.tsx` | Replay-from-step, with the confirm affordance |
| `components/flow/FlowEditor.tsx` | **Full builder** — add/remove/reorder steps, bind params, declare flow inputs, set branching. Client-facing. |
| `components/flow/StepPalette.tsx` | Available steps sourced from the manifest — the client's entire vocabulary (R8) |
| `components/flow/ApprovalPanel.tsx` | Approve/revoke a revision; shows what changed since the approved one |
| `components/flow/RevisionDiff.tsx` | Draft vs approved step diff — what the approver is actually signing off |
| `components/flow/ValidationPanel.tsx` | Ref errors and cap violations from `flow-validator` |

#### Modified

| File / page | Change |
| :--- | :--- |
| `lib/adapters.ts` | **Primary seam.** Kestra execution + Foundry metadata → UI types |
| `lib/api.ts` | Add flow / step-run / replay / export functions; retire whole-script execute |
| `lib/types.ts` | `Flow`, `FlowStep`, `StepRun`, `FlowExecution` |
| `lib/foundry-client.ts` | Flow and step endpoints |
| `lib/plan.ts` | `planFromPrompt` currently a **local simulation** — becomes real flow-draft generation |
| `lib/authoring.ts`, `lib/drafts.ts` | Flow-authoring drafts rather than prompt drafts |
| `lib/runstream.ts` | Per-step progress stream |
| `lib/stats.ts` | Dashboard stats from flow executions |
| `app/(app)/automations/[id]/page.tsx` | **Rebuild.** Code preview → step graph. Keep the self-test / audit / versions / triggers sections. |
| `app/(app)/automations/new/page.tsx` | **Rework.** Prompt → flow draft → edit steps → validate → deploy |
| `app/(app)/automations/page.tsx` | Repoint to flows |
| `app/(app)/triggers/page.tsx` | Repoint; keep `enableReady` / `enableBlockedReason` surfacing. **Add the approval state** — a trigger blocked on approval must say so, not present a dead switch (the same mistake as the removed localStorage go-live gate) |
| `app/(app)/history/page.tsx` | Repoint to flow executions |
| `app/(app)/dashboard/page.tsx`, `home/page.tsx` | Stats re-sourced |
| `components/automation/GenStageStrip.tsx` | Repurpose as a step-progress strip |

#### Unchanged

`app/(app)/{tools,data-sources,virtual-tables,keys,organization,outbox,apps}`, `login/`,
`components/{ui,shell,data,keys}/`, `lib/{auth,toast,workspace,hooks,validation,vault-fields,manifest-form}`.

Roughly **60% of the client is untouched, 30% re-pointed through `adapters.ts`, 10% rebuilt** — and
that 10% is where the cost is. The step-graph view is **new UI, not migrated UI**; Kestra supplies
the data, not the components.

#### Known client bugs to fix while in there

- **H.1 three-layer trigger type inconsistency** — a trigger created as *Email* reloads as
  *Webhook*. Still open; the trigger rework touches exactly this code.
- The `automations/new` → detail handoff should carry the flow id, not a script id.

### 7.4 Database — `foundry/packages/server/src/db/schema.ts`

#### New tables

| Table | Key columns |
| :--- | :--- |
| `flows` | `id`, `workspace_id`, `name`, `kestra_flow_id`, `draft_revision`, **`armed_revision?`** (the approved one in the live namespace), `status` |
| `flow_revisions` | `flow_id`, `revision`, `model_json` (Foundry's model, **not** YAML), `compiled_yaml_hash`, `created_by`, `created_at` |
| `flow_steps` | `flow_id`, `revision`, `step_id`, `ordinal`, `kind` (`tool\|datasource\|code\|agent\|notify\|transform`), `config_json`, `generated_code?`, `manifest_refs_json` |
| `flow_approvals` | `flow_id`, `revision`, `approver_user_id`, `approver_kind` (`client_admin\|foundry_operator`), `approved_at`, `revoked_at?`, `manifest_fingerprint`, `stale_at?` |
| `flow_executions` | `id`, `flow_id`, `kestra_execution_id` **(unique)**, `status`, `trigger_fire_id?`, `inputs_json`, `started_at`, `ended_at` |
| `flow_step_runs` | **Pointer + Foundry-only metadata.** `flow_execution_id`, `step_id`, `kestra_taskrun_id` **(unique)**, **`tether_run_id?` (unique)**, `audit_verdict?`, `oracle_score?`. **Do not store** status, timing, inputs or outputs — those are Kestra's, read via API (R2/R6) |
| `execution_tokens` | `token_hash`, `workspace_id`, `flow_execution_id`, `expires_at`, `consumed_at?` |
| `tenant_budgets` | `workspace_id`, `max_concurrent_executions`, `max_agent_runs_per_day` |

Store **hashes**, never raw tokens. Index `flow_step_runs (flow_execution_id, step_id)` and
`flow_executions (kestra_execution_id)` — both are hot join paths for the UI. `flow_steps` is keyed
by `(flow_id, revision, step_id)` because approval is revision-scoped (§6.5), so step definitions
must be immutable per revision rather than mutated in place.

#### Dropped

`scripts`, `script_versions`, `execution_results`, `test_results` — **deleted, not retained** (§7.0).
No production automations exist, so there is no history worth preserving and no migration to write.

#### Unchanged

`workspaces`, `tools`, `workspace_secrets`, `datasources`, `schemas`, `workspace_manifests`,
`triggers`, `trigger_fires`, `stub_mail_outbox`, `stub_chat_messages`, `stub_tickets`,
`stub_call_log`.

### 7.5 Infrastructure

| File | Change |
| :--- | :--- |
| `foundry/infra/docker-compose.yml` | Add `kestra` service; add a `kestra` database on the existing Postgres |
| `foundry/.env` / `.env.example` | `KESTRA_BASE_URL`, `KESTRA_AUTH`, `KESTRA_NAMESPACE_PREFIX` |
| `foundry/scripts/e2e-smoke.mjs` | Extend the 10/10 journey with: deploy flow → execute → assert per-step records → replay from step |
| `foundry/package.json` | `infra:up` picks up Kestra automatically |
| `Foundry-Harness/docker-compose.yml` | **No change** |

---

