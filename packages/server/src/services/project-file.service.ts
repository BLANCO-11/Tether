/**
 * A project's FILES (0132) — documents its members share, which every chat in the project can open.
 *
 * Seen by the project's members and Admins only, like everything that lives in a project: the check is membership,
 * asked on every call, so removing somebody takes the files from them at once. Any member who builds may add one;
 * removing one is for whoever added it, the project's owner, or an Admin. The same types and 50 MB per-file limit as
 * workspace Files (`workspace-file.service.ts`), 500 MB per project, contents encrypted at rest. A name already taken
 * in the project is refused rather than replaced. Deleted with the project (there is no My space for a file to go to).
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { projectFiles, projects } from "../db/schema.js";
import { decryptBytes, encryptBytes } from "../utils/encryptor.js";
import { ATTACHMENT_TYPES, OLD_OFFICE, safeAttachmentName } from "../pi-builder/attachments.js";
import type { Viewer } from "./content-visibility.service.js";
import { MAX_WORKSPACE_FILE_BYTES } from "./workspace-file.service.js";

export const MAX_PROJECT_FILE_BYTES = MAX_WORKSPACE_FILE_BYTES;
export const MAX_PROJECT_FILES_TOTAL_BYTES = 500 * 1024 * 1024;

export type ProjectFileMeta = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedByEmail: string | null;
  createdAt: Date;
};

const meta = {
  id: projectFiles.id,
  name: projectFiles.name,
  contentType: projectFiles.contentType,
  sizeBytes: projectFiles.sizeBytes,
  uploadedBy: projectFiles.uploadedBy,
  uploadedByEmail: projectFiles.uploadedByEmail,
  createdAt: projectFiles.createdAt,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const httpErr = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** The project, if this person may see what is in it; NOT FOUND otherwise (a 403 would say it exists). */
async function projectFor(workspaceId: string, projectId: string, v: Viewer) {
  if (!UUID.test(projectId)) throw httpErr("No such project.", 404);
  const [p] = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
  if (!p || !(v.all || v.projects?.has(p.id))) throw httpErr("No such project.", 404);
  return p;
}

export const projectFileService = {
  /** The files, each saying whether this person may remove it. */
  async list(workspaceId: string, projectId: string, v: Viewer): Promise<Array<ProjectFileMeta & { canRemove: boolean }>> {
    const p = await projectFor(workspaceId, projectId, v);
    const rows = await db.select(meta).from(projectFiles).where(eq(projectFiles.projectId, p.id)).orderBy(asc(projectFiles.name));
    return rows.map((f) => ({ ...f, canRemove: v.all || (v.subject != null && (f.uploadedBy === v.subject || p.ownerSubject === v.subject)) }));
  },

  /**
   * A file opened by a CHAT that lives in the project (Forge's tools/open-file.mjs --project). No viewer: where the chat
   * lives is the access, read from its row on every call, so a chat moved out of the project can open nothing in it.
   */
  async readForChat(workspaceId: string, projectId: string, name: string): Promise<{ data: Buffer } | null> {
    const [row] = await db
      .select({ contentEnc: projectFiles.contentEnc })
      .from(projectFiles)
      .where(and(eq(projectFiles.workspaceId, workspaceId), eq(projectFiles.projectId, projectId), eq(projectFiles.name, name)))
      .limit(1);
    return row ? { data: decryptBytes(Buffer.from(row.contentEnc)) } : null;
  },

  async upload(
    workspaceId: string,
    projectId: string,
    v: Viewer,
    who: { subject: string; email: string | null },
    rawName: string | null,
    body: Buffer,
  ): Promise<ProjectFileMeta & { canRemove: boolean }> {
    const p = await projectFor(workspaceId, projectId, v);
    if (!rawName) throw httpErr("The file needs a name.", 400);
    let decoded = rawName;
    try {
      decoded = decodeURIComponent(rawName);
    } catch {
      /* the name as sent */
    }
    const name = safeAttachmentName(decoded);
    const ext = extname(name).toLowerCase();
    if (OLD_OFFICE[ext]) throw httpErr(`${ext} files cannot be read here — save it as ${OLD_OFFICE[ext]} and add that.`, 415);
    const contentType = ATTACHMENT_TYPES[ext];
    if (!contentType) {
      throw httpErr(`${ext || "A file with no extension"} cannot be stored. Add documents (PDF, Word), sheets (Excel, CSV), images or text files.`, 415);
    }
    if (body.length === 0) throw httpErr("The file is empty.", 400);
    if (body.length > MAX_PROJECT_FILE_BYTES) throw httpErr(`The file is ${mb(body.length)}; a file can be at most 50 MB.`, 413);
    const [{ used }] = await db
      .select({ used: sql<number>`coalesce(sum(${projectFiles.sizeBytes}), 0)::bigint` })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, p.id));
    if (Number(used) + body.length > MAX_PROJECT_FILES_TOTAL_BYTES) {
      throw httpErr(`This project's files would come to ${mb(Number(used) + body.length)}; the limit is 500 MB. Remove files you no longer need first.`, 413);
    }
    const taken = await db.select({ id: projectFiles.id }).from(projectFiles).where(and(eq(projectFiles.projectId, p.id), eq(projectFiles.name, name))).limit(1);
    if (taken.length) throw httpErr(`A file named "${name}" is already in this project. Remove it first, or rename the new one.`, 409);
    const [row] = await db
      .insert(projectFiles)
      .values({
        projectId: p.id,
        workspaceId,
        name,
        contentType,
        sizeBytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        contentEnc: encryptBytes(body),
        uploadedBy: who.subject,
        uploadedByEmail: who.email,
      })
      .returning(meta);
    return { ...row!, canRemove: true };
  },

  /** The file's bytes, by id or by name, for somebody who may see the project. */
  async read(workspaceId: string, projectId: string, v: Viewer, by: { id: string } | { name: string }): Promise<(ProjectFileMeta & { data: Buffer }) | null> {
    const p = await projectFor(workspaceId, projectId, v);
    if ("id" in by && !UUID.test(by.id)) return null;
    const [row] = await db
      .select({ ...meta, contentEnc: projectFiles.contentEnc })
      .from(projectFiles)
      .where(and(eq(projectFiles.projectId, p.id), "id" in by ? eq(projectFiles.id, by.id) : eq(projectFiles.name, by.name)))
      .limit(1);
    if (!row) return null;
    const { contentEnc, ...rest } = row;
    return { ...rest, data: decryptBytes(Buffer.from(contentEnc)) };
  },

  /** Remove one: whoever added it, the project's owner, or an Admin. */
  async remove(workspaceId: string, projectId: string, v: Viewer, fileId: string): Promise<void> {
    const p = await projectFor(workspaceId, projectId, v);
    if (!UUID.test(fileId)) throw httpErr("No such file in this project.", 404);
    const [f] = await db.select({ id: projectFiles.id, uploadedBy: projectFiles.uploadedBy }).from(projectFiles).where(and(eq(projectFiles.projectId, p.id), eq(projectFiles.id, fileId)));
    if (!f) throw httpErr("No such file in this project.", 404);
    const may = v.all || (v.subject != null && (f.uploadedBy === v.subject || p.ownerSubject === v.subject));
    if (!may) throw httpErr("Only whoever added this file, the project's owner, or an Admin can remove it.", 403);
    await db.delete(projectFiles).where(eq(projectFiles.id, f.id));
  },

  async countIn(projectId: string): Promise<number> {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(projectFiles).where(eq(projectFiles.projectId, projectId));
    return Number(n);
  },
};
