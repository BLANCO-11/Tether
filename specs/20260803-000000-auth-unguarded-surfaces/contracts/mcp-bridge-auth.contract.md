# Contract: MCP bridge authentication (US1, FR-001…FR-006)

Surface: `POST /mcp` on `packages/mcp-bridge` (`:3015`, published to the host).

## Before

No authentication of any kind. All four tools take `workspaceId: z.string()`
from the caller (`index.ts:22,28,38,47`). Any client that can reach the port
reads any workspace's table names, column names, types, foreign keys and row
estimates.

## After

### Transport

`Authorization: Bearer fdy_<keyId>.<secret>` on the `POST /mcp` request. Verified
once per request, before the MCP server is constructed — a refused request must
not reach `buildServer()` or the transport.

`GET /health` stays open. It returns only `{status, server}` and is used by
compose's healthcheck.

### Tool signatures

`workspaceId` is **removed from every tool's input schema.** The workspace comes
from the credential (FR-002). This is the load-bearing change: leaving the
parameter in place and merely comparing it to the credential's workspace would
keep a caller-supplied value in the contract, and the next person to add a tool
would plumb it through again.

| Tool | Before | After |
|---|---|---|
| `list_tables` | `{workspaceId, prefix?}` | `{prefix?}` |
| `read_table_schema` | `{workspaceId, tableName}` | `{tableName}` |
| `describe_relationships` | `{workspaceId, tableName}` | `{tableName}` |
| `get_column_stats` | `{workspaceId, tableName, columnName}` | `{tableName, columnName}` |

The workspace is bound into the closure when the per-request server is built, so
`schemaStore` calls are unchanged and still workspace-scoped.

**Consequence to record**: this is a breaking change to the bridge's tool
contract. Tether's registration must be updated in step. Per the standing
instruction that breaking API changes do not ride along with infrastructure
changes, this ships as its own commit within the feature, with the migration
note in the commit message — not folded into the credential-primitive commit.

### Remaining input validation (FR-004)

`tableName` and `columnName` are `zIdentifier` from V1's primitives, not bare
`z.string()`. They are interpolated into schema-store queries as parameters
today, so this is defence in depth rather than a fix — but an unconstrained
identifier reaching a metadata query is exactly what V1 removed everywhere else,
and the bridge was simply not in V1's scope.

### Error handling (FR-017)

The bridge mounts V1's `requestIdMiddleware` and `errorHandler`, replacing the
hand-rolled 500 at `index.ts:73-76`. Refusals use the uniform shape from
[workspace-credential.contract.md](workspace-credential.contract.md).

### Refusals

| Condition | Response | Log |
|---|---|---|
| No `Authorization` header | `401 {error:"unauthorized",requestId}` | `reason=missing_credential` |
| Malformed token | `401` same body | `reason=malformed` |
| Unknown / revoked / expired | `401` same body | specific `reason` |
| `ws_progress` credential | `401` same body | `reason=audience_mismatch` |
| Valid, workspace has no datasources | `200`, empty result | — |

The fourth row matters: a progress ticket must not open the bridge.

## Verification path (research R2)

The bridge has its own `pg.Pool` and no dependency on `packages/server`.
Preferred: one verification routine compiled by both packages. Fallback:
duplicated with a conformance test in each package running identical fixtures
and asserting identical `VerifyResult`s. **Whichever is chosen, the conformance
test is mandatory** — two verifiers permitted to drift is worse than one
duplicated deliberately.

## Fail-closed

`MCP_BRIDGE_REQUIRE_AUTH` defaults to **on**. If it is unset, malformed, or set
to anything other than an explicit `false`, authentication is required. An
operator who wants it off must say so unambiguously, and the bridge logs a
prominent warning at startup when it is off, every time — not once.

## Tests

| Test | Asserts |
|---|---|
| unauthenticated `list_tables` | 401, and **no schema strings anywhere in the body** |
| credential for A, tools for A | response byte-identical to pre-change (FR-006) |
| credential for A cannot see B's tables | Article XII / SC-003 |
| `workspaceId` in tool input is ignored or rejected | it is no longer part of the contract |
| bridge with no credentials issued at all | every tool refuses |
| `/health` unauthenticated | still 200 |
| `MCP_BRIDGE_REQUIRE_AUTH` unset | auth still required (fail-closed) |
| refusal body across all failure reasons | byte-identical between them |
