#!/usr/bin/env node
/**
 * The actions of the services this workspace is connected to, and where each is on — Forge Agent (2026-10-28).
 *
 *   node tools/connector-actions.mjs              every service you can reach, each action with on: workspace | me | off
 *   node tools/connector-actions.mjs azure-devops one service (any of its names), with each action's description and inputs
 *
 * A name that matches no connected service is answered with the services that ARE connected.
 *
 * An action that is "off" can be proposed for switching on with tools/propose-setting.mjs. "never" says why one can
 * never be switched on from chat (it deletes, or it is the raw API call).
 */
import { readFileSync } from "node:fs";

const [service] = process.argv.slice(2);
let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Connected services are not available in this conversation.");
  process.exit(1);
}
const res = await fetch(`${cfg.url}/actions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify(service ? { service } : {}),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { message: text };
}
const said = body.message ?? (typeof body.error === "string" ? body.error : null) ?? text;
// 404: no service by that name — the answer names the ones that ARE connected; say it as it is.
if (res.status === 404) {
  console.log(said);
  process.exit(0);
}
if (!res.ok) {
  console.error(`Could not list them: ${said}`);
  process.exit(1);
}
if (!body.services?.length) {
  console.log("Nothing is connected that you can use in this workspace.");
  process.exit(0);
}
console.log(JSON.stringify(body.services, null, 2));
