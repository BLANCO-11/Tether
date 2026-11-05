/**
 * `reexpress-types` — the REAL input type of every source the phase-2 re-expression gate reads (compiled-builder 2d).
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/reexpress-types.ts [--write]
 *
 * The gate re-expresses the baseline's correct transforms as combinator pipelines. They must be typed against the types
 * the checker would really give their source — not types written by the person re-expressing them, who would pick the
 * convenient nullability. So this reads each source's type through the production path (`buildCatalogueSnapshot` +
 * `pipelineInputType`) in the workspace the baseline flow ran in, and compares it with the committed
 * `@foundry/flow-edit` fixture (`REEXPRESS_SOURCE_TYPES`). `--write` prints the JSON to commit. A drift exits 1, and so does
 * a source that is absent unless the gate declares its type (the six operations deleted after the baseline).
 * No model calls, nothing written to the deployment.
 */
import { pipelineInputType, REEXPRESS_SOURCE_TYPES, sameJson, sourceType } from "@foundry/flow-edit";
import { buildCatalogueSnapshot } from "../services/flow-typecheck.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";

/** Every source ref the 41 transforms read, with the workspace and step kind it was read as in the baseline. */
const SOURCES: Array<{ ref: string; workspace: string; kind: "datasource" | "tool" }> = [
  { ref: "hr_list_employees", workspace: "HR", kind: "tool" },
  { ref: "hr_demo.employee_directory", workspace: "HR", kind: "datasource" },
  { ref: "hr_demo.attendance_below_threshold", workspace: "HR", kind: "datasource" },
  { ref: "hr_demo.attendance_period_rows", workspace: "HR", kind: "datasource" },
  { ref: "hr_demo.department_attendance_rollup", workspace: "HR", kind: "datasource" },
  { ref: "hr_demo.flagged_unreachable", workspace: "HR", kind: "datasource" },
  { ref: "finance_demo.claims_over_policy", workspace: "Finance", kind: "datasource" },
  { ref: "legal_demo.contracts_expiring_no_autorenew", workspace: "Legal", kind: "datasource" },
  { ref: "legal_demo.contract_identity_counterparty_value_end", workspace: "Legal", kind: "datasource" },
  { ref: "itops_demo.vuln_finding_rows", workspace: "IT Operations", kind: "datasource" },
  { ref: "itops_demo.incidents_sla_at_risk", workspace: "IT Operations", kind: "datasource" },
  { ref: "itops_demo.incidents_sla_breached", workspace: "IT Operations", kind: "datasource" },
  { ref: "support_demo.tickets_breaching_resolve", workspace: "Customer Support", kind: "datasource" },
  { ref: "support_demo.csat_survey_rows", workspace: "Customer Support", kind: "datasource" },
  { ref: "support_demo.all_csat_responses", workspace: "Customer Support", kind: "datasource" },
  { ref: "support_demo.ticket_sla_rows", workspace: "Customer Support", kind: "datasource" },
  { ref: "orders_demo.orders_past_promised_date", workspace: "Orders & Fulfilment", kind: "datasource" },
  { ref: "orders_demo.open_order_line_rows", workspace: "Orders & Fulfilment", kind: "datasource" },
  { ref: "hiring_demo.offers_expiring_status", workspace: "Recruitment", kind: "datasource" },
  { ref: "hiring_demo.candidate_application_rows", workspace: "Recruitment", kind: "datasource" },
  { ref: "hiring_demo.applications_inactive_since", workspace: "Recruitment", kind: "datasource" },
  { ref: "hiring_demo.applications_prior_month", workspace: "Recruitment", kind: "datasource" },
];

const workspaces = (await workspaceRepo.list()).filter((w: { deletedAt: unknown }) => !w.deletedAt) as Array<{ id: string; name: string }>;
const live: Record<string, unknown> = {};
const missing: string[] = [];
const declared: string[] = [];
/** A source with no live type is acceptable only when the gate DECLARES its type (it was deleted after the baseline). */
const declaredOk = (ref: string) => { try { return sourceType(ref).declared; } catch { return false; } };
const cats = new Map<string, Awaited<ReturnType<typeof buildCatalogueSnapshot>>>();
for (const s of SOURCES) {
  const w = workspaces.find((x) => x.name === s.workspace);
  if (!w) { (declaredOk(s.ref) ? declared : missing).push(`${s.ref} (no workspace "${s.workspace}")`); continue; }
  if (!cats.has(w.id)) cats.set(w.id, await buildCatalogueSnapshot(w.id));
  const ty = pipelineInputType({ id: "src", kind: s.kind, ref: s.ref }, cats.get(w.id)!);
  if (!ty) { (declaredOk(s.ref) ? declared : missing).push(`${s.ref} (not in "${s.workspace}"'s catalogue)`); continue; }
  live[s.ref] = ty;
}
if (process.argv.includes("--write")) console.log(JSON.stringify(live, null, 1));
let drift = 0;
for (const [ref, ty] of Object.entries(live)) {
  const committed = (REEXPRESS_SOURCE_TYPES as Record<string, unknown>)[ref];
  if (!committed) { console.log(`NEW      ${ref}`); drift++; continue; }
  if (!sameJson(committed, ty)) { console.log(`DRIFT    ${ref}`); drift++; }
  else console.log(`same     ${ref}`);
}
for (const m of declared) console.log(`DECLARED ${m} — deleted after the baseline; the gate declares its type, every column nullable`);
for (const m of missing) console.log(`MISSING  ${m}`);
console.log(`\n${Object.keys(live).length} of ${SOURCES.length} sources typed live · ${declared.length} declared · ${drift} differ from the committed fixture · ${missing.length} missing`);
process.exit(drift || missing.length ? 1 : 0);
