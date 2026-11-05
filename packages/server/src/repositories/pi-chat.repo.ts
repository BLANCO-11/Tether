import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { flows, piChatFiles, piChats, type PiChatRow } from "../db/schema.js";
import { decryptBytes, encryptBytes } from "../utils/encryptor.js";

/** The newest MAX messages are kept — a transcript, not an archive. */
const MAX_MESSAGES = 400;

export type PiChatSummary = {
  id: string;
  title: string;
  /** The first line of what the chat asked for, at most 160 characters — a preview for the Chats list. */
  goal: string;
  flowId: string | null;
  flowName: string | null;
  createdBy: { subject: string | null; name: string | null };
  /** `private` or `public` (0122): who reads it. */
  visibility: string;
  /** The project it lives in (sharing-boundaries phase 5), or null. */
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  /**
   * What an UNSAVED build in this chat has so far (a chat with no workflow): its steps and the name Forge gave it.
   * 0 and null for a chat that built nothing, or whose build is saved (then it is the workflow).
   */
  draftSteps: number;
  draftName: string | null;
  /** Workflow Builder or Forge Agent (0097). */
  mode: "workflow" | "agent";
};

export type PiChatFileMeta = { name: string; contentType: string; sizeBytes: number; origin: string; createdAt: Date };

/** Saved Forge conversations (0095). Every read is scoped to a workspace; a chat id from another one is not found. */
export const piChatRepo = {
  async create(input: {
    workspaceId: string;
    flowId: string | null;
    title: string;
    goal: string;
    createdBy: { subject: string | null; name: string | null } | null;
    mode?: "workflow" | "agent";
    thinking?: string;
    model?: string | null;
    /** Where it lives (sharing-boundaries phase 5): a project, or NULL for My space. */
    projectId?: string | null;
  }): Promise<string> {
    const [row] = await db
      .insert(piChats)
      .values({
        workspaceId: input.workspaceId,
        flowId: input.flowId,
        title: input.title,
        goal: input.goal,
        createdBySubject: input.createdBy?.subject ?? null,
        createdByName: input.createdBy?.name ?? null,
        mode: input.mode ?? "workflow",
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      })
      .returning({ id: piChats.id });
    return row!.id;
  },

  async get(workspaceId: string, chatId: string): Promise<PiChatRow | null> {
    const [row] = await db
      .select()
      .from(piChats)
      .where(and(eq(piChats.id, chatId), eq(piChats.workspaceId, workspaceId)))
      .limit(1);
    return row ?? null;
  },

  /** The workflow's conversation: the chat that last worked on it. */
  async latestForFlow(workspaceId: string, flowId: string): Promise<PiChatRow | null> {
    const [row] = await db
      .select()
      .from(piChats)
      .where(and(eq(piChats.flowId, flowId), eq(piChats.workspaceId, workspaceId)))
      .orderBy(desc(piChats.updatedAt))
      .limit(1);
    return row ?? null;
  },

  async list(workspaceId: string): Promise<PiChatSummary[]> {
    const rows = await db
      .select({
        id: piChats.id,
        title: piChats.title,
        goal: sql<string>`left(btrim(split_part(btrim(coalesce(${piChats.goal}, '')), E'\n', 1)), 160)`,
        flowId: piChats.flowId,
        flowName: flows.name,
        subject: piChats.createdBySubject,
        name: piChats.createdByName,
        createdAt: piChats.createdAt,
        updatedAt: piChats.updatedAt,
        messageCount: sql<number>`jsonb_array_length(${piChats.messages})`,
        draftSteps: sql<number>`case when ${piChats.flowId} is null and jsonb_typeof(${piChats.draftBundle}->'workflow'->'steps') = 'array'
          then jsonb_array_length(${piChats.draftBundle}->'workflow'->'steps') else 0 end`,
        draftName: sql<string | null>`case when ${piChats.flowId} is null then nullif(btrim(${piChats.draftBundle}->'workflow'->>'name'), '') end`,
        mode: piChats.mode,
        visibility: piChats.visibility,
        projectId: piChats.projectId,
      })
      .from(piChats)
      .leftJoin(flows, eq(flows.id, piChats.flowId))
      .where(eq(piChats.workspaceId, workspaceId))
      .orderBy(desc(piChats.updatedAt));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      goal: r.goal ?? "",
      flowId: r.flowId,
      flowName: r.flowName ?? null,
      createdBy: { subject: r.subject, name: r.name },
      visibility: r.visibility,
      projectId: r.projectId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: Number(r.messageCount ?? 0),
      draftSteps: Number(r.draftSteps ?? 0),
      draftName: r.draftName ?? null,
      mode: r.mode === "agent" ? "agent" : "workflow",
    }));
  },

  /** What the conversation now is. Only the fields given are written; `updated_at` always moves. */
  async update(
    chatId: string,
    patch: { messages?: unknown[]; forgeSession?: string; draftBundle?: unknown | null; flowId?: string | null; goal?: string; mode?: "workflow" | "agent"; thinking?: string; model?: string | null; connectionChoices?: Record<string, unknown> },
  ): Promise<void> {
    const set: Partial<typeof piChats.$inferInsert> = { updatedAt: new Date() };
    if (patch.messages) set.messages = patch.messages.slice(-MAX_MESSAGES);
    if (patch.forgeSession !== undefined) set.forgeSession = patch.forgeSession;
    if (patch.draftBundle !== undefined) set.draftBundle = patch.draftBundle;
    if (patch.flowId !== undefined) set.flowId = patch.flowId;
    if (patch.goal !== undefined) set.goal = patch.goal;
    if (patch.mode !== undefined) set.mode = patch.mode;
    if (patch.thinking !== undefined) set.thinking = patch.thinking;
    if (patch.model !== undefined) set.model = patch.model;
    if (patch.connectionChoices !== undefined) set.connectionChoices = patch.connectionChoices;
    await db.update(piChats).set(set).where(eq(piChats.id, chatId));
  },

  /** A new name for the chat. `updated_at` does NOT move: renaming is not activity, so the list keeps its order. */
  async setVisibility(workspaceId: string, chatId: string, visibility: "private" | "public"): Promise<boolean> {
    const rows = await db
      .update(piChats)
      .set({ visibility })
      .where(and(eq(piChats.workspaceId, workspaceId), eq(piChats.id, chatId)))
      .returning({ id: piChats.id });
    return rows.length > 0;
  },

  async rename(workspaceId: string, chatId: string, title: string): Promise<boolean> {
    const done = await db
      .update(piChats)
      .set({ title })
      .where(and(eq(piChats.id, chatId), eq(piChats.workspaceId, workspaceId)))
      .returning({ id: piChats.id });
    return done.length > 0;
  },

  async remove(workspaceId: string, chatId: string): Promise<boolean> {
    const gone = await db
      .delete(piChats)
      .where(and(eq(piChats.id, chatId), eq(piChats.workspaceId, workspaceId)))
      .returning({ id: piChats.id });
    return gone.length > 0;
  },

  /** Store a file with the chat. A name already stored keeps its first copy (a sent file never changes). */
  async putFile(chatId: string, workspaceId: string, file: { name: string; contentType: string; body: Buffer; origin?: "person" | "forge" }): Promise<void> {
    await db
      .insert(piChatFiles)
      .values({
        chatId,
        workspaceId,
        name: file.name,
        contentType: file.contentType,
        sizeBytes: file.body.length,
        contentEnc: encryptBytes(file.body),
        origin: file.origin ?? "person",
      })
      .onConflictDoNothing({ target: [piChatFiles.chatId, piChatFiles.name] });
  },

  /** Remove one stored file from a chat. True when there was one. */
  async removeFile(chatId: string, name: string): Promise<boolean> {
    const gone = await db
      .delete(piChatFiles)
      .where(and(eq(piChatFiles.chatId, chatId), eq(piChatFiles.name, name)))
      .returning({ name: piChatFiles.name });
    return gone.length > 0;
  },

  async listFiles(chatId: string): Promise<PiChatFileMeta[]> {
    return db
      .select({
        name: piChatFiles.name,
        contentType: piChatFiles.contentType,
        sizeBytes: piChatFiles.sizeBytes,
        origin: piChatFiles.origin,
        createdAt: piChatFiles.createdAt,
      })
      .from(piChatFiles)
      .where(eq(piChatFiles.chatId, chatId));
  },

  /** Every file of the chat with its bytes — for laying them out in a reopened sandbox. */
  async readFiles(chatId: string, names?: string[]): Promise<Array<{ name: string; contentType: string; body: Buffer; origin: string }>> {
    const rows = await db
      .select({ name: piChatFiles.name, contentType: piChatFiles.contentType, enc: piChatFiles.contentEnc, origin: piChatFiles.origin })
      .from(piChatFiles)
      .where(names ? and(eq(piChatFiles.chatId, chatId), inArray(piChatFiles.name, names)) : eq(piChatFiles.chatId, chatId));
    return rows.map((r) => ({ name: r.name, contentType: r.contentType, body: decryptBytes(r.enc), origin: r.origin }));
  },

  /**
   * Keep a file Forge made. Its own earlier file of that name is replaced (Forge revised it); a file the PERSON sent
   * under that name is never touched — the new one is kept as "<name> (2)…" and that name is returned.
   */
  async putForgeFile(chatId: string, workspaceId: string, file: { name: string; contentType: string; body: Buffer }): Promise<string> {
    const taken = await db
      .select({ name: piChatFiles.name, origin: piChatFiles.origin })
      .from(piChatFiles)
      .where(eq(piChatFiles.chatId, chatId));
    const byName = new Map(taken.map((t) => [t.name, t.origin]));
    let name = file.name;
    if (byName.get(name) === "person") {
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      for (let i = 2; byName.has(name); i++) name = `${stem} (${i})${ext}`;
    }
    const values = { chatId, workspaceId, name, contentType: file.contentType, sizeBytes: file.body.length, contentEnc: encryptBytes(file.body), origin: "forge" };
    await db
      .insert(piChatFiles)
      .values(values)
      .onConflictDoUpdate({
        target: [piChatFiles.chatId, piChatFiles.name],
        set: { contentType: values.contentType, sizeBytes: values.sizeBytes, contentEnc: values.contentEnc, createdAt: new Date() },
      });
    return name;
  },
};
