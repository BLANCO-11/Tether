# Tasks: Request Policy Engine (V8)

**Input**: Design documents from `/specs/20260806-081433-request-policy-engine/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — all present.

**Tests**: requested explicitly (spec.md "Testing Expectations" + FR-018). Test tasks are included and precede their implementation within each phase.

**Organization**: by user story (US1–US5, spec.md priorities). **Note on US1/US2 sequencing**: spec.md states these are "equal in priority" and a P1 rejection-only rule (US1) implemented without its differentiation counter-evidence (US2) would produce the exact false positives ("Slack alternative" → wrongly rejected) the spec calls a worse outcome than a missed clone. They are therefore implemented in the same phase (Phase 3) rather than sequentially — this is a deliberate deviation from strict per-story sequencing, recorded here rather than left implicit.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5, mapping to spec.md's user stories
- All paths are relative to `foundry/` (the pnpm workspace root), per plan.md's Project Structure

---

## Phase 1: Setup

**Purpose**: package scaffolding, no behavior yet.

- [X] T001 Create `packages/shared/src/request-policy/` directory with empty `evidence.ts`, `config.ts`, `rules.ts`, `combinator.ts`, `transform.ts`, `fixtures.ts`
- [X] T002 Add `export * from "./request-policy/evidence.js";` and re-exports for the other new modules to `packages/shared/src/index.ts`
- [X] T003 Add a "Request policy configuration" section to `packages/shared/README.md` per plan.md Decisions D2 — states explicitly that this module's functions (`rules.ts`, `combinator.ts`, `transform.ts`) are an intentional exception to the package's "plain data only" rule, and why (FR-004–FR-008 require the split to live here, next to the data it operates on, per V7's dual-consumption mechanism)

**Checkpoint**: package compiles, no runtime behavior yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: types and config every user story's rules/combinator depend on.

**⚠️ CRITICAL**: no user-story rule or combinator work can begin until this phase is complete.

- [X] T004 [P] Define `Evidence` discriminated union (`productReference`, `reproductionIntent`, `differentiationQualifier`, `capabilitySignature`) in `packages/shared/src/request-policy/evidence.ts`, per data-model.md
- [X] T005 [P] Define `PolicyDecision`, `EvaluationMode`, `ResolvedRequest`, `RuleCapability` types in `packages/shared/src/request-policy/evidence.ts`, per data-model.md
- [X] T006 [P] Define `PolicyConfig`, `ProductEntry`, `FeatureSubstitute`, `IntentLexicon` types in `packages/shared/src/request-policy/config.ts`, per data-model.md
- [X] T007 Populate an initial `PolicyConfig` dataset in `packages/shared/src/request-policy/config.ts`: products (Facebook, Instagram, Slack, Salesforce/CRM-class, Stripe, SAP, Uber, Uber Eats) with short, genuinely distinguishing `distinguishingFeatures` lists (exclude generic features per FR-014); `featureSubstitutes` for each distinguishing feature; `intentLexicon.reproduction` (clone, exact copy, identical, replicate, rebuild) and `intentLexicon.differentiation` (alternative, interop, similar, vertical phrase patterns), per spec Edge Cases; set `version: "1"`
- [X] T008 Write a unit test in `packages/shared/src/request-policy/config.test.ts` asserting every `featureSubstitutes` entry's `feature` exists in some product's `distinguishingFeatures` (catches a typo'd mapping at test time, not at TRANSFORM time)
- [X] T009 Build the fixture table skeleton in `packages/shared/src/request-policy/fixtures.ts`: an array of `{ request: string, mode: EvaluationMode, expected: PolicyDecision["decision"] }`, seeded with the spec's Edge Cases requests (empty `evidence`/`reason` assertions added per-story below)

**Checkpoint**: types and a versioned config exist; no rule or combinator logic yet.

---

## Phase 3: User Story 1 & 2 — Explicit clones rejected; category/alternative requests always allowed (Priority: P1) 🎯 MVP

**Goal**: the two P1 behaviors that must ship together (see note above): an explicit product+reproduction-intent request is rejected with named evidence; a category-level or alternative/interoperability-framed request is never blocked, even when it names a product.

**Independent Test**: submit the spec's US1 and US2 fixture requests (`"Build Facebook"` → reject; `"build a social media platform"`, `"an open-source Slack alternative"`, `"a PostgreSQL-compatible database"` → allow) and confirm every one decides correctly, before any generation call.

### Tests for User Story 1 & 2

- [X] T010 [P] [US1] Add fixture cases to `packages/shared/src/request-policy/fixtures.ts` for direct clones ("Build Facebook", "Clone Instagram exactly", "Rebuild Facebook from scratch") → `reject`
- [X] T011 [P] [US2] Add fixture cases to `packages/shared/src/request-policy/fixtures.ts` for category-level requests ("build a social media platform", "build a CRM", "build a video sharing platform") → `allow`, and alternative/interop-framed requests ("an open-source Slack alternative", "a CRM like Salesforce", "a PostgreSQL-compatible database", "a browser compatible with Chrome extensions") → `allow`
- [X] T012 [P] [US1] Unit tests for the product-reference rule in `packages/shared/src/request-policy/rules.test.ts`: matches a cataloged product name and its aliases, produces no evidence for an uncataloged product name
- [X] T013 [P] [US1] Unit tests for the reproduction-intent rule in `packages/shared/src/request-policy/rules.test.ts`: matches each lexicon phrase, produces no evidence for neutral phrasing
- [X] T014 [P] [US2] Unit tests for the differentiation-qualifier rule in `packages/shared/src/request-policy/rules.test.ts`: matches alternative/interop/similar phrases per product, produces no evidence when absent
- [X] T015 [US1] Unit tests for the combinator in `packages/shared/src/request-policy/combinator.test.ts`: `productReference` + `reproductionIntent` evidence, no differentiation evidence → `reject` — **CORRECTED 2026-08-12 (post-merge audit, T068)**: the task text as originally written claimed `canRejectAlone` is "respected via `RuleCapability` metadata (not a hardcoded rule-name check)". That was never true of the implementation: `combinator.ts`'s `decide()` branches directly on evidence `kind` (`productRefs`/`reproIntents`/`capabilityMatches`), and never reads `.capability`/`.canRejectAlone` on any rule. The tests this task added (`rules.test.ts`'s "declares canRejectAlone: false" cases) only assert the field's static value on each rule — they do not, and never did, exercise any dispatch through it, because the combinator performs no such dispatch. `canRejectAlone` remains metadata reserved for a future generic rule-dispatch mechanism, not yet wired up; the current combinator's policy is explicitly defined per evidence type, in `decide()` itself. This is the safer, already-tested behavior — the fix here is documentation, not code (see `evidence.ts`'s `RuleCapability` doc comment, corrected in the same pass).
- [X] T016 [US2] Unit tests for the combinator: `productReference` + `reproductionIntent` evidence **plus** `differentiationQualifier` evidence → `allow`, per FR-008's reconciliation requirement — the combinator, not the product-reference rule, performs this reconciliation (assert by checking the rule module exports no logic referencing "alternative"/"clone" together)

### Implementation for User Story 1 & 2

- [X] T017 [P] [US1] Implement the product-reference rule (`productReference(request, config): Evidence[]`) in `packages/shared/src/request-policy/rules.ts`, with static `capability: { canRejectAlone: false }` (per FR-013, only the *combination* with reproduction-intent may reject, not this rule alone)
- [X] T018 [P] [US1] Implement the reproduction-intent rule (`reproductionIntent(request, config): Evidence[]`) in `packages/shared/src/request-policy/rules.ts`, `capability: { canRejectAlone: false }` — **CORRECTED after manual UI testing (T045 verification)**: `bareProductRequest`'s regex originally anchored the match to the end of the *entire string*, which meant "Build Facebook" alone rejected correctly but "Build Facebook, with everything" and "Build Facebook. Data sources it can use: none." (exactly what the real client sends once anything is attached in the builder UI) silently ALLOWED — a genuine bypass of FR-013's unilateral-reject case, found only once this rule ran against real composed requests instead of bare fixture strings. Fixed by anchoring the match to a clause boundary (`,`/`.`/`!`/`?`/end-of-string) immediately after the product name instead of true end-of-string. Deliberately NOT widened to a bare prefix match with no end restriction at all: doing so reopens an unresolvable ambiguity between "Build an Uber for doctors" (spec's own worked example, must allow) and "Build Facebook for my team" (arguably a literal clone with an audience clause) — both produce identical surface evidence once the alias may be followed by anything, and this heuristic cannot tell them apart from text alone. That specific case is left as a documented, deliberate limitation (`combinator.test.ts`'s "KNOWN LIMITATION" test) rather than guessed at either direction. See `rules.ts`'s `bareProductRequest` doc comment and `rules.test.ts`'s "clause boundary handling" tests.
- [X] T019 [P] [US2] Implement the differentiation-qualifier rule (`differentiationQualifier(request, config): Evidence[]`) in `packages/shared/src/request-policy/rules.ts` — independent of the two rules above, per FR-008 and plan.md Decisions D1/Q2
- [X] T020 [US1] Implement the combinator's REJECT path in `packages/shared/src/request-policy/combinator.ts`: `productReference` + `reproductionIntent` evidence present and no `differentiationQualifier` evidence → `reject`, with `reason` naming the matched product and phrase (FR-006, FR-013)
- [X] T021 [US2] Implement the combinator's reconciliation in `packages/shared/src/request-policy/combinator.ts`: `differentiationQualifier` evidence present → suppress the reject path regardless of other evidence → `allow` (FR-008)
- [X] T022 [US1] Implement the combinator's default `allow` path (no evidence at all, or evidence that doesn't meet any rule's `canRejectAlone` bar) in `packages/shared/src/request-policy/combinator.ts`, stamping `configVersion` from `PolicyConfig.version` (FR-020)
- [X] T023 [US1] Create `packages/server/src/services/request-policy.service.ts`: thin wrapper calling the shared combinator with the request's `task`, all rules, and `EvaluationMode` — exposes `evaluate(task, mode): PolicyDecision`, plus a reserved, unused `bypass?: { reason: string }` parameter per FR-021 (not wired to any behavior in this phase)
- [X] T024 [US1] Add `confirmationAvailable: z.boolean().default(true)` to `generateScriptSchema` in `packages/server/src/validation/schemas/script.schema.ts` (default per plan.md Decisions D4)
- [X] T025 [US1] Wire `requestPolicyService.evaluate()` into `scriptGenerationService.start()` in `packages/server/src/services/script-generation.service.ts`, before `manifestBuilderService.buildAndPersist()` (line ~445 per plan.md/research.md R1): on `reject`, throw an error the route maps to `422` with the decision body; on `allow`, proceed unchanged
- [X] T026 [US1] Update `scriptsRouter.post("/")` in `packages/server/src/routes/scripts.ts` to catch the reject error and respond `422 { decision: "reject", evidence, reason }` per contracts/generate-script-policy-response.md
- [X] T027 [US1] Integration test in `packages/server/src/routes/scripts.route.test.ts` (or existing route test file): `POST` with `task: "Build Facebook"` → `422`, no script row created; `POST` with `task: "Build a CRM"` → `202`, unchanged behavior (FR-023 non-regression, SC-007)
- [X] T028 [P] [US1] Create `packages/client/src/lib/request-policy-client.ts`: thin wrapper calling the same shared combinator, for client-side fast feedback
- [X] T029 [US1] Implement `policyGateFor(state): ValidationProblem[]` in `packages/client/src/lib/automation-flow.ts`, evaluated at the `describe → connect` transition (per plan.md Decisions D6 / research.md R5), returning a `ValidationProblem` naming the matched evidence when the decision is `reject`
- [X] T030 [US1] Unit tests for `policyGateFor` in `packages/client/src/lib/automation-flow.test.ts`: the same fixture set from `fixtures.ts` produces the same gate result client-side

**Checkpoint**: explicit clones are rejected; category-level and alternative/interop-framed requests are always allowed; nothing else in the pipeline is touched.

---

## Phase 4: User Story 3 — Unnamed feature-match clones offered a transformation (Priority: P2)

**Goal**: a feature-only description matching a cataloged product's signature, with no product name and no reproduction intent, is offered a proposed rewrite rather than silently blocked or silently passed through, when confirmation is available.

**Independent Test**: submit a feature-only description matching a cataloged signature (e.g., "a blue social network with friends, pages, marketplace, messenger, news feed") with `confirmationAvailable: true` and confirm the decision is `transform`, not `reject` or `allow`, with a proposal that substitutes each flagged feature per `featureSubstitutes`.

### Tests for User Story 3

- [X] T031 [P] [US3] Add fixture cases to `fixtures.ts`: a feature-only description matching Facebook's signature, `mode: "confirmation-available"` → `transform`; the identical evidence under `mode: "confirmation-unavailable"` → `reject` (this second case belongs to US4 but is added here since it's the same fixture input)
- [X] T032 [P] [US3] Unit tests for the capability-signature rule in `rules.test.ts`: full signature match produces `matched`/`missing` evidence; partial match produces evidence with a non-empty `missing` array; no cataloged product's signature meets the match threshold → no evidence (uncataloged-product default-allow, FR-015)
- [X] T033 [US3] Unit tests for the combinator's TRANSFORM path in `combinator.test.ts`: `capabilitySignature` evidence alone (no `productReference`, no `reproductionIntent`) under `confirmation-available` mode → `transform`, and this evidence pattern **never** produces `reject` under that mode (FR-013's "capability evidence alone cannot unilaterally reject")
- [X] T034 [US3] Unit tests for `transform.ts` in `transform.test.ts`: given matched features, the proposal's `task` text contains each feature's `featureSubstitutes` mapping and none of the original product-specific feature names; a flagged feature with **no** substitute mapping falls back to the "ask the user directly" / no-guess behavior (FR-009) — assert this is a distinct, testable code path, not a thrown exception

### Implementation for User Story 3

- [X] T035 [US3] Implement the capability-signature rule (`capabilitySignature(request, config): Evidence[]`) in `rules.ts`, `capability: { canRejectAlone: false }` — matches request text against each product's `distinguishingFeatures`, using a documented, fixture-tested match threshold (not a numeric confidence score exposed in the evidence shape — the threshold is internal to the rule, the evidence exposes only `matched`/`missing` lists)
- [X] T036 [US3] Implement the combinator's TRANSFORM path in `combinator.ts`: `capabilitySignature` evidence meeting the rule's threshold, under `confirmation-available` mode → `transform`, calling `transform.ts` to build the proposal
- [X] T037 [US3] Implement `buildProposal(evidence, config): { proposalId, task } | null` in `transform.ts`: assembles a rewritten task from `featureSubstitutes` plus fixed boilerplate ("do not reproduce branding/workflows/proprietary functionality" per spec's example wording); returns `null` when a flagged feature has no substitute mapping (FR-009)
- [X] T038 [US3] When `buildProposal` returns `null`, the combinator falls back to `reject` with an explanation naming the unmappable feature (FR-009's stated fallback), even under `confirmation-available` mode
- [X] T039 [US3] Add `acceptedTransform: z.object({ proposalId: z.string(), task: z.string() }).optional()` to `generateScriptSchema` (plan.md Decisions D3)
- [X] T040 [US3] Extend `request-policy.service.ts` with proposal-tracking: issue and remember a `proposalId` on `transform`, and on a resubmission carrying `acceptedTransform`, verify the `proposalId` matches a proposal this process actually issued — **CORRECTED after initial implementation**: the task description as originally written ("proceeding directly to generation without re-running the policy check") was itself a bug, caught in review. `verifyAcceptedTransform` confirms the proposalId was real and consumes it once (replay protection), but the accepted/edited text is NEVER trusted verbatim — see T041. **CORRECTED again (second review pass)**: `proposalId` generation changed from content-derived/deterministic to `crypto.randomUUID()`-based — determinism had no actual benefit (Article X/FR-018 only requires the *decision* to be reproducible, not the tracking id) and a content-derived id was needlessly enumerable. Also added a `PROPOSAL_TTL_MS` (30 min) expiry and a concurrency test proving single-use holds under two racing accepts. See `transform.test.ts`, `equivalence.test.ts`, and `request-policy.service.test.ts`'s TTL/concurrency tests.
- [X] T041 [US3] Update `scriptGenerationService.start()` to accept `acceptedTransform` and skip straight to manifest-building with the accepted task when present and verified — **CORRECTED**: `start()` now always re-runs `requestPolicyService.evaluate()` on whichever text is in play (freshly submitted or verified-accepted), and only proceeds if that re-evaluation is `allow`. An edited proposal that reintroduces the original violation ("Clone Facebook") is re-rejected, not silently passed through. See `request-policy.service.test.ts`'s "CRITICAL" test.
- [X] T042 [US3] Update `scriptsRouter.post("/")` to respond `200 { decision: "transform", proposal, evidence, reason }` per contracts/generate-script-policy-response.md, and to accept a resubmission with `acceptedTransform`
- [X] T043 [US3] Integration test: `POST` with a feature-only Facebook-matching task, `confirmationAvailable: true` → `200 transform` with a proposal; resubmitting with `acceptedTransform` set to that proposal → `202`, generation proceeds with the substituted task
- [X] T044 [P] [US3] Implement a TRANSFORM-confirmation surface in the client builder flow (new component under `packages/client/src/components/`, composed from `src/components/ui/` per `design.md`): shows `proposal.task`, lets the user confirm-as-is or edit before resubmitting; verified at 375/768/1280px
- [X] T045 [US3] Wire the client's `policyGateFor` / generation-submit flow to handle a `transform` response: hold navigation at `describe`/`plan`, show the confirmation surface, resubmit with `acceptedTransform` on confirm — **DONE**, with one deliberate deviation from the task's literal wording, recorded here rather than left implicit: `automations/new/page.tsx` does NOT call `policyGateFor` for Next-disabling. `policyGateFor` blocks equally on `transform` and `reject` (correct for its own gate-only contract), but wiring that verbatim into the button that triggers the real submission would make Next permanently disabled for exactly the requests this feature needs to reach the confirm surface for — since client and server are equivalence-tested (FR-018) to predict the same outcome, a transform-eligible request would never be submittable. Instead: `evaluateRequestPolicy` is called directly at `describe`/`plan` (its own docstring recommends this for "the full decision"); only `reject` blocks Next early (a true dead end — nothing to confirm, only text to change); `transform` is left to the real submission inside `runBuild`, whose `PolicyInterventionError` (new, `foundry-client.ts` — named "Intervention" rather than "Blocked" since a `transform` isn't a failure, it's the engine asking for confirmation) now renders `PolicyTransformPrompt` and resubmits with `acceptedTransform` on confirm. Also fixed in the same pass: `req()`'s default throw-on-!res.ok would have turned the 422 reject response into an opaque `FoundryApiError`, and `faFallback` would have silently substituted a *fabricated passing build* for both transform and reject (the exact "silent side effect presenting a refusal as success" its own comment warns against) had `PolicyInterventionError` not been added to its rethrow list alongside `at_capacity`/`rate_limited`. Tests: `policy-response.test.ts` (client-layer: 422 parses as a decision not a throw, `PolicyInterventionError` shape, `faFallback` rethrow). No test exercises the full page (no existing test harness for `automations/new/page.tsx`); typecheck + the full client suite (339 tests) are clean.

**Checkpoint**: an unnamed-but-feature-matching request is offered a transformation, shown to the user, and only proceeds on explicit confirmation.

---

## Phase 5: User Story 4 — Unattended requests never receive a silent rewrite (Priority: P2)

**Goal**: the identical evidence that produces `transform` under confirmation-available mode produces `reject` under confirmation-unavailable mode — never an auto-applied rewrite.

**Independent Test**: submit the Phase 4 feature-only request with `confirmationAvailable: false` and confirm the decision is `reject`, carrying the same evidence-based reason `transform` would have used, and that no `proposal` field is present.

### Tests for User Story 4

- [X] T046 [US4] Unit test in `combinator.test.ts`: the exact evidence set that produces `transform` under `confirmation-available` produces `reject` under `confirmation-unavailable`, with an identical `reason` string modulo the proposal-specific sentence (FR-012)
- [X] T047 [US4] Integration test: `POST` with the Phase 4 feature-only task and `confirmationAvailable: false` → `422 reject`, no script row created, response contains no `proposal` field

### Implementation for User Story 4

- [X] T048 [US4] Implement the mode-collapse in `combinator.ts`: any evidence pattern reaching the TRANSFORM branch under `confirmation-unavailable` mode returns `reject` instead, reusing the same `reason`-building logic rather than a second copy of it (FR-012) — this is the one behavior this story adds; T036's TRANSFORM path and T048's collapse should share the evidence-to-reason logic to avoid the two modes' explanations drifting apart
- [X] T049 [US4] Confirm (test, not just code review) that `request-policy.service.ts`'s default (`confirmationAvailable: true`, T024) means an ordinary UI-driven submission is unaffected by this story — only an explicit `confirmationAvailable: false` caller sees the collapse

**Checkpoint**: no path exists where an unattended caller receives a rewritten request it never approved.

---

## Phase 6: User Story 5 — Every decision is explainable from named evidence; original request preserved (Priority: P3)

**Goal**: any decision record — ALLOW, TRANSFORM, or REJECT — states its evidence in named terms, carries the original request text, and stamps the configuration version that produced it.

**Independent Test**: produce one decision of each kind and confirm each record satisfies FR-019/FR-020 without referencing implementation internals.

### Tests for User Story 5

- [X] T050 [P] [US5] Unit test in `combinator.test.ts`: every `PolicyDecision` variant (`allow`/`transform`/`reject`) includes non-empty `originalRequest` and a `configVersion` matching `PolicyConfig.version`
- [X] T051 [P] [US5] Regression test in `config.test.ts`: bump `PolicyConfig.version` when `products`/`featureSubstitutes`/`intentLexicon` content changes — a test that fails if content changes without a version bump (FR-020, D5 note in data-model.md)
- [X] T052 [US5] Equivalence test `packages/shared/src/request-policy/equivalence.test.ts`: for every case in `fixtures.ts`, the server wrapper (`request-policy.service.ts`, called directly) and the client wrapper (`request-policy-client.ts`) produce a byte-identical `PolicyDecision` (FR-018), per V7's established equivalence-test shape (research.md R4)

### Implementation for User Story 5

- [X] T053 [US5] Ensure every combinator branch (T020–T022, T036, T038, T048) populates `evidence`, `reason`, `originalRequest`, `configVersion` — no branch may omit any field (FR-019)
- [X] T054 [US5] Surface `reason` and `evidence` in the client's rejection/transform-declined messaging (extends T029/T044) so a user sees named evidence, not a generic refusal (Story 5, Scenario 1)

**Checkpoint**: every decision this feature produces is fully explainable and auditable without reading source code.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T055 [P] Run `quickstart.md` end-to-end (all four validation sections) and fix any drift between the doc and actual behavior — **PARTIAL**: sections 1/2/3's assertions are covered by the automated test suites that were run (`pnpm test` in shared/server/client, all green); the literal `curl` manual-check commands and section 4's manual builder-UI check were not run against a live server
- [X] T056 [P] Confirm `docs/validation-and-guardrails-roadmap.md`'s V8 status row and §6/§V4 corrections (already written ahead of this task list) still accurately describe what shipped; update the status row from "Spec drafted" to "Implemented" with the commit/branch note, matching the style of V4–V7's entries
- [X] T057 Observability (constitution V/XV): confirm no combinator or service branch silently swallows an unrecognized `EvaluationMode` or malformed `PolicyConfig` — log and fail closed (`reject`) the same way `audit-gate.ts`'s unrecognized-verdict branch does, per plan.md's reuse of that pattern
- [X] T058 Secrets (constitution VIII): confirm no new env var was introduced (none is expected — verify against `.env.example`, no diff needed)
- [X] T059 Workspace scoping (constitution XII): confirm `PolicyConfig` and decision evaluation carry no `workspaceId` and are not stored per-tenant (n/a per plan.md Constitution Check — verify this is still true after implementation, not just at plan time)
- [X] T060 Honest-signal audit (constitution X): confirm no code, log line, or UI copy anywhere in this feature presents a `PolicyDecision` as a correctness or safety judgment about the *generated code* — it is a policy decision about the *request*, and must not be conflated with the audit's plausibility check (V5)
- [ ] T061 UI conformance (design.md §3): verify the Phase 4 confirmation surface at 375/768/1280px, using tokens not raw hex, composed from `src/components/ui/` — **NOT DONE**: no browser available in this session to verify breakpoints; `PolicyTransformPrompt.tsx` composes from `Modal`/`Button` (tokens throughout, no raw hex) and typechecks, but visual/breakpoint verification per this project's own CLAUDE.md guidance ("if you can't test the UI, say so explicitly") is an explicit gap, not a silent pass
- [X] T062 [P] Delete/simplify pass: after all stories are green, look for wiring that tests exercise but nothing calls (V3/V6's own deletion-pass precedent) — in particular confirm `bypass` (T023, FR-021) is truly unused end-to-end, not silently invoked anywhere
- [ ] T063 Run `/speckit-comply` and resolve CRITICAL findings before considering this feature complete — **NOT DONE YET**, recommended as the immediate next step

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — BLOCKS every user story
- **Phase 3 (US1+US2)**: depends on Foundational — this is the MVP; ships together per the note above
- **Phase 4 (US3)**: depends on Phase 3 (reuses the combinator's evidence-handling and the service/route wiring Phase 3 established)
- **Phase 5 (US4)**: depends on Phase 4 (the mode-collapse only makes sense once TRANSFORM exists)
- **Phase 6 (US5)**: depends on Phase 3 at minimum (decision-record shape applies to every branch built by then); best done last so every branch exists to test
- **Polish (Phase 7)**: depends on all prior phases

### Parallel Opportunities

- T004–T006 (type definitions) in parallel; T007 depends on T006's types existing
- T012–T014 (per-rule unit tests) in parallel; T017–T019 (per-rule implementations) in parallel once their tests exist
- T028 (client wrapper) can proceed in parallel with T023 (server wrapper) — both consume the same shared combinator
- T050–T051 in parallel

---

## Parallel Example: Phase 3 (US1 & US2)

```bash
# Rule unit tests, together:
Task: "Unit tests for the product-reference rule in rules.test.ts"
Task: "Unit tests for the reproduction-intent rule in rules.test.ts"
Task: "Unit tests for the differentiation-qualifier rule in rules.test.ts"

# Rule implementations, together, once tests exist:
Task: "Implement the product-reference rule in rules.ts"
Task: "Implement the reproduction-intent rule in rules.ts"
Task: "Implement the differentiation-qualifier rule in rules.ts"
```

---

## Implementation Strategy

### MVP First

Phase 1 → Phase 2 → Phase 3 (US1+US2). **Stop and validate**: explicit clones
reject, category/alternative requests always allow, nothing else in the
generation pipeline changed (T027's `202` case). This alone is deployable and
matches the spec's stated priority — it is the whole reason this feature
exists, and it introduces zero new false positives against today's behavior.

### Incremental Delivery

1. Phase 1+2 → Phase 3 → validate → this is the MVP.
2. Add Phase 4 (US3, transformation) → validate → richer UX for unnamed clones.
3. Add Phase 5 (US4, mode-awareness) → validate → safe for unattended callers.
4. Add Phase 6 (US5, explainability) → validate → auditable end-to-end.
5. Phase 7 polish, then `/speckit-comply`.

---

## Notes

- No task in this list adds an LLM call anywhere in Phases 1–6 — this is
  deliberate (spec Out of Scope) and should not be "improved" during
  implementation.
- Commit after each phase's checkpoint, not after each task, per this
  project's established slice-sized-commit convention on this branch.
- T023's `bypass` parameter (FR-021) must remain genuinely unused end-to-end
  through every phase — T062 exists specifically to catch it if implementation
  drifts into wiring it "just in case."

## Backfilled 2026-08-12 from working tree

A pre-merge senior-engineering audit (independent of the phases above) found
five issues in the already-`[X]`-complete implementation and fixed them
directly; this section regularizes that work per constitution Article I. None
of it changes the engine's architecture (Evidence → Rules → Combinator →
Decision → Transform is unchanged) — it closes a test gap, a config-authoring
gap, a wire-format gap, and one inaccurate task claim.

- [X] T064 [BACKFILL] Move `rules.ts`'s module-local `BARE_BUILD_VERBS` array
  into `config.ts` as a new `intentLexicon.bareBuildVerbs` field, so it falls
  under `config.test.ts`'s FR-020 version-bump discipline instead of being a
  second, unsynced intent vocabulary alongside `intentLexicon.reproduction`.
  `rules.ts`'s `bareProductRequest()` now takes the verb list as a parameter
  (sourced from `config.intentLexicon.bareBuildVerbs`) and escapes each verb
  via `escapeRegExp`, since the list is now editable config data rather than
  a hardcoded-safe literal. `config.test.ts`'s version-discipline snapshot
  extended with `expect(policyConfig.intentLexicon.bareBuildVerbs.length).toBe(7)`.
  Files: `packages/shared/src/request-policy/config.ts`,
  `packages/shared/src/request-policy/rules.ts`,
  `packages/shared/src/request-policy/config.test.ts`.
- [X] T065 [BACKFILL] Correct `evidence.ts`'s `RuleCapability` doc comment,
  which claimed the combinator reads `.canRejectAlone` to dispatch instead of
  hardcoding rule identity (T007/FR-007's original intent) — the combinator
  never did this (see T015's correction above). The comment now states plainly
  that `canRejectAlone` is declared per-rule metadata for a possible future
  generic-dispatch combinator, not yet consulted by the current one. No
  behavior change; rewiring `decide()` to actually dispatch off this field was
  considered and rejected as unnecessary risk this close to merge — the
  current explicit per-evidence-kind logic in `decide()` is already the
  security-relevant code path and is already fully tested.
  File: `packages/shared/src/request-policy/evidence.ts`.
- [X] T066 [BACKFILL] Add `configVersion` to the HTTP response bodies for both
  the `transform` (`200`) and `reject` (`422`) branches of
  `POST /:workspaceId/scripts` (previously present on the internal
  `PolicyDecision` object per T022/T053, but dropped when the route hand-built
  the response body) — closes a traceability gap where FR-020's
  "a decision is traceable to the dataset version that produced it" guarantee
  was true inside `@foundry/shared` but silently lost at the HTTP boundary.
  `FAGeneratePolicyResponse` (client) extended to require `configVersion`; the
  client's local reconstruction of a `PolicyDecision` in
  `automations/new/page.tsx` (which previously fabricated `configVersion: ""`
  to satisfy the type, since the server never sent a real value) now uses
  `e.decision.configVersion` from the real server response.
  `contracts/generate-script-policy-response.md` updated in the same pass —
  see below — so contract and implementation agree (T067 does not add new
  behavior, it documents this one).
  Files: `packages/server/src/routes/scripts.ts`,
  `packages/client/src/lib/foundry-client.ts`,
  `packages/client/src/app/(app)/automations/new/page.tsx`,
  `packages/client/src/lib/policy-response.test.ts` (fixtures extended with
  `configVersion` to match the corrected contract).
- [X] T067 [BACKFILL] Update `contracts/generate-script-policy-response.md`'s
  TRANSFORM and REJECT response examples to include `configVersion`, per T066.
  This is a contract correction, not a new contract: the field already existed
  on the internal `PolicyDecision` (T022/FR-020) and the original contract
  simply never carried it through to the wire format it documents.
  File: `specs/20260806-081433-request-policy-engine/contracts/generate-script-policy-response.md`.
- [X] T068 [BACKFILL] Add production-wiring tests for the policy gate inside
  the REAL, unmocked `scriptGenerationService.start()` — closes the gap where
  T043's "integration test" exercised the route with `scriptGenerationService.
  start` mocked (`scripts-policy.route.test.ts`) and `request-policy.service.
  test.ts` called `requestPolicyService.evaluate()` directly, so neither would
  fail if the `evaluate()` call were deleted from `start()` itself. Added four
  tests to `prompt-persisted.test.ts` (same mock boundary as its existing
  FR-006 suite — only DB/Tether/secrets mocked, `requestPolicyService` and
  `@foundry/shared`'s `evaluatePolicy` real): a reject decision returns before
  anything is built/submitted; a transform decision likewise; editing an
  accepted proposal back into the original violation is re-evaluated and
  rejected, not trusted; accepting the proposed substitute text re-evaluates
  to allow and reaches generation. **Verified adversarially**: temporarily
  deleted the `requestPolicyService.evaluate()` call and its `if (decision.
  decision !== "allow") return {kind: "policy", decision}` branch from
  `script-generation.service.ts`'s `start()`; all four new tests failed; the
  file was restored and confirmed identical via `git diff --stat` before
  re-verifying green.
  File: `packages/server/src/services/prompt-persisted.test.ts`.
- [X] T069 [BACKFILL] Record the trigger/policy-timing decision surfaced by
  the same audit — see spec.md's new FR-024 and Clarifications Q4 — as a
  spec-level answer rather than only a source comment: policy is evaluated
  once, at generation time; a later change to `policyConfig` is not
  retroactively applied to scripts already generated or triggers already
  armed. No code changed for this task — it is a documentation-only
  regularization of already-existing, already-correct behavior in
  `trigger.service.ts`/`trigger-scheduler.ts` (neither calls
  `requestPolicyService`, confirmed by the same audit).
  File: `specs/20260806-081433-request-policy-engine/spec.md`.

Coverage: T064–T069 close every finding from the pre-merge audit that required
a source change or a durable documentation answer. No engine architecture
change, no new dependency, no new abstraction — consistent with this feature's
existing Simplicity posture (constitution Article IV).
