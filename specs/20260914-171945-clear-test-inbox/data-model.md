# Data model: Clear test inbox

No schema change. No migration. The feature moves rows out of one existing
table; everything below already exists.

## `mail_outbox` (ops-api owned, `packages/ops-api/src/db/schema.ts`)

- `id` uuid PK · `message_id` varchar(128) · `sender` varchar(256)
- `recipients` jsonb · `subject` · `body` · `status` · `bounce_reason`
- `sent_at` timestamptz · index `idx_mail_outbox_sent`

**Clear semantics**: `DELETE FROM mail_outbox` (no `WHERE` — the table has no
workspace column, which is exactly why the confirmation names the shared
scope). Plain `DELETE` rather than `TRUNCATE ... RESTART IDENTITY`: no
sequence/identity columns are consumed by inserts (uuid default), and `DELETE`
returns a row count for the response.

## `email_sends` (parent owned) — explicitly NOT touched

Workspace-scoped send/audit record. The clear path issues no statement against
it; the server test pins the route to `clearRecords("mail")` so a future edit
cannot quietly widen it to the audit record.

## Clear result (wire shape)

```text
DELETE /api/workspaces/:ws/email-box/simulated
→ 200 { ok: true, cleared: <number of mail_outbox rows deleted> }
→ 503 { error: … } when ops-api cannot be reached (OpsApiError passthrough)
```
