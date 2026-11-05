# Research: Guardrail Port — V2/V4/V5/V8

## Decision 1 — mcp-bridge's credential mechanism, sized to its actual callers

**Question**: spec.md's Key Entities section left this open — "a shared key... is the leading
candidate... not assumed necessary."

**Audit**: Read `packages/mcp-bridge/src/index.ts` (82 lines, the whole service) and
`packages/mcp-bridge/src/schema-store.ts` (98 lines) — zero auth logic anywhere. Read
`infra/docker-compose.yml`'s `mcp-bridge:` block and its own comment: *"dead code and has been
removed. Kept running because it is harmless and the read-only schema tools may be rewired later;
not currently on any live path."* Grepped the whole repo for `mcp-bridge`/`MCP_BRIDGE`/`4003` — the
only non-doc, non-compose hit outside the package itself is `demo/finance/finance-dataset.ts`, which
does not call it (a coincidental substring). **Nothing in this repository calls mcp-bridge today.**

**Decision**: A shared API key, its own env var (`MCP_BRIDGE_API_KEY`), checked via an `x-api-key`
header on every request except `/health`. Hand-rolled inside `packages/mcp-bridge/src/auth.ts` —
**not** imported from `@foundry/shared` or `packages/server`'s `requireApiKey`. Three reasons:

1. mcp-bridge has never depended on either package (`package.json` has no `@foundry/shared` or
   `@foundry/server` entry) and this feature is not the place to introduce that coupling for one
   ~15-line middleware function.
2. The check itself is genuinely that small: read a header, compare to `process.env.MCP_BRIDGE_API_KEY`,
   401 on mismatch, 500 on the env var being unset (fail closed — Decision matches `resolveIdentity`'s
   own `identity_unavailable` precedent named in spec.md's Edge Cases).
3. Sizing it to a full per-workspace credential primitive (V2's original design, or D-15's ticket
   mechanism) would be building infrastructure for callers that do not exist. FR-013/Article IV both
   argue against it, and spec.md's own Context section already ruled it out ("not assumed necessary").

**Fail-closed behavior** (FR-002): an unset `MCP_BRIDGE_API_KEY` must refuse every request, never
silently allow. Verified by a test that unsets the var and asserts 500, with a positive control that
a correctly-configured server allows a valid key through.

## Decision 2 — the V8 attach points are NOT what spec.md assumed, corrected in place

**Question**: spec.md named `flow-chat.service.ts`'s `turn()` as "confirmed as the default per D-47"
and deferred whether `flow-generation-job.service.ts` also needed the check.

**Audit, in order**:

1. Read `flow-generation-job.service.ts`'s `runGeneration()` (lines 207–260+): it branches on
   `input.authored !== undefined` → `authorFlow` (canvas, no free text) vs. `draftFlow({ goal, outline,
   ... })` (goal/outline mode, **free text**). This is the actual initial-creation entry point.
2. Read `flow-chat.service.ts`'s header comment and `turn()`: *"You are editing ONE automation, one
   component at a time"* — this is the **editing** surface for an existing automation, not creation.
   `turn()`'s `parsed.message` is a second, separate piece of raw free text.
3. Read `flow-generation.service.ts`'s `buildDraftPrompt` (confirms `opts.goal`/`opts.outline` are the
   text a drafted flow is built from) and `runTurn`'s prompt-building path (confirms `parsed.message`
   feeds `buildChatPrompt`).

**Finding**: D-47 (cited in spec.md's original assumption) is about outline mode being the *default
authoring mode on `/flows/new`*, which is exactly `runGeneration()`'s goal/outline branch — it has
nothing to do with `flow-chat.service.ts`. The original spec.md sentence conflated the two. **Both are
real, distinct entry points and both need the check** — corrected directly in spec.md (FR-007, User
Story 4, Edge Cases, Assumptions, Key Entities, Dependencies) per this feature's own audit-first
discipline, the same discipline that narrowed V2/V5's scope.

**Decision**: One shared evaluation function, called from two sites:
- `runGeneration()` — evaluate `input.goal` (goal mode) and, if present, each `input.outline` line
  joined (outline mode is still one automation request, evaluated as one text) — **before** calling
  `draftFlow`/`authorFlow`. Skipped entirely for `input.authored !== undefined` (canvas mode: no free
  text, nothing to evaluate).
- `flowChatService.turn()` — evaluate `parsed.message` — **before** `runTurn()` is invoked, so a
  `reject`/`transform` decision never reaches `flowChatRepo.createTurn`'s `running` status or any
  inference call.

Sharing one function (not two copies) is what SC-004/SC-005's "no drift between the two entry points"
requirement actually needs — a rule that fires differently at creation vs. edit time is a rule nobody
can reason about.

## Decision 3 — the provenance envelope's ONE integration point

**Question**: where does manifest content actually enter a generation prompt on v1-alpha (the source
branch's equivalent, `script-generation.service.ts`, is deleted — Phase 4 of the Kestra migration)?

**Audit**: `grep -rn "manifestXml\|summaryXml" packages/server/src --include="*.ts"` outside
`manifest-builder.service.ts` itself, across the whole server package, returns exactly one prompt-text
site: `flow-generation.service.ts` line 716, `buildDraftPrompt`: `` [DRAFT_RULES, ``, opts.catalogue,
``, `WORKSPACE MANIFEST`, opts.manifestXml, ``] ``. Every other reference (`db/schema.ts`, three
`demo/*provision*.ts` files) is either the column definition or a byte-length log line, not prompt
text.

**Decision**: Wrap `opts.manifestXml` at that one call site with
`` `${PROVENANCE_DECLARATION}\n\n${wrapUntrusted(opts.manifestXml)}` ``, mirroring the source branch's
own `script-generation.service.ts` pattern exactly (same two functions, same call shape). This is the
**only** edit needed to satisfy FR-003/SC-002 for the manifest artifact itself.

**Deliberately not touched — `catalogueText()`.** `flow-generation.service.ts` (and
`flow-chat.service.ts`, via the same function) also render tool/query names and descriptions through
`catalogueText()`, a separate rendering from the manifest XML. This is third-party content too, but it
is a distinct artifact spec.md never names (spec.md's User Story 2 and FR-003 both say "the manifest").
Wrapping it is a legitimate future extension of the same idea but is explicitly out of scope here —
extending scope mid-planning to a surface the spec never named would be exactly the kind of unaudited
scope creep this feature's whole methodology exists to avoid. Noted in `plan.md`'s summary for
whoever picks this up next.

**Injection detection is computed alongside, not embedded**: `manifestBuilderService.buildAndPersist()`
gains a `warnings` field on its return value —
`detectInjection(spansFromInventory(inventoryFromWorkspace(...)))` — computed from the same
tools/datasources/entities `buildAndPersist` already has in hand (no extra query, matching the source
branch's own reasoning for why `spansFromInventory` takes an already-assembled inventory rather than a
`workspaceId`). **This must not change `hashBody`** (the content hash `manifestRepo` versions on) —
`warnings` is metadata about the render, never mixed into the hashed or persisted XML strings. Verified
by SC-003: a manifest with a planted injection string produces a warning, and its `manifestXml`/
`summaryXml`/`hash` are byte-identical to the same manifest with detection disabled.

## Decision 4 — V5: nothing to build, only to record

**Confirmed equivalence** (already established in spec.md's Context, re-verified here before
committing to "no code"): `flow-expectation.service.ts`'s `ExpectationStatus` union is
`"passed" | "failed" | "unevaluable"`, and its own module comment states `unevaluable` does not
satisfy the gate. `trigger.service.ts`'s `flowEnableReadiness()` requires a succeeded run with every
declared expectation `passed`. Both together are V5's exact discipline: a claim about output is
checked, and "nothing to check against" is not silently treated as passing.

**Decision**: a single, permanent CLAUDE.md note (task in tasks.md's Polish phase) recording the
finding with both function names and the shared incident, so no future contributor re-derives this
from scratch reading the source branch's V5 description in isolation. No test, no code change — the
"test" for this user story (per spec.md) is that the note exists and cites the right functions, which
is a documentation-review check, not a runtime one.

## Decision 5 — porting the request-policy config near-verbatim

**Audit**: read the full source module (`rules.ts`, `combinator.ts`, `config.ts`, `transform.ts`,
`evidence.ts`) on `origin/krt/guardrail_validation`. It is genuinely domain-agnostic — its only inputs
are `{ task: string }` and a plain-data `PolicyConfig`; nothing references script generation, Python,
or any product-shape concept the source branch has that v1-alpha lacks. `request-policy.service.ts`
(the server wrapper) is equally portable: it only depends on `@foundry/shared`'s `evaluatePolicy` and
tracks issued TRANSFORM proposals in-memory.

**Decision**: port all five files near-verbatim into `@foundry/shared/src/request-policy/`, and port
`request-policy.service.ts` near-verbatim into `packages/server/src/services/`. No behavioral changes
to the ported logic itself — the only new work is the two call sites (Decision 2) and the outcome
shapes they produce (Decision 6).

## Decision 6 — outcome shape: `policy_reject`/`policy_transform` as first-class 200s

**Precedent**: v1-alpha already has exactly this pattern for a different refusal —
`isDraftRefusal`/`DraftRefusal` (`status: "insufficient_catalogue"`), returned from `runGeneration()`
as a `GenerationOutcome` variant, never thrown. D-38's rule ("a refusal is a 200, its own terminal
status, never a client-retriable error") applies identically here — FR-010 says exactly this for
`reject`.

**Decision**: add two `GenerationOutcome` variants (`status: "policy_reject"` /
`status: "policy_transform"`) following the exact shape convention `insufficient_catalogue` already
uses, and the equivalent two variants on `TurnOutcome` for `flowChatService.turn()`. `policy_transform`
carries the `proposal` (`proposalId`, rewritten `task`); `policy_reject` carries `reason` and
`evidence`. Both short-circuit before any inference call — matching `insufficient_catalogue`'s
placement (before `generateFragments`), just one step earlier (before `draftFlow`/`authorFlow` even
runs), since a policy decision needs no model call to reach.

**Resubmission** (FR-008/FR-009): the client confirming a `transform` proposal resubmits
`{ proposalId, task }`; the route calls `requestPolicyService.verifyAcceptedTransform(...)`, which
returns the verified task text or `null` (unknown/expired proposal — treated as fresh, re-evaluated
from scratch, never trusted blindly). This closes the exact bypass FR-009 names: an edited proposal
that reverts to the original problematic text is re-evaluated by `evaluatePolicy`, not skipped.
