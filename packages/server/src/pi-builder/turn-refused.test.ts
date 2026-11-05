/** A message the forge host refuses reaches the person with the host's reason, never "Forge stopped unexpectedly". */
import { describe, expect, it } from "vitest";
import { turnFailure } from "./forge-errors.js";

describe("a refused message", () => {
  it("says the host's reason", () => {
    const e = turnFailure("refused", { minutes: 10, reason: "This conversation's files are over 300 MB. Remove some, or start a new chat." });
    expect(e.title).toBe("Forge could not take this message");
    expect(e.said).toContain("over 300 MB");
    expect(e.title).not.toContain("unexpectedly");
  });
});
