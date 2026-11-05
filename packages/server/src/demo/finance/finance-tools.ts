/**
 * The tools a Finance workspace can call.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 *
 * The seven `hr_*` tools. They are HTTP endpoints over the `hr_demo` database,
 * and registering them here would let a Finance flow read another tenant's
 * employee directory over the network — a cross-tenant read that no datasource
 * boundary would catch, because it does not go through a datasource. The
 * separate `finance_ro` role stops Finance reaching HR's data by SQL; leaving
 * these out is the same boundary on the tool side.
 *
 * That absence has a cost worth stating rather than hiding: `bearer` is the auth
 * style the HR directory service uses, and it is therefore the one style Finance
 * does not exercise. Finance uses `header` (mail, ticketing, llm), `query`
 * (chat) and `basic` (probe). Inventing a Finance directory service purely to
 * reach four-out-of-four would be building a service to satisfy a checklist.
 *
 * ── WHY NOT JUST FILTER `demoToolCatalogue()` ────────────────────────────────
 *
 * Because the descriptions are the interface. `chat_post_message` lists the HR
 * channels and `mail_send_template` lists the HR templates; a Finance drafter
 * reading those writes a flow that 404s or 422s. The tool NAMES and URLs are the
 * same endpoints — same services, same credentials, same auth styles — and only
 * the prose a model reads differs. `finance-tools.test.ts` asserts that overlap
 * so the two catalogues cannot drift into pointing at different places.
 */
import type { z } from "zod";
import { config } from "../../config/index.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, type OpsService } from "../../services/ops-client.service.js";
import type { createToolSchema } from "../../services/tool.service.js";
import { isPlatformToolName } from "../../services/platform-tool-names.js";

type ToolSpec = z.input<typeof createToolSchema>;

const auth = (service: OpsService) => ({
  secretEnvName: OPS_SECRET_ENV[service],
  authStyle: OPS_AUTH_STYLE[service].style,
  authParamName: OPS_AUTH_STYLE[service].paramName ?? undefined,
});

const p = (type: string, required: boolean, description: string) => ({ type, required, description });

/** Which ops-api services a Finance workspace holds a credential for. */
export const FINANCE_OPS_SERVICES: OpsService[] = ["mail", "chat", "ticketing", "probe", "llm"];

export function financeToolCatalogue(): ToolSpec[] {
  const b = config.opsApiBase;
  const tools: ToolSpec[] = [
    // ── Email ───────────────────────────────────────────────────────────────
    {
      name: "mail_send",
      ...auth("mail"),
      method: "POST",
      url: `${b}/mail/send`,
      description:
        "Send one email. Returns {message_id, status, accepted[], rejected[], bounce_reason}. " +
        "status is 'sent' (201) or 'bounced' (202) — a 202 means NOTHING was delivered, so read " +
        "status/rejected rather than treating any 2xx as success. One vendor in this workspace " +
        "has no accounts-payable address at all (never pass a null recipient) and one is on a " +
        "domain that always hard-bounces; both need reporting by another channel rather than " +
        "counting as chased.",
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)"),
        recipients: p("array", true, "One address or an array of up to 50"),
        cc: p("array", false, "Optional cc addresses (e.g. the cost centre owner)"),
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
        "Send an email from a named template, so wording stays consistent. Finance templates: " +
        "'invoice_chase' (to the vendor; needs vendor_name, invoice_number, due_date, " +
        "days_past_due, outstanding), 'expense_over_policy' (to the approver; needs " +
        "approver_name, employee_name, claim_code, category, amount, limit, over_by), " +
        "'budget_variance' (to the cost centre owner; needs owner_name, cost_centre_name, " +
        "period, actual, budget, variance, commentary). Missing variables return 422 listing " +
        "exactly which. " +
        "⚠ Every amount variable is a preformatted STRING and the template divides nothing — " +
        "money in this workspace is stored in minor units (cents) and must be converted before " +
        "it reaches a recipient.",
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)"),
        recipients: p("array", true, "One address or an array"),
        cc: p("array", false, "Optional cc addresses"),
        template: p("string", true, "invoice_chase | expense_over_policy | budget_variance"),
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
        "List postable chat channels. Returns an ENVELOPE {total, channels[]} — read the " +
        "`channels` key, it is not a bare array. Call this before posting rather than guessing; " +
        "an unknown channel returns 404.",
      paramsSchema: {},
    },
    {
      name: "chat_post_message",
      ...auth("chat"),
      method: "POST",
      url: `${b}/chat/messages`,
      description:
        "Post a message to a chat channel. The finance channels are #finance-ops (month-end and " +
        "budget reporting) and #ap-alerts (overdue invoices and payables exceptions); " +
        "#compliance also exists for policy breaches. The leading # is optional. 404 for any " +
        "other channel.",
      paramsSchema: {
        channel: p("string", true, "Channel name, e.g. #ap-alerts"),
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
        "Open a ticket and return its ticket_key. One call opens one ticket — batch the detail " +
        "into its description rather than calling this once per invoice.",
      paramsSchema: {
        title: p("string", true, "Short summary"),
        description: p("string", false, "Detail, e.g. the full list of overdue invoices"),
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
        "Update a ticket by ticket_key. At least one of status, priority, assignee, description " +
        "is required. status: open | in_progress | resolved | closed. 404 for an unknown key.",
      paramsSchema: {
        key: p("string", true, "Ticket key (path parameter)"),
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
        "Returns an ENVELOPE {total, tickets[]} — read the `tickets` key, not a bare array. " +
        "Newest first, optionally filtered by status.",
      paramsSchema: {
        status: p("string", false, "open | in_progress | resolved | closed"),
        limit: p("integer", false, "1-200, default 50"),
      },
    },

    // ── Text generation ─────────────────────────────────────────────────────
    //
    // ⚠ Non-deterministic, and its output is TERMINAL (D-34). It earned that
    // rule on a Finance-shaped task: a digest whose figures were all correct
    // ranked two departments in an order its own numbers contradicted. In this
    // workspace the temptation is sharper — "which of these invoices look
    // suspicious" is exactly the question it must not be asked, because the
    // answer would be consumed by a chase.
    {
      name: "llm_complete",
      ...auth("llm"),
      method: "POST",
      url: `${b}/llm/complete`,
      description:
        "Transform text with a language model: give it an INSTRUCTION in plain English and the " +
        "INPUT to work on, and it returns {text} — prose or markdown. Use it to summarise, " +
        "rephrase or draft: a covering note on a variance report, a written commentary on " +
        "figures a previous step already computed.\n" +
        "IMPORTANT: the output is NOT deterministic and NOTHING downstream may read it. Do not " +
        "ask it to classify an invoice, decide who to chase, judge whether a claim is " +
        "reasonable, total anything, extract fields, or return JSON — it is instructed to " +
        "refuse structured output, and a step that parses this will work in testing and fail in " +
        "production. Use a code or transform step for anything a later step consumes, and never " +
        "put it on a path that decides whether money moves.\n" +
        "It also sources nothing: it cannot fetch, browse, run code or call other tools, so it " +
        "must not be asked for a figure that is not in the input. " +
        "422 output_truncated means the answer hit max_tokens mid-sentence. 429 means the " +
        "per-minute budget is spent; a step fanning out over a large array will hit that.",
      paramsSchema: {
        instruction: p(
          "string",
          true,
          'What to do with the input, e.g. "write two short paragraphs of commentary on this variance for the cost centre owner"',
        ),
        input: p(
          "string",
          true,
          "The text to work on — typically the previous step's output. May be empty (a period with nothing to report is a valid input).",
        ),
        model: p("string", false, "Optional; must be one the operator enabled. Defaults to the configured model."),
        max_tokens: p("integer", false, "1-4000, default 600. 422 if the answer is cut off."),
      },
    },
    // A platform tool (`llm_complete`, the email tool) is registered for every workspace by
    // `registerPlatformTools`; a demo catalogue never writes one.
  ];
  return tools.filter((t) => !isPlatformToolName(t.name));
}
