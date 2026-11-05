# Phase 1 Data Model: Authentication on the unguarded surfaces (V2)

One new table. No change to any existing table's columns.

---

## `workspace_api_credentials`

A bearer credential scoped to exactly one workspace (Q3). Used in two lifetimes:
long-lived service credentials for the MCP bridge, and single-use 30-second
tickets for the progress WebSocket (research R3). Same table, same verification
routine, distinguished by `audience` and `expires_at`.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, default random | |
| `workspace_id` | uuid | **NOT NULL**, FK → `workspaces.id` **ON DELETE CASCADE** | Article XII |
| `key_id` | varchar(32) | **NOT NULL**, **UNIQUE**, indexed | Lookup prefix. Not a secret and never the auth check — see below |
| `secret_hash` | varchar(255) | NOT NULL | `scrypt` digest. Never the plaintext |
| `salt` | varchar(64) | NOT NULL | Per-credential, 16 random bytes hex |
| `audience` | varchar(32) | NOT NULL, CHECK ∈ (`mcp`, `ws_progress`) | What the credential may be presented to |
| `script_id` | uuid | NULL, FK → `scripts.id` ON DELETE CASCADE | Set only for `ws_progress` tickets; binds a ticket to one script |
| `label` | varchar(255) | NULL | Operator-facing description, e.g. "Tether registration" |
| `expires_at` | timestamptz | NULL | NULL = long-lived. Tickets: `now() + 30s` |
| `consumed_at` | timestamptz | NULL | Single-use marker. Tickets only |
| `single_use` | boolean | NOT NULL, default false | True for tickets |
| `last_used_at` | timestamptz | NULL | Observability (Article V) |
| `revoked_at` | timestamptz | NULL | Soft revocation; a revoked row still refuses |
| `created_at` | timestamptz | default now() | |

### Constraints and indexes

- `UNIQUE (key_id)` — the lookup path. Exactly one row fetch per verification.
- `INDEX (workspace_id)` — listing and cascade performance.
- `INDEX (expires_at) WHERE expires_at IS NOT NULL` — ticket reaping.
- `CHECK (audience IN ('mcp','ws_progress'))` — follows V1's precedent of
  enforcing enums in the database, not only in Zod (US5 of V1 added four such
  constraints; this is the fifth).
- `CHECK (audience <> 'ws_progress' OR script_id IS NOT NULL)` — a progress
  ticket that is not bound to a script would be a workspace-wide listening
  grant. The database refuses to store one.
- `CHECK (single_use = false OR expires_at IS NOT NULL)` — a single-use
  credential with no expiry can be left dangling forever if never consumed.

### Why `key_id` is not a prefix-validated key

Article IX's gate says "no key validated by prefix". This design has a prefix,
so the distinction matters and is called out deliberately:

- `key_id` selects **which row** to check. It is public, low-entropy, and
  carries no authority.
- The authority is `secret`, verified as
  `timingSafeEqual(scrypt(presented_secret, salt), secret_hash)`.

A prefix-validated key would be one where matching the prefix *grants* something.
Here, matching the prefix grants a database lookup and nothing else. The reason
for the prefix at all is defensive: without it, verification would have to hash
the presented secret against every candidate row, letting an unauthenticated
caller force N `scrypt` runs per request.

### Presented token format

```
fdy_<key_id>.<secret>
```

- `key_id`: 16 bytes, base64url — 22 chars.
- `secret`: 32 bytes, base64url — 43 chars.
- Split on the **first** `.`; reject anything without exactly one separator,
  anything whose parts are not the expected length, and anything failing the
  base64url character class, **before** touching the database.
- The `fdy_` prefix exists so a leaked credential is recognisable in a log or a
  paste, and so a secret scanner can be taught the shape.

### Lifecycle

**MCP credential** (`audience='mcp'`, `single_use=false`, `expires_at=NULL`)

```
issued ──► active ──► revoked        (revoked_at set)
                └───► workspace deleted (row cascades away)
```

Issued through an authenticated parent-API call. The plaintext is returned
**once**, at issuance, and is not recoverable afterwards — which is the point of
storing a digest (research R1).

**Progress ticket** (`audience='ws_progress'`, `single_use=true`, 30s TTL)

```
minted ──► consumed        (consumed_at set, at upgrade)
       └─► expired         (expires_at passed, never consumed)
```

Consumption is a conditional update — `SET consumed_at = now() WHERE id = $1 AND
consumed_at IS NULL` — and the socket proceeds only if that update affected one
row. This makes "single use" atomic rather than a read-then-write race two
concurrent upgrades could both win.

### Validity predicate

A presented credential is valid iff **all** hold:

1. The token is well-formed (checked before any query).
2. A row exists with that `key_id`.
3. `revoked_at IS NULL`.
4. `expires_at IS NULL OR expires_at > now()`.
5. `single_use = false OR` the conditional consume affected one row.
6. `audience` matches the surface being called.
7. `timingSafeEqual` over the digests succeeds.
8. For tickets: `script_id` matches the requested script.

Any failure produces the **same** refusal to the caller (FR-003, SC-003) and a
**specific** reason in the log (Article V). Which of 1–8 failed is never
observable from the response, including by timing — hence the digest comparison
runs even when the row is missing, against a dummy salt.

### Relationship to existing tables

- `workspaces` — parent. Cascade delete satisfies Article XII's "new tables
  cascade-delete with the workspace".
- `scripts` — referenced by tickets only, also cascading.
- `workspace_secrets` — **unrelated**, and deliberately not reused. That table
  holds secrets the parent must *present* to something else, so its values are
  reversibly encrypted. These are secrets the parent only *verifies*, so they are
  digested and unrecoverable. Storing both in one table would force the weaker
  treatment on both (research R1).
- `workspaces.tether_api_key` — unchanged, still AES-256-GCM via
  `utils/encryptor.ts`, for the same reason.

## Entities not stored

- **Upstream path allowlist** — code, not data (`lib/proxy-allowlist.ts`). It
  must be reviewable in a diff and testable by import; a database table would
  make it silently editable at runtime, which is the opposite of what an
  allowlist is for.
- **Role → operation mapping** — same, and it lives with the allowlist because
  each entry carries its required role (research R4).
- **`Origin` allowlist** — environment (`WS_ALLOWED_ORIGINS`), since it differs
  per deployment.
