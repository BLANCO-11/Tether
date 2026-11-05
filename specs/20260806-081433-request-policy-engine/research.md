# Phase 0 Research: Request Policy Engine (V8)

No `NEEDS CLARIFICATION` markers remain in Technical Context — the extended
design discussion preceding the spec resolved every open design question. This
document instead records the concrete facts gathered from the live codebase
that the plan depends on, so a later reader does not have to re-derive them.

## R1 — Where the task string enters the server

**Decision**: hook the policy check at the top of
`scriptGenerationService.start(workspaceId, input)`
(`packages/server/src/services/script-generation.service.ts:440`), before
`manifestBuilderService.buildAndPersist()` (line 445).

**Rationale**: `start()` is called from exactly one place —
`routes/scripts.ts:70`, `scriptsRouter.post("/", ...)` — after V1's
`validate({ params, body: generateScriptSchema })` and the generation
rate-limit/concurrency guards. It is the earliest point in the server where
`input.task` (the raw operator string) is available and nothing costly has
happened yet: no manifest built, no prompt composed, no harness call made.

**Alternatives considered**: inside `composePrompt()` (rejected — by the time
that runs, the manifest has already been built at cost, and `composePrompt`'s
job is prompt assembly, not policy); inside the Express route handler directly
(rejected — `start()` is the actual seam other slices use for service-level
concerns, e.g. manifest building and session-reuse logic already live there;
keeping policy alongside them keeps `routes/scripts.ts` a thin HTTP layer,
consistent with the rest of the file).

## R2 — The existing route response contract, and how TRANSFORM/REJECT extend it without breaking it

**Finding**: `scriptsRouter.post("/")` today always returns `202` with
`scriptGenerationService.start()`'s result on success, or a `429` (capacity)
before `start()` is even called. There is no existing `200` or `422` response
from this route, so introducing them for TRANSFORM/REJECT is additive — no
existing client code branches on an absence of those status codes in a way
that would misinterpret them.

**Decision**: `200 { decision: "transform", proposal, evidence, reason }` and
`422 { decision: "reject", evidence, reason }`, `202` unchanged for ALLOW.

## R3 — `@foundry/shared`'s existing scope boundary, and why V8's data is a new module, not a `RuleDefinition` addition

**Finding**: `packages/shared/src/rules.ts`'s own doc comment and README are
explicit: entries are single-field, regex/bounds/message rules that mirror a
**pre-existing server zod primitive** ("this package shares an existing rule;
it does not introduce one"). `RuleDefinition` is a closed union
(`PatternRule | UrlRule | PositiveIntRule`) with no shape for "a product name
with aliases and a feature signature," and forcing V8's data through it would
misrepresent both the data's purpose and the package's stated boundary.

**Decision**: add `packages/shared/src/request-policy/` as a sibling module
within the same package (Decisions D2 in plan.md), re-exported from
`index.ts`, with its own README section. Confirmed via `package.json`
(`exports: { ".": "./src/index.ts" }`) that the package has one export surface
today — the new module is added to the same `index.ts` re-export, not a new
package export path, to keep both consumers importing from `@foundry/shared`
exactly as they do today.

## R4 — The V7 dual-consumption/equivalence-test pattern, confirmed present and reusable

**Finding**: `packages/server/src/validation/primitives.ts` builds zod schemas
**from** `@foundry/shared`'s data (e.g. `zEnvVarName` wraps `envVarName`'s
pattern/bounds/message); `packages/client/src/lib/field-check.ts`'s `check()`
applies the same `RuleDefinition` data directly, no zod. An equivalence test
(referenced in both files' comments as `primitives.equivalence.test.ts`)
proves the two agree over a shared case table. This is exactly the shape V8
needs and the plan's `fixtures.ts` / `equivalence.test.ts` reuse it.

**Difference to account for**: V7's checker is a pure function over one value
and one rule. V8's combinator takes a whole evidence array plus a mode flag
and returns one of three decisions, not a pass/fail per field — the
equivalence property to test is therefore "same request + same config + same
mode → same `PolicyDecision`," not "same value + same rule → same
`ValidationProblem[]`." The mechanism (one data source, two independent
consumers, one fixture-driven equivalence test) transfers; the specific
assertion shape does not, and `equivalence.test.ts` is written against
`PolicyDecision`, not `ValidationProblem`.

## R5 — The client step machine's two natural checkpoints

**Finding**: `packages/client/src/lib/automation-flow.ts` defines
`Step = "describe" | "connect" | "clarify" | "plan" | "build" | ...`.
`describe` is where the operator first types the request; `clarify` (skipped
when nothing needs asking) and `plan` are where the request is resolved into
fuller stated features before `build` (generation) begins.

**Decision**: evaluate the policy gate leaving `describe` (first pass, catches
Story 1/2's bare requests) and leaving `plan` (second pass, catches Story 3's
soft-phrased-then-resolved requests), per spec FR-002. Implemented as a
sibling function `policyGateFor(state)`, not folded into the existing
`gateFor(step, state)`, per Decisions D6 (preserves V7's own Q2 resolution
that flow-advancement and field/request validity are different concerns).

## R6 — `generateScriptSchema`'s existing task bound

**Finding**: `packages/server/src/validation/schemas/script.schema.ts:5` —
`task: z.string().min(3).max(20_000)`. This bound is orthogonal to and
unaffected by this feature; V8 evaluates the content of a string already
bounded in length by V1, it does not change that bound.

**New optional fields needed on the same schema** (additive, both optional):
`confirmationAvailable: z.boolean().default(true)` (Decisions D4) and
`acceptedTransform: z.object({ proposalId: z.string(), task: z.string() }).optional()`
(Decisions D3) — a resubmission after a shown TRANSFORM proposal.
