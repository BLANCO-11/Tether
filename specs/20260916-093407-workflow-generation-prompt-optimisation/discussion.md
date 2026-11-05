# Workflow generation — prompt optimisation

**Status:** discussion only. No code changed, no prompt bytes moved.
**Date:** 2026-09-16
**Subject:** restructuring workflow generation into *shape → mapping → verification*, and
whether a DSL helps.

---

## The question this document answers

The proposal was a three-phase generation pipeline:

1. **Build** — break the user's request down into the shape of the workflow, and ask
   clarifying questions where a step is not clear.
2. **Map** — link the step nodes together based on their input and output shapes.
3. **Refine** — verify that every field a node requires is actually being sent to it, and
   that every field a node reads is actually produced upstream.

This document reports what already exists, what is genuinely missing, and what the cheapest
path to the proposed shape is.

**The short answer:** phase 1 exists. Phase 3 exists but is split across two places that do
not talk to each other. Phase 2 does not exist — and the thing that would make it work is
already built, already accepted by the parser, already preferred by the compiler, and has
never been shown to the model.

---

## Part 1 — how generation works today, in plain terms

A person types a goal. One model call produces the **entire** workflow: every step, every
parameter, and every wiring expression. That answer is checked by ~14 pure functions. If any
check fails, the findings are appended to the prompt and **the whole workflow is asked for
again**, up to three attempts total.

Measured on `gpt-5.6-luna` (2026-09-10): a draft takes 1.5–2.0 attempts and ~26 s. Generation
is decode-bound, so the cost is dominated by how many tokens get emitted and how many times.
`draft-measure`'s own summary line states the conclusion:

> the lever is ATTEMPTS: every rejection re-emits the whole flow.

### Where each phase lives now

| Phase | Where | State |
| :--- | :--- | :--- |
| 1 · breakdown + clarify | `services/flow-clarify.ts` | **Exists and is already a separate call.** 0–3 questions before drafting; answers are rendered into the draft prompt as `STATED FACTS` the drafter may not re-decide. |
| 2 · mapping | — | **Does not exist.** Wiring is produced inline, in the same call, as hand-written expression strings. |
| 3 · verification | `flow-model-findings.ts` (14 checks) **and** `flow-validator.service.ts` `assertValid` (12 checks) | **Exists, split.** Only the first set feeds the retry loop. |

---

## Part 2 — Finding 1: the model writes the hardest possible thing

### What it is asked to write

To say *"send an email to each overdue customer, using their email address"*, the model today
emits this, as one JSON string field:

```
"paramsExpr": "[{\"to\": {{ json(outputs.fetch.body).results[0].data | jq('[.[] | {to: .customer_email}]') | first }}}]"
```

Read the nesting outward: **jq** inside **Pebble** inside a **JSON string** inside **JSON**.
Four layers of quoting and escaping, authored character by character, by a model, with three
attempts before the whole generation fails.

Most of the check layer exists to catch mistakes in exactly this string. Of `SHAPE_CHECKS`'
ten checks, five (`checkJsonPositions`, `checkPluckedThenJq`, `checkFreeTextInQuotes`,
`checkEncodedInQuotes`, `checkTextValueThenJq`) do nothing but catch quoting and piping
errors in it. Each was added after a real workflow failed at execution.

### What the product actually stores

The same wiring, in the model the rest of the system uses
(`packages/flow-edit/src/node-types.ts`):

```json
{ "name": "to", "source": { "from": "step", "stepId": "fetch", "field": "customer_email" } }
```

No quoting. No escaping. Three named facts.

### The part that matters: this path is already complete

This is not a proposal for new infrastructure. Every piece is built and in production:

| Step | Where | What it does |
| :--- | :--- | :--- |
| The draft parser **already accepts** typed bindings | `flow-drafted-shape.ts` — `draftedInputsSchema` | `inputs: [{name, source}]` is a declared, optional field on every call step |
| Typed bindings **already win** over the string | `flow-edit/src/model-version.ts` — `normaliseCall` | when bindings are complete, `paramsExpr` is *deleted* |
| The compiler **already renders** the expression from them | `flow-compiler.service.ts` — `displayParams` → `buildFanOutParams` / `buildSingleParams` | produces a string that is inside D-22's allowlist *by construction* |
| Chat **already teaches** them | `flow-chat.service.ts` — the `set_binding` op | and the rule reads: *"Changing a recipient is `set_binding`, NEVER rewriting the whole `paramsExpr` blob — a blob rewrite is refused."* |

**The drafter is the only authoring path in the product still writing blobs.** `paramsExpr`
is mandatory in the draft schema (`z.string().min(1)`), and `inputs` appears nowhere in
`SHAPE_LINE` — the table of what a step may contain, as told to the model.

So the capability is reachable by the parser and unreachable by the model. This is the same
defect shape `chat-op-vocabulary.test.ts` was written to prevent for chat ops; there is no
equivalent guard for step *fields*.

### What it would remove

`scenarios/draft-measure.ts`'s `classify()` sorts every rejection into 16 named buckets.
Those buckets exist because each was observed in a real run. **Ten of the sixteen are pure
expression-string mechanics** — typed bindings make them unrepresentable, not merely caught:

> nested `{{ }}` (I-11) · `@encoder` outside jq (I-43) · jq builtin at pebble level ·
> jq filter at pebble level (I-118) · unbalanced literal brackets (I-113) · invented key on a
> step body (I-117) · unknown expression root · unknown expression call · wrong output shape ·
> structure in a JSON string

The six that survive are the ones that *should*: wrong step kind, invented ref, missing
required field, bad field value, outline count, and a refusal.

It also repairs a check that currently gives up silently. `checkFlowParams` — the check for
*"does this step pass the parameters its target declares?"* — reads:

```ts
const used = literalParamKeys(step.paramsExpr ?? "");
if (!used) continue;   // could not read them
```

`literalParamKeys` is a hand-written brace-and-quote scanner over the four-layer string above.
When it cannot parse (a jq program, an ambiguous nesting), it returns `null` and the required-
parameter check says nothing at all. With typed bindings, `used` is `inputs.map(b => b.name)` —
exact, and always readable.

---

## Part 3 — Finding 2: phase 3's strongest check never gets a retry

`checkRefOutputFields` (`services/flow-ref-columns.ts`) is precisely the phase-3 check being
asked for: *does a step read a field the upstream node actually returns?*

It is the check that found **14 of 29** transform steps on this deployment reading a column
that does not exist. Only the ones feeding an email went red — a null recipient is refused by
the mail route. The rest settled **SUCCESS** with wrong data, which is the dangerous half.

It is called in exactly one place: `flowValidator.assertValid`, which runs at
`flowService.writeRevision` — **after** `draftFlow` has returned and after fragments have been
generated. The draft retry loop never sees it.

The same is true of `checkFlowInputResolution`, `checkFlowOutput`, `checkUnknownBindingSteps`,
`checkLlmModels`, `checkHttpSteps` and `checkMailAddressSteps`.

**The consequence:** the drafter gets three attempts at expression *syntax* and zero attempts
at *"are the fields actually wired correctly."* That arrives later as a thrown error, after
the expensive part is paid for. This is I-48's shape — *"the caps used to fire only AFTER
generation had been paid for"* — one layer along.

`checkRefOutputFields`' findings already carry the full column list, and its docblock says
why: so a corrective pass can hand the model the projection instead of asking it to guess
again. Nothing currently does that.

---

## Part 4 — Recommendations, in priority order

### R1 · Teach `inputs`; make `paramsExpr` optional in the draft schema

Highest leverage by a wide margin, and the smallest change: a prompt edit plus one schema
relaxation. Every downstream consumer already prefers bindings, so nothing else has to move.

Ship it behind the existing shape-digest test in `flow-step-shapes.test.ts`, so the prompt
bytes move once and deliberately.

### R2 · Split drafting into **shape → mapping**, with the full check set between

This is phase 2, and the split is what makes phase 3 affordable.

- **Call A — shape.** Emits `{id, kind, ref, dependsOn, name}` only. A few hundred tokens.
  A rejection here re-emits a skeleton, not a workflow.
- **Between A and B — the fact sheet.** Hand the model the *exact* port list for every node it
  chose: `RefInterface.params` for inputs and `RefInterface.columns` for outputs. Both are
  already computed, in one round trip, by `refFindings`. Today the model chooses column names
  from the operation's *name*, which is what produced the 14-of-29 defect.
- **Call B — mapping.** Emits bindings only, against a closed set of `(stepId, field)` pairs.
  Most of `checkRefOutputFields` becomes a set-membership test rather than a stage-aware jq
  scanner.

### R3 · Move the `assertValid` checks that can produce a finding into the draft loop

They are pure functions over the model and cost nothing to run. This is what turns phase 3
from a post-hoc throw into a corrective pass.

### R4 · Add a vocabulary-coverage test for step fields

Mirroring `chat-op-vocabulary.test.ts`: every field `draftedStepSchema` accepts must appear in
`SHAPE_LINE`, or be explicitly exempted with a reason.

Two live examples of the drift this closes: `inputs` is **accepted and untaught** (the model
cannot reach a capability that works), and `assistant` is **taught and schema-less** (the model
is offered a step the parser refuses). Both are currently invisible.

---

## Part 5 — Constraints that must survive the change

### A refusal must still end the loop, in all three phases

`§6.7` / D-38: a refusal is never retried. Re-asking is how a correct *"I cannot build this"*
becomes an invented value on attempt 2 — the measured `period="2023-10"` failure this whole
programme was built around.

A three-phase pipeline creates **three** places a refusal can arrive and three places to
accidentally `continue`. `draftFlow` already carries a long comment about a deleted "threshold
safety net" that was removed for exactly this: it ended in `continue`, which retried a
refusal. Read that comment before wiring the phases together.

### Phase 1 must not become a retry channel

`flow-clarify.ts` is deliberately advisory — a failed clarify call returns zero questions and
drafting proceeds, so a broken gate never blocks creation. `flow-inputs.ts` states the risk
directly: *"the whole risk of a clarification exchange is that it becomes a retry with a
different label."* **Phase 2 and phase 3 must not be able to bounce back into phase 1.**

### Typed bindings do not cover everything, and should not try

The win is on call steps — `tool`, `datasource`, `query` — which is where the measured
failures are. These stay expression-shaped and that is correct:

- `transform` bodies are genuinely jq programs.
- `branch` conditions beyond the eleven-operator `BranchTest` vocabulary.
- `code` contracts, which are a different artefact entirely.

### Prompt caching

Block order in `buildDraftPrompt` and `buildChatPrompt` is load-bearing: everything constant
for a workspace goes first, the varying ask goes last. Three phases means three prefixes, each
cached separately. That is fine, but the discipline has to be repeated per phase rather than
assumed.

---

## Part 6 — Measurement debt, and why it blocks this work

Per `CLAUDE.md`, **`draft:measure`, `outline:measure`, `chat:measure` and `kestra:refusal` are
all stale** — four prompt changes deep, `chat:measure` more than that. There is currently **no
valid generation number for this build.**

That means any change here would be measured against a baseline that does not exist.

> **Take a baseline on the model `/ai-provider` actually resolves — read
> `resolveGenerationProvider()`, never the env var — before touching `SHAPE_LINE`, not after.**

Without it, the improvement and the model's own run-to-run variance are indistinguishable.
That trap is already recorded once: `chat:measure` scenario 1 went 2-of-5 → 5-of-5 across two
runs, and the honest reading is that both are single conversations.

Note also that `kestra:refusal`'s **control weakened** on `gpt-5.6-luna` — it refused 1 of 3
on a *satisfiable* contract. Any refusal-rate number from this model needs that beside it.

---

## Open questions for the team

1. **Does phase 2 emit bindings for every call step, or only where the shape is unambiguous?**
   A partial answer (`source: null`) is representable and the panel renders it as *unknown* —
   which may be a better outcome than a guess, and is already the normaliser's fail-closed
   behaviour.
2. **Does the fact sheet between A and B go into the prompt, or does phase 2 become a
   per-step call?** Per-step is more accurate and costs N calls; one call over a rendered port
   table keeps the cost flat. Neither has been measured.
3. **Does `paramsExpr` stay as an escape hatch, or is it removed from the drafter entirely?**
   Chat already refuses a blob rewrite. The same argument may apply here.
4. **Does the outline mode's step-count check still make sense** when phase A is the shape and
   phase B is the wiring? `validateOutline` currently counts steps on the whole draft.
