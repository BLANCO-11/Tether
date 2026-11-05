#!/usr/bin/env node
/**
 * Snapshot / restore sandbox workflow state (not fixtures, not context).
 *
 *   node scripts/snapshot.mjs take [label]
 *   node scripts/snapshot.mjs restore <id|latest>
 *   node scripts/snapshot.mjs list
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");
const SNAP_ROOT = join(SANDBOX, ".snapshots");

const TRACKED = ["workflow.json", "questions.json", "answers.json", "GOAL.md", "steps"];

export function snapDir(id) {
  return join(SNAP_ROOT, id);
}

export function latestId() {
  const p = join(SNAP_ROOT, "LATEST");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim() || null;
}

export function takeSnapshot(label = "") {
  mkdirSync(SNAP_ROOT, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomBytes(3).toString("hex")}`;
  const dest = snapDir(id);
  mkdirSync(dest, { recursive: true });
  for (const name of TRACKED) {
    const src = join(SANDBOX, name);
    if (!existsSync(src)) continue;
    const st = statSync(src);
    if (st.isDirectory()) cpSync(src, join(dest, name), { recursive: true });
    else cpSync(src, join(dest, name));
  }
  const meta = {
    id,
    label,
    createdAt: new Date().toISOString(),
    files: TRACKED.filter((n) => existsSync(join(dest, n))),
  };
  writeFileSync(join(dest, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  writeFileSync(join(SNAP_ROOT, "LATEST"), `${id}\n`);
  return meta;
}

export function restoreSnapshot(id = "latest") {
  const real = id === "latest" ? latestId() : id;
  if (!real) throw new Error("no snapshot to restore");
  const src = snapDir(real);
  if (!existsSync(join(src, "meta.json"))) throw new Error(`unknown snapshot: ${real}`);

  // Clear tracked targets then copy back
  for (const name of TRACKED) {
    const dest = join(SANDBOX, name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  }
  for (const name of TRACKED) {
    const from = join(src, name);
    if (!existsSync(from)) continue;
    const st = statSync(from);
    if (st.isDirectory()) cpSync(from, join(SANDBOX, name), { recursive: true });
    else cpSync(from, join(SANDBOX, name));
  }
  return JSON.parse(readFileSync(join(src, "meta.json"), "utf8"));
}

export function listSnapshots() {
  if (!existsSync(SNAP_ROOT)) return [];
  return readdirSync(SNAP_ROOT)
    .filter((n) => n !== "LATEST" && existsSync(join(SNAP_ROOT, n, "meta.json")))
    .map((id) => JSON.parse(readFileSync(join(SNAP_ROOT, id, "meta.json"), "utf8")))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function main() {
  const cmd = process.argv[2] || "list";
  try {
    if (cmd === "take") {
      const label = process.argv.slice(3).join(" ") || "";
      const meta = takeSnapshot(label);
      console.log(JSON.stringify(meta, null, 2));
      process.exit(0);
    }
    if (cmd === "restore") {
      const id = process.argv[3] || "latest";
      const meta = restoreSnapshot(id);
      console.log(`restored ${meta.id}${meta.label ? ` (${meta.label})` : ""}`);
      process.exit(0);
    }
    if (cmd === "list") {
      const rows = listSnapshots();
      const latest = latestId();
      for (const r of rows) {
        console.log(`${r.id === latest ? "*" : " "} ${r.id}  ${r.label || ""}`);
      }
      process.exit(0);
    }
    console.error("usage: snapshot.mjs take|restore|list");
    process.exit(2);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
