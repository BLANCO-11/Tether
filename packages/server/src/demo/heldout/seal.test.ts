import { describe, expect, it } from "vitest";
import { sealCheck, SEALED_WORKSPACES } from "./seal.js";

const held = { id: "H01", workspace: SEALED_WORKSPACES[0]! };
const tuned = { id: "D01", workspace: "HR" };

describe("the held-out seal (D-313)", () => {
  it("lets a run with no sealed goal through", () => {
    expect(sealCheck([tuned], false, undefined)).toBeNull();
  });
  it("refuses a sealed goal without --gate, naming it", () => {
    const r = sealCheck([tuned, held], false, undefined);
    expect(r).toMatch(/refused/);
    expect(r).toContain("H01");
    expect(r).not.toContain("D01");
  });
  it("refuses a gate run that names no log", () => {
    expect(sealCheck([held], true, undefined)).toMatch(/gate-log/);
  });
  it("lets a logged gate run through", () => {
    expect(sealCheck([held], true, "evidence.md")).toBeNull();
  });
});
