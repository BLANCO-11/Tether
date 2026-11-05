/**
 * R3 — execution-scoped tokens. Tenant identity never travels in a payload.
 * archive/kestra-migration/02-rules.md R3
 *
 * Foundry mints a token bound to (workspace, flow execution) with a short TTL.
 * Kestra presents it on every step callback and Foundry resolves tenancy FROM
 * THE TOKEN. Kestra never receives, stores, or asserts a `tenantId`.
 *
 * The consequence is the whole reason a no-tenant-model engine is safe to run:
 * compromising Kestra exposes in-flight executions only, not the tenant space.
 *
 * Two properties that are easy to lose in a refactor:
 *
 *   1. **Only the HASH is stored.** Kestra persists flow inputs in its own
 *      database, so the raw token is already at rest somewhere we do not
 *      control. It must not also be readable here — otherwise a Foundry DB read
 *      yields live credentials for every running execution.
 *   2. **Comparison is constant-time.** A token is a bearer credential; an
 *      early-exit compare on a hex digest leaks it a nibble at a time.
 */
import crypto from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { executionTokens } from "../db/schema.js";

/** Short by design — long enough for a slow flow, short enough that a leaked token expires. */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export interface MintedToken {
  /** The raw token. Returned exactly ONCE, at mint. Never persisted, never re-derivable. */
  token: string;
  expiresAt: Date;
}

export interface TokenClaims {
  workspaceId: string;
  flowExecutionId: string;
}

function hash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export const executionTokenService = {
  /**
   * Mint a token for one execution.
   *
   * TTL must outlast the execution. A flow with an `agent` step pauses for ~6
   * minutes, and one with a human approval `Pause` can sit for days — for those,
   * pass an explicit `ttlMs` rather than letting the default expire mid-flow and
   * present as a 401 on a step that had been working.
   */
  async mint(claims: TokenClaims, ttlMs = DEFAULT_TTL_MS): Promise<MintedToken> {
    // 256 bits from the CSPRNG. Not a uuid: uuidv4 carries only 122 bits and
    // advertises its own structure.
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    await db.insert(executionTokens).values({
      tokenHash: hash(token),
      workspaceId: claims.workspaceId,
      flowExecutionId: claims.flowExecutionId,
      expiresAt,
    });
    return { token, expiresAt };
  },

  /**
   * Resolve a presented token to its claims, or null.
   *
   * Returns null for every failure mode — unknown, expired, already burned — and
   * deliberately does not say which. A caller that distinguishes them hands an
   * attacker an oracle for which tokens exist.
   */
  async verify(token: string): Promise<TokenClaims | null> {
    if (!token) return null;
    const presented = hash(token);

    const rows = await db
      .select()
      .from(executionTokens)
      .where(eq(executionTokens.tokenHash, presented))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    // The lookup above is by hash, so a mismatch cannot reach here — but compare
    // anyway, constant-time, so that a future change to a non-unique lookup
    // (e.g. a prefix index) does not silently reintroduce a timing leak.
    const a = Buffer.from(row.tokenHash, "utf8");
    const b = Buffer.from(presented, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    return { workspaceId: row.workspaceId, flowExecutionId: row.flowExecutionId };
  },

  /**
   * Burn every token for an execution — called when the execution reaches a
   * terminal state.
   *
   * NOT called per step. §7.4 describes these as "single use", which read
   * literally is unimplementable: ONE token authenticates EVERY step callback of
   * an execution, so burning on first use would 401 step 2. Single-use is per
   * EXECUTION. See progress/DECISIONS.md D-06.
   */
  async burnForExecution(flowExecutionId: string): Promise<number> {
    const rows = await db
      .update(executionTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(executionTokens.flowExecutionId, flowExecutionId),
          isNull(executionTokens.consumedAt),
        ),
      )
      .returning({ id: executionTokens.id });
    return rows.length;
  },

  /**
   * Does this execution still have a usable token? Phase 6.1.
   *
   * A **liveness** question, not a read: it returns a boolean and there is no
   * variant that returns the token, the hash or the row. A partial replay reuses
   * the original execution's token — Kestra rehydrates `outputs.begin.token` and
   * `begin` does not re-run — so without this check the failure mode is every
   * replayed step 401ing, which reads as a broken credential rather than as an
   * expired one. Asking first turns that into a refusal that names the fix.
   */
  async hasLiveToken(flowExecutionId: string): Promise<boolean> {
    const rows = await db
      .select({ id: executionTokens.id })
      .from(executionTokens)
      .where(
        and(
          eq(executionTokens.flowExecutionId, flowExecutionId),
          isNull(executionTokens.consumedAt),
          gt(executionTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  /**
   * Delete expired rows. Expiry is already enforced in `verify`, so this is
   * hygiene, not a control — an unpruned table would grow one row per execution
   * forever.
   */
  async pruneExpired(): Promise<number> {
    const rows = await db
      .delete(executionTokens)
      .where(lt(executionTokens.expiresAt, new Date()))
      .returning({ id: executionTokens.id });
    return rows.length;
  },
};
