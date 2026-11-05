#!/usr/bin/env node
// Forge's reader for files a person attached to the chat (files/) — prints a file's text so it can be read.
//
//   node tools/read-file.mjs files/<name> [--from=<char>]
//
// The file itself is stored exactly as uploaded; this only reads it. PDF (unpdf), Word / PowerPoint /
// OpenDocument text (the XML inside the zip), Excel / OpenDocument sheets / CSV (each sheet as CSV), and plain
// text. Images are not text — open them with the read tool instead. Output is capped at LIMIT characters; a longer
// file says where to continue with --from.
import { readFileSync, statSync } from "node:fs";
import { extname, basename } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LIMIT = 40_000;

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
const from = Number((args.find((a) => a.startsWith("--from=")) ?? "--from=0").slice(7)) || 0;
if (!path) {
  console.error("usage: node tools/read-file.mjs files/<name> [--from=<char>]");
  process.exit(2);
}

const ext = extname(path).toLowerCase();
const buf = readFileSync(path);

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic"]);
const TEXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".yaml", ".yml", ".log", ".sql", ".py", ".js", ".ts"]);

/** The text of an XML document: paragraphs kept as lines, tags dropped, entities decoded. */
function xmlText(xml) {
  // Word and PowerPoint keep the words in text runs (<w:t>, <a:t>); everything else in the XML is layout — picture
  // offsets, sizes — and must not read as content. OpenDocument has no run element, so it keeps the tag strip.
  const run = xml.includes("<w:t") ? "w" : xml.includes("<a:t") ? "a" : null;
  if (run) {
    const tokens = new RegExp(`<${run}:t(?:\\s[^>]*)?>([^<]*)</${run}:t>|</${run}:p>|<${run}:(?:tab|br)\\/>`, "g");
    xml = (xml.match(tokens) ?? [])
      .map((t) => (t.startsWith(`</`) ? "</text:p>" : t.includes(":tab") ? "<text:tab/>" : t.includes(":br") ? "<text:line-break/>" : t))
      .join("");
  }
  return xml
    .replace(/<\/(w:p|a:p|text:p|text:h)>/g, "\n")
    .replace(/<(w:tab|text:tab)\/>/g, "\t")
    .replace(/<(w:br|a:br|text:line-break)\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Entries of a zip (docx/pptx/odt), via SheetJS's bundled reader. */
function zipEntries(b) {
  const XLSX = require("xlsx");
  const z = XLSX.CFB.read(b, { type: "buffer" });
  return z.FullPaths.map((p, i) => ({ path: p.replace(/^Root Entry\//, ""), file: z.FileIndex[i] }));
}

async function textOf() {
  if (IMAGES.has(ext)) {
    return `${basename(path)} is an image (${statSync(path).size} bytes) — open it with the read tool to see it.`;
  }
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const body = text.map((t, i) => `--- page ${i + 1} of ${totalPages} ---\n${t.trim()}`).join("\n\n");
    return body.replace(/---\n\s*(?=\n|$)/g, "---\n").trim() || `${basename(path)}: ${totalPages} page(s) with no text layer (a scan).`;
  }
  if (ext === ".docx" || ext === ".odt") {
    const want = ext === ".docx" ? /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/ : /^content\.xml$/;
    return zipEntries(buf)
      .filter((e) => want.test(e.path) && e.file?.content)
      .map((e) => xmlText(Buffer.from(e.file.content).toString("utf8")))
      .join("\n\n");
  }
  if (ext === ".pptx" || ext === ".odp") {
    const slides = zipEntries(buf)
      .filter((e) => (ext === ".pptx" ? /^ppt\/slides\/slide\d+\.xml$/ : /^content\.xml$/).test(e.path) && e.file?.content)
      .sort((a, b) => Number(a.path.match(/\d+/)?.[0] ?? 0) - Number(b.path.match(/\d+/)?.[0] ?? 0));
    return slides.map((e, i) => `--- slide ${i + 1} ---\n${xmlText(Buffer.from(e.file.content).toString("utf8"))}`).join("\n\n");
  }
  if ([".xlsx", ".xlsm", ".xls", ".ods"].includes(ext)) {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
    return wb.SheetNames.map((n) => `--- sheet "${n}" ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }).trim()}`).join("\n\n");
  }
  if (TEXT.has(ext) || !buf.subarray(0, 8000).includes(0)) return buf.toString("utf8");
  return `${basename(path)} is a binary file this reader cannot show (${buf.length} bytes).`;
}

const text = await textOf();
const part = text.slice(from, from + LIMIT);
process.stdout.write(part);
if (from + LIMIT < text.length) {
  process.stdout.write(`\n\n[… ${text.length - from - LIMIT} more characters — continue with --from=${from + LIMIT}]\n`);
} else {
  process.stdout.write("\n");
}
