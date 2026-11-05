# Contract — shared rules and client checking

Each invariant reads as a test name. `tasks.md` references them by ID.

## E — Equivalence (the feature's core guarantee)

- **E1** — For every shared rule and every value in its `rejected` list, the
  server's zod primitive and the client's checker both reject it.
- **E2** — For every shared rule and every value in its `accepted` list, both
  accept it. *This is the one that catches a client stricter than the server, which
  produces no error report and so is never reported.*
- **E3** — For every shared rule, the client's message equals the server's message,
  character for character.
- **E4** — Every server primitive is constructed from a shared definition. A
  primitive that reverts to a literal pattern fails this test. **This is what makes
  FR-003 structural rather than a review convention.**
- **E5** — The shared package's rule definitions contain no functions, no zod, and
  no imports from either consumer.

## C — Client checking

- **C1** — `check(value, rule)` returns `ValidationProblem[]` — empty when valid.
- **C2** — Every producer (`gateFor`, `validatePlan`, form-field check) returns the
  same shape.
- **C3** — A `FormField`'s `required`, `min`, `max` and `integer` constraints are
  checked against a value.
- **C4** — A rule the client cannot express is **not checked** on the client, and
  is not approximated (FR-005). Concretely: the cross-field auth rules in
  `tool.schema.ts` have no client counterpart, weakened or otherwise.
- **C5** — Compiling a rule's pattern creates a fresh `RegExp` per call site; no
  shared `RegExp` object is exported (stateful `lastIndex` across consumers).

## S — Server preservation

- **S1** — Every export of `validation/primitives.ts` still exists with the same
  name.
- **S2** — The server's existing `primitives.test.ts` passes **unchanged**. If it
  needed editing, behaviour changed, and this feature is not permitted to change
  behaviour.
- **S3** — Every message string is byte-identical to before this feature. The
  register inconsistency ("must be…" / "Must be…") is preserved; improving it is a
  separate commit.
- **S4** — `zEnvVarName`'s deliberate case-insensitivity, and the comment
  explaining why, survive into the shared definition.

## N — Naming

- **N1** — No file named `validation.ts` in the client holds non-validation logic.
- **N2** — The localStorage key `foundry.validatedBuilds.v1` is unchanged, so no
  existing recorded verdict is invalidated.
- **N3** — The SSR guard (`typeof window === "undefined"`) survives the rename.
- **N4** — No stale import of the old module path remains.

## G — Gate coherence (US4, depends on V5)

- **G1** — The client's go-live affordance reflects the server's readiness
  decision.
- **G2** — With the local verdict store cleared, the server's decision still
  governs.
- **G3** — The local store can **block** a go-live and can never **permit** one the
  server would refuse.

## A — Audit and non-regression

- **A1** — Every rule enforced on the client has an identified server counterpart,
  or is recorded as a finding (SC-004, FR-006). `MIN_PROMPT_LENGTH` and
  `validatePlan`'s structural rules are the two known candidates.
- **A2** — No value accepted before this feature is rejected after it, unless the
  server rejects it too (FR-014).
- **A3** — `packages/client` gains no new runtime dependency (SC-008).
- **A4** — Each new wiring point, deleted individually, makes the suite fail.
