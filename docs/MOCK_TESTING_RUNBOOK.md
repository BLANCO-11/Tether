# Mock testing DBs — deploy runbook

Every onboarded Postgres datasource gets a fake twin: 10 deterministic rows per table,
generated from the schema alone (never `SELECT`s prod), executed in-process via PGlite.
Test runs read fakes. Live runs read prod. This page is how to roll it out.

## Deploy steps (in order)

1. **Migrate.** `pnpm --filter @foundry/server db:migrate` — applies `0062_mock_readiness`
   (`mock_status`/`mock_error` on fixtures, `use_prod_override` on executions,
   nullable DSN). The dev/test database needs it too, not just prod.
2. **Recreate services** (`up -d --build server`). The mocks dir is a named volume
   (`foundry_mockdata:/repo/data/mocks`) — files survive rebuilds. If the volume is
   ever lost, ready rows self-heal: the next refresh rebuilds the file deterministically.
3. **Rebuild existing datasources.** Nothing historical gets fakes automatically.
   Per datasource: `tsx src/mock/cli.ts --workspace=<id|name> --datasource=<id|name>`,
   or all: `--all`. Re-onboarding (schema refresh) does the same thing.
   Until rebuilt, test runs on old datasources HARD-REFUSE with a reason — announce this
   before deploy; it is the guarantee working, not an outage.

## Behavior after deploy

- **Test run, no opt-in** → mock engine. A missing/failed mock refuses (409 + reason),
  never silently reads prod. Missing mock file with a ready row rebuilds on next refresh.
- **Test run + "Use production data"** (Confirm-gated, default OFF) → admin+ only, every
  use audited (`access`/`datasource`), response carries `usedProductionData`. Authors get 403.
- **Live runs** → prod always; the override is ignored (asserted by test).
- **MySQL / other types** → loud refused-state. Postgres-only v1 by decision (no embedded
  MySQL-for-Node exists; the sidecar was cut). Fakes still generate; execution is refused
  with reason, not warn-and-read-prod.
- **Datasource page** → schema browser + mock viewer ("mock data — never production") +
  credential attach. No prod preview anywhere.

## What to check when something looks wrong

- `GET .../datasources/:ds/mock` → `building` (wait), `failed` + `mock_error` (rebuild),
  `null` (never onboarded — refresh first).
- `409 mock_file_missing` → refresh or run the CLI; it self-heals.
- Suspect a test touched prod? The draft path never decrypts the prod DSN without an
  override row — `usedProductionData` on the response + the audit event are the receipts.
