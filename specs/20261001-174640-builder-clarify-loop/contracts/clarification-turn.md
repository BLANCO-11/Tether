# Contract: Clarification Turn (observable behaviour)

**Feature**: [spec.md](./spec.md) | **State model**: [data-model.md](../data-model.md)

Pinned by tests at the seam the field report exercises:
`builder/conversation.ts` (turn generation) and
`flow-chat-builder.ts` (chat filing), rendered by `ChatPanel.tsx`.

## Inputs

- `builderStart(goal)` — first turn.
- `builderAnswer(flowId, text)` — reply while a question is pending.
- `builderContinue(flowId, text)` — new message on an unfinished build.

## Turn outputs (BuilderTurn → chat turn row)

| Situation | `BuilderTurn.status` | Chat status | Question payload |
|---|---|---|---|
| Unanswered, non-deferred question remains | `asks` | `needs_input` | the ONE pending question |
| All questions answered, build valid | `complete` | `applied` | — |
| Built with gaps (or bound reached, offer made) | `incomplete` | `incomplete` | — |
| Workspace cannot build | `cannot` | `insufficient_catalogue` | — |
| Nothing changed | `unchanged` | `answered` | — |

## Behavioural clauses

### C1 — Accumulation (invariant I1)
**Given** a build with answers {A1, A2}, **when** any continuation or
clarification round runs, **then** the Conversation stored afterwards contains
at least keys {A1, A2}; no code path writes `answers: {}` over a non-empty map.

### C2 — No re-ask (invariant I2)
**Given** question Q (id q) was answered or deferred, **when** any later turn
selects a pending question, **then** q is never selected. The ask text for the
previously answered unknown must not appear as a new question in any later
turn of the same build.

### C3 — Stable identity (invariant I3)
**Given** the same goal text, **when** the spec's unclear list is re-derived
in a different order or with different indices, **then** each unclear question
keeps the same hole id (content-keyed). `questionIdOf()` output for such ids
remains a valid panel id (non-empty, colon-free after sanitisation).

### C4 — Answer delivery (FR-002)
**Given** pending `clarify:unsettled` with items O1, O2, **when** the person
replies with text T, **then** in that same turn:
1. T is passed to the spec re-understanding (existing behaviour), **and**
2. T is stored in `answers` under the stable ids of the addressed open items,
   **and**
3. the re-derived open-item list is recomputed by code against T and the
   updated spec — items satisfied are closed without another user turn.

### C5 — Monotonic progress (FR-009, invariant I5)
**Given** the previous round's item list L, **when** a reply resolves nothing,
**then** the turn states which specific item remains and why — the reply must
never be answered with a byte-identical re-ask presented as if new. The wording
distinguishes "your answer did not settle these" (with the new reason) from a
fresh "not settled yet".

### C6 — Defer (FR-006, invariant I2)
**Given** any pending question (unclear, spec value, delivery, or
`clarify:unsettled`), **when** the reply matches `KEEP_AS_IS` — which MUST
match bare `leave`, `skip`, `fine`, `ok`, `stop` and their "it/this" forms —
**then** that question is deferred: the draft is kept as-is, the question is
closed for the build, and no model call is made for the defer itself.

### C7 — Bound (FR-005, invariant I4)
**Given** `clarifyRounds == MAX_CLARIFY_ROUNDS` (5) on a build, **when** the
next clarification would start, **then** no question is asked; the turn lists
the open items with proposed defaults and offers accept-or-stop. After
accept/stop, no further question is asked in that build.

### C8 — Status truthfulness (FR-008, invariant I6)
**Given** a turn that answered by code replay only (0 model calls), **when**
the panel renders it, **then** it shows as answered/cleared — never as
"Needs your input" — unless an actually-unanswered, non-deferred question
remains. `needs_input` ⇔ such a question exists.

### C9 — Restart durability (FR-010)
**Given** a persisted Conversation, **when** the process restarts, **then**
accumulated answers, defers, and `clarifyRounds` are all still in effect —
all three live on the persisted Conversation, never in module memory.

## Non-goals (explicit)

- Does not change routing (`chat-route.ts`), edit questions
  (`chat-edit.service.ts` — separate pending mechanism), or the readback
  wording beyond the clarify wording rules in C5.
- Does not add model calls; bound and defers are code-only.
