# Implementation Plan: the Legal demo domain — contract lifecycle & obligations

**Branch**: `20260819-080932-legal-contract-demo-domain` | **Date**: 2026-08-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260819-080932-legal-contract-demo-domain/spec.md`

## Summary

A **third tenant**: `legal_demo`, `legal_ro`, a `Legal` workspace, an 8-tool catalogue, 5 named queries
and an independently written `legalOracle()`, modelling **contract lifecycle and obligations**.

It follows `demo/finance/` file for file, because that shape is already proven and copying it is the
cheapest way to demonstrate that a new tenant needs **no change inside any service**. **Nothing about
the mechanics is new** — the seeder, the role setup, the derived password, the grant ordering, the
provisioning sequence and the two-half verifier are the Finance ones with Legal data in them. Two things
about the *data* are new rather than copied:

1. **An inverted boundary rule.** Finance: *due today is not overdue*. Legal: *a notice deadline today
   is the last chance and must be urgent*. Two datasets that disagree force the rule to be read.
2. **A directional trap.** `auto_renew` turns one date calculation into two opposite actions with two
   opposite recipients. Resolved **structurally** — two catalogue queries, not one flag — which is the
   same move as resolving a `COALESCE` in SQL.

**Shape of the change**: **19 files** — 9 new, 10 edited. No drizzle migration, no new npm dependency,
no client file, **no new shared module**, **no edit to any existing seeder**, and **no behaviour change
anywhere under `packages/server/src/services/`** — the two files touched there are a test's tenant list
and a docblock.

**Three phases, each shippable alone**: P1 the data and the oracle (verifiable with `psql` and half A);
P2 the callable surface (`legal:seed` end to end); P3 the oracle harness and the housekeeping
(`legal:verify` both halves).

## Technical Context

**Language/Version**: TypeScript 5, Node ≥ 22, ESM (`"type": "module"`)

**Primary Dependencies**: `pg` (direct `Client`, as every seeder uses), `zod` via
`createToolSchema`. **No new dependency.**

**Storage**: a **new Postgres database** `legal_demo`, created by the seeder at run time on the same
cluster as `foundry_parent`. **No drizzle migration.** ⚠ The current head is `0039_bright_thundra`; a
`0040` appearing in this feature means somebody persisted demo data in the parent database, which is
the mistake `hr_demo` exists to prevent (the introspector is hardcoded to `table_schema = 'public'`, so
demo tables in the parent DB would appear to the agent as queryable business data alongside `scripts`
and `triggers`).

**Testing**: `vitest`. New suites: `demo/legal/legal-tools.test.ts`,
`demo/legal/legal-dataset.test.ts`. Edited: `services/datasource-target.test.ts` (roster). Plus two
non-vitest harnesses run by hand and in CI: `legal:seed` and `legal:verify`.

**Target Platform**: Linux, Postgres 14+. The `REVOKE CREATE ON SCHEMA public FROM PUBLIC` ordering in
the role setup is a PG ≤ 14 requirement and is copied verbatim from the Finance seeder, comment
included — it has bitten this repo twice.

**Project Type**: pnpm monorepo. **Server + ops-api only.** `packages/client` is untouched, so
`ui-honesty-check.sh` gains no assertion and needs no run.

**Performance Goals**: none meaningful. ~120 rows across 10 tables; the seed is one connection and
ten multi-row `INSERT`s. `ANALYZE` runs as the owner **before** the grants so `pg_class.reltuples` is
populated for the read-only role's introspection — a never-analysed table reports `-1`, which the
manifest renders as an unknown row count.

**Constraints**: no migration; no service-layer behaviour change; no `Date.now()` anywhere in the
dataset (a dataset whose traps move with the clock cannot have an oracle); no shared oracle code with
Finance or HR; no flows or triggers created by provisioning.

**Scale/Scope**: 10 tables, ~120 rows, 3 as-of dates, 9 named traps, 5 named queries, 8 tools,
2 new chat channels, 3 new mail templates.

## Constitution Check

| Gate | Status |
|---|---|
| **I — Spec-first** | **PASS.** This directory is the feature. ⚠ `.specify/feature.json` still points at `specs/20260818-084135-email-send-tool` and must be repointed here before `/speckit-implement`, or the agent hooks and the pre-commit gate refuse the source writes. Deliberately **not** repointed by this plan — flipping the active feature out from under in-flight work is the author's call. |
| **II — Test-first** | **PASS.** T004 writes `legal-dataset.test.ts` (trap invariants) before `legal-dataset.ts` exists, so it fails to compile first; T015 writes the isolation and endpoint-parity suite before provisioning is wired. The two controls that matter — the inclusive boundary and the disjointness of the two deadline queries — are specified in T004 and T021 before the SQL they check. |
| **III — Code review** | **PASS.** The diff is reviewable in one specific way worth stating: `git diff --stat packages/server/src/services/` must show **exactly two files** — `datasource-target.test.ts` (one literal added to `TENANT_DBS`) and `datasource-target.service.ts` (a docblock row) — and **neither changes behaviour**. Any third file there is a Legal special case that leaked into a service, and it is the review finding (T032). Also reviewable: `git diff packages/server/src/demo/finance/ packages/server/src/demo/*.ts` touches only `cli.ts`, `tidy-litter.ts` and `verify-dataset.ts` — **no existing seeder is edited**. |
| **IV — Simplicity** | **PASS, and it is why there is NO new shared module.** Legal adds one directory and edits nothing structural. Three abstractions are deliberately absent: no `demo/tenant-databases.ts` roster (D-4), no shared `demo/tenant-provision-base.ts` (the near-duplication between the provisioners is *legible* duplication, and a base class would be the branch-free claim smuggled back in as inheritance), and no generic "domain descriptor" config. |
| **V — Observability** | **PASS.** `legal:seed` prints the same structured line Finance's does, including trap counts, and sets a non-zero exit code on any role problem, secret collision or unstored secret. `legal:verify` names the failing row, not just the count. |
| **VI — Branch discipline** | **PASS.** One branch, phases land in order, each phase leaves the repo green. |
| **VII — Documentation currency** | **PASS, and it repays a debt.** `.env.example` gains `LEGAL_DB_NAME`/`LEGAL_DB_RO_ROLE`/`LEGAL_DB_RO_PASSWORD` **and the `FINANCE_*` equivalents, which are read by `seed-finance-db.ts` today and documented nowhere.** `CLAUDE.md` gains one paragraph. `verify-dataset.ts`'s "run finance:verify too" note gains Legal. |
| **VIII — Secrets hygiene** | **PASS.** No credential in source. `legal_ro`'s password is HMAC-derived from `CREDENTIAL_ENC_KEY` under the salt `legal_demo:read-only-role:v1` — distinct from HR's and Finance's, so the three roles do not share a password despite sharing a derivation. The owner DSN stays parent-side and is never registered. Every ops credential is `opsServiceKey(service)`-derived, as Finance's are. |
| **No fingerprint moves** | **PASS.** Nothing touches `paramsSchema` on an existing tool, existing manifest XML, `refFingerprints()` or the compiler's emitted YAML. The **new** Legal manifest is a first version, not a move. |
| **No silent cap** | **PASS.** The only bound is `contracts_renewal_due`'s `limit` parameter, which is a caller-supplied `LIMIT` with a documented default, and `verify-legal.ts` runs every query **unbounded** so a cap can never hide a row from the oracle comparison. |
| **UI honesty** | **N/A** — no client file changes. |

## Project Structure

### Documentation (this feature)

```
specs/20260819-080932-legal-contract-demo-domain/
├── spec.md      # the feature specification
├── plan.md      # this file
└── tasks.md     # the ordered task list
```

No `data-model.md`: the data model is `legal-schema.sql` plus `legal-dataset.ts`, both of which are
heavily commented by house convention, and a third copy of it in markdown would be the copy that goes
stale. No `research.md`: nothing here is unknown — the pattern is `demo/finance/`.

### Source Code (repository root)

```
packages/server/src/demo/
├── cli.ts                           # EDIT — provision-legal | seed-legal case
├── verify-dataset.ts                # EDIT — pointer note names legal:verify
├── tidy-litter.ts                   # EDIT — PROTECTED_SLUGS += "legal"
└── legal/                           # NEW DIRECTORY — 9 files, and the ONLY new code
    ├── legal-schema.sql             # 10 tables, traps documented in comments
    ├── legal-dataset.ts             # definitions + legalOracle()
    ├── legal-dataset.test.ts        # trap invariants, no database
    ├── seed-legal-db.ts             # database, DDL, rows, ANALYZE, role, verify
    ├── legal-queries.ts             # 5 named queries; traps resolved in SQL
    ├── legal-tools.ts               # 8 tools; no hr_*, no HR_DIRECTORY_TOKEN
    ├── legal-tools.test.ts          # isolation + endpoint-parity with Finance
    ├── provision-legal.ts           # workspace, tools, secrets, ds, queries, manifest
    └── verify-legal.ts              # half A invariants + half B oracle-vs-SQL

packages/ops-api/src/routes/ops.ts   # EDIT — 2 channels, 3 mail templates
packages/server/src/services/datasource-target.test.ts  # EDIT — TENANT_DBS += "legal_demo"
packages/server/src/services/datasource-target.service.ts # EDIT — docblock table row (comment only)
packages/server/package.json         # EDIT — legal:seed, legal:verify, build cp
scripts/backup.sh                    # EDIT — DEMO_DBS += legal_demo
.env.example                         # EDIT — LEGAL_* and the undocumented FINANCE_*
CLAUDE.md                            # EDIT — one paragraph
```

## The domain, concretely

### Tables (10)

| Table | Rows | Carries |
|---|---|---|
| `org_settings` | 4 | `default_notice_period_days` = 60, `renewal_lookahead_days` = 90, `obligation_reminder_lead_days` = 14, `default_governing_law` |
| `legal_entities` | 2 | Which of our entities contracts. Makes an entity-scoped report possible, and a report that forgets to scope visibly wrong |
| `counterparties` | 11 | One `contact_email IS NULL`, one on `*-bounce.example`, one with **zero live contracts**, a `vendor_code` soft link to `finance_demo` with **no FK** |
| `contract_types` | 6 | `msa`/`nda`/`dpa`/`sow`/`saas`/`lease`; **`default_notice_period_days` NULL for 2 of them** — the second hop |
| `contracts` | 24 | Dates, `auto_renew`, nullable `notice_period_days`, `status`, nullable `superseded_by_id`, `value_cents` (minor) |
| `contract_relationships` | 5 | `amends` / `sow_under` / `dpa_for` — hierarchy without overloading `superseded_by_id` |
| `contract_clauses` | 20 | `is_non_standard`, `risk_rating`, `liability_cap_multiple` (a **multiple**, not currency) |
| `obligations` | 22 | Nullable `owner_email` (falls back to the contract's), `due_date`, `recurrence`, non-authoritative `status` |
| `obligation_completions` | 9 | The truth about completion. One exists for an obligation still marked `open` |
| `notice_log` | 6 | One notice inside the current window (suppress), one from a prior cycle (do **not** suppress) |

### The nine traps, and what each one costs

1. **Inclusive notice boundary.** A contract whose notice deadline is exactly the as-of date is the last
   day notice can be served. A `<` where `<=` belongs drops the one contract still saveable. ⚠ This is
   **the opposite** of Finance's `>` rule and the disagreement is the point.
2. **Two-level notice fallback.** contract → type → org default. One contract needs **both** hops and
   is the highest-value contract in the dataset, so a single-level `COALESCE` loses the expensive one.
3. **Evergreen contract** (`end_date IS NULL`). No renewal date exists. Must be excluded by an explicit
   predicate; NULL date arithmetic sorts it to the top of "most urgent".
4. **Supersession.** `status = 'superseded'` with `superseded_by_id` set; the successor holds the live
   dates. Reporting the superseded row chases a counterparty about a contract that no longer governs.
   **Negative control**: two contracts share a title prefix with different counterparties — title
   matching finds a chain that is not there.
5. **⚠ The auto-renew inversion — load-bearing.** Same date maths, one boolean, two opposite actions and
   two opposite recipients. Miss it on `auto_renew = true` and you are locked in for another term; miss
   it on `false` and the contract lapses. Getting it backwards serves a **termination notice to a
   counterparty you meant to renew with**, and every step exits zero. **Resolved structurally** by two
   catalogue queries.
6. **Obligation owner fallback.** `obligations.owner_email` NULL → `contracts.owner_email`. One
   obligation relies on it; without the `COALESCE` the reminder goes to nobody, or to `"None"`.
7. **Stale obligation status + a waived obligation past due.** Completion comes from
   `obligation_completions`; `status` lags. A waived obligation is settled and must never be chased —
   the same rule as Finance's rejected claim, restated because it was missed once already.
8. **Date-bounded already-noticed suppression.** One contract already noticed this cycle (suppress);
   one noticed in a prior cycle (notify again). An `EXISTS` with no date bound suppresses the wrong one
   and the contract auto-renews in silence.
9. **Unmailable and bouncing counterparties.** Same mechanism as HR and Finance, different stake: an
   unserved **legal notice** means the notice period never started. That is an escalation, not a logged
   warning, and the tool description says so.

### As-of dates

`2026-04-30`, `2026-05-31`, `2026-06-30` — the same grid as Finance's periods, so a reviewer moving
between tenants is comparing like with like.

- **2026-04-30** — **zero** contracts in the notice window, **zero** obligations overdue. The empty
  case, and the only date that exercises it.
- **2026-05-31** — a moderate window; one missed deadline; the superseded chain is live here.
- **2026-06-30** — the default and the richest: contracts in all four urgency buckets, and the **only**
  date where both the unmailable and the bouncing counterparty have something actionable.

Three facts hold at **every** as-of date, which is what makes them assertable rather than tuned:
exactly one contract sits on the notice boundary, exactly one obligation's status is stale, exactly one
counterparty has zero live contracts.

### The five named queries

| Query | Params | Resolves |
|---|---|---|
| `contracts_renewal_due` | `as_of`, `lookahead_days`, `limit` | Two-level `COALESCE`; **inclusive** boundary; excludes evergreen/superseded/draft/terminated; returns `notice_deadline`, `days_to_deadline`, `urgency_bucket` (`missed`/`0-14`/`15-30`/`31-90`), `already_noticed` (date-bounded), counterparty contact. **`auto_renew = true` only.** |
| `contracts_expiring_no_autorenew` | `as_of`, `lookahead_days` | Same date maths, **`auto_renew = false` only**, internal recipient (`owner_email`). The structural half of trap 5. |
| `obligations_due` | `as_of`, `lookahead_days` | Completion from `obligation_completions`, not `status`; excludes `waived`; `resolved_owner_email` via `COALESCE`; `overdue` boolean. |
| `nonstandard_clause_register` | `risk_rating` | Non-standard clauses with contract, counterparty, owner, and `liability_cap_multiple_x` — the unit in the alias. |
| `counterparty_contract_summary` | `as_of` | Per counterparty via **`LEFT JOIN`** so the zero-contract one appears: live count, total `value_cents`, next notice deadline, `contact_status` (`ok`/`no_contact_email`/`bouncing`). |

Each is one read statement with positional parameters, and `provision-legal.ts` runs all five through
`checkSqlShape` **before** insert — the same function `POST …/datasources/:id/queries` uses. Seed data
that could not be authored through the product would demonstrate something the product cannot do, and
this check has caught real mistakes in hand-written queries.

**What the queries deliberately do not decide**: whether a deadline 40 days out is worth an email. They
return `days_to_deadline` and `urgency_bucket`; the judgement is the flow's, and a person can see it on
the DAG.

## Key decisions

**D-1 — Two deadline queries, not one with an `auto_renew` column.** The whole justification for a third
tenant is a trap the existing ones cannot express, and the mitigation for this one is a *design*
decision. One query plus a flag leaves the inversion for a generated fragment to get right, and the
measured baseline for fragment-level branching is poor. Two queries make the wrong recipient a
*different call site*, which review can see. Cost, stated plainly: the date arithmetic is duplicated
across two SQL bodies, and `verify-legal.ts` asserts disjointness-and-completeness at every as-of date
so it cannot drift.

**D-2 — `public` schema, base tables.** `hr_demo_alt` already covers named schemas, views, composite
keys and fraction-versus-percentage. Repeating any of that here would add a variable without adding a
lesson. Legal changes exactly one thing: the domain.

**D-3 — Oracle written independently, from the definitions.** `legalOracle()` is **not** a
parameterisation of `financeOracle()`. The swap rehearsal established the reason: a shared oracle lets
a shared bug produce a wrong answer that agrees with itself. It is also computed from the TypeScript
definitions, never from a query result — if it read the database it would be a second implementation of
the same SQL and the two would be wrong together the first time somebody fixed a bug in one.

**D-4 — Legal's cross-tenant check is a hardcoded list local to `seed-legal-db.ts`, exactly like
Finance's. A shared tenant roster was considered and is NOT in this feature.**

The roster idea was: replace `seed-finance-db.ts`'s single `has_database_privilege(role, hr_demo,
'CONNECT')` check and `datasource-target.test.ts`'s `TENANT_DBS = [dbName, altDbName, "finance_demo"]`
with one module, so the assertion becomes *"my own database and no other tenant's"* and a fourth tenant
is covered without touching a seeder. **Set aside deliberately: this feature keeps the new tenant's seed
code identical in shape to the existing ones, and touches no existing seeder.**

What Legal does instead — the same idiom Finance uses, one file, no import from a sibling tenant:

```ts
// seed-legal-db.ts — the databases this role must NOT be able to reach.
// Hardcoded, local, and in the same shape seed-finance-db.ts uses. See the plan's D-4.
const OTHER_TENANT_DBS = [config.demo.dbName, config.demo.altDbName, "finance_demo"];
```

⚠ **The cost, stated rather than discovered later**: the isolation claim is now spelled out in three
files, and a fourth tenant means a fourth literal in each of them — including in the *existing* seeders,
which is the edit this feature is avoiding, so Legal's own check is the only one that will be complete
until somebody does that pass. **`finance_ro` and the HR role are therefore NOT checked against
`legal_demo` by this feature**, and SC-006 says so with the real numbers instead of claiming four-way
isolation. Consolidating is a small, separate change on its own branch, and it should be argued for on
its own merits rather than smuggled in behind a new dataset.

⚠ **`has_database_privilege` throws on a database that does not exist**, so the list must be filtered
against `pg_database` before it is used — `legal_demo` is being created by the very seeder that reads
it, and on a machine that has never run `demo:seed-alt` there is no `hr_demo_alt` either.

**D-5 — `vendor_code` on `counterparties` is not a foreign key and never will be.** It is a soft
correlation to `finance_demo.vendors`, and the two live in two databases precisely so they cannot be
joined. Leaving the column there with a comment saying why is more instructive than leaving it out:
"correlate the legal and financial view of one supplier" is a real request, and the answer has to be
*through the product*, not through SQL.

**D-6 — `liability_cap_multiple` rather than a second currency-units trap.** Finance owns the
cents-versus-dollars lesson. A multiple-of-annual-value is a units trap of a *different* kind —
`2.00` rendered as `$2.00` — so it teaches something the first one does not, at the cost of one
`numeric(4,2)` column.

**D-6b — Legal mirrors Finance's 8 tools and its 5 stored credentials, including the unused one.**
Verified 2026-08-19: `financeToolCatalogue()` returns **8** tools — `mail_send`, `mail_send_template`,
`chat_list_channels`, `chat_post_message`, `ticket_create`, `ticket_update`, `ticket_search`,
`llm_complete` — which between them exercise **two** auth styles, `header` and `query`.
`FINANCE_OPS_SERVICES` nonetheless holds five credentials: there is **no probe tool**, so the `basic`
credential is stored and never presented, and `bearer` is unexercised as documented. Legal reproduces
that arrangement exactly so the endpoint-parity test is a real comparison — and this plan **states the
discrepancy rather than inheriting it silently**. Narrowing `LEGAL_OPS_SERVICES` to four would make
Legal the odd one out for a reason unrelated to Legal; if the unused credential should go, it should go
from both, in its own change.

**D-7 — No flows in this feature.** `provisionLegal()` creates no flows and no triggers, exactly as
`provisionFinance()` does not. Authoring the renewal-notice automation belongs in a later piece of work
and should happen **through the product**, because a hand-written flow proves nothing about the product
that generated nothing.

**D-8 — `legal-schema.sql` DROPs and recreates.** Same as HR's and Finance's, and the reason the grants
must come **after** the DDL and the data: table privileges die with the table, so a grant issued
earlier silently vanishes and the role ends up able to connect and unable to read.

## Phasing

### Phase 1 — the data and the oracle (shippable alone)

`legal-schema.sql`, `legal-dataset.ts` + `legalOracle()`, `legal-dataset.test.ts`, `seed-legal-db.ts`.
**No existing file is touched in this phase at all.**

**Done when**: `tsx src/demo/legal/seed-legal-db.ts` (or a one-line harness) creates `legal_demo`,
loads ~120 rows, produces a clean `legal_ro` with zero privilege problems and no `CONNECT` to
`hr_demo`, `hr_demo_alt` or `finance_demo`; `legal-dataset.test.ts` passes with all 9 traps asserted.
`finance:seed` and `demo:seed` are re-run as a control and must be **untouched** — nothing in this
phase should be able to affect them, which is the point of not editing them.

**Value alone**: a queryable third tenant that provably cannot read the other two, before any product
wiring.

### Phase 2 — the callable surface (shippable alone)

`legal-queries.ts`, `legal-tools.ts`, `legal-tools.test.ts`, `provision-legal.ts`, the `cli.ts` case,
the `package.json` scripts and build `cp`, and the ops-api channels and templates.

**Done when**: `pnpm --filter @foundry/server legal:seed` exits `0` reporting 8 tools, 5 queries,
10 tables introspected and a manifest version; running it twice is idempotent; the Legal workspace is
visible in the UI with its datasource and query catalogue.

**Value alone**: a workspace somebody can author against.

### Phase 3 — the oracle harness and the housekeeping

`verify-legal.ts` (both halves), `.env.example`, `backup.sh`, `tidy-litter.ts`, `verify-dataset.ts`,
`datasource-target.test.ts`, the `datasource-target.service.ts` docblock, `CLAUDE.md`.

**Done when**: `pnpm --filter @foundry/server legal:verify` exits `0` with 5 queries × 3 as-of dates
agreeing with the oracle row for row, and the disjointness/completeness assertion passing; a Legal
workspace survives `tidy:clear`; `legal_demo` is in the backup set.

**Value alone**: the difference between "the query ran" and "the query is right" — which is the only
reason any of this exists.

## Risks

| Risk | Mitigation |
|---|---|
| **The oracle and the SQL are written by the same person in the same sitting and agree because they share a misreading of the schema.** This is the real risk and it is not fully mitigable. | Write the oracle **from `legal-schema.sql`'s comments** before writing any SQL, and write the SQL without re-reading the oracle. `verify-legal.ts` also asserts *absolute* documented counts (e.g. "exactly one contract on the boundary at every as-of date"), which a shared misreading would have to also match by coincidence. |
| Tuning traps to one as-of date and calling the dataset general. | Three as-of dates, one of them empty, and three invariants that must hold at all three. |
| Legal's hardcoded `OTHER_TENANT_DBS` drifts as tenants are added, so the isolation claim quietly stops being complete. | It is already incomplete **by design** in one direction (D-4), and SC-006 states the real coverage rather than claiming four-way isolation. The list carries a comment naming the other two files that would need the same edit. |
| `has_database_privilege` throws on `hr_demo_alt` on a machine that never ran `demo:seed-alt`, so the role check dies mid-seed. | Filter the list against `pg_database` first. Called out in D-4 and asserted in Phase 1 on a database where only `hr_demo` exists. |
| Two new chat channels break an existing HR/Finance assertion on `CHANNELS.length`. | Grep for length assertions on `CHANNELS` before editing `ops.ts`; the Finance channels were added the same way and the tool descriptions name channels, not counts. |
| A Legal branch creeps into a service to make something work. | T032 requires `git diff --stat packages/server/src/services/` to show only the two comment/literal edits. Anything else is the finding. |
| A convenience edit creeps into an existing seeder — the constraint this feature is built on. | T033 diffs `packages/server/src/demo/` by name and refuses any existing seeder in the list. |
| Trap 5's duplicated date arithmetic drifts between the two queries. | The disjointness-and-completeness assertion at all three as-of dates, in half B. |

## Complexity Tracking

| Thing | Why it is not simpler |
|---|---|
| 10 tables where 7 would carry the traps | `legal_entities`, `contract_relationships` and `obligation_completions` each exist for one trap or one report shape: entity scoping, MSA→SOW hierarchy, and completion-is-not-status. Dropping `contract_relationships` is the most defensible cut if the feature needs shrinking — say so out loud rather than quietly. |
| Two deadline queries instead of one | D-1. The duplication is the mitigation, and it is guarded by an assertion. |
| A third hardcoded copy of the tenant database list | D-4, and it is the **deliberately less clever option**: keeping the new tenant identical in shape to the existing ones was chosen over consolidating them. The cost is written down in D-4 and in SC-006 rather than left to be discovered. |
| `verify-legal.ts` duplicating `verify-finance.ts`'s structure | Deliberate. A shared verifier harness is exactly the shared-implementation-agrees-with-itself failure the two-oracle rule exists to prevent. |
