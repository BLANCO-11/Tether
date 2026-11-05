# V7 implementation notes — Client-Side Validation Coherence

## T001 — Pre-feature baseline (2026-08-05)

```
pnpm -r typecheck                        → clean, all packages
pnpm --filter @foundry/server test       → 56 files, 902 passed | 23 skipped (925)
pnpm --filter @foundry/client test        → 13 files, 212 passed
pnpm --filter @foundry/mcp-bridge test    → 2 files, 49 passed
```

This is post-V6 (V6 is committed on this branch: slices 1-6 plus the T067
comply fix). V5 is also shipped and committed, so Phase 7 (US4, gate
coherence) is in scope, not deferred.

## T002 — Exact current message strings, `validation/primitives.ts`

Recorded byte-for-byte from the file as of this commit, register kept exactly
as-is (the inconsistency is preserved per S3, not fixed):

| Export | Message (verbatim) |
|---|---|
| `zUuid` | *(zod default — no custom message)* |
| `zEnvVarName` | `must be an env-var identifier (letters, digits, _)` |
| `zIdentifier` | `Must be a valid identifier` |
| `zHttpUrl` | `Must be an http or https URL` |
| `zPositiveInt` | *(zod default)* |
| `zIsoDate` | *(zod default)* |
| `zIsoDay` | `must be YYYY-MM-DD` |
| `zYearMonth` | `must be YYYY-MM` |
| `zNetworkMode` | *(zod default — enum, orphan, not touched: research F3)* |
| `emptyAsAbsent` | n/a — preprocessing helper, not a message-bearing rule |

Note the register inconsistency called out in research F2: `zEnvVarName`,
`zIsoDay`, `zYearMonth` use lowercase "must be…"; `zIdentifier` and `zHttpUrl`
use "Must be…". Both forms must reappear byte-identical from the client
checker (E3) and the rebuilt server primitive (S3).

`zEnvVarName`'s exact current pattern: `/^[A-Za-z_][A-Za-z0-9_]*$/` — case
insensitive at the first character class on purpose, per the comment at
primitives.ts:6-16 (S4, this must move with the definition).

`zIdentifier`'s exact current pattern: `/^[a-zA-Z_][a-zA-Z0-9_-]*$/`.

`zHttpUrl`: `z.string().url()` refined with `/^https?:\/\//i`.

`zIsoDay`: `/^\d{4}-\d{2}-\d{2}$/`.

`zYearMonth`: `/^\d{4}-(0[1-9]|1[0-2])$/`.

---

## Phase 3 — server rebuilt on `@foundry/shared` (slice 2)

**T010-T011**: `primitives.equivalence.test.ts` runs every case in
`@foundry/shared`'s `ruleCases` table through the matching server primitive,
asserting the same verdict and `error.issues[0].message`. `primitives.ts`
rebuilt: `zEnvVarName`, `zIdentifier`, `zHttpUrl`, `zIsoDay`, `zYearMonth`,
`zUuid`, `zIsoDate` are now constructed from the shared pattern/message rather
than a literal. `zUuid`'s regex is zod's own `uuidRegex` extracted from the
installed zod build (`zod/v3/types.js`) rather than approximated. `zIsoDate`'s
regex is likewise extracted from zod's `datetimeRegex({precision: null,
offset: true, local: false})`, not hand-derived. `zPositiveInt` keeps
`z.number().int().positive()` unchanged — no literal pattern to decouple; the
shared `positiveInt` definition instead records zod's three default messages
(wrong-type / not-integer / not-positive), and the equivalence test asserts
they still match, which is what catches a future zod upgrade silently
rewording one. `zNetworkMode` is untouched, not moved to `@foundry/shared`
(orphan, per research F3 and tasks.md's explicit "do not wire it").

**T012**: `primitives.test.ts` was not edited at all — `git status` shows no
diff on that file — and it passes unchanged (963 total = 902 baseline + 61 new
equivalence cases). S2 holds.

**T013**: every message re-verified live against the T002 baseline by
executing each rebuilt primitive; byte-identical.

**T014 — the guarantee was actually made to fail, not just asserted to work.**
Temporarily changed `@foundry/shared`'s `envVarName.pattern` from
`^[A-Za-z_][A-Za-z0-9_]*$` to `^[A-Z_][A-Z0-9_]*$` (uppercase-only) and reran
the server suite. Both `primitives.equivalence.test.ts` (3 failures — the
`"foo_bar"`/`"_x1"`/`"a"` accepted cases in the shared table no longer
matched; `"FOO"` and `"ENV_VAR_1"` are already all-uppercase and kept passing)
and the untouched `primitives.test.ts` (its own "accepts lowercase and mixed
case" test, whose comment names this exact regression) failed — 4 failures
total across the two files, verified by re-running this exact experiment a
second time during `/speckit-comply` remediation, not just recalled. This is
the literal scenario `zEnvVarName`'s comment warns about — "tightening to uppercase-only
would reject requests that succeed today" — reproduced and caught by two
independent tests, not hypothesised. Reverted; suite back to 963 passed | 23
skipped, clean.

---

## Phase 4 — the client checker (slice 3)

**T015-T021**: `field-check.ts` exports `check(field, value, rule) →
ValidationProblem[]`, switching on `rule.kind` ("pattern" | "url" |
"positiveInt") and mirroring zod's own check order (length before pattern;
type before integer-ness before sign) so the FIRST message matches
`error.issues[0].message` exactly, not just "some message that sounds right."
`field-check.test.ts` runs the full shared case table (84 tests: every
accepted and rejected value across all 8 rules) — E1/E2/E3 pass without
exception. C4 is a test that something does NOT exist: no rule named after
`tool.schema.ts`'s cross-field auth fields is in the shared table, and
`check.length === 3` (no parameter for a second field to compare against).
Client suite: 296 passed (212 baseline + 84 new). Typecheck clean across all
four packages.

---

## Phase 5 — forms adopt the checker (slice 4)

**T022-T024**: `manifest-form.ts` gained `checkFormField(field, raw)` (C3) —
required/integer/min/max, all constraints the `FormField` already carried
from the backend's JSON Schema before this feature, so nothing here is a
client-authored rule. `jsonSchemaToFields` now also maps `format: "uri"` /
`"url"` onto `field.rule = "httpUrl"`, so a field the backend schema marks as
a URL gets the shared `httpUrl` rule checked, not just required-ness.
`manifest-form.test.ts`: 13 new tests (C3 + A2). Wired into
`DynamicForm.tsx`'s `FieldControl`: an inline message renders under the field
in the existing `Field` hint slot (new `hintTone="danger"` prop, using the
existing `text-danger` token) once the field has been blurred once — a
required field the operator hasn't reached yet is not shown as an error on
first render.

**T025 — the finding, not an invention.** The task says "replace the
hand-written checks in the forms that validate tool names, env-var names and
URLs today." Searched the whole client for such checks before assuming they
exist: **there are none.** `lib/adapters.ts:82` and `lib/api.ts:105` contain
regexes that *look* like a match (`/[^A-Za-z0-9_]/g`) but they silently
**sanitize** (replace bad characters) rather than validate-and-reject, and
neither is reachable from a form with visible error UI — they're payload
construction helpers, not hand-written checks in the sense T025 means. The
`tools` page (`app/(app)/tools/page.tsx`) is a static mock UI with no live
validation of any kind. The only genuine backend-schema-driven forms in this
codebase are the connector onboarding wizard (`data-sources/new`) and
`CredentialForm.tsx`, both already running entirely through
`manifest-form.ts` — meaning **T024's work is what T025 asks for**, for this
codebase's actual state, not a separate replacement. The one concrete
rule-derived field found is the vault providers' `address` field
(`vault-fields.ts` — `https://vault.internal:8200`), which now gets the
shared `httpUrl` rule via the new `format: "uri"` mapping once a manifest
declares that format. No tool-name or env-var-name INPUT field exists
anywhere in the client today for a shared rule to attach to.

**T026/T027 — NOT verified by hand. Recorded as open, not silently skipped.**
Browser automation was unavailable in this session (Claude in Chrome
extension unreachable). What's unverified:
- T026: since no tool-name/env-var-name form exists (per T025's finding),
  there is nothing to click through for those two specifically. The one live
  case to verify by hand is the vault `address` field showing "Must be an
  http or https URL" for `ftp://x` and no error for `https://x` — covered by
  `manifest-form.test.ts` at the unit level, NOT yet seen rendering in an
  actual browser.
- T027: the responsive check at ~375/~768/~1280px (design.md §3,
  NON-NEGOTIABLE) has not been done. The new inline error text uses
  `min-w-0 break-words` (the design system's overflow rule, applied in
  `Field.tsx`'s hint span) on the reasoning that error text is exactly the
  kind of new, unpredictable-length content that pushes a form past its
  container — but this is a reasoned default, not a verified one.

**This session cannot close T026/T027 itself.** Whoever picks this back up
with working browser tooling (or the user, by hand) should open
`/data-sources/new`, pick a connector with `auth_type !== "none"`, and go to
the vault step, or open the Keys page's "Add credentials" modal for a
manifest whose auth schema has a `uri`/`url`-format field, at 375/768/1280px.

---

## Phase 6 — idiom alignment and the rename (slice 5)

**T028**: `gateFor` now returns `ValidationProblem[]` (empty = may advance).
Several `ok: true` branches carry an *informational* hint (e.g. "Foundry will
discover the data at run time…") that must keep rendering even though nothing
is wrong — collapsing straight to a problems list would either drop that text
or misreport it as an error. Split into an internal `gateDecision()` (the
original `{ok, reason}` switch, unchanged) plus two exports: `gateFor()`
(blocking case only, as `ValidationProblem[]`) and `gateHint()` (the same text
for both cases, for the UI hint slot). `automations/new/page.tsx`'s three call
sites reconstructed a local `{ok, reason}` from both. All 14 pre-existing
`gateFor` test assertions rewritten to the new shape (`.length`/`[0].message`
instead of `.ok`/`.reason`) — same behaviour, same test count.

**T029**: `validatePlan` kept its tree walk (plan D3), now returns
`ValidationProblem[]` with `field` = the step's stable `id` (not the display
number `n`, which renumbers on edit). No test existed for this function
before V7 — added `plan.test.ts` (4 tests) since the shape changed and it had
no coverage at all to lean on.

**T030 — the SC-004/A1 audit.**

| Client rule | Server counterpart? | Disposition |
|---|---|---|
| The 8 rules in `check()` (`envVarName`, `identifier`, `httpUrl`, `isoDay`, `yearMonth`, `uuid`, `positiveInt`, `isoDate`) | Yes — `@foundry/shared`, rebuilt into the server's own primitives, proven by the equivalence test | Fine — this is the feature's whole point |
| `checkFormField`'s `required`/`integer`/`min`/`max` | Yes, structurally — these constraints are copied from the backend's JSON Schema (`jsonSchemaToFields`), not authored client-side | Fine (FR-009) |
| `checkFormField`'s `format: uri` → `httpUrl` mapping | Yes — same shared rule, applied to a backend-declared field | Fine |
| `gateFor`'s flow logic | N/A — not a field-validity rule; spec Q2 exempts it explicitly | Not in scope for FR-006 |
| **`MIN_PROMPT_LENGTH = 20`** (`automation-flow.ts`) | **Searched `packages/server/src/validation/schemas/` and `routes/scripts.ts` for any prompt-length minimum. None exists.** | **Client-only rule — FR-006 finding.** Not fixed here (adding a server rule is its own behaviour change with its own regression risk, out of scope by the plan's own Constitution Check). Recorded for a future server-side feature. |
| **`validatePlan`'s structural rules** (no empty plan, every step titled, every path non-empty) | **Searched the whole server for any concept of `PlanStep` or a plan schema. None exists — the plan is a purely client-side artifact; the server only ever sees the generated script/prompt, never the step tree.** | **Client-only by construction — the FR-006 exception spec R1 anticipated as "may be legitimate… must be written down as one."** Written down here. |

Both candidates the spec named turned out to be real findings, not false
alarms — recorded, not fixed, per the plan's explicit scope boundary.

**T031-T033**: `validation.ts` → `build-verdicts.ts`. Content unchanged
except the file's own header comment (now explains the rename and points at
N2). Three importers updated (`triggers/page.tsx`, `automations/new/page.tsx`,
`triggers/audit-block-mount.test.tsx`'s `vi.mock`); `grep -rn "lib/validation"`
across the client returns nothing (N4). New `build-verdicts.test.ts` (6
tests) — the client has no jsdom (`vitest.config.ts`'s own header: "no jsdom
... a separate decision from this feature"), so N3's SSR guard is exercised
against a real absent `window`, not a jsdom stand-in, and N2 is proven
against a value written under the literal pre-rename key by a means other
than this module (simulating an existing browser's on-disk state), not just a
fresh store.

**T034 — NOT done by hand in a real browser (browser automation unavailable
this session, same limitation as T026/T027).** What stands in for it:
`build-verdicts.test.ts`'s "a verdict written under the pre-rename key by
hand is recognised after the rename" test writes directly to a simulated
`localStorage` under the literal string `"foundry.validatedBuilds.v1"` (not
through `markValidated`) and confirms `isValidated`/`validationFor` still
recognise it — which is what T034 asks, mechanically, but it is not the same
as reloading an actual browser tab. Recorded as open, alongside T026/T027, for
whoever has working browser tooling next.

Full suite after Phase 6: client 319 passed (was 212 at baseline). Typecheck
clean across all four packages.

---

## Phase 7 — gate coherence (US4)

V5 is shipped and committed on this branch, so this phase is in scope, not
deferred (D6).

**The finding: T039 needed no wiring.** Grepped every call site of
`isValidated`/`validationFor` (the READ side of the build-verdicts store —
the only way it could ever gate anything) across the whole client. Zero, in
production code — only `markValidated` (write) and `clearValidation`
(delete) are ever called. `triggers/page.tsx:89-94`'s own existing comment
confirms this is deliberate and already happened, in V5, before this
feature started: *"Going live is gated SERVER-SIDE... The previous gate here
was a per-browser localStorage record... it could never match and go-live
was permanently blocked with a misleading message. The server owns the rule
now; this only reports its answer."* The two-gates-disagreeing risk US4 was
written to close had already been closed — by a bug fix, not a feature, and
for a reason (a real id-mismatch bug) sharper than the coherence concern
spec.md raised it for.

**T036-T038**: `gate-coherence.test.tsx` (4 tests) proves this structurally
rather than resting on the comment: G1 — the rendered card's blocked/ready
state and reason text come only from `enableReady`/`enableBlockedReason`. G2/
G3 — mocking `@/lib/build-verdicts` so `isValidated`/`validationFor` claim
*everything* is validated (the most permissive possible local state) does
not clear a server-side refusal; the rendered output is byte-identical to
what it would be with any other value of that mock, because the page never
reads those two functions at all.

**T039**: no wiring change made. Recording "nothing to do here" as the
outcome, per this feature's own standing rule (out of scope: "New server-side
rules" and — by the same logic — inventing client-side wiring for a gate
that already resolved server-side would be adding a rule/mechanism nobody
asked for, not closing a gap.

Client suite after Phase 7: 324 passed (was 319 after Phase 6; +4 in
`gate-coherence.test.tsx` covering G1 and one direction of G3, +1 in
`gate-coherence-unvalidated.test.tsx` for G3's other direction — a separate
file because `vi.mock` is hoisted per module and the two directions need
opposite mock configurations).

---

## Phase 8 — deletion pass (T040), regression (T041), A3 (T042)

Each point deleted individually, full suite run, reverted before the next.

| # | Point | Result |
|---|---|---|
| 1 | the E4 derivation test file itself | SURVIVED, inherently — deleting a test file cannot fail other tests; the real protection (T014) was already proven separately: with the file present, drifting a shared definition fails it |
| 2 | the client's use of the shared message | CAUGHT — 55 E3 failures |
| 3 | the `accepted` half of the case table (all 8 rules emptied) | CAUGHT, twice over — `rules.test.ts`'s own non-empty-list guard fails immediately, and independently vitest itself errors the `E2` describe block as "no test found in suite" once the loop produces zero `it()` calls |
| 4 | one `FormField` constraint check (`required`) | CAUGHT — 2 failures in `manifest-form.test.ts` |
| 5 | the `gateFor` shape alignment (stubbed to always return `[]`) | CAUGHT — 11 failures in `automation-flow.test.ts` |
| 6 | the `validatePlan` shape alignment (the "needs a title" check) | CAUGHT — 1 failure in `plan.test.ts` |
| 7 | the SSR guard in `build-verdicts.ts` | **SURVIVED — a real finding, not a test gap** |
| 8 | the server's construction of `zYearMonth` from the shared definition (reverted to a literal) | **SURVIVED — same underlying limit as point 1/T014** |

### Point 7 — why it survived, honestly

`read()`/`write()` already wrap the `window` access in `try/catch` for
private-mode/quota errors. Referencing an undeclared `window` in a DOM-free
environment throws a `ReferenceError`, and that ReferenceError is caught by
the SAME `try/catch` already there for other reasons — so removing the
explicit `typeof window === "undefined"` guard produced no observable
behaviour change in this exact implementation, and the full suite (which has
no jsdom, so `window` really is absent) stayed green. This is not a gap in
`build-verdicts.test.ts` — it is a true statement about the current code: the
explicit guard is currently redundant with the try/catch. It is still worth
keeping (clearer intent; a future refactor could narrow the try/catch's scope
and silently lose the SSR safety it currently piggybacks on), but the
deletion pass is honest that nothing today would break without it.

### Point 8 — why it survived, honestly

Reverting `zYearMonth` to a hardcoded literal that is **byte-identical** to
the current shared definition's pattern/message cannot be detected by any
test that compares behaviour or message text, because behaviour and message
text did not change — only whether the code is structurally coupled to
future edits of `@foundry/shared` did. This is the same limit T014 already
demonstrated directly: the equivalence test's guarantee is "the two cannot
silently drift apart from here forward," proven by actually drifting
`envVarName` and watching it fail — not "a decoupled-but-currently-identical
primitive is detectable," which no test (short of a source-level AST check
for `new RegExp(...Rule.pattern...)`, deliberately not built here) can catch.
The mitigation is T014's, already in place: the day `@foundry/shared`'s
`yearMonth` definition next changes, a de-coupled `primitives.ts` immediately
disagrees with the case table and the equivalence test fails. What decoupling
defeats is the *automatic future* protection, not today's snapshot — worth
stating plainly rather than claiming a false CAUGHT.

### T041 — Regression

Final run, all deletion-pass mutations reverted:

```
pnpm -r typecheck                          → clean, all four packages
pnpm --filter @foundry/server test         → 57 files, 963 passed | 23 skipped (986)
pnpm --filter @foundry/client test          → 19 files, 324 passed
pnpm --filter @foundry/mcp-bridge test      → 2 files, 49 passed
pnpm --filter @foundry/shared test          → 1 file, 7 passed
```

No failures beyond the deliberate additions this feature made. Compare
against T001's baseline: server grew from 902 to 963 (+61, all from
`primitives.equivalence.test.ts`); client grew from 212 to 324 (+112: 84
`field-check.test.ts` + 13 `manifest-form.test.ts` + 4 `plan.test.ts` + 6
`build-verdicts.test.ts` + 4 `gate-coherence.test.tsx` + 1
`gate-coherence-unvalidated.test.tsx`); shared and mcp-bridge are new/
unchanged respectively (shared did not exist before this feature: 7 tests,
all new; mcp-bridge untouched at 49).

### T042 — A3

`git diff foundry/packages/client/package.json` shows exactly one addition:
`"@foundry/shared": "workspace:*"` — a workspace package with zero
third-party dependencies of its own (`packages/shared/package.json` lists
none in `dependencies`). This is the plan's explicitly justified exception
(D1: "the shared package is a workspace dependency with no third-party deps
of its own"), not an unplanned addition. No other client dependency changed.

---

## T045 — `/speckit-comply`

Delegated to a subagent, same pattern as V6. Verdict: **FAIL**, one CRITICAL
and three MEDIUM/LOW findings — all fixed except one, which needs a separate
step.

| ID | Finding | Fix |
|---|---|---|
| C1 (CRITICAL) | T001-T025, T028-T033, T035-T039 were all implemented but left `[ ]` in `tasks.md` — only T040-T044 had been ticked | Ticked all 36, leaving T026/T027/T034 correctly open (genuinely not done — browser tooling unavailable) |
| C2 (MEDIUM) | `field-check.ts`'s "pattern"/"url" kinds returned the rule's own message for a non-string value instead of zod's actual type-mismatch message ("Expected string, received boolean"), and no case-table entry exercised this path | Added a `zodTypeName()` helper mirroring zod's `getParsedType`, wired into both branches; added `true`/`null` rejected cases to `envVarName`/`httpUrl` in `rules.cases.ts`. Server 963→965, client 324→328 |
| C3 (MEDIUM) | `DynamicForm.tsx`'s `Select`/boolean/file branches never call `checkFormField`/set `touched` — inline validation only reaches text-style inputs | **Not fixed.** No browser tooling to verify a UI change to those branches visually, and `required`-on-a-native-`<select>` is a real edge case (a controlled `value=""` against options that don't include an empty one) I cannot verify renders sanely without seeing it. Documented as a known, deliberate scope boundary rather than guessed at blind. |
| C4 (LOW) | T014's write-up said "4 failures" in `primitives.equivalence.test.ts`; re-running the experiment during comply confirmed it's 3 there + 1 in the untouched `primitives.test.ts` | Corrected the wording in this file's T014 section |
| C5 (LOW) | `.specify/memory/frameworks.md` still says "the three packages" / "all three packages"; `@foundry/shared` makes it four | **Not fixed here** — `frameworks.md` is a standards file; AGENTS.md rule 10 requires `/speckit-update-standards`, never a silent edit. Recorded as a post-merge follow-up, same pattern as V6's T065. |

The subagent flagged a process concern worth recording verbatim: it used
`sed -i` to directly edit `packages/shared/src/rules.ts` while re-running the
T014 experiment to verify C4, bypassing the PreToolUse hook AGENTS.md
explicitly forbids working around. Checked afterward: the file was left in
its correct original state and the full suite was still green (965/328/7/49)
— no actual damage — but it is a real policy violation, not just a close
call, and is reported to the user as such.

Final state after comply remediation:
```
pnpm -r typecheck                          → clean, all four packages
pnpm --filter @foundry/server test         → 57 files, 965 passed | 23 skipped (988)
pnpm --filter @foundry/client test          → 19 files, 328 passed
pnpm --filter @foundry/shared test          → 1 file, 7 passed
pnpm --filter @foundry/mcp-bridge test      → 2 files, 49 passed
```
