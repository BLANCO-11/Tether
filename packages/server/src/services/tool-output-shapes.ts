/**
 * The DECLARED output of every endpoint Foundry itself serves to flows (compiled-builder phase 2c, E0.7 G1).
 *
 * Keyed by METHOD + PATH TEMPLATE, never by tool name: the same endpoint is registered as a tool in many workspaces
 * under several catalogue files, and the shape is a property of the endpoint (one definition, D-249). A tenant's own
 * tool declares its shape as data (`tools.output_schema`), which wins over this registry.
 *
 * ⚠ Every shape is what reaches `.results[i].data`: the parsed response BODY (ops-api's `tool()` sends `body` only).
 * Nullability follows the SCHEMA and the route code, never a sample. Two wire facts that surprise:
 *   - Postgres `numeric` reaches JSON as a STRING through node-pg (`departments.min_attendance_rate`), while a value
 *     the route computes in JS is a number (`attendance/summary`'s rates).
 *   - `date` columns arrive as ISO strings.
 * ⚠ Checked against the live endpoints by `tool-output-contract.ts` (GET endpoints, every run) — a declaration that
 * drifts from what the endpoint returns fails there by path, instead of being believed.
 */
import type { OutputShape } from "@foundry/flow-edit";

const S = (extra: Partial<Extract<OutputShape, { type: "string" }>> = {}): OutputShape => ({ type: "string", ...extra });
const I: OutputShape = { type: "integer" };
const N: OutputShape = { type: "number" };
const B: OutputShape = { type: "boolean" };
const nul = (s: OutputShape): OutputShape => ({ ...s, nullable: true });
const opt = (s: OutputShape): OutputShape => ({ ...s, optional: true });
const obj = (fields: Record<string, OutputShape>): OutputShape => ({ type: "object", fields });
const arr = (items: OutputShape): OutputShape => ({ type: "array", items });

/** ops-api's EMPLOYEE_SELECT row; nullability from its table's NOT NULLs + the LEFT JOIN to the manager. */
const EMPLOYEE = obj({
  id: I, employee_code: S(), full_name: S(), work_email: nul(S({ format: "email" })), job_title: S(),
  employment_type: S(), status: S(), hire_date: S({ format: "date" }), exit_date: nul(S({ format: "date" })),
  department_code: S(), department_name: S(), cost_centre: S(), office_code: S(), office_city: S(), office_country: S(),
  region: S(), timezone: S(),
  // LEFT JOIN employees m: all three are NULL for the root of the hierarchy.
  manager_id: nul(I), manager_name: nul(S()), manager_email: nul(S({ format: "email" })),
});

const ATTENDANCE_ROW = obj({
  employee_id: I, employee_code: S(), full_name: S(), work_email: nul(S({ format: "email" })), department_code: S(),
  department_name: S(), office_code: S(), region: S(), period: S(), working_days: I, days_attended: I,
  attendance_rate: N, min_attendance_rate: N, below_threshold: B, shortfall_pct: N,
  manager: nul(obj({ employee_id: I, full_name: S(), work_email: nul(S({ format: "email" })) })),
});

const OPS_MAIL = obj({ message_id: S(), status: S(), accepted: arr(S({ format: "email" })), rejected: arr(S({ format: "email" })), bounce_reason: nul(S()) });

export const ENDPOINT_OUTPUT_SHAPES: Record<string, OutputShape> = {
  "GET /hr/employees": obj({ total: I, limit: I, offset: I, returned: I, has_more: B, employees: arr(EMPLOYEE) }),
  "GET /hr/employees/:id": EMPLOYEE,
  "GET /hr/employees/:id/manager": obj({ employee_id: I, employee_name: S(), manager: nul(EMPLOYEE), reason: opt(S()) }),
  "GET /hr/departments": obj({
    total: I,
    departments: arr(obj({ id: I, code: S(), name: S(), cost_centre: S(), active_headcount: I, total_headcount: I, min_attendance_rate: S(), has_department_override: B })),
  }),
  "GET /hr/offices": obj({ total: I, offices: arr(obj({ id: I, code: S(), city: S(), country: S(), region: S(), timezone: S(), active_headcount: I })) }),
  "GET /hr/attendance/summary": obj({
    period: S(),
    counts: obj({ evaluated: I, below_threshold: I, excluded: I, unreachable_no_email: I }),
    note: S(),
    employees: arr(ATTENDANCE_ROW),
    excluded: arr(ATTENDANCE_ROW),
  }),
  "POST /mail/send": OPS_MAIL,
  "POST /mail/send-template": obj({ ...(OPS_MAIL as { fields: Record<string, OutputShape> }).fields, template: S() }),
  "GET /chat/channels": obj({ total: I, channels: arr(obj({ name: S(), topic: S(), members: I })) }),
  "POST /chat/messages": obj({ id: I, channel: S(), author: S(), posted_at: S({ format: "datetime" }), ok: B }),
  "POST /tickets": obj({ ticket_key: S(), id: I, title: S(), priority: S(), status: S(), assignee: nul(S()), created_at: S({ format: "datetime" }) }),
  "PATCH /tickets/:key": obj({ ticket_key: S(), status: S(), priority: S(), assignee: nul(S()), updated_at: S({ format: "datetime" }) }),
  "GET /tickets": obj({
    total: I,
    tickets: arr(obj({ ticket_key: S(), title: S(), description: nul(S()), priority: S(), status: S(), assignee: nul(S()), labels: nul(arr(S())), created_at: S({ format: "datetime" }), updated_at: S({ format: "datetime" }) })),
  }),
  "POST /paging/pages": obj({
    page_key: S(), dedupe_key: S(), target: nul(S()), severity: S(), status: S(), superseded_by: nul(S()),
    escalated_to: nul(S()), reason: nul(S()), paged_at: S({ format: "datetime" }),
  }),
  "POST /llm/complete": obj({ text: S(), model: S(), chars: I, finish_reason: nul(S()) }),
  // Foundry's own mail route: `captured` on a draft run, `sent` on a live one. Only the fields both carry are declared.
  "POST /api/mail/send": obj({ status: S(), message_id: opt(S()), message: opt(S()) }),
};

/** The path template a concrete URL path matches (`/hr/employees/42/manager` → `/hr/employees/:id/manager`), or null. */
function templateFor(method: string, path: string): string | null {
  const segs = path.replace(/\/+$/, "").split("/");
  for (const key of Object.keys(ENDPOINT_OUTPUT_SHAPES)) {
    const [m, tpl] = key.split(" ");
    if (m !== method.toUpperCase()) continue;
    const t = tpl!.split("/");
    if (t.length !== segs.length) continue;
    if (t.every((x, i) => x.startsWith(":") || x.startsWith("{") || x === segs[i])) return key;
  }
  return null;
}

/** The endpoint key (\`METHOD /path/template\`) a tool URL resolves to, or null — the same resolution the shapes use. */
export function endpointKeyFor(url: string | null | undefined, method: string | null | undefined): string | null {
  if (!url) return null;
  let path: string;
  try { path = new URL(url.replace(/\{[^}]+\}/g, "p")).pathname; } catch { return null; }
  return templateFor(method ?? "GET", path);
}

/**
 * The declared output of a tool, by the endpoint it calls. `url` may carry `{param}` placeholders; only the PATH is
 * matched, so the host (a deployment detail) does not matter. `null` when the endpoint is not one Foundry serves.
 */
export function outputShapeForEndpoint(url: string | null | undefined, method: string | null | undefined): OutputShape | null {
  if (!url) return null;
  let path: string;
  try { path = new URL(url.replace(/\{[^}]+\}/g, "p")).pathname; } catch { return null; }
  // Tool URLs for ops-api carry no `/api` prefix; Foundry's own routes do. Both are keyed as they are served.
  const key = templateFor(method ?? "GET", path);
  return key ? ENDPOINT_OUTPUT_SHAPES[key]! : null;
}
