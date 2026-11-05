import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SANDBOXES_ROOT } from "./paths.js";
import { sandboxDir } from "./sandbox-fs.js";
import {
  chatFileNames,
  chatFileOnDisk,
  findAttachment,
  newOutputs,
  outDir,
  outSnapshot,
  layOutFiles,
  legacyAttachmentFolders,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
  removeAttachment,
  safeAttachmentName,
  storeAttachment,
} from "./attachments.js";
import { chatTitle, withAttachments } from "./service.js";

const ws = `test-att-${randomUUID()}`;
afterEach(() => rmSync(join(SANDBOXES_ROOT, ws), { recursive: true, force: true }));

const status = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? -1;
  }
};

describe("chat attachments", () => {
  it("keeps a file exactly as uploaded, under a safe name", () => {
    const body = Buffer.from("%PDF-1.4 hello");
    const a = storeAttachment(ws, "s1", body, "../../etc/Q3 report.pdf");
    expect(a).toEqual({ name: "Q3 report.pdf", size: body.length, type: "application/pdf" });
    // In the session's own sandbox, where Forge reads it.
    expect(readFileSync(join(sandboxDir(ws, "s1"), "files", a.name))).toEqual(body);
    expect(readAttachment(ws, "s1", a.name)).toEqual(body);
  });

  it("never replaces a file already attached under that name", () => {
    storeAttachment(ws, "s", Buffer.from("a"), "notes.txt");
    expect(storeAttachment(ws, "s", Buffer.from("b"), "notes.txt").name).toBe("notes (2).txt");
  });

  it("refuses what is not accepted (presentations, video, programs), an empty file, a file over 50 MB, and a missing name", () => {
    expect(status(() => storeAttachment(ws, "s", Buffer.from("x"), "run.exe"))).toBe(415);
    expect(status(() => storeAttachment(ws, "s", Buffer.from("x"), "old.doc"))).toBe(415);
    expect(status(() => storeAttachment(ws, "s", Buffer.from("x"), "deck.pptx"))).toBe(415);
    expect(status(() => storeAttachment(ws, "s", Buffer.from("x"), "clip.mp4"))).toBe(415);
    expect(status(() => storeAttachment(ws, "s", Buffer.alloc(0), "a.txt"))).toBe(400);
    expect(status(() => storeAttachment(ws, "s", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), "a.txt"))).toBe(413);
    expect(status(() => storeAttachment(ws, "s", Buffer.from("x"), null))).toBe(400);
    expect(status(() => safeAttachmentName("dir/"))).toBe(400);
    expect(status(() => storeAttachment(ws, "s", Buffer.from("x"), ".pdf"))).toBe(415);
  });

  it("finds and removes only regular files inside the store", () => {
    storeAttachment(ws, "s", Buffer.from("x"), "a.csv");
    expect(findAttachment(ws, "s", "../a.csv")).toBeNull();
    expect(findAttachment(ws, "s", "a.csv")?.type).toBe("text/csv");
    expect(removeAttachment(ws, "s", "a.csv")).toBe(true);
    expect(removeAttachment(ws, "s", "a.csv")).toBe(false);
  });

  it("a reopened chat's files are laid out where Forge reads them; a name already there is left alone", () => {
    storeAttachment(ws, "s2", Buffer.from("mine"), "spec.md");
    layOutFiles(ws, "s2", [
      { name: "spec.md", body: Buffer.from("stored") },
      { name: "rates.csv", body: Buffer.from("a,b") },
      { name: "../escape.txt", body: Buffer.from("no") },
    ]);
    expect(readFileSync(join(sandboxDir(ws, "s2"), "files", "spec.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(sandboxDir(ws, "s2"), "files", "rates.csv"), "utf8")).toBe("a,b");
    expect(existsSync(join(sandboxDir(ws, "s2"), "escape.txt"))).toBe(false);
  });

  it("finds the old layout's workflow chat files to move into saved chats, and nothing else", () => {
    const root = join(SANDBOXES_ROOT, ws, "legacy-root");
    mkdirSync(join(root, "w1", "_attachments", "flow-abc"), { recursive: true });
    writeFileSync(join(root, "w1", "_attachments", "flow-abc", "a.pdf"), "x");
    mkdirSync(join(root, "w1", "_attachments", "session-zzz"), { recursive: true });
    mkdirSync(join(root, "_catalog", "_attachments", "flow-q"), { recursive: true });
    expect(legacyAttachmentFolders(root)).toEqual([
      { workspaceId: "w1", flowId: "abc", dir: join(root, "w1", "_attachments", "flow-abc"), files: ["a.pdf"] },
    ]);
  });

  it("keeps what Forge made or changed in out/ this turn, and says why it cannot keep the rest", () => {
    const sid = "s-out";
    layOutFiles(ws, sid, [{ name: "old.csv", body: Buffer.from("a"), origin: "forge" }]);
    const before = outSnapshot(ws, sid);
    writeFileSync(join(outDir(ws, sid), "Rates (updated).xlsx"), "xlsx bytes");
    writeFileSync(join(outDir(ws, sid), "deck.pptx"), "nope");
    writeFileSync(join(outDir(ws, sid), "empty.txt"), "");
    const r = newOutputs(ws, sid, before);
    expect(r.kept.map((f) => f.name)).toEqual(["Rates (updated).xlsx"]);
    expect(r.kept[0]!.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(r.refused.map((f) => f.name).sort()).toEqual(["deck.pptx", "empty.txt"]);
    // Unchanged since the snapshot: not offered again.
    expect(newOutputs(ws, sid, outSnapshot(ws, sid)).kept).toEqual([]);
  });

  it("keeps a code or web file Forge made as plain text, never as a page, and a person still cannot attach one", () => {
    const sid = "s-code";
    const before = outSnapshot(ws, sid);
    mkdirSync(outDir(ws, sid), { recursive: true });
    writeFileSync(join(outDir(ws, sid), "mockup.html"), "<html><script>alert(1)</script></html>");
    writeFileSync(join(outDir(ws, sid), "app.tsx"), "export {}");
    const r = newOutputs(ws, sid, before);
    expect(r.kept.map((f) => [f.name, f.type]).sort()).toEqual([["app.tsx", "text/plain"], ["mockup.html", "text/plain"]]);
    expect(() => storeAttachment(ws, sid, Buffer.from("<html></html>"), "page.html")).toThrow(/cannot be attached/);
  });

  it("lists the chat's files in files/ and out/, so a file Forge deleted during a turn can be told apart", () => {
    layOutFiles(ws, "s4", [
      { name: "image.png", body: Buffer.from("p"), origin: "person" },
      { name: "old-map.png", body: Buffer.from("o"), origin: "forge" },
      { name: "new-art.png", body: Buffer.from("n"), origin: "forge" },
    ]);
    mkdirSync(join(outDir(ws, "s4"), "a-folder"), { recursive: true });
    const before = chatFileNames(ws, "s4");
    expect([...before].sort()).toEqual(["image.png", "new-art.png", "old-map.png"]); // a folder is not a file
    rmSync(join(outDir(ws, "s4"), "old-map.png")); // what Forge's `rm` does
    const after = chatFileNames(ws, "s4");
    expect([...before].filter((n) => !after.has(n))).toEqual(["old-map.png"]);
  });

  it("a workflow here reads the chat's file: Forge's own first, else the person's", () => {
    layOutFiles(ws, "s-read", [
      { name: "a.csv", body: Buffer.from("person"), origin: "person" },
      { name: "a.csv", body: Buffer.from("forge"), origin: "forge" },
      { name: "b.csv", body: Buffer.from("only person") },
    ]);
    expect(chatFileOnDisk(ws, "s-read", "a.csv")?.body.toString()).toBe("forge");
    expect(chatFileOnDisk(ws, "s-read", "b.csv")?.body.toString()).toBe("only person");
    expect(chatFileOnDisk(ws, "s-read", "../b.csv")).toBeNull();
    expect(chatFileOnDisk(ws, "s-read", "c.csv")).toBeNull();
  });

  it("names a chat by the person's first message, on one line, cut at a word", () => {
    expect(chatTitle("  Email me\nthe   report ", [], "")).toBe("Email me the report");
    const long = "Every Monday read the attendance sheet and email each manager the people who missed more than two days last week";
    const t = chatTitle(long, [], "");
    expect(t.length).toBeLessThanOrEqual(81);
    expect(t.endsWith("…")).toBe(true);
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
    expect(chatTitle("", ["spec.pdf"], "")).toBe("spec.pdf");
    expect(chatTitle("", [], "")).toBe("Untitled chat");
  });

  it("tells the agent where each file is, where a changed file goes, and how a workflow reads one; no files, the text as it was", () => {
    expect(withAttachments("hello", [])).toBe("hello");
    const told = withAttachments("", [{ name: "a.pdf", size: 2 * 1024 * 1024, type: "application/pdf" }]);
    expect(told).toContain("files/a.pdf (application/pdf, 2.0 MB)");
    expect(told).toContain("node tools/read-file.mjs");
    expect(told).toContain("out/<name>");
    expect(told).toContain('foundry.file("<name>")');
    expect(told).toContain("These files come first");
    expect(told).toContain("follow the file, unless this message says otherwise");
    expect(told).toContain("sent only the attached files");
  });
});

describe("removeOrphanedSessionTrees", () => {
  it("removes session trees and draft attachments; keeps a workflow's attachments and the catalogue", async () => {
    const { removeOrphanedSessionTrees } = await import("./sandbox-fs.js");
    const { tmpdir } = await import("node:os");
    const root = join(tmpdir(), `orphans-${randomUUID()}`);
    const w = join(root, "ws1");
    mkdirSync(join(w, randomUUID(), "sandbox"), { recursive: true });
    mkdirSync(join(w, "_attachments", "session-x"), { recursive: true });
    mkdirSync(join(w, "_attachments", "flow-y"), { recursive: true });
    mkdirSync(join(root, "_catalog", "ws1"), { recursive: true });
    mkdirSync(join(w, "not-a-session"), { recursive: true });
    mkdirSync(join(root, randomUUID(), "sandbox"), { recursive: true }); // the first, workspace-less layout
    expect(removeOrphanedSessionTrees(root)).toEqual({ trees: 2, draftFiles: 1 });
    expect(existsSync(join(w, "_attachments", "flow-y"))).toBe(true);
    expect(existsSync(join(w, "_attachments", "session-x"))).toBe(false);
    expect(existsSync(join(root, "_catalog", "ws1"))).toBe(true);
    expect(existsSync(join(w, "not-a-session"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
