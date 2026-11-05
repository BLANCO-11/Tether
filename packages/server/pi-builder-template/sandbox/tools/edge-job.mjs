#!/usr/bin/env node
/**
 * Poll one edge job (personal Foundry).
 *
 *   node tools/edge-job.mjs <jobId> [waitMs]
 */
import { readFileSync } from "node:fs";

const [jobId, waitRaw] = process.argv.slice(2);
if (!jobId) {
  console.error("Usage: node tools/edge-job.mjs <jobId> [waitMs]");
  process.exit(2);
}
// Default 0: status peek only. Long waits block the chat turn — Background owns watching.
const waitMs = waitRaw != null ? Number(waitRaw) : 0;

let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Edge devices are not available in this conversation.");
  process.exit(1);
}

const res = await fetch(`${cfg.url}/edge/job`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify({ jobId, waitMs: Number.isFinite(waitMs) ? waitMs : 0 }),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { message: text };
}
if (!res.ok) {
  console.error(body.message ?? body.error ?? text);
  process.exit(1);
}
console.log(body.message);
console.log(JSON.stringify(body.job, null, 2));
process.exit(body.job?.status === "failed" ? 1 : 0);
