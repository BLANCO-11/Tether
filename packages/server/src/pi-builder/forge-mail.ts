/**
 * Forge Agent emails with files it made in the chat (tools/send-email.mjs → POST /api/forge/mail). Mail to the chat's
 * owner alone is sent directly. Mail to anyone else becomes a draft: nothing is sent until the person's own click on a
 * user-authenticated route (Forge holds no key for it) confirms it. The attachments are re-read and verified by sha256
 * at that point, and the draft expires after 30 minutes. MAIL_ALLOWED_RECIPIENT_DOMAINS deliberately does not apply
 * here, because the person's confirmation is the control. No DB or config imports: everything is injected so it can be
 * tested.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { z } from "zod";
import { confined, sandboxDir } from "./sandbox-fs.js";
import { EMAIL_RE, checkMessageCaps } from "../services/mail-recipients.js";
import { sanitizeAttachBaseName } from "../services/mail-attachments.js";
import type { MailMessage, MailSendResult } from "../services/mail.service.js";
import type { NewEmailSend } from "../repositories/email-send.repo.js";
import type { ChatMode } from "./instructions.js";

export const MAX_CHAT_RECIPIENTS = 20;
export const EMAIL_CONFIRM_TTL_MS = 30 * 60_000;

const address = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .refine((a) => EMAIL_RE.test(a), { message: "is not an email address" });

/** Strict: `to` and `cc` are allowed; anything else (such as `bcc`) is refused. */
export const forgeMailBodySchema = z
  .object({
    to: z.array(address).max(MAX_CHAT_RECIPIENTS).optional(),
    cc: z.array(address).max(MAX_CHAT_RECIPIENTS).optional(),
    subject: z.string().min(1).max(250),
    body: z.string().min(1).max(200_000),
    attachments: z.array(z.string().min(1).max(500)).max(20).optional(),
  })
  .strict();

export class ForgeMailError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

export type ForgeMailContext = {
  workspaceId: string;
  sessionId: string;
  chatId: string | null;
  mode: ChatMode;
  ownerSubject: string | null;
  actor: string;
};

export type ForgeMailCaps = {
  maxCount: number;
  maxTotalBytes: number;
  maxBodyBytes: number;
  maxRecipients: number;
  perHour: number;
};

export type ForgeMailDeps = {
  lookupEmail(subject: string): Promise<string | null>;
  send(m: MailMessage): Promise<MailSendResult>;
  record(row: NewEmailSend): Promise<{ id: string }>;
  finish(
    id: string,
    patch: { outcome: "sent" | "failed"; graphMessageId: string | null; failureReason: string | null },
  ): Promise<unknown>;
  audit(entry: {
    workspaceId: string;
    actor: string;
    chatId: string | null;
    description: string;
    raw: Record<string, unknown>;
  }): Promise<void>;
  now(): number;
  caps: ForgeMailCaps;
};

export async function resolveOwnerAddress(
  subject: string | null,
  lookup: (subject: string) => Promise<string | null>,
): Promise<string | null> {
  if (!subject || !subject.trim()) return null;
  const candidate = subject.startsWith("email:") ? subject.slice("email:".length) : await lookup(subject);
  const addr = (candidate ?? "").trim().toLowerCase();
  return EMAIL_RE.test(addr) ? addr : null;
}

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
};

const refuse = (message: string): never => {
  throw new ForgeMailError(message, 422);
};

export function readChatAttachments(
  workspaceId: string,
  sessionId: string,
  paths: string[],
  caps: Pick<ForgeMailCaps, "maxCount" | "maxTotalBytes">,
): { name: string; contentType: string; data: Buffer; bytes: number }[] {
  if (paths.length > caps.maxCount) refuse(`Too many attachments: ${paths.length} (at most ${caps.maxCount}).`);
  const root = sandboxDir(workspaceId, sessionId);
  const picked: { path: string; full: string; ext: string; stem: string; size: number }[] = [];
  for (const p of paths) {
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\0") || p.includes("\\")) {
      refuse(`${p.replace(/\0/g, "")} is not a path inside this chat; give a path like out/report.pdf.`);
    }
    const norm = posix.normalize(p);
    if (norm === ".." || norm.startsWith("../") || norm.startsWith("/")) refuse(`${p} is outside this chat.`);
    const segs = norm.split("/").filter((x) => x !== "");
    if (segs.length === 0 || segs.some((x) => x.startsWith("."))) refuse(`${p} cannot be attached.`);
    const full = join(root, norm);
    let size = 0;
    let cur = root;
    for (let i = 0; i < segs.length; i++) {
      cur = join(cur, segs[i]);
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        return refuse(`No file at ${p} in this chat.`);
      }
      if (st.isSymbolicLink()) refuse(`${p} is a link; attach the file itself.`);
      if (i === segs.length - 1) {
        if (!st.isFile()) refuse(`${p} is not a file.`);
        size = st.size;
      } else if (!st.isDirectory()) {
        refuse(`No file at ${p} in this chat.`);
      }
    }
    if (!confined(full)) refuse(`${p} is outside this chat.`);
    const last = segs[segs.length - 1];
    const dot = last.lastIndexOf(".");
    const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
    if (!TYPES[ext]) {
      refuse(`${p} is not a type that can be emailed. Allowed: ${Object.keys(TYPES).join(", ")}.`);
    }
    picked.push({ path: p, full, ext, stem: last.slice(0, dot), size });
  }
  const total = picked.reduce((n, f) => n + f.size, 0);
  if (total > caps.maxTotalBytes) {
    refuse(
      `The attachments total ${(total / 1048576).toFixed(1)} MB; the limit is ${(caps.maxTotalBytes / 1048576).toFixed(1)} MB.`,
    );
  }
  return picked.map((f) => {
    const fd = openSync(f.full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) refuse(`${f.path} is not a file.`);
      const data = readFileSync(fd);
      return {
        name: `${sanitizeAttachBaseName(f.stem)}.${f.ext}`,
        contentType: TYPES[f.ext],
        data,
        bytes: data.length,
      };
    } finally {
      closeSync(fd);
    }
  });
}

/** Timestamps of successful sends in the last hour, per chat. */
const sent = new Map<string, number[]>();

export function resetForgeMailRateLimit(): void {
  sent.clear();
}

export type ForgeEmailDraft = {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  attachments: Array<{ path: string; name: string; bytes: number; sha256: string }>;
  expiresAt: string;
};

const NO_OWNER_MESSAGE =
  "Your account has no email address here, so I cannot email you. You can download the file from this chat instead.";

export function chatRecipients(
  input: { to?: string[]; cc?: string[] },
  owner: string | null,
): { to: string[]; cc: string[]; ownerOnly: boolean } {
  const to = [...new Set(input.to ?? [])];
  const cc = [...new Set(input.cc ?? [])].filter((a) => !to.includes(a));
  if (to.length === 0 && cc.length === 0) {
    if (!owner) throw new ForgeMailError(NO_OWNER_MESSAGE, 422);
    return { to: [owner], cc: [], ownerOnly: true };
  }
  if (to.length === 0) throw new ForgeMailError("Put at least one address in --to.", 422);
  if (to.length + cc.length > MAX_CHAT_RECIPIENTS) {
    throw new ForgeMailError(
      `That is ${to.length + cc.length} recipients; an email from a chat can have at most ${MAX_CHAT_RECIPIENTS}.`,
      422,
    );
  }
  return { to, cc, ownerOnly: owner !== null && cc.length === 0 && to.length === 1 && to[0] === owner };
}

export function assertChatOwner(ownerSubject: string | null, personSubject: string | null | undefined): void {
  if (!ownerSubject || !personSubject || ownerSubject !== personSubject) {
    throw new ForgeMailError("Only the person this chat belongs to can send or cancel this email.", 403);
  }
}

export async function sendForgeMail(
  ctx: ForgeMailContext,
  input: z.infer<typeof forgeMailBodySchema>,
  deps: ForgeMailDeps,
): Promise<
  | { status: "sent"; sentTo: string; to: string[]; cc: string[]; attachments: { name: string; bytes: number }[] }
  | { status: "pending"; draft: ForgeEmailDraft }
> {
  if (ctx.mode !== "agent") {
    throw new ForgeMailError(
      "Emailing from a chat is for Forge Agent. In Workflow Builder a workflow sends email with the tether_email_send tool.",
      403,
    );
  }
  const key = ctx.chatId ?? ctx.sessionId;
  const recent = (sent.get(key) ?? []).filter((t) => t > deps.now() - 3_600_000);
  sent.set(key, recent);
  if (recent.length >= deps.caps.perHour) {
    throw new ForgeMailError(`This chat has sent ${recent.length} emails in the last hour. Try again later.`, 429);
  }

  const { subject, body } = input;
  const tag = ctx.chatId ? `chat:${ctx.chatId}` : `forge:${ctx.sessionId}`;
  const base = { workspaceId: ctx.workspaceId, flowExecutionId: null, stepId: tag, cc: [] as string[], subject: subject.slice(0, 500) };
  const refused = async (message: string, status: number): Promise<never> => {
    await deps.record({ ...base, recipients: [], outcome: "refused", failureReason: message.slice(0, 2000) });
    throw new ForgeMailError(message, status);
  };

  const owner = await resolveOwnerAddress(ctx.ownerSubject, deps.lookupEmail);
  let rcpt: ReturnType<typeof chatRecipients>;
  try {
    rcpt = chatRecipients(input, owner);
  } catch (e) {
    if (e instanceof ForgeMailError) return refused(e.message, e.statusCode);
    throw e;
  }
  const capsCheck = checkMessageCaps({
    subject,
    body,
    caps: { maxRecipients: deps.caps.maxRecipients, maxBodyBytes: deps.caps.maxBodyBytes },
  });
  if (!capsCheck.ok) return refused(capsCheck.message, 422);

  let attachments: ReturnType<typeof readChatAttachments> = [];
  try {
    attachments = readChatAttachments(ctx.workspaceId, ctx.sessionId, input.attachments ?? [], deps.caps);
  } catch (e) {
    if (e instanceof ForgeMailError) return refused(e.message, e.statusCode);
    throw e;
  }
  const meta = attachments.map((a) => ({ name: a.name, bytes: a.bytes }));

  if (!rcpt.ownerOnly) {
    const paths = input.attachments ?? [];
    return {
      status: "pending",
      draft: {
        to: rcpt.to,
        cc: rcpt.cc,
        subject,
        body,
        attachments: attachments.map((a, i) => ({
          path: paths[i],
          name: a.name,
          bytes: a.bytes,
          sha256: createHash("sha256").update(a.data).digest("hex"),
        })),
        expiresAt: new Date(deps.now() + EMAIL_CONFIRM_TTL_MS).toISOString(),
      },
    };
  }
  const ownerAddr = rcpt.to[0];

  const intent = await deps.record({
    ...base,
    recipients: [ownerAddr],
    resolvedFrom: "requester",
    attachments: meta,
    outcome: "failed",
    failureReason: "no provider answer yet",
  });
  const r = await deps.send({ subject, body, contentType: "Text", to: [ownerAddr], attachments });
  if (!r.ok) {
    await deps.finish(intent.id, {
      outcome: "failed",
      graphMessageId: null,
      failureReason: `${r.message} ${JSON.stringify(r.detail)}`.slice(0, 2000),
    });
    throw new ForgeMailError(r.message, r.status);
  }
  await deps.finish(intent.id, { outcome: "sent", graphMessageId: r.messageId, failureReason: null });
  recent.push(deps.now());
  try {
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      chatId: ctx.chatId,
      description: `Forge emailed the chat's owner (${ownerAddr}): "${subject.slice(0, 200)}" with ${attachments.length} attachment(s)`,
      raw: { chatId: ctx.chatId, sessionId: ctx.sessionId, attachments: meta },
    });
  } catch (e) {
    console.warn(`[forge-mail] could not record the audit entry: ${(e as Error).message}`);
  }
  return { status: "sent", sentTo: ownerAddr, to: [ownerAddr], cc: [], attachments: meta };
}

function draftRow(ctx: ForgeMailContext, draft: ForgeEmailDraft) {
  return {
    workspaceId: ctx.workspaceId,
    flowExecutionId: null,
    stepId: ctx.chatId ? `chat:${ctx.chatId}` : `forge:${ctx.sessionId}`,
    subject: draft.subject.slice(0, 500),
    recipients: draft.to,
    cc: draft.cc,
    resolvedFrom: "explicit" as const,
    attachments: draft.attachments.map(({ name, bytes }) => ({ name, bytes })),
  };
}

async function auditSafely(deps: ForgeMailDeps, entry: Parameters<ForgeMailDeps["audit"]>[0]): Promise<void> {
  try {
    await deps.audit(entry);
  } catch (e) {
    console.warn(`[forge-mail] could not record the audit entry: ${(e as Error).message}`);
  }
}

export async function expireForgeMail(
  ctx: ForgeMailContext,
  draft: ForgeEmailDraft,
  deps: ForgeMailDeps,
): Promise<{ outcome: "expired"; message: string }> {
  await deps.record({
    ...draftRow(ctx, draft),
    outcome: "refused",
    failureReason: "expired: not confirmed within 30 minutes; nothing was sent",
  });
  await auditSafely(deps, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    chatId: ctx.chatId,
    description: `An email Forge drafted to ${draft.to.join(", ")} expired unconfirmed: "${draft.subject.slice(0, 200)}"`,
    raw: { chatId: ctx.chatId, sessionId: ctx.sessionId, to: draft.to, cc: draft.cc },
  });
  return {
    outcome: "expired",
    message: "This email expired before it was confirmed (30 minutes), so nothing was sent. Ask Forge again.",
  };
}

export async function cancelForgeMail(
  ctx: ForgeMailContext,
  draft: ForgeEmailDraft,
  by: { label: string },
  deps: ForgeMailDeps,
): Promise<void> {
  await deps.record({
    ...draftRow(ctx, draft),
    outcome: "refused",
    failureReason: `cancelled: ${by.label} pressed Cancel on the card; nothing was sent`,
  });
  await auditSafely(deps, {
    workspaceId: ctx.workspaceId,
    actor: by.label,
    chatId: ctx.chatId,
    description: `${by.label} cancelled an email Forge drafted to ${draft.to.join(", ")}: "${draft.subject.slice(0, 200)}"`,
    raw: { chatId: ctx.chatId, sessionId: ctx.sessionId, to: draft.to, cc: draft.cc },
  });
}

export async function confirmForgeMail(
  ctx: ForgeMailContext,
  draft: ForgeEmailDraft,
  by: { label: string },
  deps: ForgeMailDeps,
): Promise<{ outcome: "sent" | "failed" | "expired"; message: string }> {
  if (deps.now() > Date.parse(draft.expiresAt)) return expireForgeMail(ctx, draft, deps);

  const key = ctx.chatId ?? ctx.sessionId;
  const recent = (sent.get(key) ?? []).filter((t) => t > deps.now() - 3_600_000);
  sent.set(key, recent);
  if (recent.length >= deps.caps.perHour) {
    throw new ForgeMailError(`This chat has sent ${recent.length} emails in the last hour. Try again later.`, 429);
  }

  const row = draftRow(ctx, draft);
  let files: ReturnType<typeof readChatAttachments>;
  try {
    files = readChatAttachments(ctx.workspaceId, ctx.sessionId, draft.attachments.map((a) => a.path), deps.caps);
  } catch (e) {
    if (!(e instanceof ForgeMailError)) throw e;
    await deps.record({ ...row, outcome: "refused", failureReason: e.message.slice(0, 2000) });
    return { outcome: "failed", message: `${e.message} Nothing was sent.` };
  }
  for (let i = 0; i < draft.attachments.length; i++) {
    const want = draft.attachments[i];
    const got = files[i];
    if (!got || got.name !== want.name || createHash("sha256").update(got.data).digest("hex") !== want.sha256) {
      const message = `${want.path} changed after the card was shown, so nothing was sent. Ask Forge to propose it again.`;
      await deps.record({ ...row, outcome: "refused", failureReason: message });
      return { outcome: "failed", message };
    }
  }

  const intent = await deps.record({ ...row, outcome: "failed", failureReason: "no provider answer yet" });
  const r = await deps.send({
    subject: draft.subject,
    body: draft.body,
    contentType: "Text",
    to: draft.to,
    ...(draft.cc.length ? { cc: draft.cc } : {}),
    attachments: files,
  });
  if (!r.ok) {
    await deps.finish(intent.id, {
      outcome: "failed",
      graphMessageId: null,
      failureReason: `${r.message} ${JSON.stringify(r.detail)}`.slice(0, 2000),
    });
    return { outcome: "failed", message: r.message };
  }
  await deps.finish(intent.id, { outcome: "sent", graphMessageId: r.messageId, failureReason: null });
  recent.push(deps.now());
  const to = draft.to.join(", ");
  const cc = draft.cc.join(", ");
  await auditSafely(deps, {
    workspaceId: ctx.workspaceId,
    actor: by.label,
    chatId: ctx.chatId,
    description: `${by.label} confirmed an email Forge drafted, sent to ${to}${cc ? `; cc ${cc}` : ""}: "${draft.subject.slice(0, 200)}" with ${files.length} attachment(s)`,
    raw: { chatId: ctx.chatId, sessionId: ctx.sessionId, to: draft.to, cc: draft.cc, attachments: row.attachments },
  });
  return { outcome: "sent", message: `Sent to ${to}${cc ? `; cc ${cc}` : ""}` };
}
