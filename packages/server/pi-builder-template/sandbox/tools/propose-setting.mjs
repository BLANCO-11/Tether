#!/usr/bin/env node
/**
 * PROPOSE switching a connected service's action on or off — Forge Agent, while answering (2026-10-28).
 *
 *   node tools/propose-setting.mjs <service> <action> on "<why, in a line>"
 *   node tools/propose-setting.mjs <service> <action> off "<why, in a line>"
 *
 * <service> is a name from tools/connector-actions.mjs ("azure-devops"), <action> its action name
 * ("create_or_update_file") or its tool name. Nothing changes: the person sees a card saying what it allows and
 * through whose connection, and chooses "for me" (every Forge Agent chat of theirs here) or "the whole workspace" —
 * or cancels.
 */
import { readFileSync } from "node:fs";

const [service, action, state, reason = ""] = process.argv.slice(2);
if (!service || !action || !["on", "off"].includes(state ?? "") || !reason.trim()) {
  console.error(`Usage: node tools/propose-setting.mjs <service> <action> on|off "<why, in a line>"`);
  process.exit(2);
}
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Connected services are not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/propose-setting`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify({ service, action, on: state === "on", reason }),
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
