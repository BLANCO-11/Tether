import type { z } from "zod";
import { config } from "../config/index.js";
import {
  OPS_AUTH_STYLE,
  OPS_SECRET_ENV,
  type OpsService,
} from "../services/ops-client.service.js";
import type { createToolSchema } from "../services/tool.service.js";
import type { ParamFormat } from "../services/param-descriptor.js";
import { isPlatformToolName } from "../services/platform-tool-names.js";

// The zod INPUT type, not CreateToolInput (which is the post-parse output and so
// has isActive already defaulted and therefore required).
type ToolSpec = z.input<typeof createToolSchema>;

/**
 * The 14 operational tools, registered against `ops-api` on :4004, plus
 * `http_request` — a fixed-URL generic POST with no credential (see its entry).
 *
 * Every operational one is a REAL HTTP endpoint over real SQL (`packages/ops-api`),
 * so wrong parameters produce visibly wrong answers.
 *
 * These entries used to carry an explicit `isDummy: false` to distinguish them from
 * the alternative — a tool whose response came from `routes/stubs.ts`, which could
 * only interpolate request fields into a fixed template and therefore returned one
 * shape however it was called. That alternative is deleted: nothing in the repo ever
 * created such a tool, so the flag had exactly one value everywhere it appeared.
 *
 * ── AUTHENTICATION: the 14 operational tools, in four styles (Stage 5) ──────
 *
 * Eleven of these were keyless until Stage 5. The reason given was that one
 * broken credential should not take the whole demo down, and that was a
 * reasonable trade while they were routes inside the parent process. It is the
 * wrong trade for a service on its own port, and it left the credential path
 * exercised by three tools out of fourteen.
 *
 * Now every operational tool carries `secretEnvName` + `authStyle`, and the five
 * between them use ALL FOUR styles — `bearer`, `header`, `query`, `basic`. That
 * spread is the point, not variety for its own sake: each service accepts
 * exactly one style and rejects the others even when the value is correct, so
 * "the automation authenticated the wrong way" is a distinguishable outcome
 * (`auth_ok: false` with the style it used) rather than something absorbed. An
 * endpoint accepting every style cannot detect a wrong guess.
 *
 * The env-var NAME is the single identifier: it is what `workspace_secrets`
 * stores, what the manifest renders as `<auth env=…>`, and what the executor
 * looks up. One name, so the manifest, the registration and the endpoint cannot
 * disagree. The values are derived — see `opsServiceKey`.
 *
 * An earlier version of this comment recorded a defect as the reason for
 * keylessness: manifest-builder rendered `tools.secretEnvName` as `<secretRef>`
 * while `execution.service.ts` injected only DATASOURCE secrets, so a tool with
 * a secret produced a script that KeyError'd at execution. That defect was fixed
 * in WS-B.1/B.2 and `execution.service.ts` no longer exists at all.
 */

const base = () => config.opsApiBase;

/**
 * The auth fields for one service, from the single table that also configures
 * ops-api's side. Spread into a tool entry rather than written out per tool, so
 * the fourteen registrations cannot individually drift from the five endpoints.
 */
const auth = (service: OpsService) => ({
  secretEnvName: OPS_SECRET_ENV[service],
  authStyle: OPS_AUTH_STYLE[service].style,
  authParamName: OPS_AUTH_STYLE[service].paramName ?? undefined,
});

/**
 * Shorthand for a param descriptor. `format` is the machine-readable value
 * shape (`month` | `date` | `datetime` | `text`); absent means unconstrained
 * prose and never blocks. Only pass a format grounded in the reader that
 * enforces it — prose-only guesses stay absent.
 */
const p = (type: string, required: boolean, description: string, format?: ParamFormat) => ({
  type,
  required,
  description,
  ...(format ? { format } : {}),
});

export function demoToolCatalogue(): ToolSpec[] {
  const b = base();
  const tools: ToolSpec[] = [
    // ── HR Directory ────────────────────────────────────────────────────────
    {
      name: "hr_list_employees",
      ...auth("hr"),
      method: "GET",
      url: `${b}/hr/employees`,
      description:
        "List employees with optional filters. Returns {total, limit, offset, returned, has_more, employees[]}. " +
        "Each employee carries department, office, region and inlined manager name/email. " +
        "work_email is NULL for contractors — handle that rather than emailing 'None'. " +
        "Paginated: check has_more and page with offset; the default limit is 50, max 200.",
      paramsSchema: {
        department: p("string", false, "Department code, e.g. ENG, SLS, SUP, FIN, HR, MKT, LEG"),
        region: p("string", false, "One of AMER, EMEA, APAC"),
        office: p("string", false, "Office code, e.g. NYC, AUS, LON, BER, BLR, SIN"),
        status: p("string", false, "One of active, on_leave, exited"),
        employment_type: p("string", false, "One of full_time, part_time, contractor"),
        manager_id: p("integer", false, "Only direct reports of this employee id"),
        has_email: p("string", false, "'false' returns only employees whose work_email IS NULL"),
        q: p("string", false, "Case-insensitive substring match on name or email"),
        limit: p("integer", false, "1-200, default 50"),
        offset: p("integer", false, "0-10000, default 0"),
      },
    },
    {
      name: "hr_get_employee",
      ...auth("hr"),
      method: "GET",
      url: `${b}/hr/employees/{id}`,
      description:
        "Fetch one employee by numeric id, with department, office and inlined manager. 404 if no such employee.",
      paramsSchema: { id: p("integer", true, "Employee id (path parameter)") },
    },
    {
      name: "hr_get_manager",
      ...auth("hr"),
      method: "GET",
      url: `${b}/hr/employees/{id}/manager`,
      description:
        "Fetch an employee's manager. Returns 200 with manager:null (plus a reason) for the CEO, " +
        "who is the root of the hierarchy — that is NOT an error and must not be treated as one. " +
        "404 only when the employee id itself does not exist.",
      paramsSchema: { id: p("integer", true, "Employee id (path parameter)") },
    },
    {
      name: "hr_list_departments",
      ...auth("hr"),
      method: "GET",
      url: `${b}/hr/departments`,
      description:
        "Returns an ENVELOPE {total, departments[]} — read the `departments` key, not a bare array. " +
        "Each entry has active_headcount, total_headcount, cost_centre, and the applicable " +
        "min_attendance_rate (the department override if has_department_override is true, else the " +
        "org-wide default). One department has zero employees. Use this instead of hardcoding a threshold.",
      paramsSchema: {},
    },
    {
      name: "hr_list_offices",
      ...auth("hr"),
      method: "GET",
      url: `${b}/hr/offices`,
      description:
        "Returns an ENVELOPE {total, offices[]} — read the `offices` key, not a bare array. Each entry " +
        "has city, country, region, timezone and active_headcount. One office has a single occupant.",
      paramsSchema: {},
    },
    {
      name: "hr_attendance_summary",
      ...auth("hr"),
      method: "GET",
      url: `${b}/hr/attendance/summary`,
      description:
        "Returns an ENVELOPE {period, counts{}, note, employees[], excluded[]} — read `employees` and " +
        "`excluded`, neither is a bare array. Monthly attendance vs the applicable policy " +
        "threshold, per employee — the primary read for " +
        "attendance screening. Each row has attendance_rate and min_attendance_rate as PERCENTAGES " +
        "(0-100), below_threshold, shortfall_pct, and the employee's manager inlined (so you do NOT " +
        "need a second call per employee). Employees who must not be actioned are returned separately " +
        "in excluded[], each with an exclusion_reason (approved_medical_leave, exited, on_leave) — " +
        "report them, do not email them. counts{} gives evaluated / below_threshold / excluded / " +
        "unreachable_no_email. Reports each employee's min_attendance_rate and below_threshold (computed against policy_thresholds org default 80% / Engineering 85%); a specific percentage in the goal (e.g. 80%) should be evaluated by reading those fields in a transform, not by a threshold parameter.",
      // ── Param formats: `periodParam`/`dateParam` in
      // `packages/ops-api/src/routes/ops.ts` are the semantic reference for
      // these shapes (YYYY-MM for `period`, YYYY-MM-DD for `from`/`to`) — that
      // file enforces them and no regex is duplicated here. Every other param
      // in this catalogue is prose-only, so its format stays absent
      // (unconstrained, never blocking) rather than guessed.
      paramsSchema: {
        period: p("string", false, "YYYY-MM; defaults to the current demo period 2026-06", "month"),
        below_threshold_only: p("string", false, "'true' returns only employees under threshold"),
        department: p("string", false, "Department code filter"),
        region: p("string", false, "One of AMER, EMEA, APAC"),
        limit: p("integer", false, "1-500, default 200"),
      },
    },
    {
      name: "hr_attendance_daily",
      ...auth("hr"),
      method: "GET",
      url: `${b}/hr/attendance/daily`,
      description:
        "Returns an ENVELOPE {employee_id, from, to, total, note, days[]} — read the `days` key. " +
        "Per-day attendance for one employee over an optional date range. status 'present' and 'wfh' " +
        "both count as attended; 'absent' and 'leave' do not; 'holiday' is not a working day. " +
        "Use for drilling into a flagged employee, not for bulk screening.",
      paramsSchema: {
        employee_id: p("integer", true, "Employee id"),
        from: p("string", false, "YYYY-MM-DD inclusive", "date"),
        to: p("string", false, "YYYY-MM-DD inclusive", "date"),
      },
    },

    // ── Email ───────────────────────────────────────────────────────────────
    {
      name: "mail_send",
      ...auth("mail"),
      method: "POST",
      url: `${b}/mail/send`,
      description:
        // ⚠ The `SIMULATED` prefix is the cheapest defence available against the
        // drafter picking this instead of `foundry_email_send`, which delivers for
        // real. The two read like they do the same job and one of them delivers
        // nothing; the difference has to be in the first four words, because a
        // caveat at the end of a paragraph is a caveat a model may not weight.
        "SIMULATED (demo mail service — nothing is delivered). " +
        "Send one email. Returns {message_id, status, accepted[], rejected[], bounce_reason}. " +
        "status is 'sent' (201) or 'bounced' (202) — a 202 means NOTHING was delivered, so check " +
        "status/rejected rather than assuming a 2xx is success. Never pass a null recipient.",
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)"),
        recipients: p("array", true, "One address or an array of up to 50"),
        cc: p("array", false, "Optional cc addresses (e.g. the employee's manager)"),
        subject: p("string", true, "Subject line"),
        body: p("string", true, "Plain-text body"),
        attachments: p("array", false, "Up to 10 {filename, contentType, content} objects"),
      },
    },
    {
      name: "mail_send_template",
      ...auth("mail"),
      method: "POST",
      url: `${b}/mail/send-template`,
      description:
        // See the note on `mail_send` above — same reason, same prefix.
        "SIMULATED (demo mail service — nothing is delivered). " +
        "Send an email from a named template, so wording stays consistent. Templates: " +
        "'attendance_warning' (to the employee; needs full_name, period, attendance_rate, " +
        "min_attendance_rate, department_name), 'manager_escalation' (to the manager; needs " +
        "manager_name, full_name, period, attendance_rate, min_attendance_rate), 'general_update' " +
        "(needs full_name, subject, message). Missing variables return 422 listing exactly which.",
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)"),
        recipients: p("array", true, "One address or an array"),
        cc: p("array", false, "Optional cc addresses"),
        template: p("string", true, "attendance_warning | manager_escalation | general_update"),
        variables: p("object", true, "Template variables; 422 lists any that are missing"),
      },
    },

    // ── Chat ────────────────────────────────────────────────────────────────
    {
      name: "chat_list_channels",
      ...auth("chat"),
      method: "GET",
      url: `${b}/chat/channels`,
      description:
        "List postable chat channels. Returns an ENVELOPE {total, channels[]} — read the `channels` " +
        "key, it is not a bare array. Each entry has name, topic and members. Call this before " +
        "posting rather than guessing a channel name; an unknown channel returns 404.",
      paramsSchema: {},
    },
    {
      name: "chat_post_message",
      ...auth("chat"),
      method: "POST",
      url: `${b}/chat/messages`,
      description:
        "Post a message to a chat channel. Known channels: #hr-ops, #hr-announcements, #eng-leads, " +
        "#compliance (the leading # is optional). 404 for any other channel.",
      paramsSchema: {
        channel: p("string", true, "Channel name, e.g. #hr-ops"),
        text: p("string", true, "Message text"),
        author: p("string", false, "Display name; defaults to foundry-automation"),
        blocks: p("array", false, "Optional rich blocks"),
      },
    },

    // ── Ticketing ───────────────────────────────────────────────────────────
    {
      name: "ticket_create",
      ...auth("ticketing"),
      method: "POST",
      url: `${b}/tickets`,
      description:
        "Open a ticket and return its ticket_key (e.g. HR-1001). One call opens one ticket — " +
        "batch the detail into its description rather than calling this once per row.",
      paramsSchema: {
        title: p("string", true, "Short summary"),
        description: p("string", false, "Detail, e.g. the full list of flagged employees"),
        priority: p("string", false, "low | normal | high | urgent (default normal)"),
        assignee: p("string", false, "Email address of the assignee"),
        labels: p("array", false, "Optional string labels"),
      },
    },
    {
      name: "ticket_update",
      ...auth("ticketing"),
      method: "PATCH",
      url: `${b}/tickets/{key}`,
      description:
        "Update a ticket by ticket_key. At least one of status, priority, assignee, description is " +
        "required. status: open | in_progress | resolved | closed. 404 for an unknown key.",
      paramsSchema: {
        key: p("string", true, "Ticket key, e.g. HR-1001 (path parameter)"),
        status: p("string", false, "open | in_progress | resolved | closed"),
        priority: p("string", false, "low | normal | high | urgent"),
        assignee: p("string", false, "Email address"),
        description: p("string", false, "Replacement description"),
      },
    },
    {
      name: "ticket_search",
      ...auth("ticketing"),
      method: "GET",
      url: `${b}/tickets`,
      description:
        "Returns an ENVELOPE {total, tickets[]} — read the `tickets` key, not a bare array. Newest " +
        "first, optionally filtered by status.",
      paramsSchema: {
        status: p("string", false, "open | in_progress | resolved | closed"),
        limit: p("integer", false, "1-200, default 50"),
      },
    },

    // ── Text generation ─────────────────────────────────────────────────────
    //
    // ⚠ The fifteenth tool, and the first NON-DETERMINISTIC one. Everything
    // above computes an actual answer, which is what lets the oracle say
    // "right" rather than "ran". Read the header comment on `POST /llm/complete`
    // in `packages/ops-api/src/routes/ops.ts` before using it for anything: the
    // rule is that its output is TERMINAL — prose a human reads — and never
    // load-bearing. Nothing downstream may parse it, branch on it, or count
    // things in it. A flow that needs a decision uses a `code` or `transform`
    // step, which is deterministic and re-runnable to the same answer.
    //
    // The description says all of that to the drafter as well, because the
    // drafter is the thing most likely to reach for it as a cheap parser.
    {
      name: "llm_complete",
      ...auth("llm"),
      method: "POST",
      url: `${b}/llm/complete`,
      description:
        "Transform text with a language model: give it an INSTRUCTION in plain English and the " +
        "INPUT to work on, and it returns {text} — prose or markdown of any length. Use it to " +
        "summarise, rephrase, explain or draft: an email body, a chat update, a written report of " +
        "something a previous step already computed. " +
        "BOTH 'instruction' and 'input' are REQUIRED — omitting either is a 400 and the step will not run. " +
        "'input' MUST be wired from a previous step's output, e.g. {{ json(outputs.fetch.employees) }} or " +
        "{{ json(outputs.fetch.body).results[0].data | jq('map({name, rate}) | tostring | @json') | first }} — " +
        "do NOT omit it, do NOT invent data, and do NOT pass a bare instruction string as input. " +
        "'instruction' is REQUIRED — plain English of what to do with that input, e.g. \"summarise these findings in two short paragraphs for an email\".\n" +
        "IMPORTANT: the output is NOT deterministic and NOTHING downstream may read it. Do not ask " +
        "it to classify, decide, count, extract fields, choose recipients, or return JSON — it is " +
        "instructed to refuse structured output, and a step that parses this will work in testing " +
        "and fail in production. Use a code or transform step for anything a later step consumes. " +
        "It also sources nothing: it cannot fetch, browse, run code or call other tools, and it " +
        "must not be asked for facts that are not in the input. " +
        "422 output_truncated means the answer hit max_tokens mid-sentence — raise it rather than " +
        "using a partial document. 429 means the per-minute budget is spent; a step fanning out " +
        "over a large array will hit that.",
      paramsSchema: {
        instruction: p(
          "string",
          true,
          'What to do with the input, e.g. "summarise these findings in two short paragraphs for an email"',
        ),
        input: p(
          "string",
          true,
          "The text to work on — typically the previous step's output. May be empty (a period with nothing to report is a valid input).",
        ),
        model: p("string", false, "Optional; must be one the operator enabled. Defaults to the configured model."),
        max_tokens: p(
          "integer",
          false,
          "Output ceiling. Too low TRUNCATES and returns 422 rather than a half-written answer, so size it for the document you asked for.",
        ),
      },
    },

    // ── Generic HTTP ──────────────────────────────────────────────────────
    //
    // ⚠ Fixed-URL boundary: a tool's URL is fixed and fingerprinted
    // (`manifest-builder.service.ts`), so this is one specific callable, not a
    // URL-every-time node. A generic URL-as-parameter HTTP node is a model
    // change and out of scope — override via HTTP_REQUEST_URL at seed time.
    // It carries no credential (`authStyle: null`): whatever it posts to must
    // accept an unauthenticated call.
    {
      name: "http_request",
      secretEnvName: null,
      authStyle: null,
      authParamName: null,
      method: "POST",
      url: process.env.HTTP_REQUEST_URL ?? "https://httpbin.org/post",
      description:
        "POST a JSON body to one fixed URL (an echo endpoint by default). " +
        "Returns whatever that endpoint returns. The URL is fixed at seed time, " +
        "not per call — there is no url parameter. Extra per-step inputs " +
        "(query params, additional body fields) merge into the call.",
      paramsSchema: {
        body: p("object", true, "JSON body to send"),
      },
    },
    // A platform tool (`llm_complete`, the email tool) is registered for every workspace by
    // `registerPlatformTools`; a demo catalogue never writes one.
  ];
  return tools.filter((t) => !isPlatformToolName(t.name));
}
