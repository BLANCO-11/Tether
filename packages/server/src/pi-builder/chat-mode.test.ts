/**
 * Chat modes (0097): Workflow Builder and Forge Agent. Each gets the shared instructions plus its own; a Forge Agent
 * turn never changes the workflow (anything it changed is put back); what Forge is told each turn says which mode.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SANDBOXES_ROOT } from "./paths.js";
import { isChatMode, systemPromptFor } from "./instructions.js";
import { readBundle, restoreWorkflowSnapshot, workflowSnapshot } from "./sandbox-fs.js";
import { buildPrompt } from "./service.js";

describe("the instructions for each mode", () => {
  const workflow = systemPromptFor("workflow");
  const agent = systemPromptFor("agent");

  it("share the core: how to talk, the catalogue, files, asking", () => {
    for (const text of [workflow, agent]) {
      expect(text).toContain("## How you talk");
      expect(text).toContain("## Files in this chat");
      expect(text).toContain("## Asking the person");
      expect(text).toContain('"pick": "file"');
    }
  });

  it("give the building rules to Workflow Builder only, and the hands-off rule to Forge Agent only", () => {
    expect(workflow).toContain("# This chat: Workflow Builder");
    expect(workflow).toContain("## What you build");
    expect(workflow).not.toContain("# This chat: Forge Agent");
    expect(agent).toContain("# This chat: Forge Agent");
    expect(agent).toContain("never edit `workflow.json`");
    expect(agent).not.toContain("## What you build");
    expect(agent).not.toContain("# This chat: Workflow Builder");
  });

  it("teach that test data is invented, and that questions are asked in the person's words", () => {
    expect(workflow).toContain("Test data is invented, not a sample of the real data");
    for (const text of [workflow, agent]) {
      expect(text).toContain("Never ask about the test data");
      expect(text).toContain("column name (`entry_date_iso`");
      expect(text).toContain("Do not ask them to confirm what you can sensibly assume");
      expect(text).toContain("Find what the person names by its meaning, everywhere");
      expect(text).toContain("Forge Agent switch under the message box");
      expect(text).not.toContain("top of the chat");
    }
  });

  it("carry no leftover of the per-message intent rules", () => {
    for (const text of [workflow, agent]) expect(text).not.toMatch(/assistant mode/i);
  });

  it("knows its two modes and nothing else", () => {
    expect(isChatMode("workflow")).toBe(true);
    expect(isChatMode("agent")).toBe(true);
    expect(isChatMode("assistant")).toBe(false);
  });
});

describe("what Forge is told each turn", () => {
  it("names the mode, and in Forge Agent that the workflow is not its to change", () => {
    expect(buildPrompt("hi", "", undefined, "workflow")).toContain("This chat is in Workflow Builder mode");
    const agent = buildPrompt("hi", "", undefined, "agent");
    expect(agent).toContain("This chat is in Forge Agent mode");
    expect(agent).toContain("Never change workflow.json");
    expect(agent).not.toContain("put it back");
    expect(buildPrompt("hi", "", undefined, "agent", true)).toContain("Foundry put it back as it was");
  });
});

describe("the Forge Agent guard on the workflow", () => {
  const ws = `test-${randomUUID()}`;
  const sid = randomUUID();
  const sbx = join(SANDBOXES_ROOT, ws, sid, "sandbox");
  const outside = join(SANDBOXES_ROOT, ws, "server-file.txt");
  mkdirSync(join(sbx, "steps", "a"), { recursive: true });
  writeFileSync(outside, "untouched");
  afterAll(() => rmSync(join(SANDBOXES_ROOT, ws), { recursive: true, force: true }));

  it("puts back a changed workflow, removes added steps, and never writes through a link", () => {
    writeFileSync(join(sbx, "workflow.json"), JSON.stringify({ name: "Chase", steps: [{ id: "a" }] }));
    writeFileSync(join(sbx, "steps", "a", "main.py"), "def run(p, i): return {}\n");
    const before = workflowSnapshot(ws, sid);

    // The turn rewrites the step, adds one, and leaves links where the workflow and the goal were.
    writeFileSync(join(sbx, "steps", "a", "main.py"), "changed\n");
    mkdirSync(join(sbx, "steps", "b"), { recursive: true });
    writeFileSync(join(sbx, "steps", "b", "main.py"), "new\n");
    rmSync(join(sbx, "workflow.json"));
    symlinkSync(outside, join(sbx, "workflow.json"));
    rmSync(join(sbx, "GOAL.md"), { force: true });
    symlinkSync(outside, join(sbx, "GOAL.md"));
    expect(workflowSnapshot(ws, sid)).not.toBe(before);

    restoreWorkflowSnapshot(ws, sid, before, "Chase late invoices");
    expect(workflowSnapshot(ws, sid)).toBe(before);
    expect(Object.keys(readBundle(ws, sid).files)).toEqual(["steps/a/main.py"]);
    expect(readFileSync(join(sbx, "GOAL.md"), "utf8")).toContain("Chase late invoices");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });
});

describe("a conversation's folder size", () => {
  it("says what to do when full: remove chat files, or start a new chat when they are not the bulk", async () => {
    const { storageFullMessage } = await import("./service.js");
    const MB = 1024 * 1024;
    const mostlyFiles = storageFullMessage({ bytes: 310 * MB, limit: 300 * MB, chat: 250 * MB });
    expect(mostlyFiles).toContain("310 MB of its 300 MB");
    expect(mostlyFiles).toContain("Remove files you no longer need in the Files pane");
    expect(storageFullMessage({ bytes: 310 * MB, limit: 300 * MB, chat: 5 * MB })).toContain("start a new chat");
  });

  it("counts the chat's files apart from the rest, and a link as a link", async () => {
    const { folderUsage } = await import("./sandbox-fs.js");
    const ws = `test-${randomUUID()}`;
    const sid = randomUUID();
    const root = join(SANDBOXES_ROOT, ws, sid);
    const sbx = join(root, "sandbox");
    mkdirSync(join(sbx, "files"), { recursive: true });
    mkdirSync(join(sbx, "out"), { recursive: true });
    writeFileSync(join(sbx, "files", "a.csv"), "x".repeat(1000));
    writeFileSync(join(sbx, "out", "b.xlsx"), "y".repeat(500));
    writeFileSync(join(sbx, "workflow.json"), "z".repeat(100));
    const big = join(SANDBOXES_ROOT, ws, "big.bin");
    writeFileSync(big, "q".repeat(100_000));
    symlinkSync(big, join(sbx, "files", "link.bin"));
    try {
      const u = folderUsage(ws, sid);
      expect(u.chat).toBeGreaterThanOrEqual(1500);
      expect(u.chat).toBeLessThan(2000);
      expect(u.bytes).toBeGreaterThanOrEqual(1600);
      expect(u.bytes).toBeLessThan(5000);
    } finally {
      rmSync(join(SANDBOXES_ROOT, ws), { recursive: true, force: true });
    }
  });
});

describe("the note a mode switch leaves", () => {
  it("is one note for a run of switches, and none when the run ends where it started", async () => {
    const { withModeNote } = await import("./service.js");
    const said = { id: "u", role: "user" as const, text: "hi", at: "" };
    let m = withModeNote([said], "agent");
    expect(m).toHaveLength(2);
    expect(m.at(-1)?.text).toContain("Forge Agent");
    m = withModeNote(m, "workflow");
    expect(m).toEqual([said]);
    m = withModeNote(withModeNote(withModeNote(m, "agent"), "workflow"), "agent");
    expect(m).toHaveLength(2);
    expect(m.at(-1)?.modeSwitch).toEqual({ from: "workflow" });
  });

  it("starts a new note once something was said after the last one", async () => {
    const { withModeNote } = await import("./service.js");
    let m = withModeNote([], "agent");
    m = [...m, { id: "u2", role: "user" as const, text: "do it", at: "" }];
    m = withModeNote(m, "workflow");
    expect(m).toHaveLength(3);
    expect(m.filter((x) => x.modeSwitch)).toHaveLength(2);
  });
});
