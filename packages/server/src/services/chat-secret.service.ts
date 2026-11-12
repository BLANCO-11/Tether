import { ZodError } from "zod";
import { chatSecretRepo, type ChatSecretPatch } from "../repositories/chat-secret.repo.js";
import { piChatRepo } from "../repositories/pi-chat.repo.js";
import { decrypt, encrypt } from "../utils/encryptor.js";
import {
  ChatSecretError,
  PENDING_TTL_MS,
  assertSecretOwner,
  createInputSchema,
  toView,
  updateInputSchema,
  type ChatSecretView,
} from "../pi-builder/chat-secrets.js";
import type { ScrubSecret } from "../pi-builder/scrub.js";

type Person = { subject: string };
type Placement = { kind: "header" | "query" | "bearer"; name: string | null };

const listeners: Array<(chatId: string) => void> = [];
function changed(chatId: string): void {
  for (const l of listeners) {
    try {
      l(chatId);
    } catch {
      /* a listener must not break a write */
    }
  }
}

function parse<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof ZodError) throw new ChatSecretError(e.issues[0]?.message ?? "That is not valid.", 400);
    throw e;
  }
}

async function ownedChat(workspaceId: string, chatId: string, person: Person): Promise<void> {
  const chat = await piChatRepo.get(workspaceId, chatId);
  if (!chat) throw new ChatSecretError("This chat is not here any more.", 404);
  assertSecretOwner(chat.createdBySubject, person.subject);
}

export const chatSecretService = {
  async list(workspaceId: string, chatId: string, person: Person): Promise<ChatSecretView[]> {
    await ownedChat(workspaceId, chatId, person);
    return (await chatSecretRepo.list(chatId)).map(toView);
  },

  async create(workspaceId: string, chatId: string, person: Person, input: unknown): Promise<ChatSecretView> {
    await ownedChat(workspaceId, chatId, person);
    const v = parse(() => createInputSchema.parse(input));
    if (await chatSecretRepo.get(chatId, v.name)) {
      throw new ChatSecretError(`This chat already has a secret named ${v.name}.`, 409);
    }
    const row = await chatSecretRepo.insert({
      workspaceId,
      chatId,
      ownerSubject: person.subject,
      name: v.name,
      status: "active",
      valueEnc: encrypt(v.value),
      boundHost: v.host,
      extraHosts: v.extraHosts ?? [],
      placementKind: v.placement.kind,
      placementName: v.placement.kind === "bearer" ? null : v.placement.name,
      expiresAt: v.expiresAt ? new Date(v.expiresAt) : null,
    });
    changed(chatId);
    return toView(row);
  },

  async update(workspaceId: string, chatId: string, name: string, person: Person, input: unknown): Promise<ChatSecretView> {
    await ownedChat(workspaceId, chatId, person);
    const v = parse(() => updateInputSchema.parse(input));
    const current = await chatSecretRepo.get(chatId, name);
    if (!current) throw new ChatSecretError(`This chat has no secret named ${name}.`, 404);
    const patch: ChatSecretPatch = {};
    if (v.value !== undefined) patch.valueEnc = encrypt(v.value);
    if (v.host !== undefined) patch.boundHost = v.host;
    if (v.extraHosts !== undefined) patch.extraHosts = v.extraHosts;
    if (v.placement !== undefined) {
      patch.placementKind = v.placement.kind;
      patch.placementName = v.placement.kind === "bearer" ? null : v.placement.name;
    }
    if (v.expiresAt !== undefined) patch.expiresAt = v.expiresAt ? new Date(v.expiresAt) : null;
    const host = patch.boundHost ?? current.boundHost;
    if (current.status === "pending" && host) {
      patch.status = "active";
      // A pending secret's deadline is its pending timer; once it is active it lasts until the person says otherwise.
      if (v.expiresAt === undefined) patch.expiresAt = null;
    }
    const row = await chatSecretRepo.update(chatId, name, patch);
    if (!row) throw new ChatSecretError(`This chat has no secret named ${name}.`, 404);
    changed(chatId);
    return toView(row);
  },

  async remove(workspaceId: string, chatId: string, name: string, person: Person): Promise<void> {
    await ownedChat(workspaceId, chatId, person);
    if (!(await chatSecretRepo.remove(chatId, name))) throw new ChatSecretError(`This chat has no secret named ${name}.`, 404);
    changed(chatId);
  },

  /** Secrets caught in a pasted message: parked as pending until the owner picks each one's website. */
  async storePending(
    workspaceId: string,
    chatId: string,
    ownerSubject: string,
    caught: Array<{ name: string; value: string }>,
  ): Promise<string[]> {
    const names: string[] = [];
    for (const c of caught) {
      await chatSecretRepo.insert({
        workspaceId,
        chatId,
        ownerSubject,
        name: c.name,
        status: "pending",
        valueEnc: encrypt(c.value),
        boundHost: null,
        extraHosts: [],
        placementKind: "bearer",
        placementName: null,
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      });
      names.push(c.name);
    }
    if (names.length) changed(chatId);
    return names;
  },

  /** Every secret's name and value (pending too), only for scrubbing output. */
  async scrubSecrets(chatId: string): Promise<ScrubSecret[]> {
    const rows = await chatSecretRepo.allValues(chatId);
    const out: ScrubSecret[] = [];
    for (const r of rows) {
      try {
        out.push({ name: r.name, value: decrypt(r.valueEnc) });
      } catch {
        /* an undecryptable row cannot be scrubbed, and cannot be used either */
      }
    }
    return out;
  },

  async forUse(
    chatId: string,
    name: string,
  ): Promise<{ name: string; value: string; hosts: string[]; placement: Placement } | null> {
    const row = await chatSecretRepo.get(chatId, name);
    if (!row || row.status !== "active" || !row.boundHost) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    const enc = await chatSecretRepo.valueOf(chatId, name);
    if (!enc) return null;
    let value: string;
    try {
      value = decrypt(enc);
    } catch {
      return null;
    }
    return {
      name: row.name,
      value,
      hosts: [row.boundHost, ...row.extraHosts],
      placement: { kind: row.placementKind as Placement["kind"], name: row.placementName },
    };
  },

  /** For Forge's list of what it can use: names and websites, no owner check, never a value. */
  async names(chatId: string): Promise<ChatSecretView[]> {
    return (await chatSecretRepo.list(chatId)).map(toView);
  },

  async markUsed(chatId: string, name: string): Promise<void> {
    await chatSecretRepo.touchUsed(chatId, name);
  },

  onChanged(listener: (chatId: string) => void): void {
    listeners.push(listener);
  },
};
