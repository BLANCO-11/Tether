# Tasks: Client-Side Validation Coherence

**Feature**: `specs/20260804-081646-client-validation-coherence` | **Branch**: `krt/guardrail_validation`

**Inputs**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/shared-rules.md](contracts/shared-rules.md),
[quickstart.md](quickstart.md)

**Tests are required** (Article II). Contract IDs (E1…, C1…, S1…, N1…, G1…, A1…)
refer to `contracts/shared-rules.md`.

**The standing rule for this whole feature**: client validation is UX, never the
guardrail. Every rule the client enforces must already be enforced server-side
(FR-006). This feature must not add a rule that exists only on the client.

**Do not wire `zNetworkMode`.** It is an orphan primitive waiting on the
boolean→enum breaking change, which is its own PR (research F3).

---

## Phase 1: Setup and baseline

- [X] T001 Record the pre-feature baseline in `specs/20260804-081646-client-validation-coherence/notes.md`: `pnpm -r typecheck` and the three package test counts.
- [X] T002 Record the **exact current message string** for every export of `foundry/packages/server/src/validation/primitives.ts` in `notes.md`. **S3** requires them byte-identical afterwards, and "it looked the same" is not a check. Include the inconsistent register ("must be…" vs "Must be…") — it is preserved, not fixed, in this feature.
- [X] T003 Create the `@foundry/shared` package skeleton at `foundry/packages/shared/` with no third-party dependencies, and wire it into the workspace and both consumers' `tsconfig`/`package.json`.
- [X] T004 Write `foundry/packages/shared/README.md` stating what belongs in the package and, more usefully, what does not — nothing that would let the client *enforce* rather than *preview*. Without a stated boundary, "shared" becomes where everything goes.

---

## Phase 2: Foundational — the shared definitions (slice 1)

- [X] T005 [P] Write `foundry/packages/shared/src/rules.cases.ts` — the accepted and rejected case table per rule, from research F2. **Every rule needs a non-empty `accepted` list**; a table with only rejected values cannot catch **E2**, which is the failure that produces no error report.
- [X] T006 [P] Write `foundry/packages/shared/src/rules.test.ts` for **E5** and **C5**: the definitions module imports nothing from either consumer, contains no functions and no zod; patterns are source strings, never `RegExp` objects (a shared `RegExp` with `g` carries `lastIndex` across consumers).
- [X] T007 Write `foundry/packages/shared/src/rules.ts` — the definitions as plain data per data-model.md: `uuid`, `envVarName`, `identifier`, `httpUrl`, `isoDay`, `yearMonth`, `positiveInt`, `isoDate`. Messages copied **verbatim** from T002 (FR-002).
- [X] T008 Carry `zEnvVarName`'s explanatory comment into the shared definition — the one recording that case-insensitivity was kept deliberately because tightening would reject requests that succeed today (**S4**, research F2). Without it someone tidies the pattern and breaks live callers.
- [X] T009 Run `pnpm --filter @foundry/shared test`.

---

## Phase 3: Foundational — the server rebuilt on it (slice 2)

**Before the client depends on anything, prove the definitions reproduce current
server behaviour exactly.**

- [X] T010 [P] Write `foundry/packages/server/src/validation/primitives.equivalence.test.ts` for **E4**: every export of `primitives.ts` is constructed from a shared definition, and a primitive reverting to a literal pattern fails this test. **This is what makes FR-003 structural rather than a review convention.**
- [X] T011 Rebuild `foundry/packages/server/src/validation/primitives.ts` on the shared definitions. Every export keeps its name (**S1**) and its message (**S3**).
- [X] T012 Run the server suite and confirm `primitives.test.ts` passes **unchanged** (**S2**). If it needed editing, behaviour changed — stop and find out what moved. This feature is not permitted to change server behaviour.
- [X] T013 Diff the message strings against T002's record (**S3**).
- [X] T014 Verify T010's guarantee actually works: temporarily revert one primitive to a literal pattern and confirm the equivalence test fails. Revert. A guarantee nobody has seen fail is a guarantee nobody has verified.

---

## Phase 4: User Story 1 — the client rejects what the server rejects (P1)

- [X] T015 [P] [US1] Write `foundry/packages/client/src/lib/field-check.test.ts` for **E1**: every value in every rule's `rejected` list is rejected by the client checker.
- [X] T016 [P] [US1] Same file, **E2**: every value in every rule's `accepted` list is accepted. This is the test that catches the client being stricter than the server — the failure mode that generates no error report, just an operator who assumes they are wrong.
- [X] T017 [P] [US1] Same file, **E3**: the client's message equals the server's, character for character.
- [X] T018 [P] [US1] Same file, **C1**: `check` returns an empty array for valid input.
- [X] T019 [P] [US1] Same file, **C4**: assert there is **no** client counterpart to `tool.schema.ts`'s cross-field auth rules, weakened or otherwise. A test that something does not exist, deliberately — FR-005 forbids approximating a rule the client cannot express, and an approximation is exactly what someone adds in good faith later.
- [X] T020 [US1] Write `foundry/packages/client/src/lib/field-check.ts` — `check(value, rule) → ValidationProblem[]`, compiling each pattern fresh per call (**C5**).
- [X] T021 [US1] Run the client suite and `pnpm -r typecheck`.

**Checkpoint**: the client can reject what the server rejects. Nothing uses it yet.

---

## Phase 5: User Story 1 (cont.) — the forms adopt it (slice 4)

- [X] T022 [P] [US1] Write tests for **C3**: a `FormField` carrying `required`, `min`, `max` and `integer` rejects and accepts values accordingly.
- [X] T023 [P] [US1] Write a test for **A2** over the existing forms: every value accepted today is still accepted. Drive the existing form tests unchanged.
- [X] T024 [US1] Add value checking to `foundry/packages/client/src/lib/manifest-form.ts` over the constraints it **already carries** from the backend's JSON Schema. This is FR-009's "extend rather than replace" — those constraints come from the server, so they cannot drift.
- [X] T025 [US1] Replace the hand-written checks in the forms that validate tool names, env-var names and URLs today with the shared rules, so the operator sees the server's message before any request is sent.
- [ ] T026 [US1] Verify by hand in the UI: a bad tool name and a bad env-var name produce the server's message, and no request is made.
- [ ] T027 [US1] Verify the touched forms in a real browser at ~375 / ~768 / ~1280 px per `design.md` §3 (**NON-NEGOTIABLE**). Inline error text is new content in existing layouts and is exactly what pushes a form past its container.

---

## Phase 6: User Story 2 and 3 — idiom alignment and the rename (slice 5)

- [X] T028 [P] [US2] Align `gateFor` in `foundry/packages/client/src/lib/automation-flow.ts` to return `ValidationProblem[]` (**C2**); update its call sites. Keep its logic — it decides *flow*, not field validity (plan D3, spec Q2).
- [X] T029 [P] [US2] Align `validatePlan` in `foundry/packages/client/src/lib/plan.ts` to the same shape, with `field` naming the step. Keep the traversal (plan D3, spec Q3).
- [X] T030 [US2] **The SC-004 / A1 audit.** Enumerate every rule the client enforces and locate its server counterpart. Record the table in `notes.md`. `MIN_PROMPT_LENGTH = 20` and `validatePlan`'s structural rules are the two known candidates for having none. For each: derive it from a server rule, or **record it as a finding for a separate feature**. Do **not** add a server rule here — that is a behaviour change with its own regression risk, in a feature whose whole point is that the client is not the enforcement.
- [X] T031 [US3] Rename `foundry/packages/client/src/lib/validation.ts` to `build-verdicts.ts` and update every import (**N1**, **N4**).
- [X] T032 [US3] Confirm the storage key `foundry.validatedBuilds.v1` is **unchanged** (**N2**, FR-011, research R4). It is an on-disk contract with every existing browser; the module name is not. Changing it would force every user to re-validate.
- [X] T033 [US3] Confirm the SSR guard `typeof window === "undefined"` survived (**N3**).
- [ ] T034 [US3] Verify **N2** by hand: place a recorded verdict in localStorage using the pre-rename key, reload, and confirm it is still recognised. A test against a fresh store cannot catch a changed key.
- [X] T035 Run all three suites and `pnpm -r typecheck`.

---

## Phase 7: User Story 4 — gate coherence (P3, depends on V5)

**If V5 has not shipped, skip this phase and say so in `notes.md` rather than
ticking it.**

- [X] T036 [P] [US4] Write a test for **G1**: the go-live affordance reflects the server's readiness decision.
- [X] T037 [P] [US4] Write a test for **G2**: with the local verdict store cleared, the server's decision still governs.
- [X] T038 [P] [US4] Write a test for **G3**, both directions: local-validated + server-refused → refused; local-not-validated + server-ready → not offered. The store blocks, never permits (FR-013).
- [X] T039 [US4] Wire the server's readiness decision into the go-live surface, so the two gates agree rather than each answering separately.

---

## Phase 8: Hardening and close-out

- [X] T040 **Deletion pass (A4).** For each of the eight wiring points in [quickstart.md](quickstart.md) §6: delete, run the full suite, record CAUGHT/SURVIVED in `notes.md`, revert. **Watch point 3** — if deleting every `accepted` value from the case table leaves the suite green, nothing is testing **E2**, and the client-stricter-than-server failure is unguarded.
- [X] T041 **Regression (A2).** Re-run T001's commands and compare with the baseline.
- [X] T042 **A3** — confirm `foundry/packages/client/package.json` gained no runtime dependency.
- [X] T043 Record in `notes.md` the outcome of the T030 audit, listing any client-only rules found. These are findings for a future server-side feature, and writing them down is what stops them being rediscovered as "why does the UI block this".
- [X] T044 Update `docs/validation-and-guardrails-roadmap.md` §V7: `manifest-form.ts` was a **rendering** seam, not a validating one, so "adopt the existing declarative seam" was work rather than adoption; and the shared-rules approach chosen was plain-data definitions rather than shared zod or served schemas, with the reason.
- [X] T045 Run `/speckit-comply`. **Verify each `[X]` above individually rather than in bulk** — V2's comply found three tasks marked complete whose tests were never written; V3 and V4 each found more.
- [ ] T046 Commit each slice separately on `krt/guardrail_validation`, only when green. **The user drives git manually — do not commit without being asked.**
- [ ] T047 *(after merge)* Update the roadmap to mark V7 shipped, and record what stayed open — notably any client-only rules from T030, and that client validation remains UX rather than a control.

**No standards amendment.** `security.md` must **not** be amended to claim
client-side validation as a control. It is not one, and recording it as one would
be the exact misreading FR-006 exists to prevent.

---

## Dependencies

```
Phase 1 → Phase 2 (shared defs) → Phase 3 (server rebuilt) → Phase 4 (client checker)
                                                                     ↓
                                                          Phase 5 (forms adopt)
                                                                     ↓
                                                    Phase 6 (idioms + rename)
                                                                     ↓
                                          Phase 7 (US4, needs V5) → Phase 8
```

Phase 3 before Phase 4 is deliberate: if rebuilding the server's primitives changes
any server behaviour, that must surface while the client is still uninvolved.

## Parallel opportunities

- T005/T006 (different files)
- T015–T019 (one file, independent cases)
- T022/T023 (different files)
- T028/T029 (different files)
- T036–T038 (independent cases)

## MVP scope

**Phases 1–5.** The shared definitions, the server rebuilt on them, the client
checker, and the forms using it. That delivers the roadmap's stated win — the
client rejects what the server would reject, with the same message — and everything
after it is coherence and cleanup.
