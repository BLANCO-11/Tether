#!/usr/bin/env node
/** Golden control: verify → run → oracle (no agent). */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function runNode(rel) {
  const r = spawnSync(process.execPath, [join(ROOT, rel)], {
    cwd: ROOT,
    encoding: "utf8",
  });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("=== CONTROL: verify ===");
runNode("verifier/verify.mjs");
console.log("=== CONTROL: run ===");
runNode("runner/run.mjs");
console.log("=== CONTROL: oracle ===");
runNode("oracle/check.mjs");
console.log("=== CONTROL PASS ===");
