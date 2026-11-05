# Phase 0 — Prerequisites (no Kestra yet)

**Status:** 🟡 IN PROGRESS · **Started** 2026-07-28
**Implements:** [08 §10 "Phase 0"](../08-scale-and-phasing.md) · [08 §M3](../08-scale-and-phasing.md) · [08 §M4](../08-scale-and-phasing.md)

Ships value with zero migration risk. Nothing in this phase depends on Kestra existing.

## Tasks

| # | Task | Status |
| :--- | :--- | :--- |
| 0.1 | Branch `kestra-migration` + this `progress/` scaffolding | ✅ |
| 0.2 | Pin and pull `kestra/kestra:v1.3.29` (D-01) | ✅ |
| 0.3 | `tenant_budgets` table (M3) + `tenant-budget.service.ts`. The *check* lands in `POST /api/executions/begin` in Phase 1 — this phase only creates the store. | ✅ |
| 0.4 | M4 cost-metering columns: `tenant_budgets.max_tokens_per_day` / `max_agent_runs_per_day` | ✅ |
| 0.5 | Config keys `KESTRA_BASE_URL`, `KESTRA_AUTH`, `KESTRA_NAMESPACE_PREFIX` in `config/index.ts` + `.env.example` | ✅ |
| 0.6 | Baseline the regression net: `pnpm demo:verify` + `pnpm demo:rehearse` green **before** any change | ✅ |

## Explicitly dropped from Phase 0

Both were in earlier drafts and are dropped by the pinned plan — **do not build them**:

- ~~WS-H scheduler durability fix~~ — Kestra Schedule triggers supersede it ([03 §5.4](../03-architecture.md)).
  Don't build what you're about to delete.
- ~~Fix the H.1 trigger-type inconsistency~~ (a trigger created as *Email* reloads as *Webhook*) —
  triggers are being rewritten in Phase 3. Don't fix the old bug; just don't reproduce it
  ([07 §7.0](../07-refactor-inventory.md)).

## Carried out of scope — tracked, not done here

**Tether boot reconciliation for orphaned runs.** `agent-backend/server.js:1500` keeps `activeRuns`
in memory with no boot reconciliation, so a restart leaves runs at `status:"running"` forever and
Foundry's Phase-4 agent-step poller would poll one indefinitely. This is a **separate work item in a
different repo** (`Foundry-Harness/`) and the pinned plan is explicit that it must not be coupled to
this migration ([07 §7.1](../07-refactor-inventory.md)). It becomes a hard dependency at Phase 4.

## Exit criterion

`tenant_budgets` exists and migrates cleanly; `demo:verify` and `demo:rehearse` are green; the pinned
Kestra image is local. No behaviour change to the running app.

## Work log

- **2026-07-28** — Branch `kestra-migration` cut from `working_foundry_app` @ `d33825e`.
  `progress/` scaffolding created (`00-STATUS`, `ISSUES`, `DECISIONS`, `phase-0..6`).
  Environment survey: Docker 29.6.1, Compose v5.3.1, no host JVM (fine — Kestra is containerised).
  Hit **I-01** (disk full) before anything could be pulled; resolved by the user. Pinned Kestra
  `v1.3.29` (**D-01**) and started the pull.
- **2026-07-28** — Regression-net baseline taken **before** touching anything, so any later red is
  attributable to migration work: `demo:verify` exit 0 (11 below threshold, 2 excluded, #14 @ 80.95%
  trap present, `foundry_ro` with 0 privilege problems), `demo:rehearse` **30/30**.
  `kestra/kestra:v1.3.29` pulled — 3.87 GB on disk.
- **2026-07-28** — 0.3/0.4: `tenant_budgets` added to `db/schema.ts` (**D-03** on why it is
  workspace-keyed despite the name, **D-04** on why an absent row means finite defaults rather than
  unlimited), plus `repositories/tenant-budget.repo.ts` and `services/tenant-budget.service.ts`.
  Migration `drizzle/0009_faithful_tinkerer.sql` generated and applied; `tsc --noEmit` clean.
  0.5: `config.kestra.{baseUrl,auth,namespacePrefix}` and `config.budgetDefaults` added, mirrored in
  `.env.example`.
  **Not wired into any route yet** — Phase 0 is deliberately store-only; enforcement is Phase 1's
  `POST /api/executions/begin`.
