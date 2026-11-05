// src/lib/trigger-groups.test.ts — the grouping, and the two sentences that
// belong on the automation rather than on every card under it. ui-upgrade
// Phase 7.2, D-109.
import { describe, expect, it } from "vitest";
import { automationWord, groupByAutomation } from "@/lib/trigger-groups";
import type { Trigger } from "@/lib/types";

function trig(over: Partial<Trigger> = {}): Trigger {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    flowId: "flow-a",
    name: "Start by hand",
    kind: "manual",
    icon: "manual",
    quote: "…",
    state: "Draft",
    stateStatus: "neutral",
    rows: [],
    automationName: "Invoice chase",
    enableReady: true,
    enableBlockedReason: null,
    approvalBlockedReason: null,
    ...over,
  };
}

describe("groupByAutomation", () => {
  it("puts every trigger of one automation in one group", () => {
    const groups = groupByAutomation([trig(), trig(), trig({ flowId: "flow-b", automationName: "Budget variance" })]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.flowId === "flow-a")!.triggers).toHaveLength(2);
  });

  it("groups on the FLOW ID, not the automation's name", () => {
    // ⚠ Two automations may share a name, and one may be renamed between the
    // fan-out's two requests. Either turns a name-keyed grouping into a page
    // that quietly merges or splits automations.
    const groups = groupByAutomation([
      trig({ flowId: "flow-a", automationName: "Chase" }),
      trig({ flowId: "flow-b", automationName: "Chase" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("says a blocked gate ONCE, on the automation", () => {
    // The defect this exists for: three triggers on one unapproved flow printed
    // "waiting on approval" three times and read as three problems.
    const reason = "This flow has no approved revision, so it cannot run unattended yet.";
    const [g] = groupByAutomation([
      trig({ approvalBlockedReason: reason }),
      trig({ approvalBlockedReason: reason }),
      trig({ approvalBlockedReason: reason }),
    ]);
    expect(g.approvalBlockedReason).toBe(reason);
    expect(g.triggers).toHaveLength(3);
  });

  it("keeps gate 1 and gate 2 as TWO fields", () => {
    // ⚠ D-88. "It has never run" is fixed by running it; "it has no approved
    // revision" is fixed by a second person. One merged sentence can only be
    // right about one of them — so they must not collapse into a single field
    // here either, where the collapse would be invisible on screen.
    const [g] = groupByAutomation([
      trig({
        enableReady: false,
        enableBlockedReason: "The flow has never completed a run.",
        approvalBlockedReason: "This flow has no approved revision.",
      }),
    ]);
    expect(g.enableBlockedReason).toBe("The flow has never completed a run.");
    expect(g.approvalBlockedReason).toBe("This flow has no approved revision.");
    expect(g.enableBlockedReason).not.toBe(g.approvalBlockedReason);
  });

  it("does not carry gate 1's sentence when gate 1 is satisfied", () => {
    // The server keeps `enableBlockedReason` from an earlier state on some
    // shapes; the group must read `enableReady`, which is the answer.
    const [g] = groupByAutomation([
      trig({ enableReady: true, enableBlockedReason: "stale sentence from before the run" }),
    ]);
    expect(g.enableBlockedReason).toBeNull();
  });

  it("gives a trigger bound to nothing its own group, sorted last", () => {
    // ⚠ Never dropped and never folded into the first. `createForFlow` is the
    // only constructor, so this group should not exist — and a page that hid it
    // would hide exactly the row worth seeing.
    const groups = groupByAutomation([
      trig({ flowId: null, automationName: null }),
      trig({ flowId: "flow-z", automationName: "Zebra" }),
    ]);
    expect(groups.map((g) => g.automation)).toEqual(["Zebra", null]);
  });

  it("sorts by automation name, never by trigger count", () => {
    // A list that reorders itself as runs happen is one where the row you were
    // about to click moves.
    const groups = groupByAutomation([
      trig({ flowId: "b", automationName: "Beta" }),
      trig({ flowId: "a", automationName: "Alpha" }),
      trig({ flowId: "b", automationName: "Beta" }),
      trig({ flowId: "b", automationName: "Beta" }),
    ]);
    expect(groups.map((g) => g.automation)).toEqual(["Alpha", "Beta"]);
  });

  it("returns nothing for nothing, rather than an empty group", () => {
    expect(groupByAutomation([])).toEqual([]);
  });
});

describe("automationWord", () => {
  it("is live once a revision is armed", () => {
    expect(automationWord(trig({ armedRevision: 4 }))).toBe("live");
  });

  it("is blocked when the automation was suspended", () => {
    // Different in kind from "never run": something WAS running unattended and
    // has stopped.
    expect(automationWord(trig({ approvalStatus: "suspended" }))).toBe("blocked");
  });

  it("reads a flow that merely owes its first run as DRAFT, not blocked", () => {
    // ⚠ `lib/status.ts` warns that colouring ordinary drafts as a problem makes
    // the colour meaningless where something actually is one — and every freshly
    // generated automation is in exactly this state. The sentence under the
    // heading says what it owes; the colour does not shout.
    expect(
      automationWord(trig({ enableReady: false, enableBlockedReason: "The flow has never completed a run." })),
    ).toBe("draft");
  });

  it("prefers armed over suspended-looking input it was not given", () => {
    expect(automationWord(trig({ armedRevision: 2, approvalStatus: "armed" }))).toBe("live");
  });
});
