# Quickstart — verifying V7

Contract IDs (E1…, C1…, S1…, N1…, G1…, A1…) refer to
[contracts/shared-rules.md](contracts/shared-rules.md).

## Prerequisites

```bash
cd foundry
pnpm install
```

No database is needed. Everything here is pure.

## §0 — Baseline

```bash
pnpm -r typecheck
```

```bash
pnpm --filter @foundry/server test
```

```bash
pnpm --filter @foundry/client test
```

Record the counts in `notes.md`. Then record the **exact current message string
for every primitive** in `packages/server/src/validation/primitives.ts`. **S3**
requires them byte-identical afterwards, and "it looked the same" is not a check.

## §1 — Shared package (slice 1)

```bash
pnpm --filter @foundry/shared test
```

- **E5** — the definitions module imports nothing from either consumer, contains no
  functions and no zod. Assert it structurally, not by convention.
- **C5** — patterns are exported as source strings, never as `RegExp` objects. A
  shared `RegExp` with `g` carries `lastIndex` across consumers, which is an
  intermittent bug that is very hard to find from the symptom.
- The case table exists for every rule, and **every rule has a non-empty
  `accepted` list** — a table with only rejected values cannot catch **E2**.

## §2 — Server rebuilt on it (slice 2)

```bash
pnpm --filter @foundry/server test
```

- **S2** — `primitives.test.ts` passes **unchanged**. If you had to edit it,
  behaviour changed, and that is not permitted here. Stop and find out what moved.
- **S1** — every export still exists under the same name.
- **S3** — diff the message strings against §0's record.
- **S4** — `zEnvVarName` still accepts lowercase, and the comment explaining why
  travelled with the definition.
- **E4** — the test that every primitive is constructed from a shared definition.
  Verify it works by temporarily reverting one primitive to a literal pattern and
  confirming the test fails. A guarantee nobody has seen fail is a guarantee nobody
  has verified.

## §3 — Client checker (slice 3)

```bash
pnpm --filter @foundry/client test
```

- **E1/E2/E3** — the equivalence test, driven from the shared case table, run
  through both consumers. This is the feature's core guarantee; it lives here and
  in §2 rather than in one place, because both sides must be exercised.
- **C1** — `check` returns an empty array for valid input.
- **C4** — assert there is **no** client-side counterpart to `tool.schema.ts`'s
  cross-field auth rules. This is a test that something does *not* exist, which is
  unusual and correct: FR-005 says the client must not approximate what it cannot
  express, and an approximation would be added in good faith by someone who did not
  know the rule.

## §4 — Forms adopt it (slice 4)

- **C3** — a `FormField` carrying `required`, `min`, `max` and `integer` rejects
  and accepts values accordingly.
- **C2** — every producer returns `ValidationProblem[]`.
- **A2** — every value the forms accept today is still accepted. Drive the existing
  form tests unchanged.
- Manually: enter a bad tool name and a bad env-var name in the UI; confirm the
  message is the server's, and that no request is sent.

## §5 — Idiom alignment and rename (slice 5)

- **C2** — `gateFor` and `validatePlan` return the common shape; their call sites
  are updated.
- **A1 — the SC-004 audit.** Enumerate every rule the client enforces and find its
  server counterpart. Record the table in `notes.md`. `MIN_PROMPT_LENGTH` and
  `validatePlan`'s structural rules are the two known candidates for having none;
  each is either derived from a server rule or **recorded as a finding for a
  separate feature**. Neither is closed here — adding a server rule is a behaviour
  change with its own regression risk.
- **N1–N4** — the rename: no `validation.ts` holding non-validation logic, the
  storage key unchanged, the SSR guard intact, no stale imports.
- Verify **N2** by hand: with a recorded verdict in localStorage from before the
  rename, reload and confirm it is still recognised. A test with a fresh store
  cannot catch a changed key.

## §6 — Gate coherence and hardening (slice 6)

Requires V5. If V5 has not shipped, skip §6's gate items and say so in `notes.md`
rather than ticking them.

- **G1** — the go-live affordance reflects the server's readiness decision.
- **G2** — clear localStorage; the server's decision still governs.
- **G3** — construct the disagreement both ways. Local says validated + server says
  refused → refused. Local says not validated + server says ready → not offered.
  The store blocks, never permits.

### Deletion pass (A4)

Delete each, run the full suite, record CAUGHT/SURVIVED in `notes.md`, revert:

1. the **E4** derivation test (should immediately allow a literal to creep back)
2. the client's use of the shared message (should break **E3**)
3. the `accepted` half of the case table (should break **E2**)
4. one `FormField` constraint check
5. the `gateFor` shape alignment
6. the `validatePlan` shape alignment
7. the SSR guard in the renamed module
8. the server's construction of one primitive from the shared definition

Point 3 is the one to watch. If deleting every `accepted` value leaves the suite
green, then nothing is testing **E2**, and the client being stricter than the
server — the failure that generates no error report — is unguarded.

### Regression

Re-run §0 and compare. **A3** — confirm `packages/client/package.json` gained no
runtime dependency.
