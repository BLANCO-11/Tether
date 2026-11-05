/**
 * about_flow must not mutate the flow — Strategy B Phase 4b.
 * Asserts the assistant / chat-answers path does not call writeRevision.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("about_flow honesty", () => {
  it("flow-chat-builder about_flow branch never calls writeRevision or saveIncomplete", () => {
    const src = readFileSync(fileURLToPath(new URL("../flow-chat-builder.ts", import.meta.url)), "utf8");
    // Control: the file must contain about_flow handling at all.
    expect(src).toMatch(/case "about_flow"/);
    const after = src.slice(src.indexOf('case "about_flow"'));
    const untilNext = after.slice(0, after.indexOf("case \"capabilities\""));
    expect(untilNext).not.toMatch(/writeRevision/);
    expect(untilNext).not.toMatch(/saveIncomplete/);
    expect(untilNext).not.toMatch(/builderStart|builderRebuild|makePlan/);
  });

  it("CONTROL: build case still reaches builderStart", () => {
    const src = readFileSync(fileURLToPath(new URL("../flow-chat-builder.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/case "build"[\s\S]*builderStart/);
  });
});
