import express, { Router, type Request } from "express";
import { previewOf } from "../pi-builder/file-preview.js";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { piBuilderService } from "../pi-builder/service.js";
import type { PiEvent } from "../pi-builder/types.js";
import { THINKING_LEVELS } from "../pi-builder/thinking.js";
import { flowRunnerService, FlowRunnerError, type PiBundle } from "../services/flow-runner.service.js";
import { requesterOf } from "../services/run-requester.js";
import { authorOf, requireIdentity } from "../middleware/identity.middleware.js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from "../pi-builder/attachments.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { parsePlace, projectService } from "../services/project.service.js";
import { piChatRepo } from "../repositories/pi-chat.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { chatRead, mayChangeFlowNamedInBody, noteAdminReads } from "../middleware/content-guard.middleware.js";

/**
 * Pi builder — isolated per-session sandbox, JSON event stream from Pi,
 * Accept → snapshot. Mounted at `/api/workspaces/:workspaceId/pi-builder`.
 */
export const piBuilderRouter = Router({ mergeParams: true });

piBuilderRouter.post(
  "/sessions",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        goal: z.string().max(20_000).optional(),
        /** Bind to an existing Foundry flow — one Pi session per flow. */
        flowId: z.string().uuid().optional().nullable(),
        /** /flows/new tab key — parallel drafts stay isolated. */
        draftKey: z.string().uuid().optional().nullable(),
        /** Reopen a saved chat (0095). */
        chatId: z.string().uuid().optional().nullable(),
        /** The mode a NEW chat starts in (0097); without it, the person's default. */
        mode: z.enum(["workflow", "agent"]).optional().nullable(),
        /** A NEW chat started inside a project (sharing-boundaries phase 5); only for somebody in it. */
        projectId: z.string().uuid().optional().nullable(),
      })
      .strict()
      .parse(req.body ?? {});
    /** Set when this person is opening somebody else's chat (an Admin): the screen says whose it is. */
    let othersChat: { ownerName: string | null } | null = null;
    /**
     * Where this chat lives, so the builder can say it before anything is saved (P6-I4): a reopened chat's own place,
     * else the project it is started in, else My space. `key` is the place key the Move dialog uses.
     */
    let place: { key: string; projectName: string | null } = { key: "mine", projectName: null };
    // The chat or workflow named in the BODY is checked here — the content guard reads paths only. Reopening a chat
    // needs it to be yours (or an Admin's); building on a workflow needs it to be yours to change.
    {
      const ws = req.params.workspaceId;
      const viewer = await contentVisibility.viewer(req.user, ws);
      const gone = () => res.status(404).json({ error: "not_found", message: "This is not here any more." });
      if (input.chatId) {
        const chat = await piChatRepo.get(ws, input.chatId);
        if (chat && !contentVisibility.chatVisible(viewer, chat)) return gone();
        // A shared chat is shared to READ (sharing-boundaries): only its owner (or an Admin) continues it.
        if (chat && !contentVisibility.chatChangeable(viewer, chat)) {
          return res.status(403).json({
            error: "read_only",
            message: "This chat is shared with the workspace to read. Only the person who started it can continue it.",
          });
        }
        // An Admin reopening somebody else's chat leaves a line in the audit history (rbac-observability).
        if (chat) place = chat.projectId ? { key: `project:${chat.projectId}`, projectName: null } : { key: chat.visibility === "public" ? "workspace" : "mine", projectName: null };
        if (chat && chat.createdBySubject !== viewer.subject) {
          noteAdminReads(req, ws, [chatRead(chat)]);
          othersChat = { ownerName: chat.createdByName ?? null };
        }
      }
      if (input.flowId) {
        const flow = await flowRepo.get(ws, input.flowId);
        if (flow && !contentVisibility.flowChangeable(viewer, flow)) return gone();
        // A chat opened on a workflow lives with it.
        if (flow && !input.chatId) place = flow.projectId ? { key: `project:${flow.projectId}`, projectName: null } : { key: flow.visibility === "public" ? "workspace" : "mine", projectName: null };
      }
      // A project this person is not in is NOT FOUND, like everything in it.
      if (input.projectId && ((!viewer.all && !viewer.projects?.has(input.projectId)) || !(await projectService.contextOf(ws, input.projectId)))) return gone();
      if (!input.chatId && input.projectId) place = { key: `project:${input.projectId}`, projectName: null };
      if (place.key.startsWith("project:")) place.projectName = (await projectService.contextOf(ws, place.key.slice(8)))?.name ?? null;
    }
    const session = await piBuilderService.create(req.params.workspaceId, {
      goal: input.goal ?? "",
      flowId: input.flowId ?? null,
      draftKey: input.draftKey ?? null,
      chatId: input.chatId ?? null,
      mode: input.mode ?? null,
      projectId: input.projectId ?? null,
      person: req.user ? { subject: req.user.subject ?? null, name: req.user.name ?? null, email: req.user.email ?? null } : null,
    });
    res.status(201).json({ session, othersChat, place });
  }),
);

/**
 * Saved chats (0095). A chat is PRIVATE (rbac-observability, 2026-10-15): its owner sees it, renames it and deletes
 * it; so does anybody holding `content.read.others` (the Admin preset). Nobody else learns it exists — the content
 * guard answers 404 on every `/chats/:chatId` route, and the list below holds only what this person may see.
 */
async function mayChangeChat(workspaceId: string, user: Request["user"], ownerSubject: string | null): Promise<boolean> {
  if (user?.subject != null && ownerSubject === user.subject) return true;
  return (await contentVisibility.viewer(user, workspaceId)).all;
}

piBuilderRouter.get(
  "/chats",
  asyncHandler(async (req, res) => {
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId);
    const chats = (await piBuilderService.listChats(req.params.workspaceId)).filter((c) =>
      contentVisibility.chatVisible(viewer, {
        id: c.id,
        createdBySubject: c.createdBy.subject,
        visibility: c.visibility,
        projectId: c.projectId,
      }),
    );
    const projectNames = await projectService.namesIn(req.params.workspaceId);
    res.json({
      // Listed: the viewer's own, every chat shared with the workspace (to read), and everything for an Admin.
      // `canChange` (continue, rename, delete, share): the owner's or an Admin's — a shared chat is not the reader's.
      // `mine`: started by the person asking — an Admin, who sees everybody's, can narrow to their own.
      chats: chats.map((c) => {
        const canChange = contentVisibility.chatChangeable(viewer, { createdBySubject: c.createdBy.subject });
        return { ...c, projectName: c.projectId ? (projectNames.get(c.projectId) ?? null) : null, canDelete: canChange, canRename: canChange, canChange, mine: viewer.subject != null && c.createdBy.subject === viewer.subject };
      }),
    });
  }),
);

piBuilderRouter.delete(
  "/chats/:chatId",
  asyncHandler(async (req, res) => {
    const chatId = z.string().uuid().parse(req.params.chatId);
    const owner = await piBuilderService.chatOwner(req.params.workspaceId, chatId);
    if (!owner) return res.status(404).json({ error: "not_found", message: "This chat is not here any more." });
    if (!(await mayChangeChat(req.params.workspaceId, req.user, owner.subject))) {
      return res.status(403).json({ error: "forbidden", message: "Only the person who started this chat or an Admin can delete it." });
    }
    await piBuilderService.deleteChat(req.params.workspaceId, chatId);
    res.status(204).end();
  }),
);

piBuilderRouter.patch(
  "/chats/:chatId",
  asyncHandler(async (req, res) => {
    const chatId = z.string().uuid().parse(req.params.chatId);
    // ⚠ WHERE a chat lives changes with Move only (sharing-boundaries phase 7, P7-D1): this used to take `visibility`,
    // a second way to move it that skipped saying first who would lose it. Named, it is refused — never ignored.
    const input = z
      .object({
        title: z.string().trim().min(1, "A chat needs a name.").max(200, "A chat's name can be at most 200 characters.").optional(),
        visibility: z.string().optional(),
      })
      .strict()
      .refine((b) => b.title !== undefined || b.visibility !== undefined, "Say what to change: its name.")
      .parse(req.body);
    if (input.visibility !== undefined) {
      return res.status(409).json({ error: "use_move", message: "Where a chat lives changes with Move, which says first who would gain or lose it: POST …/pi-builder/chats/:chatId/move." });
    }
    const owner = await piBuilderService.chatOwner(req.params.workspaceId, chatId);
    if (!owner) return res.status(404).json({ error: "not_found", message: "This chat is not here any more." });
    if (!(await mayChangeChat(req.params.workspaceId, req.user, owner.subject))) {
      return res.status(403).json({ error: "forbidden", message: "Only the person who started this chat or an Admin can change it." });
    }
    const title = input.title?.replace(/\s+/g, " ");
    if (title !== undefined) await piBuilderService.renameChat(req.params.workspaceId, chatId, title);
    res.json({ id: chatId, ...(title !== undefined ? { title } : {}) });
  }),
);

/**
 * Where a chat lives (sharing-boundaries phase 5): My space, a project, or the Workspace. Like a workflow's, the preview
 * says first who would stop seeing it. Moving is the person who started it's, or an Admin's; into a project, only for
 * somebody in it. A chat in a project starts each turn with the project's shared instructions.
 */
piBuilderRouter.get(
  "/chats/:chatId/move-preview",
  asyncHandler(async (req, res) => {
    const chatId = z.string().uuid().parse(req.params.chatId);
    const owner = await piBuilderService.chatOwner(req.params.workspaceId, chatId);
    if (!owner) return res.status(404).json({ error: "not_found" });
    if (!(await mayChangeChat(req.params.workspaceId, req.user, owner.subject))) {
      return res.status(403).json({ error: "forbidden", message: "Only the person who started this chat or an Admin can move it." });
    }
    const to = parsePlace(z.string().parse(req.query.to ?? ""));
    if (!to) return res.status(400).json({ error: "bad_place", message: "Say where to: mine, workspace, or project:<id>." });
    const preview = await projectService.movePreview(req.params.workspaceId, { kind: "chat", id: chatId }, to);
    if (!preview) return res.status(404).json({ error: "not_found" });
    res.json(preview);
  }),
);

piBuilderRouter.post(
  "/chats/:chatId/move",
  asyncHandler(async (req, res) => {
    const chatId = z.string().uuid().parse(req.params.chatId);
    const { to: raw } = z.object({ to: z.string().min(1).max(64) }).strict().parse(req.body ?? {});
    const owner = await piBuilderService.chatOwner(req.params.workspaceId, chatId);
    if (!owner) return res.status(404).json({ error: "not_found" });
    if (!req.user || !(await mayChangeChat(req.params.workspaceId, req.user, owner.subject))) {
      return res.status(403).json({ error: "forbidden", message: "Only the person who started this chat or an Admin can move it." });
    }
    const to = parsePlace(raw);
    if (!to) return res.status(400).json({ error: "bad_place", message: "Say where to: mine, workspace, or project:<id>." });
    const ws = req.params.workspaceId;
    await projectService.move(ws, { kind: "chat", id: chatId }, to, await contentVisibility.viewer(req.user, ws), req.user.email ?? req.user.subject);
    res.json({ id: chatId, to: raw });
  }),
);

/**
 * Read a chat WITHOUT opening it (sharing-boundaries P1-I5 "A"): the stored conversation, for a member reading a chat
 * shared with the workspace. Starts no Forge process and changes nothing. The content guard answers 404 when this
 * person may not see it, and records an Admin's look at somebody's private chat (which notifies its owner).
 */
piBuilderRouter.get(
  "/chats/:chatId",
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId!;
    const chatId = z.string().uuid().parse(req.params.chatId);
    const chat = await piChatRepo.get(ws, chatId);
    if (!chat) return res.status(404).json({ error: "not_found", message: "This chat is not here any more." });
    const viewer = await contentVisibility.viewer(req.user, ws);
    const canChange = contentVisibility.chatChangeable(viewer, chat);
    const sharedToMe = viewer.subject != null && viewer.sharedChats?.has(chat.id) === true;
    // Phase 5.2: non-owners reading a shared chat get redacted message text (secrets never leave for a sharee).
    const { redactChatMessages } = await import("../services/item-share.service.js");
    const rawMessages = (Array.isArray(chat.messages) ? chat.messages : []) as Array<{ text?: string | null; [k: string]: unknown }>;
    const messages = canChange ? rawMessages : redactChatMessages(rawMessages);
    res.json({
      chat: {
        id: chat.id,
        title: chat.title,
        mode: chat.mode,
        flowId: chat.flowId,
        visibility: chat.visibility,
        projectId: chat.projectId ?? null,
        createdBy: { subject: chat.createdBySubject, name: chat.createdByName },
        updatedAt: chat.updatedAt,
        messages,
      },
      mine: viewer.subject != null && chat.createdBySubject === viewer.subject,
      canChange,
      /** True when this person may read because of a per-person share (Phase 5), not Workspace/project place. */
      sharedWithMe: sharedToMe && !canChange,
    });
  }),
);

/** Per-person read shares on a chat (Phase 5) — People-listed members only; no public links. */
piBuilderRouter.get(
  "/chats/:chatId/shares",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { itemShareService } = await import("../services/item-share.service.js");
    const chatId = z.string().uuid().parse(req.params.chatId);
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    res.json({ shares: await itemShareService.list(req.params.workspaceId!, "chat", chatId, viewer) });
  }),
);

piBuilderRouter.post(
  "/chats/:chatId/shares",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { itemShareService } = await import("../services/item-share.service.js");
    const chatId = z.string().uuid().parse(req.params.chatId);
    const { subject } = z.object({ subject: z.string().min(1).max(320) }).strict().parse(req.body ?? {});
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    const share = await itemShareService.grant(
      req.params.workspaceId!,
      "chat",
      chatId,
      viewer,
      req.user!.email ?? req.user!.subject,
      subject,
    );
    res.status(201).json({ share });
  }),
);

piBuilderRouter.delete(
  "/chats/:chatId/shares/:subject",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { itemShareService } = await import("../services/item-share.service.js");
    const chatId = z.string().uuid().parse(req.params.chatId);
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId!);
    await itemShareService.revoke(req.params.workspaceId!, "chat", chatId, viewer, req.params.subject!);
    res.status(204).end();
  }),
);

piBuilderRouter.get(
  "/chats/:chatId/files/:name",
  asyncHandler(async (req, res) => {
    const chatId = z.string().uuid().parse(req.params.chatId);
    const file = await piBuilderService.chatFile(req.params.workspaceId, chatId, req.params.name);
    res.setHeader("Cache-Control", "no-store");
    // ?preview=1: a sheet or Word document as JSON the page can draw (file-preview.ts).
    if (req.query.preview === "1") {
      res.json({ preview: previewOf(file.name, file.body) });
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.body.length));
    // ?inline=1: shown in the page (an image or a PDF in the preview), not saved. Only types a browser renders safely;
    // anything else still downloads, so a file can never run as a page on this origin.
    const inline = req.query.inline === "1" && /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|text\/csv)/.test(file.contentType);
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(file.body);
  }),
);

piBuilderRouter.delete(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) => {
    piBuilderService.destroy(req.params.workspaceId, req.params.sessionId);
    res.status(204).end();
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/bind-flow",
  asyncHandler(async (req, res) => {
    const input = z.object({ flowId: z.string().uuid() }).strict().parse(req.body);
    if (!(await mayChangeFlowNamedInBody(req.user, req.params.workspaceId, input.flowId))) {
      return res.status(404).json({ error: "not_found", message: "This is not here any more." });
    }
    const session = piBuilderService.bindFlow(
      req.params.workspaceId,
      req.params.sessionId,
      input.flowId,
    );
    res.json({ session });
  }),
);

piBuilderRouter.get(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) => {
    res.json({ session: piBuilderService.get(req.params.workspaceId, req.params.sessionId) });
  }),
);

/**
 * SSE of PiEvent. Proxy must stream (not buffer) text/event-stream.
 */
piBuilderRouter.get(
  "/sessions/:sessionId/events",
  asyncHandler(async (req, res) => {
    // Prove session exists first
    piBuilderService.get(req.params.workspaceId, req.params.sessionId);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const write = (ev: PiEvent) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    // Snapshot current state as first events so late subscribers catch up
    const snap = piBuilderService.get(req.params.workspaceId, req.params.sessionId);
    write({ type: "status", status: snap.status });
    write({ type: "workflow", workflow: snap.workflow });
    write({ type: "questions", questions: snap.questions });
    for (const a of snap.liveActivities) write({ type: "activity", activity: a });
    // The reply written so far: a page that reloads mid-answer shows it at once instead of a blank until the turn ends.
    if (snap.draftText) write({ type: "delta", text: snap.draftText });

    const unsub = piBuilderService.subscribe(req.params.workspaceId, req.params.sessionId, write);
    // An open stream IS the page being open: it is what keeps the conversation's Forge alive (forge-pool.ts).
    piBuilderService.connected(req.params.workspaceId, req.params.sessionId);
    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsub();
      piBuilderService.disconnected(req.params.workspaceId, req.params.sessionId);
    });
  }),
);

/** Who sent a chat message — the verified identity only, never a body field. Null for a caller with none. */
function authorOfMessage(req: Request): { subject: string | null; name: string | null } | null {
  const u = req.user;
  if (!u) return null;
  return { subject: u.subject ?? null, name: u.name ?? u.email ?? null };
}

piBuilderRouter.post(
  "/sessions/:sessionId/messages",
  asyncHandler(async (req, res) => {
    // `retry`: Try again on a failure card — re-runs the last turn as it was (no text, no second message).
    // `attachments`: names of files uploaded to this chat (POST …/attachments) to send with the message. With files,
    // the text may be empty — a screenshot on its own is a message.
    const input = z
      .union([
        z
          .object({
            text: z.string().max(50_000),
            attachments: z.array(z.string().min(1).max(200)).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
          })
          .strict()
          .refine((b) => b.text.trim().length > 0 || (b.attachments?.length ?? 0) > 0, "message required"),
        z.object({ retry: z.literal(true) }).strict(),
      ])
      .parse(req.body);
    piBuilderService.noteReader(req.params.workspaceId, req.params.sessionId, req.user);
    const session = await piBuilderService.message(
      req.params.workspaceId,
      req.params.sessionId,
      "text" in input ? input.text : "",
      requesterOf(req),
      authorOfMessage(req),
      "retry" in input,
      "attachments" in input ? (input.attachments ?? []) : [],
    );
    res.status(202).json({ session });
  }),
);

/** "Send now" on a queued message (2026-11-03): give it to Forge during the turn that is running. 409 when no turn is running. */
piBuilderRouter.post(
  "/sessions/:sessionId/steer",
  asyncHandler(async (req, res) => {
    const { text } = z
      .object({ text: z.string().max(50_000) })
      .strict()
      .refine((b) => b.text.trim().length > 0, "message required")
      .parse(req.body ?? {});
    piBuilderService.noteReader(req.params.workspaceId, req.params.sessionId, req.user);
    const session = await piBuilderService.steer(req.params.workspaceId, req.params.sessionId, text, authorOfMessage(req));
    res.json({ session });
  }),
);

/**
 * Attach a file to this workflow's chat — the raw bytes, its name in `x-file-name` (URI-encoded). Stored as-is for
 * Forge to read while building (pi-builder/attachments.ts); sent with the next message that names it.
 */
piBuilderRouter.post(
  "/sessions/:sessionId/attachments",
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES + 1024 * 1024 }),
  asyncHandler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const header = req.header("x-file-name");
    let name: string | null = null;
    if (header) {
      try {
        name = decodeURIComponent(header);
      } catch {
        name = header; // a malformed escape is a name, not a 500
      }
    }
    const attachment = piBuilderService.attach(req.params.workspaceId, req.params.sessionId, raw, name);
    res.status(201).json({ attachment });
  }),
);

/** Remove an attached file that has not been sent yet. */
piBuilderRouter.delete(
  "/sessions/:sessionId/attachments/:name",
  asyncHandler(async (req, res) => {
    piBuilderService.detach(req.params.workspaceId, req.params.sessionId, req.params.name);
    res.status(204).end();
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/answers",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ answers: z.record(z.string(), z.string()) })
      .strict()
      .parse(req.body);
    piBuilderService.noteReader(req.params.workspaceId, req.params.sessionId, req.user);
    const session = await piBuilderService.answer(
      req.params.workspaceId,
      req.params.sessionId,
      input.answers,
      requesterOf(req),
      authorOfMessage(req),
    );
    res.status(202).json({ session });
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/verify",
  asyncHandler(async (req, res) => {
    const session = await piBuilderService.verify(req.params.workspaceId, req.params.sessionId);
    res.json({ session });
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/accept",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ label: z.string().max(200).optional() })
      .strict()
      .parse(req.body ?? {});
    const session = piBuilderService.accept(
      req.params.workspaceId,
      req.params.sessionId,
      input.label ?? "accept",
    );
    res.json({ session });
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/stop",
  asyncHandler(async (req, res) => {
    const session = piBuilderService.stop(req.params.workspaceId, req.params.sessionId);
    res.json({ session });
  }),
);

/** Remove a file from the chat (its folder and the saved chat); its cards stay, marked removed. */
piBuilderRouter.delete(
  "/sessions/:sessionId/files/:name",
  asyncHandler(async (req, res) => {
    const session = await piBuilderService.removeChatFile(req.params.workspaceId, req.params.sessionId, String(req.params.name));
    res.json({ session });
  }),
);

/** Switch the chat between Workflow Builder and Forge Agent (0097). Applies from the next message. */
piBuilderRouter.post(
  "/sessions/:sessionId/mode",
  asyncHandler(async (req, res) => {
    const { mode } = z.object({ mode: z.enum(["workflow", "agent"]) }).strict().parse(req.body ?? {});
    const session = await piBuilderService.setMode(req.params.workspaceId, req.params.sessionId, mode);
    res.json({ session });
  }),
);

/** How hard Forge Agent thinks (0119): low, balanced, high or ultra. Applies from the next message. */
piBuilderRouter.post(
  "/sessions/:sessionId/thinking",
  asyncHandler(async (req, res) => {
    const { thinking } = z.object({ thinking: z.enum(THINKING_LEVELS) }).strict().parse(req.body ?? {});
    const session = await piBuilderService.setThinking(req.params.workspaceId, req.params.sessionId, thinking);
    res.json({ session });
  }),
);

/** The model this chat's Forge runs with, from the models turned on for the builder. Applies from the next message. */
piBuilderRouter.post(
  "/sessions/:sessionId/model",
  asyncHandler(async (req, res) => {
    const { model } = z.object({ model: z.string().min(1).max(200) }).strict().parse(req.body ?? {});
    const session = await piBuilderService.setModel(req.params.workspaceId, req.params.sessionId, model);
    res.json({ session });
  }),
);

/**
 * The person's answer to a change Forge Agent proposed (plugins phase 6): run it, or decline it. ⚠ Only the person
 * Forge was answering may decide (checked in the service against the message's verified author), and only once.
 */
piBuilderRouter.post(
  "/sessions/:sessionId/proposals/:proposalId",
  asyncHandler(async (req, res) => {
    // `scope`: where a SETTING change applies (the person, in every chat of theirs, or the workspace), chosen by the button the person pressed.
    // `choice`: on an ACCOUNT card, the connection the person picked for this chat.
    const { decision, scope, choice, actionId, selected, always } = z
      .object({
        decision: z.enum(["run", "decline"]),
        scope: z.enum(["me", "workspace"]).optional(),
        choice: z.string().uuid().optional(),
        actionId: z.string().max(64).optional(),
        selected: z.array(z.string().max(128)).max(50).optional(),
        always: z.enum(["command", "path_read", "deny"]).nullable().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    if (!req.user?.subject) throw Object.assign(new Error("confirming a change needs a signed-in person"), { statusCode: 401 });
    const proposal = await piBuilderService.decideProposal(
      req.params.workspaceId!,
      req.params.sessionId!,
      req.params.proposalId!,
      decision,
      { subject: req.user.subject, email: req.user.email ?? null, name: req.user.name ?? null, identity: req.user },
      scope,
      choice,
      actionId || selected ? { actionId, selected } : undefined,
      always ?? null,
    );
    res.json({ proposal });
  }),
);

/** "Change" on the chat's accounts: forget the connection chosen for a service; the next call asks again (8.5). */
piBuilderRouter.post(
  "/sessions/:sessionId/accounts/clear",
  asyncHandler(async (req, res) => {
    const { piece } = z.object({ piece: z.string().min(1).max(200) }).strict().parse(req.body ?? {});
    const session = piBuilderService.clearAccount(req.params.workspaceId!, req.params.sessionId!, piece);
    res.json({ session });
  }),
);

/** "Compact now" on the context meter: Forge summarises the earlier conversation to make room. */
piBuilderRouter.post(
  "/sessions/:sessionId/compact",
  asyncHandler(async (req, res) => {
    const session = await piBuilderService.compact(req.params.workspaceId, req.params.sessionId);
    res.json({ session });
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/test-run",
  asyncHandler(async (req, res) => {
    // The values a person typed into the test form. Checked against the workflow's declared inputs (name, type,
    // required) by the runner service before a run exists — never here, so there is one rule.
    const body = z
      .object({
        inputs: z.record(z.union([z.string().max(10_000), z.number(), z.boolean()])).optional(),
        useProductionData: z.boolean().optional().default(false),
        /**
         * Continue the session's test run that is WAITING at an approval (P5): the person testing decides it here.
         * A test captures mail and runs on test data, so the person who started it may approve it — the
         * started-it-cannot-approve-it rule guards live runs in the approvals inbox, where it still applies.
         */
        decision: z.enum(["approved", "rejected"]).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    // Both answer at once (202): the run goes on in the background and its result arrives on the event stream.
    if (body.decision) {
      const session = await piBuilderService.decideTest(req.params.workspaceId, req.params.sessionId, body.decision, requesterOf(req));
      return res.status(202).json({ session });
    }
    if (body.useProductionData) {
      // The SAME gate the old builder's test run applies (routes/flows.ts): a workspace admin, from the verified
      // identity — 401 anonymous, 403 anyone else. Dynamic import for the same cycle reason as there.
      const { workspaceMemberService } = await import("../services/workspace-member.service.js");
      const verdict = await workspaceMemberService.check(req.params.workspaceId, req.user, "admin");
      if (!verdict.allowed) return res.status(verdict.status).json({ error: "forbidden", message: verdict.reason });
    }
    const session = await piBuilderService.testRun(
      req.params.workspaceId,
      req.params.sessionId,
      requesterOf(req),
      body.inputs,
      { useProductionData: body.useProductionData },
    );
    res.status(202).json({ session });
  }),
);

/**
 * Start a DRAFT run of a Pi bundle on Foundry's own runner (plans/pi-runtime-2026-10-09, P1).
 * Draft only — the run reads mock data and captures mail; nothing in the body can change that (D-52).
 */
piBuilderRouter.post(
  "/runs",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        flowId: z.string().uuid().optional().nullable(),
        // Every top-level key workflow.json may carry, and nothing else (`.strict()`). It listed only reads + steps and
        // zod DROPS unlisted keys, so `inputs` (and its defaults) vanished on the way to the runner — a key accepted and
        // ignored reads exactly like one that works. Same list as the verifier's TOP_KEYS.
        workflow: z
          .object({
            name: z.string().max(200).optional(),
            inputs: z.record(z.unknown()).optional(),
            reads: z.record(z.unknown()).optional(),
            steps: z.array(z.record(z.unknown())).min(1).max(100),
          })
          .strict(),
        files: z.record(z.string().max(200_000)).refine((f) => Object.keys(f).length <= 200, "too many files"),
        inputs: z.record(z.unknown()).optional(),
      })
      .strict()
      .parse(req.body);
    if (!(await mayChangeFlowNamedInBody(req.user, req.params.workspaceId, input.flowId))) {
      return res.status(404).json({ error: "not_found", message: "This is not here any more." });
    }
    try {
      const started = await flowRunnerService.startDraftRun({
        workspaceId: req.params.workspaceId,
        flowId: input.flowId ?? null,
        bundle: { workflow: input.workflow as PiBundle["workflow"], files: input.files },
        inputs: input.inputs,
        requester: requesterOf(req),
      });
      res.status(202).json(started);
    } catch (e) {
      if (e instanceof FlowRunnerError) return res.status(e.statusCode).json({ error: "run_refused", message: e.message });
      throw e;
    }
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/save-version",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ name: z.string().min(1).max(200).optional() })
      .strict()
      .parse(req.body ?? {});
    const session = await piBuilderService.saveVersion(
      req.params.workspaceId,
      req.params.sessionId,
      // The author is the VERIFIED identity (authorOf is the only minter of `user`); there is no body field for it.
      { name: input.name, author: authorOf(req, undefined) },
    );
    res.json({ session });
  }),
);

/**
 * Chat → schedule (personal Phase 1): put a preset cron on the workflow, optionally save + switch on.
 * Identity is required — arming is enableOwn, which needs the verified subject.
 */
piBuilderRouter.post(
  "/sessions/:sessionId/schedule",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        cron: z.string().min(1).max(64),
        timezone: z.string().min(1).max(64).optional(),
        arm: z.boolean().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const subject = req.user!.subject;
    const out = await piBuilderService.setSchedule(req.params.workspaceId, req.params.sessionId, {
      cron: input.cron,
      timezone: input.timezone,
      arm: input.arm === true,
      author: authorOf(req, undefined),
      subject,
      actor: req.user?.email || subject,
    });
    res.json(out);
  }),
);

/**
 * Workflow references (plans/workflow-references-2026-10-16): saved workflows of this workspace a Workflow Builder
 * chat learns from. The service holds every rule (same workspace, saved only, never the chat's own, at most 3).
 */
piBuilderRouter.get(
  "/sessions/:sessionId/referenceable",
  asyncHandler(async (req, res) => {
    const viewer = await contentVisibility.viewer(req.user, req.params.workspaceId);
    res.json({ workflows: await piBuilderService.referenceable(req.params.workspaceId, req.params.sessionId, viewer) });
  }),
);

piBuilderRouter.get(
  "/sessions/:sessionId/references",
  asyncHandler(async (req, res) => {
    res.json({ references: await piBuilderService.references(req.params.workspaceId, req.params.sessionId) });
  }),
);

piBuilderRouter.post(
  "/sessions/:sessionId/references",
  asyncHandler(async (req, res) => {
    const input = z.object({ flowId: z.string().uuid() }).strict().parse(req.body);
    piBuilderService.noteReader(req.params.workspaceId, req.params.sessionId, req.user);
    const references = await piBuilderService.addReference(
      req.params.workspaceId,
      req.params.sessionId,
      input.flowId,
      req.user?.subject ?? null,
      // The workflow is named in the BODY, which the content guard does not read: only one the person may see.
      await contentVisibility.viewer(req.user, req.params.workspaceId),
    );
    res.status(201).json({ references });
  }),
);

piBuilderRouter.patch(
  "/sessions/:sessionId/references/:refId",
  asyncHandler(async (req, res) => {
    const input = z.object({ revision: z.number().int().min(1) }).strict().parse(req.body);
    const references = await piBuilderService.setReferenceVersion(
      req.params.workspaceId,
      req.params.sessionId,
      req.params.refId,
      input.revision,
      await contentVisibility.viewer(req.user, req.params.workspaceId),
    );
    res.json({ references });
  }),
);

piBuilderRouter.delete(
  "/sessions/:sessionId/references/:refId",
  asyncHandler(async (req, res) => {
    const references = await piBuilderService.removeReference(req.params.workspaceId, req.params.sessionId, req.params.refId);
    res.json({ references });
  }),
);
