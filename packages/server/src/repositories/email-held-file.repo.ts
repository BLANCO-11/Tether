/**
 * A held message's attachments as files (`email_held_files`, migration 0098) — see the table's docblock.
 *
 * ⚠ Read back only by (workspace, message, position): an id alone opens nothing, and a message in another workspace is
 * never found, whatever is asked for.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailHeldFiles } from "../db/schema.js";
import { decryptBytes, encryptBytes } from "../utils/encryptor.js";

export type HeldFileMeta = { position: number; name: string; contentType: string; bytes: number };

export const emailHeldFileRepo = {
  /** Keep every attachment of a held message, in the order it carried them. */
  async saveAll(
    workspaceId: string,
    emailSendId: string,
    files: ReadonlyArray<{ name: string; contentType: string; data: Buffer }>,
  ): Promise<void> {
    if (!files.length) return;
    await db.insert(emailHeldFiles).values(
      files.map((f, position) => ({
        workspaceId,
        emailSendId,
        position,
        name: f.name.slice(0, 255),
        contentType: f.contentType.slice(0, 120),
        sizeBytes: f.data.byteLength,
        contentEnc: encryptBytes(f.data),
      })),
    );
  },

  /** What is held for these messages, without the content: `sendId → files`. */
  async metaFor(workspaceId: string, sendIds: string[]): Promise<Map<string, HeldFileMeta[]>> {
    const out = new Map<string, HeldFileMeta[]>();
    if (!sendIds.length) return out;
    const rows = await db
      .select({
        sendId: emailHeldFiles.emailSendId,
        position: emailHeldFiles.position,
        name: emailHeldFiles.name,
        contentType: emailHeldFiles.contentType,
        bytes: emailHeldFiles.sizeBytes,
      })
      .from(emailHeldFiles)
      .where(and(eq(emailHeldFiles.workspaceId, workspaceId), inArray(emailHeldFiles.emailSendId, sendIds)))
      .orderBy(asc(emailHeldFiles.position));
    for (const r of rows) {
      out.set(r.sendId, [...(out.get(r.sendId) ?? []), { position: r.position, name: r.name, contentType: r.contentType, bytes: r.bytes }]);
    }
    return out;
  },

  /** One held file, when this workspace's message holds it; otherwise null. */
  async read(
    workspaceId: string,
    emailSendId: string,
    position: number,
  ): Promise<{ name: string; contentType: string; body: Buffer } | null> {
    const [row] = await db
      .select({ name: emailHeldFiles.name, contentType: emailHeldFiles.contentType, contentEnc: emailHeldFiles.contentEnc })
      .from(emailHeldFiles)
      .where(
        and(
          eq(emailHeldFiles.workspaceId, workspaceId),
          eq(emailHeldFiles.emailSendId, emailSendId),
          eq(emailHeldFiles.position, position),
        ),
      )
      .limit(1);
    return row ? { name: row.name, contentType: row.contentType, body: decryptBytes(Buffer.from(row.contentEnc)) } : null;
  },
};
