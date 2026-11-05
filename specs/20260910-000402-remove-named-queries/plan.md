# Implementation Plan: Remove Named Queries (backfilled 2026-09-10)

Recorded retroactively from the working tree on branch
`20260910-000402-remove-named-queries`. This plan describes what was ACTUALLY
built, not what was proposed.

## Stack (as implemented)

- pnpm workspaces, Node >= 22, TypeScript 5.7, Next 14 + React 18 + Tailwind 3.4
  (client), Express + Drizzle + Zod + Postgres (server), Kestra (orchestration),
  Vitest 2.1.8. No new dependencies were added by this feature.

## Structure of the change

### 1. Compiler extensions (`packages/server/src/services/db-operation.service.ts`)

- `andOn`: composite-key equalities on plain joins (resolution mirrors
  `onLeft`/`onRight`, strict: one bad pair fails the join); refused with
  `latestOne` (directed to the lookup's own filters).
- Compute expression tree: `{column}`, `{param}`, `{addDays}`, `{diffDays}`,
  `{diffMinutes}`, `{greatest}`, `{least}`, `{businessMinutes}`, `{coalesce}`
  (migrated from single-value `coalesceWith`). Params inside computes take
  positions after filters. `businessMinutes` is a fixed generate_series
  day-walk (Mon–Fri 09–17 UTC), the SQL twin of the itops oracle's walk.
- Readback (`db-operation-readback.ts`): every node renders in words for the
  approval screen (`the later of X and Y`, `the business minutes … from X
  to Y`, composite keys appended to the From line).

### 2. Operation catalogue (`packages/server/src/demo/catalogue/operations.ts`)

23 operations across 6 demo workspaces (was 12 across 4). New this pass:
`support_demo.ticket_sla_rows`, `orders_demo.open_order_line_rows`,
`hiring_demo.outstanding_offer_rows`, `itops_demo.incident_sla_rows`,
`itops_demo.oncall_roster_rows`, `itops_demo.vuln_finding_rows`, plus the
earlier `hr_demo` pair and `finance_demo` triple. Catalogue test was
strengthened: six domains, all-params (filters + lateral + aggregate +
compute) must carry human prose, every reader projects an address alias.

### 3. Flow migrations (all `datasource` → `query`, texts preserved)

- `scenarios/generic-flows.ts`: support (breach derived in jq with
  tonumber coercion), orders (per-order `group_by` rollup; late test reads
  source fields), hiring (direct projection, recruiter `//` manager).
- `scenarios/itops-flows.ts`: triage collapsed to one `incidents` query;
  single shaping transform rebuilds `consumed` per group and projects both
  `pages` (escalation recipient) and `tickets` arms; vuln split/staleness in
  jq (`stale_limit_days` is text → `tonumber`).
- `showcase/flows.ts`: rollup datasource replaced by month query + `rollupT`
  clone; assess/message/announce untouched.
- `scenarios/itops-verify.ts`: mail freshness window 200 → 2000 (capped
  fetch reported zero new mail once the capture table passed 200 rows).

### 4. Client removal (earlier in this branch, not this pass)

`NamedQueryPanel` + test deleted; `DbOperationsPanel`, builder, chat and
review surfaces re-pointed; `datasource` kind refused server-side with the
operations path named.

## Key decisions and measurements

- Consumed-minutes fidelity over clock shortcut: 3→7 breach drift measured,
  oracle agreement proven for all 30 incidents × 4 verify instants.
- Window clamp (`LEAST(coalesce(resolved,as_of),as_of)`): bare coalesce
  over-pages incidents resolved after the reading (caught at 2026-06-15).
- Escalation in the op (team address else org fallback), not in a cross-step
  jq join (Pebble feeds one step per expression; `rowSourceOf` skips
  multi-step reads).
- One shaping transform per flow where two guards read it (a continuation
  branch cannot declare `dependsOn`; a second shape would race its guard).
- Kestra render-time rules (measured, mechanism unisolated): select source
  rows before constructing; parenthesise `//` with field reads; every jq
  program in the tree was parse-checked with CLI jq (47 programs, zero
  syntax errors) after one unbalanced `map(` reached Kestra and failed
  opaquely in 2 ms with no logs.

## Verification performed

- `catalogue:seed`: 23/23 installed against live schemas; every new op's
  compiled SQL executed with live rows.
- Seeds green: finance (13/13 verify), generic (4 flows), itops-verify (both
  flows, all instants, arms + recipients + templates), showcase, hr.
- Server unit suite: 160 files, 2477 passed, 23 skipped.
