# Contract: `DELETE /admin/records/:name` (ops-api)

**Owner**: `packages/ops-api/src/routes/admin.ts` · behind `requireRootKey` (unchanged).

## Request

```text
DELETE /admin/records/mail
Authorization: Bearer <OPS_API_KEY>
```

`:name` MUST be one of the existing `READABLE` keys
(`mail | chat | tickets | pages | call-log`). Unknown → `404 { error: { code: "not_found" } }`.
Missing/wrong key → `401` (existing middleware, unchanged).

## Response

```text
200 { ok: true, cleared: <number>, set: "mail" }
```

- `cleared` is the `DELETE` row count for that set's table.
- `llm_provider` is not clearable through this endpoint (not in `READABLE`).
- Clearing `mail` deletes from `mail_outbox` only; every other table is untouched.

## Non-goals

- No replacement for `POST /admin/reset` (harness-wide truncate stays as-is).
- No per-workspace scoping (the tables have no workspace column — stated, not fixed).
