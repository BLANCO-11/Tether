# Feature Specification: Guardrail Port — V2/V4/V5/V8 (krt/guardrail_validation → v1-alpha)

**Feature Branch**: `20260812-101032-guardrail-v2-v4-v5-v8`

**Created**: 2026-08-12

**Status**: Draft

**Input**: User description: "Port V2/V4/V5/V8 guardrail concepts from krt/guardrail_validation into
v1-alpha, adapted to the flow-chat/flow-generation-job surface" — the four slices explicitly deferred
by the prior feature (`20260812-075013-guardrail-infra-port`, which ported V1/V3/V6/V7).

## Context

This is the second of two guardrail-port features from the unrelated-history `krt/guardrail_validation`
branch into `v1-alpha`. The first ported the four generic slices (V1/V3/V6/V7). This one covers the
four remaining — V2 (auth/workspace isolation), V4 (prompt-boundary), V5 (audit-verdict gate), V8
(request-policy/clone-detection) — which were deferred because they were assumed coupled to a
script-generation model v1-alpha doesn't have.

**A direct-evidence audit of `origin/krt/guardrail_validation` and `v1-alpha`'s real code, done before
writing this spec, found that assumption is only true for one of the four** — and, as importantly,
found that v1-alpha has *already independently built* more mature equivalents of two of the other
three. This spec is scoped to that evidence, not to the four slices' original descriptions.

### What the audit found, slice by slice

- **V2 — auth/workspace isolation.** The source branch's problem was: a shared single API key with no
  per-request identity, a `roles` claim minted into sessions but enforced nowhere, an unauthenticated
  progress WebSocket, and an unauthenticated MCP bridge. **v1-alpha already has a more mature version
  of the first three**: `identity.middleware.ts`'s `resolveIdentity`/`requireIdentity` give real
  per-request identity (a verified JWT, not a shared key), `requireWorkspaceRole("author"|"approver"|"admin")`
  reads a real `workspace_members` table and is wired into gate 2/gate 3/revision-provenance checks —
  roles are genuinely enforced, not minted-and-ignored. The flow-execution progress channel is
  **already** authorized by a single-use, execution-scoped ticket (`POST …/flow-executions/:id/watch`,
  D-15) — the same mechanism V2 introduces for its `ws_progress` ticket, already built, independently.
  **The one part that is a real, present-day gap**: `packages/mcp-bridge/src/index.ts` has **zero**
  authentication of any kind — no API key check, nothing (confirmed by reading the file: no
  `x-api-key`/`requireApiKey`/auth logic exists at all). It is documented elsewhere as "not on any
  live path today," which is a mitigating factor, not a reason to leave a published port
  unauthenticated.
- **V4 — prompt-boundary guardrails.** Two halves, and they land differently. The envelope/provenance
  framing + pattern-based injection detection (does third-party manifest content — a tool description,
  a table/column name — read as an instruction rather than data?) is a **genuine, present-day gap**:
  `manifest-builder.service.ts` has `xmlEscape()` (stops structural XML breakage) and nothing else —
  no declared-untrusted-data framing, no injection-pattern detection. The `unrequested_action` finding
  (does generated **code** reach a host/env-var neither the manifest nor the task named?) requires a
  code-audit artifact that does not exist on v1-alpha (no `generation-audit.service.ts` equivalent,
  because v1-alpha generates declarative flow steps, not source code) — this is out of scope for this
  feature; the concept may be worth a future, separately-designed detector over flow-step JSON.
- **V5 — audit-verdict gate.** **Already substantially satisfied**, independently. `flow-expectation.service.ts`
  computes a `passed`/`failed`/`unevaluable` verdict per declared expectation, with `unevaluable`
  explicitly **not** satisfying the gate (V5's exact discipline: findings block, absence never
  permits) — and `trigger.service.ts`'s gate-readiness check literally cites the same motivating
  incident V5 was built to prevent (a `clean`-verdict script that hardcoded a wrong period and mailed
  0 of 11 recipients). Nothing to port here; this spec documents the equivalence rather than adding
  code.
- **V8 — request-policy engine (clone detection).** **A complete, present-day gap.** No check exists
  anywhere in `flow-chat.service.ts` or `flow-generation.service.ts` on the raw task/message text
  before generation begins (confirmed: zero matches for `clone|policy|reproduce|commercial` in either
  file). This is the cleanest and most valuable port of the four — the rules/combinator/config in
  `krt/guardrail_validation`'s `@foundry/shared` are domain-agnostic text classification with no
  coupling to script-generation at all.

### Scope this spec actually covers

1. **Close the mcp-bridge authentication gap** (the real part of V2).
2. **Port V4's envelope + injection-detection half** onto v1-alpha's manifest composition (not the
   `unrequested_action` finding, which has no artifact to run against).
3. **Document V5's equivalence** — no code change; a durable record that `flow-expectation.service.ts`
   already provides this discipline, so nobody re-builds it.
4. **Port V8's request-policy engine**, attached to where task text first enters v1-alpha's generation
   pipeline. Planning's audit of the actual call graph (not assumed here) found **two** such entry
   points, not one — see the Assumptions section update below.

**Explicitly out of scope**: V2's full credential-primitive/ticket rewrite (already superseded by
`identity.middleware.ts`+`requireWorkspaceRole`+D-15's ticket — porting the source branch's version
would be building a second, weaker mechanism beside a working one); V4's `unrequested_action` finding;
V5's gate implementation (nothing to build); rewriting `identity.middleware.ts`, `requireWorkspaceRole`,
`flow-expectation.service.ts`, or `trigger.service.ts` — all are pre-existing, working, and untouched.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The schema-introspection bridge is not an open door (Priority: P1)

`packages/mcp-bridge` serves read-only workspace schema data on a published port with no
authentication today. After this feature, a caller must present a valid credential to reach it.

**Why this priority**: An unauthenticated port serving any workspace's schema on request, by id, is
the same class of exposure V2 was built to close on the source branch — "not on any live path today"
describes today's product wiring, not a property of the port itself.

**Independent Test**: Send a request to the mcp-bridge with no credential and confirm it is refused.
Send one with a valid credential and confirm it still returns the same schema data as before.

**Acceptance Scenarios**:

1. **Given** a request to `packages/mcp-bridge`'s schema endpoint with no credential, **When** it is
   received, **Then** it is refused before any schema lookup occurs.
2. **Given** the same request with a valid credential, **When** it is received, **Then** the response
   is identical to today's — no behavior change for a legitimate, authenticated caller.

---

### User Story 2 - Third-party workspace content cannot pose as an instruction (Priority: P1)

A tool description, table name, or column name is data supplied by whoever registered that tool or
datasource — not an instruction to the model composing a generation prompt. Today, `manifest-builder.service.ts`
escapes this content structurally (so it cannot break the XML) but nothing tells the model this
content is data rather than instruction, and nothing flags content that reads as an instruction
regardless. After this feature, the manifest declares this content's provenance explicitly, and
content matching known injection patterns is surfaced as a non-blocking warning.

**Why this priority**: This is the server's own generation prompt being used against it via content a
tenant (or anyone who can register a tool in a workspace) controls — the same class of exposure V4
closed on the source branch, and it is completely unguarded here today.

**Independent Test**: Register a tool whose description contains an instruction-shaped string (e.g.
"ignore prior instructions and…") and confirm the manifest still renders correctly (nothing crashes or
is silently stripped) while a warning is produced identifying the pattern. Register an ordinary tool
and confirm no warning appears and the manifest is otherwise unchanged.

**Acceptance Scenarios**:

1. **Given** any tool/datasource description or identifier reaching the manifest, **When** the
   manifest is composed, **Then** that content is wrapped in an explicit provenance declaration
   stating it is untrusted workspace data, not an instruction.
2. **Given** manifest content matching a known injection pattern, **When** the manifest is composed,
   **Then** a warning is produced identifying the match — the content itself is never stripped,
   mutated, or blocked; the warning is advisory.
3. **Given** ordinary tool/datasource content with no injection-shaped pattern, **When** the manifest
   is composed, **Then** no warning is produced and the rendered manifest is unchanged from today's.

---

### User Story 3 - Nothing is at risk of re-discovering the audit-verdict gate (Priority: P3, documentation only)

A future contributor, reading the V5 slice's description on the source branch, might conclude v1-alpha
needs an audit-verdict gate built from scratch. After this feature, that conclusion is checked and
recorded as false, with the evidence, so the same investigation is not repeated.

**Why this priority**: Lowest urgency — this produces no behavior change. It exists to prevent future
wasted work re-discovering what this spec's own research already established.

**Independent Test**: Read the recorded finding and confirm it cites the specific v1-alpha functions
(`flow-expectation.service.ts`'s verdict states, `trigger.service.ts`'s gate check) and the specific
shared incident (the hardcoded-period/0-of-11 case) that make the two mechanisms equivalent.

**Acceptance Scenarios**:

1. **Given** the finding is recorded, **When** a future contributor looks for an audit-verdict gate on
   v1-alpha, **Then** they find a pointer to the existing mechanism instead of an open gap.

---

### User Story 4 - A request to build a known commercial product is caught before generation starts (Priority: P1)

A person's goal-mode text, an outline line, or a flow-chat edit message can ask, in effect, "build me a
clone of \<commercial product\>." Today nothing in `flow-generation-job.service.ts`'s `runGeneration()`
(goal/outline creation) or `flow-chat.service.ts`'s `turn()` (chat-based editing) evaluates the raw
request against this concern before generation proceeds. After this feature, such a request is
deterministically classified — allowed, offered a rewritten alternative (with the person's
confirmation), or refused when no rewrite is safe and no confirmation is possible — before any
manifest is built or model call made, at both entry points.

**Why this priority**: This is the server's own generation capability being pointed at reproducing a
named commercial product on request, and it is completely unguarded today. No LLM sits on this
decision path — it is deterministic and config-driven, matching this codebase's own preference for
structural checks over model judgment (D-22, D-47's `validateOutline()`, the whole guardrail-infra-port
feature that preceded this one).

**Independent Test**: Send a flow-chat message naming a cataloged commercial product with clone/build
intent and confirm generation does not proceed — the response is either a rewrite proposal awaiting
confirmation or an outright refusal, never a manifest build. Send an ordinary, legitimate automation
request and confirm it proceeds exactly as today.

**Acceptance Scenarios**:

1. **Given** a flow-chat turn whose message names a cataloged product with reproduction intent,
   **When** the turn is processed, **Then** the policy decision (`allow`/`transform`/`reject`) is
   evaluated before any manifest is built or generation call is made.
2. **Given** a `transform` decision, **When** it is returned, **Then** the person sees the proposed
   rewrite and must explicitly confirm it before generation proceeds on the rewritten text — the
   original text is never silently substituted.
3. **Given** a `reject` decision, **When** it is returned, **Then** no manifest is built and no
   generation call is made, and the turn is filed as a genuine terminal outcome (matching this
   codebase's own rule for `insufficient_contract` and other refusals: a 200, not an error a client
   would retry).
4. **Given** an ordinary automation request with no reproduction-intent language, **When** it is
   processed, **Then** behavior is unchanged from today — no new latency-visible step, no new
   response shape for the allowed case.
5. **Given** a differentiation-qualifier request ("an Uber for doctors," "like Slack but for
   \<distinct audience/purpose\>"), **When** it is processed, **Then** it is allowed — the policy must
   not block a legitimately novel request that merely references a known product for comparison.

---

### Edge Cases

- What happens when the mcp-bridge credential check itself is unreachable/misconfigured? It must fail
  closed (refuse), matching every other auth check in this codebase (`resolveIdentity`'s
  `identity_unavailable` 500 is the precedent — refuse rather than silently treat as anonymous).
- What happens when injection-pattern detection produces a false positive on legitimate content (e.g.
  a table literally named `ignore_previous_transactions`)? It must remain a non-blocking warning —
  User Story 2's acceptance scenario 2 is explicit that content is never stripped or blocked, only
  flagged, precisely to bound this cost.
- What happens when the request-policy engine's `transform` proposal is edited by the person before
  confirming? The edited text must be re-evaluated against the same policy, not accepted verbatim —
  matching the source branch's own closed bypass (an edited proposal that reverts to the original
  text must not skip re-evaluation).
- What happens to a flow-chat turn that names a product but with clearly differentiating context? See
  User Story 4 acceptance scenario 5 — allowed, not blocked.
- What happens for the outline-mode/goal-mode generation entry points (not just chat)? **Resolved in
  planning by reading the actual call graph, not assumed**: `flow-chat.service.ts`'s `turn()` is NOT
  the entry point for initial creation — it is the *editing* surface for an existing automation
  ("editing ONE automation, one component at a time"), and its raw free text is `parsed.message`.
  The initial-creation free text (a person typing a goal, or writing an outline) enters through
  `flow-generation-job.service.ts`'s `runGeneration()`, as `input.goal` (goal mode) and each line of
  `input.outline` (outline mode) — confirmed by reading `runGeneration`'s three-way branch
  (`authored` / outline / goal). Canvas mode (`authored`) carries no free text and needs no check.
  **Both real entry points get the check**, sharing one function from `@foundry/shared` so the rule
  cannot drift between the creation path and the editing path.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `packages/mcp-bridge`'s schema endpoint(s) MUST require a valid credential on every
  request, refusing (not silently proceeding) when absent or invalid.
- **FR-002**: The credential check for FR-001 MUST fail closed — an unreachable or misconfigured check
  refuses the request rather than treating it as anonymous or authenticated.
- **FR-003**: Every third-party-supplied string reaching the generation manifest (tool descriptions,
  datasource/table/column identifiers, param descriptions) MUST be wrapped in an explicit,
  model-readable provenance declaration stating it is untrusted workspace data, not an instruction.
- **FR-004**: Manifest content MUST be checked against a deterministic set of injection-pattern
  signatures; a match MUST produce a non-blocking, non-mutating warning — the underlying content is
  never stripped, altered, or used to refuse manifest composition.
- **FR-005**: This feature MUST NOT introduce a code-artifact audit step (the `unrequested_action`
  concept) — v1-alpha has no generated-code artifact to audit, and building one is out of scope.
- **FR-006**: This feature MUST document, without modifying, the equivalence between V5's
  asymmetric-gate discipline and v1-alpha's existing `flow-expectation.service.ts`/`trigger.service.ts`
  gate — citing the specific functions and the specific incident both defend against.
- **FR-007**: A deterministic, config-driven request-policy decision (`allow`/`transform`/`reject`)
  MUST be evaluated on the raw free text of (a) a flow-chat turn's message and (b) a flow-generation
  request's `goal` or `outline` lines, before any manifest is built or generation call is made for
  that turn/request. Canvas-authored (`authored`) requests carry no free text and are not evaluated.
- **FR-008**: A `transform` decision MUST require explicit human confirmation before generation
  proceeds on the rewritten text; the original text MUST NOT be silently substituted.
- **FR-009**: An edited or re-submitted `transform` proposal MUST be re-evaluated against the policy
  before being accepted — accepting a proposal that has reverted to (or still contains) the original
  problematic text MUST NOT bypass evaluation.
- **FR-010**: A `reject` decision MUST NOT build a manifest or make a generation call, and MUST be
  recorded as a genuine terminal turn outcome (a normal response, not a client-retriable error) —
  matching this codebase's existing rule for other terminal-but-not-error outcomes.
- **FR-011**: The request-policy rule set (cataloged products, reproduction-intent lexicon,
  differentiation-qualifier suppression) MUST be config-driven and versioned, not hardcoded inline,
  matching the source branch's `@foundry/shared`-config pattern.
- **FR-012**: This feature MUST NOT modify `identity.middleware.ts`, `requireWorkspaceRole`, the
  flow-execution progress-ticket mechanism (D-15), `flow-expectation.service.ts`, or
  `trigger.service.ts`'s gate-readiness check — all are pre-existing, working, and already provide
  what V2/V5 would otherwise have introduced.
- **FR-013**: No behavior change MUST occur for a legitimate, already-valid request to any of the
  four surfaces this feature touches (mcp-bridge with a valid credential, manifest content with no
  injection pattern, a flow-chat turn with no reproduction-intent language) — this feature only adds
  new rejection/warning paths for requests that were already invalid, injected, or policy-violating.

### Key Entities

- **MCP-bridge credential**: a shared API key, its own env var (`MCP_BRIDGE_API_KEY`), checked via an
  `x-api-key` header — confirmed the smallest correct mechanism given mcp-bridge's actual current
  callers (none) and its standalone-package status (no shared dependency on `packages/server`).
- **Provenance declaration**: the envelope wrapping untrusted manifest content, stating its origin and
  that it is data, not instruction — attached at manifest-composition time.
- **Injection-pattern warning**: a non-blocking finding — pattern name, matched span, location in the
  manifest — surfaced to whoever can act on it (mirrors the source branch's non-mutating design).
- **Request-policy decision**: `allow` / `transform` (with a proposed rewrite) / `reject`, evaluated
  against raw free text at two confirmed entry points — `flow-generation-job.service.ts`'s
  `runGeneration()` (creation: goal/outline) and `flow-chat.service.ts`'s `turn()` (editing: chat
  message) — before manifest composition or a generation/inference call, at either site.
- **Request-policy config**: the versioned, shared (client+server) dataset of cataloged products,
  reproduction-intent lexicon, and differentiation qualifiers.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every request to `packages/mcp-bridge`'s schema endpoint without a valid credential is
  refused; every request with one returns identical data to today's unauthenticated behavior.
- **SC-002**: For every piece of third-party content reaching the manifest, the rendered manifest
  declares its provenance explicitly — verified by a test asserting the envelope wraps every
  tool/datasource-derived string, not just a sample.
- **SC-003**: A manifest containing a planted injection-pattern string produces a warning naming the
  pattern; the same manifest's rendered content is byte-identical to a version with detection
  disabled (proving the check is genuinely non-mutating).
- **SC-004**: A goal/outline/chat request naming a cataloged product with reproduction intent never
  reaches manifest composition, at either entry point — verified by asserting the
  manifest-builder/generation-call function is never invoked for a `transform`- or `reject`-decided
  request from `runGeneration()` or from `flowChatService.turn()`.
- **SC-005**: A goal/outline/chat request with no reproduction-intent language is unaffected at either
  entry point — same response shape, same latency-visible steps, as measured before this feature.
- **SC-006**: A differentiation-qualifier request set (at least the "Uber for X" class of example) is
  confirmed `allow`, not `transform`/`reject`, by an explicit test.
- **SC-007**: Every existing v1-alpha integration path that was working before this feature continues
  to pass its existing test suite unchanged after this feature.
- **SC-008**: A new engineer can determine, from `tasks.md` and `plan.md` alone, exactly which
  v1-alpha file each ported concept landed in, which `krt/guardrail_validation` file it was adapted
  from, and — for V2/V5 — why no file exists because the concept was already satisfied.

---

## Assumptions

- **Resolved in planning**: `packages/mcp-bridge` is confirmed dead-on-arrival infrastructure — the
  compose file's own comment states "nothing registers it today... not currently on any live path,"
  and no other file in the repo calls it. There is no workspace/tenant concept reachable through it in
  practice today. A shared API key, checked with the same `x-api-key` style as `requireApiKey` (but a
  distinct env var — mcp-bridge has no dependency on `packages/server`'s config module and must not
  gain one just for this), is the smallest correct mechanism. Sized to match what actually calls it:
  nothing, today — so the bar is "fail closed for whoever eventually does," not a per-workspace
  credential primitive.
- **Resolved in planning**: goal-mode/outline-mode generation entry points DO need the request-policy
  check, and it is not the same function as flow-chat's. `flow-generation-job.service.ts`'s
  `runGeneration()` is the actual creation-time entry point (`input.goal` / `input.outline`);
  `flow-chat.service.ts`'s `turn()` is a separate, later editing surface (`parsed.message`). Both are
  real, both get the check, from one shared function.
- The request-policy rule dataset (cataloged products, lexicon) can be ported near-verbatim from
  `krt/guardrail_validation`'s `@foundry/shared`, since it is domain-agnostic text classification —
  confirmed by reading `shared/src/request-policy/{evidence,rules,combinator,config}.ts` in the prior
  feature's audit trail, re-verified against the actual file contents during planning before porting.
- `@foundry/shared` (introduced by the prior feature, `20260812-075013-guardrail-infra-port`) is the
  natural home for the request-policy engine and the injection-pattern signatures, following the same
  package-shape precedent already established.

## Out of Scope

- V2's full credential-primitive/ticket rewrite — superseded by existing, working mechanisms.
- V4's `unrequested_action` code-artifact finding — no code artifact exists to audit.
- V5's gate implementation — nothing to build; this feature only documents the existing equivalence.
- Any change to `identity.middleware.ts`, `requireWorkspaceRole`, the flow-execution progress-ticket
  mechanism, `flow-expectation.service.ts`, or `trigger.service.ts`.
- Any change to `flow-validator.service.ts`, `flow-compiler.service.ts`'s D-22 expression allowlist, or
  any other mechanism from the prior guardrail-infra-port feature — this feature is additive on top of
  that one, not a revision of it.

## Dependencies

- `@foundry/shared` (from the prior feature) as the landing package for the request-policy engine and
  injection-pattern signatures.
- `packages/mcp-bridge`'s actual current callers/deployment (confirmed during planning: none) sized
  the credential mechanism to a shared key.
- `manifest-builder.service.ts` as the integration point for the provenance envelope and injection
  detection.
- `flow-generation-job.service.ts`'s `runGeneration()` and `flow-chat.service.ts`'s `turn()` as the
  two confirmed integration points for the request-policy check.
