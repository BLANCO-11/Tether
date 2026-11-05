# Quickstart: validating resource detail schema + DB operations

## Prerequisites

- Stack up (`docker compose`), workspaces seeded (`pnpm --filter @foundry/server seed:all`).
- Node 22 (`vitest.config.ts` throws below it).

## Automated

```bash
pnpm --filter @foundry/client test -- resources
pnpm --filter @foundry/client test          # full client suite stays green
pnpm --filter @foundry/client typecheck
./scripts/ui-honesty-check.sh
```

Expected: the resources suites pass, including the new both-directions assertions; the honesty
check's PASS/FAIL counts are no worse than the pre-change baseline (capture it first).

## Manual

1. Open `/resources?type=datasource` and pick a seeded datasource (Finance → `finance_demo`).
2. **FR-001**: a Schema section lists the discovered tables; expanding one shows columns.
3. **FR-002**: a DB operations section lists that datasource's existing operations
   (`finance_demo` has 6 after `catalogue:seed`) and offers creation.
4. **FR-003 / SC-003**: switch to `?type=connector`, open one (e.g. an email connector) — neither
   section renders.
5. **FR-007 / SC-004**: confirm no text on the page refers to "the data source schema view".

## Expected data after seeding

| Datasource | Readers (DB operations) |
| :-- | --: |
| finance_demo | 6 |
| itops_demo | 3 |
| hr_demo | 2 |
| support_demo / orders_demo / hiring_demo | 4 each |
| legal_demo / hr_demo_alt | 0 (exercises the honest-empty list) |

`legal_demo` is the useful manual case for an empty operations list with a **non**-empty schema.
