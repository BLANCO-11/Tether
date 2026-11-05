#!/usr/bin/env node
/**
 * Open one of the workspace's Files (Resources → Files, catalogue `files[]`) to look at while you build.
 *
 *   node tools/open-file.mjs "<file name>"
 *   node tools/open-file.mjs --project "<file name>"   a file of this chat's project (named in each message)
 *
 * Saves a copy as `workspace-files/<file name>` (or `project-files/<file name>`) and prints that path. Read it with Python like any file (pandas,
 * openpyxl, python-docx, pypdf). The copy is for looking only: a workflow still opens the file at run time with
 * `foundry.file("<file name>")`, and changing the copy changes nothing in Files.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const project = args[0] === "--project";
const name = (project ? args.slice(1) : args).join(" ").trim();
if (!name) {
  console.error('Usage: node tools/open-file.mjs [--project] "<file name>"');
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Opening workspace files is not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/file`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify(project ? { name, project: true } : { name }),
});
if (!res.ok) {
  const text = await res.text();
  let why = text;
  try {
    const b = JSON.parse(text);
    why = b.message ?? (typeof b.error === "string" ? b.error : text);
  } catch {
    /* plain text */
  }
  console.error(`Not opened: ${why}`);
  process.exit(1);
}
const folder = project ? "project-files" : "workspace-files";
const dir = join(fileURLToPath(new URL("..", import.meta.url)), folder);
mkdirSync(dir, { recursive: true });
const path = join(dir, basename(name));
writeFileSync(path, Buffer.from(await res.arrayBuffer()));
console.log(`${folder}/${basename(name)}`);
