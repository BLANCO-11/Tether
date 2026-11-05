/**
 * P3 — accept-with-gaps: accept closes every open gap as words-anchors;
 * leave/skip still defers one; new words still ask; discard still drops.
 * (Accept/discard dispatch on the router's typed route kinds, never regex.)
 */
import { describe, expect, it } from "vitest";
import { acceptGaps } from "./conversation.js";
import type { Conversation } from "./conversation.js";

const conv = (c: Partial<Conversation>): Conversation => ({
  goal: "g", texts: ["g"], spec: { sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: null },
  answers: {}, pending: null, ...c,
});

describe("P3 — accept-with-gaps", () => {
  it("accept closes all open gaps as words-anchors", () => {
    const { accepted, stillOpen } = acceptGaps(conv({
      pending: "part:said:x",
      pendingGroup: ["unclear:the approver:action", "part:said:threshold"],
      unsettled: ["the goal also says “the channel”, and nothing built here does it"],
    }));
    expect(stillOpen).toEqual([]);
    expect(accepted).toContain("words:approver");
    expect(accepted.length).toBeGreaterThanOrEqual(3);
  });

  it("CONTROL: nothing open closes nothing", () => {
    expect(acceptGaps(conv({ pending: null })).accepted).toEqual([]);
  });

  it("CONTROL: single pending closes one anchor", () => {
    const { accepted } = acceptGaps(conv({ pending: "unclear:the threshold:condition" }));
    expect(accepted).toEqual(["words:threshold"]);
  });
});
