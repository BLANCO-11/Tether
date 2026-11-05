#!/usr/bin/env node
/**
 * Run a job on a paired edge device (personal Foundry).
 *
 *   node tools/edge-run.mjs <deviceId> run_command '<shell command>'
 *   node tools/edge-run.mjs <deviceId> read_path '<absolute path>'
 *   node tools/edge-run.mjs <deviceId> write_path '<absolute path>' '<contents>'
 *
 * Non-allowlisted run_command / write_path need Approve on the chat card (or Needs you / Devices).
 * This tool waits up to ~90s and prints status / result.
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

async function post(path, body) {
  const res = await fetch(`${cfg.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forge-token": cfg.token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  return { ok: res.ok, status: res.status, data };
}

const enq = await post("/edge/enqueue", { deviceId, kind, payload });
if (!enq.ok) {
  console.error(enq.data.message ?? enq.data.error ?? JSON.stringify(enq.data));
  process.exit(1);
}
console.log(enq.data.message);
console.log(`job ${enq.data.job.id} status=${enq.data.job.status}`);

if (enq.data.job.needsApproval) {
  console.log(">>> Tell the person once: Approve the card that just appeared in this chat.");
}

// Poll: short waits so we can print when still awaiting approval.
const deadline = Date.now() + 90_000;
let last = "";
while (Date.now() < deadline) {
  const wait = await post("/edge/job", { jobId: enq.data.job.id, waitMs: 15_000 });
  if (!wait.ok) {
    console.error(wait.data.message ?? wait.data.error ?? JSON.stringify(wait.data));
    process.exit(1);
  }
  const j = wait.data.job;
  const line = `${j.status}${j.needsApproval ? " (needs approval)" : ""}`;
  if (line !== last) {
    console.log(wait.data.message);
    last = line;
  }
  if (j.status === "succeeded") {
    console.log(JSON.stringify(j.result ?? {}, null, 2));
    process.exit(0);
  }
  if (j.status === "failed" || j.status === "revoked") {
    console.error(j.error ?? j.status);
    process.exit(1);
  }
  if (j.needsApproval) {
    // Keep waiting; person may approve mid-poll.
    continue;
  }
}
console.error("Timed out waiting for the edge agent. Is it running? Check Devices.");
process.exit(1);
