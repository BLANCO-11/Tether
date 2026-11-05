/**
 * A chat file as something a page can show (2026-10-13): a sheet as a table, a Word document as its paragraphs.
 *
 * Images, PDFs and plain text are shown by the browser straight from the file; only formats a browser cannot open
 * come through here. A preview is bounded (rows, columns, characters) and says when it was cut, so a large file never
 * reads as complete. Nothing here executes the file: SheetJS parses the sheet, and a .docx is read as a zip of XML.
 */
import XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";

// Taken from the default export, which both SheetJS builds have (0.18.5 was CommonJS, where a named `CFB` import
// passed the tests and crashed the server at boot).
const { CFB, read, utils } = XLSX;

// ⚠ The code-page tables. xlsx 0.20 resolves to its ESM build, which — unlike 0.18.5's CommonJS one — does not load
// them, so a legacy file storing text in a code page (BIFF2–5 .xls, dBASE) loses characters: "€ café" in Windows-1252
// reads as " café". `file-preview.test.ts` pins it.
XLSX.set_cptable(cptable);

export const PREVIEW_ROWS = 200;
export const PREVIEW_COLS = 40;
export const PREVIEW_CHARS = 200_000;

export type FilePreview =
  | { kind: "table"; sheets: Array<{ name: string; rows: string[][]; totalRows: number; totalCols: number }> }
  | { kind: "text"; text: string; cut: boolean }
  | { kind: "none"; reason: string };

const SHEET_EXT = /\.(xlsx|xlsm|xls|ods|csv|tsv)$/i;

export function previewOf(name: string, body: Buffer): FilePreview {
  try {
    if (SHEET_EXT.test(name)) return sheetPreview(body, /\.tsv$/i.test(name));
    if (/\.docx$/i.test(name)) return docxPreview(body);
  } catch (e) {
    return { kind: "none", reason: `This file could not be read for a preview (${(e as Error).message}). Download it to open it.` };
  }
  return { kind: "none", reason: "There is no preview for this kind of file. Download it to open it." };
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function sheetPreview(body: Buffer, tsv: boolean): FilePreview {
  const wb = read(body, { type: "buffer", cellDates: true, ...(tsv ? { FS: "\t" } : {}) });
  const sheets = wb.SheetNames.slice(0, 20).map((name) => {
    const all = utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, blankrows: false, defval: "" });
    const totalCols = all.reduce<number>((n, r) => Math.max(n, r.length), 0);
    const rows = all.slice(0, PREVIEW_ROWS).map((r) => r.slice(0, PREVIEW_COLS).map(cell));
    return { name, rows, totalRows: all.length, totalCols };
  });
  return { kind: "table", sheets };
}

const XML_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A .docx's text: each paragraph on its own line, table cells separated by tabs. */
export function docxText(body: Buffer): string {
  const zip = CFB.read(body, { type: "buffer" });
  const doc = CFB.find(zip, "word/document.xml") ?? CFB.find(zip, "/word/document.xml");
  if (!doc?.content) throw new Error("it has no document body");
  const xml = Buffer.from(doc.content as Uint8Array).toString("utf8");
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
      e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : (XML_ENTITY[e] ?? m),
    )
    .replace(/\t\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function docxPreview(body: Buffer): FilePreview {
  const text = docxText(body);
  return text.length > PREVIEW_CHARS ? { kind: "text", text: text.slice(0, PREVIEW_CHARS), cut: true } : { kind: "text", text, cut: false };
}
