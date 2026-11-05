# Feature Specification: Request Policy Engine (V8)

**Feature Branch**: `krt/guardrail_validation`

**Created**: 2026-08-06

**Status**: Draft

**Input**: User description: "V8 — Request Policy Engine: a pre-generation guardrail that evaluates whether a user's request complies with application policy before any generation begins. First policy module: originality / commercial-product-cloning detection. Runs after V1 structural validation, before V4 prompt composition. Rules are independent evidence producers (no opaque confidence scores); a combinator reasons over named evidence to produce ALLOW / TRANSFORM / REJECT. Mode-aware: TRANSFORM proposes a rewrite and waits for confirmation where a human is present, and collapses to REJECT where none is — never a silent rewrite. Policy (product names, aliases, distinguishing-feature signatures, intent lexicons) lives as versioned configuration consumed by both client and server via the existing shared-rules pattern (V7), not hardcoded in the engine. The distinguishing-feature dataset is deliberately incomplete; absence of a match defaults to ALLOW. LLM involvement is excluded from the production decision path entirely, for full reproducibility."

---

## The rule this feature must not break

**The production decision is deterministic, full stop.** Given the same request
and the same configuration, the engine produces the same verdict every time — no
model call, no prompt, no temperature setting sits anywhere on the path from
request to ALLOW/TRANSFORM/REJECT. An LLM-assisted advisory reviewer may exist
later as a dataset-maintenance aid, but it is out of this feature's scope
entirely (see Out of Scope), and even when built it must never influence a
production verdict, only suggest configuration changes to a human.

A close second: **TRANSFORM is never a silent rewrite.** Where a human can
confirm it, the engine proposes and waits; where none can, it does not guess —
it refuses and explains. Auto-substituting the user's request with different
words they never approved is a bigger violation of intent than rejecting
outright, and this project's constitution already settled this question
generally (Article XV, "No Silent Side Effects" — generating and executing are
separate, explicit acts; nothing proceeds on an assumption of consent). This
feature is the first place that article's spirit applies to the *request* side
of the pipeline rather than the *execution* side, and the same discipline
applies: propose, do not perform, unless someone can say yes.

Both of these are acceptance criteria for the whole feature, not aspirations.

## Relationship to the existing roadmap (V1–V7)

`docs/validation-and-guardrails-roadmap.md` documents seven prior slices. This
feature is additive to that roadmap, not a revision of it, with one exception
that must be resolved during planning (see Clarifications, Q1).

- **V1 (validation kernel)** checks shape — types, lengths, enums — at the route
  boundary. This feature checks meaning, not shape, and runs as a distinct step
  after V1, not an extension of it.
- **V4 (prompt-boundary guardrails)** protects against a different attacker: content
  the *system* introspects (schema identifiers, tool metadata) being read as
  instruction by the model. V4's spec deliberately leaves the operator's own task
  text unfiltered, for reasons specific to injection defense (§ below, and see
  Q1). This feature is not part of V4 and does not touch its envelope/detection
  mechanism; it is a separate decision that runs before V4's prompt composition
  even begins.
- **V5 (audit verdict as a gate)** established the asymmetric-gate discipline this
  feature reuses: *"findings can block, absence must not permit."* V5's version
  of that runs after generation, over the code; this feature's version runs
  before generation, over the request. Same discipline, different point in the
  pipeline — REJECT-eligible evidence can block, but no rule's silence is treated
  as a green light.
- **V6 (SSRF/egress policy)** established the config-as-data pattern for a
  denylist enforced identically regardless of which layer checks it. This feature
  follows the same shape for its product/lexicon dataset.
- **V7 (client validation coherence)** built the exact mechanism this feature
  reuses rather than reinventing: rule *definitions* as data in `@foundry/shared`,
  consumed by both `packages/client` (fast feedback) and `packages/server`
  (authoritative), proven equivalent by a shared-fixture test. This feature's
  policy configuration should be delivered the same way.

## Pipeline placement

```
Request → V1 (structural validation) → V8 (Request Policy Engine)
                                          ├─ ALLOW     → V4 (prompt boundary) → generation → V5 (audit)
                                          ├─ TRANSFORM → user confirms/edits → V4 → generation → V5
                                          └─ REJECT    → explanation returned, generation never starts
```

The engine runs **twice** in the client's existing step flow
(`packages/client/src/lib/automation-flow.ts`): once at initial request intake,
and again after any clarify/plan step has resolved the request into a fuller set
of stated features. A request phrased softly at intake ("something like
Instagram") can resolve into a feature list that is, in substance, a full
product match — the second pass exists because the decision must be made against
what the request has actually become, not only its first sentence.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An explicit clone request is rejected, with a stated reason (Priority: P1)

A user asks to build Facebook, or to clone Instagram exactly. The system does not
attempt generation. It tells them why: it names the product it recognized and the
reproduction language it matched.

**Why this priority**: this is the problem the feature exists to solve, and the
one place a false negative (an obvious clone slipping through) is most visible
and most costly to the project's stated goal.

**Independent Test**: submit a request naming a cataloged product together with
explicit reproduction language ("clone", "exact copy", "identical to",
"replicate", "rebuild") and confirm the request is rejected before any
generation call is made, with a reason that names the matched product and
matched phrase.

**Acceptance Scenarios**:

1. **Given** a request naming a cataloged product with reproduction intent,
   **When** the request is submitted, **Then** the decision is REJECT and no
   generation call occurs.
2. **Given** a REJECT decision, **When** the response is shown to the user,
   **Then** it names the specific evidence matched (product, intent phrase) —
   not a generic refusal.
3. **Given** the same request submitted twice under the same configuration,
   **When** both are evaluated, **Then** both produce the identical decision and
   the identical stated evidence.

---

### User Story 2 - Category-level and inspiration/alternative requests are never blocked (Priority: P1)

A user asks to build a social media platform, an e-commerce site, a CRM, a
project management tool, or an open-source alternative to a named product, or a
tool that is compatible/interoperable with one. None of these are blocked or
altered.

**Why this priority**: equal in priority to Story 1. A guardrail that blocks
legitimate category-level or competitive-alternative work is a worse outcome
than one that occasionally misses a disguised clone — this is the project's
explicitly stated constraint on the whole feature.

**Independent Test**: submit each of the category-level and alternative-framed
example requests below and confirm every one decides ALLOW.

**Acceptance Scenarios**:

1. **Given** a request describing a software category with no named product
   ("build a social media platform", "build a CRM", "build a video sharing
   platform"), **When** evaluated, **Then** the decision is ALLOW.
2. **Given** a request naming a product together with alternative or
   interoperability language ("an open-source Slack alternative", "a CRM like
   Salesforce", "a PostgreSQL-compatible database", "a browser compatible with
   Chrome extensions"), **When** evaluated, **Then** the decision is ALLOW, even
   though a product name and even a matching feature set are present.
3. **Given** a request describing an existing business model applied to a novel,
   uncataloged domain ("Uber for doctors", "Notion for construction companies"),
   **When** evaluated, **Then** the decision is ALLOW, because no cataloged
   product's signature matches.

---

### User Story 3 - An unnamed but unmistakable clone is offered a transformation, not silently blocked (Priority: P2)

A user describes a product feature-by-feature without ever naming it (e.g., "a
blue social network with friends, pages, marketplace, messenger, and a news
feed") such that the description matches a cataloged product's distinguishing
features closely, with no product name and no explicit reproduction language.
Where a human can respond, the system proposes an original alternative and lets
the user confirm, edit, or decline it rather than proceeding with generation
unmodified or rejecting outright.

**Why this priority**: real, but conditioned on Story 1 and 2 already holding —
this is the hardest edge of the policy, and it is a UX improvement over a bare
reject, not a correctness requirement on its own.

**Independent Test**: submit a request matching a cataloged product's
distinguishing-feature set with no product name present, in a context where
confirmation is available, and confirm the decision is TRANSFORM, not REJECT,
and that nothing proceeds to generation until the user confirms or edits the
proposal.

**Acceptance Scenarios**:

1. **Given** a feature-only description matching a cataloged product's
   signature, with confirmation available, **When** evaluated, **Then** the
   decision is TRANSFORM, and the proposed rewrite is shown to the user before
   anything proceeds.
2. **Given** the same request, **When** the user declines or edits the proposal,
   **Then** their decision — not the system's default — determines what (if
   anything) proceeds to generation.
3. **Given** the same evidence pattern (feature-signature match, no product name,
   no reproduction-intent phrase), **When** decided, **Then** the decision is
   never REJECT on that evidence alone — an explicit product name plus
   reproduction intent is the only pattern permitted to reject unilaterally
   (see FR-010).

---

### User Story 4 - Unattended requests never receive a silent rewrite (Priority: P2)

The same request as Story 3 arrives through a context where no one is present to
confirm a proposal — a scheduled run, an API call, or any other unattended path.
The system does not proceed with a rewritten request the caller never saw.

**Why this priority**: without this, Story 3's UX improvement becomes a
correctness hazard the moment the product supports any non-interactive request
path — silently substituting a request nobody approved is worse than either
alternative.

**Independent Test**: submit the Story 3 request through a context flagged as
having no confirmation available, and confirm the decision is REJECT (with the
same evidence-based explanation TRANSFORM would have used), not an unattended
substitution.

**Acceptance Scenarios**:

1. **Given** evidence that would produce TRANSFORM when confirmation is
   available, **When** the same evidence is evaluated with confirmation
   unavailable, **Then** the decision is REJECT, and the explanation states what
   evidence was matched.
2. **Given** confirmation is unavailable, **When** any decision is produced,
   **Then** no rewritten request is ever sent onward without having been shown to
   and accepted by a human.

---

### User Story 5 - Every decision is explainable from named evidence, and the original request is never lost (Priority: P3)

A developer or support engineer investigating why a request was rejected,
transformed, or allowed can read a decision record that states which named
facts were matched (which product, which phrases, which features present and
absent) rather than an opaque score, and can see the user's original wording
even when it was transformed.

**Why this priority**: important for maintainability and trust, but it does not
change what gets allowed or blocked — it is about being able to answer "why"
after the fact.

**Independent Test**: produce one decision of each kind (ALLOW, TRANSFORM,
REJECT) and confirm each decision record names its evidence in plain terms, and
that the original request text is present in every record, including TRANSFORM
records that also carry the rewritten text.

**Acceptance Scenarios**:

1. **Given** any decision, **When** its record is inspected, **Then** the
   evidence backing it is named (matched product, matched phrases, matched and
   missing features) rather than expressed only as a number.
2. **Given** a TRANSFORM decision, **When** its record is inspected, **Then**
   both the original request and the proposed rewrite are present.
3. **Given** two decisions made under different configuration versions, **When**
   their records are compared, **Then** each record states which configuration
   version produced it, so a change in outcome across a configuration update is
   explainable rather than mysterious.

---

### Edge Cases

- **"Build something similar to Instagram" that later resolves, via clarify/plan,
  into a near-total feature match.** Must be re-evaluated after resolution, not
  only at first submission (see Pipeline placement) — the initial soft phrasing
  must not permanently exempt the resolved request from evaluation.
- **"Rebuild Facebook from scratch" / "Clone Facebook exactly"** — explicit name
  plus explicit reproduction intent → REJECT.
- **"Create a Facebook-like social network" / "Build something similar to
  Instagram"** — explicit name plus inspiration/alternative language, no
  reproduction intent → ALLOW.
- **"Create an open-source Slack alternative"** — explicit name, explicit
  alternative-framing → ALLOW, even though "Slack" is present.
- **"Build an ERP like SAP" / "Build a payment gateway like Stripe"** — same
  pattern → ALLOW.
- **"Build a browser compatible with Chrome extensions" / "Build a
  PostgreSQL-compatible database"** — explicit name, interoperability framing,
  no reproduction intent → ALLOW. Interoperability is a legitimate engineering
  goal and must not be conflated with cloning.
- **"Uber for doctors"** — named business model, novel/uncataloged vertical → ALLOW
  (nothing in the distinguishing-feature dataset matches "doctors").
- **"Uber for restaurants"** — resolves to ALLOW or a match depending only on
  whether "Uber Eats" (or an equivalent) is itself a cataloged product with its
  own signature; there is no separate "occupied vertical" mechanism (see FR-013).
- **A product with no dataset entry at all** (a product too new, or never added)
  — defaults to ALLOW. This is a deliberate trade-off, not a gap to be
  urgently closed (see FR-014, Assumptions).
- **A request whose flagged features have no known safe-substitute mapping in
  the dataset** — TRANSFORM must not guess a rewrite it has no template for;
  it falls back to REJECT-with-explanation, or, where confirmation is available,
  asks the user directly rather than fabricating a substitution (see FR-009).
- **Confirmation-available vs. confirmation-unavailable is a property of the
  calling context (is a human present to respond), not of a specific channel** —
  the same request via a web UI wizard, a CLI, an API call, or a scheduled
  trigger must be classified correctly regardless of which of those it is (see
  FR-011).

## Requirements *(mandatory)*

### Placement and decision shape

- **FR-001**: The system MUST evaluate every request for policy compliance after
  structural validation (V1) and before any prompt is composed or any generation
  call is made.
- **FR-002**: The system MUST re-evaluate the request after any clarify/plan step
  that resolves it into a fuller statement of features, not only at initial
  submission.
- **FR-003**: Every evaluation MUST produce exactly one of three decisions:
  ALLOW, TRANSFORM, or REJECT.

### Rules produce evidence; a combinator decides

- **FR-004**: Individual rules MUST return named, structured facts (e.g., which
  product matched, which phrases matched, which distinguishing features matched
  or were absent) and MUST NOT themselves produce a final ALLOW/TRANSFORM/REJECT
  decision.
- **FR-005**: Rules MUST NOT depend on one another's output or existence. Adding,
  removing, or changing one rule MUST NOT require changing another rule's logic.
- **FR-006**: A single combinator component MUST be the sole place that reasons
  over the full set of evidence produced by all rules and MUST produce the final
  decision plus a plain-language reason built from the named evidence — never
  from a single opaque aggregate score.
- **FR-007**: Each rule MUST declare, as data, which decisions it is capable of
  contributing evidence toward (e.g., whether its evidence alone may justify a
  REJECT); the combinator MUST read this from rule metadata rather than
  containing logic specific to an individual rule's identity.

### Reconciling conflicting signals

- **FR-008**: Reproduction-intent evidence and differentiation/alternative-framing
  evidence (e.g., "alternative to", "compatible with", "interoperable with",
  "like", "similar to", explicit vertical differentiation such as "but for
  [domain]") MUST each be produced by their own independent rule. The combinator,
  not any individual rule, MUST be responsible for reconciling their co-occurrence
  (e.g., treating a strong differentiation signal as suppressing what would
  otherwise be a REJECT-eligible pattern).

### Transformation

- **FR-009**: A TRANSFORM decision's proposed rewrite MUST be assembled from
  versioned, data-driven mappings (flagged distinguishing feature → generic
  substitute, plus fixed boilerplate language about not reproducing branding or
  proprietary workflows), not generated freeform. Where no substitute mapping
  exists for a flagged feature, the system MUST NOT fabricate one — it MUST fall
  back to REJECT-with-explanation, or, where confirmation is available, ask the
  user directly.
- **FR-009a**: Wording produced by this feature (rejection explanations,
  transformation proposals) MAY be phrased with LLM assistance for fluency, but
  the substantive content — which features were flagged, what they were mapped
  to — MUST remain traceable to the data-driven mapping, so the output stays
  verifiable against fixtures independent of wording.

### Mode-awareness

- **FR-010**: The system MUST distinguish two evaluation modes based on whether a
  human can respond to a proposal, not on which UI or channel is involved:
  **confirmation-available** and **confirmation-unavailable**.
- **FR-011**: In confirmation-available mode, a TRANSFORM decision MUST present
  the proposed rewrite to the user and MUST NOT proceed to generation until the
  user confirms it, edits it, or otherwise responds.
- **FR-012**: In confirmation-unavailable mode, any evidence pattern that would
  produce TRANSFORM under confirmation-available mode MUST instead produce
  REJECT, carrying the same evidence-based explanation. No rewrite may be
  auto-applied when no human can approve it.

### REJECT authority

- **FR-013**: Only the combination of an explicit, cataloged product reference
  together with explicit reproduction-intent evidence MAY justify a REJECT
  decision on its own. Capability-signature evidence alone (a feature-set match
  with no explicit product name) MUST NOT justify a unilateral REJECT — its
  strongest reachable outcome on its own is TRANSFORM (or, per FR-012, the
  REJECT that mode produces). This is a stated policy choice: an unnamed request
  that resembles a cataloged product is given the chance to be transformed or
  clarified, not silently or unilaterally rejected.

### Dataset scope, degradation, and vertical differentiation

- **FR-014**: The distinguishing-feature dataset MUST be scoped to products whose
  feature set is genuinely distinguishing (features that are rare enough to
  identify one product, not shared conveniences like login, search,
  notifications, or comments). It is explicitly not required, and is not
  expected, to ever achieve exhaustive coverage of every commercial product.
- **FR-015**: A request or product with no matching dataset entry MUST default to
  ALLOW. This is a deliberate trade-off favoring false negatives (an
  uncataloged clone occasionally passing through) over false positives (a
  legitimate, novel request being blocked or altered).
- **FR-016**: "[Existing business model] for [domain]" requests MUST NOT be
  evaluated against a separate "is this vertical already occupied" mechanism or
  dataset. They are caught only when the domain-specific product itself has its
  own cataloged signature (e.g., a request matches because "Uber Eats" is itself
  a dataset entry, not because "food delivery" is understood as an occupied
  category). An uncataloged domain combination defaults to ALLOW under FR-015.

### Configuration, not code

- **FR-017**: The engine MUST contain no hardcoded product names, aliases,
  feature signatures, or intent phrases. All such content MUST live in versioned
  configuration/data, consumed identically by the client (for fast feedback) and
  the server (as the authoritative check), following the existing shared-rules
  mechanism (`@foundry/shared`, per V7) rather than a new one.
- **FR-018**: The client and server MUST produce identical decisions given the
  same request and the same configuration version. This MUST be verified by an
  equivalence test, per the existing V7 pattern, not left to code review.

### Decision records

- **FR-019**: Every decision MUST be recorded as a structured object containing:
  the decision (ALLOW/TRANSFORM/REJECT), the named evidence considered, a
  plain-language reason derived from that evidence, the original request text,
  the transformed request text (when the decision is TRANSFORM), and the
  configuration version in effect at decision time.
- **FR-020**: The configuration version MUST be stamped on every decision record
  at the time the decision is made, so that a later change in outcome for an
  equivalent request can be attributed to a specific configuration change rather
  than left unexplained.

### Reserved extension points (not implemented by this feature)

- **FR-021**: The engine's entry point MUST accept an explicit, structured
  parameter through which a future policy bypass (administrator override,
  research mode) could be threaded and audited. This feature MUST NOT implement
  any bypass behavior behind it — the parameter exists so a future override is
  additive to a known interface rather than retrofitted as an ad hoc escape
  hatch. No caller in this feature may set it to anything other than its
  not-bypassed default.
- **FR-022**: The combinator and rule interfaces MUST be generic enough that a
  future, unrelated policy concern (e.g., a rule about a different subject
  entirely) could be added as a new rule module without changing the combinator
  or any existing rule's contract. This feature MUST implement only the
  originality/commercial-cloning ruleset; it MUST NOT implement or design the
  content of any other policy module.

### Non-regression

- **FR-023**: No request that would be generated today (prior to this feature)
  and that does not match this feature's REJECT or TRANSFORM criteria MAY be
  blocked or altered by this feature.

### Policy timing (non-retroactivity)

- **FR-024**: Policy evaluation happens exactly once, at code-generation time
  (the `evaluate()` call inside `scriptGenerationService.start()`). A later
  change to `PolicyConfig` (a new product, a bumped `version`, an edited
  lexicon) MUST NOT be retroactively applied to a script already generated or
  an automation trigger already armed under a prior config. Re-evaluating
  policy at trigger-fire time is explicitly out of scope for this feature —
  see Clarifications Q4 for the reasoning.

### Key Entities *(include if feature involves data)*

- **Rule evidence** — a named, structured fact produced by one rule (e.g.,
  matched product, matched intent phrase, matched/missing distinguishing
  features, matched differentiation qualifier). Carries no decision of its own.
- **Rule capability metadata** — data declared per rule describing which final
  decisions its evidence is permitted to contribute toward unilaterally (e.g.,
  whether it may justify REJECT alone).
- **Decision record** — the combinator's output: decision, full evidence set,
  plain-language reason, original request, transformed request (if any),
  configuration version.
- **Product signature** — a configuration entry: a product's name, known
  aliases, and its small set of genuinely distinguishing features (explicitly
  excluding generic, widely shared features).
- **Feature substitute mapping** — a configuration entry pairing a flagged
  distinguishing feature with a generic substitute usable in a TRANSFORM
  proposal (e.g., "stories" → "temporary posts").
- **Intent lexicon** — configuration data distinguishing reproduction-intent
  phrases ("clone", "exact", "rebuild") from differentiation/alternative-framing
  phrases ("alternative to", "compatible with", "like", "but for [domain]").

## Clarifications

### Q1: This feature evaluates the operator's task text for policy compliance. The roadmap already states a non-goal that reads as though it forbids exactly that.

**Context**: `docs/validation-and-guardrails-roadmap.md` §6 states, as a
"deliberate non-goal": *"Filtering the operator's task text — first-party input;
false positives cost more than they prevent (see V4)."* V4's own section makes
clear this was written specifically about **injection-pattern filtering** of task
text — the concern was that scanning first-party task text for "suspicious"
patterns produces false positives on legitimate work, with the real defense
being output audit (V5) and execution confinement (V6). This feature does
something different in kind: it is not scanning for suspicious patterns as an
injection defense, it is evaluating whether the request's *substance* asks for
reproduction of a specific commercial product, a business-policy question V4
never considered and explicitly did not attempt to answer.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Treat the two non-goals as covering different concerns and record an explicit, narrow correction to roadmap §6 during planning — the way §V4/V5/V6/V7 corrections are already recorded elsewhere in the same document — clarifying that the existing non-goal is scoped to injection-pattern filtering, not to originality/policy evaluation. | Keeps the roadmap internally consistent and honest about what changed and why, matching this project's existing convention of recording corrections rather than silently superseding prior text. Requires a small, explicit documentation change alongside this feature. |
| B | Leave roadmap §6 unchanged and treat this feature as silently overriding it. | Cheaper short-term, but leaves a standing document that appears to forbid the very thing this feature does, which is exactly the kind of drift this project's spec-kit discipline exists to prevent. |
| C | Reframe this feature as operating only on resolved plan/feature state, never on raw task text, to avoid touching the non-goal at all. | Does not work: Story 1 (a bare "Build Facebook") must be caught at the first sentence, before any plan/feature resolution exists. Narrowing scope to avoid the roadmap conflict would reintroduce the exact evasion ("just don't say it plainly until after intake") this feature exists to close. |

**Resolution**: **A**, proposed. During `/speckit-plan`, add a corrective note to
`docs/validation-and-guardrails-roadmap.md` §6 (in the same style as its existing
V4/V5/V6/V7 corrections) narrowing the task-text non-goal explicitly to
injection-pattern filtering, and cross-referencing this feature as the place
semantic/policy evaluation of task text now lives. This keeps the roadmap
accurate rather than quietly contradicted.

### Q2: Rule 1 (product reference + reproduction intent) must not reject legitimate interoperability/alternative requests — how is that reconciled with rules being independent and never deciding outcomes?

**Context**: FR-013 permits a REJECT based on product-reference and
reproduction-intent evidence, but "Build an open-source Slack alternative" and
"Build a PostgreSQL-compatible database" also reference a named product and
must not be rejected. If the product-reference rule suppressed its own match
upon detecting "alternative" or "compatible" language, that rule would be making
an outcome judgment, which FR-004/FR-005 forbid.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Differentiation/alternative-framing detection is its own independent rule (FR-008), producing its own evidence fact, never embedded in the product-reference or intent-detection rules. The combinator is the sole place that reconciles "reproduction-intent evidence present + differentiation evidence present" into a non-REJECT outcome. | Keeps every rule genuinely independent (FR-005) while still preventing the false positive. This is the same reconciliation pattern already needed for vertical-differentiation phrasing ("but for [domain]"), so it is one mechanism, not a special case for Rule 1. |
| B | Embed alternative/interoperability detection inside the product-reference rule itself. | Simpler to write, but violates FR-004/FR-005 (a rule producing an outcome-aware judgment) and does not generalize to the vertical-differentiation case, which needs the identical reconciliation logic. |

**Resolution**: **A**, already reflected in FR-008. Recorded here because it is
easy to misread FR-013's "product reference + reproduction intent" wording as
implying the product-reference rule itself decides when to stand down, rather
than the combinator doing so from independently-produced evidence.

### Q3: "Interactive" vs. "automation" mode terminology

**Context**: earlier design discussion used "interactive" and "automation" to
distinguish the two evaluation modes, then reconsidered: a scheduled run, a CLI
invocation, an API call, and a future MCP-driven caller are all "automation" in
different senses, but the property that actually matters is only whether a
human can respond to a proposal.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | Name the modes by the property that matters — **confirmation-available** / **confirmation-unavailable** — as done throughout this spec (FR-010). | Accurately describes the distinguishing property regardless of how many calling contexts exist later; avoids the terminology implying a fixed, closed list of channels. |
| B | Keep "interactive"/"automation" naming. | Understandable today, but couples the concept to today's two known contexts (wizard UI vs. everything else) rather than to the actual property being tested. |

**Resolution**: **A**. Purely a naming decision with no behavioral effect;
recorded so planning does not reintroduce the narrower terms.

### Q4: Does a change to `PolicyConfig` apply to automations that were already generated and armed under an earlier version? (added 2026-08-12, post-merge audit)

**Context**: a pre-merge audit noted that `trigger.service.ts`/
`trigger-scheduler.ts` fire an already-generated script's stored code without
calling `requestPolicyService` again, and asked whether that is a gap or a
deliberate design choice — e.g. if `policyConfig.version` is later bumped to
newly disallow a pattern, an automation generated and armed under the older,
looser config keeps firing indefinitely with no re-check.

| Option | Answer | Implications |
|--------|--------|--------------|
| A | **Generation-time only.** Policy is evaluated once, when generation is requested (FR-024). Existing generated/armed automations are never retroactively re-evaluated when the dataset changes. | Simple, matches the current implementation exactly (no code change required). A legitimately-approved automation cannot be silently broken by an unrelated later policy edit — an operator would reasonably not expect a dataset change made for a new product to affect automations that have nothing to do with that product. Trade-off: a dataset tightened specifically to close a gap does not retroactively close it for automations that already exploited that gap. |
| B | **Continuous re-evaluation.** Every scheduled/webhook/manual trigger fire re-runs `evaluatePolicy` against the script's original task text before executing. | Closes the retroactivity gap, but introduces a new failure mode this feature does not otherwise have: an automation that ran successfully yesterday could start failing today with no code or data change on the operator's side, for a reason (a policy dataset edit) invisible from the Triggers page. Also couples an unrelated policy-authoring action (adding a new product) to the availability of existing, unrelated automations. |

**Resolution**: **A**. Continuous re-evaluation (Option B) is a materially
different feature — it changes what "armed" means, needs its own failure UX
for "this automation was disabled by a policy change," and has product
implications for every existing automation, not just future ones. It is not
adopted here. `trigger.service.ts`/`trigger-scheduler.ts` require no code
change for this decision — confirmed by the same audit that neither calls
`requestPolicyService` today, which is FR-024's already-correct behavior, now
recorded as a spec-level decision rather than left implicit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every request in a fixture set of explicit clone requests (naming a
  cataloged product with reproduction intent) is rejected before any generation
  call, 100% of the time, under a fixed configuration version.
- **SC-002**: Every request in a fixture set of category-level requests (no
  named product) and alternative/interoperability-framed requests (named
  product, no reproduction intent) is allowed, 100% of the time, under the same
  configuration version — zero false positives across that set.
- **SC-003**: For a fixture set of unnamed-but-feature-matching requests, the
  decision is TRANSFORM under confirmation-available evaluation and REJECT under
  confirmation-unavailable evaluation for the identical evidence, 100% of the
  time — never a silent pass-through and never a silent rewrite.
- **SC-004**: Client and server produce an identical decision for every fixture
  request under the same configuration version, verified by an automated
  equivalence check, not sampled review.
- **SC-005**: Every decision record, inspected after the fact, allows a
  developer to state which named evidence produced the decision without
  reference to any numeric score.
- **SC-006**: Changing the configuration dataset (e.g., adding a product entry)
  changes only the decisions attributable to that entry, verified by a
  regression fixture set that asserts unrelated requests are unaffected.
- **SC-007**: No fixture request that was previously generated without incident
  (prior to this feature) becomes blocked or altered unless it matches this
  feature's stated REJECT or TRANSFORM criteria.

## Assumptions

- The distinguishing-feature dataset starts small and grows over time by
  data-only changes (no engine code changes); comprehensive product coverage is
  explicitly not a goal of this or any single iteration (FR-014).
- Ownership of what enters the product/lexicon dataset (which products, which
  features count as distinguishing, which phrases count as reproduction vs.
  alternative framing) is an organizational decision outside this feature's
  scope; this feature only requires that the content be expressible as
  reviewable configuration, not that a specific team maintain it.
- The client's existing step-flow mechanism (`automation-flow.ts`) is the
  integration point for the second, post-resolution evaluation pass; no new
  step-flow mechanism is introduced.
- V7's `@foundry/shared` package and equivalence-testing pattern are suitable
  vehicles for this feature's configuration and are extended rather than
  replaced.

## Out of Scope

- **Any LLM involvement in the production decision path.** Deterministic only,
  for full reproducibility across model, prompt, or temperature changes.
- **An LLM-assisted advisory reviewer** (dev-facing, suggesting possible dataset
  gaps, never affecting execution) — deferred entirely to a future feature. Not
  designed, not stubbed, to avoid shipping an unused review channel with no
  defined consumption workflow.
- **Explanations for non-matches** ("why wasn't this considered a match for
  product X") — deferred.
- **Implementing an administrator/research-mode override system** — only the
  reserved, unused interface parameter is in scope (FR-021); the override
  behavior itself is a future feature.
- **Any policy module other than originality/commercial-product-cloning** —
  dangerous-software generation, credential harvesting, copyright, privacy, and
  org-specific policy are explicitly future rule modules under the same
  interface (FR-022), not designed or scoped here.
- **Post-generation brand/trademark scanning of generated code output** —
  remains a V5 (audit) concern if wanted later, not an intake concern.
- **Any change to V4's prompt-boundary envelope or detection mechanism.** This
  feature's own output (a TRANSFORM rewrite) is the engine's own content and is
  not subject to V4's untrusted-content wrapping; the original user request is
  preserved separately for audit/support purposes, not passed through V4's
  detector.

## Dependencies

- V1's request-validation boundary, as the step immediately preceding this
  feature.
- V7's `@foundry/shared` package and its dual-enforcement, equivalence-tested
  pattern, as the delivery mechanism for this feature's configuration.
- The client's `automation-flow.ts` step machine, as the integration point for
  both evaluation passes.
- A corrective update to `docs/validation-and-guardrails-roadmap.md` §6 (see
  Clarifications Q1), to be made during `/speckit-plan`.

## Standards impact

`.specify/memory/security.md` and `.specify/memory/constitution.md` are likely
unaffected in substance — this feature's core discipline (deterministic gate,
asymmetric authority, no silent side effects) already follows existing
constitution articles (X, XV) rather than introducing new principles. The one
required documentation change is the roadmap correction in Clarifications Q1,
which is a narrowing/correction of existing text, not a new standard.

## Backfilled additions 2026-08-12

A pre-merge senior-engineering audit of this already-implemented feature
found five issues, fixed four in code and documented one product decision
that required no code change. Regularized per constitution Article I
(`tasks.md`'s `T064`–`T069`). No user-facing behavior changed except that a
decision's `configVersion` is now visible over HTTP (it was already computed,
just not sent) — see `contracts/generate-script-policy-response.md`.

- **FR-024** and **Clarifications Q4** (added above): policy evaluation is
  generation-time-only and non-retroactive — an explicit product decision,
  not a gap, made durable here rather than left to a source comment.
- **T015** corrected: its original claim that `canRejectAlone` drives the
  combinator's dispatch was inaccurate; the field is reserved metadata, not
  yet consulted. See T015's inline correction and T065.
- The HTTP contract for `POST /:workspaceId/scripts`'s `transform`/`reject`
  responses was missing `configVersion`, which the internal `PolicyDecision`
  already carried (T022/FR-020). Contract and implementation now agree
  (T066/T067).
