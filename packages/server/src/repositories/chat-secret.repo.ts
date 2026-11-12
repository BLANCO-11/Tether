import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatSecrets } from "../db/schema.js";

/** A secret row without its encrypted value: the value only ever leaves through `valueOf` / `allValues`. */
const cols = {
  id: chatSecrets.id,
  workspaceId: chatSecrets.workspaceId,
  chatId: chatSecrets.chatId,
  ownerSubject: chatSecrets.ownerSubject,
  name: chatSecrets.name,
  status: chatSecrets.status,
  boundHost: chatSecrets.boundHost,
  extraHosts: chatSecrets.extraHosts,
  placementKind: chatSecrets.placementKind,
  placementName: chatSecrets.placementName,
  createdAt: chatSecrets.createdAt,
  updatedAt: chatSecrets.updatedAt,
  expiresAt: chatSecrets.expiresAt,
  lastUsedAt: chatSecrets.lastUsedAt,
};

export type ChatSecretMeta = {
  id: string;
  workspaceId: string;
  chatId: string;
  ownerSubject: string;
  name: string;
  status: string;
  boundHost: string | null;
  extraHosts: string[];
  placementKind: string;
  placementName: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
};

export type ChatSecretInsert = {
  workspaceId: string;
  chatId: string;
  ownerSubject: string;
  name: string;
  status: "pending" | "active";
  valueEnc: string;
  boundHost: string | null;
  extraHosts: string[];
  placementKind: "header" | "query" | "bearer";
  placementName: string | null;
  expiresAt: Date | null;
};

export type ChatSecretPatch = Partial<
  Pick<ChatSecretInsert, "status" | "valueEnc" | "boundHost" | "extraHosts" | "placementKind" | "placementName" | "expiresAt">
>;

/** A chat's vault (0150). Rows never come back with `valueEnc` except through `valueOf` and `allValues`. */
export const chatSecretRepo = {
  async list(chatId: string): Promise<ChatSecretMeta[]> {
    return db.select(cols).from(chatSecrets).where(eq(chatSecrets.chatId, chatId)).orderBy(chatSecrets.createdAt);
  },

  async get(chatId: string, name: string): Promise<ChatSecretMeta | undefined> {
    const [row] = await db
      .select(cols)
      .from(chatSecrets)
      .where(and(eq(chatSecrets.chatId, chatId), eq(chatSecrets.name, name)))
      .limit(1);
    return row;
  },

  async insert(input: ChatSecretInsert): Promise<ChatSecretMeta> {
    const [row] = await db.insert(chatSecrets).values(input).returning(cols);
    return row!;
  },

  async update(chatId: string, name: string, patch: ChatSecretPatch): Promise<ChatSecretMeta | undefined> {
    const [row] = await db
      .update(chatSecrets)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(chatSecrets.chatId, chatId), eq(chatSecrets.name, name)))
      .returning(cols);
    return row;
  },

  async remove(chatId: string, name: string): Promise<boolean> {
    const rows = await db
      .delete(chatSecrets)
      .where(and(eq(chatSecrets.chatId, chatId), eq(chatSecrets.name, name)))
      .returning({ id: chatSecrets.id });
    return rows.length > 0;
  },

  async valueOf(chatId: string, name: string): Promise<string | null> {
    const [row] = await db
      .select({ v: chatSecrets.valueEnc })
      .from(chatSecrets)
      .where(and(eq(chatSecrets.chatId, chatId), eq(chatSecrets.name, name)))
      .limit(1);
    return row?.v ?? null;
  },

  async allValues(chatId: string): Promise<Array<{ name: string; valueEnc: string }>> {
    return db.select({ name: chatSecrets.name, valueEnc: chatSecrets.valueEnc }).from(chatSecrets).where(eq(chatSecrets.chatId, chatId));
  },

  async touchUsed(chatId: string, name: string): Promise<void> {
    await db
      .update(chatSecrets)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(chatSecrets.chatId, chatId), eq(chatSecrets.name, name)));
  },
};
