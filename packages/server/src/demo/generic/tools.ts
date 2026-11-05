/**
 * The generic tool catalogue — mail, chat, ticketing and `llm_complete`.
 *
 * ⚠ **THE DESCRIPTIONS ARE THE PRODUCT SURFACE, AND THEY ARE PER DOMAIN.** A
 * tool's description is ~60% of what a drafting model is given, so a shared
 * description that says "post a message to a channel" teaches nothing about
 * WHICH channel or WHEN. Each domain therefore supplies its own channel names
 * and its own sentence about when the expensive action is the right one — which
 * is what `itops-tools.ts` does at length for `page_oncall`.
 *
 * ⚠ **`llm_complete`'s caveat is IDENTICAL everywhere on purpose** (D-34). Its
 * output is terminal and nothing downstream may read it. That is a property of
 * the tool, not of the domain, and letting a domain reword it is how one
 * workspace ends up with a softer version of the one rule that stops a model's
 * guess becoming a decision.
 */
import { config } from "../../config/index.js";
import { ACTION_WORDS as DOMAIN_WORDS } from "../lean-catalogue.js";
import { OPS_AUTH_STYLE, OPS_SECRET_ENV, type OpsService } from "../../services/ops-client.service.js";
import type { createToolSchema } from "../../services/tool.service.js";
import type { z } from "zod";
import type { DomainSpec } from "./domain.js";
import { isPlatformToolName } from "../../services/platform-tool-names.js";

type ToolSpec = z.input<typeof createToolSchema>;

const auth = (service: OpsService) => ({
  secretEnvName: OPS_SECRET_ENV[service],
  authStyle: OPS_AUTH_STYLE[service].style,
  authParamName: OPS_AUTH_STYLE[service].paramName ?? undefined,
});

const p = (type: string, required: boolean, description: string) => ({ type, required, description });


export function genericToolCatalogue(spec: DomainSpec): ToolSpec[] {
  const b = config.opsApiBase;
  const w = DOMAIN_WORDS[spec.key] ?? {
    channels: "Post a message to a chat channel.",
    ticketQueue: "Raise a ticket in this workspace's queue.",
  };
  const tools: ToolSpec[] = [
    {
      name: "ticket_create",
      description:
        `${w.ticketQueue} One call opens ONE ticket — batch the detail into its description ` +
        `rather than calling this once per row, because a queue with a dozen near-identical ` +
        `tickets is a queue nobody works. Returns its ticket_key.`,
      url: `${b}/tickets`,
      method: "POST",
      ...auth("ticketing"),
      paramsSchema: {
        title: p("string", true, "One line. Name the thing it is about so the ticket is findable."),
        description: p("string", false, "The detail — the full list, the figures, what was already tried."),
        priority: p("string", false, "low | normal | high | urgent. Defaults to normal."),
        assignee: p("string", false, "An address. Usually a team's contact address, not an individual."),
        labels: p("array", false, "Free-form strings."),
      },
    },
    {
      name: "ticket_search",
      description:
        "Returns an ENVELOPE {total, tickets[]} — read the `tickets` key, it is not a bare " +
        "array. Newest first, optionally filtered by status. Use it to avoid raising a second " +
        "ticket for something already in the queue.",
      url: `${b}/tickets`,
      method: "GET",
      ...auth("ticketing"),
      paramsSchema: {
        status: p("string", false, "open | in_progress | resolved | closed."),
        limit: p("number", false, "1-200, default 50."),
      },
    },
    {
      name: "ticket_update",
      description: "Change an existing ticket's status, priority, assignee or description, by its ticket key.",
      url: `${b}/tickets/{key}`,
      method: "PATCH",
      ...auth("ticketing"),
      paramsSchema: {
        key: p("string", true, "The ticket key ticket_create returned."),
        status: p("string", false, "open | in_progress | resolved | closed."),
        priority: p("string", false, "low | normal | high | urgent."),
        assignee: p("string", false, "An address."),
        description: p("string", false, "Replacement description."),
      },
    },
    {
      name: "chat_list_channels",
      description:
        "Returns an ENVELOPE {total, channels[]} — read the `channels` key. Call this before " +
        "posting rather than guessing a channel name; an unknown channel returns 404.",
      url: `${b}/chat/channels`,
      method: "GET",
      ...auth("chat"),
      paramsSchema: {},
    },
    {
      name: "chat_post_message",
      description:
        `${w.channels} Nothing posted to a channel interrupts anybody — it is the quiet arm. ` +
        `Include the counts a reader needs in the text; do not make them open something else ` +
        `for the number.`,
      url: `${b}/chat/messages`,
      method: "POST",
      ...auth("chat"),
      paramsSchema: {
        channel: p("string", true, "Channel name, e.g. #support-floor. The leading # is optional."),
        text: p("string", true, "The message."),
        author: p("string", false, "Display name; defaults to foundry-automation."),
        blocks: p("array", false, "Optional structured blocks."),
      },
    },
    {
      name: "mail_send",
      description:
        "SIMULATED (demo mail service — nothing is delivered). Send one email. Returns " +
        "{message_id, status, accepted[], rejected[], bounce_reason}. status is 'sent' (201) or " +
        "'bounced' (202) — a 202 means NOTHING was delivered, so read status and rejected " +
        "rather than assuming a 2xx is success. Never pass a null recipient.",
      url: `${b}/mail/send`,
      method: "POST",
      ...auth("mail"),
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)."),
        recipients: p("array", true, "One address or an array of up to 50. Never null."),
        subject: p("string", true, "Subject line."),
        body: p("string", true, "Plain-text body."),
        cc: p("array", false, "Optional cc addresses."),
        attachments: p("array", false, "Up to 10 {filename, contentType, content} objects."),
      },
    },
    {
      name: "mail_send_template",
      description:
        "SIMULATED (demo mail service — nothing is delivered). Send an email from a named " +
        "template so wording stays consistent across runs. Templates: 'general_update' (needs " +
        "full_name, subject, message). Missing variables return 422 listing exactly which.",
      url: `${b}/mail/send-template`,
      method: "POST",
      ...auth("mail"),
      paramsSchema: {
        sender: p("string", true, "From address (an address like ops@example.com, never a display name)."),
        recipients: p("array", true, "One address or an array."),
        template: p("string", true, "general_update"),
        variables: p("object", true, "Template variables; 422 lists any that are missing."),
        cc: p("array", false, "Optional cc addresses."),
      },
    },
    {
      name: "llm_complete",
      // ⚠ IDENTICAL in every workspace, deliberately — D-34. See this file's header.
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
    // A platform tool (`llm_complete`, the email tool) is registered for every workspace by
    // `registerPlatformTools`; a demo catalogue never writes one.
  ];
  return tools.filter((t) => !isPlatformToolName(t.name));
}
