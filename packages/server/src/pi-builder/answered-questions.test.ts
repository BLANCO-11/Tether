/**
 * An answered question leaves the card by CODE, in `answer()` — never left for Forge to clear (chat 4ecefa5a: Forge
 * Agent forgot, the same card came back after its reply, and the person answered it twice). Read off the source because
 * `answer()` starts a Forge turn; what matters is that the clear exists and runs AFTER the two settles, each of which
 * rewrites questions.json from the questions as asked and would otherwise put the answered ones back.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
const body = src.slice(src.indexOf("async answer("), src.indexOf("async verify("));

describe("answering clears the card", () => {
  it("CONTROL: the scan found answer()", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("settleBlankColumns(");
  });
  it("removes every answered question, after both settles", () => {
    const clear = body.indexOf("writeQuestionsRaw(s.workspaceId, s.id, asked.filter((q) => !answeredIds.has(q.id)))");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(body.indexOf("settleHeldAllowances("));
    expect(clear).toBeGreaterThan(body.indexOf("settleBlankColumns("));
  });
  it("no longer asks Forge to clear it", () => {
    expect(body).not.toMatch(/`Answers are in answers\.json[^`]*Clear questions\.json/);
    expect(body).toMatch(/`Answers are in answers\.json[^`]*off the card/);
  });
});
