import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformUsers } from "../db/schema.js";

/**
 * Who this API has seen — the list a super admin assigns from.
 * `specs/20260820-193547-superadmin-workspace-assignment/` · D-2, D-3
 *
 * ⚠ **Read `db/schema.ts`'s docblock on `platform_users` before using this.** A
 * row means one thing only: this subject presented a token that verified against
 * `RUNTIME_JWT_SECRET`. Not an account, not an entitlement, not proof of who
 * anybody is.
 */

export interface PlatformUser {
  subject: string;
  email: string;
  name: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * ⚠ **The throttle is not an optimisation, it is what makes `seen()` safe to
 * call from a middleware.** `resolveIdentity` runs on every request carrying an
 * identity, and a live dashboard polls; without this, one open browser tab is a
 * write per poll for ever, on the request path of every authenticated call.
 *
 * In memory and per process, deliberately — the same trade `authFailureThrottle`
 * states for itself. This server runs as one process (no `deploy.replicas`), and
 * a restart clearing it costs one redundant upsert per subject.
 */
const SEEN_THROTTLE_MS = 60_000;
const lastWrite = new Map<string, number>();

/** Test seam. Not exported through the service object — nothing in the product may call it. */
export function _resetSeenThrottle(): void {
  lastWrite.clear();
}

export const platformUserService = {
  /**
   * Record that this identity was seen. **Never throws, never awaited into a
   * response.**
   *
   * ⚠ Both properties are the point. This is bookkeeping on the path of every
   * authenticated request, including every authorisation check — so a failure
   * here must not turn a working request into a 500, and its latency must not be
   * added to one. A stale list is a worse list; an unavailable API is a worse
   * outcome. The failure is logged, so "the list stopped growing" has somewhere
   * to be diagnosed from rather than being silent.
   */
  async seen(identity: { subject?: string | null; email?: string | null; name?: string | null }): Promise<void> {
    const subject = identity.subject?.trim();
    if (!subject) return;
    const now = Date.now();
    const prev = lastWrite.get(subject);
    if (prev !== undefined && now - prev < SEEN_THROTTLE_MS) return;
    // Stamped BEFORE the await, so a slow or failing write cannot be retried by
    // every concurrent request that arrives while it is in flight.
    lastWrite.set(subject, now);
    try {
      await db
        .insert(platformUsers)
        .values({
          subject,
          email: identity.email?.trim() ?? "",
          name: identity.name?.trim() || null,
        })
        .onConflictDoUpdate({
          target: platformUsers.subject,
          set: {
            lastSeenAt: new Date(),
            // ⚠ Refreshed, because an address and a display name change and the
            // stale one is what a super admin would be picking from. `subject`
            // and `first_seen_at` are never touched: the first is the key, and
            // the second is the one fact a later request cannot restate.
            email: sql`excluded.email`,
            name: sql`excluded.name`,
          },
        });
    } catch (e) {
      lastWrite.delete(subject);
      console.warn(
        `[platform-users] could not record ${subject}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },

  /**
   * Everyone seen, most recent first.
   *
   * ⚠ No workspace filter and no pagination: it is a deployment-level list read
   * only by a super admin (`requireSuperAdmin` on the route), which is the same
   * reason there is deliberately no cross-workspace MEMBER listing (D-27) — that
   * one would assemble a directory of a customer base out of per-tenant rows.
   * This one is the deployment's own operators looking at their own deployment.
   */
  async list(): Promise<PlatformUser[]> {
    const rows = await db
      .select()
      .from(platformUsers)
      .orderBy(desc(platformUsers.lastSeenAt));
    return rows.map((r) => ({
      subject: r.subject,
      email: r.email,
      name: r.name,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    }));
  },

  /** The mode this person's new Forge chats open in (0097): Workflow Builder unless they chose otherwise. */
  async forgeDefaultMode(subject: string | null | undefined): Promise<"workflow" | "agent"> {
    if (!subject?.trim()) return "workflow";
    const [row] = await db
      .select({ mode: platformUsers.forgeDefaultMode })
      .from(platformUsers)
      .where(eq(platformUsers.subject, subject.trim()))
      .limit(1);
    return row?.mode === "agent" ? "agent" : "workflow";
  },

  /** The email address held for a person's subject, or null. */
  async emailOf(subject: string): Promise<string | null> {
    const [row] = await db
      .select({ email: platformUsers.email })
      .from(platformUsers)
      .where(eq(platformUsers.subject, subject.trim()))
      .limit(1);
    return row?.email ?? null;
  },

  /** A person's own choice of default, from their verified identity. Writes the row if this is its first appearance. */
  async setForgeDefaultMode(
    identity: { subject: string; email?: string | null; name?: string | null },
    mode: "workflow" | "agent",
  ): Promise<void> {
    await db
      .insert(platformUsers)
      .values({ subject: identity.subject, email: identity.email?.trim() ?? "", name: identity.name?.trim() || null, forgeDefaultMode: mode })
      .onConflictDoUpdate({ target: platformUsers.subject, set: { forgeDefaultMode: mode } });
  },
};
