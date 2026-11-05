# Session notes — the Legal demo domain

**Purpose**: a handoff record. If this session ends mid-implementation, another agent (or another
account) picks up from **"Where to resume"** below and needs nothing from the conversation that
produced it.

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Tasks**: [tasks.md](./tasks.md)
**Repo root for all paths below**: `/home/mayank/Foundary_kestra_migration/foundry`

---

## Read this first — the four things that shape every decision

1. **Legal's seed code is the EXISTING seed code's shape with Legal data in it.** `demo/finance/` is
   the template, file for file. No shared module, no new abstraction, **no edit to any existing
   seeder**. Where Finance hardcodes something, Legal hardcodes it too. This was an explicit user
   instruction, not an inference — see plan.md **D-4**.
2. **`legalOracle()` must be written from `legal-schema.sql`'s comments, independently**, and must
   import nothing from `demo/finance/` or `demo/hr-dataset.ts`. A shared oracle lets a shared bug
   produce a wrong answer that agrees with itself (plan.md D-3).
3. **The boundary rule is INVERTED relative to Finance.** Finance: *due today is not overdue* (`>`).
   Legal: *a notice deadline today is the last chance and must be urgent* (`<=`). The disagreement is
   deliberate and is the most valuable thing in the dataset. Do not "make it consistent".
4. **No drizzle migration.** Head must stay `0039_bright_thundra`. `legal_demo` is a separate database
   created by the seeder at run time.

---

## Environment facts verified in this session (2026-08-19)

- Branch created: **`20260819-080932-legal-contract-demo-domain`**, off `20260818-084135-email-send-tool`
  at commit `db18342`.
- `.specify/feature.json` **repointed** to this feature. Previous value was
  `specs/20260818-084135-email-send-tool`; a backup of the original file is in the session scratchpad,
  and the value is recorded here so it can be restored by hand:
  `{"feature_directory": "specs/20260818-084135-email-send-tool"}`.
- Migration head confirmed **`0039_bright_thundra.sql`**.
- ⚠ **`git config core.hooksPath` is UNSET**, so `.githooks/pre-commit` is **not installed** — the
  commit-time spec gate will not fire locally. CI (`ci/check-spec-compliance.sh`) is the backstop.
  Its three gates are: (1) source changes need a feature-branch name matching
  `^[0-9]{8}-[0-9]{6}-[a-z0-9-]+$`, (2) the feature dir needs `spec.md`+`plan.md`+`tasks.md`,
  (3) **every staged source file must be named in `tasks.md`** (full path or basename). tasks.md's
  file inventory already lists every path this feature touches, so gate 3 is satisfied — **if you add
  a file not in that inventory, add it to tasks.md in the same commit.**
- ⚠ The `.claude/hooks/spec-gate.sh` PreToolUse hook is configured in `foundry/.claude/settings.json`,
  but this session's `CLAUDE_PROJECT_DIR` is the **parent** directory, so the hook did not fire. Do not
  rely on it to catch a bad write.
- **Nothing has been committed.** All work is in the working tree on the new branch.

---

## Where to resume

**Status: Phases 0, 1, 2 and 3 COMPLETE except two deliberately-skipped gates (T031 partial, T035 not
run — see "Gates deliberately not run"). `legal:seed` and `legal:verify` both work by their real names
and exit 0. The verifier is PROVEN TO FAIL by three perturbations.**

| Task | State |
| :--- | :--- |
| T001 repoint `.specify/feature.json` | **DONE** |
| T002 create branch, record migration head | **DONE** |
| T003 `legal-schema.sql` | **DONE** — 10 tables, executed against a scratch DB and re-run cleanly |
| T004 `legal-dataset.test.ts` (before the dataset) | **DONE** — written first, confirmed failing to load |
| T005 `legal-dataset.ts` definitions | **DONE** |
| T006 `legalOracle()` | **DONE** |
| T007 run the dataset test | **DONE — 38/38 pass, `tsc --noEmit` clean for `demo/legal`** |
| T008 `seed-legal-db.ts` | **DONE** — mirrors `seed-finance-db.ts` structure for structure |
| T009 seed + role check + `pg_database` filter proof | **DONE** — see the evidence block below |
| T010 control: `finance:verify` and `demo:verify` unchanged | **DONE** — both exit 0, output unchanged |
| T011 `legal-queries.ts` — 5 named queries | **DONE** — all five accepted by `checkSqlShape` |
| T012 queries file header docblock | **DONE** (written with T011) |
| T013 ops-api channels + mail templates | **DONE** — 8 channels, 3 Legal templates; ops-api 17/17 green |
| T014 `legal-tools.ts` | **DONE** — 8 tools, same set as Finance |
| T015 `legal-tools.test.ts` | **DONE** — 11 tests, three-way parity vs HR *and* Finance |
| T016 `provision-legal.ts` | **DONE** |
| T017 `cli.ts` case | **DONE** — `provision-legal` / `seed-legal` |
| T018 `package.json` scripts + build cp | **DONE** |
| T019 run `legal:seed` | **DONE** — exit 0, and idempotent on the second run |
| T020 UI check | **NOT DONE** — needs a browser; see below |
| T021 `verify-legal.ts` — both halves | **DONE** — green, and proven to fail (below) |
| T022 run `legal:verify` | **DONE** — exit 0 by its real name |
| T023 `backup.sh` DEMO_DBS | **DONE** (edited; `bash -n` clean — the script itself was not RUN) |
| T024 `tidy-litter.ts` PROTECTED_SLUGS | **DONE** |
| T025 `verify-dataset.ts` pointer note | **DONE** |
| T026 `datasource-target.test.ts` TENANT_DBS | **DONE** — literal, per D-4; 20/20 green |
| T027 `datasource-target.service.ts` docblock | **DONE** — comment only |
| T028 `.env.example` | **DONE** — LEGAL_* **and** the undocumented FINANCE_* trio |
| T029 `CLAUDE.md` | **DONE** — new section + 3 corrections elsewhere |
| T030 typecheck / test / build | **DONE** — see below |
| T031 full seed round-trip | **PARTIAL, deliberately** — see below |
| T032 services diff | **DONE** — exactly 2 files, both comment/literal |
| T033 demo/ diff | **DONE** — no existing seeder touched |
| T034 migration head | **DONE** — still `0039_bright_thundra` |
| T035 backup round-trip | **NOT RUN, deliberately** — see below |

**Next action**: nothing is blocking. What remains is the three items below plus committing, which was
deliberately left to the author.

### Gates deliberately not run, and why

- **T020 (UI check)** — needs a browser. The workspace is provisioned
  (`b026e808-04f2-43cb-9604-3cd503959a10`) with its datasource, 10 introspected tables and 5 named
  queries, so open `/workspaces` and confirm the query descriptions read as intended: they are what the
  drafting model sees, and they are the interface.
- **T031 (full seed round-trip)** — **`legal:seed` was run from scratch and twice more (idempotent), and
  all three verifiers exit 0.** What was NOT done is re-running `demo:seed`, `demo:seed-alt` and
  `finance:seed`. Those mutate a **live deployment that holds three armed Finance flows**, and a
  manifest bump can suspend an armed flow through the staleness sweep. Nothing in this feature touches
  their seeders (T033 proves it), so re-seeding them proves nothing about this change — but if you want
  the gate literally satisfied, run them yourself when the deployment is quiet.
- **T035 (backup round-trip)** — `scripts/backup.sh` **STOPS kestra, server and ops-api** to get a
  cross-database-consistent dump. That is not something to do to a running deployment unasked. The edit
  is one array element and `bash -n` is clean; run `pnpm backup && pnpm backup:verify` when convenient.

### T030 results, measured

```
pnpm -r typecheck                    exit 0 — every package, client included
pnpm --filter @foundry/server build  exit 0 — legal-schema.sql reached dist/demo/legal/,
                                              and today's build emitted ZERO test files
pnpm --filter @foundry/server test    94 files / 1456 pass, 1 PRE-EXISTING failure (flow-replay)
pnpm --filter @foundry/ops-api test    3 files /   17 pass
demo:verify / finance:verify / legal:verify   all exit 0
```

⚠ **`pnpm -r test` as written in tasks.md CANNOT pass on this machine** — the client package refuses to
run below Node 22 (Surprise #0). Server and ops-api were run individually instead. Do not report the
recursive command as green.

⚠ **`dist/` contains 64 stale `*.test.js` files dated 2026-08-12**, from before the
`tsconfig.build.json` fix. Today's build emitted none (`find dist -path '*legal*' -name '*.test.js'` →
0). `dist/` is simply never cleaned. Pre-existing; not this feature's to fix.

### ⚠ OPERATIONAL RULE: change the dataset -> RESEED before verifying

The oracle reads the TypeScript; the SQL reads Postgres. So after ANY edit to `legal-dataset.ts` you
must reseed, or half B reports a disagreement that is really just a stale database. This bit me once and
cost a confusing debug — the verifier correctly said "SQL 8 rows, oracle 9" and both were right about
their own source.

```bash
cd /home/mayank/Foundary_kestra_migration/foundry/packages/server
npx tsx src/demo/legal/verify-legal.ts     # until T017/T018 land, run it directly
```

### The verifier is PROVEN TO FAIL — three perturbations, all caught

A control that cannot fail is worse than none (I-38). Each of these was applied to
`legal-queries.ts`, run, and reverted:

| Perturbation | Caught? | What it reported |
| :--- | :--- | :--- |
| `IN_WINDOW`: `<=` → `<` (Finance's rule carried across) | **yes**, 3 problems | `2026-06-30 renewal_due: SQL returned 8 row(s), the oracle says 9` |
| Drop the `org_settings` hop from the two-level COALESCE | **yes**, 15 problems | `C-2024-001` vanishes entirely — the highest-value contract, exactly as documented |
| Drop the date lower bound from `ALREADY_NOTICED` | **yes**, 2 problems | `C-2024-011: already_noticed true vs oracle false` at both May and June — precisely the prior-cycle contract |

### Phase 1 evidence, measured 2026-08-19

```
seed:      databaseCreated=true, then false on reseed (idempotent), identical counts both times
counts:    org_settings=4 legal_entities=2 counterparties=11 contract_types=6 contracts=24
           contract_relationships=5 contract_clauses=20 obligations=22
           obligation_completions=7 notice_log=5
role:      legal_ro — SELECT on 10 tables, 0 privilege problems,
           no CONNECT to [hr_demo, hr_demo_alt, finance_demo]
DDL:       executes and RE-RUNS cleanly (DROP ... CASCADE at the top)
tests:     38/38 pass; tsc --noEmit 0 errors
controls:  finance:verify exit 0 (unchanged), demo:verify exit 0 (unchanged)
```

**Write refusals probed directly as `legal_ro`, with `default_transaction_read_only` turned OFF** — so
these are the ABSENT GRANT doing the work, not the session default (which a session can turn off, and
which the repo is explicit is *not* the control):

| Attempt | Result |
| :--- | :--- |
| `SELECT` | succeeded (24 contracts) |
| `INSERT` / `UPDATE` / `DELETE` | `permission denied for table …` |
| `CREATE TABLE` | `permission denied for schema public` |
| `CONNECT` to `finance_demo`, `hr_demo`, `hr_demo_alt`, `foundry_parent` | all refused |

**The `pg_database` filter was proven by perturbation**, not assumed: re-running with
`FINANCE_DB_NAME=finance_demo_does_not_exist` completes normally and honestly reports
`isolatedFrom=[hr_demo, hr_demo_alt]` — it neither throws nor silently claims to have checked Finance.
That is what the `isolatedFrom` field on `LegalRoleReport` exists for: a check that skipped a database
must not read like a check that passed.

### Oracle output, measured 2026-08-19 (use this as the regression baseline)

```
2026-04-30  renewalDue=0 [missed=0 0-14=0 15-30=0 31-90=0]  lapseRisk=2  oblDue=14 oblOverdue=0  alreadyNoticed=[]
2026-05-31  renewalDue=6 [missed=1 0-14=0 15-30=1 31-90=4]  lapseRisk=3  oblDue=17 oblOverdue=1  alreadyNoticed=[]
2026-06-30  renewalDue=9 [missed=1 0-14=1 15-30=1 31-90=6]  lapseRisk=5  oblDue=14 oblOverdue=6  alreadyNoticed=[C-2025-010]
```

**Confirmed reproduced FROM SQL as `legal_ro` at all three dates** — `legal:verify` half B compares
membership, order, `notice_deadline`, `days_to_deadline`, `urgency_bucket`, `already_noticed`,
`effective_notice_days` and `value_cents` row by row, and passes.

`nonStandardClauses=7` at every date (not date-dependent). `missedDeadlines` is the union across both
deadline queries: 0 / 2 / 4. **These are the numbers `verify-legal.ts` half B must reproduce from SQL.**

---

## Commands this feature uses

```bash
cd /home/mayank/Foundary_kestra_migration/foundry

# Node 22 is REQUIRED. On Node 20 the client's 21 render-test files silently do not run,
# and vitest.config.ts now throws below 22. Check first:
node --version

# Tests (scoped — the root `npx vitest` is NOT a supported entry point)
pnpm --filter @foundry/server test
pnpm --filter @foundry/server test src/demo/legal
pnpm -r typecheck

# The existing regression net — MUST stay green and MUST NOT be adjusted
pnpm --filter @foundry/server demo:verify
pnpm --filter @foundry/server finance:verify

# This feature's own commands, once T017/T018 land
pnpm --filter @foundry/server legal:seed
pnpm --filter @foundry/server legal:verify
```

⚠ Every `demo:*` / `finance:*` / `legal:*` script lives in `packages/server/package.json` and **none is
aliased at the root** — `pnpm demo:verify` fails with exit 254. Always use the `--filter` form.

---

## Decisions taken during implementation

*(append as they happen — each with the reason, so a later reader does not have to re-derive it)*

- **2026-08-19 — the dataset arithmetic was fully worked out on paper before writing `legal-dataset.ts`,
  and it exposed two contradictions in the spec.** Both are recorded under *Surprises* below with the
  resolution. Do not start from the spec's literal wording on these two points; start from here.

- **2026-08-19 — feature.json repointed rather than left alone.** plan.md deliberately did not do this
  because flipping the active feature out from under in-flight work is the author's call. The user then
  asked for implementation to start, which makes T001 authorised. The old value is recorded above.

---

## Surprises and corrections

*(anything the plan got wrong, found while implementing — record it here AND fix the plan, so the two
do not drift)*

### ⚠ 0. THE ENVIRONMENT IS ON NODE 20, AND CLAUDE.md SAYS IT SHOULD BE NODE 22

`node --version` → **v20.20.2**. `.node-version` and `.nvmrc` both say `22`, both `package.json`
`engines` say `>=22`, and CLAUDE.md records Node 22.23.2 as having been installed to
`~/.local/share/node-versions/v22.23.2` — **that directory does not exist, and there is no nvm.**

What this does and does not affect:

- **`packages/server` tests RUN FINE on Node 20** — that package has no `vitest.config.ts` and so no
  version guard. All 38 legal tests pass here. Phase 1 is unaffected.
- **`packages/client` tests CANNOT run**: `packages/client/vitest.config.ts:52` throws below Node 22 by
  design. So **`pnpm -r test` (task T030's gate) WILL FAIL on the client package** for a reason that has
  nothing to do with this feature.
- ⚠ **Do not "fix" this by relaxing the client's guard.** That guard exists because on Node 20 the
  client's 21 render-test files silently did not run while the summary line still read green — the
  largest instance of a control that could not fail in this repo. Removing it re-creates that.
- **What to do at T030**: either install Node 22 first, or run `pnpm --filter @foundry/server test` and
  state in the commit that the client suite was not run and why. This feature touches no client file, so
  the client suite has nothing to say about it — but the gate as written in tasks.md says `pnpm -r test`,
  and reporting that as passing when the client package errored would be false.

### ⚠ 1. "2026-04-30 is the empty case" and "one contract on the boundary at every as-of date" cannot BOTH be true of `contracts_renewal_due`

**The arithmetic.** With a 90-day lookahead the windows are

| as-of | window |
| :--- | :--- |
| 2026-04-30 (A) | 2026-04-30 → 2026-07-29 |
| 2026-05-31 (M) | 2026-05-31 → 2026-08-29 |
| 2026-06-30 (J) | 2026-06-30 → 2026-09-28 |

A boundary contract at J has its notice deadline on **2026-06-30**, which is **inside A's window**. So if
that contract is `auto_renew = true`, `contracts_renewal_due` is non-empty at A and the empty case is
gone. The same holds for a boundary contract at M (2026-05-31 is also inside A's window), and for any
*missed* auto-renew deadline at M or J (a deadline before 2026-06-30 is at or inside A's window too).

**Resolution — two parts, both implemented:**

1. **A contract that has not STARTED yet is excluded**, exactly as `financeOracle()` skips an invoice
   whose `issueDate > asOf`. The rule is `startDate > asOf → not a renewal decision`. That is what lets
   the J-boundary contract (`C-2026-008`, startDate 2026-05-01) and the missed-at-J contract
   (`C-2026-009`, startDate 2026-05-05) be absent at A while present at J. **This rule was not in the
   spec and is load-bearing — it is now the reason the empty case survives.**
2. **The emptiness claim is scoped to `contracts_renewal_due`.** At 2026-04-30 the renewal query returns
   **zero rows** and **zero obligations are overdue**; `contracts_expiring_no_autorenew` returns **two**
   (the A-boundary lease `C-2025-004` and `C-2025-005`). Saying "April is empty" without naming the
   query would be false. spec.md FR-011 / US1 acceptance 6 read as if both queries were empty.

**Also corrected**: US1 acceptance 2 says the boundary contract is "in the most urgent bucket". At J the
`missed` bucket exists and is more urgent, so the true claim is **"present, and in the `0-14` bucket"**.

### ⚠ 2. Three row counts in plan.md's table do not match what the invariants need

Discovered while satisfying the trap assertions simultaneously. The plan's numbers were estimates; these
are what the data actually requires.

| Table | plan.md said | actual | why |
| :--- | :--- | :--- | :--- |
| `notice_log` | 6 | **5** | A sixth renewal-type row put a *second* contract in the "prior-cycle notice, must be noticed again" state, breaking the exactly-one invariant. The `sent_to IS NULL` case moved onto the postal `non_renewal` row (`C-2023-013`), which is coherent for any counterparty — a postal notice has no email address. |
| `obligation_completions` | 9 | **7** | 22 obligations cannot yield 9 completions while still leaving 6 overdue at J, 1 overdue at M and 0 at A, plus a waived one and a stale-status one. |
| `contracts` | 24 | **24** | unchanged |

**plan.md and spec.md must be corrected to match** — tracked as a follow-up below, so the documents and
the code do not drift.

### Reference: the deadline arithmetic, so it does not have to be re-derived

Notice deadline = `end_date − effectiveNoticeDays`. Eligible for a deadline report =
`status = 'active'` AND `end_date IS NOT NULL` AND `superseded_by_id IS NULL` AND `signed_date IS NOT
NULL` AND `start_date <= asOf` AND `end_date >= asOf`.

- **Boundary contracts** (deadline == asOf): `C-2025-004` at A, `C-2025-005` at M, `C-2026-008` at J.
  The first two are `auto_renew = false`; the third is `true`, which is what puts the boundary trap in
  the flagship query at the default date.
- **The two-hop fallback contract is `C-2024-001`** — `notice_period_days` NULL on type `msa` whose
  `default_notice_period_days` is also NULL, so it resolves to `org_settings` (60). It is also the
  highest `value_cents` in the dataset (48,000,000) by design.
- **`C-2025-002` exercises the middle hop alone** — NULL on type `saas`, which defaults to 60.
- At J, `contracts_renewal_due` returns **8** rows and **all four buckets are populated**:
  `missed` 1 (`C-2026-009`), `0-14` 1 (`C-2026-008`), `15-30` 1 (`C-2025-002`), `31-90` 5.

### ⚠ 3. THE TEST CAUGHT A REAL DATA FLAW: the two-level fallback was not discriminating

First version had `org_settings.default_notice_period_days = 60` **and** `contract_types.saas = 60`. With
both at 60, the middle hop resolves to the same number as the org default — so a query written as
`COALESCE(contract.notice_period_days, org_default)`, skipping the contract-type level entirely, gets the
right answer for **every** contract in the dataset. The trap existed in the schema and was undetectable
in the data.

`legal-dataset.test.ts`'s middle-hop assertion (`effectiveNoticeDays(c)` must NOT equal the org default)
failed, which is the test doing exactly the job it was written for.

**Fix: `DEFAULT_NOTICE_PERIOD_DAYS` is now 45**, deliberately unequal to every type default. Now both
shortcuts are caught by a specific contract:

| Shortcut | Wrong for | How it shows |
| :--- | :--- | :--- |
| `COALESCE(contract, org_default)` — skips the TYPE level | `C-2026-002` (`saas` = 60) | resolves 45, deadline moves 15 days |
| `COALESCE(contract, type_default)` — skips the ORG level | `C-2024-001` (`msa` = NULL) | resolves NULL, and the **highest-value contract in the dataset** silently vanishes |

A test now also asserts `CONTRACT_TYPES` contains no default equal to the org default, so the flaw
cannot come back. **Knock-on**: `C-2024-001`'s deadline moved 2026-08-16 → 2026-08-31, which drops it out
of the 2026-05-31 window — May's renewal count is **6**, not the 7 the plan estimated.

### Two test assertions were wrong and were corrected (not the data)

Both were written before the data existed and asserted more than was true.

1. **"shares no oracle implementation"** originally grepped for the strings `financeOracle` /
   `expectedScreening`. The dataset docblock NAMES both, deliberately, to say it is not a
   parameterisation of either — so the cheapest way to make the test green was to delete the
   explanation. Replaced with **"this module imports nothing at all"**, which is stronger (you cannot
   call what you have not imported) and does not punish the docblock.
2. **"never reports a completed obligation"** asserted the stale-status obligation was absent at *every*
   as-of date. False: its evidence is dated 2026-06-05, so at 2026-04-30 it genuinely is still open and
   reporting it is correct. Split into a **waived** test (absolute) and an **as-of-dated completion**
   test that requires the obligation to be PRESENT before the evidence date and ABSENT after — with a
   control asserting both branches are actually taken.

### ⚠ 4. One PRE-EXISTING server test fails, and it is not this feature's

`src/services/flow-replay.test.ts > 6.1 replay authorisation > does not report an unreachable engine as
a purged execution` fails with:

```
expected 'this execution is no longer in the en…' to match /cannot reach the engine/i
```

**Proven pre-existing by removing `src/demo/legal/` from the tree entirely and re-running** — it fails
identically. It is an engine-reachability message assertion; Kestra is running on this host, so the
"unreachable" branch does not produce the message the test expects. **Full server suite: 93 files /
1444 tests pass, this 1 fails.** Do not attempt to fix it under this feature, and do not report the
suite as fully green — say "1444 pass, 1 pre-existing failure in flow-replay".

### ⚠ 5. `.specify/feature.json` is GITIGNORED (`.gitignore:116`)

So T001's repoint is a **local-only** change that will not travel with a commit or a clone. A handoff on
a **different machine** must redo T001 by hand. `git status` correctly shows the working tree as
containing only two untracked directories (`packages/server/src/demo/legal/` and this spec directory),
which is also the proof that Phase 1 touched no existing file.

### ⚠ 6. THE FIRST PERTURBATION INITIALLY DID NOT FAIL — a control that could not fail, found and fixed

Changing `<=` to `<` in `IN_WINDOW` left `legal:verify` **completely green**. The reason: the inclusive
boundary was only ever exercised at the *as-of* end of the window (a contract with `deadline == asOf`),
never at the **horizon** end (`deadline == asOf + lookahead`). `IN_WINDOW`'s upper bound therefore had
nothing to discriminate, and the docblock claiming it was load-bearing was unfalsifiable.

**Fix: `C-2025-021` is now the HORIZON CONTROL.** Its `end_date` moved 2026-12-15 → **2026-11-27** so
that with a 60-day notice its deadline is exactly **2026-09-28** = `2026-06-30 + 90`. Now `<` drops it
and `<=` keeps it, and the perturbation fails as it should. The contract carries a comment saying not to
move that date.

**Knock-on**: June's `renewalDue` is now **9**, not 8, and `31-90` is **6**, not 5. The baseline table
above reflects this.

This is worth generalising: **the dataset needs a row on BOTH edges of every inclusive bound**, not just
the one that reads more naturally. The as-of edge was obvious; the horizon edge was not.

### ⚠ 7. THE SAME TEST MISTAKE HAPPENED TWICE — source-reading assertions must target IMPORTS

Twice, a "this module does not depend on that one" test was written as a **whole-file substring grep**,
and twice it failed on the module's own docblock explaining *why* it does not depend on that one:

- `legal-dataset.test.ts` grepped for `financeOracle` — the docblock names it to say the oracle is not a
  parameterisation of it.
- `legal-tools.test.ts` grepped for `financeToolCatalogue` — the docblock names it under "WHY NOT JUST
  FILTER `financeToolCatalogue()`".

In both cases the cheapest way to make the test green is **to delete the explanation**, which is the
opposite of what the test is for. Both are now asserted over **import lines only**, which is stronger
(you cannot call what you have not imported) and does not punish documentation. **If you add a third
such check, write it against imports from the start.**

## Follow-ups owed before this feature is done

- [ ] Correct **spec.md FR-011 and US1 acceptance 6** to scope the empty case to `contracts_renewal_due`,
      and US1 acceptance 2 to say the `0-14` bucket.
- [ ] Add the **not-yet-started exclusion rule** to spec.md (it is a real eligibility rule, currently
      undocumented) and to plan.md's trap list.
- [ ] Correct **plan.md's row-count table**: `notice_log` 5, `obligation_completions` 7.
- [ ] Record in spec.md/plan.md that `DEFAULT_NOTICE_PERIOD_DAYS` is **45** and why it must differ from
      every contract-type default (Surprise #3). The plan's trap description implies any value works.
- [ ] plan.md's as-of-date table should carry the measured counts above (May is 6 renewals, June is 9).
- [ ] plan.md/spec.md should record the **horizon control** (`C-2025-021`) and the general rule it
      taught: an inclusive bound needs a row on BOTH edges or half of it is untestable (Surprise #6).
- [ ] tasks.md's T030 gate says `pnpm -r test`; it cannot pass below Node 22. Either scope it to the
      server + ops-api packages or state the Node 22 precondition in the task.
- [ ] **Nothing has been committed.** Branch `20260819-080932-legal-contract-demo-domain` holds the work
      in the working tree. `.specify/feature.json` is gitignored so its repoint will not travel.

---

## Surprise #8 — the platform email tool, and why parity did not catch it

**Reported as**: "there is a common foundry email send tool in all the workspaces except legal".

**Measured**: Legal *did* have it, and had had it since creation. `foundry_email_send`
was created in Legal at `09:53:00.634`, **before** its 8 demo tools — i.e. correctly, by
`workspaceService.create`. Finance is the odd one: demo tools at `2026-08-18 09:39:03`,
email tool at `10:53:18`, **74 minutes later**, put there by the startup backfill in
`db/seed-platform-tools.ts`. The report was stale, most likely a list read before the
`10:03:39` restart re-ran that backfill.

**But the report pointed at a real defect.** `foundry_email_send` is a *platform* tool,
registered by `registerPlatformTools`, not by any demo catalogue. Two consequences:

1. `legal-tools.test.ts`'s three-way parity check could never have caught it. Parity is
   asserted over the DEMO catalogues, and the platform tool is in none of them.
2. `provision.ts` (HR) calls `registerPlatformTools` explicitly at step 5b — "it is a
   product capability, so it must survive a reseed rather than being left behind by one".
   **`provision-legal.ts` did not**, so Legal's email tool rested entirely on the
   create-time call, which fires once, only on the create branch, and which
   `workspace.service.ts` **deliberately swallows on failure**. Re-running `legal:seed`
   could not have restored it. That is the exact hole Finance fell through.

**Fixed**: `provision-legal.ts` step 7b now calls
`registerPlatformTools(workspaceId, { rebuildManifest: false })` before the step-8
manifest build, mirroring HR. `LegalProvisionReport` gained `platformTools`, and the CLI
prints `RESTORED <name>` when a run puts one back — a restore that happens silently is
indistinguishable from one that never happened.

**Proven by perturbation** (this is the point — the fix needed a control that can fail):

| perturbation | result |
|---|---|
| delete the Legal `foundry_email_send` row, run `legal:seed` | restored; `✓ platform tools: 1 created — RESTORED foundry_email_send` |
| move `registerPlatformTools` after the manifest build | 1 test fails (ordering) |
| remove the call entirely | 3 tests fail |

Three tests added to `legal-tools.test.ts` (11 → 14): the call exists, it precedes the
manifest build, and it passes `rebuildManifest: false`. The ordering one is the
load-bearing one — a manifest hashed before registration leaves the tool in the database
and invisible to every flow, because the drafter reads the manifest.

Confirmed after the fix: manifest stays at **v2, `changed: false`** across two further
reseeds, so re-registering does not churn the version; API returns 9 tools for Legal
including `foundry_email_send`; the row is byte-identical to all four other workspaces
(same URL, method, `FOUNDRY_MAIL_KEY`, `header` auth, 550-char description).

### Still owed
- [ ] **`provision-finance.ts` has the same gap** and was NOT edited — it is an existing
      seeder, and the standing instruction was to leave those alone. Finance is currently
      protected only by the startup backfill. One-line fix, same shape as Legal's 7b.
