/**
 * Files a running step saved (`step_files`) — see the table's docblock in `db/schema.ts`.
 *
 * ⚠ Read back only by (workspace, execution, id): a file id alone opens nothing. A step can attach what its own run
 * saved and nothing another run or workspace saved, whatever id it names.
 */
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { stepFiles } from "../db/schema.js";
import { decryptBytes, encryptBytes } from "../utils/encryptor.js";

/** How long a saved file is kept: long enough for the step that saved it, and a retry. */
export const STEP_FILE_TTL_MS = 24 * 60 * 60_000;

export const stepFileRepo = {
  async create(input: {
    workspaceId: string;
    flowExecutionId: string;
    stepId: string | null;
    name: string;
    bytes: Buffer;
  }): Promise<{ id: string; name: string; bytes: number }> {
    const [row] = await db
      .insert(stepFiles)
      .values({
        workspaceId: input.workspaceId,
        flowExecutionId: input.flowExecutionId,
        stepId: input.stepId,
        name: input.name,
        sizeBytes: input.bytes.byteLength,
        contentEnc: encryptBytes(input.bytes),
      })
      .returning({ id: stepFiles.id, name: stepFiles.name, bytes: stepFiles.sizeBytes });
    return row!;
  },

  /** The file's bytes, when this run in this workspace saved it; otherwise null. */
  async read(workspaceId: string, flowExecutionId: string, id: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const [row] = await db
      .select({ contentEnc: stepFiles.contentEnc })
      .from(stepFiles)
      .where(and(eq(stepFiles.id, id), eq(stepFiles.workspaceId, workspaceId), eq(stepFiles.flowExecutionId, flowExecutionId)))
      .limit(1);
    return row ? decryptBytes(Buffer.from(row.contentEnc)) : null;
  },

  /** Drop files older than the TTL. Returns how many went. */
  async sweep(now = Date.now()): Promise<number> {
    const gone = await db
      .delete(stepFiles)
      .where(lt(stepFiles.createdAt, new Date(now - STEP_FILE_TTL_MS)))
      .returning({ id: stepFiles.id });
    return gone.length;
  },
};
