/**
 * The builder's opening message — written from THIS person, THIS workspace and (when one is open) THIS flow, never
 * a fixed string. Derived, not generated: every noun in it is read from the catalogue or the saved bundle, so it can
 * name nothing the workspace does not have. No model call — a greeting is not worth seconds of waiting, and a model
 * would be free to promise a capability that is not there.
 *
 * Pure: inputs in, text out.
 */

import type { PiStep } from "./types.js";

export type WelcomeCatalogue = {
  entries?: Array<{ ref?: string; kind?: string }>;
  datasources?: Array<{ name?: string; tables?: Array<{ name?: string }> }>;
};

export type WelcomeFlow = {
  name: string;
  workflow: {
    inputs?: Record<string, unknown>;
    reads?: Record<string, { datasource?: unknown; ref?: unknown }>;
    steps?: PiStep[];
  };
};

/** "Himanshu" from a display name or, failing that, an address — null when neither says. */
export function firstNameOf(person: { name?: string | null; email?: string | null } | null | undefined): string | null {
  const fromName = person?.name?.trim().split(/\s+/)[0];
  if (fromName) return cap(fromName);
  const local = person?.email?.split("@")[0]?.split(/[._-]/)[0];
  return local && /^[a-z]{2,}$/i.test(local) ? cap(local) : null;
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

const pick = <T,>(xs: readonly T[], rand: () => number): T => xs[Math.floor(rand() * xs.length) % xs.length]!;

/**
 * The lines a greeting is drawn from (2026-10-12). Each is short and stands on its own, with no em dashes and no comma
 * chains: the model is told the same (SYSTEM.md, How you talk) and the greeting is the first thing it imitates. `{name}`
 * becomes a person's first name; `{in}` becomes " in <workspace>" or nothing. Lines naming a person are used only when
 * there is a name, so no greeting ever reads "Hi ."
 */
const NEW_OPENERS = [
  "Hi {name}. What should we automate{in}?",
  "Hello {name}. What can I take off your plate{in}?",
  "Hey {name}. What would you like to build{in}?",
  "Good to see you, {name}. What's on your list{in}?",
  "Hi {name}. Which job should run itself from now on?",
  "Hey {name}. What's the task you keep doing by hand{in}?",
  "Hello {name}. Got something repetitive{in} I can take over?",
  "Hi {name}. What should happen automatically{in}?",
  "Hey {name}. Let's build something useful. What do you have in mind?",
  "Hi {name}. What would make your week easier{in}?",
  "Hello {name}. Tell me about a chore{in} and I'll automate it.",
  "Hey {name}. What should we set up today?",
  "Hi there. What should we automate{in}?",
  "Hello. What can I take off your plate{in}?",
  "Hey there. What would you like to build{in}?",
  "Hi. Which job should run itself from now on?",
  "Hello. What's the task you keep doing by hand{in}?",
  "Hey. Got something repetitive{in} I can take over?",
  "Hi there. What would make your week easier{in}?",
  "Hello. What should we set up today?",
];

const NEW_FOLLOW_UPS = [
  "Describe it in your own words.",
  "Tell me what should happen and I'll take it from there.",
  "Just describe the job. I'll ask if I need more.",
  "Say it the way you'd tell a colleague.",
  "A sentence or two is plenty to start.",
  "Tell me what to look at and who should hear about it.",
  "Rough is fine. We'll shape it together.",
  "Start with what you want done. The details can come later.",
  "You can also attach a sample or a screenshot.",
  "Tell me when it should run and what it should do.",
  "No need to be precise yet. I'll check with you as I go.",
  "Describe the outcome you want and I'll work out the steps.",
];

const SAVED_OPENERS = [
  "Welcome back, {name}. “{flow}” is just as you left it.",
  "Hi again, {name}. “{flow}” is ready where you left off.",
  "Good to see you again, {name}. “{flow}” is open.",
  "Hey {name}. Picking up “{flow}” where you left it.",
  "Welcome back, {name}. Here's “{flow}”.",
  "Hi {name}. “{flow}” is open and unchanged since your last save.",
  "Welcome back. “{flow}” is just as you left it.",
  "Hi again. “{flow}” is ready where you left off.",
  "“{flow}” is open, just as you saved it.",
  "Back to “{flow}”. Everything is where you left it.",
];

const SAVED_FOLLOW_UPS = [
  "What should change?",
  "What would you like to change?",
  "Tell me what to change, or ask how any part works.",
  "What are we working on today?",
  "Want to change something, or test it first?",
  "Ask me anything about it, or tell me what to adjust.",
  "What needs a tweak?",
  "Where should we pick up?",
];

const EMPTY_FOLLOW_UP = "Nothing is connected here yet, so I'll tell you what's missing as we go.";

/** One line from `lines`, filled in. Lines needing a name are skipped when there is none. */
function draw(lines: readonly string[], vars: Record<string, string | null>, rand: () => number): string {
  const usable = lines.filter((l) => !/\{name\}/.test(l) || !!vars.name);
  return pick(usable, rand).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

/**
 * A new conversation: two short lines. A greeting with a question, then an invitation.
 *
 * ⚠ Deliberately brief. It used to list the workspace's databases, tables and tool count, which read like a status
 * report rather than a greeting. What the workspace has is Forge's to bring up when it matters. The one exception is an
 * empty workspace, where the honest thing is to say nothing is connected.
 */
export function newWelcome(
  person: string | null,
  workspaceName: string | null,
  cat: WelcomeCatalogue,
  rand: () => number = Math.random,
): string {
  const open = draw(NEW_OPENERS, { name: person, in: workspaceName ? ` in ${workspaceName}` : "" }, rand);
  const empty = !(cat.datasources ?? []).some((d) => d.name) && !(cat.entries ?? []).some((e) => e.kind === "tool");
  const next = empty ? EMPTY_FOLLOW_UP : draw(NEW_FOLLOW_UPS, {}, rand);
  return `${open}\n\n${next}`;
}

/** An existing flow, reopened: welcome back, which flow, what to change. Its steps are on the canvas beside it. */
export function savedWelcome(person: string | null, flow: WelcomeFlow, rand: () => number = Math.random): string {
  const open = draw(SAVED_OPENERS, { name: person, flow: flow.name }, rand);
  return `${open}\n\n${draw(SAVED_FOLLOW_UPS, {}, rand)}`;
}

/** Every line a greeting can use — for tests. */
export const GREETING_LINES = { NEW_OPENERS, NEW_FOLLOW_UPS, SAVED_OPENERS, SAVED_FOLLOW_UPS, EMPTY_FOLLOW_UP };
