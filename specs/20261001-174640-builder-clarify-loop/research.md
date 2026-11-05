# Phase 0 Research: Builder Clarification Loop — Durable Answer State

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-01

## Evidence base (root causes, file:line)

All four defects verified by direct source reading on branch
`20261001-174640-builder-clarify-loop` (commit `70f07fa0`):

| # | Defect | Evidence |
|---|--------|----------|
| E1 | Answer set wiped on every continuation round | `builder/conversation.ts` `continueBuild`: `const fresh: Conversation = { …, answers: {}, pending: null, … }` — each CLARIFY/addition round starts with an empty answer map |
| E2 | Question identity is positional | `builder/builder.service.ts` unclear questions built as `holeId: unclear:${i}:${about}` (index `i` into the re-derived `spec.unclear`); after re-understanding, index `i` denotes a different quote — a kept answer would match the wrong question, so matching by position is structurally unsafe |
| E3 | CLARIFY reply reaches only the spec model call, never persisted as an answer | `conversation.ts` `builderAnswer`: for `pending === CLARIFY` the text goes to `continueBuild` → `understand(...)` (one model call); it is never written into `conv.answers`, and the re-derived `run` recomputes solver `unmet` with the answerer returning nothing for regenerated holes |
| E4 | No cross-turn termination bound | `build.ts` `MAX_ROUNDS = 3` bounds rounds *within one trace* (`noLoopProblems`, build.ts:432-441); the CLARIFY turn cycle (`step` → `unsettled` → `continueBuild` → `step`) is unbounded across turns |
| E5 | Defer matching too narrow | `builder/normalise-value.ts:119` `KEEP_AS_IS` requires "leave it"/"keep it" — bare "leave" does not match; honored only when `pending === CLARIFY` (conversation.ts `builderAnswer`), so a defer on an `unclear:` question is stored as a literal answer |
| E6 | "no model call" turn label | `flow-chat-builder.ts` `resumeEdit` files `calls: 0`; `wholeRound` deferral path in `builder.service.ts run()` returns a replayed trace where the model was intentionally not re-called — the panel renders `attempts === 0` as "no model call" |

Field transcript (local://paste-1.md) matches E1+E3: the same
"What do you mean by \"relevant body message\"?" re-opened 4×, "Your answer
did not settle these" repeated byte-identically, and "leave" fell through.

## Decisions

### D1 — Answer state accumulates; never resets

**Decision**: `Conversation.answers` is append-only per build. Every code path
that constructs a new `Conversation` (currently `builderStart`, `continueBuild`,
the settle-persistence sites in `step`) must carry
`answers: { ...prev.answers, ...new }`. A correction supersedes by writing the
same key (latest wins on read); no path assigns `answers: {}` on a conversation
that already has answers.

**Rationale**: Fixes E1 at the state-machine level. The invariant is checkable
in one assertion (`Object.keys(prev).every(k => k in next)`), so it is
enforceable in tests, not by convention.

**Alternatives considered**:
- *Re-derive answers from the spec each round* — rejected: the spec is a model
  output; deriving user answers from it reintroduces nondeterminism (this is
  what made re-asking possible at all).
- *Move answers out of Conversation into a separate store* — rejected:
  Conversation is already persisted per-build and survives restarts (FR-010);
  a second store adds a sync problem (Constitution IV).

### D2 — Question identity keyed by content, not position

**Decision**: Unclear-question hole ids become content-derived:
`unclear:<normalised quote>:<about>` (normalisation: casefold, collapse
whitespace, strip surrounding quotes — same normalisation `quoted()` already
uses in `goal-spec.ts`). The index is dropped. `answers` keys therefore remain
valid across spec re-derivations: the same unknown re-derives the same id.

**Rationale**: Fixes E2 structurally. Positional ids are only safe if the
unclear list is immutable between rounds; `continueBuild` re-derives it by
design. `noLoopProblems`' "hole asked at most once" check (build.ts:434-435)
compares holeIds — content keys make that check *stronger* (the same quote can
never be asked twice under two ids).

**Alternatives considered**:
- *Keep positional ids, re-key answers on each re-derivation* — rejected:
  re-keying requires knowing which old index became which new quote; that
  mapping is exactly the ambiguity the fix must remove.
- *Add a separate stable `key` field alongside holeId* — rejected: two
  identities invites divergence; holeId already flows to the panel as the
  question id (`questionIdOf`, flow-chat-builder.ts) and is opaque to the user.

**Constraint carried forward**: `questionIdOf()` sanitises hole ids for the
panel; content-derived ids must stay colon-free *or* keep being sanitised —
existing sanitisation already handles this; contract test required.

### D3 — An answer reaches every consumer in the same turn

**Decision**: A CLARIFY reply is recorded as an answer under the stable ids of
the open items it addresses **and** passed to `understand()` as today. Two
consumers, one turn:
1. the spec re-understanding (existing `understand` correction path),
2. the stored answer set — so the replayed `run()` answerer returns it for any
   regenerated question with the same identity.

Open items ("not settled yet") become recomputable: after the answer round,
items whose requirement is now satisfied by the stored answer/spec are closed
**by code comparison** (FR-004), not by asking the model whether it is satisfied.

**Rationale**: Fixes E3. The current design gives the answer to exactly one of
two consumers; the solver-side complaint list is then structurally
unsatisfiable, which is why "did not settle these" repeated with a
byte-identical list.

**Alternatives considered**:
- *Ask the model to re-list unmet items and trust its list* — rejected: the
  identical-list repetition shows the model is not the binding constraint;
  code-side closure is deterministic and testable (FR-009).
- *Feed answers into a second model call dedicated to the solver* — rejected:
  adds a call per turn and nondeterminism; solver `unmet` is code-computed
  (`checkSpec`/`solveInto`) and should be re-evaluated against stored answers
  directly.

### D4 — Bounded, terminal clarification loop

**Decision**: A per-build clarification-round counter (`clarifyRounds`) is
stored on `Conversation`. Reaching `MAX_CLARIFY_ROUNDS` (default 5, enforced
constant beside `MAX_ROUNDS`) switches the turn to a terminal offer: open items
listed with proposed defaults, user chooses accept-or-stop; no further questions
are asked in that build. `KEEP_AS_IS` is extended to bare "leave", "skip",
"ok", and is honored for **any** pending question (defer closes that question
and keeps the draft), not only `CLARIFY`.

**Rationale**: Fixes E4+E5. The trace-level `MAX_ROUNDS` provably cannot bound
a cross-turn loop (each turn is its own trace). A stored counter is the only
form that survives restarts (FR-010).

**Alternatives considered**:
- *Bound by wall-clock / turn count* — rejected: build turns include
  unrelated messages; the bound must count clarification rounds specifically.
- *Keep "leave it" wording-only* — rejected: the field transcript proves a
  user's bare "leave" silently becomes a literal answer to an unclear
  question, which is the worst outcome (answer set polluted + question not
  deferred).

### D5 — Truthful status, no silent deferral

**Decision**: Status `needs_input` is emitted iff, *after* answer accumulation,
an unanswered question actually remains. The `wholeRound` deferral and
`resumeEdit` paths report their real model-call counts (0 is truthful for a
code-only replay, but the panel distinguishes "answered without a model call"
from "stuck" — FR-008).

**Rationale**: Fixes E6 and FR-008. Current UI conflates "this turn needed no
model call" with "blocked".

**Alternatives considered**:
- *Always make a model call so the counter is nonzero* — rejected: fabricating
  calls to satisfy a label violates honest-reporting principles and costs
  latency.

## Research task resolution

No `NEEDS CLARIFICATION` markers existed in Technical Context; the two items
deferred by the spec resolve here:

| Open item | Resolution |
|-----------|-----------|
| Round bound value | `MAX_CLARIFY_ROUNDS = 5` (D4) — single-digit, beside existing `MAX_ROUNDS = 3` in `build.ts`; config-not-needed until proven otherwise (YAGNI) |
| Storage location | Unchanged: `flow.build.goalSpec.conversation` via `saveIncomplete` (D1 keeps writes at existing persistence sites) |
