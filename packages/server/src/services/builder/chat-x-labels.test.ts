/**
 * Phase X's labelled sets are well-formed: every edit label names an action its state really offers, at the place it says.
 * A label that names nothing would score as a model miss when it is a typo in the set (I-38: a check that cannot pass is no check).
 */
import { describe, expect, it } from "vitest";
import { SYNTHETIC } from "@foundry/flow-edit";
import { editable, placeWords } from "./chat-edit.js";
import { STATES } from "../../scenarios/chat-edit-states.js";
import { adjudicateEdit, EDIT_CASES, ROUTE_CASES } from "../../scenarios/chat-x-labels.js";

describe("phase X labelled sets", () => {
  it("every labelled edit action exists on its state, at its place", () => {
    for (const c of EDIT_CASES) {
      if (!c.expect.label) continue;
      const acts = editable(STATES[c.state](), SYNTHETIC);
      const hit = acts.some((a) => a.label === c.expect.label && (c.expect.at === undefined || placeWords(a.where) === c.expect.at));
      expect(hit, `[${c.state}] “${c.message}” → ${c.expect.label} at ${c.expect.at}`).toBe(true);
    }
  });

  it("the sets are the size the plan states, and every route kind is represented", () => {
    expect(ROUTE_CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(ROUTE_CASES.map((c) => c.kind)).size).toBe(5);
    expect(EDIT_CASES.length).toBeGreaterThanOrEqual(20);
    expect(ROUTE_CASES[0]!.message).toBe("What can you build?"); // the report's own message (I-309)
  });

  it("the adjudicator: an applied edit that is not the label is WRONG, a matching one agrees", () => {
    const c = EDIT_CASES.find((x) => x.expect.status === "confirm")!;
    expect(adjudicateEdit(c, { status: "confirm", label: c.expect.label, at: c.expect.at })).toEqual({ agrees: true, wrongApplied: false });
    expect(adjudicateEdit(c, { status: "apply", label: c.expect.label, at: c.expect.at })).toEqual({ agrees: false, wrongApplied: true });
  });
});
