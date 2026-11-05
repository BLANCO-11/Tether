/**
 * Notices to one person (migration 0121, sharing-boundaries phase 1). Written by the server about something that
 * happened to that person's work; read only by that person — every read and write takes the recipient's subject, so
 * nothing here can list somebody else's.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifications } from "../db/schema.js";

export type NotificationKind = "admin_viewed" | "activation_paused" | "schedule_stopped" | "project_changed";
export type Notification = typeof notifications.$inferSelect;

/** What the bell keeps: enough to answer "what happened to my things", not a log. */
const KEEP = 30;

export const notificationService = {
  async add(n: { workspaceId: string; subject: string; kind: NotificationKind; title: string; body: string; href?: string | null }): Promise<void> {
    await db.insert(notifications).values({ ...n, href: n.href ?? null });
  },

  async listFor(workspaceId: string, subject: string): Promise<Notification[]> {
    return db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.subject, subject)))
      .orderBy(desc(notifications.createdAt))
      .limit(KEEP);
  },

  /** Mark this person's notices read — the ones named, or all of them. Somebody else's ids change nothing. */
  async markRead(workspaceId: string, subject: string, ids?: string[]): Promise<void> {
    if (ids && !ids.length) return;
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.subject, subject),
          isNull(notifications.readAt),
          ids ? inArray(notifications.id, ids) : undefined,
        ),
      );
  },
};
