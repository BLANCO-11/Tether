import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every colour token must take an opacity modifier (2026-10-10). A raw "var(--x)" colour makes Tailwind DROP
 * `border-line/50` and friends with no error — 101 uses rendered nothing, and a dropped border colour fell back to the
 * preflight grey (the bright outline in dark mode).
 */
describe("tailwind colour tokens", () => {
  const src = readFileSync(resolve(__dirname, "../../tailwind.config.ts"), "utf8");
  const colors = src.slice(src.indexOf("colors: {"), src.indexOf("},", src.indexOf("colors: {")));

  it("CONTROL: the colours block was found and holds tokens", () => {
    expect(colors).toContain('line: mix("--line")');
  });

  it("no colour is a plain var(--x) string — each is mix(...) or carries <alpha-value>", () => {
    const plain = [...colors.matchAll(/^\s*"?([a-z0-9-]+)"?\s*:\s*"(var\([^"]+\))"/gm)].map((m) => m[1]);
    expect(plain).toEqual([]);
  });
});
