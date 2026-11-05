/**
 * Project memory ledger (personal thin product Phase 4) — curated facts a project's chats start with.
 *
 * Not vectors: each row is an accepted decision / preference / open loop / note. Active rows inject into
 * `projectService.contextOf` (capped). Members who can see the project may list and add; managing the
 * project (owner / Admin) may supersede or discard. Compact promotions are proposed client-side and
 * accepted through the same create path with `source: "compact"`.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { projectMemories, projects } from "../db/schema.js";
import type { Viewer } from "./content-visibility.service.js";

export const MEMORY_KINDS = ["decision", "preference", "open_loop", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["active", "superseded", "discarded"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SOURCES = ["manual", "promoted", "compact"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Soft cap on one memory's body (chars). */
export const MEMORY_BODY_MAX = 500;
/** Soft cap on active memories per project — refuse new actives past this. */
export const MEMORY_ACTIVE_MAX = 50;
/** Inject at most this many characters of active memory into each chat turn (~2k tokens). */
export const MEMORY_INJECT_CHARS = 6000;

export type ProjectMemory = typeof projectMemories.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const httpErr = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

async function projectFor(workspaceId: string, projectId: string, v: Viewer) {
  if (!UUID.test(projectId)) throw httpErr("No such project.", 404);
  const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  if (!p || !(v.all || v.projects?.has(p.id))) throw httpErr("No such project.", 404);
  return p;
}

function cleanBody(raw: string): string {
  const body = raw.replace(/\s+/g, " ").trim();
  if (!body) throw httpErr("A memory needs some text.", 400);
  if (body.length > MEMORY_BODY_MAX) throw httpErr(`Keep each memory under ${MEMORY_BODY_MAX} characters.`, 400);
  return body;
}

/** Active memories for inject — oldest first, cut when the char budget is spent. */
export function formatActiveMemories(rows: Array<{ kind: string; body: string }>, budget = MEMORY_INJECT_CHARS): string[] {
  const out: string[] = [];
  let used = 0;
  for (const r of rows) {
    const line = `[${r.kind}] ${r.body.trim()}`;
    if (!line.slice(r.kind.length + 3)) continue;
    if (used + line.length + 1 > budget) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/**
 * Heuristic candidates after compact (≤3): short user lines, or assistant lines that sound like a kept preference.
 * Pure — the client may call the same idea locally; the server re-checks on accept.
 */
export function pickMemoryCandidates(messages: Array<{ role: string; text: string }>, limit = 3): string[] {
  const cues = /\b(always|never|prefer|remember|we decided|decision|from now on|don't|do not|please use|use my|call me)\b/i;
  const out: string[] = [];
  for (const m of [...messages].reverse()) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const t = m.text.replace(/\s+/g, " ").trim();
    if (t.length < 12 || t.length > MEMORY_BODY_MAX) continue;
    if (m.role === "assistant" && !cues.test(t)) continue;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    out.push(t.slice(0, MEMORY_BODY_MAX));
    if (out.length >= limit) break;
  }
  return out.reverse();
}

export const projectMemoryService = {
  async list(workspaceId: string, projectId: string, v: Viewer, opts?: { status?: MemoryStatus | "all" }): Promise<ProjectMemory[]> {
    await projectFor(workspaceId, projectId, v);
    const status = opts?.status ?? "active";
    const where =
      status === "all"
        ? and(eq(projectMemories.projectId, projectId), eq(projectMemories.workspaceId, workspaceId))
        : and(eq(projectMemories.projectId, projectId), eq(projectMemories.workspaceId, workspaceId), eq(projectMemories.status, status));
    return db.select().from(projectMemories).where(where).orderBy(asc(projectMemories.createdAt));
  },

  /** Active bodies for `contextOf` — no viewer (chat membership is the access). Char-budgeted. */
  async activeForInject(workspaceId: string, projectId: string): Promise<Array<{ kind: string; body: string }>> {
    const rows = await db
      .select({ kind: projectMemories.kind, body: projectMemories.body })
      .from(projectMemories)
      .where(and(eq(projectMemories.projectId, projectId), eq(projectMemories.workspaceId, workspaceId), eq(projectMemories.status, "active")))
      .orderBy(asc(projectMemories.createdAt));
    const kept: Array<{ kind: string; body: string }> = [];
    let used = 0;
    for (const r of rows) {
      const body = r.body.trim();
      if (!body) continue;
      const cost = r.kind.length + body.length + 3;
      if (used + cost > MEMORY_INJECT_CHARS) break;
      kept.push({ kind: r.kind, body });
      used += cost;
    }
    return kept;
  },

  async create(
    workspaceId: string,
    projectId: string,
    v: Viewer,
    who: { subject: string },
    input: {
      kind: MemoryKind;
      body: string;
      source?: MemorySource;
      sourceChatId?: string | null;
      sourceMessageId?: string | null;
    },
  ): Promise<ProjectMemory> {
    await projectFor(workspaceId, projectId, v);
    if (!MEMORY_KINDS.includes(input.kind)) throw httpErr("Unknown memory kind.", 400);
    const source = input.source ?? "manual";
    if (!MEMORY_SOURCES.includes(source)) throw httpErr("Unknown memory source.", 400);
    const body = cleanBody(input.body);

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(projectMemories)
      .where(and(eq(projectMemories.projectId, projectId), eq(projectMemories.status, "active")));
    if ((n ?? 0) >= MEMORY_ACTIVE_MAX) {
      throw httpErr(`This project already has ${MEMORY_ACTIVE_MAX} active memories. Supersede or discard one first.`, 409);
    }

    const [row] = await db
      .insert(projectMemories)
      .values({
        projectId,
        workspaceId,
        kind: input.kind,
        body,
        status: "active",
        source,
        sourceChatId: input.sourceChatId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        createdBy: who.subject,
      })
      .returning();
    return row!;
  },

  async setStatus(
    workspaceId: string,
    projectId: string,
    memoryId: string,
    v: Viewer,
    status: "superseded" | "discarded",
  ): Promise<ProjectMemory> {
    const p = await projectFor(workspaceId, projectId, v);
    if (!(v.all || (v.subject != null && p.ownerSubject === v.subject))) {
      throw httpErr("Only the project's owner (or an Admin) can change a memory's status.", 403);
    }
    if (!UUID.test(memoryId)) throw httpErr("No such memory.", 404);
    const [row] = await db
      .select()
      .from(projectMemories)
      .where(and(eq(projectMemories.id, memoryId), eq(projectMemories.projectId, projectId), eq(projectMemories.workspaceId, workspaceId)));
    if (!row) throw httpErr("No such memory.", 404);
    if (row.status !== "active") throw httpErr("That memory is already closed.", 409);
    const [updated] = await db
      .update(projectMemories)
      .set({ status, supersededAt: new Date() })
      .where(eq(projectMemories.id, memoryId))
      .returning();
    return updated!;
  },

  /** Newest-first peek used by promote UX; not the inject order. */
  async recentActive(workspaceId: string, projectId: string, limit = 5): Promise<ProjectMemory[]> {
    return db
      .select()
      .from(projectMemories)
      .where(and(eq(projectMemories.projectId, projectId), eq(projectMemories.workspaceId, workspaceId), eq(projectMemories.status, "active")))
      .orderBy(desc(projectMemories.createdAt))
      .limit(limit);
  },
};
