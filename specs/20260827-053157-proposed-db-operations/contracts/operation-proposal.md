# Contract: operation proposal

`POST /api/workspaces/:workspaceId/datasources/:dsId/operations/propose`

Behind `requireApiKey`, like every other route on `datasourcesRouter`. **Read-only with respect to
`db_operations`** — this route creates nothing (FR-010).

---

## Request

```json
{ "need": "read invoices that are overdue as of a given date, with the customer's name" }
```

| Field | Rule |
| :--- | :--- |
| `need` | required, 3…2000 chars. One sentence describing the data required. |

⚠ **There is no field for a DSN, a schema, a table list, a goal, a flow id or a row of data.** The
proposer's inputs are resolved server-side from `:dsId` (FR-005). A field here would be a caller
supplying part of the proposer's world, which is the isolation this feature's safety rests on.

---

## Response — channel 1: a proposal (HTTP 200)

```json
{
  "status": "ok",
  "name": "overdue_invoices",
  "description": "Invoices past their due date as of a supplied date, with the customer name.",
  "spec": {
    "base": { "table": "invoices" },
    "columns": [
      { "column": "id",        "alias": "invoice_id" },
      { "column": "amount",    "alias": "amount" },
      { "column": "due_date",  "alias": "due_date" },
      { "column": "name",      "alias": "customer_name" }
    ],
    "joins": [
      { "table": "customers", "onLeft": "customer_id", "onRight": "id", "kind": "inner" }
    ],
    "filters": [ { "column": "due_date", "op": "lt", "param": "as_of" } ],
    "sort":    [ { "column": "amount", "dir": "desc" } ],
    "limit": 500
  },
  "readback": [
    { "label": "From",       "text": "invoices" },
    { "label": "From",       "text": "each row matched to customers, by customer_id = customers.id",
      "note": "invoices with no matching row in customers are LEFT OUT of the result" },
    { "label": "Kept when",  "text": "due_date is BEFORE the value you supply — for a number, LESS THAN it (as_of)" },
    { "label": "You get",    "text": "invoice_id ← id · amount ← amount · due_date ← due_date · customer_name ← name" },
    { "label": "Ordered by", "text": "amount, largest first — for dates, most recent first" },
    { "label": "At most",    "text": "500 rows" }
  ],
  "outputColumns": [
    { "alias": "invoice_id",    "source": "invoices.id",     "type": "integer" },
    { "alias": "amount",        "source": "invoices.amount", "type": "numeric" },
    { "alias": "due_date",      "source": "invoices.due_date","type": "date" },
    { "alias": "customer_name", "source": "customers.name",  "type": "text" }
  ],
  "compiledSql": "SELECT …",
  "paramsSchema": { "as_of": { "type": "string", "required": true } },
  "attempts": 1,
  "maxPerRequest": 3
}
```

| Field | Notes |
| :--- | :--- |
| `name` | Editable by the person **before** creation. Validated against `dbOperationBodySchema`'s identifier regex. ⚠ Immutable after save — it is half of every `<datasource>.<operation>` ref (FR-012, D-173). |
| `spec` | A `DbOperationSpec`. **Unchanged schema** — this feature adds a producer, not a shape. |
| `readback` | ⚠ **The primary review artefact** (FR-011, D-178). Ordered labelled clauses, rendered from the **spec** by **pure code** — never by a model (FR-022). `note` is where a decision's consequence is stated. ⚠ **The sample above is the ACTUAL output of `readback()` for the spec above**, not an illustration — it was an illustration until P1b, and it read better than the real thing in two ways worth knowing: a label can **repeat** (one `From` clause per join, so each join carries its own note), and the join condition is spelled out because it is the part most likely to be wrong. A `Kept when`, `Ordered by` and `At most` clause is emitted **even when the spec is silent** — see plan Decision 18 (**D-187**). |
| `outputColumns` | `alias ← source (type)`. Pure schema metadata, resolved by the compiler. Lets a reviewer check *"am I getting the right columns?"* with no SQL. |
| `compiledSql` | From `dbOperationService.check()`. `SELECT`-only by construction. **Available, collapsed — not the primary artefact** (FR-011). |
| `paramsSchema` | *Derived* from `spec.filters`, in order. Never supplied by the model. |
| `attempts` | Inference calls spent. `> 1` means `check()` findings were fed back. |
| `maxPerRequest` | `MAX_PROPOSALS_PER_REQUEST` — FR-014's bound, **on both channels**. ⚠ Added during P1b: FR-014 requires the bound to be **on screen**, and a surface hardcoding the number would be a second definition of it. It is not enforced server-side and cannot be — one propose call has no notion of "this generation", and the server holds no proposal state because D-170 forbids persisting one. See plan Decision 21 (**D-189**). ⚠ **How a surface states it before the first response was settled in P2 — plan Decision 26 (D-194): it does not.** The number is held from the first response of the visit; the catalogue's `caps` was considered and rejected. The bound is on screen at every point a person can reach it, because *"Propose another"* only exists once a response has arrived. |

---

## Response — channel 2: a refusal (HTTP **200**)

```json
{
  "status": "insufficient_schema",
  "missing": ["a due date or invoice date column"],
  "reason": "no column in the introspected schema carries a date; overdue cannot be expressed",
  "maxPerRequest": 3
}
```

⚠ **`maxPerRequest` is on this channel too.** A refusal spends one of the N — it costs an inference
call and a person's attention — so a surface counting only proposals would offer N+1.

⚠ **200, and it is a SUCCESS.** Same rule as `insufficient_catalogue` and `insufficient_contract`
(§6.7 / D-38): a refusal naming the boundary is the most useful answer this path produces, and a 4xx is
how a client renders it as a failure and retries it.

⚠ **Never retried** (FR-008, D-171). Re-asking is how *"there is no due date column"* becomes a
plausible-looking `created_at` on attempt 2.

⚠ **No Retry button on any surface that renders this.**

---

## Errors

| Status | When |
| :--- | :--- |
| `400` | `need` missing or out of bounds |
| `404` | datasource not in this workspace |
| `409` | **schema not introspected** — the fix is a re-scan, and the message must say so. ⚠ Never propose against an empty schema. |
| `422` | **three attempts produced no spec that compiles.** ⚠ Added during P1b — the original table had no row for it, and something has to happen. This is a **failure, not a refusal**: `insufficient_schema` names a boundary in the schema, this names three answers the compiler rejected. The `findings` travel with it (the 4xx branch of `error.middleware.ts` carries `findings`), because they are the only actionable part. **No Retry button** — the same rule the refusal channel follows. |
| `502` | the inference gateway is unreachable. **Infrastructure, not a bad proposal** — it must not consume an attempt |

---

## `check()` returns the readback too — deliberately

`readback` and `outputColumns` are **added to `dbOperationService.check()`'s existing response**, not
invented for this route (FR-026).

Three consequences, all wanted:

* **One implementation.** A client-side renderer would be a second definition of what a spec means, and
  the two would drift toward a screen that disagrees with the SQL.
* **It recomputes on every edit.** The panel already round-trips to `check()` when a spec changes, so
  editing a join from `inner` to `left` updates the sentence with no new mechanism.
* **The human-driven panel gains it for free.** A readback that only *proposed* operations carried would
  be two review standards for one artefact, chosen by who authored it.

⚠ **The readback is never persisted.** It is a function of the spec, and the spec is what is stored —
storing a rendering as well is two sources of truth for one fact, and the stale one wins arguments.

---

## Saving an approved proposal

**No new route.** The existing `POST /:dsId/operations` takes it, unchanged:

```json
{ "name": "overdue_invoices", "description": "…", "spec": { … } }
```

⚠ **The submitted spec is re-run through `check()` and `create()`** (FR-013, D-170). A proposal id is not
authorisation, and no field here carries one — the dialog is editable by design, so the spec that arrives
is frequently not the spec that was proposed. `create`'s 409 on a duplicate name stays as the atomic
backstop.

---

## Invariants a test must hold

| # | Invariant | Source |
| :-- | :--- | :--- |
| 1 | No `db_operations` row exists after a propose call that was not followed by a save | SC-004 |
| 2 | The proposer's module source contains no DSN, connection string, database handle, row fetch, or read of any other datasource's schema | FR-006 |
| 3 | A status-less response is **rejected**, never read as `ok` | D-171 |
| 4 | `insufficient_schema` spends exactly one attempt | FR-008 |
| 5 | A `check()` finding is fed back **verbatim**, with nothing added | FR-009, I-57 |
| 6 | Creating a proposed operation moves **0** existing ref fingerprints | SC-003, FR-015 |
| 7 | The proposer module imports nothing from `flow-generation.service.ts` | FR-018 |
| 8 | `readback()` renders a **different** sentence for `inner` than for `left`, and for `lt` than for `lte` — with a control asserting the test fails if they collapse | SC-007, FR-023 |
| 9 | `readback()` is reachable **without** an `InferenceClient` — it is pure, and a test constructs it with no model at all | FR-022 |
| 10 | No surface renders a row of data that did not come from the tenant's database | SC-008, FR-024 |
| 11 | A 409 for an un-introspected datasource spends **zero** inference calls, and its message names the re-scan | FR-007 |
| 12 | A 502 spends **one** call and does not retry | this contract's error table |
| 13 | The first prompt is a byte-exact **prefix** of the retry prompt — findings go after the NEED | prefix caching |
| 14 | The prompt's enum lines are rendered **from** `FILTER_OPS` / `JOIN_KINDS`, never retyped | D-176's pairing, inverted |
| 15 | The proposer's module source contains no ` FROM `, ` WHERE `, ` JOIN `, `$1`, and exactly **one** mention of `SELECT` — the prompt's own disclaimer | SC-002 |
| 16 | `/operations/check` and `/operations/propose` are declared **before** `/:dsId/operations/:name`, and no `POST` on `:name` exists | T09's ordering hazard |
