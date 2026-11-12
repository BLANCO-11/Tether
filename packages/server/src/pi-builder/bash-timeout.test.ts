/**
 * Every Forge bash command stops on its own (pi-builder-template/pi-extensions/bash-timeout.js, 2026-10-21): pi's bash
 * tool has no default timeout, and a chat sat on a running timer for 4 m 45 s until the person pressed Stop.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain-JS pi extension, loaded by pi rather than by this package
import bashTimeout, { DEFAULT_S, MAX_S } from "../../pi-builder-template/pi-extensions/bash-timeout.js";

type Handler = (event: { toolName: string; input: Record<string, unknown> }) => unknown;
function onToolCall(): Handler {
  const on: Record<string, Handler> = {};
  bashTimeout({ on: (name: string, fn: Handler) => (on[name] = fn) });
  return on.tool_call!;
}
const run = (toolName: string, input: Record<string, unknown>) => {
  onToolCall()({ toolName, input });
  return input;
};

describe("bash timeout", () => {
  it("gives a command sent without a timeout the default", () => {
    expect(run("bash", { command: "python3 x.py" }).timeout).toBe(DEFAULT_S);
  });
  it("keeps a shorter timeout the model asked for", () => {
    expect(run("bash", { command: "ls", timeout: 30 }).timeout).toBe(30);
  });
  it("caps a longer one", () => {
    expect(run("bash", { command: "x", timeout: 100_000 }).timeout).toBe(MAX_S);
  });
  it("replaces a zero, negative or unreadable timeout (none of them stop anything)", () => {
    for (const timeout of [0, -5, "soon", null]) expect(run("bash", { command: "x", timeout }).timeout).toBe(DEFAULT_S);
  });
  it("leaves other tools alone", () => {
    expect(run("read", { path: "a.txt" })).toEqual({ path: "a.txt" });
  });
  it("is loaded by the runner", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./pi-runner.ts", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toMatch(/join\(ext, "bash-timeout\.js"\)/);
    expect(src).toMatch(/\["luna-tools-compat\.js", "image-budget\.js", "bash-timeout\.js", "tether-gateway\.js"\]/);
  });
});
