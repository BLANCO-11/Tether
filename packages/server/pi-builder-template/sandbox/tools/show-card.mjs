#!/usr/bin/env node
/**
 * Show a structured card in the chat (info list or ask choice) — Forge Agent.
 *
 *   node tools/show-card.mjs '<JSON card>'
 *   node tools/show-card.mjs @scratch/card.json
 *
 * Card shape (allowlisted):
 *   { "mode": "info"|"ask", "type": "list"|"choice", "title": "...", "subtitle"?: "...",
 *     "items": [{ "id", "title", "subtitle"?, "tone"?, "meta"? }, ...],
 *     "actions"?: [{ "id", "label", "style?", "itemId?", "payload?" }],  // info list; agent-defined, click resumes Forge
 *     "multi"?: true }  // choice only
 *
 * info never pauses the turn. ask (choice) pauses until the person picks and submits.
 * Prefer this over a prose bullet list when presenting an inventory or a pick.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [raw] = process.argv.slice(2);
if (!raw) {
  console.error(`Usage: node tools/show-card.mjs '<JSON card>'\n       node tools/show-card.mjs @scratch/card.json`);
  process.exit(2);
}
let card;
try {
  card = JSON.parse(raw.startsWith("@") ? readFileSync(resolve(raw.slice(1)), "utf8") : raw);
} catch {
  console.error("The card must be one JSON object.");
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Cards are not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/card`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify({ card }),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { message: text };
}
if (!res.ok) {
  console.error(`Card not shown: ${body.message ?? (typeof body.error === "string" ? body.error : null) ?? text}`);
  process.exit(1);
}
console.log(body.message);
