# Research — V5 Audit Verdict as an Asymmetric Gate

Everything here was read out of the code on 2026-08-04, not remembered. Where a
finding contradicts the roadmap, the code wins and the contradiction is stated.

## F1 — Four of the CHECK constraints the roadmap asks for already exist

`docs/validation-and-guardrails-roadmap.md` lists "DB CHECK constraints on
`audit_verdict` and the other status enums (hole 8)" as V5 work. Reading
`db/schema.ts`:

| Constraint | Line | Status |
|---|---|---|
| `chk_scripts_status` | 229 | present |
| `chk_test_results_audit_verdict` | 266 | present |
| `chk_execution_results_status` | 307 | present |
| `chk_triggers_type` | 336 | present |
| `chk_tickets_*` (3) | 537–547 | present |

`db/schema.test.ts:73-93` tests the `audit_verdict` one against a live database,
including the NULL case. So hole 8 was closed by an earlier slice and the roadmap
text was never updated.

**Consequence**: if this feature had been implemented from the roadmap text, it
would have produced a migration that re-adds constraints that exist, which fails
on a live database. FR-016 is written to the two columns that genuinely lack one.

**Columns still unconstrained**: `test_results.overall_status`,
`trigger_fires.fired_by`, `datasources.test_status`,
`schema_entities.entity_type`, and the two `varchar` status columns at
`schema.ts:393` and `:427`. The first two are on the gate path and are in scope;
the rest are named as out of scope so the omission is deliberate rather than
missed.

## F2 — The parent API has no user identity, so "who overrode" has no honest answer today

`middleware/auth.middleware.ts` is a **single shared API key** (`requireApiKey`),
compared in constant time, throttled per address. There is no user, no subject
claim, no session at this boundary. The client has sessions and roles (V2), but
the parent cannot verify anything the client asserts about them —
`security.md` §9 R2 records exactly this: `backendToken` is minted by the client
and never verified.

**Consequence**: spec.md Q1 resolves to recording only verifiable facts —
timestamp, request id, reason — with the field named so it does not imply
identity. A column called `overridden_by` holding a client-supplied string would
be an attribution the system cannot stand behind, and Article XV exists to keep
exactly that kind of unearned signal out.

**When R2 lands**, the field should be *replaced* rather than joined by a second
one, so no single record ever mixes verified and unverified attribution.

## F3 — The existing readiness gate already embodies the asymmetry rule

`trigger.service.ts` refuses to enable a trigger unless the script is `completed`
with code, **and** has at least one succeeded execution. The comment above it
(lines ~30-52) explains why the obvious evidence was rejected:

> a script with `status="completed"`, `tests_passed=true` and audit verdict
> `clean` hardcoded `period="2023-10"` and emailed 0 of 11 people — today's gate
> would happily let a schedule fire that forever.

and closes with:

> DELIBERATE LIMIT, stated out loud: this proves the automation ran once, not
> that it produced the right result. An enabled trigger is not a correctness
> guarantee.

**Consequence**: this feature is continuing a decision, not introducing one. It
also means the `clean`-unlocks-nothing rule already has a precedent in the code,
which is worth pointing at when someone later proposes "if the audit is clean we
can skip the manual-run requirement." That proposal is the exact thing this
comment was written to prevent.

## F4 — The verdict function, and what `fail` actually means

`generation-audit.service.ts:615`:

```
verdict = findings.some(f => f.severity === "high") ? "fail"
        : findings.length ? "warn"
        : "clean"
```

So `fail` means **at least one high-severity finding**. The twelve codes, with
the severity each is raised at:

| Code | Severity |
|---|---|
| `undeclared_env` | high |
| `invented_endpoint` | high |
| `external_source` | low |
| `unknown_table` | high |
| `unverifiable_schema` | medium |
| `attempted_write` | high |
| `hardcoded_credential` | high |
| `hardcoded_connection` | high |
| `no_tool_used` | medium |
| `synthetic_test_data` | low |
| `undeclared_invention` | high |
| `unrequested_action` | medium (added by V4) |

Seven codes can produce `fail`. That is the blast radius of this gate, and it is
worth stating plainly: **this feature makes seven existing checks able to block
arming.** None of them was written with blocking in mind, which is the strongest
argument for the override in US3.

`invented_endpoint` deserves particular attention — the comment at line 444
records that it *"marked a correct script as failing"* at severity `high`. It is
the most likely false positive, and it will now block. The override is not a
nicety.

## F5 — What the gate must NOT read

`test_results` carries the agent's self-report in the same row as the audit:
`testsRan`, `testsPassed`, `syntaxCheckPassed`, `dependencyResolutionOk`,
`dryRunExitCode`, `schemaAlignmentVerified`, `endpointConnectivityOk`.

The gate reads `auditVerdict` and `auditJson`, and none of the others. They are
adjacent in the same row, which makes accidentally reading one a plausible
mistake rather than an absurd one — hence FR-020 and a named test.

## R1 — Where should the verdict check sit in the refusal sequence?

**Decision**: last, after the script-status and succeeded-execution checks.

**Rationale**: refusal reasons are ordered by which is most useful to the
operator. A script that has never run should be told it has never run — that is
actionable and it is the earlier problem. Telling them about audit findings first
would send them to review findings for an automation that cannot be armed for a
simpler reason anyway.

**Alternative considered**: first, on the theory that the "worst" problem should
surface first. Rejected — severity of the *finding* is not the same as usefulness
of the *message*, and the operator's next action is what the message is for.

## R2 — What happens to a trigger already armed when the code is regenerated into `fail`?

**Decision**: nothing automatic. The condition becomes visible; the trigger keeps
firing.

**Rationale**: auto-disabling is a silent side effect, and Article XV names
exactly this class. An automation that stops firing for an invisible reason is a
harder incident than one that keeps firing — the first is discovered days later
when someone notices a report never arrived. Making the condition visible on the
trigger and on the automation gives the operator the information and the decision.

**Alternative considered**: auto-disable and notify. Rejected for this feature —
it needs a notification channel that does not exist, and without one it is
auto-disable-and-say-nothing. Worth revisiting if a notification surface is ever
built; recorded here so the reasoning is available then.

**Alternative considered**: re-check the verdict at fire time rather than at arm
time. Rejected as scope: it changes the trigger firing path, which is the live
execution path, for a case the visible-condition approach already covers. It is
also a different feature — "continuous" rather than "at-arming" gating — and
mixing them would make both harder to reason about.

## R3 — Reason field: how long, and how validated?

**Decision**: required, at least one non-whitespace character, capped at 2000
characters, stored as written.

**Rationale**: the minimum exists because `""` produces a trail that looks
complete and says nothing (FR-011). The cap exists because it is a free-text
field on an authenticated endpoint and unbounded text on such a field is how a
table becomes a storage problem. 2000 is generous for a paragraph of reasoning
and small enough to be uninteresting as an abuse vector.

**Not decided here**: whether to require a minimum *word* count. Rejected — it is
trivially defeated ("ok fine ok fine") and it punishes the honest short answer
("`invented_endpoint` fires on our own internal host; confirmed registered").

## R4 — Does the override need its own authorization?

**Decision**: it inherits whatever guards the enable path, and adds nothing.

**Rationale**: Article XI — a guardrail that can be satisfied by widening a
credential is not a guardrail, and the converse holds too: adding a *new*
privilege tier for the override, on a system with one shared API key (F2), would
be authorization theatre. The client's V2 role gate applies to the surface. When
R2 lands and real identity exists, requiring a specific role to override becomes
possible and should be revisited.

**This is a real limitation and it is stated rather than hidden**: today, anyone
who can arm a trigger can override the gate that blocks arming it. What the
override buys is not *restriction* — it is the **record**. That is still worth
having, and it is worth being clear that it is what is on offer.
