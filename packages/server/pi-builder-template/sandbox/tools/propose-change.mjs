#!/usr/bin/env node
/**
 * PROPOSE a change to a connected service — Forge Agent, while answering (plugins phase 6).
 *
 *   node tools/propose-change.mjs <tool name> '<JSON params>' "<one line: what it does>"
 *   node tools/propose-change.mjs <tool name> '[<params>, <params>, …]' "<one line>"   (a batch: up to 25, one card)
 *   node tools/propose-change.mjs <tool name> @scratch/params.json "<one line>"         (the params read from a file)
 *
 * Use the @file form for large values, such as a file's content as base64: one command-line argument holds at most
 * about 128 KB.
 *
 * Nothing is performed. The server checks the tool and the values, and the person sees the change as a card under your
 * reply with "Do it" and "Cancel"; only their click runs it. A tool that deletes is never proposed from chat.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [tool, raw = "{}", summary = ""] = process.argv.slice(2);
if (!tool || !summary.trim()) {
  console.error(`Usage: node tools/propose-change.mjs <tool name> '<JSON params>' "<one line: what it does>"`);
  process.exit(2);
}
let params;
try {
  params = JSON.parse(raw.startsWith("@") ? readFileSync(resolve(raw.slice(1)), "utf8") : raw);
} catch {
  console.error("The params must be one JSON object, or a list of them for a batch, e.g. '{\"project\": \"Foundry\", \"work_item_id\": 2688}'.");
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Connected services are not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/propose`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify({ tool, params, summary }),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { message: text };
}
if (!res.ok) {
  console.error(`Not proposed: ${body.message ?? (typeof body.error === "string" ? body.error : null) ?? text}`);
  process.exit(1);
}
console.log(body.message);
