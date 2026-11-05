# Quickstart — verifying V5

How to check each slice actually does what it claims. Contract IDs (G1…, O1…,
S1…) refer to [contracts/gate-decision.md](contracts/gate-decision.md).

## Prerequisites

```bash
cd foundry
pnpm install
```

A running Postgres (`infra/docker-compose.yml`) is needed for the schema and
migration checks. The service and route tests mock the repositories and need no
database.

## §0 — Baseline, before any source change

Record it, so FR-021 / R1 can be checked against a real before-value rather than
a remembered one.

```bash
pnpm -r typecheck
```

```bash
pnpm --filter @foundry/server test
```

```bash
pnpm --filter @foundry/client test
```

Write the three counts into `notes.md`. Also record, for the live database, which
distinct values currently exist in the two columns gaining a constraint — a
constraint added over a violating row fails the migration:

```sql
SELECT DISTINCT overall_status FROM test_results;
```

```sql
SELECT DISTINCT fired_by FROM trigger_fires;
```

## §1 — Verdict reader (slice 1)

`testResultRepo.latestForScript(scriptId)` returns the newest row by
`generated_at`, or undefined.

- **G7** — insert two test results for one script with different `generated_at`
  and different verdicts; the newer one is returned. Do this with the older row
  inserted *second*, so a test that accidentally asserts insertion order fails.
- The verdict classifier maps `fail`→refuse, `warn`/`clean`/`null`→no refusal,
  anything else→refuse (**G5**), and logs on the last.

## §2 — The gate (slice 2)

Service-level, against `enableReadiness()` with the repositories mocked:

- **G1** — `fail` + completed + succeeded execution → not ready; reason names the
  finding codes (**S1**).
- **G3** — `warn`, same conditions → ready.
- **G4** — verdict `null`, same conditions → ready.
- **G6** — `clean` but script not `completed` → still refused, with the *status*
  reason. `clean` but no succeeded execution → still refused, with the
  *never-executed* reason (**S2**).
- **G10** — a `manual` trigger with a `fail` verdict → ready.

Route-level, against the real `createApp()` — this is the part that catches the
wiring:

- **G2** — `POST` a trigger with `enabled: true` for a `fail`-verdict script → 409.
- **G1** — `PATCH`/enable an existing trigger for the same script → 409.
- **G8** — after both refusals, re-read the script and the trigger: nothing
  changed.
- **G9** — execute the script manually → still works.

The two route tests are the ones to write first. A service test with no route
test is the exact shape that let a middleware mount be deleted in V3 with the
suite green.

## §3 — Findings on the client (slice 3)

```bash
pnpm --filter @foundry/client test
```

- **S5** — the findings component renders code, severity and detail for each
  finding from the report.
- **S3** — with a `clean` verdict, the rendered copy contains no pass/score/green
  language. Assert on the copy module directly, so the test is about the words
  and survives a restyle.
- **S4** — a test that the independent-audit block and the self-reported block
  carry distinguishing labels.
- **S6** — the component branches on `blockedBy`, not on `reason` text. Test by
  changing the reason string and asserting the rendering does not change.

Responsive check per `design.md` §3 (NON-NEGOTIABLE) at ~375 / ~768 / ~1280 px.
Finding `detail` is generated-code-derived and can be long and unbroken, so the
overflow stress case is a long unbroken token — the same hazard V4 found and
fixed with `min-w-0 break-words`.

## §4 — Override (slice 4)

```bash
pnpm --filter @foundry/server test
```

- **O2** — reason `""` and `"   "` → 400 at the route. Then assert the database
  constraint independently by attempting a direct insert, so the rule is proved
  in both layers rather than assumed to be one.
- **O1** — a real reason → 201, and the previously-refused enable now succeeds.
- **O3** — insert a second `test_results` row with a `fail` verdict for the same
  script; the enable is refused again. This is the test that proves D4's
  key choice actually works.
- **O5** — a second trigger on the same audited code is armable without a second
  override.
- **O6** — the override's reason and time appear on the trigger's public shape.
- **O7** — no role, scope or credential differs before and after.

Migration check against a live database:

```bash
pnpm --filter @foundry/server exec drizzle-kit migrate
```

Then confirm both new constraints reject a bad value and accept the good ones,
following the existing pattern in `db/schema.test.ts:73`.

## §5 — Hardening (slice 5)

**Deletion pass (R3).** For each wiring point below: delete it, run the full
suite, record CAUGHT or SURVIVED, revert. Anything that SURVIVES is untested
wiring and needs a test before the slice is done.

1. the verdict refusal inside `enableReadiness()`
2. `assertEnableAllowed` on the enable route
3. the `create({enabled:true})` call to `assertEnableAllowed`
4. the unrecognised-verdict fail-closed branch
5. the override lookup that lets a blocked enable through
6. the `test_result_id` scoping of the override (delete it and let any override apply)
7. the reason non-empty check in the service
8. the reason CHECK constraint in the migration
9. the findings component's mount point
10. the override path in the client proxy allowlist

Point 6 is the one to watch: it is the difference between "an override" and "an
override for this code", and a test that only ever uses one test result cannot
tell them apart.

**Asymmetry deletion (G6).** Separately from the above: delete the verdict
condition entirely and run the suite. Every case refused before must still be
refused for its original reason. If any previously-refused case now passes, the
verdict was contributing to a permit somewhere and the asymmetry is broken.

**Regression (R1/R2).** Re-run the §0 commands. Compare against the recorded
baseline. The only new failures permitted are tests that deliberately encode the
new refusal.
