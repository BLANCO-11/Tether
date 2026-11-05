/**
 * The tools an IT Operations workspace can call.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 *
 * The seven `hr_*` tools. They are HTTP endpoints over the `hr_demo` database,
 * and registering them here would let an IT Operations flow read another
 * tenant's employee directory over the network — a cross-tenant read that no
 * datasource boundary would catch, because it does not go through a datasource.
 * The separate `itops_ro` role stops this workspace reaching HR's, Finance's or
 * Legal's data by SQL; leaving these out is the same boundary on the tool side.
 *
 * ── ⚠ WHAT IS DELIBERATELY PRESENT, AND IT IS THE POINT OF THIS DOMAIN ──────
 *
 * `page_oncall`. Finance and Legal automate things that can wait: an invoice
 * chase, a renewal notice. IT operations is the first domain here where the
 * right answer at 03:00 is sometimes "wake a person up", and the whole reason
 * this domain is worth building is that the three arms of its branch are
 * genuinely different ACTIONS with genuinely different costs:
 *
 *     breached  page_oncall     — somebody's phone rings. The expensive one.
 *     at_risk   ticket_create   — it lands in a queue. Nobody is woken.
 *     healthy   chat_post_message / llm_complete — a digest somebody reads later.
 *
 * A demonstration where all three arms send an email with a different subject
 * line proves nothing about branching, because there is nothing at stake in
 * picking the wrong one. Here there is.
 *
 * ── ⚠ `page_oncall` IS THE ONLY TOOL IN THIS REPO THAT SUPPRESSES ITSELF ────
 *
 * A flow on a fifteen-minute schedule pages the same unresolved incident four
 * times an hour, and every one of those calls is correct in isolation. Real
 * paging services deduplicate; so does this one, on `dedupe_key`, within a
 * window. Two consequences the prose below has to carry, because the prose is
 * what a drafting model actually reads:
 *
 *   1. `dedupe_key` is REQUIRED and must be the incident code. A model that
 *      passes a timestamp, or the summary text, gets a distinct key every run
 *      and the suppression never fires — which looks like it working.
 *   2. The outcome is in the BODY, not the status code. `suppressed` and
 *      `no_responder` are 201s, because a 4xx would make a retry policy re-page,
 *      which is the exact behaviour suppression exists to prevent.
 *
 * ── WHY NOT JUST FILTER `legalToolCatalogue()` ──────────────────────────────
 *
 * Because the descriptions are the interface. `chat_post_message` lists the
 * channels and `mail_send_template` lists the templates; a model reading
 * Legal's prose inside an IT Operations workspace writes a flow that 404s or
 * 422s. The tool NAMES and URLs are the same endpoints — same services, same
 * credentials, same auth styles — and only the prose differs.
 * `itops-tools.test.ts` asserts that overlap so the catalogues cannot drift into
 * pointing at different places.
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

/**
 * Which ops-api services an IT Operations workspace holds a credential for.
 *
 * ⚠ `paging` is the one Finance and Legal do NOT hold, and that asymmetry is the
 * control: those two workspaces cannot wake anybody even with a hand-written
 * tool row, because they hold no `PAGING_API_TOKEN` and the endpoint 401s.
 *
 * ⚠ `hr` is deliberately absent, exactly as in Finance and Legal: this workspace
 * holds no `HR_DIRECTORY_TOKEN`, so even a hand-written tool row pointing at
 * `/hr/employees` returns 401 rather than another tenant's people. `probe` is
 * held and unused, mirroring Finance and Legal so the parity test in
 * `itops-tools.test.ts` compares two identical arrangements rather than two
 * different ones — if the unused credential ought to go, it goes from all three
 * in its own change.
 */
export const ITOPS_OPS_SERVICES: OpsService[] = ["mail", "chat", "ticketing", "probe", "llm", "paging"];

export function itopsToolCatalogue(): ToolSpec[] {
  const b = config.opsApiBase;
  const tools: ToolSpec[] = [
    // ── Paging ──────────────────────────────────────────────────────────────
    {
      name: "page_oncall",
      description:
        "Wake the on-call engineer. This is an interrupt, not a message: it is the most " +
        "expensive action available here and it is paid for by a person, so use it only for an " +
        "incident that has already breached its resolve budget. An incident that is merely at " +
        "risk goes to ticket_create instead — it still has time. " +
        "REPEATS ARE SUPPRESSED: pass the incident code as dedupe_key and a second page for the " +
        "same incident inside the window (60 minutes by default) is recorded and NOT delivered, " +
        "so a scheduled automation does not ring the same phone every time it runs. Pass the " +
        "INCIDENT CODE, never a timestamp or the summary text — a key that differs every run " +
        "suppresses nothing while appearing to work. " +
        "READ status IN THE RESPONSE: 'delivered' means somebody was woken; 'suppressed' means " +
        "they had already been told and superseded_by names the earlier page; 'no_responder' " +
        "means the address was undeliverable and NOBODY WAS WOKEN — which is an escalation, not " +
        "a warning to log. All three come back as a success, because a failure status would make " +
        "a retry re-page.",
      url: `${b}/paging/pages`,
      method: "POST",
      ...auth("paging"),
      paramsSchema: {
        target: p("string", true, "Address of the person to wake — the on-call engineer for the owning team."),
        dedupe_key: p("string", true, "The incident code, e.g. INC-1021. Repeats of this key inside the window are suppressed."),
        severity: p("string", false, "P1 | P2 | P3 | P4. Defaults to P2. The incident's own priority."),
        summary: p("string", true, "One line: what the person is being woken for. Include the service and what is broken."),
        escalation_target: p("string", false, "Where to escalate if the target is undeliverable. Without it, an undeliverable page wakes nobody at all."),
        dedupe_window_mins: p("number", false, "Suppression window in minutes, 0-1440. Defaults to 60. Leave it alone unless you have a reason."),
      },
    },
    {
      name: "page_search",
      description:
        "List pages already sent, most recent first. Use it to answer 'has anybody been told " +
        "about this yet' before deciding to page, and to show in a digest what the automation " +
        "actually did overnight. Filter by dedupe_key for one incident's history, or by status " +
        "to find the ones that woke nobody.",
      url: `${b}/paging/pages`,
      method: "GET",
      ...auth("paging"),
      paramsSchema: {
        dedupe_key: p("string", false, "Restrict to one incident code."),
        status: p("string", false, "delivered | suppressed | no_responder."),
        limit: p("number", false, "1-200, default 50."),
      },
    },

    // ── Ticketing ───────────────────────────────────────────────────────────
    {
      name: "ticket_create",
      description:
        "Raise a ticket in the queue the owning team works from. This is the middle arm: it " +
        "reaches somebody during working hours and wakes nobody, which is the right answer for " +
        "an incident at risk of breaching but not yet breached, and for remediation work that a " +
        "change freeze has deferred. Set assignee to the owning team's contact address.",
      url: `${b}/tickets`,
      method: "POST",
      ...auth("ticketing"),
      paramsSchema: {
        title: p("string", true, "One line, and name the incident or CVE in it so the ticket is findable."),
        description: p("string", false, "The detail: minutes consumed, budget, what was deferred and until when."),
        priority: p("string", false, "low | normal | high | urgent. Defaults to normal."),
        assignee: p("string", false, "An address. Usually the owning team's contact address, not an individual."),
        labels: p("array", false, "Free-form strings, e.g. the service code or the freeze name."),
      },
    },
    {
      name: "ticket_update",
      description:
        "Change an existing ticket's status, priority, assignee or description. Identified by " +
        "its ticket key, which ticket_create returned.",
      url: `${b}/tickets/{key}`,
      method: "PATCH",
      ...auth("ticketing"),
      paramsSchema: {
        key: p("string", true, "The ticket key, e.g. HR-1004."),
        status: p("string", false, "open | in_progress | resolved | closed."),
        priority: p("string", false, "low | normal | high | urgent."),
        assignee: p("string", false, "An address."),
        description: p("string", false, "Replacement description."),
      },
    },
    {
      name: "ticket_search",
      description:
        "List tickets, most recent first, optionally filtered by status. Use it to avoid " +
        "raising a second ticket for something already in the queue.",
      url: `${b}/tickets`,
      method: "GET",
      ...auth("ticketing"),
      paramsSchema: {
        status: p("string", false, "open | in_progress | resolved | closed."),
        limit: p("number", false, "1-200, default 50."),
      },
    },

    // ── Chat ────────────────────────────────────────────────────────────────
    {
      name: "chat_list_channels",
      description: "List the chat channels this workspace can post to, with their ids.",
      url: `${b}/chat/channels`,
      method: "GET",
      ...auth("chat"),
      paramsSchema: {},
    },
    {
      name: "chat_post_message",
      description:
        "Post a message to a chat channel. This is the quiet arm: nobody is woken and nobody " +
        "is assigned anything, which is the right answer for a healthy digest or a " +
        "freeze-deferral announcement. Two channels serve this workspace: #it-incidents for " +
        "service health, SLA digests and overnight summaries, and #it-changes for change " +
        "freezes, deferred remediation and release windows. Nothing posted to a channel wakes " +
        "anybody — if somebody needs waking, that is page_oncall.",
      url: `${b}/chat/messages`,
      method: "POST",
      ...auth("chat"),
      paramsSchema: {
        channel: p("string", true, "Channel id from chat_list_channels."),
        text: p("string", true, "The message. Include the counts a reader needs; do not make them open a link for the number."),
        author: p("string", false, "Display name; defaults to foundry-automation"),
        blocks: p("array", false, "Optional structured blocks."),
      },
    },

    // ── Email ───────────────────────────────────────────────────────────────
    {
      name: "mail_send",
      description:
        "Send an email. Appropriate for a scheduled report or a freeze announcement, and NOT " +
        "for a breach: an email does not wake anybody, so sending one where a page was needed " +
        "leaves the incident unattended while the run goes green. " +
        "Read the per-recipient status in the response — an address on a domain that hard-" +
        "bounces is reported as bounced, and reporting 'sent 12' without reading it is how an " +
        "automation claims work it did not do.",
      url: `${b}/mail/send`,
      method: "POST",
      ...auth("mail"),
      // ⚠ `sender` / `recipients`, NOT `from` / `to`. These are the endpoint's own
      // names and the parity test against the other three tenants is what caught
      // the first version of this file inventing `to`. A parameter name that
      // reads more naturally than the one the service accepts produces a flow
      // that drafts cleanly and 400s at run time.
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)."),
        recipients: p("array", true, "One address or an array of up to 50."),
        cc: p("array", false, "Optional cc addresses, e.g. the owning team's inbox."),
        subject: p("string", true, "Subject line."),
        body: p("string", true, "Plain-text body."),
        attachments: p("array", false, "Up to 10 {filename, contentType, content} objects."),
      },
    },
    {
      name: "mail_send_template",
      description:
        "Send an email from a stored template, filling its variables. Prefer this to mail_send " +
        "when a template fits: the wording is reviewed once instead of being regenerated per " +
        "run. Two templates serve this workspace: sla_at_risk_warning, for an incident that has " +
        "time left, and freeze_deferral_notice, for remediation a change freeze has postponed. " +
        "⚠ THERE IS DELIBERATELY NO TEMPLATE FOR A BREACH. A breach is a page, and an email does " +
        "not wake anybody — so use page_oncall and do not substitute a message for it. " +
        "Read the per-recipient status in the response, exactly as for mail_send.",
      url: `${b}/mail/send-template`,
      method: "POST",
      ...auth("mail"),
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)."),
        recipients: p("array", true, "One address or an array."),
        cc: p("array", false, "Optional cc addresses."),
        template: p("string", true, "sla_at_risk_warning | freeze_deferral_notice."),
        variables: p("object", true, "Template variables; a 422 lists any that are missing."),
      },
    },

    // ── Text ────────────────────────────────────────────────────────────────
    {
      name: "llm_complete",
      description:
        "Turn figures you already have into a paragraph a person can read. " +
        "⚠ ITS OUTPUT IS TERMINAL: put it at the END of a flow and let nothing downstream read " +
        "it. It returns prose, never JSON, and it must never be asked to decide anything — not " +
        "which incidents breached, not who to page, not whether a freeze applies. Every figure " +
        "in the text must come from a query or a code step that already computed it; this step " +
        "only words them. A digest whose numbers were all correct once ranked two teams in an " +
        "order its own numbers contradicted, which is why this rule exists.\n" +
        "It also sources nothing: it cannot fetch, browse, run code or call other tools, so it " +
        "must not be asked for a figure, a hostname or a deadline that is not in the input. " +
        "422 output_truncated means the answer hit max_tokens mid-sentence. 429 means the " +
        "per-minute budget is spent; a step fanning out over a large array will hit that.",
      url: `${b}/llm/complete`,
      method: "POST",
      ...auth("llm"),
      paramsSchema: {
        instruction: p(
          "string",
          true,
          'What to do with the input, e.g. "write three short sentences introducing this overnight service-health digest for the on-call handover"',
        ),
        input: p(
          "string",
          true,
          "The text to work on — typically the previous step's output. May be empty (a quiet night with nothing to report is a valid input).",
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
