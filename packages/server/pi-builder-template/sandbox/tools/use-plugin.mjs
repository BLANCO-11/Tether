#!/usr/bin/env node
/**
 * Read from a connected service (a plugin tool in catalogue.json) — Forge Agent, while answering.
 *
 *   node tools/use-plugin.mjs <tool name> '<JSON params>'
 *
 * Only reads and searches run. A tool that changes something is refused by the server: propose it instead with
 * tools/propose-change.mjs (where the workspace allows it), and the person's click on the card runs it.
 */
import { readFileSync } from "node:fs";

const [tool, raw = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error(`Usage: node tools/use-plugin.mjs <tool name> '<JSON params>'`);
  process.exit(2);
}
let params;
try {
  params = JSON.parse(raw);
} catch {
  console.error("The params must be one JSON object, e.g. '{\"prefix\": \"reports/\"}'.");
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Connected services are not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/plugin`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify({ tool, params }),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { message: text };
}
if (!res.ok) {
  console.error(`Not done (${res.status}): ${body.message ?? (typeof body.error === "string" ? body.error : null) ?? text}`);
  process.exit(1);
}
if (body.via) console.log(`(through ${body.via})`);
console.log(JSON.stringify(body.result, null, 2).slice(0, 60_000));
