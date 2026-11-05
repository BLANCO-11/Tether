import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { platformAuditEvents } from "../db/schema.js";

export type PlatformAuditAction =
  | "grant"
  | "revoke"
  | "role.create"
  | "role.update"
  | "role.retire"
  | "deny"
  | "plugin.install"
  | "plugin.upgrade"
  | "plugin.uninstall"
  | "plugin.hosts"
  | "plugin.oauth_app";

export type PlatformAuditEntity = "platform_role" | "workspace_role" | "member" | "permission" | "plugin";

export interface PlatformAuditRow {
  id: string;
  time: Date;
  actor: string;
  actorEmail: string | null;
  action: PlatformAuditAction;
  subject: string | null;
  entity: PlatformAuditEntity;
  entityId: string | null;
  before: unknown;
  after: unknown;
  repeatCount: number;
}

/**
 * The platform-tier audit record.
 *
 * ⚠ **There is deliberately no `update` that rewrites a decision and no `delete`.**
 * FR-033: the audit is what happened, not what somebody would prefer had happened. The
 * one mutation is `bumpRepeat`, which increments a COUNT on a denial row — it changes
 * how many times a refusal is known to have occurred, never whether it occurred.
 */
export const platformAuditRepo = {
  async record(input: {
    actor: string;
    actorEmail?: string | null;
    action: PlatformAuditAction;
    subject?: string | null;
    entity: PlatformAuditEntity;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    repeatCount?: number;
  }): Promise<{ id: string }> {
    const [row] = await db
      .insert(platformAuditEvents)
      .values({
        actor: input.actor,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        subject: input.subject ?? null,
        entity: input.entity,
        entityId: input.entityId ?? null,
        before: input.before ?? null,
        after: input.after ?? null,
        repeatCount: input.repeatCount ?? 1,
      })
      .returning({ id: platformAuditEvents.id });
    return row!;
  },

  /** Flush a window's worth of repeats onto the row that opened it. */
  async bumpRepeat(id: string, by: number): Promise<void> {
    if (by <= 0) return;
    await db
      .update(platformAuditEvents)
      .set({ repeatCount: sql`${platformAuditEvents.repeatCount} + ${by}` })
      .where(eq(platformAuditEvents.id, id));
  },

  async list(opts?: {
    actor?: string;
    action?: PlatformAuditAction;
    since?: Date;
    until?: Date;
    limit?: number;
  }): Promise<PlatformAuditRow[]> {
    const where = [
      opts?.actor ? eq(platformAuditEvents.actor, opts.actor) : undefined,
      opts?.action ? eq(platformAuditEvents.action, opts.action) : undefined,
      opts?.since ? gte(platformAuditEvents.time, opts.since) : undefined,
      opts?.until ? lte(platformAuditEvents.time, opts.until) : undefined,
    ].filter(Boolean);

    const rows = await db
      .select()
      .from(platformAuditEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(platformAuditEvents.time))
      .limit(Math.min(opts?.limit ?? 200, 1000));
    return rows as PlatformAuditRow[];
  },
};
