import { describe, expect, it } from "vitest";
import { formatActiveMemories, MEMORY_INJECT_CHARS, pickMemoryCandidates } from "./project-memory.service.js";
import { projectLines } from "../pi-builder/service.js";

describe("formatActiveMemories", () => {
  it("keeps oldest first and stops at the char budget", () => {
    const rows = [
      { kind: "decision", body: "Use ISO dates." },
      { kind: "preference", body: "x".repeat(MEMORY_INJECT_CHARS) },
      { kind: "note", body: "Never seen." },
    ];
    const lines = formatActiveMemories(rows, 80);
    expect(lines).toEqual(["[decision] Use ISO dates."]);
    expect(lines.join("\n")).not.toContain("Never seen");
  });
});

describe("pickMemoryCandidates", () => {
  it("prefers recent short user lines and cue-bearing assistant lines, max 3", () => {
    const msgs = [
      { role: "user", text: "Hello there friend" },
      { role: "assistant", text: "Sure, I can help with that workflow." },
      { role: "user", text: "Always use UTC for due dates" },
      { role: "assistant", text: "Got it — we prefer ISO dates from now on." },
      { role: "user", text: "Call the sheet Payroll close" },
    ];
    const c = pickMemoryCandidates(msgs, 3);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatch(/UTC/);
    expect(c[2]).toMatch(/Payroll/);
  });

  it("skips tiny and huge lines", () => {
    expect(pickMemoryCandidates([{ role: "user", text: "hi" }, { role: "user", text: "x".repeat(600) }])).toEqual([]);
  });
});

describe("projectLines memories", () => {
  it("injects accepted memories after instructions", () => {
    const lines = projectLines({
      name: "Payroll",
      instructions: "Cite the pay period.",
      files: [],
      memories: [{ kind: "preference", body: "Always use UTC." }],
    });
    const joined = lines.join("\n");
    expect(joined).toContain("Cite the pay period.");
    expect(joined).toContain("remembered facts");
    expect(joined).toContain("[preference] Always use UTC.");
  });
});
