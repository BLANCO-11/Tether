/**
 * Resources → Files: a workspace's files, which a workflow reads when it runs (`workspace-file.service.ts`).
 *
 *   GET    /                  the files, each with the workflows that use it
 *   POST   /                  upload one (raw body, `x-file-name`), 50 MB per file, 1 GB per workspace
 *   GET    /:fileId/content   download it
 *   DELETE /:fileId           delete it
 */
import express, { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { MAX_WORKSPACE_FILE_BYTES, workspaceFileService } from "../services/workspace-file.service.js";
import { refreshWorkspaceCatalogue } from "../pi-builder/catalogue-sync.js";

export const workspaceFilesRouter = Router({ mergeParams: true });

// Forge's catalogue lists the files; keep it current, and never let a refresh failure fail the request.
const refresh = (workspaceId: string) =>
  void refreshWorkspaceCatalogue(workspaceId).catch((e) => console.warn(`[files] catalogue refresh failed: ${(e as Error).message}`));

workspaceFilesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId!;
    const [files, used] = await Promise.all([workspaceFileService.list(ws), workspaceFileService.dependents(ws)]);
    res.json({ files: files.map((f) => ({ ...f, usedBy: used.get(f.name) ?? [] })) });
  }),
);

workspaceFilesRouter.post(
  "/",
  // The parser allows a little over the limit so the service, not the parser, refuses — with the size in words.
  express.raw({ type: () => true, limit: MAX_WORKSPACE_FILE_BYTES + 1024 * 1024 }),
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId!;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const file = await workspaceFileService.upload(ws, req.header("x-file-name") ?? null, body, req.user?.email ?? req.user?.name ?? null);
    refresh(ws);
    res.status(201).json({ file: { ...file, usedBy: [] } });
  }),
);

workspaceFilesRouter.get(
  "/:fileId/content",
  asyncHandler(async (req, res) => {
    const f = await workspaceFileService.read(req.params.workspaceId!, { id: req.params.fileId! });
    if (!f) return res.status(404).json({ error: "not_found", message: "No such file in this workspace." });
    res.setHeader("content-type", f.contentType);
    res.setHeader("content-length", String(f.data.length));
    res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.end(f.data);
  }),
);

workspaceFilesRouter.delete(
  "/:fileId",
  asyncHandler(async (req, res) => {
    const ws = req.params.workspaceId!;
    if (!(await workspaceFileService.remove(ws, req.params.fileId!))) {
      return res.status(404).json({ error: "not_found", message: "No such file in this workspace." });
    }
    refresh(ws);
    res.status(204).end();
  }),
);
