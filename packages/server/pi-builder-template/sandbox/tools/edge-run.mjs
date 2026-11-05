#!/usr/bin/env node
/**
 * Queue a job on a paired edge device (personal Foundry).
 *
 *   node tools/edge-run.mjs <deviceId> run_command '<shell command>'
 *   node tools/edge-run.mjs <deviceId> read_path '<absolute path>'
 *   node tools/edge-run.mjs <deviceId> write_path '<absolute path>' '<contents>'
 *
 * Returns as soon as the job is queued. Do NOT poll in a loop — Background
 * watches the job and the chat gets the result. Approve cards still appear
 * for non-allowlisted run_command / write_path.
 */
import { readFileSync } from "node:fs";

const [deviceId, kind, a, b] = process.argv.slice(2);
const kinds = new Set(["run_command", "read_path", "write_path"]);
if (!deviceId || !kind || !kinds.has(kind)) {
  console.error(`Usage:
  node tools/edge-run.mjs <deviceId> run_command '<command>'
  node tools/edge-run.mjs <deviceId> read_path '<path>'
  node tools/edge-run.mjs <deviceId> write_path '<path>' '<contents>'`);
  process.exit(2);
}

let payload = {};
if (kind === "run_command") {
  if (!a?.trim()) {
    console.error("Command is required.");
    process.exit(2);
  }
  payload = { command: a };
} else if (kind === "read_path") {
  if (!a?.trim()) {
    console.error("Path is required.");
    process.exit(2);
  }
  payload = { path: a };
} else {
  if (!a?.trim()) {
    console.error("Path is required.");
    process.exit(2);
  }
  payload = { path: a, contents: b ?? "" };
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Edge devices are not available in this conversation.");
  process.exit(1);
}

const res = await fetch(`${cfg.url}/edge/enqueue`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify({ deviceId, kind, payload }),
});
const text = await res.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  data = { message: text };
}
if (!res.ok) {
  console.error(data.message ?? data.error ?? text);
  process.exit(1);
}
console.log(data.message);
console.log(`job ${data.job.id} status=${data.job.status}`);
if (data.job.needsApproval) {
  console.log(">>> Tell them once, briefly: Approve the card in this chat. Foundry continues automatically after that — do not ask them to say okay.");
} else {
  console.log(">>> Foundry continues this chat when the job finishes. Do not poll edge-job; do not ask them to say okay.");
}
process.exit(0);
