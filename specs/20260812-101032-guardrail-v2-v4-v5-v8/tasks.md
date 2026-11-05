# Tasks: Guardrail Port — V2/V4/V5/V8 (krt/guardrail_validation → v1-alpha)

**Input**: plan.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: colocated `*.test.ts`, Vitest — written alongside each implementation task (Article II),
matching the prior feature's discipline.

## Phase 1: Setup

- [x] T001 Create `packages/shared/src/request-policy/` directory; add its export to
      `packages/shared/src/index.ts`
- [x] T002 [P] Add `MCP_BRIDGE_API_KEY=` (placeholder only) to a new
      `packages/mcp-bridge/.env.example` and to the root `.env.example`'s mcp-bridge section
- [x] T003 [P] Create `packages/server/src/prompt-boundary/` directory (no files yet — populated in Phase 4)

## Phase 2: Foundational

*No cross-story blocking work — US1 (mcp-bridge), US2 (prompt-boundary), US4 (request-policy) and US3
(documentation) touch disjoint files and packages, confirmed in plan.md's Project Structure. Proceed
directly to per-story phases.*

## Phase 3 (US1, P1): mcp-bridge is not an open door

**Goal**: every mcp-bridge request requires a valid credential; `/health` stays open; the check fails
closed.

- [x] T004 [P] [US1] Write `packages/mcp-bridge/src/auth.test.ts` — asserts: no header → 401; wrong
      key → 401; correct key → next() called; `MCP_BRIDGE_API_KEY` unset → 500 (fail closed, FR-002);
      failure is logged without echoing the presented value
- [x] T005 [US1] Implement `packages/mcp-bridge/src/auth.ts`'s `requireApiKey` middleware to satisfy
      T004
- [x] T006 [US1] Wire `requireApiKey` into `packages/mcp-bridge/src/index.ts` — mounted before the
      `/mcp` route only; `/health` stays unauthenticated (FR-001)
- [x] T007 [US1] Update `infra/docker-compose.yml`'s `mcp-bridge:` service to pass
      `MCP_BRIDGE_API_KEY` through `environment:`/`env_file`, matching how other services receive
      their keys

**Checkpoint**: `curl -X POST :4003/mcp` with no key → 401; with the configured key → identical
response to pre-feature behavior (SC-001).

## Phase 4 (US2, P1): third-party workspace content cannot pose as an instruction

**Goal**: manifest content is wrapped in an explicit provenance declaration where it enters a
generation prompt; injection-pattern matches produce non-blocking, non-mutating warnings.

- [x] T008 [P] [US2] Port `packages/server/src/prompt-boundary/normalize.ts` +
      `normalize.test.ts` from `origin/krt/guardrail_validation`'s
      `foundry/packages/server/src/prompt-boundary/{normalize.ts,normalize.test.ts}`, unchanged
- [x] T009 [P] [US2] Port `packages/server/src/prompt-boundary/patterns.ts` + `patterns.test.ts`,
      unchanged (depends on T008's `normalizeForMatching`)
- [x] T010 [P] [US2] Port `packages/server/src/prompt-boundary/envelope.ts` + `envelope.test.ts`,
      unchanged
- [x] T011 [US2] Port `packages/server/src/prompt-boundary/spans.ts` + `spans.test.ts`, adapting
      `SPAN_FIELDS`/`InventoryTool`/`InventoryEntity` to v1-alpha's actual `tool.repo.ts` /
      `schema-introspector.service.ts` column names (v1-alpha has no `isDummy`/`dummyResponseTemplate`
      — omit those two fields; keep every other field named in research.md Decision 3)
- [x] T012 [US2] Port `packages/server/src/prompt-boundary/detect.ts` + `detect.test.ts`, unchanged
      (depends on T009, T011)
- [x] T013 [US2] Extend `packages/server/src/services/manifest-builder.service.test.ts`: assert
      `buildAndPersist()`'s new `warnings` field surfaces a planted injection pattern, AND assert
      `manifestXml`/`summaryXml`/`hash` are byte-identical between detection-triggering and ordinary
      content (SC-003's non-mutation invariant)
      — no such test file existed; created it following the same
      `vi.mock(...repositories...)` pattern as `manifest-fingerprint.test.ts`, and mocked
      `detectInjection` directly so the byte-identity assertion isolates the one property that
      matters (manifestXml/hash independent of whatever the detector returns).
- [x] T014 [US2] Implement: `manifest-builder.service.ts`'s `buildAndPersist()` calls
      `detectInjection(spansFromInventory(...))` over the same tools/datasources/entities already
      assembled, adds `warnings` to its return value, and does NOT feed it into `hashBody` (satisfies T013)
- [x] T015 [US2] Extend `packages/server/src/services/flow-generation.service.test.ts`: assert
      `buildDraftPrompt`'s output contains `PROVENANCE_DECLARATION` and the manifest text is wrapped
      in `UNTRUSTED_OPEN`/`UNTRUSTED_CLOSE`
      — the real file is `flow-generation.test.ts` (no `.service` in the name); extended that.
- [x] T016 [US2] Implement: `flow-generation.service.ts`'s `buildDraftPrompt` wraps `opts.manifestXml`
      per research.md Decision 3 (satisfies T015)

**Checkpoint**: a tool with an instruction-shaped description produces a warning naming the pattern
and an unchanged manifest; an ordinary tool produces no warning (SC-002, SC-003).

## Phase 5 (US4, P1): a clone request is caught before generation starts

**Goal**: `allow`/`transform`/`reject` evaluated on goal/outline text (`runGeneration`) and chat-edit
text (`flowChatService.turn()`), before any manifest build or inference call; `transform` requires
confirmation; `reject` is a genuine terminal 200.

- [x] T017 [P] [US4] Port `packages/shared/src/request-policy/evidence.ts` (types only, no test file
      needed) from `origin/krt/guardrail_validation`'s
      `foundry/packages/shared/src/request-policy/evidence.ts`, unchanged
      — also ported `fixtures.ts`, a test-only dependency of `combinator.test.ts` that tasks.md
      did not list but the source branch's suite requires.
- [x] T018 [P] [US4] Port `packages/shared/src/request-policy/config.ts` + `config.test.ts`, unchanged
      (depends on T017)
- [x] T019 [US4] Port `packages/shared/src/request-policy/rules.ts` + `rules.test.ts`, unchanged
      (depends on T017, T018)
- [x] T020 [US4] Port `packages/shared/src/request-policy/transform.ts` + `transform.test.ts`,
      unchanged (depends on T017, T018)
- [x] T021 [US4] Port `packages/shared/src/request-policy/combinator.ts` + `combinator.test.ts`,
      unchanged (depends on T019, T020) — this is the module SC-006's differentiation-qualifier test
      lives in
- [x] T022 [US4] Export `evaluatePolicy`, `policyConfig`, and the `Evidence`/`PolicyDecision`/
      `EvaluationMode` types from `packages/shared/src/request-policy/index.ts` and
      `packages/shared/src/index.ts`
- [x] T023 [P] [US4] Port `packages/server/src/services/request-policy.service.ts` +
      `request-policy.service.test.ts` from `origin/krt/guardrail_validation`'s
      `foundry/packages/server/src/services/request-policy.service.ts`, unchanged (depends on T022)
- [x] T024 [US4] Extend `packages/server/src/services/flow-generation-job.service.test.ts`: assert a
      goal naming a cataloged product with reproduction intent returns `status: "policy_reject"`
      before `draftFlow`/`manifestBuilderService.buildAndPersist`/the inference client are ever
      invoked (spy call-count 0, per contracts/generation-outcome-contracts.md's SC-004 invariant);
      assert a differentiation-qualifier goal ("Uber for doctors") returns a normal draft, not a
      policy field; assert canvas mode (`input.authored`) never evaluates the policy
      — no such test file existed; created it mocking every downstream dependency
      (`flow-generation.service.js`, `manifest-builder.service.js`, `inference.service.js`,
      `flow.service.js`, `trigger.service.js`, repos) so the zero-call-count assertions are real.
      ⚠ Found in the process: quickstart.md's own capability-signature example ("...a workspace
      concept for teams") ends in "for teams", which matches the vertical-differentiation pattern
      and gets suppressed to `allow` rather than `policy_transform` — flagged for T032/T033, not
      fixed here (unchanged port, per research.md Decision 5).
- [x] T025 [US4] Implement: `flow-generation-job.service.ts`'s `runGeneration()` evaluates
      `requestPolicyService.evaluate()` on `input.goal`/`input.outline` before calling
      `draftFlow`/`authorFlow` (skipped for `authored`); adds `policy_reject`/`policy_transform`
      `GenerationOutcome` variants; handles `input.acceptedProposal` via `verifyAcceptedTransform`
      (satisfies T024, FR-007, FR-008, FR-009, FR-010)
      — also added `acceptedProposal` to `startGenerationSchema` and doc-comments on both
      `status` columns (`flow_generation_jobs`, `flow_chat_turns`) naming the two new values.
- [x] T026 [US4] Extend `packages/server/src/services/flow-chat.service.test.ts`: the equivalent
      assertions for `turn()` against `parsed.message`, confirming `runTurn`/inference is never
      invoked for a `reject`/`transform` decision
      — no such test file existed; created it mocking the repository layer
      (`flow-chat.repo.js`, `flow.repo.js`, `tool.repo.js`, `datasource-query.repo.js`,
      `inference.service.js`).
- [x] T027 [US4] Implement: `flow-chat.service.ts`'s `turn()` evaluates the policy on `parsed.message`
      before calling `runTurn()`; `TurnOutcome` gains the equivalent two variants (satisfies T026)
      — implemented via the turn's `status`/`findingsJson` fields (matching the existing
      `insufficient_contract`/`too_structural` precedent) rather than a new field on the
      `TurnOutcome` TypeScript type, which is just `{turn, flowId, diff?}` reading through to the row.
- [x] T028 [P] [US4] Confirm (add a passthrough test if missing) that
      `packages/server/src/routes/flows.ts` and `packages/server/src/routes/flow-chat.ts` forward the
      new outcome variants unchanged — no route-level filtering that would drop `policy_reject`/
      `policy_transform` before it reaches the client
      — added `packages/server/src/routes/flows-outcome-passthrough.test.ts` (source-scan style,
      matching `flow-chat-imports.test.ts`'s precedent).

**Checkpoint**: `pnpm --filter @foundry/server kestra:refusal`-style manual runs from quickstart.md's
US4 section behave as documented; SC-004/SC-005/SC-006/SC-007 all hold.

## Phase 6 (US3, P3): the V5 finding is recorded, not rediscovered

- [x] T029 [US3] Add a `CLAUDE.md` note under this feature's future section (or a durable pointer in
      this feature's own spec/plan, cross-linked) recording: `flow-expectation.service.ts`'s
      `unevaluable`-never-satisfies-the-gate discipline + `trigger.service.ts`'s
      `flowEnableReadiness()` together already satisfy V5's asymmetric-gate rule; cite the
      hardcoded-period/0-of-11 incident both defend against; state explicitly that no code was added
      — added as "The guardrail infrastructure port, continued — V2/V4/V5/V8" in CLAUDE.md, which
      also covers V2/V4/V8 (T033's scope) since they were written together for coherence.

## Phase 7: Polish & Cross-Cutting

- [x] T030 [P] Run `pnpm -r typecheck` and `pnpm -r test` (full regression, SC-007) — fix any
      incidental break, do not suppress
      — `pnpm -r typecheck`: all 7 packages clean. `pnpm --filter @foundry/server` (the package this
      feature actually touched) run directly: 59/76 files pass, the SAME 17 pre-existing failures
      CLAUDE.md already documents ("column slug does not exist" migration lag — confirmed
      file-for-file identical to the documented list, none of them in a file this feature added or
      touched). `pnpm -r test` (the literal command) stops at `packages/client` with exit 1 — but its
      own output shows **351/351 tests pass**; the exit code is the documented jsdom/undici teardown
      quirk ("Vitest treats the unhandled teardown error as a process failure regardless"), not a
      real failure, and it is unrelated to this feature (no client changes). No incidental breaks
      found; nothing suppressed.
- [x] T031 [P] Run `pnpm --filter @foundry/mcp-bridge test`, `pnpm --filter @foundry/shared test`,
      `pnpm --filter @foundry/server test` individually and confirm the new suites pass
      — mcp-bridge: 5/5. shared: 68/68 (8 files, incl. the 5 request-policy suites). server: all new
      suites pass (prompt-boundary's 5 files/154 tests, manifest-builder.service.test.ts,
      flow-generation.test.ts's extension, flow-generation-job.service.test.ts,
      flow-chat.service.test.ts, request-policy.service.test.ts, flows-outcome-passthrough.test.ts).
- [x] T032 Live verification per `quickstart.md`'s manual sections (mcp-bridge curl checks, planted
      injection string, the four request-policy curl scenarios) against a running dev stack
      — the full docker-compose stack (server :4000, kestra) was not standable in this session (the
      local Foundry Postgres is behind on migrations — the same pre-existing "column slug does not
      exist" gap T030 found — and only `foundry-parent-postgres`/`foundry-parent-redis` were running,
      not `server`/`kestra`/`mcp-bridge` containers). Verified everything that does not require the
      full stack, against REAL running/compiled code rather than mocks:
      - mcp-bridge (US1): ran `packages/mcp-bridge/src/index.ts` standalone via `tsx` on a scratch
        port, live `curl`: no key → 401, wrong key → 401, correct key → 200, `MCP_BRIDGE_API_KEY`
        unset → 500 (fail closed), `/health` → 200 unauthenticated. All five match quickstart.md
        exactly.
      - injection warning (US2): built `packages/server` (`tsc`), ran the planted-description example
        from quickstart.md step 1 directly against the compiled `detectInjection(spansFromInventory(...))` —
        returned both `instruction_override` and `exfiltration_directive`, excerpt quoting the raw
        description verbatim, `truncated: false`.
      - request policy (US4): built `packages/shared`, ran `evaluatePolicy` against quickstart.md's
        three example goals directly — `"Build me a clone of Slack"` → `reject` with the documented
        reason; `"Build an Uber for doctors — dispatch on-call physicians to house calls"` → `allow`;
        `"Build a tool with channels, threads, and a workspace"` (quickstart's own example minus the
        trailing "for teams" — see the T024 finding above) → `transform` with a proposal. Confirms the
        quirk found during T024 is real and reproducible outside the test suite, not a test artifact.
      - NOT verified live (needs the full stack): the `/api/workspaces/<ws>/flows/generate` HTTP
        route itself, the `acceptedProposal` HTTP resubmission round-trip, and the flow-chat HTTP
        route. All three are covered by T013/T024/T026/T028's mocked-dependency unit tests instead,
        which exercise the identical code path (`runGeneration`/`flowChatService.turn`/the route
        handlers) minus the HTTP transport and the database.
- [x] T033 Update `CLAUDE.md`'s "guardrail infrastructure port" section (or add a sibling section for
      this feature) documenting where V2(mcp-bridge)/V4/V8 landed and V5's documentation-only outcome,
      matching the prior feature's doc-currency discipline (Article VII)
      — done together with T029 (see its note): "The guardrail infrastructure port, continued —
      V2/V4/V5/V8" in `CLAUDE.md`, covering all four, including the T024/T032 quickstart-example
      quirk finding so it doesn't get rediscovered.

## Dependencies & execution order

- Phase 1 (Setup) before everything.
- Phases 3, 4, 5 are mutually independent (disjoint files/packages, confirmed in plan.md) — may run
  in any order or in parallel once Phase 1 is done.
- Within Phase 5: T017 → {T018} → {T019, T020} → T021 → T022 → T023 → T024 → T025 → T026 → T027 → T028
  (each step depends on the ones before it producing a real export to import).
- Within Phase 4: T008 → T009 → {T010, T011} → T012 → T013 → T014 → T015 → T016.
- Phase 6 has no code dependency on Phases 3–5 and may run any time after Phase 1.
- Phase 7 last, after all of Phases 3–6.

## Parallel execution examples

```text
# After Phase 1:
T004 [P] (mcp-bridge test)  ‖  T008 [P] (normalize)  ‖  T017 [P] (evidence types)
# all touch different packages/files — no conflict.
```

## Implementation strategy

**MVP** = Phase 3 alone (US1, mcp-bridge auth) — smallest, fully independent, closes a real
unauthenticated-port exposure with no dependency on the other two build-out phases. Phases 4 and 5 are
each independently shippable after that. Phase 6 is a documentation-only checkpoint that can land
anytime. Recommended order given priority tags (all P1 except US3): 3 → 4 → 5 → 6 → 7, but any
ordering of 3/4/5 is valid since they do not share files.
