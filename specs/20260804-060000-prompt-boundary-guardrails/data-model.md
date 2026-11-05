# Phase 1 Data Model — Prompt-Boundary Guardrails

**No persisted schema changes.** No new table, no new column, no migration. Every
entity below is in-memory and derived per request or per run. This is a
consequence of decision R3 (warnings are recomputed, not stored) and is why this
feature adds nothing to the `0011` migration series.

---

## UntrustedSpan

The single vocabulary for "content that reaches the prompt but was not authored by
this repository". Produced by `collectUntrustedSpans(workspaceId)`, consumed by
both the envelope renderer and the detector (R6).

| Field | Type | Meaning |
|---|---|---|
| `source` | `"tool" \| "datasource" \| "schema"` | which registry the content came from |
| `itemName` | `string` | the tool or datasource name, for locating it in the UI |
| `field` | `string` | which field of that item — see the registry below |
| `value` | `string` | the raw content, exactly as registered |

**Field registry** — this list *is* FR-002. Adding a field here is how the
deferred column-comment feature (spec OOS-005) extends the mechanism.

| `source` | `field` | Origin |
|---|---|---|
| `tool` | `name`, `description`, `method`, `url` | operator-registered |
| `tool` | `paramName`, `paramType` | operator-registered, one span per parameter |
| `tool` | `dummyResponseTemplate` | operator-registered; serialised JSON |
| `tool` | `secretEnvName`, `authStyle`, `authParamName` | operator-registered **names only, never values** |
| `datasource` | `name`, `type` | operator-registered |
| `schema` | `schemaName`, `tableName`, `entityKind` | introspected from the remote database |
| `schema` | `columnName`, `columnType`, `foreignKeyReference` | introspected from the remote database |
| *(deferred)* | `tableComment`, `columnComment` | **not collected today** — see OOS-005 |

The last row is listed deliberately. Leaving it out would let a future reader
assume comments were considered and dismissed; listing it as deferred makes the
gap a visible property of the model.

**Invariants**

- `value` is the **raw** registered text. Normalisation happens at match time and
  is never persisted back into the span (R5).
- A span carries no secret **value** — only identifier names. Article VIII.
- The collector is workspace-scoped; a span never crosses workspaces (Article XII).

---

## ManifestWarning

Produced when a span matches an injection pattern. Returned on the manifest build
result; never stored, never part of the content hash (FR-010, R3).

| Field | Type | Meaning |
|---|---|---|
| `source` | same as the span | which registry |
| `itemName` | `string` | the tool or datasource to go and look at |
| `field` | `string` | which field of it |
| `pattern` | `string` | the pattern family that matched, e.g. `instruction_override` |
| `excerpt` | `string` | a bounded excerpt of the **raw** value, so the operator can find it |

**Invariants**

- A warning **never** changes what is delivered. The manifest returned alongside a
  warning is byte-identical to the manifest that would have been returned with
  detection disabled (FR-008, Article XV). This is the invariant most likely to be
  broken by a well-meaning later change, so it carries its own test.
- Warnings are excluded from the hashed body, so raising one cannot bump the
  manifest version (FR-010).
- The list is capped (FR-014). When the cap is reached the result says so
  explicitly rather than truncating in silence.
- Re-raised on every rebuild while the content still matches (FR-009). There is no
  acknowledged/dismissed state — a dismissal would be a stored decision about
  content that can change underneath it.

---

## Prompt envelope

Not a data structure — a rendering contract, recorded here because framing and
detection must stay aligned on it.

- The manifest blocks in the composed prompt are enclosed in a declared data
  region.
- A first-party declaration precedes the region and identifies the manifest **by
  identity**, covering the copy the agent re-reads from `.foundry/manifest.xml`
  inside the sandbox (D1's stated limit).
- Delimiter integrity comes from the existing `xmlEscape` (D5/F3), so no
  per-render nonce is introduced and the cacheable prefix is preserved (FR-005).

---

## AuditFinding — one new code

Extends the existing `AuditFinding` shape in `generation-audit.service.ts`. No new
type, no new field.

| Property | Value |
|---|---|
| `code` | `unrequested_action` |
| `severity` | `medium` → contributes `warn`, never `fail` (D2/R2) |
| `message` | states that the action traces to neither the task nor the manifest |
| `detail` | the concrete evidence — host, env var, or call — capped as the existing findings are |

**Invariants**

- **Excluded** from the set counted by the `undeclared_invention` meta-finding
  (`undeclared_env`, `invented_endpoint`, `unknown_table`). Including it would let
  one underlying fact produce two findings and manufacture a `fail` it did not
  earn (D2). This has its own test.
- The verdict function is unchanged: `any high → fail`, `any finding → warn`,
  `none → clean`.
- Advisory. Nothing presents this finding, or its absence, as a correctness gate
  (Article X, FR-018, SC-007).

---

## New audit input

The one change to what the audit is given.

| Input | Before | After |
|---|---|---|
| `task` | **never passed** | passed from the script row's `description` at `finalizeRun` |

Available without a schema change — the task is already persisted when the script
row is created. This is the substantive part of US3 (finding F1): every existing
finding compares code against the *manifest*; none has ever been able to consult
what the operator actually asked for.
