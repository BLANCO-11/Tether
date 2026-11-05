/**
 * `POST /api/steps/files` — a running step saves a file (the Excel report it built) and gets back an id a tool call
 * can carry, so a large report travels as the step's own compact file rather than as rows inside a JSON body.
 *
 * Authorised by the execution token like every `/api/steps/*` route; the file is bound to that run and workspace
 * (`stepFileRepo.read`). Mounted ABOVE `/api/steps`, so the 5 MB step-call limit does not apply — this route has
 * its own, `config.steps.fileMaxBytes`.
 */
import express, { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { config } from "../config/index.js";
import { stepFileRepo } from "../repositories/step-file.repo.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";
import { piChatRepo } from "../repositories/pi-chat.repo.js";
import { workspaceFileService } from "../services/workspace-file.service.js";
import { refuseUndeclaredUse } from "../services/forge-uses.js";

export const stepFilesRouter = Router();

/** A plain file name: no folders, no control characters, no leading dot, at most 200 characters. */
export function stepFileName(raw: string | undefined): string | null {
  if (!raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  name = name.replace(/\\/g, "/").split("/").pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.startsWith(".") || name.length > 200) return null;
  return name;
}

stepFilesRouter.post(
  "/",
  express.raw({ type: () => true, limit: config.steps.fileMaxBytes }),
  asyncHandler(async (req, res) => {
    const { workspaceId, flowExecutionId } = req.stepAuth!;
    const name = stepFileName(req.header("x-file-name"));
    if (!name) return res.status(400).json({ error: "invalid_file", message: "the file needs a plain name (x-file-name)" });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.byteLength === 0) return res.status(400).json({ error: "invalid_file", message: `${name} is empty` });
    const stepId = req.header("x-step-id")?.slice(0, 200) ?? null;
    const saved = await stepFileRepo.create({ workspaceId, flowExecutionId, stepId, name, bytes: body });
    res.status(201).json({ file: saved.id, name: saved.name, bytes: saved.bytes });
  }),
);

/**
 * `GET /api/steps/files/workspace/:name` — a running step reads one of its WORKSPACE's files (Resources → Files), by
 * name. The workspace comes from the execution token, never the request. Which files a step may read is its `uses`
 * (`file:<name>`), held to that list here, not only by the step's library (forge-uses.ts).
 */
stepFilesRouter.get(
  "/workspace/:name",
  asyncHandler(async (req, res) => {
    const { workspaceId, flowExecutionId } = req.stepAuth!;
    // Only a file the workflow declares (`file:<name>`) — held here, not only by the step's library (forge-uses.ts).
    const refused = await refuseUndeclaredUse(flowExecutionId, { kind: "file", name: req.params.name! });
    if (refused) return res.status(403).json({ error: "undeclared_use", message: `Not allowed: ${refused}.` });
    // A TEST run started from a chat reads that chat's files first: the file the person attached (or Forge made) is
    // the one the workflow is being built against, and it is copied into Files when the workflow is saved.
    const chatId = ((await flowExecutionRepo.get(flowExecutionId))?.runnerJob as { chatId?: string } | null)?.chatId;
    if (chatId) {
      const chat = await piChatRepo.get(workspaceId, chatId);
      const [cf] = chat ? await piChatRepo.readFiles(chat.id, [req.params.name!]) : [];
      if (cf) {
        res.setHeader("content-type", cf.contentType);
        res.setHeader("content-length", String(cf.body.length));
        return res.end(cf.body);
      }
    }
    const f = await workspaceFileService.read(workspaceId, { name: req.params.name! });
    if (!f) {
      return res.status(404).json({
        error: "not_found",
        message: `There is no file named "${req.params.name}" in this workspace's Files${chatId ? " or in the chat this test came from" : ""}.`,
      });
    }
    res.setHeader("content-type", f.contentType);
    res.setHeader("content-length", String(f.data.length));
    res.end(f.data);
  }),
);
