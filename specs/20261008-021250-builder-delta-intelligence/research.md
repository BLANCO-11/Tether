# Research: Builder Delta Intelligence

## Decision 1: Contiguous partition for band capture

- **Decision**: Extract all stated boundaries; infer present floor from the maximum stated ceiling (weight-0 arm); build intervals `[<b1, b1–b2, ≥b2]`; under-determined → one bounded unclear question.
- **Rationale**: Live failure shows rank-pairing drops 9.5 and double-pins 4.75 — the pairing owns the bug, not the model. Contiguous partition is deterministic (same goal → same arms) and preserves refuse-on-scramble via `bandArmsConsistent`.
- **Alternatives considered**: Ask the model to place boundaries (rejected — non-deterministic, unprovable offline); keep rank-pairing with extra regexes (rejected — each new phrasing needs another regex, the treadmill we're leaving).

## Decision 2: Patch-first edits with revision-hash pin

- **Decision**: Classify edits: single-step (one touched step, slot-validated) → `carryOut` patch; else whole rebuild. Patch pins `draftRevision` + `structureHash`; mismatch → rebuild fallback. Lost-check diffs touched steps only.
- **Rationale**: Turn-7 refusal proves whole-diff false-positives on unrelated sinks. Patch path already validates slot fit; hash pin prevents mis-application after concurrent replans.
- **Alternatives considered**: Semantic whole-diff (normalised quotes) alone (rejected — still rebuilds for one-word SQL fixes, slower and still comparison-shaped); removing lost-actions guard (rejected — guard is correct for true multi-step removals).

## Decision 3: Validate-then-capture routing

- **Decision**: On pending-question state, validate reply against hole (`literalFits`/slot check) first; fit → capture; miss → re-route without pending context, question stays open.
- **Rationale**: Turns 4–5 prove capture-swallows-intent. Validation is pure (no model call on the happy path); the extra route call happens only on mismatch, bounded, no loop.
- **Alternatives considered**: Keyword "this answers X" detection (rejected — another regex treadmill); always re-route (rejected — breaks genuine one-word answers like "yes").

## Decision 4: Drafted defaults with confirm gate

- **Decision**: Policy switch — model drafts body/subject from goal content, marked `provenance: drafted`, asked as one confirmation; reject → today's open ask.
- **Rationale**: Constants rule is correct against invention but over-broad for derivable text. Draft+confirm keeps the person sovereign while removing two interrogation turns. Needs user policy decision (open question Q2 below).
- **Alternatives considered**: Silent drafting (rejected — violates provenance honesty); keep open asks (rejected — the observed UX complaint).

## Decision 5: Spec-grounded verification answers

- **Decision**: `about_flow` messages containing numeric/operator claims route to a spec-lookup: code reads bands, model phrases yes/no with quoted evidence. Neutral questions keep the summary path.
- **Rationale**: Turn 6 proves the summariser ignores checkable claims. Code quotes spec (no invention), model only phrases.
- **Alternatives considered**: Full LLM Q&A over spec (rejected — unbounded, unprovable); keyword FAQ (rejected — treadmill).

## Decision 6: Delta-scoped unclear with exact-norm settled matching

- **Decision**: Settled quotes enter the replan prompt as frozen facts; `checkSpec` hard-drops unclear flags overlapping settled (exact-norm); question emission gets a single settled-membership choke point; `sameWords` fuzzy stays for new-question dedup only. Narrow `goal-spec.ts:939` gag to mechanical shaping; overlap-match drops → exact-match.
- **Rationale**: Edit-storms amplify fuzzy-drift re-asks. Exact-norm for settled (a miss re-asks — intolerable); fuzzy for new dedup (a miss duplicates — tolerable). Two strictnesses, named for what they protect.
- **Alternatives considered**: Embedding-similarity settled matching (rejected — new dep, non-deterministic, constitution IV); freezing whole spec (rejected — corrections must re-open words).

## Proof method (offline replay, no model calls)

- Fixtures: JSON snapshots of flow `73f11284` revisions 1–3 goal_specs + thread turns 1–7.
- Matrix per slice: fixed case changes (assert new behaviour) × control cases byte-identical (A01/A02, pin tests, plan tests).
- Soak: 10 sequential updates → zero settled-anchored questions + final spec equals single-goal equivalent.
- Each slice replayed twice: fresh build + mid-build correction on dirty state (replan-drift column).
