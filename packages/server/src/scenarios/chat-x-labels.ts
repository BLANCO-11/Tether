/**
 * Phase X, task 8 — the labelled sets, DECLARED BEFORE THE FIRST RUN (this file's first commit). The expectations cannot be relaxed
 * to fit a result without the relaxation being in the diff. Pure: no database, no model — so a test may import it.
 *
 * ROUTE: a message, whether the automation has steps, the kind it is. EDIT: a request against a fixed state (`chat-edit-states.ts`,
 * neutral synthetic catalogue) and what code must end up doing with it.
 */
import type { RouteKind } from "../services/builder/chat-route.js";

export interface RouteCase { message: string; hasSteps: boolean; kind: RouteKind }
export const ROUTE_CASES: RouteCase[] = [
  // capabilities — the report's own message first (I-309)
  { message: "What can you build?", hasSteps: false, kind: "capabilities" },
  { message: "what can you do", hasSteps: false, kind: "capabilities" },
  { message: "What kinds of automations can I make here?", hasSteps: false, kind: "capabilities" },
  { message: "show me what's possible", hasSteps: false, kind: "capabilities" },
  { message: "what can this workspace do?", hasSteps: true, kind: "capabilities" },
  { message: "Tell me what you could build for me", hasSteps: false, kind: "capabilities" },
  { message: "what are my options?", hasSteps: false, kind: "capabilities" },
  { message: "Which automations could you set up with the data here?", hasSteps: true, kind: "capabilities" },
  // build — a goal, or an addition
  { message: "Email me the overdue items every Monday morning", hasSteps: false, kind: "build" },
  { message: "every day at 8, post the new sign-ups to the team channel", hasSteps: false, kind: "build" },
  { message: "can you make one that sends me a weekly summary?", hasSteps: false, kind: "build" },
  { message: "find the records with no owner and open a ticket for each", hasSteps: false, kind: "build" },
  { message: "Get me a list of this month's orders", hasSteps: false, kind: "build" },
  { message: "also post the result to the ops channel", hasSteps: true, kind: "build" },
  { message: "add a step that emails the summary to me", hasSteps: true, kind: "build" },
  { message: "and run it every weekday at noon", hasSteps: true, kind: "build" },
  { message: "read the people list and email each person their score", hasSteps: false, kind: "build" },
  { message: "notify me when anything is past due", hasSteps: false, kind: "build" },
  // change — alter or remove what is there
  { message: "send it to ops@acme-corp.com instead", hasSteps: true, kind: "change" },
  { message: "remove the approval", hasSteps: true, kind: "change" },
  { message: "stop running it on a schedule", hasSteps: true, kind: "change" },
  { message: "make it run daily instead of weekly", hasSteps: true, kind: "change" },
  { message: "take the email step out", hasSteps: true, kind: "change" },
  { message: "change the subject line to Weekly roundup", hasSteps: true, kind: "change" },
  { message: "don't ask anyone to approve it any more", hasSteps: true, kind: "change" },
  { message: "use the monthly totals as the message instead", hasSteps: true, kind: "change" },
  // about_flow — a question about the automation as it is
  { message: "what does this automation do?", hasSteps: true, kind: "about_flow" },
  { message: "what does the second step do", hasSteps: true, kind: "about_flow" },
  { message: "who does this send to?", hasSteps: true, kind: "about_flow" },
  { message: "when does it run?", hasSteps: true, kind: "about_flow" },
  { message: "explain this workflow to me", hasSteps: true, kind: "about_flow" },
  { message: "what data does it read?", hasSteps: true, kind: "about_flow" },
  { message: "is this finished?", hasSteps: true, kind: "about_flow" },
  // chat — asks for nothing
  { message: "thanks!", hasSteps: true, kind: "chat" },
  { message: "hello", hasSteps: false, kind: "chat" },
  { message: "great, that's perfect", hasSteps: true, kind: "chat" },
  { message: "ok cool", hasSteps: true, kind: "chat" },
  { message: "good morning", hasSteps: false, kind: "chat" },
  { message: "never mind", hasSteps: true, kind: "chat" },
  { message: "you're doing great", hasSteps: false, kind: "chat" },
];

/** What code must end up doing with an edit request. `label`/`at` name the action (its canvas label and place words). */
export interface EditCase {
  state: "A" | "B";
  message: string;
  expect: { status: "apply" | "confirm" | "which_step" | "ask_value" | "none_fit"; label?: string; at?: string; value?: string };
}
export const EDIT_CASES: EditCase[] = [
  // State A — read_1 (people) → gate_1 → call_1 (mail_send), weekly
  { state: "A", message: "take out the approval step", expect: { status: "confirm", label: "remove this step", at: "step gate_1" } },
  { state: "A", message: "stop running it every week", expect: { status: "confirm", label: "stop running on a schedule", at: "the automation" } },
  { state: "A", message: "send the mail to every person in the list", expect: { status: "apply", label: "every read_1.email", at: "to of call_1" } },
  { state: "A", message: "set the subject to Weekly roundup", expect: { status: "apply", label: "a value you type (Text<SingleLine, MaxLen(200)>)", at: "subject of call_1", value: "Weekly roundup" } },
  { state: "A", message: "change the schedule to every day at 7", expect: { status: "ask_value", label: "change the schedule", at: "the automation" } },
  { state: "A", message: "run it at 30 6 * * 1 instead", expect: { status: "apply", label: "change the schedule", at: "the automation", value: "30 6 * * 1" } },
  { state: "A", message: "make the mail the result", expect: { status: "apply", label: "this is the flow's result", at: "step call_1" } },
  { state: "A", message: "put the list of people in the body", expect: { status: "apply", label: "read_1 as text", at: "body of call_1" } },
  { state: "A", message: "remove a step", expect: { status: "which_step", label: "remove this step" } },
  { state: "A", message: "send it to ops@acme-corp.com", expect: { status: "apply", label: "a value you type (Address)", at: "to of call_1", value: "ops@acme-corp.com" } },
  { state: "A", message: "delete the mail step", expect: { status: "confirm", label: "remove this step", at: "step call_1" } },
  { state: "A", message: "rename the first step to people", expect: { status: "none_fit" } },
  // State B — read_1 (widgets), read_2 (by_month) → call_1 (chat_post), call_2 (ticket_open)
  { state: "B", message: "post it to #alerts", expect: { status: "apply", label: "a value you type (Text<OneOf[#ops, #alerts]>)", at: "channel of call_1", value: "#alerts" } },
  { state: "B", message: "make the ticket high priority", expect: { status: "apply", label: "a value you type (Text<OneOf[low, normal, high]>)", at: "priority of call_2", value: "high" } },
  { state: "B", message: "assign the ticket to lead@acme-corp.com", expect: { status: "apply", label: "a value you type (Address)", at: "assignee of call_2", value: "lead@acme-corp.com" } },
  { state: "B", message: "only carry on when there are widgets", expect: { status: "apply", label: "only when read_1 has rows", at: "step read_1" } },
  { state: "B", message: "have someone approve before posting to chat", expect: { status: "ask_value", label: "a person approves before this runs", at: "step call_1" } },
  { state: "B", message: "use the widgets as the chat message", expect: { status: "apply", label: "read_1 as text", at: "text of call_1" } },
  { state: "B", message: "remove the monthly totals", expect: { status: "confirm", label: "remove this step", at: "step read_2" } },
  { state: "B", message: "swap the ticket for an email", expect: { status: "none_fit" } },
  { state: "B", message: "set the period to 2026-05", expect: { status: "apply", label: "a value you type (Month)", at: "period of read_2", value: "2026-05" } },
  { state: "B", message: "remove it", expect: { status: "which_step", label: "remove this step" } },
  { state: "B", message: "make the monthly totals the result", expect: { status: "apply", label: "this is the flow's result", at: "step read_2" } },
  { state: "B", message: "limit the monthly totals to 50 rows", expect: { status: "apply", label: "a value you type (Int)", at: "limit_to of read_2", value: "50" } },
];

/** What a decision was, in the labels' terms. */
export interface EditOutcome { status: EditCase["expect"]["status"]; label?: string; at?: string; value?: string; destructive?: boolean }

/** Did the outcome match the label? And was it WRONG in the way that matters — an edit applied that the label did not ask for? */
export function adjudicateEdit(c: EditCase, o: EditOutcome): { agrees: boolean; wrongApplied: boolean } {
  const e = c.expect;
  const same = o.status === e.status && (e.label === undefined || o.label === e.label) && (e.at === undefined || o.at === e.at) && (e.value === undefined || (o.value ?? "").trim() === e.value);
  const wrongApplied = o.status === "apply" && !same;
  return { agrees: same, wrongApplied };
}
