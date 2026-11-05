/**
 * `tool-output-contract` — every DECLARED read-only endpoint, called, and its response checked against the declaration
 * (compiled-builder phase 2c). The declaration is only believed because this runs.
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/tool-output-contract.ts
 *
 * GET endpoints only: a POST has an effect (a captured mail, a chat post, a ticket, a page), and learning a shape is not
 * a reason to cause one. POST declarations are read from the route code; their contract is checked on a draft run.
 * Exits 1 on any violation, naming the path.
 */
import { checkOutputShape } from "@foundry/flow-edit";
import { opsServiceKey, OPS_AUTH_STYLE, type OpsService } from "../services/ops-client.service.js";
import { ENDPOINT_OUTPUT_SHAPES } from "../services/tool-output-shapes.js";

const CASES: Array<{ key: string; service: OpsService; path: string }> = [
  { key: "GET /hr/employees", service: "hr", path: "/hr/employees?limit=200" },
  { key: "GET /hr/employees/:id", service: "hr", path: "/hr/employees/2" },
  { key: "GET /hr/employees/:id/manager", service: "hr", path: "/hr/employees/2/manager" },
  { key: "GET /hr/employees/:id/manager", service: "hr", path: "/hr/employees/1/manager" }, // the root: manager null
  { key: "GET /hr/departments", service: "hr", path: "/hr/departments" },
  { key: "GET /hr/offices", service: "hr", path: "/hr/offices" },
  { key: "GET /hr/attendance/summary", service: "hr", path: "/hr/attendance/summary?period=2026-06" },
  { key: "GET /hr/attendance/summary", service: "hr", path: "/hr/attendance/summary?period=2026-04" }, // the empty case
  { key: "GET /chat/channels", service: "chat", path: "/chat/channels" },
  { key: "GET /tickets", service: "ticketing", path: "/tickets?limit=200" },
];

async function call(service: OpsService, path: string) {
  const a = OPS_AUTH_STYLE[service];
  const key = opsServiceKey(service);
  const url = new URL(`http://ops-api:4004${path}`);
  const headers: Record<string, string> = {};
  if (a.style === "bearer") headers.authorization = `Bearer ${key}`;
  else if (a.style === "header") headers[a.paramName!] = key;
  else if (a.style === "query") url.searchParams.set(a.paramName!, key);
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.json() };
}

let failures = 0;
for (const c of CASES) {
  const r = await call(c.service, c.path);
  const v = r.status === 200 ? checkOutputShape(r.body, ENDPOINT_OUTPUT_SHAPES[c.key]!) : [`HTTP ${r.status}`];
  console.log(`${v.length ? "VIOLATES" : "conforms"} ${c.key.padEnd(34)} ${c.path}${v.length ? `\n   ${v.slice(0, 8).join("\n   ")}` : ""}`);
  if (v.length) failures++;
}
// Negative control: a declaration made deliberately wrong must be refused, or "conforms" means nothing.
const wrong = { type: "object", fields: { total: { type: "string" } } } as const;
const ctl = checkOutputShape((await call("hr", "/hr/offices")).body, wrong as never);
console.log(ctl.length ? `CONTROL  a wrong declaration is refused: ${ctl[0]}` : "CONTROL FAILED: a wrong declaration conformed");
if (!ctl.length) failures++;
process.exit(failures ? 1 : 0);
