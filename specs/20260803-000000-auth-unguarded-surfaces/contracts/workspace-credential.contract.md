# Contract: workspace-scoped credential primitive

The single identity primitive for V2 (FR-002, FR-008). Both the MCP bridge and
the progress socket verify through this module and no other.

Module: `packages/server/src/auth/workspace-credential.ts`

## Surface

```ts
type Audience = "mcp" | "ws_progress";

interface IssueInput {
  workspaceId: string;          // zUuid
  audience: Audience;
  label?: string;
  scriptId?: string;            // required when audience === "ws_progress"
  ttlSeconds?: number;          // omit for long-lived
  singleUse?: boolean;
}

interface IssuedCredential {
  keyId: string;
  token: string;                // `fdy_<keyId>.<secret>` — returned ONCE, never stored
  expiresAt: Date | null;
}

interface VerifyInput {
  token: string;
  audience: Audience;           // the surface doing the verifying
  scriptId?: string;            // required when audience === "ws_progress"
}

type VerifyResult =
  | { ok: true; workspaceId: string; keyId: string }
  | { ok: false; reason: VerifyFailure };   // reason is for the LOG, never the response

type VerifyFailure =
  | "malformed" | "unknown_key" | "revoked" | "expired"
  | "already_consumed" | "audience_mismatch" | "script_mismatch" | "bad_secret";

function issue(input: IssueInput): Promise<IssuedCredential>;
function verify(input: VerifyInput): Promise<VerifyResult>;
function revoke(keyId: string): Promise<void>;
```

## Invariants

1. **`verify` never returns the workspace of a credential that failed any
   check.** `ok: false` carries no workspace, so a caller cannot accidentally
   use one.
2. **`verify` is constant-shape in time.** When the key is unknown, it still
   performs a `scrypt` against a fixed dummy salt before returning, so a missing
   row and a wrong secret are not distinguishable by timing (SC-003).
3. **The plaintext token exists only in the return value of `issue`.** It is
   never logged, never stored, never returned by any other function. There is no
   "show me the credential again" path — by design.
4. **`reason` is log-only.** Callers must map every `ok: false` to one uniform
   refusal. A caller that branches its *response* on `reason` violates FR-003;
   the type name is chosen to make that read wrong at the call site.
5. **Single-use consumption is atomic** — a conditional `UPDATE … WHERE
   consumed_at IS NULL`, and `ok: true` requires it to have affected one row. Two
   concurrent upgrades presenting the same ticket: exactly one succeeds.
6. **Authorization precedes existence.** `verify` never reveals, by any path,
   whether a workspace or script exists.

## Refusal shape (FR-017)

Every surface renders a failed `verify` identically:

```json
{ "error": "unauthorized", "requestId": "<uuid>" }
```

HTTP `401`. No `message`, no `reason`, no hint about which check failed. The
matching log line carries the detail:

```
[auth] refused surface=mcp reason=bad_secret keyId=<keyId> requestId=<uuid>
```

`keyId` is loggable (public, no authority). The secret and the token are not.

## Tests this contract requires

| Test | Asserts |
|---|---|
| issues and verifies a round trip | happy path, per audience |
| rejects a credential for another workspace | **Article XI over-grant test** |
| rejects a `ws_progress` credential presented to the bridge | audience isolation |
| rejects after `revoke` | revocation is effective immediately |
| rejects after `expires_at` | TTL honoured |
| second use of a single-use ticket fails | consumption is atomic |
| concurrent double-use: exactly one succeeds | no read-then-write race |
| unknown `key_id` and wrong secret are indistinguishable | SC-003, incl. timing class |
| malformed tokens rejected before any query | no DB touch on garbage input |
| plaintext never appears in the row | digest storage (research R1) |
| deleting the workspace removes the credentials | Article XII cascade |
