import { describe, it, expect } from "vitest";
import { isPersonalRemovedPath } from "./personal";

describe("personal fork removed paths", () => {
  it("flags enterprise admin and org surfaces", () => {
    expect(isPersonalRemovedPath("/admin")).toBe(true);
    expect(isPersonalRemovedPath("/admin/people")).toBe(true);
    expect(isPersonalRemovedPath("/organization")).toBe(true);
    expect(isPersonalRemovedPath("/incidents/break-glass")).toBe(true);
    expect(isPersonalRemovedPath("/reports")).toBe(true);
  });

  it("keeps the personal product surface", () => {
    expect(isPersonalRemovedPath("/dashboard")).toBe(false);
    expect(isPersonalRemovedPath("/chats")).toBe(false);
    expect(isPersonalRemovedPath("/projects")).toBe(false);
    expect(isPersonalRemovedPath("/ai-provider")).toBe(false);
    expect(isPersonalRemovedPath("/flows")).toBe(false);
  });
});
