# Data Model — V5 Audit Verdict as an Asymmetric Gate

## New persisted entity

### `audit_overrides`

A durable record that a human read specific findings about specific audited code
and judged them acceptable. One row per override event; never updated, never
deleted by the application.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `test_result_id` | uuid, **not null**, FK → `test_results.id` ON DELETE CASCADE | **The identity of the audited code.** D4: regenerating the script makes a new `test_results` row, so an override cannot carry over to code nobody reviewed. This single column is what makes FR-014 free. |
| `verdict_at_override` | varchar(10), not null | The verdict as it stood. Denormalised **on purpose**: the record must remain readable as a statement about what the human saw, even if the row it points at is later interpreted differently. |
| `finding_codes` | jsonb, not null | The codes present at the moment of override. Same reasoning. |
| `reason` | text, not null | FR-011. CHECK: `length(btrim(reason)) > 0`. The constraint is in the database, not only in the service, because "required" enforced in one layer is required until someone writes a second insert path. |
| `request_id` | varchar(64), null | The request that made it. This is the closest thing to attribution the system can honestly provide (research F2). |
| `created_at` | timestamptz, default now() | |

**Deliberately absent: `overridden_by`.** There is no verified user identity at
the parent API (research F2). A column with that name holding a client-supplied
string would read as attribution and would not be one. When `security.md` §9 R2
is fixed, add a real actor column then — and *replace* `request_id`'s role rather
than sitting beside it, so no record mixes verified and unverified attribution.

**Index**: `idx_audit_overrides_test_result` on `(test_result_id)`. The only
query shape is "is there an override for this audited code?".

## New CHECK constraints on existing tables

Per D5 / FR-016. Only the two on the gate path.

| Constraint | Column | Allowed |
|---|---|---|
| `chk_test_results_overall_status` | `test_results.overall_status` | NULL or the set the finaliser writes — **enumerate from the code before writing the migration, not from memory** |
| `chk_trigger_fires_fired_by` | `trigger_fires.fired_by` | `manual`, `schedule`, `poll`, `webhook` |

Both must be preceded by a data check against the live database. A constraint
added over an existing violating row fails the migration, and this database has
real rows.

**Not touched** (already constrained): `chk_scripts_status`,
`chk_test_results_audit_verdict`, `chk_execution_results_status`,
`chk_triggers_type`, the three ticket constraints.

## Derived, not persisted

### Gate decision — extends the existing `EnableReadiness`

`trigger.service.ts` already has:

```ts
interface EnableReadiness { ready: boolean; reason: string | null; }
```

It grows the fields the client needs to explain an audit block and to offer the
override:

| Field | Meaning |
|---|---|
| `ready` | unchanged |
| `reason` | unchanged — the single most useful sentence |
| `blockedBy` | which condition refused: `script_status`, `never_executed`, `audit_verdict`, or absent when ready. Lets the client render the audit case specifically without string-matching a sentence. |
| `auditVerdict` | the verdict consulted, or null when there is none |
| `blockingFindingCodes` | the high-severity codes that caused an audit block; empty otherwise |
| `overrideRecorded` | whether an override exists for the current audited code |

`blockedBy` is a new field rather than a parse of `reason`, because the client
already renders `enableBlockedReason` as prose and a UI that branches on prose is
a UI that breaks when the prose is improved.

**Invariant**: when `ready` is `true`, `blockedBy` is absent and
`blockingFindingCodes` is empty. `auditVerdict` may be any value including
`clean` — and *nothing may branch on it in the ready case*. It is present for
display only. That sentence is the whole asymmetry rule restated as a field
contract, and it is the thing a reviewer should check first.

### Verdict, as the gate reads it

```
"clean" | "warn" | "fail" | null | <unrecognised>
```

- `fail` → refuse
- `warn` → do not refuse (FR-006)
- `clean` → do not refuse, **and grant nothing** (FR-007)
- `null` → do not refuse, do not grant (FR-008)
- anything else → **refuse**, and log as a defect (FR-015)

The unrecognised branch is not reachable through the application — the existing
CHECK constraint prevents it — and it exists anyway, because a gate whose input
is a string from a database should fail closed when it cannot interpret that
string. It is cheap and it is one of the named tests.

## Client-side types

| Type | Shape |
|---|---|
| `FAAuditFinding` | `{ code, severity, message, detail? }` — mirrors the server's `AuditFinding` |
| `FAAuditReport` | `{ verdict, findings, stats }` — mirrors `AuditReport` |
| `FAEnableReadiness` | the gate decision above, as returned on each trigger |

The client renders `FAAuditReport` **as the parent's independent check**, visually
and textually separate from `buildVerdictFromTests`'s self-reported score
(FR-020). Two verdict-shaped things on one screen with no stated difference is
worse than one, because the reader will average them.
