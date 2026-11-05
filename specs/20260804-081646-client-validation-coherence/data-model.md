# Data Model — V7 Client-Side Validation Coherence

Nothing is persisted. This feature defines two shapes and moves one storage key
nowhere.

## Rule definition (`@foundry/shared`)

A rule is **plain data**. No functions, no library types, no zod — that is what
lets the client consume it without a dependency (plan D1).

| Field | Meaning |
|---|---|
| `name` | stable id, e.g. `envVarName` |
| `pattern` | regex **source string**, or absent |
| `flags` | regex flags, or absent |
| `minLength` / `maxLength` | bounds, or absent |
| `message` | the message, **copied verbatim from the server's current wording** |
| `describes` | one plain sentence for a form hint |

**`message` is copied, not improved.** FR-002 requires the client to use the
server's message; the server's messages are currently inconsistent in register
("must be…" and "Must be…" both appear — research F2). Fixing that is a behaviour
change and belongs in its own commit, not hidden inside a refactor.

**Regex as a source string, not a `RegExp`.** A shared `RegExp` object carries
`lastIndex` state across consumers when `g` is set, which is a genuinely nasty
intermittent bug. Each side compiles its own.

### Rules that move to the shared package

`uuid`, `envVarName`, `identifier`, `httpUrl`, `isoDay`, `yearMonth`,
`positiveInt`, `isoDate`. Each keeps its server behaviour exactly.

`zEnvVarName`'s comment — recording that case-insensitivity was kept deliberately
because tightening would reject requests that succeed today — **moves with the
definition**. Without it, someone tidies the pattern to uppercase-only and breaks
live callers.

### Rules that stay server-only (FR-005, research R2)

Cross-field rules (`tool.schema.ts`'s `superRefine`), uniqueness, and V6's egress
address check. These are **not** put in the shared package in a weakened form. The
client checks the parts it can express — a URL's scheme, say — and does not
approximate the rest.

### Case table

Per rule, in the shared package beside the definitions:

```
{ rule: "envVarName", accepted: [...], rejected: [...] }
```

**`accepted` is not optional.** The failure mode nobody looks for is the client
being *stricter* than the server (FR-004, SC-002): it produces no error report,
just an operator who cannot do something and assumes they are wrong. A table with
only rejected values cannot catch it.

This table is what plan D2's equivalence test runs through both consumers.

## Validation result

One shape, everywhere (research R3):

```
{ field: string, rule: string, message: string }
```

and every producer returns `ValidationProblem[]`.

| Producer | Before | After |
|---|---|---|
| form field check | nothing existed | zero or one per field |
| `gateFor` | `{ ok, reason }` | list of zero or one; `ok` is `length === 0` |
| `validatePlan` | `string[]` | list, `field` naming the step |

A list of zero-or-one is mildly awkward at exactly one call site, and it is what
lets every consumer render problems without knowing which producer made them. The
alternative — a union of three shapes — is three idioms sharing a name.

## `FormField` — validation over constraints it already carries

`manifest-form.ts`'s `FormField` already carries `required`, `min`, `max`,
`integer` from the backend's JSON Schema, and nothing checks them (research F4).
This feature adds the checker, using the shape above. No field is added to
`FormField` unless a rule needs it — the constraints already came from the
backend, which is what makes them undriftable and is why FR-009 says extend rather
than replace.

## Build verdict store — renamed, key unchanged

`lib/validation.ts` → `lib/build-verdicts.ts`. Same record, same behaviour, same
SSR guard.

**Storage key `foundry.validatedBuilds.v1` is unchanged** (FR-011, research R4).
It is an on-disk contract with every browser that has one; the module name is not.
Changing it would invalidate every recorded verdict and force every user to
re-validate — fail-safe, and a real cost for no benefit.
