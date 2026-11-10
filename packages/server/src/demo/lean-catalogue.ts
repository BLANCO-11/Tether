/**
 * THE LEAN TOOL CATALOGUE — three tools per workspace, and why so few.
 *
 * ── THE COMPLAINT THIS ANSWERS ───────────────────────────────────────────────
 *
 * Measured on this deployment before the reset: HR held **17** tools, Finance
 * and Legal **9** each — 85 tool rows across 7 datasources — against **19**
 * named queries and exactly **one** DB operation. A tool's description is a
 * large share of what a drafting model is given, so a catalogue that size is
 * mostly noise competing for the model's attention, and several of the rows
 * were worse than noise:
 *
 *   `weather`      a live call to api.open-meteo.com from a demo tenant
 *   `flaky_probe`  an endpoint that fails on purpose, for a retry test
 *   `hr_*`  (×7)   HTTP endpoints reading `hr_demo` — a datasource was already
 *                  registered against the same database, so these are a second,
 *                  slower, uncheckable route to rows the datasource can read
 *
 * ── WHAT SURVIVES, AND WHAT REPLACES THE REST ────────────────────────────────
 *
 * Reading data is the datasource's job — a named query or a DB operation, which
 * is a structured form a model can fill in and a person can approve by reading
 * plain English. Tools are for the things a database cannot do: send something,
 * or turn figures into prose.
 *
 *   `test_email_send`     captured, never delivered. Visible in the Email box.
 *   `llm_complete`        figures in, one paragraph out. Terminal (D-34).
 *   `tether_email_send`  real delivery, and NOT defined here — it comes from
 *                         `platform-tool-catalogue.ts`, because it is a product
 *                         capability rather than demo data and must survive a
 *                         reseed.
 *
 * ⚠ **NO TICKETING AND NO CHAT.** Both existed and both were dropped on
 * request. The reasoning worth keeping is that they were the *cheap* arms of a
 * branch: offering "raise a ticket" beside "email the customer" lets a run go
 * green having done the thing nobody reads. With one delivery channel, a branch
 * has to decide whether to act at all, which is the decision worth watching.
 *
 * ⚠ **`ticket_create` etc. still EXIST in `generic/tools.ts` and
 * `finance-tools.ts`.** They are no longer called. Restoring one is a call site,
 * not a rewrite — which is why those files were left alone rather than gutted.
 */
import { config } from "../config/index.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, type OpsService } from "../services/ops-client.service.js";
import type { createToolSchema } from "../services/tool.service.js";
import type { z } from "zod";
import { isPlatformToolName } from "../services/platform-tool-names.js";

type ToolSpec = z.input<typeof createToolSchema>;

const auth = (service: OpsService) => ({
  secretEnvName: OPS_SECRET_ENV[service],
  authStyle: OPS_AUTH_STYLE[service].style,
  authParamName: OPS_AUTH_STYLE[service].paramName ?? undefined,
});

const p = (type: string, required: boolean, description: string) => ({ type, required, description });

/**
 * The ops-api services a lean workspace holds a credential for.
 *
 * ⚠ The ABSENCES are the control, not the catalogue. `paging` and
 * `HR_DIRECTORY_TOKEN` are missing here as they are from Finance and Legal, so
 * these workspaces cannot wake anybody or read HR's database even with a
 * hand-written tool row — the endpoint 401s. The refusal is at the service.
 * `ticketing` and `chat` are now absent for the same reason: a restored tool
 * row alone would not make either callable.
 */
/**
 * Per-domain wording for the two ACTION tools where the domain genuinely
 * changes the advice — the channel names and what the queue is for.
 *
 * ⚠ **Lifted here from `generic/tools.ts` on 2026-09-08 so there is ONE copy.**
 * The lean catalogue now serves these two tools as well, and a second table of
 * channel names is exactly the drift `demo/generic/tools.ts` already carries a
 * warning about: a description naming a channel `ops-api`'s `CHANNELS` does not
 * have is not a documentation slip — the call 404s at runtime, after the flow
 * has been authored, approved and armed, which is how all three generic demo
 * flows failed their first run. `generic/tools.ts` imports this.
 */
export type ActionWords = { channels: string; ticketQueue: string };

export const ACTION_WORDS: Record<string, ActionWords> = {
  support: {
    channels:
      "Two channels serve this workspace: #support-floor for shift digests and SLA warnings, " +
      "and #support-escalations for anything a team lead needs to see today.",
    ticketQueue:
      "Raise an internal follow-up in the support team's own queue — for a ticket nobody can be " +
      "nudged about automatically, or a customer who needs a call rather than an email.",
  },
  orders: {
    channels:
      "Two channels serve this workspace: #fulfilment for daily dispatch digests and stock " +
      "warnings, and #order-exceptions for orders past their promised date.",
    ticketQueue:
      "Raise a task for the warehouse or the account team — for an order that cannot be shipped, " +
      "or a customer with no email address who has to be phoned.",
  },
  finance: {
    channels:
      "Two channels serve this workspace: #finance-ops for month-end and routine digests, and " +
      "#ap-alerts for accounts-payable exceptions and overdue invoices.",
    ticketQueue:
      "Raise a task for the finance team — for an invoice that cannot be chased automatically, " +
      "or a vendor with no contact address.",
  },
  // The compiled-builder held-out domain (D-313). Same two-channel split: a routine digest vs an exception somebody must
  // act on today. ⚠ Both names must exist in ops-api's `CHANNELS`, or the call 404s after the flow is armed.
  fleet: {
    channels:
      "Two channels serve this workspace: #fleet-ops for shift digests and routine device health, " +
      "and #fleet-alerts for devices that need somebody today.",
    ticketQueue:
      "Raise a task for the site's field team — for a device that needs a visit, or one whose owner " +
      "cannot be reached automatically.",
  },
  hiring: {
    channels:
      "Two channels serve this workspace: #hiring for pipeline digests, and #hiring-urgent for " +
      "offers about to expire and roles that have stalled.",
    ticketQueue:
      "Raise a task for the recruiting team — for a requisition whose recruiter cannot be " +
      "reached automatically, or an offer that needs a phone call today.",
  },
};

export const LEAN_OPS_SERVICES: OpsService[] = ["mail", "llm", "ticketing", "chat"];

/**
 * The name the fake email tool carries.
 *
 * ⚠ It is `test_email_send` and not `mail_send`, and the name is doing real
 * work. `mail_send` reads like the way to send mail; a model choosing between
 * `mail_send` and `tether_email_send` has no way to tell which one reaches a
 * person. The `test_` prefix is the only signal in the catalogue that says so,
 * and the description repeats it.
 */
export const TEST_EMAIL_TOOL = "test_email_send";

/**
 * The workspace's tools.
 *
 * `domainKey` picks the per-domain wording for the two ACTION tools and is what
 * decides whether they are offered at all: a workspace whose key is not in
 * `ACTION_WORDS` gets the three original tools and nothing else. ⚠ That is
 * deliberate — a `ticket_create` whose description cannot say what the queue is
 * FOR, or a `chat_post_message` that cannot name a channel, is a tool a model
 * calls with a guess. An unknown channel is a 404 at runtime, after approval.
 */
export function leanToolCatalogue(domainKey?: string): ToolSpec[] {
  const b = config.opsApiBase;
  const words = domainKey ? ACTION_WORDS[domainKey] : undefined;
  const tools: ToolSpec[] = [
    {
      name: TEST_EMAIL_TOOL,
      description:
        "Send a TEST email. ⚠ NOTHING IS DELIVERED — the message is captured and shown in " +
        "Foundry's Email box (Resources → Email box) for whoever is testing the automation. Use " +
        "this while building and testing. `tether_email_send` is the one that reaches a real " +
        "mailbox. Returns {message_id, status, accepted[], rejected[], bounce_reason}: status is " +
        "'sent' (201) or 'bounced' (202), and a 202 means nothing was accepted — so read " +
        "`status` and `rejected` rather than treating any 2xx as success. One call takes many " +
        "recipients; never pass a null address.",
      url: `${b}/mail/send`,
      method: "POST",
      ...auth("mail"),
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)."),
        recipients: p("array", true, "One address or an array of up to 50. Never null."),
        subject: p("string", true, "Subject line."),
        body: p("string", true, "Plain-text body."),
        cc: p("array", false, "Optional cc addresses."),
      },
    },
    {
      name: "llm_complete",
      // ⚠ IDENTICAL in every workspace, deliberately — D-34. Its output being
      // terminal is a property of the tool, not of the domain, and letting a
      // domain reword it is how one workspace gets a softer version of the one
      // rule that stops a model's guess becoming a decision.
      description:
        "Turn figures you already have into a paragraph a person can read. ⚠ ITS OUTPUT IS " +
        "TERMINAL: put it at the END of a flow and let nothing downstream read it. It returns " +
        "prose, never JSON, and it must never be asked to decide anything — not which rows " +
        "matter, not who to contact, not whether a threshold was crossed. Every figure in the " +
        "text must come from a query or a code step that already computed it; this step only " +
        "words them. A digest whose numbers were all correct once ranked two departments in an " +
        "order its own numbers contradicted, which is why this rule exists. It also sources " +
        "nothing: it cannot fetch, browse, run code or call other tools. 422 output_truncated " +
        "means the answer hit max_tokens mid-sentence. 429 means the per-minute budget is spent.",
      url: `${b}/llm/complete`,
      method: "POST",
      ...auth("llm"),
      paramsSchema: {
        input: p("string", true, "The data to work on — wired from a previous step's output."),
        instruction: p("string", true, "What to do with it, in plain English."),
        max_tokens: p("number", false, "Upper bound on the answer's length."),
      },
    },
    /**
     * ── THE TWO ACTION TOOLS, restored 2026-09-08 ────────────────────────────
     *
     * ⚠ **They were removed on request, and the argument for removing them is
     * kept rather than deleted, because it was a real argument.** It was that
     * they are the CHEAP arms of a branch: offering "raise a ticket" beside
     * "email the customer" lets a run go green having done the thing nobody
     * reads, and with one delivery channel a branch has to decide whether to
     * act at all — which is the decision worth watching.
     *
     * They are back because the catalogue was measured to be the limiting
     * factor on what an automation could be: four workspaces held three tools
     * and ONE DB operation each, so every flow was a read plus an email, and
     * `needs_component` never fired once across eleven conversations because a
     * reusable-looking reader always existed. A demo whose every flow has the
     * same shape does not show a branch at all, cheap arm or not.
     *
     * ⚠ **`ticket_search`, `ticket_update` and `chat_list_channels` stay OUT.**
     * They are reads, and reading is the datasource's job here; a model given a
     * search tool beside a DB operation has two routes to the same rows and no
     * way to tell which is checkable. The channel list is in the `channel`
     * param's own description instead, which costs no step and cannot go stale
     * against `ACTION_WORDS` without going stale in both places at once.
     */
    ...(words
      ? [
          {
            name: "ticket_create",
            description:
              `${words.ticketQueue} One call opens ONE ticket — batch the detail into its ` +
              `description rather than calling this once per row, because a queue with a dozen ` +
              `near-identical tickets is a queue nobody works. Returns its ticket_key.`,
            url: `${b}/tickets`,
            method: "POST" as const,
            ...auth("ticketing"),
            paramsSchema: {
              title: p("string", true, "One line. Name the thing it is about so the ticket is findable."),
              description: p("string", false, "The detail — the full list, the figures, what was already tried."),
              priority: p("string", false, "low | normal | high | urgent. Defaults to normal."),
              assignee: p("string", false, "An address. Usually a team's contact address, not an individual."),
            },
          },
          {
            name: "chat_post_message",
            description:
              `${words.channels} Nothing posted to a channel interrupts anybody — it is the ` +
              `quiet arm, so use it for a digest and use email or a ticket when somebody has to ` +
              `act. Include the counts a reader needs in the text; do not make them open ` +
              `something else for the number.`,
            url: `${b}/chat/messages`,
            method: "POST" as const,
            ...auth("chat"),
            paramsSchema: {
              // ⚠ The channel names live HERE and in `ACTION_WORDS` above, and
              // both come off the same string — so they cannot disagree. An
              // unknown channel is a 404 at runtime, after approval.
              channel: p("string", true, `Which channel. ${words.channels}`),
              text: p("string", true, "The message."),
              author: p("string", false, "Display name; defaults to foundry-automation."),
            },
          },
        ]
      : []),
    // A platform tool (`llm_complete`, the email tool) is registered for every workspace by
    // `registerPlatformTools`; a demo catalogue never writes one.
  ];
  return tools.filter((t) => !isPlatformToolName(t.name));
}
