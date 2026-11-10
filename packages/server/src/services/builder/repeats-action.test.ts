/**
 * Issue 1 (2026-10-03): "attach the list as a CSV to the email" was planned as an ADDITION — a second email carrying the attachment.
 * An added action that is the same component sending to the same recipient as a step already there is a change to that step.
 */
import { describe, expect, it } from "vitest";
import { repeatsAnAction } from "./conversation.js";
import type { GoalSpec } from "./goal-spec.js";

const ME = "me@x.example";
const start = { id: "f", inputs: [], holes: [], steps: [
  { id: "read", kind: "datasource", ref: "ds.rows", inputs: [] },
  { id: "mail", kind: "tool", ref: "tether_email_send", inputs: [{ name: "to", source: { from: "literal", value: ME } }, { name: "subject", source: { from: "literal", value: "Weekly" } }] },
] } as never;
const spec = (sinks: string[], values: GoalSpec["values"]): GoalSpec => ({ sources: [], sinks: sinks.map((ref) => ({ ref, quote: "" })), values, conditions: [], schedule: null, missing: null } as never);

describe("an edit that repeats an action the automation already takes", () => {
  it("the same email to the same person — “me”, or their address written out — is a repeat", () => {
    expect(repeatsAnAction(spec(["tether_email_send"], [{ role: "recipient", from: "requester", quote: "me", fills: "tether_email_send.to" }]), start, ME)).toBe(true);
    expect(repeatsAnAction(spec(["tether_email_send"], [{ role: "recipient", from: "goal", quote: "Me@X.example", fills: "tether_email_send.to" }]), start)).toBe(true);
  });
  it("an UNSAID recipient on a component that sends to an address is the same one — the build reuses the address already there", () => {
    expect(repeatsAnAction(spec(["tether_email_send"], []), start, ME, () => true)).toBe(true);
  });
  it("CONTROL: someone else, another component, no recipient, or a requester not known — an addition", () => {
    expect(repeatsAnAction(spec(["tether_email_send"], [{ role: "recipient", from: "goal", quote: "finance@x.example", fills: "tether_email_send.to" }]), start, ME)).toBe(false);
    expect(repeatsAnAction(spec(["chat_post_message"], [{ role: "recipient", from: "requester", quote: "me", fills: "chat_post_message.to" }]), start, ME)).toBe(false);
    expect(repeatsAnAction(spec(["tether_email_send"], []), start, ME)).toBe(false);
    expect(repeatsAnAction(spec(["tether_email_send"], [{ role: "recipient", from: "requester", quote: "me", fills: "tether_email_send.to" }]), start)).toBe(false);
  });
});
