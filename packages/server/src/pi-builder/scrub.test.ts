import { describe, expect, it } from "vitest";
import { makeScrubber, scrubDeep } from "./scrub.js";

const VALUE = "ab+c/d=efgh1234";

describe("scrubber", () => {
  const scrub = makeScrubber([{ name: "k", value: VALUE }], { token: "forge-token-123456" });

  it("scrubs the exact value, URL-encoded and base64 forms", () => {
    expect(scrub(`x ${VALUE} y`)).toBe("x [secret:k] y");
    expect(scrub(`x ${encodeURIComponent(VALUE)} y`)).toBe("x [secret:k] y");
    expect(scrub(`x ${Buffer.from(VALUE).toString("base64")} y`)).toBe("x [secret:k] y");
  });

  it("scrubs the tool key", () => {
    expect(scrub("t forge-token-123456")).toBe("t [forge-tool-key]");
  });

  it("redacts a strong pattern", () => {
    expect(scrub(`ghp_${"a1B2".repeat(9)}`)).toBe("[redacted]");
  });

  it("leaves a short value alone", () => {
    expect(makeScrubber([{ name: "s", value: "short" }])("a short one")).toBe("a short one");
  });

  it("scrubDeep scrubs strings, not keys or numbers, without mutating", () => {
    const input = { [VALUE]: 5, a: [`v ${VALUE}`, 3], b: { c: VALUE } };
    const out = scrubDeep(input, scrub) as typeof input & Record<string, unknown>;
    expect(out).toEqual({ [VALUE]: 5, a: ["v [secret:k]", 3], b: { c: "[secret:k]" } });
    expect(input.b.c).toBe(VALUE);
  });
});
