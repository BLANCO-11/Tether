/**
 * Forge Agent's thinking level (0119) reaches the model as reasoning_effort: the level maps to an effort, the effort
 * travels to the process as PI_FORGE_REASONING_EFFORT, and luna-tools-compat.js puts it on the request.
 */
import { describe, expect, it } from "vitest";
import { reasoningEffort, isThinkingLevel, thinkingNote, THINKING_LEVELS } from "./thinking.js";
import { thinkingFromUpdate } from "./activity.js";
// @ts-expect-error a plain-JS pi extension, loaded by pi rather than by this package
import lunaCompat, { effortFor } from "../../pi-builder-template/pi-extensions/luna-tools-compat.js";

type Handler = (event: { payload: unknown }, ctx: { model?: { id: string } }) => Record<string, unknown> | undefined;
function onRequest(): Handler {
  const on: Record<string, Handler> = {};
  lunaCompat({ on: (name: string, fn: Handler) => (on[name] = fn) });
  return on.before_provider_request!;
}

describe("reasoningEffort", () => {
  it("maps each level in Forge Agent, Ultra included", () => {
    expect(THINKING_LEVELS.map((l) => reasoningEffort("agent", l))).toEqual(["low", "medium", "high", "xhigh"]);
  });
  it("is none in Workflow Builder, whatever the level", () => {
    for (const l of THINKING_LEVELS) expect(reasoningEffort("workflow", l)).toBe("none");
  });
  it("knows its levels", () => {
    expect(isThinkingLevel("ultra")).toBe(true);
    expect(isThinkingLevel("xhigh")).toBe(false);
    expect(isThinkingLevel(null)).toBe(false);
  });
});

describe("thinkingNote", () => {
  it("names the level the chat shows", () => {
    expect(thinkingNote("ultra")).toBe("Thinking: Ultra high.");
    expect(thinkingNote("balanced")).toBe("Thinking: Balanced.");
  });
});

describe("luna-tools-compat.js", () => {
  it("passes the process's effort to a model that takes it", () => {
    expect(effortFor("gpt-6-luna", "xhigh")).toBe("xhigh");
    expect(effortFor("gpt-6-luna", "medium")).toBe("medium");
  });
  it("keeps none for gpt-5.x luna, which refuses an effort with tools", () => {
    expect(effortFor("gpt-5.6-luna", "high")).toBe("none");
  });
  it("is none when nothing (or nonsense) was set", () => {
    expect(effortFor("gpt-6-luna", undefined)).toBe("none");
    expect(effortFor("gpt-6-luna", "max")).toBe("none");
  });
  it("sets the request's reasoning_effort from the environment, and leaves other models alone", () => {
    const run = onRequest();
    const before = process.env.PI_FORGE_REASONING_EFFORT;
    process.env.PI_FORGE_REASONING_EFFORT = "high";
    try {
      expect(run({ payload: { model: "x" } }, { model: { id: "gpt-6-luna" } })).toEqual({ model: "x", reasoning_effort: "high" });
      expect(run({ payload: { model: "x" } }, { model: { id: "qwen" } })).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.PI_FORGE_REASONING_EFFORT;
      else process.env.PI_FORGE_REASONING_EFFORT = before;
    }
  });
});

describe("thinkingFromUpdate", () => {
  const upd = (ame: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: ame });
  it("reads Pi's thinking events, and nothing else", () => {
    expect(thinkingFromUpdate(upd({ type: "thinking_start" }))).toEqual({ kind: "start" });
    expect(thinkingFromUpdate(upd({ type: "thinking_delta", delta: "Weigh 4 v 4" }))).toEqual({ kind: "delta", text: "Weigh 4 v 4" });
    expect(thinkingFromUpdate(upd({ type: "thinking_end" }))).toEqual({ kind: "end" });
    expect(thinkingFromUpdate(upd({ type: "text_delta", delta: "The ball is 0.05" }))).toBeNull();
    expect(thinkingFromUpdate(upd({ type: "thinking_delta", delta: "" }))).toBeNull();
  });
});
