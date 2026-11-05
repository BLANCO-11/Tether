import express, { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { requireIdentity, requireWorkspaceRole } from "../middleware/identity.middleware.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { projectService } from "../services/project.service.js";
import { MAX_PROJECT_FILE_BYTES, projectFileService } from "../services/project-file.service.js";
import { MEMORY_KINDS, MEMORY_SOURCES, pickMemoryCandidates, projectMemoryService } from "../services/project-memory.service.js";

/**
 * `/api/workspaces/:workspaceId/projects` — projects (sharing-boundaries phase 5). A project this person is not in
 * answers NOT FOUND (an Admin sees every one); changing one is its owner's or an Admin's. Members come from the
 * workspace. Removing somebody takes everything in it from them at once.
 */
export const projectsRouter = Router({ mergeParams: true });

const who = (req: { user?: { subject: string; email?: string | null } }) => ({ subject: req.user!.subject, actor: req.user!.email ?? req.user!.subject });
const viewerOf = (req: Parameters<Parameters<typeof projectsRouter.get>[1]>[0]) => contentVisibility.viewer(req.user, req.params.workspaceId!);

projectsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({ projects: await projectService.list(req.params.workspaceId!, await viewerOf(req)) });
  }),
);

projectsRouter.post(
  "/",
  requireIdentity,
  // An Observer builds nothing; a project is somewhere to build with others.
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(120), description: z.string().max(2000).nullish(), instructions: z.string().max(20_000).optional() })
      .strict()
      .parse(req.body ?? {});
    res.status(201).json({ project: await projectService.create(req.params.workspaceId!, who(req), body) });
  }),
);

projectsRouter.get(
  "/:projectId",
  asyncHandler(async (req, res) => {
    const p = await projectService.get(req.params.workspaceId!, req.params.projectId!, await viewerOf(req));
    if (!p) return res.status(404).json({ error: "not_found" });
    res.json({ project: p });
  }),
);

projectsRouter.patch(
  "/:projectId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ name: z.string().min(1).max(120).optional(), description: z.string().max(2000).nullish(), instructions: z.string().max(20_000).optional() })
      .strict()
      .parse(req.body ?? {});
    res.json({ project: await projectService.update(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), who(req).actor, body) });
  }),
);

projectsRouter.delete(
  "/:projectId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    res.json(await projectService.remove(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), who(req).actor));
  }),
);

projectsRouter.post(
  "/:projectId/members",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { subject } = z.object({ subject: z.string().min(1).max(320) }).strict().parse(req.body ?? {});
    await projectService.addMember(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), who(req).actor, subject);
    res.status(201).json({ project: await projectService.get(req.params.workspaceId!, req.params.projectId!, await viewerOf(req)) });
  }),
);

/** Remove a member — the owner or an Admin; or anybody removing THEMSELVES (leaving). */
projectsRouter.delete(
  "/:projectId/members/:subject",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const v = await viewerOf(req);
    if (!v.all && !v.projects?.has(req.params.projectId!)) return res.status(404).json({ error: "not_found" });
    res.json(await projectService.removeMember(req.params.workspaceId!, req.params.projectId!, v, who(req).actor, req.params.subject!));
  }),
);

projectsRouter.put(
  "/:projectId/owner",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { subject } = z.object({ subject: z.string().min(1).max(320) }).strict().parse(req.body ?? {});
    await projectService.setOwner(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), who(req).actor, subject);
    res.json({ project: await projectService.get(req.params.workspaceId!, req.params.projectId!, await viewerOf(req)) });
  }),
);

/**
 * A project's files (0132) — for its members and Admins; the service answers NOT FOUND to anybody else. Adding one
 * is any member who builds; removing one is whoever added it, the owner, or an Admin.
 */
projectsRouter.get(
  "/:projectId/files",
  asyncHandler(async (req, res) => {
    res.json({ files: await projectFileService.list(req.params.workspaceId!, req.params.projectId!, await viewerOf(req)) });
  }),
);

projectsRouter.post(
  "/:projectId/files",
  requireIdentity,
  // The parser allows a little over the limit so the service, not the parser, refuses — with the size in words.
  express.raw({ type: () => true, limit: MAX_PROJECT_FILE_BYTES + 1024 * 1024 }),
  asyncHandler(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const file = await projectFileService.upload(
      req.params.workspaceId!,
      req.params.projectId!,
      await viewerOf(req),
      { subject: req.user!.subject, email: req.user!.email ?? null },
      req.header("x-file-name") ?? null,
      body,
    );
    res.status(201).json({ file });
  }),
);

projectsRouter.get(
  "/:projectId/files/:fileId/content",
  asyncHandler(async (req, res) => {
    const f = await projectFileService.read(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), { id: req.params.fileId! });
    if (!f) return res.status(404).json({ error: "not_found", message: "No such file in this project." });
    res.setHeader("content-type", f.contentType);
    res.setHeader("content-length", String(f.data.length));
    res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.end(f.data);
  }),
);

projectsRouter.delete(
  "/:projectId/files/:fileId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    await projectFileService.remove(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), req.params.fileId!);
    res.status(204).end();
  }),
);

/**
 * Project memory ledger (Phase 4) — curated facts chats in the project start with. Members list and add;
 * owner / Admin supersede or discard. Compact promotions are accepted through POST with source=compact.
 */
projectsRouter.get(
  "/:projectId/memories",
  asyncHandler(async (req, res) => {
    const status = z.enum(["active", "superseded", "discarded", "all"]).optional().parse(req.query.status);
    res.json({ memories: await projectMemoryService.list(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), { status }) });
  }),
);

projectsRouter.post(
  "/:projectId/memories",
  requireIdentity,
  requireWorkspaceRole("author"),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        kind: z.enum(MEMORY_KINDS),
        body: z.string().min(1).max(500),
        source: z.enum(MEMORY_SOURCES).optional(),
        sourceChatId: z.string().uuid().nullish(),
        sourceMessageId: z.string().max(64).nullish(),
      })
      .strict()
      .parse(req.body ?? {});
    const memory = await projectMemoryService.create(req.params.workspaceId!, req.params.projectId!, await viewerOf(req), { subject: req.user!.subject }, body);
    res.status(201).json({ memory });
  }),
);

projectsRouter.post(
  "/:projectId/memories/propose",
  requireIdentity,
  asyncHandler(async (req, res) => {
    await projectMemoryService.list(req.params.workspaceId!, req.params.projectId!, await viewerOf(req));
    const body = z
      .object({
        messages: z.array(z.object({ role: z.string(), text: z.string() })).max(200).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    res.json({ candidates: pickMemoryCandidates(body.messages ?? [], 3) });
  }),
);

projectsRouter.patch(
  "/:projectId/memories/:memoryId",
  requireIdentity,
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(["superseded", "discarded"]) }).strict().parse(req.body ?? {});
    const memory = await projectMemoryService.setStatus(
      req.params.workspaceId!,
      req.params.projectId!,
      req.params.memoryId!,
      await viewerOf(req),
      status,
    );
    res.json({ memory });
  }),
);
