# Feature Specification: Client-Side Validation Coherence

**Feature Branch**: `krt/guardrail_validation`

**Created**: 2026-08-04

**Status**: Draft

**Input**: User description: "Client-side validation coherence (roadmap slice V7). The client has three unrelated validation idioms: automation-flow.ts gates, plan.ts:178 validatePlan returning human strings, and manifest-form.ts's declarative FormField. There is no zod and no form library. Adopt one idiom — recommendation: extend the existing declarative manifest-form.ts seam rather than introducing a form library, since it already derives fields from the backend's JSON Schema, which is the only approach that keeps client and server rules from drifting. Share the primitives from V1 so the client rejects what the server would reject, with the same message; this is the actual win, without it client validation is decoration. Do not let client validation become the guardrail — it is UX, and every rule must exist server-side first. Naming hazard: packages/client/src/lib/validation.ts is NOT input validation — it is a localStorage record of which prompt versions passed a real test build. Rename it as part of this slice. Branch: krt/guardrail_validation, no new worktree."

---

## The rule this feature must not break

**Client validation is UX. It is never the guardrail.** Every rule it enforces
must already exist and already be enforced on the server. A rule that exists only
on the client is not a rule — it is a suggestion to anyone using `curl`.

That sentence is the acceptance criterion for the whole feature, and it decides
the design: the client must **derive** its rules from the server's, never author
them. A hand-copied regex in a React component is the shape this feature exists to
remove, and re-introducing it in a nicer wrapper would be a regression dressed as
a refactor.

## What is actually there, measured 2026-08-04

### Three idioms, no overlap

| Idiom | File | Shape | What it guards |
|---|---|---|---|
| Step gates | `lib/automation-flow.ts` (217 lines) | `gateFor(step, state) → { ok, reason }`, plus `MIN_PROMPT_LENGTH = 20` | whether the wizard may advance |
| Problem lists | `lib/plan.ts:178 validatePlan` (194 lines) | `PlanStep[] → string[]` of plain-English problems | whether a plan can be tested |
| Declarative fields | `lib/manifest-form.ts` (106 lines) | `jsonSchemaToFields(schema) → FormField[]` | connector onboarding forms |

They share no vocabulary, no error shape, and no source of truth. `gateFor`
returns `{ ok, reason }`; `validatePlan` returns `string[]`; `manifest-form`
returns field descriptors carrying `required`, `min`, `max` and never validates
anything against them.

### The client cannot currently share anything with the server

- `packages/client/package.json` has **no zod** and no dependency on
  `@foundry/server`. There is no shared package: the workspace is
  `client`, `mcp-bridge`, `server`.
- V1's primitives — `zUuid`, `zEnvVarName`, `zIdentifier`, `zHttpUrl`,
  `zPositiveInt`, `zIsoDay`, `zYearMonth` — live in
  `packages/server/src/validation/primitives.ts` and are **unreachable** from the
  client.

So today the client either duplicates a rule or does not enforce it. Both happen.

### `manifest-form.ts` is the seam the roadmap points at, and it does not validate

Worth being precise, because the roadmap's recommendation reads as though the
mechanism already exists. `jsonSchemaToFields` **describes** fields — it carries
`required`, `min`, `max`, `integer` from the JSON Schema into `FormField` — and
nothing in the client checks a value against them. The seam is a rendering seam
today; making it a validating seam is work, not adoption.

It is still the right seam, for the reason the roadmap gives: the rules come from
the backend, so they cannot drift. This spec just does not pretend the second half
is already built.

### `lib/validation.ts` is not input validation, and the name is not the worst of it

64 lines. It is a **localStorage record** of which prompt versions passed a real
test build, keyed by channel, used to decide whether a trigger may go Live. Its own
header says so. The rename is the roadmap's stated task.

But reading it surfaces something the roadmap does not mention. This is a
**go-live gate implemented in browser storage**. Its comment argues it is
fail-safe — a cleared store reads as "not validated", so it can only block, never
permit — and that reasoning is sound *for the failure it considers*. It is not a
control against anyone who edits their own localStorage, and it is not a control
at all for a caller who does not use the browser.

This matters here because **V5 introduces a real server-side gate on arming**. A
client-side go-live gate and a server-side arming gate that disagree is a worse
outcome than either alone. Reconciling them is in scope for this feature (US4).

### A concrete artefact of the shared-primitives gap

`zNetworkMode = z.enum(["none", "bridge"])` exists in the server's primitives and
is tested — and is used by **no production code**. `routes/scripts.ts:166` still
reads `req.body?.network !== false` with a comment preserving the boolean
semantics on purpose, because the boolean→enum change is a breaking API change that
was deliberately deferred to its own PR.

A primitive that exists, is tested, and is wired to nothing is exactly what
"validation infrastructure without a consumer" looks like. It is not this
feature's job to wire it — the deferral is correct — but it is a useful concrete
reminder that shared *definitions* are only worth having when something reads
them.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The client rejects what the server would reject, with the same words (Priority: P1)

An operator types a tool name with a space, an env-var name starting with a digit,
or a URL with no scheme. The form tells them immediately, using the same words the
server would have used, and the request is never sent.

**Why this priority**: This is the actual win the roadmap names. Without it, client
validation is decoration — the operator gets a friendly nudge for some rules and a
raw 400 for others, with no way to predict which.

**Independent Test**: For each shared primitive, submit a value the server rejects
and confirm the client rejects it first, with a message that matches the server's.

**Acceptance Scenarios**:

1. **Given** a value that violates a shared rule, **When** the operator enters it,
   **Then** the client rejects it before any request is made, with the server's
   message.
2. **Given** a value the server accepts, **When** the operator enters it, **Then**
   the client accepts it. No rule is stricter on the client — a client stricter
   than the server blocks legitimate work and cannot be diagnosed from the API.
3. **Given** a rule that changes on the server, **When** the change ships,
   **Then** the client's behaviour changes with it without a separate edit.
4. **Given** the client's checks are bypassed entirely, **When** the request
   reaches the server, **Then** the server still rejects it. The client check is
   never the enforcement.

---

### User Story 2 - One idiom, one error shape (Priority: P2)

A developer adding a new form has one way to express "this field must look like
X", and every surface reports problems the same way.

**Why this priority**: real and secondary. It is a maintainability win rather than
a correctness one, and it only pays off once US1 supplies something to be coherent
*about*.

**Independent Test**: Add a new validated field to an existing form using only the
adopted idiom, with no new bespoke checking code.

**Acceptance Scenarios**:

1. **Given** the adopted idiom, **When** a developer adds a validated field,
   **Then** no hand-written regex or bespoke check is required.
2. **Given** any validated surface, **When** it reports a problem, **Then** the
   problem has the same shape as every other surface's.
3. **Given** the three existing idioms, **When** this feature completes, **Then**
   each has been migrated, or its continued separate existence is justified in
   writing. `gateFor` decides *flow*, not field validity, and may well be the
   justified case — see Q2.

---

### User Story 3 - `validation.ts` says what it is (Priority: P2)

A developer looking for input validation does not find a localStorage build-verdict
store, and vice versa.

**Why this priority**: cheap, and the confusion is guaranteed rather than
hypothetical — this feature is *about* client validation and the file named
`validation.ts` has nothing to do with it.

**Independent Test**: The file is renamed, every import updated, the suite green,
and no file named `validation.ts` holds non-validation logic.

**Acceptance Scenarios**:

1. **Given** the renamed module, **When** the suite runs, **Then** it passes with
   no stale imports.
2. **Given** the renamed module, **When** a developer greps for validation,
   **Then** they find validation.
3. **Given** the rename, **When** the stored localStorage key is considered,
   **Then** existing users' recorded verdicts are not silently invalidated — or,
   if they are, that is stated and deliberate (see Edge Cases).

---

### User Story 4 - The two go-live gates agree (Priority: P3)

An operator is not told by the browser that an automation is ready to go live and
by the server that it is not — or the reverse.

**Why this priority**: P3 because it depends on V5 having shipped, and because it
is a coherence problem rather than a hole. It is in scope because this is the
feature that touches the client-side gate, and leaving two disagreeing gates in
place after touching one of them would be the worse outcome.

**Independent Test**: With a script the server refuses to arm, confirm the client
does not present it as ready to go live.

**Acceptance Scenarios**:

1. **Given** a script the server would refuse to arm, **When** the client shows
   the go-live control, **Then** it reflects the server's decision.
2. **Given** the browser's local verdict store is cleared, **When** the operator
   returns, **Then** the server's decision still governs; the local store may
   block, never permit.
3. **Given** the two disagree, **When** the operator sees the surface, **Then**
   the server's answer is the one presented.

---

### Edge Cases

- **A server rule the client cannot express** — a cross-field rule such as
  `tool.schema.ts`'s `superRefine` auth rules. The client must degrade to *not
  checking* rather than to *guessing*. A client that approximates a server rule
  and gets it wrong is worse than one that does not check: it produces confident
  wrong answers.
- **A server rule that requires data the client does not have** — uniqueness, for
  instance. Same answer: do not check.
- **The client being stricter than the server.** This is the failure mode nobody
  looks for, because it produces no error report — the operator simply cannot do
  something and assumes they are wrong. US1 scenario 2 exists for it.
- **A rule change that reaches only one side.** The design must make this
  impossible rather than caught; see Q1.
- **The localStorage key on rename.** Changing the key silently invalidates every
  recorded verdict, which forces re-validation. That is fail-safe and it is not
  free — it is a real cost to real users. Keep the key, or change it deliberately
  and say so.
- **Server-rendered/SSR paths.** `validation.ts` already guards
  `typeof window === "undefined"`; the replacement must keep that.

---

## Requirements *(mandatory)*

### Shared rules

- **FR-001**: The rules the client enforces MUST be **derived** from a single
  definition that the server also uses. The client MUST NOT author a rule.
- **FR-002**: The client's message for a shared rule MUST be the server's message.
- **FR-003**: A change to a shared rule MUST take effect on both sides without a
  second edit. This MUST be structurally guaranteed, not a review convention
  (see Q1).
- **FR-004**: The client MUST NOT be stricter than the server for any shared rule.
- **FR-005**: Where a server rule cannot be expressed on the client, the client
  MUST NOT check it at all, rather than approximate it.
- **FR-006**: Every rule enforced on the client MUST already be enforced on the
  server. This feature MUST NOT introduce a rule that exists only on the client.

### One idiom

- **FR-007**: The client MUST have one declarative way to express field validation
  and one error shape.
- **FR-008**: Each of the three existing idioms MUST be migrated to it, or its
  continued separate existence MUST be justified in writing in the plan.
- **FR-009**: The adopted idiom MUST extend the existing `manifest-form.ts` seam
  rather than replace it — it already carries backend-derived constraints and is
  the only current mechanism whose rules cannot drift.

### Naming

- **FR-010**: `packages/client/src/lib/validation.ts` MUST be renamed to describe
  what it holds — a record of which prompt versions passed a real test build.
- **FR-011**: The rename MUST NOT silently invalidate existing recorded verdicts.
  If the storage key changes, that MUST be a stated decision.

### Gate coherence

- **FR-012**: Where the client presents a go-live or arming affordance, it MUST
  reflect the server's decision.
- **FR-013**: The local verdict store MAY block a go-live and MUST NOT permit one
  the server would refuse.

### Non-regression

- **FR-014**: No value the client accepts today MAY be rejected after this
  feature, unless the server also rejects it.
- **FR-015**: No new runtime dependency MAY be added to the client without
  justification in the plan (Article IV). The client currently has no validation
  library and no form library.

---

## Clarifications

### Q1: How are the rules actually shared, given the client has no zod and no dependency on the server?

**Context**: FR-001 and FR-003. `packages/client/package.json` lists no zod and no
`@foundry/server`. V1's primitives are zod schemas in the server package. There is
no shared package in the workspace.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | **A shared package of rule *definitions as data*** — regex source, bounds, message text — which the server wraps into zod primitives and the client applies directly. | No new runtime dependency for the client (FR-015). One definition, two consumers, and a test can assert every server primitive is built from the shared table — which makes FR-003 structural rather than a convention. The definitions are plain data, so the client stays library-free. Cost: a new workspace package and its build wiring. |
| B | **A shared package of zod schemas**, with zod added to the client. | Most expressive — cross-field rules travel too. Adds a runtime dependency to the client for validation it is not allowed to rely on anyway (FR-006), which is a poor trade. Also drags zod into the Next bundle. |
| C | **The server serves the rules over the API**, extending the manifest-form JSON-Schema seam to cover every validated form. | The roadmap's literal recommendation, and it cannot drift by construction. But it makes every form asynchronous and unable to validate offline or before its schema loads, and it requires the server to publish a schema for surfaces that have none today. Much larger. |
| D | Duplicate the rules in the client. | The status quo, restated. Fails FR-003. |

**Resolution**: **A**, proposed. It satisfies FR-003 structurally — the test that
every server primitive derives from the shared table is the guarantee, and it is a
test rather than a habit — while keeping the client free of a validation
dependency it must not lean on. C stays the right long-term direction for
connector forms specifically, where the seam already exists and the schema is
already served; A and C are compatible, and A is what makes the rest of the
client's forms coherent now.

### Q2: Does `gateFor` migrate, or stay?

**Context**: FR-008. `automation-flow.ts`'s `gateFor(step, state) → { ok, reason }`
decides whether the wizard may advance. That is a **flow** decision over
accumulated state, not a field-validity decision.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Keep `gateFor` as a distinct, documented idiom; align only its error *shape* with the adopted one. | Honest: they are different problems. "May this step advance" is not "is this field valid". Forcing them into one abstraction produces an abstraction that fits neither. |
| B | Migrate everything into one mechanism. | One idiom, literally. Likely to produce a field validator carrying wizard-flow state, which is the kind of unification that gets unwound a year later. |

**Resolution**: **A**, proposed — with the justification written into the plan as
FR-008 requires, so that "we did not migrate this one" is a recorded decision
rather than an omission. `MIN_PROMPT_LENGTH = 20`, however, **is** a field rule
living in the flow module, and it should move or be derived from the shared
definition if the server has a corresponding rule. If the server has none, that is
a finding: it is a client-only rule, which FR-006 forbids.

### Q3: Does `validatePlan` migrate?

**Context**: `validatePlan` returns `string[]` of plain-English problems about a
**tree of plan steps** — structural problems ("this path has no steps"), not field
formats.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Keep the traversal; align the returned shape with the adopted error shape. | The traversal is the value and it is not field validation. Aligning the shape gets the coherence win without a contorted mapping. |
| B | Express the whole plan as a schema and validate declaratively. | Uniform, and considerably more machinery for a recursive structure whose rules are three lines of traversal. |

**Resolution**: **A**, proposed. Same reasoning as Q2: coherence of the *reporting*
shape is the win worth having; forcing a tree walk into a field-schema idiom is
not.

**Note**: `validatePlan`'s rules are client-only — they govern a plan the client
assembles before anything is sent. FR-006 says every client rule must exist
server-side. Whether the plan structure is validated server-side at all needs
checking during planning; if not, this is either an FR-006 exception that must be
written down, or a server-side gap this feature surfaces rather than closes.

---

## Key Entities

- **Shared rule definition** — a named rule: its pattern or bounds, its message,
  and what it applies to. One definition, consumed by both packages.
- **Validation result** — the single error shape every client surface reports:
  which field, which rule, what message.
- **Build verdict record** — the renamed localStorage store: which prompt version
  passed a real test build, when, and for which channel.

---

## Success Criteria *(mandatory)*

- **SC-001**: For every shared rule, a value rejected by the server is rejected by
  the client with the same message — verified rule by rule, not sampled.
- **SC-002**: For every shared rule, a value accepted by the server is accepted by
  the client. The client is nowhere stricter (FR-004).
- **SC-003**: Changing a shared rule's definition changes both sides, proven by a
  test that fails if a server primitive stops deriving from the shared definition.
- **SC-004**: No rule is enforced on the client that is not enforced on the server.
  Verified by enumerating the client's rules and finding each one's server
  counterpart — including `MIN_PROMPT_LENGTH`.
- **SC-005**: Adding a validated field to an existing form requires no bespoke
  checking code.
- **SC-006**: No file named `validation.ts` in the client holds non-validation
  logic, and existing recorded verdicts survive the rename.
- **SC-007**: The client presents no go-live affordance the server would refuse.
- **SC-008**: No new runtime dependency in `packages/client`, or one justified in
  the plan.
- **SC-009**: Every value accepted before this feature is still accepted, unless
  the server rejects it (FR-014).

---

## Assumptions

- V1's primitives are the correct rules. This feature shares them; it does not
  re-litigate them.
- The client's existing forms are the scope. No new forms are built.
- V5 has shipped or will ship before US4; if not, US4 defers and the rest lands.
- No visual redesign. This is behaviour and structure.

---

## Out of Scope

- **Introducing a form library.** The roadmap recommends against it and nothing
  found here changes that.
- **Adding zod to the client** — unless Q1 is overturned to option B.
- **Making client validation authoritative.** It is UX. Permanently.
- **New server-side rules.** If planning finds a client rule with no server
  counterpart (a real possibility for `MIN_PROMPT_LENGTH` and for `validatePlan`),
  that is **recorded as a finding**, not closed here. Adding server rules is a
  server feature with its own behaviour change and its own regression risk.
- **The `network` boolean→enum change**, and wiring the orphaned `zNetworkMode`
  primitive. Breaking API change; its own PR. Named here because this feature will
  notice the orphan.
- **Redesigning `manifest-form.ts`'s JSON-Schema handling** beyond adding
  validation to what it already describes.

---

## Dependencies

- V1's `packages/server/src/validation/primitives.ts` — the rules being shared.
- V5, for US4 only.
- The existing `manifest-form.ts` seam.

---

## Standards impact

Likely none. `security.md` should **not** be amended to claim client-side
validation as a control — it is not one, and recording it as one would be exactly
the misreading FR-006 exists to prevent. If planning finds client-only rules
(FR-006 violations that predate this feature), those are recorded as findings for
a future server-side feature, not as a standards change.
