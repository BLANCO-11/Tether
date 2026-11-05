# Tasks: the Legal demo domain — contract lifecycle & obligations

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Branch**: `20260819-080932-legal-contract-demo-domain`

## Format: `[ID] [P?] [Story] Description`

- `[P]` — parallelisable with the tasks adjacent to it (different files, no ordering dependency)
- `[Story]` — the spec user story the task serves (US1…US5), or `INFRA`
- Phase order is binding. Within a phase, `[P]` tasks may be done in any order.

⚠ **The governing constraint on this feature: Legal's seed code is the EXISTING seed code's shape with
Legal data in it.** No shared module, no new abstraction, and **no edit to any existing seeder** —
`seed-finance-db.ts`, `demo/hr-roles.ts` and `seed-alt-db.ts` are not touched. Where Finance hardcodes
something, Legal hardcodes it too. plan.md **D-4** records the one consolidation that was considered
(a tenant roster) and set aside, together with what that costs.

## Environment state (verified 2026-08-19)

Facts checked against the repo before writing these tasks. Re-check anything that looks stale.

- Migration head is **`0039_bright_thundra`** (`packages/server/drizzle/`). **This feature adds none.**
- `.specify/feature.json` points at `specs/20260818-084135-email-send-tool`. **Must be repointed** (T001).
- `demo/cli.ts` already has `provision`, `reset`, `provision-alt`, `provision-finance`, `status`.
- `packages/server/package.json` has `demo:seed`, `demo:verify`, `finance:seed`, `finance:verify`;
  its `build` script ends `cp src/demo/*.sql dist/demo/ && cp src/demo/alt/*.sql dist/demo/alt/ && cp src/demo/finance/*.sql dist/demo/finance/`.
- `scripts/backup.sh:59` — `DEMO_DBS=(hr_demo hr_demo_alt finance_demo)`.
- `demo/tidy-litter.ts:79` — `PROTECTED_SLUGS = new Set(["hr", "finance", "hr-alt-swap-rehearsal", "foundry"])`.
- `services/datasource-target.test.ts:90` — `TENANT_DBS = [config.demo.dbName, config.demo.altDbName, "finance_demo"]`.
  Legal adds **one literal** here, matching how Finance was added.
- `seed-finance-db.ts`'s `verifyFinanceReadOnlyRole` checks `has_database_privilege(role,
  config.demo.dbName, 'CONNECT')` — **one** database, hardcoded, inline. That is the idiom Legal copies.
- `ops-api/src/routes/ops.ts:960` — `CHANNELS` (6 entries). **No test asserts `CHANNELS.length`**, so
  adding two is safe; `/chat/channels` returns `{total, channels}` computed from the array.
- `ops-api/src/routes/ops.ts:~793` — mail templates; the Finance block sits after `general_update`.
- `.env.example` documents **no** `FINANCE_*` variable, though `seed-finance-db.ts` reads
  `FINANCE_DB_NAME`, `FINANCE_DB_RO_ROLE` and `FINANCE_DB_RO_PASSWORD`. Repaid in T028.
- `OpsService` is `"hr" | "mail" | "chat" | "ticketing" | "probe" | "llm"`; Legal takes the same five
  Finance takes (`mail`, `chat`, `ticketing`, `probe`, `llm`) and **not** `hr`. ⚠ Finance has **no probe
  tool**, so its `basic` credential is stored and never presented; its 8 tools exercise `header` and
  `query` only. Legal mirrors this — see plan.md D-6b.

---

## Phase 0: Gate the branch (BLOCKING — do this first)

- [ ] **T001** `[INFRA]` Repoint `.specify/feature.json` to
      `specs/20260819-080932-legal-contract-demo-domain`. Until this is done the agent hooks and the
      pre-commit gate refuse source writes under this feature. ⚠ Confirm no other feature is mid-flight
      before flipping it — that is the author's call, which is why the plan did not do it.
- [ ] **T002** `[INFRA]` Create the branch and confirm a clean tree. Record the migration head
      (`0039_bright_thundra`) so a stray `0040` is visible at review.

---

## Phase 1: The data and the oracle — additive only, no existing file touched

Landing this phase alone gives a queryable third tenant. **Nothing in it can affect HR or Finance**,
because it edits none of their files — which is what makes T010 a real control rather than a formality.

### The schema

- [ ] **T003** `[US1]` **NEW** `packages/server/src/demo/legal/legal-schema.sql`. 10 tables per
      plan.md → *Tables*. House convention on comments is binding, not decorative:
      - File header: ALL DATA SYNTHETIC, RFC 2606 domains, own database and why (the introspector is
        hardcoded to `table_schema = 'public'`, and the datasource credential must reach only what the
        workspace declared).
      - A header block titled **THE INVERTED BOUNDARY IS DELIBERATE AND LOAD-BEARING**, stating that a
        notice deadline **on** the as-of date is still actionable — the opposite of `finance_demo`'s
        *due today is not overdue* — and that the disagreement is the lesson.
      - A header block on the **auto-renew inversion**: one boolean, two opposite actions, two opposite
        recipients.
      - `COMMENT ON TABLE` / `COMMENT ON COLUMN` for every trap-bearing column: the two-level notice
        fallback, `end_date IS NULL` = evergreen, `superseded_by_id`, `value_cents` MINOR units,
        `liability_cap_multiple` is a **multiple not currency**, `obligations.status` is not
        authoritative, `notice_log` suppression must be date-bounded.
      - `DROP TABLE … CASCADE` for all 10 at the top, in dependency order (D-8).
      - Indexes: `contracts(counterparty_id)`, `contracts(end_date)`, `obligations(due_date)`,
        `obligation_completions(obligation_id)`, `notice_log(contract_id)`.

### Tests before the data (Constitution II)

- [ ] **T004** `[US1,US3]` **NEW** `packages/server/src/demo/legal/legal-dataset.test.ts` — written
      **before** `legal-dataset.ts` exists, so it fails to compile first. One `it()` per trap, named
      after the trap:
      1. exactly one contract sits **on** the notice boundary at each of the three as-of dates
      2. exactly one contract needs **both** fallback hops, and it is the **highest-`value_cents`**
         contract in the dataset
      3. exactly one contract has `end_date IS NULL`
      4. exactly one supersession chain, plus a title-prefix negative-control pair with different
         counterparties
      5. both `auto_renew` populations are non-empty at the default as-of date
      6. exactly one obligation with `owner_email === null`, and its contract's owner is non-null
      7. exactly one obligation with a completion row and `status === "open"`; exactly one `waived`
         obligation past its due date
      8. exactly one `notice_log` row inside the current window and exactly one from a prior cycle
      9. exactly one counterparty with `contact_email === null`; exactly one on `*-bounce.example`;
         exactly one with zero live contracts
      Plus: **every** email address in the dataset ends in `.example`; **no** `Date.now()` / `new Date()`
      without an explicit argument anywhere in the module; `2026-04-30` yields **zero** renewals due and
      **zero** obligations overdue.

### The data and the oracle

- [ ] **T005** `[US1,US2,US3]` **NEW** `packages/server/src/demo/legal/legal-dataset.ts` — definitions
      only, first: `ORG_SETTINGS`, `LEGAL_ENTITIES`, `COUNTERPARTIES`, `CONTRACT_TYPES`, `CONTRACTS`,
      `CONTRACT_RELATIONSHIPS`, `CONTRACT_CLAUSES`, `OBLIGATIONS`, `OBLIGATION_COMPLETIONS`,
      `NOTICE_LOG`, plus `LEGAL_AS_OF_DATES`, `LEGAL_DEFAULT_AS_OF = "2026-06-30"`,
      `DEFAULT_NOTICE_PERIOD_DAYS = 60`, `DEFAULT_LOOKAHEAD_DAYS = 90`, `BOUNCING_DOMAIN`, and pure
      helpers `effectiveNoticeDays(contract)`, `noticeDeadline(contract)`, `urgencyBucket(days)`,
      `isCompleted(obligationId, asOf)`, `alreadyNoticed(contractId, asOf, windowDays)`. All dates are
      **literal strings**. Header docblock lists the 9 traps and what each costs somebody who misses it.
- [ ] **T006** `[US1,US2,US3]` Same file — `legalOracle(asOf = LEGAL_DEFAULT_AS_OF, lookaheadDays = 90)`
      returning `{ asOf, lookaheadDays, renewalDue[], renewalByBucket, lapseRisk[], missedDeadlines[],
      alreadyNoticed[], obligationsDue[], obligationsOverdue[], nonStandardClauses[],
      counterpartySummary[], unmailable[], bouncing[], evergreenExcluded[], supersededExcluded[] }`.
      ⚠ **Write this from `legal-schema.sql`'s comments, before any SQL exists, and do not import
      anything from `demo/finance/` or `demo/` (HR).** Docblock must state that it is not a
      parameterisation of `financeOracle()` and why (D-3): a shared oracle lets a shared bug produce a
      wrong answer that agrees with itself.
- [ ] **T007** `[US1]` Run `vitest run src/demo/legal/legal-dataset.test.ts`. Green. If a trap count is
      off, **fix the data, not the test** — the counts in T004 are the documented invariants.

### The seeder

- [ ] **T008** `[US5]` **NEW** `packages/server/src/demo/legal/seed-legal-db.ts`, mirroring
      `seed-finance-db.ts` **structure for structure** — same function names, same order, same docblock
      topics, Legal values:
      - `LEGAL_DB_NAME` (`LEGAL_DB_NAME` ?? `legal_demo`), `LEGAL_RO_ROLE` (?? `legal_ro`)
      - `derivedRoPassword()` — HMAC-SHA256 over `CREDENTIAL_ENC_KEY`, salt
        **`legal_demo:read-only-role:v1`**, 32 hex chars, overridable by `LEGAL_DB_RO_PASSWORD`.
        Docblock: a fresh random password each seed would leave the DSN already encrypted into
        `datasources.connection_string_enc` pointing at a credential the server just rotated away.
      - `legalDbUrl()` (owner, parent-side, never registered), `legalRoDbUrl()`,
        `legalDbUrlForScripts()` (host/port substituted for sibling containers).
      - `ensureDatabase()` with `assertIdentifier` on the name before any `CREATE DATABASE`.
      - `insertRows()` chunked, in FK order: `org_settings`, `legal_entities`, `counterparties`,
        `contract_types`, `contracts` (⚠ **two passes** — insert with `superseded_by_id` NULL, then
        `UPDATE` the chain, because the column self-references and the successor may have the lower id),
        `contract_relationships`, `contract_clauses`, `obligations`, `obligation_completions`,
        `notice_log`.
      - `ANALYZE` **as the owner, before the grants** (otherwise `pg_class.reltuples` reports `-1` and
        the manifest shows an unknown row count).
      - `ensureLegalReadOnlyRole()` — grants **after** the DDL and data (D-8); `REVOKE CREATE ON SCHEMA
        public FROM PUBLIC` **before** revoking from the role, with the PG ≤ 14 comment copied verbatim;
        `default_transaction_read_only`, `statement_timeout`, `idle_in_transaction_session_timeout`,
        `CONNECTION LIMIT 10`.
      - `verifyLegalReadOnlyRole()` — re-derives everything from `pg_catalog`, and checks **no
        `CONNECT`** to each entry in a **local hardcoded** list:
        ```ts
        // The databases this role must NOT be able to reach. Hardcoded and local, in the same
        // shape seed-finance-db.ts uses — see the plan's D-4 for the roster that was considered
        // and set aside. ⚠ The same claim is also spelled out in seed-finance-db.ts and in
        // services/datasource-target.test.ts; a fourth tenant needs the edit in all three.
        const OTHER_TENANT_DBS = [config.demo.dbName, config.demo.altDbName, "finance_demo"];
        ```
        ⚠ **Filter it against `pg_database` before use.** `has_database_privilege` **throws** on a
        database that does not exist, and on a machine that never ran `demo:seed-alt` there is no
        `hr_demo_alt`. A seeder that dies there is a seeder nobody can run.
- [ ] **T009** `[US5]` Seed it (a scratch `tsx -e` harness is fine at this point — the CLI case lands in
      Phase 2) and confirm: database created, 10 tables, row counts matching the dataset lengths,
      `problems: []`, and no `CONNECT` to `hr_demo`, `hr_demo_alt` or `finance_demo`. Then run it on a
      machine (or a cluster) **without** `hr_demo_alt` and confirm it still completes — that is the
      `pg_database` filter proving itself rather than being assumed.
- [ ] **T010** `[US5]` **Control**: run `pnpm --filter @foundry/server finance:verify` and `demo:verify`.
      Both must pass **unchanged**. Nothing in Phase 1 edits a file either of them reads, so a failure
      here means something leaked — investigate rather than adjusting them. ⚠ Note for the record:
      `finance_ro` is **still not** checked against `legal_demo`, by design (spec SC-006).

**Phase 1 exit**: `pnpm -r typecheck` clean; `vitest run src/demo/legal/` green; `demo:verify` and
`finance:verify` untouched and green; `legal_demo` queryable as `legal_ro` and unable to reach the
other two tenants.

---

## Phase 2: The callable surface — a workspace somebody can author against

### Named queries

- [ ] **T011** `[US1,US2,US3]` **NEW** `packages/server/src/demo/legal/legal-queries.ts` exporting
      `LEGAL_QUERIES: NamedQuerySpec[]` (type imported from `kestra/hr-screening.queries.js`, as
      `finance-queries.ts` does). Shared SQL fragments as `const`s with docblocks naming the trap they
      resolve:
      - `EFFECTIVE_NOTICE_DAYS` — the **two-level** `COALESCE`: `c.notice_period_days` →
        `t.default_notice_period_days` → `(SELECT value::int FROM org_settings WHERE key =
        'default_notice_period_days')`. ⚠ Name the contract in the comment that needs both hops.
      - `NOTICE_DEADLINE` — `(c.end_date - EFFECTIVE_NOTICE_DAYS * INTERVAL '1 day')::date`.
      - `ALREADY_NOTICED` — date-**bounded** `EXISTS` over `notice_log`. ⚠ Comment: the unbounded form
        suppresses the prior-cycle contract and it auto-renews in silence.
      - `IN_WINDOW` — the upper bound `deadline <= as_of + lookahead` **and** the inclusive lower bound.
        ⚠ Comment: **`<=` not `<`, the opposite of `finance_demo`'s rule.**
      Then the five queries per plan.md → *The five named queries*. Each: one read statement,
      positional parameters only, `paramOrder` and `paramsSchema` in agreement. Every `description`
      states the recipient and the consequence of a missed deadline in its **first sentence**
      (US2 acceptance 2).
- [ ] **T012** `[US1]` File header docblock: these are the product's callable catalogue, not a harness
      fixture; a `datasource` step names a query and never carries SQL; the traps resolved here are
      structurally unreachable while a trap left for a generated fragment is missed roughly two times in
      three; and what the queries deliberately **do not** decide.

### Tools

- [ ] **T013** `[P]` `[US4]` **EDIT** `packages/ops-api/src/routes/ops.ts`:
      - `CHANNELS` (≈line 960) — add `{ name: "#legal-ops", topic: "Legal operations and contract
        lifecycle", members: 7 }` and `{ name: "#contracts-renewals", topic: "Contract renewal and
        notice deadlines", members: 5 }`, in a commented Legal block matching the Finance one's style.
        ⚠ Nothing asserts `CHANNELS.length`; `total` is computed. Verified 2026-08-19.
      - Mail templates (after the Finance block, ≈line 835) — a commented **Legal** block with
        `renewal_notice` (required: `counterparty_name`, `contract_code`, `contract_title`,
        `notice_deadline`, `renewal_term`), `non_renewal_notice` (required: `counterparty_name`,
        `contract_code`, `contract_title`, `end_date`, `notice_deadline`) and `obligation_reminder`
        (required: `owner_name`, `obligation_code`, `contract_code`, `description`, `due_date`,
        `days_remaining`). Block comment: a template is a **refusal surface** — a notice that never
        resolved its deadline must 422 rather than be served with an unrendered placeholder in the body;
        and `renewal_notice` / `non_renewal_notice` are two templates precisely so sending the wrong one
        to the wrong party fails loudly.
- [ ] **T014** `[US2,US4]` **NEW** `packages/server/src/demo/legal/legal-tools.ts` — **8** tool specs
      (⚠ verified 2026-08-19: `financeToolCatalogue()` returns 8 — `mail_send`, `mail_send_template`,
      `chat_list_channels`, `chat_post_message`, `ticket_create`, `ticket_update`, `ticket_search`,
      `llm_complete`), same endpoints/methods/auth styles as Finance's, Legal prose.
      `LEGAL_OPS_SERVICES = ["mail", "chat", "ticketing", "probe", "llm"]` — the same five Finance
      stores, including the `probe` credential no tool presents (plan.md D-6b). Header docblock,
      mirroring `finance-tools.ts`:
      - **What is deliberately absent** — the seven `hr_*` tools, and why (an HTTP read of another
        tenant's directory that no datasource boundary would catch), and the honest cost: `bearer` and
        `basic` are the styles Legal does not exercise, and inventing a Legal directory service to
        close that would be building a service to satisfy a checklist.
      - **Why not filter the Finance catalogue** — the descriptions are the interface.
      Tool prose specifics: `chat_post_message` names `#legal-ops`, `#contracts-renewals` and
      `#compliance`. `mail_send` states that for a **legal notice** an unserved send means the notice
      period never started — escalate, do not log (US4 acceptance 2). `llm_complete` states it must
      never be asked to classify a clause's risk, decide whether to serve a notice, or judge whether a
      deadline was met — and that nothing downstream may read its output.
- [ ] **T015** `[US2,US5]` **NEW** `packages/server/src/demo/legal/legal-tools.test.ts`, modelled on
      `finance-tools.test.ts`:
      1. registers no `hr_*` tool
      2. holds no credential for the HR directory service (`HR_DIRECTORY_TOKEN` absent from
         `LEGAL_OPS_SERVICES`' env names)
      3. points every shared tool at the **same** endpoint, method and auth as Finance's
      4. declares the **same parameters** as Finance's for every shared tool
      5. describes **legal** channels and templates, not Finance's or HR's
      6. holds a credential for every service its tools authenticate against
      7. `legalOracle` shares no implementation with `financeOracle` / `expectedScreening` — assert the
         module imports nothing from `demo/finance/` or `demo/hr-dataset.js` (FR-012)

### Provisioning

- [ ] **T016** `[US1,US5]` **NEW** `packages/server/src/demo/legal/provision-legal.ts` —
      `LEGAL_WORKSPACE_NAME = "Legal"`, `LEGAL_DB_SECRET_ENV = "LEGAL_DB_URL"` (⚠ **not**
      `FINANCE_DB_URL` or `HR_DB_URL`; docblock the reason — two tenants whose credentials arrive under
      one name is how a copied step configuration silently reads the wrong database). Steps in the
      Finance order, calling the **same** services with no new branch: seed → workspace (reused by
      name) → tools (upsert by name) → one ops secret per service via `workspaceSecretService.put` →
      datasource (`verifyVia: legalRoDbUrl()`, registered DSN `legalDbUrlForScripts()`) → queries
      (**every one through `checkSqlShape` first, throwing with the query name if refused**) →
      introspect **as `legal_ro`** over `{ schemas: ["public"] }` → manifest **last** → secret audit.
      Return a `LegalProvisionReport` shaped like `FinanceProvisionReport`, `oracle: legalOracle()`.
      **Creates no flows and no triggers** (D-7) — say so in the docblock.
- [ ] **T017** `[P]` `[US1]` **EDIT** `packages/server/src/demo/cli.ts` — import `provisionLegal`, add a
      `case "provision-legal": case "seed-legal":` block printing the same shape Finance's does:
      workspace id, tool total, query count, tables/columns introspected, manifest version and bytes;
      then the oracle line (renewals due by bucket, lapse-risk count, obligations due and overdue,
      already-noticed count); then the role line naming the three databases it cannot reach; then secret
      collisions/missing. Non-zero exit on any problem. Update the `default:` usage string.
- [ ] **T018** `[P]` `[US1]` **EDIT** `packages/server/package.json` — add
      `"legal:seed": "tsx src/demo/cli.ts provision-legal"` and
      `"legal:verify": "tsx src/demo/legal/verify-legal.ts"`; append
      `&& cp src/demo/legal/*.sql dist/demo/legal/` to `build`. ⚠ Omitting the `cp` makes the built
      image fail at seed time with a missing-file error and works fine under `tsx` — a divergence that
      only shows up in the container.
- [ ] **T019** `[US1]` Run `pnpm --filter @foundry/server legal:seed`. Expect exit `0`, 8 tools,
      5 queries, 10 tables introspected, a manifest version, zero role problems, zero secret problems
      (**SC-001**). Then run it **again** and confirm `workspaceCreated: false`, `created: 0`, unchanged
      manifest version, identical row counts (**SC-003**).
- [ ] **T020** `[US1]` Open the Legal workspace in the UI. The datasource, its 10 introspected tables
      and its 5 named queries must be visible, and the query descriptions must read as intended — they
      are what the drafting model sees.

**Phase 2 exit**: `legal:seed` idempotent and green; `pnpm -r test` and `pnpm -r typecheck` green;
no file under `packages/server/src/services/` changed yet; still no existing seeder edited.

---

## Phase 3: The oracle harness and the housekeeping

### The verifier — the reason the feature exists

- [ ] **T021** `[US1,US2,US3]` **NEW** `packages/server/src/demo/legal/verify-legal.ts`, two halves,
      modelled on `verify-finance.ts`. Header docblock must state that half B is the half that matters
      and that the verifier **fails rather than skips** when the database is unreachable.
      **Half A — invariants of the definitions, no database**: all 9 traps by name (reuse the
      assertions from T004's list), every address on a reserved domain, and the headline counts the
      documentation claims.
      **Half B — the queries against the oracle**: connect as `legal_ro`; for **each of the three
      as-of dates**, run all five queries **unbounded** and compare row-for-row to
      `legalOracle(asOf, 90)`. Also assert, per as-of date:
      - `contracts_renewal_due` and `contracts_expiring_no_autorenew` are **disjoint**, and their union
        covers every contract in the window (**SC-005**, the guard on D-1's duplicated date arithmetic)
      - the boundary contract is **present** and in the most urgent bucket (US1 acceptance 2)
      - the evergreen and superseded contracts are **absent** from both deadline queries
      - `2026-04-30` returns zero renewals and zero overdue obligations without erroring
      - `verifyLegalReadOnlyRole` reports no problems and no `CONNECT` to the three other tenants
      On mismatch, print **the differing rows**, not just the counts. Non-zero exit on any problem.
- [ ] **T022** `[US1]` Run `pnpm --filter @foundry/server legal:verify`. Exit `0`, both halves run,
      15 query-runs compared (**SC-002**). ⚠ On a disagreement, decide **which side is wrong** before
      changing either — the oracle was written from the schema comments and the SQL was written from the
      schema, so a disagreement means one of them misread it. Do not "fix" the oracle to match the SQL.

### Housekeeping — Constitution VII

- [ ] **T023** `[P]` `[INFRA]` **EDIT** `scripts/backup.sh:59` — `DEMO_DBS=(hr_demo hr_demo_alt
      finance_demo legal_demo)`. ⚠ Verified 2026-08-19: `backup-verify.sh` and `restore.sh` enumerate
      no demo databases of their own, so this is the only edit needed.
- [ ] **T024** `[P]` `[INFRA]` **EDIT** `packages/server/src/demo/tidy-litter.ts:79` — add `"legal"` to
      `PROTECTED_SLUGS`. Without it, `tidy:clear` deletes the Legal workspace's flows the moment anyone
      authors one.
- [ ] **T025** `[P]` `[INFRA]` **EDIT** `packages/server/src/demo/verify-dataset.ts:135` — the "this
      covers the HR dataset only" note names `legal:verify` alongside `finance:verify`.
- [ ] **T026** `[P]` `[US5]` **EDIT** `packages/server/src/services/datasource-target.test.ts:90` — add
      the literal `"legal_demo"` to `TENANT_DBS`, exactly as `"finance_demo"` was added. Update the
      docblock above it (it names the seeding commands; add `legal:seed`). ⚠ **A literal, not a shared
      import** — the same decision as D-4, and this is the third place the tenant list is spelled out.
      Say so in the comment.
- [ ] **T027** `[P]` `[INFRA]` **EDIT** `packages/server/src/services/datasource-target.service.ts` —
      docblock only (≈lines 63–91): add `legal_demo` to the same-cluster list and to the worked example
      table. **Comment change only; no behaviour change**, which keeps the
      `git diff --stat packages/server/src/services/` claim honest — note it explicitly at review.
- [ ] **T028** `[P]` `[INFRA]` **EDIT** `.env.example` — document `LEGAL_DB_NAME`, `LEGAL_DB_RO_ROLE`,
      `LEGAL_DB_RO_PASSWORD` **and** the `FINANCE_DB_NAME`, `FINANCE_DB_RO_ROLE`,
      `FINANCE_DB_RO_PASSWORD` trio, which is read today and documented nowhere (FR-024). For both
      password variables, state that the default is derived from `CREDENTIAL_ENC_KEY` and that setting
      the variable is how you rotate deliberately. ⚠ Documentation only — **`seed-finance-db.ts` itself
      is still not edited.**
- [ ] **T029** `[P]` `[INFRA]` **EDIT** `CLAUDE.md` — one paragraph in the demo-datasets section: the
      third tenant, its database and role, `legal:seed` / `legal:verify`, the **inverted boundary rule**
      versus Finance's, the auto-renew inversion and why it is two queries. ⚠ **State the isolation
      claim as it actually is** — `legal_ro` cannot reach the other three; `finance_ro` and the HR role
      are **not** checked against `legal_demo`. Do not write "four-way" or "symmetric".

### Gates

- [ ] **T030** `[INFRA]` `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @foundry/server build`
      (the last one specifically to prove the `cp` in T018 works).
- [ ] **T031** `[INFRA]` Full seed round-trip on a clean database: `demo:seed`, `demo:seed-alt`,
      `finance:seed`, `legal:seed`, then `demo:verify`, `finance:verify`, `legal:verify`. All exit `0`.
- [ ] **T032** `[INFRA]` `git diff --stat packages/server/src/services/` — must show **only**
      `datasource-target.service.ts` (comment) and `datasource-target.test.ts` (one literal). Any other
      file is a Legal special case that leaked into a service, and it is the review finding (**SC-007**).
- [ ] **T033** `[INFRA]` `git diff --name-only packages/server/src/demo/` — must show **only**
      `cli.ts`, `tidy-litter.ts`, `verify-dataset.ts` and the new `legal/` directory. ⚠ **No existing
      seeder may appear**: `finance/seed-finance-db.ts`, `hr-roles.ts` and `alt/seed-alt-db.ts` are
      untouched, and that is the governing constraint on this feature.
- [ ] **T034** `[INFRA]` `ls packages/server/drizzle/ | tail -1` — must still be
      `0039_bright_thundra.sql` (**SC-008**).
- [ ] **T035** `[INFRA]` `bash scripts/backup.sh` then `bash scripts/backup-verify.sh` — `legal_demo`
      present in the archive and the verification passes.

---

## Dependencies

```
T001,T002  →  everything

T003 (schema)  →  T004  →  T005  →  T006  →  T007  →  T008  →  T009  →  T010
T011 (queries) ─┐
T014 (tools)   ─┼→  T016 (provision)  →  T017,T018  →  T019  →  T020
T013 (ops-api) ─┘
T011           →  T012
T014           →  T015
T005,T006,T011 →  T021 (verify)  →  T022
T018           →  T030 (build)
T019,T022      →  T031  →  T032,T033,T034,T035
```

`T013`, `T017` and `T018` touch different files from each other and from `T011`/`T014`.
`T023`–`T029` are all independent of one another.

## MVP boundary

**Phase 1 alone is a shippable increment**: a third tenant database with a trap-checked dataset and a
role that provably cannot reach the other two — usable from `psql` and by the next phase, with no
product wiring and, because it edits nothing, **no possible effect on the existing tenants**.

**Phase 1 + 2** is the point at which a person can author a Legal automation in the UI.

**Phase 3 is what makes it worth having.** Without half B, "the query ran" is all anyone knows, and the
measured baseline for this system is *1 of 3 scripts achieved its objective first-pass* — the one that
failed hardcoded a period, emailed 0 of 11, and exited `0` with `tests_passed=true`. Do not stop at
Phase 2 and call the domain done.

## File inventory — every file this feature touches

### New (9) — all under one new directory

```
packages/server/src/demo/legal/legal-schema.sql
packages/server/src/demo/legal/legal-dataset.ts
packages/server/src/demo/legal/legal-dataset.test.ts
packages/server/src/demo/legal/seed-legal-db.ts
packages/server/src/demo/legal/legal-queries.ts
packages/server/src/demo/legal/legal-tools.ts
packages/server/src/demo/legal/legal-tools.test.ts
packages/server/src/demo/legal/provision-legal.ts
packages/server/src/demo/legal/verify-legal.ts
```

### Edited — server (5)

```
packages/server/src/demo/cli.ts                           # provision-legal case
packages/server/src/demo/tidy-litter.ts                   # PROTECTED_SLUGS
packages/server/src/demo/verify-dataset.ts                # pointer note
packages/server/src/services/datasource-target.test.ts    # TENANT_DBS += "legal_demo"
packages/server/src/services/datasource-target.service.ts # docblock only
```

### Edited — ops-api (1)

```
packages/ops-api/src/routes/ops.ts                        # 2 channels, 3 mail templates
```

### Edited — root and docs (4)

```
packages/server/package.json                              # legal:seed, legal:verify, build cp
scripts/backup.sh                                         # DEMO_DBS
.env.example                                              # LEGAL_* and the missing FINANCE_*
CLAUDE.md                                                 # one paragraph
```

**19 paths touched: 9 new, 10 edited.**

### Must NOT be edited

- **Any existing seeder or dataset.** `demo/finance/seed-finance-db.ts`, `demo/hr-roles.ts`,
  `demo/alt/seed-alt-db.ts`, `demo/hr-dataset.ts`, `demo/finance/finance-dataset.ts`,
  `demo/alt/alt-dataset.ts`, and Finance's `finance-queries.ts` / `finance-tools.ts` /
  `verify-finance.ts` / `provision-finance.ts`. **This is the governing constraint** (T033).
- Any drizzle migration, and no new one (**SC-008**).
- Any file under `packages/server/src/services/` other than the two named above — and neither of those
  changes behaviour (**SC-007**).
- Any file under `packages/client/`.

## Deliberately not in this feature

- **A shared tenant-roster module.** Considered and set aside — plan.md **D-4** carries the reasoning
  and the cost. It would touch every existing seeder, which is what this feature avoids. Its
  consequence is that the isolation claim is spelled out in three files and is **not symmetric**:
  `finance_ro` and the HR role are not checked against `legal_demo`. **SC-006 states the real coverage;
  do not overstate it in `CLAUDE.md` or anywhere else.**
- **Legal flows** in `src/scenarios/`. Author them **through the product**, later — a hand-written flow
  proves nothing about a generator.
- **A shared provisioning base class** for the three tenants. The duplication between the
  `provision-*.ts` files is legible, and a base class is the branch-free claim smuggled back as
  inheritance (Constitution IV).
- **A joinable link to `finance_demo.vendors`.** The `vendor_code` column stays a documented soft
  reference (D-5).
- **Multi-currency, FX, or a second cents-versus-dollars trap.** That lesson is Finance's.
- **A `bearer`- or `basic`-auth Legal service.** The gap is real, stated, and not worth a service to
  close.
