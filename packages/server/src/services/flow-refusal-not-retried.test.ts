/**
 * ⚠ **A FRAGMENT REFUSAL IS RETURNED, NEVER RETRIED (§6.7).**
 *
 * The drafter half of this file (T3, `BD-003`) went with `draftFlow` (phase 8,
 * D-333). What survives is the fragment path: re-asking a correct
 * `insufficient_contract` is how it becomes an invented `period="2023-10"` on
 * attempt 2. Source-read with a control.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** ⚠ Comments stripped — every docblock here names the symbols it asserts on. */
const SRC = (() => {
  const raw = readFileSync(
    fileURLToPath(new URL("./flow-generation.service.ts", import.meta.url)),
    "utf8",
  );
  expect(raw.length).toBeGreaterThan(3_000);
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
})();

describe("the refusal rule on the fragment path", () => {
  it("generateFragments still states and keeps it", () => {
    const start = SRC.indexOf("async function generateFragments");
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, start + 6000);
    expect(body).toContain("insufficient_contract");
  });
});
