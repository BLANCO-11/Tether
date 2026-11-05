# Notes — V5 Audit Verdict as an Asymmetric Gate

Working record. Everything here is measured, not remembered.

---

## T001 — Pre-feature baseline (2026-08-04, commit `14c30e0`)

Recorded **before** any source change, so FR-021 / R1 is checked against a real
before-value.

| Command | Result |
|---|---|
| `pnpm -r typecheck` | **clean** — client, mcp-bridge, server all `Done` |
| `pnpm --filter @foundry/server test` | **38 files passed; 651 passed, 23 skipped (674 total)** |
| `pnpm --filter @foundry/client test` | **8 files passed; 165 passed** |
| `pnpm --filter @foundry/mcp-bridge test` | **2 files passed; 49 passed** |

Server suite duration ~38 s (includes the live-database `demo/hr-roles.test.ts`
and a 30 s `statement_timeout` case). The 23 skipped are pre-existing.

### Environment note — where this work is being done

The session was launched in a git worktree
(`.claude/worktrees/validation-guardrails-v5-8ac35f`, branch
`claude/validation-guardrails-v5-8ac35f`). `specs/` is gitignored
(`.gitignore:95`), so the worktree contained **none** of the V1–V5 spec
artifacts and `scripts/spec-gate-core.sh` resolved *no active feature* — it
denied shell commands outright.

Resolved, not worked around:

- `.specify/feature.json` now points at this feature in **both** the main
  checkout and the worktree, so the agent-time gate and the authoritative
  commit-time gate (`.githooks/pre-commit`) resolve the same feature.
- `specs/20260804-075339-audit-verdict-gate` is symlinked into the worktree so
  the gate reads the real artifacts rather than being inert.
- Implementation lands in the **main checkout** `/home/kriti/foundry` on
  `krt/guardrail_validation`, matching V1–V4 and tasks.md T059.

---

## T002 — Live-database values in the two columns gaining a CHECK (D5)

Against `postgres://…@localhost:5433/foundry_parent` (`foundry-parent-postgres`).

```sql
SELECT overall_status, count(*) FROM test_results GROUP BY 1 ORDER BY 1;
--  overall_status | count
-- ----------------+-------
-- (0 rows)

SELECT fired_by, count(*) FROM trigger_fires GROUP BY 1 ORDER BY 1;
--  fired_by | count
-- ----------+-------
-- (0 rows)
```

**Both tables are empty on this database.** So the migration cannot fail here on
a pre-existing violating row.

**This is a weaker result than it looks and must not be read as "the data is
clean".** It says only that *this* database has no rows to violate the
constraint. Any database with generation history — a colleague's, or a deployed
instance — may hold a value outside the allowed set, and the migration will fail
there. The allowed set in T003 is therefore derived from the **code**, which is
the durable check, and the emptiness here is recorded as a non-finding rather
than as evidence.

---

## T003 — Every value the finaliser writes to `test_results.overall_status`

Enumerated from the code, not from memory. `overall_status` is written by exactly
**one** path — `finalize()` in
`foundry/packages/server/src/services/script-generation.service.ts:906`, through
`testResultRepo.insert()`. `grep -rn "overallStatus"` across
`packages/server/src` (excluding tests) returns only the schema declaration and
this one site; `test-result.repo.ts` has no update method at all.

```ts
// script-generation.service.ts:906
const overallStatus = succeeded
  ? "succeeded"
  : claimedOk && !hasCode
    ? "needs_review"
    : (contract?.status ?? "needs_review");
```

So the value is either a literal (`succeeded`, `needs_review`) or
`contract.status`, whose type is declared at
`services/tether-client.service.ts:25`:

```ts
status: "running" | "succeeded" | "failed" | "timeout" | "error" | "needs_review" | "awaiting_input";
```

**Are the non-terminal statuses actually reachable here?** Yes.
`TERMINAL = {succeeded, failed, timeout, error, needs_review}`
(`script-generation.service.ts:18`). Line 753 rewrites a non-terminal contract to
`status: "timeout"` **only when no fresh `RESULT.json` is present**. When a
non-terminal contract *and* a `RESULT.json` are both present, `contract.status`
reaches line 906 unrewritten — so `running` and `awaiting_input` are both
writable. Excluding them would make the constraint reject a state the code can
legitimately produce, which is how a CHECK constraint turns into an outage.

The column is nullable (`varchar("overall_status", { length: 20 })`, no
`notNull`), so NULL must be allowed too.

### `chk_test_results_overall_status` — allowed set

```
NULL, 'succeeded', 'failed', 'timeout', 'error', 'needs_review', 'running', 'awaiting_input'
```

### `chk_trigger_fires_fired_by` — allowed set

`fired_by` is `notNull` and written from one place —
`trigger.service.ts:169 fire(triggerId, firedBy: FiredBy, …)`. The `FiredBy`
union is the four trigger origins, matching data-model.md:

```
'manual', 'schedule', 'poll', 'webhook'
```

---

## T052 — Deletion pass

Each wiring point from [quickstart.md](quickstart.md) §5 was deleted individually,
the **full** suite run, the result recorded, and the change reverted. Driven by
`scratchpad/deletion-pass.py` so the revert cannot be forgotten.

| # | Wiring point | Result |
|---|---|---|
| 1 | the verdict refusal inside `enableReadiness()` | **CAUGHT** — 4 files |
| 2 | `assertEnableAllowed` on the update/enable path | **CAUGHT** — 2 files |
| 3 | the `create({enabled:true})` call to `assertEnableAllowed` | **CAUGHT** — 3 files |
| 4 | the unrecognised-verdict fail-closed branch | **CAUGHT** |
| 5 | the override lookup that lets a blocked enable through | **CAUGHT** |
| 6 | the `test_result_id` scoping of the override | **CAUGHT** |
| 7 | the reason non-empty check in the service | **CAUGHT** |
| 8 | the reason CHECK constraint in the migration | **not deletable here** — see below |
| 9 | the findings component's mount point | **SURVIVED → fixed → CAUGHT** |
| 10 | the override path in the client proxy allowlist | **CAUGHT** |

### Point 9 SURVIVED — the fifth slice in a row to ship this

`components/AuditFindings.test.tsx` (14 tests) and the copy tests were green, and
**deleting the component's mount from the automation detail page left the entire
suite passing.** A rendered component nobody renders. Exactly the pattern V1, V2,
V3 and V4 each shipped once, and V5 shipped it too until the pass found it.

Closed by `client/src/app/(app)/automations/audit-findings-mount.test.tsx`, which
renders the **real page component** with its data sources mocked and asserts the
findings reach the markup. Re-run after the fix: **CAUGHT**.

Two details worth keeping, because both cost time:

- `renderToStaticMarkup` runs no effects, so the page must see its data on the
  first synchronous pass. The mock exploits the fact that each `useAsync(() =>
  someApiFn(id))` closure calls its api function synchronously, and has the mocked
  api record what it is about to resolve. Order-independent on purpose — keying on
  the order of the four `useAsync` lines would break on a legitimate refactor.
- React escapes `'` to `&#x27;`, and both labels contain one. The test decodes
  before asserting so it fails on the words, not on an HTML-entity detail.

### A SECOND survivor, not on quickstart's list — the triggers page

Found while checking Article II coverage during `/speckit-comply`, after the
scripted pass had finished. Quickstart §5's ten points named the *automation page's*
findings mount but not the **triggers page**, which is the screen with the live
switch on it — the place the refusal is actually met.

Deleting all three V5 mounts there (the block notice, the "Record an override…"
button, and the recorded-override panel) left the client suite green at **201
passing**. Closed by
`client/src/app/(app)/triggers/audit-block-mount.test.tsx` (8 tests); re-run after
the fix: **CAUGHT, 5 failures**.

The lesson to carry to V6/V7: the deletion-point list in `quickstart.md` is itself
a hand-written artifact and can be incomplete. Deriving the list from the diff —
every new component reference in a page — would have caught both survivors, and
would not have depended on remembering.

### FINDING fixed during comply — the block copy lied to an already-armed trigger

FR-013 explicitly covers "the case where a trigger was armed before the code was
regenerated into a `fail`". The gate handles it correctly (research R2: nothing
auto-disables, because auto-disabling is itself a silent side effect). **The copy
did not.**

`AUDIT_BLOCK_EXPLAINER` opens "This blocks running the automation on a schedule…",
and the notice rendered on a **live** trigger — where nothing is blocked and the
automation is still firing every night. Telling the operator it is blocked when it
is running is the same Article XV defect as calling `clean` a pass, pointing the
other way: it would have someone close the tab believing an automation had stopped.

Fixed with `AUDIT_BLOCK_ALREADY_LIVE_EXPLAINER`, selected on the trigger's live
state, which says the trigger is still running, why the findings appeared now, and
what the operator can actually do (pause, rebuild, or override). Two tests, one of
them the control that keeps the not-yet-armed case still saying "blocks".

### Point 8 — why it could not be deleted, and what covers it instead

Deleting the constraint requires `ALTER TABLE`, and DDL against the dev database is
denied by this environment's permission layer. It is **not** untested wiring
though, and there is direct evidence rather than an argument:

**the constraint's first version was wrong, and `db/audit-overrides.schema.test.ts`
caught it.** It was written as `length(btrim(reason)) > 0`. PostgreSQL's one-argument
`btrim` trims **spaces only**, so `length(btrim(E'\t\n  '))` is 2 and a
tab/newline-only reason satisfied the constraint. The test failed on exactly that
case. Fixed to `reason ~ '[^[:space:]]'` — at least one non-whitespace character —
and re-verified against the live constraint definition.

That is the failure mode the two-layer rule exists for: the service's zod `.trim()`
already caught it, which is why the database looked fine.

### T053 — Asymmetry deletion (G6)

The verdict condition was disabled and `trigger-gate.test.ts` run in full:

- **All 11 pre-V5 tests: still pass.** Nothing about the pre-existing gate changed.
- **All three G6 tests: still pass** — `clean` + not `completed` still refused for
  the *status* reason; `clean` + never executed still refused for the
  *never-executed* reason; `clean` + failed-only-history still refused.
- **Only the 6 tests that assert the new refusal fail**, which is the expected and
  required result.

**No case that was refused before became permitted.** The verdict contributes to no
`ready: true` anywhere, which is the whole design (D3) and is now measured rather
than asserted.

---

## T054 — FR-021 / R1 regression comparison

| Command | Baseline (T001) | After V5 | Delta |
|---|---|---|---|
| `pnpm -r typecheck` | clean | clean | — |
| server | 38 files, 651 passed, 23 skipped | **44 files, 731 passed, 23 skipped** | +6 files, +80 |
| client | 8 files, 165 passed | **12 files, 209 passed** | +4 files, +44 |
| mcp-bridge | 2 files, 49 passed | **2 files, 49 passed** | — |

**Zero pre-existing tests fail, and the skip count is unchanged at 23.** No new
failures at all — not even ones deliberately encoding the new refusal, because the
pre-V5 gate tests never fixtured an audit verdict.

### An observation about those 23 skipped tests (not a V5 change)

Several files guard with `const hasDb = Boolean(process.env.DATABASE_URL)`. That env
var is loaded by `config/index.js` via dotenv, so **at module scope it is still
undefined** and those files report as *skipped* even with the database running.
`services/trigger-gate.test.ts` gets this right by probing with a query instead, and
V5's new database-touching tests copy the probe rather than the `hasDb` idiom — which
is why they actually execute. Left alone otherwise: converting the pre-existing files
would change what the suite runs, which is not this feature's business. Worth its own
small change.

---

## T055 — Verdict-rendering surface inventory (SC-005)

Every surface that renders or carries a verdict, reviewed against **S3** (no pass,
score, green check or correctness claim on `clean`) and **S4** (the independent audit
and the self-report are distinguishable, each stating which it is).

### Server

| Surface | Verdict? | S3/S4 |
|---|---|---|
| `services/audit-gate.ts` | classifies | OK — returns `{ refuses }`, no permit field to set; `clean` and `warn` are `toEqual` by test |
| `services/trigger.service.ts` | `auditVerdict` for display, `blockedBy` | OK — one `ready: true`, verdict never in a permit |
| `services/audit-override.service.ts` | `verdictAtOverride` | OK — records the verdict as it stood; makes no claim |
| `services/generation-audit.service.ts` | produces it | unchanged by V5; already advisory-only by design |
| `db/schema.ts` | persists it | OK — CHECK constraints, no display |

### Client

| Surface | Verdict? | S3/S4 |
|---|---|---|
| `lib/audit-copy.ts` | all the words | OK — `clean` has `tone: "neutral"`, never `"ok"`; approval vocabulary asserted absent for all five verdict cases |
| `components/AuditFindings.tsx` | renders findings | OK — labelled `AUDIT_INDEPENDENT_LABEL`, `clean` gets no colour, no tick, no score |
| `app/(app)/automations/[id]/page.tsx` | both panels | OK — self-report relabelled `AUDIT_SELF_REPORT_LABEL` with its own explainer; audit is a separate section below, order asserted by test |
| `app/(app)/triggers/page.tsx` | block + override record | OK — branches on `blockedBy`, renders the reason as prose without parsing it |
| `lib/adapters.ts` | carries `auditJson` through | OK — carried unsummarised, deliberately not folded into `buildVerdictFromTests`'s score |
| `lib/validation.ts` | *not* a verdict surface | misleading name — a localStorage record of which prompt versions passed a real test build. V7's rename, noted there already |

### FINDING — `app/(app)/automations/new/page.tsx` claims an independent review that does not exist

**Pre-existing, not introduced by V5, and squarely the principle this slice is
about.** Recorded rather than fixed, because fixing it means rewriting the builder's
Stage-2 narrative and that is a product decision, not a V5 cleanup.

The builder page renders, at `:1135-1162`:

- heading **"Validate it independently"**
- *"An external test facility grades the script on adversarial inputs and reviews it
  for security. Only a passing version can go live."*
- a panel headed **"Real test build · external facility"**, showing a **`score`**, a
  **P/F/NH** breakdown, and **attempt N/3** with a *"repairing"* phase.

Against the real Parent API, `build` comes from `buildVerdictFromTests(tests)`. That
adapter's own comment (`lib/adapters.ts:408`) says what it actually is:

> Degrade App A's self-test result into the UI's richer BuildVerdict shape (App A has
> no external adversarial facility — no phases/cases/repair loop).

So the screen attributes the agent's **self-report** to an external adversarial
facility, scores it, and describes a repair loop that does not run. That is the
Article XV defect V5 exists to remove, one page over: a signal presented as
something stronger than it is. It is also the S4 confusion in its purest form —
here the self-report is not merely *undistinguished* from an independent check, it
is *labelled as one*.

Not changed under this feature. Needs a decision: either the copy tells the truth
about what ran, or the facility gets built.
