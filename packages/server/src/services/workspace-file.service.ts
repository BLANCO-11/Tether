/**
 * A workspace's FILES — see `workspaceFiles` in `db/schema.ts` for what they are and are not.
 *
 * What may be stored is exactly what may be attached in chat (`pi-builder/attachments.ts`): documents, sheets, images
 * and text — no presentations and no video. One rule for both, so a file a person can show Forge is a file a workflow
 * can read. 50 MB per file, 1 GB per workspace; a name already taken is refused rather than replaced, because a
 * running workflow reads the file by name.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { flowRevisions, flows, workspaceFiles } from "../db/schema.js";
import { decryptBytes, encryptBytes } from "../utils/encryptor.js";
import { ATTACHMENT_TYPES, OLD_OFFICE, safeAttachmentName } from "../pi-builder/attachments.js";

export const MAX_WORKSPACE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_WORKSPACE_FILES_TOTAL_BYTES = 1024 * 1024 * 1024;

export type WorkspaceFileMeta = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: Date;
};

function httpErr(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

const meta = {
  id: workspaceFiles.id,
  name: workspaceFiles.name,
  contentType: workspaceFiles.contentType,
  sizeBytes: workspaceFiles.sizeBytes,
  uploadedBy: workspaceFiles.uploadedBy,
  createdAt: workspaceFiles.createdAt,
};

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Every `file:<name>` a step lists in `uses`, anywhere in a Forge workflow (loops and branch paths included). */
export function filesUsedBy(model: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.uses)) for (const u of o.uses) if (typeof u === "string" && u.startsWith("file:")) out.add(u.slice(5));
      Object.values(o).forEach((x) => x && typeof x === "object" && visit(x));
    }
  };
  visit((model as { workflow?: unknown } | null)?.workflow ?? model);
  return [...out];
}

export const workspaceFileService = {
  async list(workspaceId: string): Promise<WorkspaceFileMeta[]> {
    return db.select(meta).from(workspaceFiles).where(eq(workspaceFiles.workspaceId, workspaceId)).orderBy(asc(workspaceFiles.name));
  },

  async upload(workspaceId: string, rawName: string | null, body: Buffer, uploadedBy: string | null): Promise<WorkspaceFileMeta> {
    if (!rawName) throw httpErr("The file needs a name.", 400);
    let decoded = rawName;
    try {
      decoded = decodeURIComponent(rawName);
    } catch {
      /* the name as sent */
    }
    const name = safeAttachmentName(decoded);
    const ext = extname(name).toLowerCase();
    if (OLD_OFFICE[ext]) throw httpErr(`${ext} files cannot be read here — save it as ${OLD_OFFICE[ext]} and upload that.`, 415);
    const contentType = ATTACHMENT_TYPES[ext];
    if (!contentType) {
      throw httpErr(`${ext || "A file with no extension"} cannot be stored. Upload documents (PDF, Word), sheets (Excel, CSV), images or text files.`, 415);
    }
    if (body.length === 0) throw httpErr("The file is empty.", 400);
    if (body.length > MAX_WORKSPACE_FILE_BYTES) throw httpErr(`The file is ${mb(body.length)}; a file can be at most 50 MB.`, 413);
    const [{ used }] = await db
      .select({ used: sql<number>`coalesce(sum(${workspaceFiles.sizeBytes}), 0)::bigint` })
      .from(workspaceFiles)
      .where(eq(workspaceFiles.workspaceId, workspaceId));
    if (Number(used) + body.length > MAX_WORKSPACE_FILES_TOTAL_BYTES) {
      throw httpErr(`This workspace's files would come to ${mb(Number(used) + body.length)}; the limit is 1 GB. Delete files you no longer need first.`, 413);
    }
    const taken = await db
      .select({ id: workspaceFiles.id })
      .from(workspaceFiles)
      .where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.name, name)))
      .limit(1);
    if (taken.length) throw httpErr(`A file named "${name}" already exists. Delete it first, or rename the new one.`, 409);
    const [row] = await db
      .insert(workspaceFiles)
      .values({
        workspaceId,
        name,
        contentType,
        sizeBytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        contentEnc: encryptBytes(body),
        uploadedBy,
      })
      .returning(meta);
    return row!;
  },

  /** The file's bytes, by id or by name, within this workspace only. */
  async read(workspaceId: string, by: { id: string } | { name: string }): Promise<(WorkspaceFileMeta & { data: Buffer }) | null> {
    if ("id" in by && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(by.id)) return null;
    const [row] = await db
      .select({ ...meta, contentEnc: workspaceFiles.contentEnc })
      .from(workspaceFiles)
      .where(and(eq(workspaceFiles.workspaceId, workspaceId), "id" in by ? eq(workspaceFiles.id, by.id) : eq(workspaceFiles.name, by.name)))
      .limit(1);
    if (!row) return null;
    const { contentEnc, ...rest } = row;
    return { ...rest, data: decryptBytes(Buffer.from(contentEnc)) };
  },

  async remove(workspaceId: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
    const gone = await db
      .delete(workspaceFiles)
      .where(and(eq(workspaceFiles.workspaceId, workspaceId), eq(workspaceFiles.id, id)))
      .returning({ id: workspaceFiles.id });
    return gone.length > 0;
  },

  /** Which workflows (by their working draft) use each file name. */
  async dependents(workspaceId: string): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const rows = await db
      .select({ id: flows.id, name: flows.name, model: flowRevisions.modelJson })
      .from(flows)
      .innerJoin(flowRevisions, and(eq(flowRevisions.flowId, flows.id), eq(flowRevisions.revision, flows.draftRevision)))
      .where(eq(flows.workspaceId, workspaceId));
    const out = new Map<string, Array<{ id: string; name: string }>>();
    for (const r of rows) for (const f of filesUsedBy(r.model)) out.set(f, [...(out.get(f) ?? []), { id: r.id, name: r.name }]);
    return out;
  },
};
