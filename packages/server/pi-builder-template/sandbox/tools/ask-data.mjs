#!/usr/bin/env node
/**
 * Ask the workspace's REAL data a question, read-only — assistant mode only (the server checks, every call).
 *
 *   node tools/ask-data.mjs <datasource> "SELECT …"
 *
 * One SELECT, against a datasource named in catalogue.json. Prints how many rows came back and up to 200 of them as
 * JSON. Every read is recorded in the workspace's audit log. In a workspace without assistant mode it says so and
 * reads nothing.
 */
import { readFileSync } from "node:fs";

const [datasource, ...rest] = process.argv.slice(2);
const sql = rest.join(" ").trim();
if (!datasource || !sql) {
  console.error('Usage: node tools/ask-data.mjs <datasource> "SELECT …"');
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Reading data is not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/data`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify({ datasource, sql }),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { message: text };
}
if (!res.ok) {
  const why = body.message ?? (typeof body.error === "string" ? body.error : null) ?? text;
  console.error(`Not read: ${why}`);
  process.exit(1);
}
console.log(`${body.total} row(s)${body.total > body.shown ? `; the first ${body.shown} are shown` : ""}`);
console.log(JSON.stringify(body.rows, null, 1));
