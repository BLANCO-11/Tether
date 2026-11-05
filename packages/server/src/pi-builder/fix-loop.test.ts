/** The fix loop's prompt keeps the failure verbatim and the sources the goal names; a repeated failure is no progress. */
import { describe, expect, it } from "vitest";
import { droppedSources, fixPrompt, noProgress, routeFailure, sourceList } from "./fix-loop.js";

describe("the fix prompt", () => {
  it("keeps the failure detail unchanged", () => {
    const detail = "VERIFY FAIL step 'hc': column \"x\" missing\n  line 2";
    expect(fixPrompt(detail)).toContain(detail);
  });

  it("says to fix exactly the failure, then to keep every source the goal names", () => {
    const text = fixPrompt("boom");
    const fix = "Fix exactly what failed and change nothing else.";
    const keep = "Keep every source the goal names — its tables, its Files, its tools. Never swap one for another to get past the test.";
    expect(text).toContain(fix);
    expect(text).toContain(keep);
    expect(text.indexOf(keep)).toBeGreaterThan(text.indexOf(fix));
  });
});

describe("no progress between fix rounds", () => {
  it("is true when the round failed with the same text again, trimmed", () => {
    expect(noProgress("boom", "boom")).toBe(true);
    expect(noProgress("boom\n", "  boom")).toBe(true);
  });

  it("CONTROL: a different failure, or a missing one, is progress", () => {
    expect(noProgress("boom", "bang")).toBe(false);
    expect(noProgress(null, "boom")).toBe(false);
    expect(noProgress("", "")).toBe(false);
    expect(noProgress("boom", null)).toBe(false);
  });
});

describe("where a test result goes", () => {
  it("a passed run is ready", () => {
    expect(routeFailure({ ok: true, emptyData: false, infra: false })).toBe("ready");
  });

  it("a run that could not start is an outage, not Forge's to fix", () => {
    expect(routeFailure({ ok: false, emptyData: false, infra: true })).toBe("outage");
  });

  it("a run that found no data goes to the person", () => {
    expect(routeFailure({ ok: false, emptyData: true, infra: false })).toBe("person");
  });

  it("any other failure goes to Forge", () => {
    expect(routeFailure({ ok: false, emptyData: false, infra: false })).toBe("forge");
  });

  it("CONTROL: a passed run is ready even with infra true", () => {
    expect(routeFailure({ ok: true, emptyData: false, infra: true })).toBe("ready");
  });
});

describe("sources a fix dropped", () => {
  it("a dropped file is reported", () => {
    const before = { steps: [{ id: "hc", uses: ["file:Headcount.xlsx", "tool:email"] }] };
    const after = { steps: [{ id: "hc", uses: ["read:employees", "tool:email"] }] };
    expect(droppedSources(before, after)).toEqual(["file:Headcount.xlsx"]);
  });

  it("a nested step's dropped read is reported", () => {
    const before = { steps: [{ id: "loop", type: "loop", steps: [{ id: "inner", uses: ["read:absences"] }] }] };
    const after = { steps: [{ id: "loop", type: "loop", steps: [{ id: "inner", uses: [] }] }] };
    expect(droppedSources(before, after)).toEqual(["read:absences"]);
  });

  it("CONTROL: a source moved to another step is not reported", () => {
    const before = { steps: [{ id: "a", uses: ["file:H.xlsx"] }, { id: "b", uses: [] }] };
    const after = { steps: [{ id: "a", uses: [] }, { id: "b", uses: ["file:H.xlsx"] }] };
    expect(droppedSources(before, after)).toEqual([]);
  });

  it("CONTROL: added sources are not reported", () => {
    const before = { steps: [{ id: "a", uses: ["file:H.xlsx"] }] };
    const after = { steps: [{ id: "a", uses: ["file:H.xlsx", "read:x"] }] };
    expect(droppedSources(before, after)).toEqual([]);
  });

  it("null or garbage input returns nothing", () => {
    expect(droppedSources(null, null)).toEqual([]);
    expect(droppedSources("x", 3)).toEqual([]);
    expect(droppedSources(undefined, { steps: [] })).toEqual([]);
    expect(droppedSources({ steps: "nope" }, null)).toEqual([]);
  });

  it("a non-source uses entry is ignored", () => {
    const before = { steps: [{ id: "a", uses: ["step:prev"] }] };
    expect(droppedSources(before, { steps: [] })).toEqual([]);
  });

  it("names each source as kind and name", () => {
    expect(sourceList(["file:Headcount.xlsx", "read:emp"])).toBe('file "Headcount.xlsx", read "emp"');
  });
});
