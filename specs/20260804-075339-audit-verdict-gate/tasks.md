# Tasks: Audit Verdict as an Asymmetric Gate (Surface C)

**Feature**: `specs/20260804-075339-audit-verdict-gate` | **Branch**: `krt/guardrail_validation`

**Inputs**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/gate-decision.md](contracts/gate-decision.md),
[quickstart.md](quickstart.md)

**Tests are required.** Constitution Article II is Test-First and this feature is
a security gate; a gate whose tests were written afterwards is a gate that was
tested against whatever it happened to do. Contract IDs (G1…, O1…, S1…, R1…)
refer to `contracts/gate-decision.md`.

**Paths** are relative to the repository root. Server source lives under
`foundry/packages/server/src/`, client under `foundry/packages/client/src/`.

---

## Phase 1: Setup and baseline

- [X] T001 Record the pre-feature baseline in `specs/20260804-075339-audit-verdict-gate/notes.md`: `pnpm -r typecheck`, and the test counts from `pnpm --filter @foundry/server test`, `pnpm --filter @foundry/client test`, `pnpm --filter @foundry/mcp-bridge test`. FR-021/R1 is checked against this recorded value, not a remembered one.
- [X] T002 Query the live database for the distinct values currently in `test_results.overall_status` and `trigger_fires.fired_by`, and record them in `notes.md`. A CHECK constraint added over an existing violating row fails the migration; D5 requires checking before writing it, not after.
- [X] T003 Enumerate from the code — not from memory — every value the generation finaliser writes to `test_results.overall_status`, in `foundry/packages/server/src/services/script-generation.service.ts`, and record the list in `notes.md`. This list, unioned with T002's, is what `chk_test_results_overall_status` must allow.

---

## Phase 2: Foundational — the verdict reader (slice 1)

**Blocks every user story.** Pure addition; nothing gates yet.

- [X] T004 [P] Write `foundry/packages/server/src/repositories/test-result.repo.test.ts` for **G7**: two test results for one script with different `generated_at` and different verdicts, `latestForScript` returns the newer. Insert the OLDER row second, so a test that accidentally asserts insertion order fails.
- [X] T005 [P] Write `foundry/packages/server/src/services/audit-gate.test.ts` for the verdict classifier: `fail`→refuse, `warn`→no (**G3**), `clean`→no (**G6** partial), `null`→no (**G4**), unrecognised→refuse and log (**G5**).
- [X] T006 Add `latestForScript(scriptId)` to `foundry/packages/server/src/repositories/test-result.repo.ts` — the existing `listByScript` query with `.limit(1)`.
- [X] T007 Add the verdict classifier to `foundry/packages/server/src/services/audit-gate.ts`: a pure function from a persisted verdict string to `{ refuses: boolean, reason?: string }`. Fail-closed on unrecognised input (**G5**, FR-015), with a `console.warn` naming the value and the script — an uninterpretable gate input is a defect and must be diagnosable (Article V).
- [X] T008 Run `pnpm --filter @foundry/server test`. T004–T005 pass. **Nothing gates yet** — confirm the trigger tests are untouched.

**Checkpoint**: the reader exists and is tested. No behaviour has changed.

---

## Phase 3: User Story 1 — a failing audit blocks arming (P1)

**Goal**: a `fail` verdict refuses `schedule`/`poll`/`webhook` arming, and refuses
nothing else.

**Independent test**: fixture a `fail`-verdict script with a succeeded execution,
attempt to enable a trigger, observe the refusal naming the finding codes.

### Tests first

- [X] T009 [P] [US1] Extend `foundry/packages/server/src/services/trigger.service.test.ts` for **G1**: `fail` + `completed` + succeeded execution → not ready, reason names the finding codes (**S1**).
- [X] T010 [P] [US1] Same file, **G3** and **G4**: `warn` → ready; `null` verdict → ready. These are the negative tests and they are load-bearing — without them the gate will later be "simplified" to block anything non-clean, which is the symmetric version the constitution forbids.
- [X] T011 [P] [US1] Same file, **G6**: `clean` + not `completed` → still refused with the *status* reason; `clean` + no succeeded execution → still refused with the *never-executed* reason (**S2**). This is the asymmetry test. It looks redundant and it is the first thing to decay.
- [X] T012 [P] [US1] Same file, **G10**: a `manual` trigger with a `fail` verdict → ready.
- [X] T013 [US1] Write `foundry/packages/server/src/routes/trigger-audit-gate.route.test.ts` against the real `createApp()`: **G2** `POST` a trigger with `enabled: true` for a `fail`-verdict script → 409; **G1** enabling an existing trigger → 409. Route-level, because a service test with no route test is exactly the shape that let a V3 middleware mount be deleted with the suite green.
- [X] T014 [US1] Same file, **G8**: after both refusals, re-read the script and the trigger and assert nothing changed — no status flip, no `enabled` flip. The gate refuses; it does not write.
- [X] T015 [US1] Same file, **G9**: manual execution of the `fail`-verdict script still succeeds.

### Implementation

- [X] T016 [US1] Add the verdict refusal to `enableReadiness()` in `foundry/packages/server/src/services/trigger.service.ts`, **after** the existing script-status and succeeded-execution checks (R1 in research.md — the earlier, more actionable reason must keep winning).
- [X] T017 [US1] Extend `EnableReadiness` in the same file with `blockedBy`, `auditVerdict`, `blockingFindingCodes` per data-model.md. Assert the invariant in code and in a test: when `ready` is true, `blockedBy` is absent and `blockingFindingCodes` is empty.
- [X] T018 [US1] Thread the new fields through `toPublicDetailed()` in the same file, so the trigger list explains an audit block without a second implementation of the rule (D1).
- [X] T019 [US1] Gate only `schedule`, `poll` and `webhook` (**G10**, FR-004). Write the trigger type into the condition explicitly rather than excluding `manual` by omission — an omission reads as an oversight to the next person and gets "fixed".
- [X] T020 [US1] Add a comment above the new condition stating the asymmetry rule and pointing at `contracts/gate-decision.md` **G6**. The rule is not visible from the code alone: a reader sees a verdict check and has no way to know that the *absence* of a permit branch is deliberate.
- [X] T021 [US1] Run the server suite. T009–T015 green, and no pre-existing trigger test fails except those that deliberately encode the new refusal (**R2**).

**Checkpoint**: US1 is independently shippable. The gate blocks; nothing explains it yet.

---

## Phase 4: User Story 2 — the operator can see why (P1)

**Goal**: the audit findings are rendered, and a verdict is described honestly.

**Independent test**: with a `fail`-verdict script, the findings are visible in
the UI with code, severity and detail; the trigger control explains the block.

### Tests first

- [X] T022 [P] [US2] Write `foundry/packages/client/src/lib/audit-copy.test.ts` for **S3**: the `clean` copy contains no pass/score/green/success language, and does state what the check actually did. Assert on the copy module directly so the test is about the words and survives a restyle.
- [X] T023 [P] [US2] Same file, **S4**: the independent-audit label and the self-report label are distinct strings and each says which it is.
- [X] T024 [P] [US2] Write `foundry/packages/client/src/components/AuditFindings.test.tsx` for **S5**: each finding renders its code, severity and detail from the report — not from a derived summary.
- [X] T025 [P] [US2] Same file, **S6**: the component branches on `blockedBy`, never on `reason` text. Test by changing the reason string and asserting the rendering does not change.
- [X] T026 [P] [US2] Same file: a `clean` verdict renders no panel implying approval; a `warn` verdict renders the findings and states they do not block arming.

### Implementation

- [X] T027 [US2] Add `FAAuditFinding`, `FAAuditReport` and the extended `FAEnableReadiness` to `foundry/packages/client/src/lib/foundry-client.ts`, mirroring the server types.
- [X] T028 [US2] Write `foundry/packages/client/src/lib/audit-copy.ts` — the verdict strings. `clean` states that a fixed list of deterministic checks found nothing, and makes no correctness claim (FR-017). Same register as V4's `PROMPT_BOUNDARY_EMPTY`, which exists for the same reason.
- [X] T029 [US2] Write `foundry/packages/client/src/components/AuditFindings.tsx`. Follow `.specify/memory/design.md`: compose from the scaffolded components, design tokens only. Per §3, flex children holding text carry `min-w-0 break-words` — finding `detail` is derived from generated code and can be a long unbroken token, which is the exact overflow V4 hit and fixed.
- [X] T030 [US2] Mount it where the automation's results are shown, **visually and textually separate** from `buildVerdictFromTests`'s self-reported score (**S4**, FR-020). Two verdict-shaped things on one screen with no stated difference is worse than one, because the reader averages them.
- [X] T031 [US2] Surface the audit block on the trigger control from `blockedBy` / `blockingFindingCodes`, linking to the findings (**S1**, FR-013).
- [ ] T032 [US2] Verify the new UI in a real browser at ~375 px, ~768 px and ~1280 px per `design.md` §3 (**NON-NEGOTIABLE**). Include a long unbroken `detail` as the overflow stress case. Static review does not substitute — V4's T044 stayed open for exactly this reason.
      **STILL OPEN 2026-08-04, same cause as V4's T044.** No browser with a layout
      engine is available: the only one running is `lightpanda-browser`, which has
      none, and no Chrome instance is connected. What *has* been done, and what it
      does not substitute for — `AuditFindings.test.tsx` asserts the
      `min-w-0 break-words` classes against a 400-character unbroken token, so the
      overflow *guard* is tested; a class assertion is not a layout, and nothing
      here proves the panel does not overflow at 375 px. Do not tick this on the
      strength of the unit test.
- [X] T033 [US2] Run `pnpm --filter @foundry/client test` and `pnpm -r typecheck`.

**Checkpoint**: a refusal is explicable from the UI alone.

---

## Phase 5: User Story 3 — override, on the record (P2)

**Goal**: an operator who has read the findings can proceed, with a reason that persists.

**Independent test**: override without a reason (refused), with a reason
(allowed), then regenerate and confirm the override no longer applies.

### Tests first

- [X] T034 [P] [US3] Write `foundry/packages/server/src/db/audit-overrides.schema.test.ts` for **O2**'s database half and the two new CHECK constraints, following the live-database pattern already in `foundry/packages/server/src/db/schema.test.ts:73`: a direct insert with `reason = '   '` is rejected; a bad `overall_status` and a bad `fired_by` are rejected; the good values are accepted.
- [X] T035 [P] [US3] Write `foundry/packages/server/src/services/audit-override.service.test.ts` for **O2**'s service half: `""` and `"   "` refused. Both layers, because a rule enforced in one layer is enforced until someone writes a second insert path.
- [X] T036 [P] [US3] Same file, **O4**: no code path creates an override implicitly. Assert the repository's create is called only from the override service.
- [X] T037 [US3] Write `foundry/packages/server/src/routes/audit-override.route.test.ts` against the real `createApp()`: **O1** a real reason → 201, and the previously-refused enable now succeeds; empty reason → 400.
- [X] T038 [US3] Same file, **O3**: insert a second `test_results` row with a `fail` verdict for the same script, then attempt the enable — refused again. This is the test that proves D4's key choice works, and it is the one a single-test-result fixture cannot express.
- [X] T039 [US3] Same file, **O5**: a second trigger bound to the same audited code is armable without a second override.
- [X] T040 [US3] Same file, **O6**: the override's reason and time appear on the trigger's public shape and on the script's.
- [X] T041 [US3] Same file, **O7**: no role, scope or credential differs before and after the override. The override permits one action; it grants no authority.

### Implementation

- [X] T042 [US3] Add the `audit_overrides` table to `foundry/packages/server/src/db/schema.ts` per data-model.md, keyed on `test_result_id` with `ON DELETE CASCADE`, including the `length(btrim(reason)) > 0` CHECK and the `idx_audit_overrides_test_result` index. **No `overridden_by` column** — research F2: there is no verified user identity at this boundary, and a column with that name holding a client-supplied string would be an attribution the system cannot stand behind.
- [X] T043 [US3] Add `chk_test_results_overall_status` and `chk_trigger_fires_fired_by` to the same file, using the value lists recorded in T002/T003. Do **not** touch the four constraints that already exist (D5, research F1) — the roadmap's claim that they are missing is out of date.
- [X] T044 [US3] Generate the migration into `foundry/packages/server/drizzle/` and read the generated SQL before applying it. Confirm it adds only the new table, the index and the two constraints, and drops nothing.
- [X] T045 [US3] Write `foundry/packages/server/src/repositories/audit-override.repo.ts` — `create(row)` and `findByTestResult(testResultId)`.
- [X] T046 [US3] Write `foundry/packages/server/src/services/audit-override.service.ts` — zod input validation reusing V1's primitives, reason trimmed-non-empty and capped at 2000 characters (research R3), and denormalisation of `verdict_at_override` and `finding_codes` at write time so the record stays readable as a statement about what the human saw.
- [X] T047 [US3] Wire the override lookup into `enableReadiness()` in `foundry/packages/server/src/services/trigger.service.ts`: an override for the **current** `test_results` row suppresses the audit refusal and only the audit refusal. It must not suppress the script-status or never-executed refusals — those are not the operator's to override here.
- [X] T048 [US3] Add the override endpoint to `foundry/packages/server/src/routes/scripts.ts`, behind the same auth as the enable path (research R4). Do not invent a new privilege tier; on a system with one shared API key that would be authorization theatre.
- [X] T049 [US3] Add the override path to `foundry/packages/client/src/lib/proxy-allowlist.ts` and the call to `foundry/packages/client/src/lib/api.ts`.
- [X] T050 [US3] Add the override action and the recorded-override display to the trigger surface (**O6**). An override discoverable only in the database is a silent side effect.
- [X] T051 [US3] Run the full server and client suites and `pnpm -r typecheck`.

**Checkpoint**: the gate is escapable, on the record, and the escape is scoped to reviewed code.

---

## Phase 6: Hardening and close-out

- [X] T052 **Deletion pass.** For each of the ten wiring points in [quickstart.md](quickstart.md) §5: delete it, run the full suite, record CAUGHT or SURVIVED in `notes.md`, revert. Anything that SURVIVES is untested wiring — write the test before ticking this. The last four slices in this programme each shipped at least one wiring point that survived, so treat a clean first pass as suspicious rather than as done.
- [X] T053 **Asymmetry deletion (G6).** Separately from T052: delete the verdict condition entirely and run the suite. Every case refused before must still be refused for its original reason. If any previously-refused case now passes, the verdict was contributing to a permit somewhere and the asymmetry is broken. Record the result in `notes.md` either way.
- [X] T054 **FR-021 / R1 regression check.** Re-run the T001 commands and compare against the recorded baseline. The only new failures permitted are tests that deliberately encode the new refusal. Record the comparison in `notes.md`.
- [X] T055 Review every string and element that renders a verdict, across server and client, for **S3** — no pass, score, green check or correctness claim on `clean`. Record the surfaces reviewed in `notes.md`, so "we checked" has an inventory behind it (SC-005).
- [X] T056 Confirm **G8** by inspection as well as by test: grep the new code for any write to `scripts`, `triggers` or `test_results`. There must be none outside the override's own insert.
- [X] T057 Update `docs/validation-and-guardrails-roadmap.md` §V5 to correct the "DB CHECK constraints (hole 8)" claim — four of them already existed before this feature (research F1). Leaving the text uncorrected sets the next reader up for the same wasted work.
- [X] T058 Run `/speckit-comply`. **Verify each `[X]` above individually rather than in bulk** — V2's comply found three tasks marked complete whose tests were never written, V3 carried the instruction forward for the same reason, and V4's comply found two more. Resolve CRITICAL and HIGH findings before the feature is called done.
- [ ] T059 Commit each slice separately on `krt/guardrail_validation`, only when green. **The user drives git manually — do not commit without being asked.**
- [ ] T060 *(after merge)* Run `/speckit-update-standards` to reconcile `security.md` §8: a finding may block an irreversible action, and the absence of findings still permits nothing. The text must be reconciled, not contradicted.
- [ ] T061 *(after merge)* Update `docs/validation-and-guardrails-roadmap.md` to mark V5 shipped, and record what it deliberately left open — notably that anyone who can arm a trigger can override the gate that blocks it (research R4), pending §9 R2.

---

## Dependencies

```
Phase 1 (setup)  →  Phase 2 (verdict reader)  →  Phase 3 (US1: the gate)
                                                        ↓
                                                 Phase 4 (US2: visibility)
                                                        ↓
                                                 Phase 5 (US3: override)
                                                        ↓
                                                 Phase 6 (hardening)
```

US2 is ordered **before** US3 despite being the same priority as US1, because
shipping an override button next to a refusal nobody can inspect is worse than
shipping the refusal alone. US1 alone is a viable increment; US1 + US2 is the
sensible MVP.

## Parallel opportunities

- T004 and T005 (different files, no shared state)
- T009–T012 (same file, independent cases — parallel by author, not by process)
- T022–T026 (client tests, two files)
- T034–T036 (three different test files)

## MVP scope

**US1 + US2.** The gate plus the ability to see why it fired. US3 can follow in a
separate commit; until it lands, a false positive from `invented_endpoint` —
which research F4 records as having marked a correct script as failing — is
escaped by regenerating the script rather than by overriding, which is worse but
not blocking.
