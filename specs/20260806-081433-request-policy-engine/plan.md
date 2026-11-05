# Implementation Plan: Request Policy Engine (V8)

**Branch**: `krt/guardrail_validation` | **Date**: 2026-08-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20260806-081433-request-policy-engine/spec.md`

## Summary

A deterministic policy stage that runs on the operator's task text, before any
prompt is composed. Rules produce named evidence; a combinator reads that
evidence and produces ALLOW / TRANSFORM / REJECT plus a plain-language reason.
Policy content (product names, aliases, distinguishing-feature signatures,
intent lexicons) lives as versioned data in `@foundry/shared`, following V7's
exact dual-consumption shape: the client applies it directly for immediate
feedback in the builder flow, the server applies the same data authoritatively
before `scriptGenerationService.start()` composes a prompt, and an equivalence
test proves the two agree.

**Where this sits, concretely**:

- Server: a new check inside `scriptGenerationService.start()`
  (`packages/server/src/services/script-generation.service.ts:440`), evaluated
  on `input.task` before the manifest is built (line 445) — the earliest point
  a request can be stopped before any real work happens.
- Client: a new gate evaluated at two points in
  `packages/client/src/lib/automation-flow.ts`'s step machine — once leaving
  `describe` (first submission), once leaving `plan` (after clarify has
  resolved the request into fuller stated features), before `build` starts
  generation.

**What this feature does not do**: put an LLM anywhere in the decision path,
silently rewrite a request nobody approved, or attempt comprehensive product
coverage. See spec Out of Scope.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥20, ESM

**Primary Dependencies**: none added to `packages/client` or `packages/server`.
The policy configuration is workspace data in `@foundry/shared` (already a
dependency of both, per V7). No new third-party dependency.

**Storage**: none new. Decision records (FR-019) are attached to the existing
generation-request/response flow, not persisted to a new table for this
feature — see Decisions D5 for why persistence is deliberately out of scope.

**Testing**: vitest in all three packages, plus a shared fixture table
(`packages/shared/src/request-policy/fixtures.ts`) exercised from both sides —
the same shape as V7's `rules.cases.ts` / equivalence test.

**Target Platform**: Next.js 14 App Router client; Node/Express parent API.

**Project Type**: pnpm workspace — `client`, `server`, `shared`, `mcp-bridge`.

**Constraints**:

- **FR-005 / FR-006** — rules are independent, evidence-only, and unaware of
  outcomes; the combinator is the sole place decisions are made. This governs
  the module boundary (Decisions D1, D2).
- **FR-010–FR-012** — mode-awareness (confirmation-available vs.
  confirmation-unavailable) is a parameter into the combinator, not a
  client/server split — the server must be able to evaluate either mode
  (an API caller with no UI is still server-side), so "is a human present"
  must travel as an explicit input, not be inferred from which package is
  calling.
- **FR-017 / FR-018** — configuration-as-data and equivalence-testing, exactly
  V7's shape. Reuse `@foundry/shared`'s existing package rather than
  introducing a second shared package (Article IV).
- **Constitution Article XV** — TRANSFORM must never auto-proceed; the
  route/response contract must give the client a way to show a proposal and
  require an explicit confirm before resubmission.

**Scale/Scope**: one new module tree in `@foundry/shared`
(`src/request-policy/`), one new server module wired into one existing service
function, one new client module wired into one existing step machine, one new
response shape on the existing generation-start route, no new database table.

## Constitution Check

**Process gates (Articles I-VIII)**

- [x] **II. Test-First** — the fixture table (request → expected decision,
      covering spec's edge cases) is written before the combinator; the
      combinator is developed against it, not the reverse.
- [x] **IV. Simplicity** — no new package (reuses `@foundry/shared`), no new
      third-party dependency, no new database table. The one new abstraction —
      rule/evidence/combinator split — is required by FR-004–FR-008 and is
      justified in Decisions D1.
- [x] **V. Observability** — every REJECT/TRANSFORM names its evidence
      (FR-006, FR-019); no silent catch-and-allow.
- [x] **VII. Documentation Currency** — `docs/validation-and-guardrails-roadmap.md`
      already updated (§6 correction, V8 status row) as a precondition to this
      plan; `@foundry/shared`'s README gets a new section describing what
      belongs in `request-policy/` (parallel to its existing rule-table
      section), since this content is a different kind from V7's field rules.
- [x] **VIII. Secrets Hygiene** — no credential, no new env var.

**Foundry gates (Articles IX-XV)**

- [x] **IX. Harness Boundary** — n/a. This feature runs entirely before any
      Tether call; it does not touch `tether-client.service.ts` or add a
      second path to the runtime.
- [x] **X. Generated Code Is Untrusted (NON-NEGOTIABLE)** — directly
      applicable to the central design constraint: no LLM output (a model
      call, a prompt, a temperature setting) may sit anywhere on the
      production decision path, because it cannot be reproduced deterministically
      and therefore cannot be a gate (spec Out of Scope; roadmap §6, corrected).
- [x] **XI. Least-Privilege Data Access** — n/a. No data access introduced.
- [x] **XII. Workspace Isolation** — n/a. Policy configuration is global, not
      workspace-scoped (a product's identity does not vary by tenant); no new
      tenant-owned row is introduced.
- [x] **XIII. Manifest Is the Contract** — n/a. This feature runs before the
      manifest is built and does not touch manifest content.
- [x] **XIV. Synthetic Demo Data Only** — n/a. No demo data touched; fixture
      requests are plain English text, not personal/customer data.
- [x] **XV. No Silent Side Effects (NON-NEGOTIABLE)** — the central design
      constraint on TRANSFORM (FR-011, FR-012): confirmation-available mode
      proposes and waits; confirmation-unavailable mode never guesses, it
      REJECTs with the same explanation. Directly modeled on this article.

**Foundational standards**

- [x] **frameworks.md** — no new framework or dependency; stays inside the
      existing pnpm/TypeScript/Express/Next stack.
- [x] **security.md** — no new secret, no new attack surface reaching
      untrusted execution; if anything this closes a documented gap (§6's
      task-text non-goal was previously silent on business-policy evaluation).
      `security.md` itself is not amended by this feature — see Standards
      impact in spec.md.
- [ ] **design.md** — UI only, applies to the client's TRANSFORM-confirmation
      surface (a new proposal/confirm affordance in the builder flow). Must
      compose from `src/components/ui/`, use tokens, and be verified at
      375/768/1280px before being called done. Tracked as a task, not
      pre-checked here.

**No constitution violations. No Complexity Tracking entries required.**

## Decisions

### D1 — Rules, evidence, and the combinator are three distinct TypeScript modules, not one scoring function

Spec FR-004–FR-008 require rules to be independent and evidence-only, and a
single combinator to hold all outcome logic. Concretely:

- `packages/shared/src/request-policy/evidence.ts` — the evidence types each
  rule may produce (named facts: matched product, matched intent phrase,
  matched/missing distinguishing features, matched differentiation qualifier).
  Plain data/type definitions, no logic.
- `packages/shared/src/request-policy/rules.ts` — pure functions,
  `(request: ResolvedRequest, config: PolicyConfig) => Evidence[]`, one per
  rule (product-reference, reproduction-intent, differentiation-qualifier,
  capability-signature). Each rule reads only the request and the
  configuration; none reads another rule's output. Each carries its
  capability metadata (`canRejectAlone: boolean`) as a static property, per
  FR-007.
- `packages/shared/src/request-policy/combinator.ts` — the sole function that
  takes the full evidence array plus the mode (confirmation-available /
  confirmation-unavailable) and returns a `PolicyDecision` (FR-006, FR-010–012).

This mirrors the rule/checker split V7 already established
(`rules.ts` data → `field-check.ts`'s `check()` function), extended with an
explicit combinator layer because V7's rules are single-field and
independent by construction (each is its own regex), while V8's rules must be
independent by *design discipline* — hence the stricter module boundary and
the capability-metadata contract.

**Why not one function that both matches and decides** (rejected): this is
exactly the "hidden scoring engine" failure mode the spec's Clarifications
record — collapsing evidence-gathering and decision-making into one function
makes the decision untestable independent of the matching logic, and makes it
easy to accidentally let a rule's internal logic special-case an outcome
(exactly the Q2 risk the spec calls out).

### D2 — Policy configuration lives in `@foundry/shared`, in a new `request-policy/` module, not inside `rules.ts`

`@foundry/shared`'s existing `rules.ts`/`RuleDefinition` is scoped, by its own
README, to single-field validation rules that mirror an existing server zod
primitive — "a rule authored only for the client... does not belong here."
V8's product/lexicon dataset is a new kind of policy content with no
pre-existing server primitive to mirror. Rather than force it into
`RuleDefinition`, this feature adds a sibling module,
`packages/shared/src/request-policy/`, re-exported from the package's
`index.ts`, and extends the package README with a new section describing this
second category explicitly (what belongs: product/alias/feature-signature/
intent-lexicon data, capability metadata; what does not: the decision logic
itself, which lives as functions in `rules.ts`/`combinator.ts` within the same
module — an intentional, spec-required exception to the parent package's
"plain data only, no functions" rule, called out explicitly in the new README
section so it isn't read as an accidental violation).

**Why the same package rather than a new one** (rejected: `@foundry/policy`):
Article IV — no new package without justification, and none exists here. V7
already built the exact dual-consumption/equivalence-test plumbing
(`packages/client` depends on `@foundry/shared` with zero third-party
additions); reusing it costs nothing and a second package would duplicate that
plumbing for no benefit.

### D3 — Server integration point: inside `scriptGenerationService.start()`, before manifest build

`start()` (`script-generation.service.ts:440`) is called from exactly one
place, `routes/scripts.ts:70`, after V1's `validate()` and the rate/concurrency
guards. The policy check runs as the first statement inside `start()`, before
`manifestBuilderService.buildAndPersist()` (line 445) — nothing is built,
persisted, or sent to the harness for a REJECTed or unconfirmed-TRANSFORM
request.

**Confirmation-availability as an explicit input, not an inferred one**: the
route handler cannot assume "a browser is calling" implies confirmation is
available — an API client or a future MCP-driven caller hits the same route.
`generateScriptSchema` gains an optional field,
`confirmationAvailable: boolean` (default `true` — see Decisions D4 for why),
and `input.task` review runs with that mode. A resubmission after a shown
TRANSFORM proposal carries `acceptedTransform: { proposalId, task }`, and the
route substitutes the accepted, previously-shown task text rather than
re-evaluating from scratch — re-evaluating a resubmission is a spec
requirement (FR-002 says re-evaluate on resolution, not "re-evaluate forever");
substituting the accepted text and proceeding directly to generation is the
"the user's decision — not the system's default — determines what proceeds"
requirement from Story 3, Scenario 2.

**Response shape for TRANSFORM**: the route returns `202` today for a started
generation (`routes/scripts.ts:71`). For TRANSFORM under
confirmation-available mode, no generation starts, and the route returns `200`
with `{ decision: "transform", proposal, evidence, reason }` instead — a new,
distinguishable response the client's existing polling/state logic does not
already assume, so this is additive, not a change to `202`'s existing meaning.
For REJECT, the route returns `422` with `{ decision: "reject", evidence,
reason }`. ALLOW proceeds exactly as today (`202`, unchanged).

### D4 — `confirmationAvailable` defaults to `true`, not `false`

Rejected alternative: default `false` (fail toward the stricter behavior).
Chosen `true` because the overwhelmingly common caller today is the builder
UI, which can always show a confirmation surface, and defaulting to the
stricter behavior would turn ordinary UI-driven TRANSFORM cases into REJECTs
for every caller that doesn't yet know to set the flag — the opposite of
FR-023's non-regression requirement. A caller that genuinely cannot confirm
(a scheduled/unattended path) is expected to know that about itself and set
`confirmationAvailable: false` explicitly. This is recorded here because it is
a real judgment call, not a default with an obvious right answer either way.

### D5 — Decision records are returned in the API response, not persisted to a new table, in this feature

FR-019/FR-020 require every decision to be a structured record with named
evidence and a configuration version. This feature satisfies that by having
the combinator return the record and the route include it in the response
body (and, for REJECT/TRANSFORM, in server logs via the existing logging
path) — but does not add a new database table to store decision history
long-term. Fixture/unit tests exercise the shape directly; there is no
"decision history" UI in this feature's scope.

**Why not persist now** (deferred, not rejected): a queryable decision-history
table is a real feature (support tooling, trend analysis across configuration
versions) but it is additive — nothing in this feature's requirements depends
on decisions being queryable after the fact beyond what server logs already
provide, and adding a table without a defined consumer repeats the mistake the
spec's Out of Scope section calls out for the LLM-advisory reviewer ("avoid
shipping an unused... channel with no defined consumption workflow").

### D6 — Client integration: `automation-flow.ts` gains a policy gate, alongside `gateFor`, not inside it

`gateFor(step, state)` (FR-002 in V7's spec) decides whether the wizard may
advance — a flow decision. Policy evaluation is a different question
("is this request itself allowed"), so it is a sibling function,
`policyGateFor(state)`, called at the `describe → connect` and
`plan → build` transitions specifically (per spec's two-evaluation-pass
requirement), not folded into `gateFor`'s existing signature. This preserves
V7's own resolution (Q2: `gateFor` stays a distinct, documented idiom) rather
than re-opening it.

## Project Structure

### Documentation (this feature)

```text
specs/20260806-081433-request-policy-engine/
├── plan.md              # this file
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── generate-script-policy-response.md
└── tasks.md             # /speckit-tasks output (not created by this command)
```

### Source Code (repository root)

```text
foundry/packages/shared/src/
├── index.ts                        # re-export request-policy/*
└── request-policy/
    ├── evidence.ts                  # Evidence, PolicyDecision, PolicyConfig types
    ├── config.ts                    # the product/alias/feature-signature/intent-lexicon data
    ├── rules.ts                     # pure evidence-producing functions + capability metadata
    ├── combinator.ts                # evidence[] + mode -> PolicyDecision
    ├── transform.ts                 # templated rewrite assembly (FR-009)
    └── fixtures.ts                  # request -> expected-decision table (shared by both test suites)

foundry/packages/server/src/
├── services/
│   └── request-policy.service.ts    # thin wrapper: calls shared combinator, builds config version stamp
├── routes/schemas/
│   └── script.schema.ts             # add confirmationAvailable, acceptedTransform (existing file, extended)
└── routes/
    └── scripts.ts                   # existing file: call request-policy.service before scriptGenerationService.start()

foundry/packages/client/src/lib/
├── automation-flow.ts                # existing file: add policyGateFor()
└── request-policy-client.ts          # thin wrapper: calls shared combinator client-side for fast feedback

Tests (co-located, per this repo's existing convention — *.test.ts next to source):
foundry/packages/shared/src/request-policy/{rules,combinator,transform}.test.ts
foundry/packages/shared/src/request-policy/equivalence.test.ts   # client vs server agree, per fixtures.ts
foundry/packages/server/src/services/request-policy.service.test.ts
foundry/packages/client/src/lib/automation-flow.test.ts          # extended with policyGateFor cases
```

**Structure Decision**: extend the existing three-package pnpm workspace
(`shared`, `server`, `client`) exactly as V7 did — no new package, no new
top-level directory. All new server/client files are thin integration layers
over shared, pure logic.

## Complexity Tracking

No violations recorded. No entries required.

## Backfilled additions 2026-08-12

A pre-merge audit fixed a config-authoring gap, a wire-format gap, and a
doc-accuracy gap in the already-implemented feature above; see `tasks.md`'s
`T064`–`T069` and `spec.md`'s FR-024/Clarifications Q4 for the full record.
No change to this plan's Structure Decision, package layout, or dependency
list — every fix landed inside files this plan already scoped
(`config.ts`, `rules.ts`, `evidence.ts`, `scripts.ts`, `foundry-client.ts`,
`automations/new/page.tsx`, and the existing `prompt-persisted.test.ts` test
file from V4/T019). No new package, dependency, or architectural layer.
