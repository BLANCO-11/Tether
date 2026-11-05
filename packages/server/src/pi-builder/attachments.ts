import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { confined, sandboxDir } from "./sandbox-fs.js";

/**
 * Files a person attaches to a workflow's chat — context for Forge while it builds (a sample report, a screenshot,
 * a spec). Stored exactly as uploaded; Forge reads them itself (`tools/read-file.mjs`, its read tool for images).
 * They are NOT used by the workflow at run time — that is the workspace's Files, a different feature.
 *
 * On disk they live in the session's own `sandbox/files/` — where Forge reads them. A file is uploaded there, and
 * copied into the chat's record in the database when a message sends it (`pi_chat_files`, 0095); a reopened chat lays
 * its files out there again. One unsent and then abandoned is gone with the session, like an unsent message.
 */

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * What may be attached: documents, sheets, images and text Forge can read. No presentations and no video (a product
 * decision, 2026-10-12). Older binary Office formats are refused by name, not accepted unread.
 */
export const ATTACHMENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export const OLD_OFFICE: Record<string, string> = { ".doc": ".docx" };

/**
 * What Forge may MAKE beyond what a person may attach: code and web files (a mock page, a script, a small project's
 * sources). Kept and served as `text/plain` — and only ever downloaded or shown as text, so a page Forge wrote can never
 * run on Foundry's origin. A person cannot attach these (attachments, and the workspace's Files, keep their own list).
 */
export const OUTPUT_TYPES: Record<string, string> = {
  ...ATTACHMENT_TYPES,
  ...Object.fromEntries(
    [".html", ".htm", ".css", ".scss", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".svg", ".py", ".sh", ".sql", ".toml", ".ini", ".java", ".kt", ".go", ".rs", ".rb", ".php", ".cs", ".c", ".h", ".cpp", ".swift"].map(
      (ext) => [ext, "text/plain"],
    ),
  ),
};

/** `removed`: the person removed it from the chat later; the message keeps its name, nothing can be downloaded. */
export type PiAttachment = { name: string; size: number; type: string; removed?: boolean };

function httpErr(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function storeDir(workspaceId: string, sessionId: string): string {
  return join(sandboxDir(workspaceId, sessionId), "files");
}

/** Where Forge puts a file it MADE or CHANGED for the person (`out/<name>`); kept with the chat after each turn. */
export function outDir(workspaceId: string, sessionId: string): string {
  return join(sandboxDir(workspaceId, sessionId), "out");
}

/** At most this many files made in one turn are kept — a loop writing hundreds is a fault, not a delivery. */
export const MAX_OUTPUTS_PER_TURN = 10;

/**
 * A name safe to keep as a file: no directories, no control characters, no leading dot, at most 120 characters with
 * the extension kept. An empty result is a refusal, never a made-up name.
 */
export function safeAttachmentName(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const ext = extname(base).toLowerCase();
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120 - ext.length);
  if (!stem) throw httpErr("The file needs a name.", 400);
  return stem + ext;
}

/** `report.pdf`, then `report (2).pdf` — an upload never replaces a file already attached under that name. */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const next = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, next))) return next;
  }
}

export function storeAttachment(workspaceId: string, sessionId: string, body: Buffer, rawName: string | null): PiAttachment {
  if (!rawName) throw httpErr("The file needs a name (x-file-name).", 400);
  const name = safeAttachmentName(rawName);
  const ext = extname(name).toLowerCase();
  if (OLD_OFFICE[ext]) throw httpErr(`${ext} files cannot be read here — save it as ${OLD_OFFICE[ext]} and attach that.`, 415);
  const type = ATTACHMENT_TYPES[ext];
  if (!type) {
    throw httpErr(`${ext || "A file with no extension"} cannot be attached. Attach documents (PDF, Word), sheets (Excel, CSV), images or text files.`, 415);
  }
  if (body.length === 0) throw httpErr("The file is empty.", 400);
  if (body.length > MAX_ATTACHMENT_BYTES) throw httpErr("The file is larger than 50 MB.", 413);
  const dir = storeDir(workspaceId, sessionId);
  mkdirSync(dir, { recursive: true });
  const finalName = uniqueName(dir, name);
  writeFileSync(join(dir, finalName), body, { flag: "wx" });
  return { name: finalName, size: body.length, type };
}

/** What is attached to this session, by name — the file must be a regular file inside the store. */
export function findAttachment(workspaceId: string, sessionId: string, name: string): PiAttachment | null {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) return null;
  const p = join(storeDir(workspaceId, sessionId), name);
  if (!existsSync(p)) return null;
  const st = lstatSync(p);
  if (!st.isFile() || !confined(p)) return null;
  return { name, size: st.size, type: ATTACHMENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream" };
}

export function removeAttachment(workspaceId: string, sessionId: string, name: string): boolean {
  if (!findAttachment(workspaceId, sessionId, name)) return false;
  unlinkSync(join(storeDir(workspaceId, sessionId), name));
  return true;
}

export function readAttachment(workspaceId: string, sessionId: string, name: string): Buffer | null {
  return findAttachment(workspaceId, sessionId, name) ? readFileSync(join(storeDir(workspaceId, sessionId), name)) : null;
}

const SAFE_NAME = (name: string) => !!name && !name.includes("/") && !name.includes("\\") && !name.startsWith(".");

/**
 * A file of this chat by name, as a workflow built here would read it: one Forge made (`out/`) first, else one the
 * person attached (`files/`). Null when neither has it.
 */
export function chatFileOnDisk(workspaceId: string, sessionId: string, name: string): { name: string; type: string; body: Buffer } | null {
  if (!SAFE_NAME(name)) return null;
  for (const dir of [outDir(workspaceId, sessionId), storeDir(workspaceId, sessionId)]) {
    const p = join(dir, name);
    if (existsSync(p) && lstatSync(p).isFile() && confined(p)) {
      return { name, type: OUTPUT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream", body: readFileSync(p) };
    }
  }
  return null;
}

/** What is in `out/` now: name → size and change time, to tell after a turn what Forge made or changed. */
export function outSnapshot(workspaceId: string, sessionId: string): Map<string, string> {
  const dir = outDir(workspaceId, sessionId);
  const seen = new Map<string, string>();
  // `out` itself could be a link out of the folder (Forge can make one): nothing is read through it.
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !confined(dir)) return seen;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isFile()) seen.set(name, `${st.size}:${st.mtimeMs}`);
  }
  return seen;
}

/**
 * Every chat file on disk now: the person's in `files/` and Forge's in `out/`. Compared at the end of a turn with the
 * names at its start, it says which files Forge deleted, so the chat's record forgets them too — without that, the
 * record kept them and laid them back out on the next open, and "I removed the old files" was untrue on screen.
 */
export function chatFileNames(workspaceId: string, sessionId: string): Set<string> {
  const names = new Set<string>();
  for (const dir of [storeDir(workspaceId, sessionId), outDir(workspaceId, sessionId)]) {
    // Either folder could be a link out of the conversation (Forge can make one): nothing is read through it.
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !confined(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!lstatSync(join(dir, name)).isDirectory()) names.add(name);
    }
  }
  return names;
}

/**
 * The files Forge made or changed in `out/` since `before`: those a chat can keep (OUTPUT_TYPES, up to 50 MB, at most
 * MAX_OUTPUTS_PER_TURN), and those it cannot, each with the reason in plain words.
 */
export function newOutputs(
  workspaceId: string,
  sessionId: string,
  before: Map<string, string>,
): { kept: Array<{ name: string; type: string; body: Buffer }>; refused: Array<{ name: string; why: string }> } {
  const kept: Array<{ name: string; type: string; body: Buffer }> = [];
  const refused: Array<{ name: string; why: string }> = [];
  const dir = outDir(workspaceId, sessionId);
  for (const [name, sig] of outSnapshot(workspaceId, sessionId)) {
    if (before.get(name) === sig) continue;
    const ext = extname(name).toLowerCase();
    const type = OUTPUT_TYPES[ext];
    const size = Number(sig.split(":")[0]);
    if (!SAFE_NAME(name)) continue;
    if (!type) refused.push({ name, why: `${ext || "a file with no extension"} is not a type a chat can keep` });
    else if (size === 0) refused.push({ name, why: "it is empty" });
    else if (size > MAX_ATTACHMENT_BYTES) refused.push({ name, why: "it is larger than 50 MB" });
    else if (kept.length >= MAX_OUTPUTS_PER_TURN) refused.push({ name, why: `only ${MAX_OUTPUTS_PER_TURN} files are kept from one reply` });
    else if (!confined(join(dir, name))) continue;
    else kept.push({ name, type, body: readFileSync(join(dir, name)) });
  }
  return { kept, refused };
}


/**
 * Lay a reopened chat's stored files out where Forge reads them: the person's in `files/`, Forge's own in `out/`. A
 * name already there is left as it is.
 */
export function layOutFiles(
  workspaceId: string,
  sessionId: string,
  files: Array<{ name: string; body: Buffer; origin?: string }>,
): void {
  const person = files.filter((f) => f.origin !== "forge");
  const made = files.filter((f) => f.origin === "forge");
  writeInto(storeDir(workspaceId, sessionId), person);
  writeInto(outDir(workspaceId, sessionId), made);
}

function writeInto(dir: string, files: Array<{ name: string; body: Buffer }>): void {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    if (!f.name || f.name.includes("/") || f.name.includes("\\") || f.name.startsWith(".")) continue;
    const p = join(dir, f.name);
    if (!existsSync(p)) writeFileSync(p, f.body);
  }
}

/**
 * The folders the OLD layout kept a workflow's chat files in (`<root>/<ws>/_attachments/flow-<id>/`), before chats
 * were saved in the database. Read once at start, moved into each workflow's chat, then removed.
 */
export function legacyAttachmentFolders(root: string): Array<{ workspaceId: string; flowId: string; dir: string; files: string[] }> {
  const out: Array<{ workspaceId: string; flowId: string; dir: string; files: string[] }> = [];
  if (!existsSync(root)) return out;
  for (const ws of readdirSync(root)) {
    const att = join(root, ws, "_attachments");
    if (ws.startsWith("_") || !existsSync(att)) continue;
    for (const scope of readdirSync(att)) {
      const dir = join(att, scope);
      if (!scope.startsWith("flow-") || !statSync(dir).isDirectory()) continue;
      out.push({ workspaceId: ws, flowId: scope.slice(5), dir, files: readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()) });
    }
  }
  return out;
}

export function removeLegacyAttachmentRoot(root: string, workspaceId: string): void {
  rmSync(join(root, workspaceId, "_attachments"), { recursive: true, force: true });
}
