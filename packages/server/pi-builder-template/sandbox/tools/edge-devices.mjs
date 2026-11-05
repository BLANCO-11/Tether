#!/usr/bin/env node
/**
 * List the person's paired edge devices (personal Foundry).
 *
 *   node tools/edge-devices.mjs
 */
import { readFileSync } from "node:fs";

let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Edge devices are not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/edge/devices`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: "{}",
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
const devices = body.devices ?? [];
if (!devices.length) {
  console.log("No paired devices. The person can set one up under Devices (copy the setup curl).");
  process.exit(0);
}
console.log(`${devices.length} device(s):`);
for (const d of devices) {
  const seen = d.lastSeenAt ? ` · seen ${d.lastSeenAt}` : " · never seen";
  console.log(`- ${d.name} (${d.id})${seen} [${d.status}]`);
}
