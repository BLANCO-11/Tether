# Implementation Plan: Client-Side Validation Coherence

**Branch**: `krt/guardrail_validation` | **Date**: 2026-08-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20260804-081646-client-validation-coherence/spec.md`

## Summary

One shared definition, two consumers, and a test that keeps them honest.

1. **`@foundry/shared`** — a new workspace package holding rule definitions as
   **plain data**: pattern source, bounds, and message text. No zod, no runtime
   behaviour.
2. **The server's primitives are rebuilt on top of it.** `zEnvVarName`,
   `zIdentifier`, `zHttpUrl` and the rest keep their current behaviour and their
   current messages, and stop being the place the rule is written down.
3. **The client applies the same definitions directly** — a `check(value, rule)`
   over plain data, no dependency added.
4. **One test makes FR-003 structural**: every shared rule is asserted to behave
   identically through the server's zod primitive and through the client's checker,
   over the same case table. If someone edits one side, that test fails.

That last point is the whole feature. Two implementations of one rule that agree
today is the status quo with extra steps; two implementations proven to agree by a
shared case table is the thing worth building.

**What this feature does not do**: make client validation authoritative. It is UX.
Every rule it enforces is already enforced server-side, and FR-006 forbids adding
one that is not.

## Technical Context

**Language/Version**: TypeScript 5.x, Node ≥20, ESM

**Primary Dependencies**: **none added to `packages/client`** (FR-015, SC-008).
The shared package is a workspace dependency with no third-party deps of its own.
The server keeps zod.

**Storage**: none. One localStorage key is renamed-or-kept (FR-011).

**Testing**: vitest in all three packages. The shared case table is the load-
bearing artefact and is exercised from both sides.

**Target Platform**: Next.js 14 App Router client; Node parent API.

**Project Type**: pnpm workspace, currently `client`, `mcp-bridge`, `server`.

**Constraints**:

- **FR-004 / SC-002 — the client must not be stricter than the server.** This is
  the failure mode that produces no error report: the operator simply cannot do
  something and assumes they are wrong. The shared case table must carry
  *accepted* values, not only rejected ones.
- **FR-005** — a rule the client cannot express is not checked on the client. It
  is not approximated. `tool.schema.ts`'s cross-field `superRefine` auth rules are
  the concrete instance.
- **FR-011** — the rename must not silently invalidate recorded verdicts.
- **Article IV** — a new workspace package needs justifying, and D1 does.

**Scale/Scope**: one new package, one server file rewritten in terms of it, one
new client module, three client idioms touched, one file renamed.

## Constitution Check

- [x] **I. Spec-First** — spec written and validated first.
- [x] **II. Test-First** — the shared case table is written before either
      consumer reads it. That ordering is not ceremony here: the table *is* the
      specification of each rule, and writing it after the implementations would
      mean writing down whatever they happened to do.
- [x] **IV. Simplicity** — a new package is real weight and is justified in D1.
      No new third-party dependency anywhere.
- [x] **V. Observability** — one error shape across every client surface; a
      failed check names the field, the rule and the message.
- [x] **VII. Documentation Currency** — the rename is documented; the shared
      package gets a README saying what belongs in it and, more usefully, what
      does not.
- [x] **VIII. Secrets Hygiene** — no secret, no env var, nothing owed to
      `.env.example`.
- [x] **X. Generated Code Is Untrusted** — untouched.
- [x] **XV. No Silent Side Effects** — FR-011 forbids silently invalidating
      recorded verdicts; a cleared verdict forces re-validation, which is a real
      cost to a real user even though it is fail-safe.

**One thing to be explicit about, because it looks like a violation and is not.**
This feature adds validation to the client that can be bypassed. That is
acceptable *only* because FR-006 requires every such rule to be enforced
server-side already, and because SC-004 verifies it rule by rule. If SC-004 finds
a client rule with no server counterpart, that is a **finding to record**, not a
gap to close here — closing it means adding a server rule, which is a behaviour
change with its own regression risk and belongs to its own feature.

**No violations. No Complexity Tracking entries required.**

## Decisions

### D1 — A shared package of rule definitions as data, not as zod schemas

Spec Q1 resolution A. The package exports, for each rule, a plain object: pattern
source string, bounds, message. No zod, no functions with library types.

Why data rather than schemas:

- **The client gets no new runtime dependency.** Adding zod to the client for
  validation the client is explicitly not allowed to rely on (FR-006) is a poor
  trade, and it lands in the Next bundle.
- **Plain data is inspectable and diffable.** A rule change is a one-line diff in
  one file, readable by someone who does not know zod.
- **It keeps the honest boundary.** Cross-field rules (`superRefine`) genuinely
  cannot travel this way, and that is a feature: FR-005 says the client must not
  check what it cannot express, and a data-only format makes the inexpressible
  cases *obviously* inexpressible rather than tempting.

**Rejected**: shared zod schemas with zod added to the client (Q1 option B).
**Rejected**: serving rules over the API (Q1 option C) — correct long-term for
connector forms, where the JSON-Schema seam already exists, and far too large for
the rest. A and C are compatible; A is what makes today's forms coherent.

### D2 — The server's primitives are rebuilt on the shared definitions, and a test proves it

`primitives.ts` keeps every export and every message. Each becomes a zod schema
constructed *from* the shared definition rather than from a literal.

The test that makes FR-003 structural: a **single case table per rule** — accepted
values and rejected values — run through the server's zod primitive and through the
client's checker, asserting the same verdict and the same message. Edit one side
only, and it fails.

This is stronger than "we remembered to update both", and it is the only part of
this feature that would be worth keeping if everything else were cut.

**Watch the messages.** `zEnvVarName`'s current message is *"must be an env-var
identifier (letters, digits, _)"*. FR-002 requires the client to use the server's
message, so these strings move into the shared package verbatim. Improving them is
a separate change; doing it here would hide a behaviour change inside a refactor.

### D3 — `gateFor` and `validatePlan` keep their logic and align their shape

Spec Q2 and Q3, both resolution A. FR-008 requires the justification be written
down, so here it is:

- **`gateFor` decides flow**, not field validity — "may this wizard step advance,
  given accumulated state". Folding it into a field validator produces a field
  validator that carries wizard state, which is the kind of unification that gets
  unwound later.
- **`validatePlan` walks a recursive tree** and reports structural problems ("this
  path has no steps"). Expressing that as a field schema is more machinery than
  the three lines of traversal it replaces.

Both adopt the common **error shape**. That is the coherence worth having; forcing
either into a field-schema idiom is not.

**But `MIN_PROMPT_LENGTH = 20` is a field rule** sitting in the flow module, and it
must either derive from a shared definition or be recorded as a client-only rule —
which FR-006 forbids and SC-004 will catch. Task-listed as a check with two
possible outcomes, not as an assumption that a server counterpart exists.

### D4 — `manifest-form.ts` gains validation over the constraints it already carries

`jsonSchemaToFields` already puts `required`, `min`, `max` and `integer` on
`FormField` and nothing checks them. Add a checker that validates a value against a
`FormField`, using the same error shape.

This is FR-009's "extend rather than replace": the constraints already come from
the backend's schema, so they cannot drift. It is also the smallest possible move
that makes the seam a validating seam.

### D5 — The rename keeps the storage key

`lib/validation.ts` → a name describing what it is: a record of which prompt
versions passed a real test build.

**The `foundry.validatedBuilds.v1` key does not change** (FR-011). Changing it
invalidates every recorded verdict in every browser, forcing every user to
re-validate. That is fail-safe and it is not free, and there is no reason to pay
it for a rename. The key is an on-disk contract; the module name is not.

### D6 — US4 (gate coherence) depends on V5 and is separable

If V5 has shipped, the client reads the server's readiness decision and presents
that. If it has not, US4 defers and the rest of the feature lands — nothing in
US1–US3 depends on it.

The rule either way: **the local store may block, never permit** (FR-013). That is
what the existing module's fail-safe reasoning already claims, and this feature
keeps it true against the server's decision rather than only against a cleared
store.

## Sequencing

| # | Slice | Contents | Why here |
|---|---|---|---|
| 1 | Shared package | `@foundry/shared`, the rule definitions, the case tables, workspace wiring | Nothing consumes it yet. |
| 2 | Server rebuilt on it | `primitives.ts` reconstructed; the cross-consumer equivalence test | Proves the definitions are right before the client depends on them. |
| 3 | Client checker | `check(value, rule)`, the common error shape | The client half. |
| 4 | Forms adopt it | `manifest-form.ts` validation; the forms that hand-check today | The user-visible win. |
| 5 | Idiom alignment + rename | `gateFor`/`validatePlan` error shapes; `MIN_PROMPT_LENGTH` audit; the rename | Cleanup, once there is something to align to. |
| 6 | Gate coherence (US4) + hardening | server readiness on the go-live surface; SC-004 audit; deletion pass | Depends on V5; separable. |

Slice 2 before slice 3 is deliberate: if rebuilding the server's primitives on the
shared definitions changes any server behaviour, that must surface while the
client is still uninvolved.

## Structure

```
foundry/packages/
  shared/                        # NEW package, no third-party deps
    src/rules.ts                 # the definitions, as data
    src/rules.cases.ts           # accepted/rejected cases per rule
    README.md                    # what belongs here, and what does not
  server/src/validation/
    primitives.ts                # rebuilt on shared/rules; exports unchanged
    primitives.equivalence.test.ts   # NEW — the FR-003 guarantee
  client/src/lib/
    field-check.ts               # NEW — check(value, rule), common error shape
    manifest-form.ts             # + validation over the constraints it carries
    automation-flow.ts           # error shape aligned; MIN_PROMPT_LENGTH audited
    plan.ts                      # error shape aligned
    build-verdicts.ts            # RENAMED from validation.ts; key unchanged
```

The shared package's README matters more than usual. Without a stated boundary,
"shared" becomes the place everything goes, and the one thing this package must
never hold is anything that makes the client capable of *enforcing* rather than
*previewing*.

## Phase 0 / Phase 1 artifacts

- [research.md](research.md) — what each idiom does, which rules have server
  counterparts, and the ones that appear not to
- [data-model.md](data-model.md) — the rule definition shape and the error shape
- [contracts/shared-rules.md](contracts/shared-rules.md) — invariants as test names
- [quickstart.md](quickstart.md) — per-slice verification
