# Feature Specification: the Legal demo domain — contract lifecycle & obligations

**Branch**: `20260819-080932-legal-contract-demo-domain` | **Date**: 2026-08-19
**Status**: Draft — plan written, not implemented

## What this is

A third tenant. `legal_demo` — its own database, its own read-only role, its own workspace, its own
tool catalogue, its own named-query catalogue, and its own **independently written oracle** — modelling
**contract lifecycle management**: contracts, counterparties, renewal and notice deadlines, clause risk,
and per-contract obligations.

It is built the way `finance_demo` was built, by calling exactly the same `workspaceService`,
`toolService`, `datasourceService`, `datasourceQueryRepo`, `schemaIntrospectorService` and
`manifestBuilderService` with **no branch and no `if (legal)` anywhere in any of them**. If a third
tenant needs a code change inside a service, that change must appear in this feature as a special case
and be argued for — that is the point of adding a third one at all.

## Why a third domain, and why Legal

Two reasons the existing three datasets cannot serve.

**1. Two tenants prove separation; a third exercises it again, on a role nothing else has touched.**
`legal_ro` gets `CONNECT` on `legal_demo` and is checked against `hr_demo`, `hr_demo_alt` and
`finance_demo` — a three-way check written in the same shape `seed-finance-db.ts` uses, local to the
new seeder. ⚠ **This does not make the claim symmetric**, and the spec does not pretend otherwise:
`finance_ro` and the HR role are not checked against `legal_demo` by this feature, because doing so
means editing existing seeders and this feature deliberately edits none. See plan.md D-4 for the
consolidation that was considered and set aside, and SC-006 for the coverage actually delivered.

**2. Legal's failure mode is a class the existing traps do not contain.** Every trap measured so far
is *arithmetic or nullity*: percent-versus-fraction, cents-versus-dollars, a missing `COALESCE`, a
stale status. Legal's characteristic failure is **directional**: the same date arithmetic, run against
one boolean, produces two opposite obligations with two opposite recipients. Miss the notice deadline
on an `auto_renew = true` contract and you are locked into another term — money leaves. Miss it on an
`auto_renew = false` contract and the contract lapses — service stops. A flow that treats the two the
same sends a **termination notice to a counterparty it meant to renew with**, and every step of it
exits zero. No units check, no null check and no green run catches that.

Contract lifecycle also brings a trap class nothing in this repo currently exercises:
**already-actioned suppression**. A renewal reminder already sent is recorded, and re-sending it is
duplicate contact with an external party. Finance never had to suppress; a chase twice is merely
noise. A legal notice served twice, or served after the window closed, is a different kind of wrong.

## Why this is not "already done"

`finance_demo` has invoices with due dates and an overdue report, so "dates and deadlines" looks
covered. It is not, in three specific ways:

| | Finance | Legal |
|---|---|---|
| Deadline direction | **Backward** — the date passed, chase it | **Forward** — the date is coming, act before it |
| Boundary rule | Due today is **not** overdue (`>` not `>=`) | Deadline today is the **last chance** and must be urgent, not dropped (`<=` not `<`) |
| Fallback depth | One level — vendor terms → org default | **Two** — contract → contract type → org default |
| Consequence of missing it | One number wrong in a report | One of **two opposite actions**, to one of two opposite recipients |
| Re-running the flow | Chasing twice is noise | Noticing twice is **duplicate contact with a counterparty** |

The inverted boundary rule is deliberate and is the single most valuable thing here. A developer who
internalised *"due today is not overdue"* from the Finance dataset and carries `<` into a notice-window
query silently drops the one contract that could still have been saved. Two datasets that disagree on
the boundary is the only arrangement in which the rule has to be **read** rather than remembered.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A contract manager gets a renewal watchlist that is right, not merely green (Priority: P1)

A legal ops manager opens the Legal workspace and asks for a report of contracts whose notice deadline
falls in the next 90 days, split by urgency, with the counterparty contact and whether a reminder has
already gone out.

**Why P1**: This is the job the domain exists for, and it is where five of the nine traps meet in one
query.

**Acceptance**:

1. **Given** as-of `2026-06-30` and a 90-day lookahead, **When** `contracts_renewal_due` runs as
   `legal_ro`, **Then** its rows equal `legalOracle("2026-06-30", 90).renewalDue` exactly — same
   contract codes, same `notice_deadline`, same `urgency_bucket`, same `already_noticed` flag, in the
   same order.
2. **Given** a contract whose notice deadline is **exactly** the as-of date, **When** the report runs,
   **Then** that contract is present and in the most urgent bucket. It is the last day notice can be
   served; dropping it is the failure this assertion exists to catch.
3. **Given** the evergreen contract (`end_date IS NULL`), **When** the report runs, **Then** it is
   absent — and absent by an explicit predicate, not by NULL arithmetic that happens to compare false.
4. **Given** the superseded contract, **When** the report runs, **Then** the superseded row is absent
   and its successor is present with the successor's dates.
5. **Given** the contract whose `notice_period_days` is NULL on a contract type whose
   `default_notice_period_days` is also NULL, **When** the report runs, **Then** its notice period is
   the org-wide default and its deadline is computed from it. This contract is the highest-value one in
   the dataset, chosen so that dropping it is expensive rather than cosmetic.
6. **Given** as-of `2026-04-30`, **When** the report runs, **Then** it returns **zero rows** and does
   not error. The empty period is a first-class case, and it is the one a flow authored against a busy
   period tends to break on.

### User Story 2 — The auto-renew inversion is structurally unreachable (Priority: P1)

The same deadline, split at the catalogue level rather than left to a generated fragment's `if`.

**Why P1**: This is the trap with a real-world cost, and the mitigation is a design decision, not a test.

**Acceptance**:

1. **Given** the query catalogue, **Then** there are **two** deadline queries, not one with an
   `auto_renew` column to branch on: `contracts_renewal_due` (auto-renewing — the risk is being locked
   in; the notice goes **outward** to the counterparty) and `contracts_expiring_no_autorenew` (fixed
   term — the risk is a lapse; the warning goes **inward** to the contract owner).
2. **Given** either query, **Then** its `description` states in its first sentence who the recipient is
   and what happens if the deadline is missed, because the description is what the drafting model reads.
3. **Given** both queries at every as-of date, **Then** their result sets are **disjoint** and their
   union equals every contract in the window — asserted in `verify-legal.ts`, so a predicate drifting
   in one of them cannot silently drop or double-count a contract.
4. **Given** the tool catalogue, **Then** `mail_send_template` offers `renewal_notice` and
   `non_renewal_notice` as distinct templates with distinct `required` variables, so sending the wrong
   one to the wrong party is a 422 naming the missing variable rather than a plausible-looking email.

### User Story 3 — An obligation reminder reaches a real person, once, and only if it is really open (Priority: P1)

Obligations attached to contracts — a quarterly report to deliver, a payment to make, data to delete —
each with an owner and a due date.

**Why P1**: Second oracle-checked job, and it carries the fallback and stale-status traps in a shape
Finance's do not cover.

**Acceptance**:

1. **Given** the obligation whose `owner_email` is NULL, **When** `obligations_due` runs, **Then**
   `resolved_owner_email` is the parent contract's `owner_email`, and no row anywhere in the result has
   a NULL or `"None"` recipient.
2. **Given** the obligation with a row in `obligation_completions` whose `status` still reads `open`,
   **When** `obligations_due` runs, **Then** it is **absent**. Completion comes from the completions
   table; `status` is the register's opinion and is documented as not always current.
3. **Given** the **waived** obligation that is past its due date, **When** `obligations_due` runs,
   **Then** it is absent. Settled is settled — the same rule as Finance's rejected claim, deliberately
   restated in a second domain because it was missed once already.
4. **Given** every as-of date, **Then** the returned open/overdue counts equal
   `legalOracle(...).obligationsDue` and `.obligationsOverdue`.

### User Story 4 — A notice that could not be served is escalated, not counted as sent (Priority: P2)

One counterparty has no contact email at all; one is on a domain that always hard-bounces.

**Why P2**: The mechanism (`mail_send` returning `202` with `bounce_reason`) already exists and is
already exercised by HR and Finance. What is new is the **stake**, and the stake belongs in the prose
a model reads.

**Acceptance**:

1. **Given** the counterparty with `contact_email IS NULL`, **Then** no flow passes a null recipient to
   `mail_send`, and `counterparty_contract_summary` reports its `contact_status` as `no_contact_email`.
2. **Given** the counterparty on `*-bounce.example`, **When** a notice is sent, **Then** the tool
   returns `202` with `status: "bounced"`, and the tool description states plainly that for a legal
   notice an unserved notice means **the notice period never started** — an escalation, not a logged
   warning.
3. **Given** as-of `2026-06-30`, **Then** both the unmailable and the bouncing counterparty have
   something actionable in the window. This is the only as-of date where that is true, and it is the
   default for exactly that reason.

### User Story 5 — `legal_ro` can reach `legal_demo` and no other tenant (Priority: P1)

**Why P1**: The reason for a third tenant.

**Acceptance**:

1. **Given** a seeded `legal_demo`, **When** `verifyLegalReadOnlyRole` re-derives privileges from
   `pg_catalog`, **Then** `legal_ro` holds `SELECT` on every table, **none** of
   `INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER` on any, no `CREATE` on `public`, no `TEMPORARY`,
   and is not `SUPERUSER`/`CREATEDB`/`CREATEROLE`/`BYPASSRLS`.
2. **Given** the same check, **Then** `legal_ro` has no `CONNECT` on `hr_demo`, `hr_demo_alt` or
   `finance_demo` — from a **hardcoded list local to `seed-legal-db.ts`**, the same idiom
   `seed-finance-db.ts` uses, filtered against `pg_database` so a database that was never seeded does
   not make the check throw.
3. **Given** that list, **Then** it carries a comment naming the two other files that spell the same
   claim out (`seed-finance-db.ts`, `datasource-target.test.ts`), so the duplication is visible to
   whoever adds a fourth tenant rather than reading as three coincidences. ⚠ **The reverse directions
   are NOT checked** — see SC-006.
4. **Given** the Legal tool catalogue, **Then** it registers no `hr_*` tool and the Legal workspace
   holds no `HR_DIRECTORY_TOKEN` — so even a hand-written tool row aimed at `/hr/employees` returns
   `401` rather than another tenant's people.

### Edge Cases

- **Notice deadline in the past, contract still active.** A *missed* deadline. It is not dropped and it
  is not lumped in with "due in 14 days" — it gets its own `missed` bucket, because the action is
  different (there is no notice to serve; someone has to be told the window closed).
- **Notice period longer than the contract term.** One contract has a 90-day notice period on a 6-month
  term, so its notice deadline falls before its own start date. Reportable, not an error, and it must
  not produce a negative `days_to_deadline` rendered as "-42 days to act".
- **Two contracts with the same title, different counterparties.** The negative control for
  supersession: only `superseded_by_id` establishes a chain. A rule keyed on title matches both and is
  wrong — the same shape as Finance's `INV-2026-0002 / INV-2026-0013` duplicate negative control.
- **A notice already sent, from the *previous* renewal cycle.** Must be noticed **again** this cycle.
  An `EXISTS (SELECT 1 FROM notice_log …)` with no date bound suppresses it and the contract auto-renews
  in silence. The date-bounded form is in the catalogue; this is the row that proves the bound is there.
- **A counterparty with zero live contracts.** Present in `counterparty_contract_summary` via a
  `LEFT JOIN` — the empty-group case, mirroring Finance's `CC-RND`. An inner join drops it, and a
  counterparty whose contracts have all lapsed is exactly what the summary exists to surface.
- **A draft contract with no `signed_date`.** Never in any deadline report. It is not yet a contract.
- **`liability_cap_multiple` is a MULTIPLE, not an amount.** `2.00` means twice annual value, not
  $2.00. The column name carries the unit and the query aliases it `liability_cap_multiple_x`, because
  a report that renders it with a currency symbol is a units trap of a different kind from Finance's.
- **Database unreachable.** `legal:verify` **fails**. It does not skip its stronger half — a verifier
  that quietly drops the half that matters is the false green this repo keeps finding.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** A `legal_demo` Postgres database, created by the seeder, holding **10 tables** in schema
  `public`: `org_settings`, `legal_entities`, `counterparties`, `contract_types`, `contracts`,
  `contract_clauses`, `obligations`, `obligation_completions`, `notice_log`, and
  `contract_relationships` (see FR-004).
- **FR-002** All data **synthetic**. Every address on an RFC 2606 reserved domain — `acme-legal.example`
  for internal owners, per-counterparty `*.example` domains, and `*-bounce.example` for the
  undeliverable one, matching the suffix rule `isBouncingAddress` already applies.
- **FR-003** The dataset is defined in TypeScript (`legal-dataset.ts`) and inserted from those
  definitions, never from SQL literals — so the oracle and the seed cannot disagree about what was
  loaded.
- **FR-004** Supersession is modelled by `contracts.superseded_by_id` (self-referencing, NULL at the
  head of every chain). `contract_relationships` records non-supersession links (`amends`, `sow_under`,
  `dpa_for`) so an MSA→SOW hierarchy exists without overloading one column with two meanings.
- **FR-005** **Two-level notice-period fallback**: `contracts.notice_period_days` →
  `contract_types.default_notice_period_days` → `org_settings.default_notice_period_days`. At least one
  contract requires **both** hops, and it is the highest-value contract in the dataset.
- **FR-006** **The notice-window boundary is INCLUSIVE of the as-of date** and this is stated in the
  schema comment, the dataset docblock and the query description. One contract sits exactly on it at
  each of the three as-of dates.
- **FR-007** `auto_renew` splits the domain into two catalogue queries with two recipients and two
  templates. No single query returns both populations with a flag to branch on.
- **FR-008** Obligation completion is derived from `obligation_completions`, never from
  `obligations.status`. One obligation is completed while its status still reads `open`; one is `waived`
  and past due.
- **FR-009** `notice_log` supports **date-bounded** already-noticed suppression. One contract in the
  current window is already noticed; one has a notice from a prior cycle and must be noticed again.
- **FR-010** `contracts.value_cents` is `bigint` **MINOR units**; `contract_clauses
  .liability_cap_multiple` is `numeric(4,2)` and is a **multiple of annual value**, not currency. Both
  units are in the column comments.
- **FR-011** Three as-of dates — `2026-04-30`, `2026-05-31`, `2026-06-30` — matching the Finance
  period grid. `2026-04-30` is the **empty** case (zero in the window, zero obligations overdue);
  `2026-06-30` is the default and the only one where both the unmailable and bouncing counterparties
  have something actionable. Three facts hold at **every** as-of date: exactly one contract on the
  notice boundary, exactly one obligation whose status is stale, exactly one counterparty with zero
  live contracts.
- **FR-012** `legalOracle(asOf, lookaheadDays)` computes every claim **from the definitions in
  `legal-dataset.ts`**, never from a query result and never from a flow run. It is **not** a
  parameterisation of `financeOracle()` or `expectedScreening()`, and `legal-tools.test.ts` asserts it
  shares no implementation with them.
- **FR-013** **Five named queries**, each authored to the rules `POST …/datasources/:id/queries`
  enforces (one read statement, positional parameters only, `paramsSchema` matching the declared
  parameters) and each run through `checkSqlShape` at provision time before insert:
  `contracts_renewal_due`, `contracts_expiring_no_autorenew`, `obligations_due`,
  `nonstandard_clause_register`, `counterparty_contract_summary`.
- **FR-014** The two-level `COALESCE`, the inclusive boundary and the date-bounded suppression are
  **resolved in SQL in the catalogue**. A trap resolved in the catalogue is structurally unreachable;
  a trap left for a generated fragment is one the measured baseline says is missed roughly two times in
  three.
- **FR-015** A Legal tool catalogue of **8 tools** over the **same** ops-api endpoints, methods and
  auth styles the Finance catalogue uses — `mail_send`, `mail_send_template`, `chat_list_channels`,
  `chat_post_message`, `ticket_create`, `ticket_update`, `ticket_search`, `llm_complete` — with Legal
  prose. **No `hr_*` tool** and **no `HR_DIRECTORY_TOKEN`**. ⚠ Verified 2026-08-19: those 8 exercise
  **two** auth styles (`header`, `query`), while `FINANCE_OPS_SERVICES` stores **five** credentials —
  there is no probe tool, so `basic` is stored and never presented. Legal mirrors that arrangement; see
  plan.md D-6b for why it is mirrored rather than quietly narrowed.
- **FR-016** ops-api gains two channels (`#legal-ops`, `#contracts-renewals`) and three mail templates
  (`renewal_notice`, `obligation_reminder`, `non_renewal_notice`), each with enforced `required`
  variables so a notice that never resolved its deadline 422s instead of being served with
  `{{notice_deadline}}` in the body.
- **FR-017** A `legal_ro` role with `CONNECT` on `legal_demo` only, password derived from
  `CREDENTIAL_ENC_KEY` under a **distinct salt** so a reseed does not rotate a password already
  encrypted into `datasources.connection_string_enc`. Grants issued **after** the DDL and the data,
  because `legal-schema.sql` drops and recreates every table and table privileges die with the table.
- **FR-018** `verifyLegalReadOnlyRole` checks that `legal_ro` has no `CONNECT` to `hr_demo`,
  `hr_demo_alt` or `finance_demo`, from a **hardcoded list local to `seed-legal-db.ts`** — the same
  idiom `seed-finance-db.ts` uses — filtered against `pg_database` first. ⚠ **No shared roster module,
  and no edit to any existing seeder**: the new tenant's seed code stays identical in shape to the
  existing ones. The cost (the claim is spelled out in three files, and is not symmetric) is stated in
  plan.md D-4 and bounded by SC-006.
- **FR-019** Schema introspection performed **as `legal_ro`**, so the manifest is exactly the surface
  the credential can read.
- **FR-020** `provisionLegal()` is **idempotent**: reuses the workspace by name, upserts tools and
  queries by name, and creates **no flows and no triggers**.
- **FR-021** `pnpm --filter @foundry/server legal:seed` and `legal:verify`, plus a `provision-legal` /
  `seed-legal` case in `demo/cli.ts` and `cp src/demo/legal/*.sql` in the server build.
- **FR-022** `verify-legal.ts` has the same two halves as `verify-finance.ts`: (A) invariants of the
  definitions with no database, (B) **every named query executed as `legal_ro` at all three as-of dates
  and compared to the oracle**. It fails, not skips, when the database is unreachable.
- **FR-023** `legal_demo` added to `scripts/backup.sh`'s `DEMO_DBS`; `legal` added to
  `tidy-litter.ts`'s `PROTECTED_SLUGS`; `verify-dataset.ts`'s pointer note names `legal:verify`.
- **FR-024** `LEGAL_DB_NAME`, `LEGAL_DB_RO_ROLE` and `LEGAL_DB_RO_PASSWORD` documented in
  `.env.example` — **and the equivalent `FINANCE_*` variables, which are read today and documented
  nowhere.** Constitution VII; found while reading for this plan.

### Key Entities

- **Counterparty** — the external party. Has a nullable `contact_email` and a `vendor_code` that is a
  **soft reference** to `finance_demo.vendors.vendor_code` with **no foreign key**, because the two
  tenants are two databases and cannot be joined. Correlating them is a deliberate cross-tenant
  exercise that must go through the product, not through SQL.
- **Contract** — the agreement. Dates, `auto_renew`, a nullable two-level-resolved notice period, a
  status, a nullable `superseded_by_id`, `value_cents` in minor units.
- **Contract type** — `msa | nda | dpa | sow | saas | lease`, carrying the mid-level notice default
  (NULL for some types, which is what makes the second hop real).
- **Contract clause** — extracted clause with `is_non_standard`, `risk_rating` and
  `liability_cap_multiple` (a multiple, not an amount).
- **Obligation** — a dated duty under a contract, with a nullable owner that falls back to the
  contract's, and a status that is documented as not authoritative.
- **Obligation completion** — the evidence row. The truth about whether an obligation is done.
- **Notice log** — what was sent, to whom, when. The basis of date-bounded suppression.
- **Legal entity** — which of our entities is the contracting party. Two entities, so an entity-scoped
  report is possible and a report that forgets to scope is visibly wrong.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** `pnpm --filter @foundry/server legal:seed` from a clean database exits `0`, reporting the
  workspace id, 8 tools, 5 named queries, 10 tables introspected, a manifest version, and
  `read-only role legal_ro: SELECT on 10 table(s), no write privileges, no CONNECT to hr_demo, hr_demo_alt, finance_demo` — the three named, not a blanket claim (SC-006).
- **SC-002** `pnpm --filter @foundry/server legal:verify` exits `0` with **both** halves run: every
  invariant of the definitions, and all 5 queries × 3 as-of dates agreeing with the oracle **row for
  row**.
- **SC-003** Re-running `legal:seed` twice in a row produces `workspaceCreated: false`, `created: 0`
  tools, an unchanged manifest version, and identical row counts. Idempotency, not convergence.
- **SC-004** All 9 traps assertable and asserted, each by name, in `verify-legal.ts` half A.
- **SC-005** `contracts_renewal_due` and `contracts_expiring_no_autorenew` are **disjoint** and their
  union is complete, at all three as-of dates.
- **SC-006** `legal_ro` has no `CONNECT` to any of the three other tenant databases — **three
  directions checked, of the six that exist.** ⚠ Stated as the real number deliberately: `finance_ro`
  and the HR role are **not** checked against `legal_demo`, because that needs an edit to existing
  seeders which this feature does not make. Do not describe this feature as proving symmetric tenant
  isolation.
- **SC-007** `pnpm -r typecheck` and `pnpm -r test` pass. No service file gains a Legal branch —
  reviewable as a diff over `packages/server/src/services/`, which must be **empty of behaviour
  changes**.
- **SC-008** No drizzle migration is added. Current head stays `0039_bright_thundra`; a `0040`
  appearing in this feature means somebody persisted demo data in the parent database.

## Out of Scope

- **Legal flows / scenarios.** No entry in `src/scenarios/`. This feature delivers the data, the
  callable catalogue and the oracle; authoring automations against them is a separate piece of work
  and should be done **through the product** so it demonstrates the product.
- **Any change to Finance, HR or the alt dataset — data or code.** **No existing seeder is edited**:
  not `seed-finance-db.ts`, not `demo/hr-roles.ts`, not `seed-alt-db.ts`. Legal is purely additive.
- **A shared tenant-roster module.** Considered and deliberately not built here; plan.md D-4 carries
  the reasoning and the cost. It would touch every existing seeder, which is exactly what this feature
  avoids, so it belongs on its own branch argued on its own merits.
- **A named-schema or view-based variant.** `hr_demo_alt` already covers named schemas, views and
  composite keys. Legal uses `public` and base tables, so the only new variable is the domain.
- **A Legal directory service** (a `legal_*` tool set over HTTP). Inventing one to reach `bearer`
  auth-style coverage would be building a service to satisfy a checklist; Legal exercises the same four
  styles Finance's tools exercise, and the gap is the same documented gap.
- **Cross-tenant joins.** The `vendor_code` soft link is deliberately not joinable. Nothing in this
  feature makes it so.
- **Multi-currency / FX.** `value_cents` is USD throughout. The units lesson is Finance's; repeating it
  here would be a copy, not a second lesson.

## Assumptions

- Postgres is reachable at `config.databaseUrl` with rights to `CREATE DATABASE` and `CREATE ROLE`, as
  `demo:seed` and `finance:seed` already assume.
- ops-api is running for tool calls; the data seed and half A of the verifier do not need it.
- `CREDENTIAL_ENC_KEY` is set. The derived-password path falls back to `"0".repeat(64)` exactly as the
  HR and Finance seeders do, so a missing key is a development inconvenience, not a new failure mode.
- The three as-of dates stay fixed. They are not `Date.now()`-relative — a dataset whose traps move
  with the clock cannot have an oracle.
