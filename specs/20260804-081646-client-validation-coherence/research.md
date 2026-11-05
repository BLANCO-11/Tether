# Research — V7 Client-Side Validation Coherence

Read out of the code on 2026-08-04.

## F1 — The client has no path to the server's rules

`packages/client/package.json` dependencies: `@fontsource/inter`,
`@fontsource/jetbrains-mono`, `jose`, `next`, `next-auth`, `react`, `react-dom`.
No zod. No form library. **No dependency on `@foundry/server`**, and grepping the
client for `@foundry/server` or `@foundry/shared` returns nothing.

The workspace (`pnpm-workspace.yaml`: `packages/*`) contains `client`,
`mcp-bridge`, `server`. There is no shared package.

**Consequence**: sharing requires either a new package (spec Q1 A/B) or the API
(Q1 C). There is no third option that is not duplication.

## F2 — V1's primitives, and their exact messages

`packages/server/src/validation/primitives.ts`:

| Export | Rule | Message |
|---|---|---|
| `zUuid` | `z.string().uuid()` | zod default |
| `zEnvVarName` | 1–255, `/^[A-Za-z_][A-Za-z0-9_]*$/` | "must be an env-var identifier (letters, digits, _)" |
| `zIdentifier` | 1–128, `/^[a-zA-Z_][a-zA-Z0-9_-]*$/` | "Must be a valid identifier" |
| `zHttpUrl` | `z.string().url()` + `/^https?:\/\//i` | "Must be an http or https URL" |
| `zPositiveInt` | int, positive | zod default |
| `zIsoDate` | datetime with offset | zod default |
| `zIsoDay` | `/^\d{4}-\d{2}-\d{2}$/` | "must be YYYY-MM-DD" |
| `zYearMonth` | `/^\d{4}-(0[1-9]|1[0-2])$/` | "must be YYYY-MM" |
| `zNetworkMode` | `z.enum(["none","bridge"])` | zod default |
| `emptyAsAbsent` | preprocessing helper | n/a |

Two notes that affect the design:

- **The messages are inconsistent in register** — "must be…" and "Must be…" both
  appear. FR-002 requires the client to use the server's message, so these move
  verbatim. **Do not improve them in this feature**: a message change is a
  behaviour change and hiding one inside a refactor is how a regression gets
  attributed to the wrong commit.
- **`zEnvVarName` carries a deliberate looseness.** Its comment records that
  case-insensitivity was kept because tightening to uppercase-only would reject
  requests that succeed today. That reasoning must survive into the shared
  definition, comment and all, or someone will "tidy" it.

## F3 — `zNetworkMode` is an orphan

Grepped: it appears in `primitives.ts` and `primitives.test.ts` and **nowhere
else**. `routes/scripts.ts:166` still does `req.body?.network !== false` with a
comment preserving the boolean semantics deliberately, because the boolean→enum
migration is a breaking API change deferred to its own PR.

**Consequence for this feature**: none, deliberately. It is out of scope and is
recorded because this feature will notice the orphan and someone will be tempted
to wire it. It is also a useful illustration: a primitive that exists, is tested,
and has no consumer is what validation infrastructure without a consumer looks
like — the exact failure this feature is meant to prevent for the client.

## F4 — The three idioms, precisely

**`lib/automation-flow.ts` (217 lines)** — `gateFor(step, state) → Gate` where
`Gate = { ok: boolean; reason: string }`. Flow control over accumulated wizard
state. Also exports `MIN_PROMPT_LENGTH = 20`, used in `gateFor`'s `describe`
branch.

**`lib/plan.ts:178 validatePlan(steps) → string[]`** — walks a recursive
`PlanStep[]`, collecting plain-English problems: no steps at all, a step with no
title, a condition path with no steps. Structural, not field-format.

**`lib/manifest-form.ts` (106 lines)** — `jsonSchemaToFields(schema) → FormField[]`.
Carries `required`, `min`, `max`, `integer`, `secret` from the JSON Schema onto
each field descriptor. **Nothing checks a value against them.** The seam is a
rendering seam; making it validate is work, not adoption.

Three shapes: `{ ok, reason }`, `string[]`, and field descriptors that do not
validate. No shared vocabulary.

## F5 — `lib/validation.ts` is a go-live gate in browser storage

64 lines. Key `foundry.validatedBuilds.v1`. Records, per channel, the hash of the
prompt template that passed a real test build. `isValidated(channelId, template)`
is true only if the *current* template hashes to the recorded version — so editing
the prompt invalidates the verdict, which is the intended edit-invalidation.

Its header argues it is fail-safe: a cleared or mismatched store reads as "not
validated", so it can only block a go-live, never permit one.

**That reasoning is sound for the failure it considers and does not cover the
adversary.** It is not a control against someone editing their own localStorage,
and it is no control at all for a caller who never opens the browser.

**Consequence**: this matters because **V5 adds a real server-side gate on
arming**. Two gates that can disagree is worse than one. US4 reconciles them, with
the rule that the local store may block and never permit (FR-013) — which is what
this module already claims about itself, made true against the server rather than
only against a cleared store.

Also: it correctly guards `typeof window === "undefined"` for SSR. The replacement
must keep that.

## R1 — Which client rules have a server counterpart? (SC-004)

**A task, not a finding.** SC-004 requires enumerating every rule the client
enforces and locating its server counterpart. Two are already suspect:

- **`MIN_PROMPT_LENGTH = 20`.** Is there a server-side minimum on the generation
  task? If not, this is a client-only rule, which FR-006 forbids. Two acceptable
  outcomes: derive it from a server rule that exists, or **record it as a finding**
  for a future server-side feature. Not acceptable: leave it unexamined.
- **`validatePlan`'s structural rules.** The plan is assembled client-side before
  anything is sent. If no server-side validation of plan structure exists, these
  are client-only by construction. That may be a legitimate FR-006 exception —
  the plan may never be submitted as such — but it must be *written down* as one,
  not discovered later.

The outcome of this audit is a table in `notes.md`, and any client-only rule is a
finding for a separate feature. Adding server rules here would be a behaviour
change with its own regression risk, in a feature whose whole point is that the
client is not the enforcement.

## R2 — Which server rules cannot travel to the client?

FR-005: the client must not check what it cannot express, and must not
approximate.

- **`tool.schema.ts`'s `superRefine` auth rules** (lines ~28–60) are cross-field:
  which of `secretEnvName`, `authStyle`, `authParamName` are required depends on
  the others, and on `isDummy`. A single-field rule table cannot express this.
- **Uniqueness** of any kind — the client does not have the data.
- **The egress policy** that V6 introduces: it needs DNS. The client can check the
  *scheme* (a single-field rule) and must not attempt the address check.

Plan D1's choice of plain data over shared zod is partly *because* of this: a
data-only format makes the inexpressible cases obviously inexpressible, rather
than tempting someone to approximate them.

## R3 — What does the shared error shape need to carry?

The three existing idioms want different things: `gateFor` wants a single reason
string, `validatePlan` wants a list, forms want per-field problems.

**Decision**: one shape — `{ field, rule, message }` — with a list of them as the
universal return. `gateFor` returns a list of zero or one; `validatePlan` returns
a list with `field` naming the step; forms return one per invalid field.

**Rationale**: the alternative — a union of three shapes — is not one idiom, it is
three idioms with a shared name. A list of zero or one is mildly awkward at exactly
one call site, and it is the price of every consumer being able to render problems
the same way without knowing which producer made them.

## R4 — Does the rename need to change the storage key?

**Decision**: no. Keep `foundry.validatedBuilds.v1`.

**Rationale**: the key is an on-disk contract with every existing browser; the
module name is not. Changing it invalidates every recorded verdict and forces
every user to re-validate. Fail-safe, and not free. There is no reason to pay it
for a rename, and FR-011 exists so that paying it would have to be a stated
decision rather than a side effect of a `sed`.
