import { describe, expect, it } from "vitest";
import { steerRefusal } from "./steer.js";

const ok = { running: true, testing: false, compacting: false, forgeBusy: true };

describe("steerRefusal (2026-11-03)", () => {
  it("refuses while the conversation is being compacted", () => {
    expect(steerRefusal({ ...ok, compacting: true })).toMatch(/making room/);
  });
  it("refuses while the workflow is being tested", () => {
    expect(steerRefusal({ ...ok, testing: true })).toMatch(/testing the workflow/);
  });
  it("refuses when no turn is running", () => {
    expect(steerRefusal({ ...ok, running: false, forgeBusy: false })).toMatch(/not working on a message/);
  });
  it("refuses when the turn is over and the result is being checked", () => {
    expect(steerRefusal({ ...ok, forgeBusy: false })).toMatch(/checking its work/);
  });
  it("allows a running, busy turn", () => {
    expect(steerRefusal(ok)).toBeNull();
  });
});
