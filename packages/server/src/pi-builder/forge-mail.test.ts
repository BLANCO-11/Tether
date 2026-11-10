import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SANDBOXES_ROOT } from "./paths.js";
import { sandboxDir } from "./sandbox-fs.js";
import {
  ForgeMailError,
  forgeMailBodySchema,
  resetForgeMailRateLimit,
  sendForgeMail,
  type ForgeMailContext,
  type ForgeMailDeps,
} from "./forge-mail.js";

const ws = `test-${randomUUID()}`;
const sid = randomUUID();
const sbx = sandboxDir(ws, sid);
mkdirSync(join(sbx, "out"), { recursive: true });
const secret = join(SANDBOXES_ROOT, ws, "secret.pdf");
writeFileSync(secret, "SECRET");
writeFileSync(join(sbx, "out", "report.pdf"), "PDFDATA");
writeFileSync(join(sbx, "out", "data.csv"), "a,b\n1,2\n");
writeFileSync(join(sbx, "out", "page.html"), "<b>x</b>");
writeFileSync(join(sbx, "out", "a.exe"), "MZ");
writeFileSync(join(sbx, ".forge-tool.json"), "{}");
symlinkSync(secret, join(sbx, "link.pdf"));
symlinkSync(join(SANDBOXES_ROOT, ws), join(sbx, "linkdir"));
afterAll(() => rmSync(join(SANDBOXES_ROOT, ws), { recursive: true, force: true }));

const ctx = (over: Partial<ForgeMailContext> = {}): ForgeMailContext => ({
  workspaceId: ws,
  sessionId: sid,
  chatId: "chat-1",
  mode: "agent",
  ownerSubject: "email:me@example.org",
  actor: "me",
  ...over,
});
const input = (attachments?: string[]) => ({ subject: "Hi", body: "Hello", attachments });

let clock = 1_000_000;
function mkDeps(over: Partial<ForgeMailDeps["caps"]> = {}) {
  const send = vi.fn(async () => ({ ok: true as const, messageId: "m1", requestId: null }));
  const record = vi.fn(async () => ({ id: "r1" }));
  const finish = vi.fn(async () => undefined);
  const lookupEmail = vi.fn(async () => "Found@Example.org");
  const deps: ForgeMailDeps = {
    lookupEmail,
    send,
    record,
    finish,
    audit: vi.fn(async () => undefined),
    now: () => clock,
    caps: { maxCount: 5, maxTotalBytes: 1_000_000, maxBodyBytes: 100_000, maxRecipients: 10, perHour: 10, ...over },
  };
  return { deps, send, record, finish, lookupEmail };
}
const status = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ForgeMailError);
    return (e as ForgeMailError).statusCode;
  }
  return 0;
};

beforeEach(() => {
  resetForgeMailRateLimit();
  clock = 1_000_000;
});

describe("sendForgeMail", () => {
  it("refuses outside Forge Agent, recording nothing", async () => {
    const d = mkDeps();
    expect(await status(sendForgeMail(ctx({ mode: "workflow" }), input(), d.deps))).toBe(403);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it("sends to the owner's own address as plain text", async () => {
    const d = mkDeps();
    const r = await sendForgeMail(ctx({ ownerSubject: "email:Me@Example.org" }), input(), d.deps);
    expect(r.sentTo).toBe("me@example.org");
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ to: ["me@example.org"], contentType: "Text" }));
  });

  it("looks a subject up", async () => {
    const d = mkDeps();
    const r = await sendForgeMail(ctx({ ownerSubject: "sub-123" }), input(), d.deps);
    expect(d.lookupEmail).toHaveBeenCalledWith("sub-123");
    expect(r.sentTo).toBe("found@example.org");
  });

  it("refuses when the owner has no address", async () => {
    for (const [subject, found] of [[null, "x@y.com"], ["sub", null]] as const) {
      const d = mkDeps();
      d.lookupEmail.mockResolvedValue(found as never);
      await expect(sendForgeMail(ctx({ ownerSubject: subject }), input(), d.deps)).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/no email address/) });
      expect(d.send).not.toHaveBeenCalled();
      expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused" }));
    }
  });

  it("accepts no recipient field", () => {
    expect(forgeMailBodySchema.safeParse({ subject: "s", body: "b", to: ["x@y.com"] }).success).toBe(false);
    expect(forgeMailBodySchema.safeParse({ subject: "s", body: "b", cc: ["x@y.com"] }).success).toBe(false);
    expect(forgeMailBodySchema.safeParse({ subject: "s", body: "b" }).success).toBe(true);
  });

  it.each([
    ["a symlink to a file", ["link.pdf"], {}],
    ["a symlinked folder", ["linkdir/secret.pdf"], {}],
    ["a parent path", ["../secret.pdf"], {}],
    ["an absolute path", [secret], {}],
    ["a hidden file", [".forge-tool.json"], {}],
    ["an html file", ["out/page.html"], {}],
    ["an exe", ["out/a.exe"], {}],
    ["a missing file", ["out/nope.pdf"], {}],
    ["too many files", ["out/report.pdf", "out/data.csv"], { maxCount: 1 }],
    ["too many bytes", ["out/report.pdf", "out/data.csv"], { maxTotalBytes: 10 }],
  ])("refuses %s", async (_n, paths, caps) => {
    const d = mkDeps(caps);
    expect(await status(sendForgeMail(ctx(), input(paths), d.deps))).toBe(422);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("attaches valid files", async () => {
    const d = mkDeps();
    const r = await sendForgeMail(ctx(), input(["out/report.pdf", "out/data.csv"]), d.deps);
    const m = (d.send.mock.calls[0] as unknown as [{ attachments: { name: string; contentType: string; data: Buffer }[] }])[0];
    expect(m.attachments.map((a) => [a.name, a.contentType, a.data.toString()])).toEqual([
      ["report.pdf", "application/pdf", "PDFDATA"],
      ["data.csv", "text/csv", "a,b\n1,2\n"],
    ]);
    expect(r.attachments).toEqual([
      { name: "report.pdf", bytes: 7 },
      { name: "data.csv", bytes: 8 },
    ]);
  });

  it("limits sends per hour", async () => {
    const d = mkDeps();
    for (let i = 0; i < 10; i++) await sendForgeMail(ctx(), input(), d.deps);
    d.record.mockClear();
    expect(await status(sendForgeMail(ctx(), input(), d.deps))).toBe(429);
    expect(d.record).not.toHaveBeenCalled();
    clock += 3_600_001;
    await expect(sendForgeMail(ctx(), input(), d.deps)).resolves.toMatchObject({ sentTo: "me@example.org" });
  });

  it("passes on a provider failure", async () => {
    const d = mkDeps();
    d.send.mockResolvedValue({ ok: false, status: 424, message: "email delivery is not configured", detail: {} } as never);
    await expect(sendForgeMail(ctx(), input(), d.deps)).rejects.toMatchObject({ statusCode: 424 });
    expect(d.finish).toHaveBeenCalledWith("r1", expect.objectContaining({ outcome: "failed" }));
  });
});
