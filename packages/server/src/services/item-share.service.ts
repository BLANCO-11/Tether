/**
 * Per-person read shares (personal thin product Phase 5) — grant a People-listed member read access to a
 * chat or a run without moving it. No public links. Owner / Admin grants and revokes; the sharee may read only.
 *
 * Visibility goes through `contentVisibility` (`sharedChats` / `sharedRuns` on the Viewer). Shared payloads are
 * redacted server-side before a sharee (or any non-owner reader) sees them.
 */
import { and, eq } from "drizzle-orm";
import { redactJsonString, REDACTED } from "@foundry/redact";
import { db } from "../db/index.js";
import { flowExecutions, itemShares, piChats, workspaceMembers } from "../db/schema.js";
import type { Viewer } from "./content-visibility.service.js";
import { contentVisibility } from "./content-visibility.service.js";

export type ShareKind = "chat" | "run";

export type ItemShare = typeof itemShares.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const httpErr = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** Loose secret shapes in free text (API keys, Bearer tokens) — complements key-name redaction on JSON. */
export function redactLooseText(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{10,})\b/g, REDACTED)
    .replace(/(Bearer\s+)[A-Za-z0-9._\-+=/]+/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)\S+/gi, `$1${REDACTED}`);
}

/** Redact a chat message payload for a non-owner reader (Phase 5.2). */
export function redactChatMessages<T extends { text?: string | null }>(messages: T[]): T[] {
  return messages.map((m) => {
    if (typeof m.text !== "string" || !m.text) return m;
    const viaJson = redactJsonString(m.text);
    const text = redactLooseText(viaJson);
    return text === m.text ? m : { ...m, text };
  });
}

async function assertMember(workspaceId: string, subject: string): Promise<void> {
  const [row] = await db
    .select({ s: workspaceMembers.subject })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.subject, subject)))
    .limit(1);
  if (!row) throw httpErr("Share only with somebody already in People for this workspace.", 400);
}

async function assertMayGrant(workspaceId: string, kind: ShareKind, itemId: string, v: Viewer): Promise<{ ownerSubject: string | null }> {
  if (!UUID.test(itemId)) throw httpErr("No such item.", 404);
  if (kind === "chat") {
    const [chat] = await db.select().from(piChats).where(and(eq(piChats.id, itemId), eq(piChats.workspaceId, workspaceId)));
    if (!chat) throw httpErr("No such chat.", 404);
    if (!contentVisibility.chatChangeable(v, chat)) throw httpErr("Only the person who started this chat or an Admin can share it.", 403);
    return { ownerSubject: chat.createdBySubject };
  }
  const [run] = await db.select().from(flowExecutions).where(and(eq(flowExecutions.id, itemId), eq(flowExecutions.workspaceId, workspaceId)));
  if (!run) throw httpErr("No such run.", 404);
  const owner = run.requestedBySubject;
  if (!(v.all || (v.subject != null && owner === v.subject))) {
    throw httpErr("Only whoever started this run or an Admin can share it.", 403);
  }
  return { ownerSubject: owner };
}

export const itemShareService = {
  /** Chat / run ids shared with this subject in the workspace — loaded onto the Viewer. */
  async idsFor(workspaceId: string, subject: string, kind: ShareKind): Promise<Set<string>> {
    const rows = await db
      .select({ id: itemShares.itemId })
      .from(itemShares)
      .where(and(eq(itemShares.workspaceId, workspaceId), eq(itemShares.subject, subject), eq(itemShares.kind, kind)));
    return new Set(rows.map((r) => r.id));
  },

  async list(workspaceId: string, kind: ShareKind, itemId: string, v: Viewer): Promise<ItemShare[]> {
    await assertMayGrant(workspaceId, kind, itemId, v);
    return db
      .select()
      .from(itemShares)
      .where(and(eq(itemShares.workspaceId, workspaceId), eq(itemShares.kind, kind), eq(itemShares.itemId, itemId)));
  },

  async grant(
    workspaceId: string,
    kind: ShareKind,
    itemId: string,
    v: Viewer,
    actor: string,
    subject: string,
  ): Promise<ItemShare> {
    const { ownerSubject } = await assertMayGrant(workspaceId, kind, itemId, v);
    if (subject === ownerSubject) throw httpErr("They already own it.", 409);
    if (v.subject != null && subject === v.subject && !v.all) throw httpErr("You already have it.", 409);
    await assertMember(workspaceId, subject);
    const existing = await db
      .select()
      .from(itemShares)
      .where(and(eq(itemShares.kind, kind), eq(itemShares.itemId, itemId), eq(itemShares.subject, subject)))
      .limit(1);
    if (existing[0]) return existing[0];
    const [row] = await db
      .insert(itemShares)
      .values({ workspaceId, kind, itemId, subject, grantedBy: actor })
      .returning();
    return row!;
  },

  async revoke(workspaceId: string, kind: ShareKind, itemId: string, v: Viewer, subject: string): Promise<void> {
    await assertMayGrant(workspaceId, kind, itemId, v);
    await db
      .delete(itemShares)
      .where(and(eq(itemShares.workspaceId, workspaceId), eq(itemShares.kind, kind), eq(itemShares.itemId, itemId), eq(itemShares.subject, subject)));
  },
};
