import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, bestMatch, commandsFor, exactCommand, parseSlash } from "@/lib/composer-commands";

describe("parseSlash", () => {
  it("parses name and argument", () => {
    expect(parseSlash("/")).toEqual({ name: "", arg: "", hasArg: false });
    expect(parseSlash("/mo")).toEqual({ name: "mo", arg: "", hasArg: false });
    expect(parseSlash("/model deep")).toEqual({ name: "model", arg: "deep", hasArg: true });
    expect(parseSlash("/model ")).toEqual({ name: "model", arg: "", hasArg: true });
    expect(parseSlash("hello")).toBeNull();
  });
});

describe("commandsFor", () => {
  it("filters by name prefix", () => {
    expect(commandsFor("", SLASH_COMMANDS).map((c) => c.name)).toEqual(["model", "think"]);
    expect(commandsFor("m", SLASH_COMMANDS).map((c) => c.name)).toEqual(["model"]);
    expect(commandsFor("x", SLASH_COMMANDS)).toEqual([]);
  });
});

describe("exactCommand", () => {
  it("matches an exact name and keeps the argument", () => {
    const hit = exactCommand("/model deep", SLASH_COMMANDS);
    expect(hit?.command.name).toBe("model");
    expect(hit?.arg).toBe("deep");
  });
  it("returns null for a path-like message", () => {
    expect(exactCommand("/etc/hosts", SLASH_COMMANDS)).toBeNull();
  });
});

describe("bestMatch", () => {
  it("picks a single label match", () => {
    const items = [
      { key: "gpt-6-luna", labels: ["GPT-6 Luna", "gpt-6-luna"] },
      { key: "DeepSeek-V4-Flash-0731", labels: ["DeepSeek V4 Flash", "DeepSeek-V4-Flash-0731"] },
    ];
    expect(bestMatch("deep", items).pick).toBe("DeepSeek-V4-Flash-0731");
  });
  it("returns all candidates when several match", () => {
    const items = [
      { key: "gpt-6-luna", labels: ["GPT-6 Luna"] },
      { key: "gpt-5.6-luna", labels: ["GPT-5.6 Luna"] },
    ];
    const out = bestMatch("gpt", items);
    expect(out.pick).toBeNull();
    expect(out.candidates).toHaveLength(2);
  });
  it("falls back to substring matching", () => {
    const items = [
      { key: "gpt-6-luna", labels: ["GPT-6 Luna"] },
      { key: "DeepSeek-V4-Flash-0731", labels: ["DeepSeek V4 Flash"] },
    ];
    expect(bestMatch("luna", items).pick).toBe("gpt-6-luna");
  });
  it("returns nothing when no tier hits", () => {
    const items = [{ key: "gpt-6-luna", labels: ["GPT-6 Luna"] }];
    expect(bestMatch("zzz", items)).toEqual({ pick: null, candidates: [] });
  });
  it("prefers an exact label over a prefix", () => {
    const items = [
      { key: "high", labels: ["high"] },
      { key: "higher", labels: ["higher"] },
    ];
    expect(bestMatch("high", items).pick).toBe("high");
  });
});
