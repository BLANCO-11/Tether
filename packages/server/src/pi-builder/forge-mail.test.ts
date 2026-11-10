import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SANDBOXES_ROOT } from "./paths.js";
import { sandboxDir } from "./sandbox-fs.js";
import {
  EMAIL_CONFIRM_TTL_MS,
  ForgeMailError,
  assertChatOwner,
  cancelForgeMail,
  chatRecipients,
  confirmForgeMail,
  forgeMailBodySchema,
  resetForgeMailRateLimit,
  sendForgeMail,
  type ForgeEmailDraft,
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
const audit = (d: { deps: ForgeMailDeps }) => d.deps.audit as unknown as ReturnType<typeof vi.fn>;
const sentOf = <T extends { status: string }>(r: T) => r as Extract<T, { status: "sent" }>;
const draftOf = async (d: ReturnType<typeof mkDeps>, over: Record<string, unknown> = {}, paths = ["out/report.pdf"]) => {
  const r = await sendForgeMail(ctx(), forgeMailBodySchema.parse({ ...input(paths), to: ["x@other.com"], ...over }), d.deps);
  if (r.status !== "pending") throw new Error("expected a draft");
  return r.draft;
};
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
    expect(sentOf(r).sentTo).toBe("me@example.org");
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ to: ["me@example.org"], contentType: "Text" }));
  });

  it("looks a subject up", async () => {
    const d = mkDeps();
    const r = await sendForgeMail(ctx({ ownerSubject: "sub-123" }), input(), d.deps);
    expect(d.lookupEmail).toHaveBeenCalledWith("sub-123");
    expect(sentOf(r).sentTo).toBe("found@example.org");
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

  it("accepts to and cc but nothing else", () => {
    const p = (extra: object) => forgeMailBodySchema.safeParse({ subject: "s", body: "b", ...extra });
    expect(p({ to: ["x@y.com"] }).success).toBe(true);
    expect(p({ cc: ["x@y.com"] }).success).toBe(true);
    expect(p({}).success).toBe(true);
    const parsed = p({ to: [" A@B.com "] });
    expect(parsed.success && parsed.data.to).toEqual(["a@b.com"]);
    expect(p({ to: ["not-an-email"] }).success).toBe(false);
    expect(p({ to: Array.from({ length: 21 }, (_, i) => `u${i}@x.com`) }).success).toBe(false);
    expect(p({ bcc: ["x@y.com"] }).success).toBe(false);
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
    expect(sentOf(r).attachments).toEqual([
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
    await expect(sendForgeMail(ctx(), input(), d.deps)).resolves.toMatchObject({ status: "sent", sentTo: "me@example.org" });
  });

  it("passes on a provider failure", async () => {
    const d = mkDeps();
    d.send.mockResolvedValue({ ok: false, status: 424, message: "email delivery is not configured", detail: {} } as never);
    await expect(sendForgeMail(ctx(), input(), d.deps)).rejects.toMatchObject({ statusCode: 424 });
    expect(d.finish).toHaveBeenCalledWith("r1", expect.objectContaining({ outcome: "failed" }));
  });
});

describe("chatRecipients", () => {
  const owner = "me@example.org";
  it("dedupes to and drops a cc already in to", () => {
    expect(chatRecipients({ to: ["a@x.com", "b@x.com", "a@x.com"], cc: ["b@x.com", "c@x.com", "c@x.com"] }, owner)).toEqual({
      to: ["a@x.com", "b@x.com"],
      cc: ["c@x.com"],
      ownerOnly: false,
    });
  });
  it("defaults to the owner", () => {
    expect(chatRecipients({}, owner)).toEqual({ to: [owner], cc: [], ownerOnly: true });
    expect(chatRecipients({ to: [owner] }, owner).ownerOnly).toBe(true);
    expect(chatRecipients({ to: [owner], cc: ["o@x.com"] }, owner).ownerOnly).toBe(false);
  });
  it("refuses without an owner, with only cc, and with too many", () => {
    expect(() => chatRecipients({}, null)).toThrow(/no email address/);
    expect(() => chatRecipients({ cc: ["a@x.com"] }, owner)).toThrow(/at least one address in --to/);
    const many = (n: number, t: string) => Array.from({ length: n }, (_, i) => `${t}${i}@x.com`);
    try {
      chatRecipients({ to: many(15, "t"), cc: many(6, "c") }, owner);
      expect.unreachable();
    } catch (e) {
      expect((e as ForgeMailError).statusCode).toBe(422);
      expect((e as ForgeMailError).message).toMatch(/21.*20/);
    }
  });
});

describe("assertChatOwner", () => {
  it("only lets the owner through", () => {
    expect(() => assertChatOwner("s1", "s1")).not.toThrow();
    expect(() => assertChatOwner("s1", "s2")).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => assertChatOwner(null, "s1")).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => assertChatOwner("s1", null)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

describe("drafts", () => {
  it("sends at once with no recipients or only the owner", async () => {
    for (const extra of [{}, { to: ["me@example.org"] }]) {
      const d = mkDeps();
      const r = await sendForgeMail(ctx(), { ...input(), ...extra }, d.deps);
      expect(r).toMatchObject({ status: "sent", to: ["me@example.org"], cc: [] });
      expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ to: ["me@example.org"] }));
    }
  });

  it.each([
    ["another to", { to: ["X@Other.com"] }, ["x@other.com"], []],
    ["a cc next to the owner", { to: ["me@example.org"], cc: ["Other@x.com"] }, ["me@example.org"], ["other@x.com"]],
  ])("holds %s as a draft", async (_n, extra, to, cc) => {
    const d = mkDeps();
    const r = await sendForgeMail(ctx(), forgeMailBodySchema.parse({ ...input(["out/report.pdf"]), ...extra }), d.deps);
    expect(r.status).toBe("pending");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
    expect(audit(d)).not.toHaveBeenCalled();
    if (r.status !== "pending") return;
    expect(r.draft).toEqual({
      to,
      cc,
      subject: "Hi",
      body: "Hello",
      attachments: [
        { path: "out/report.pdf", name: "report.pdf", bytes: 7, sha256: createHash("sha256").update("PDFDATA").digest("hex") },
      ],
      expiresAt: new Date(clock + EMAIL_CONFIRM_TTL_MS).toISOString(),
    });
  });

  it("confirm sends exactly the draft", async () => {
    const d = mkDeps();
    const draft = await draftOf(d, { cc: ["o@x.com"] });
    const r = await confirmForgeMail(ctx({ mode: "workflow" }), draft, { label: "Me" }, d.deps);
    expect(r.outcome).toBe("sent");
    expect(d.send).toHaveBeenCalledTimes(1);
    const m = (d.send.mock.calls[0] as unknown as [Record<string, unknown> & { attachments: { data: Buffer }[] }])[0];
    expect(m).toMatchObject({ to: draft.to, cc: draft.cc, subject: "Hi", body: "Hello", contentType: "Text" });
    expect(m.attachments.map((a) => a.data)).toEqual([Buffer.from("PDFDATA")]);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: draft.to, cc: draft.cc, resolvedFrom: "explicit" }),
    );
    expect(d.finish).toHaveBeenCalledWith("r1", expect.objectContaining({ outcome: "sent" }));
    expect(audit(d)).toHaveBeenCalledWith(expect.objectContaining({ actor: "Me" }));
  });

  it("confirm refuses a file that changed", async () => {
    const d = mkDeps();
    const draft = await draftOf(d);
    const f = join(sbx, "out", "report.pdf");
    writeFileSync(f, "OTHER!!");
    try {
      const r = await confirmForgeMail(ctx(), draft, { label: "Me" }, d.deps);
      expect(r.outcome).toBe("failed");
      expect(d.send).not.toHaveBeenCalled();
      expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refused" }));
    } finally {
      writeFileSync(f, "PDFDATA");
    }
  });

  it("confirm after expiry sends nothing", async () => {
    const d = mkDeps();
    const draft = await draftOf(d);
    clock += EMAIL_CONFIRM_TTL_MS + 1;
    const r = await confirmForgeMail(ctx(), draft, { label: "Me" }, d.deps);
    expect(r.outcome).toBe("expired");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused", failureReason: expect.stringMatching(/^expired:/) }),
    );
  });

  it("cancel sends nothing", async () => {
    const d = mkDeps();
    const draft: ForgeEmailDraft = await draftOf(d);
    await cancelForgeMail(ctx(), draft, { label: "Me" }, d.deps);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused", failureReason: expect.stringMatching(/^cancelled:/) }),
    );
  });

  it("rate limits confirms and new drafts", async () => {
    const d = mkDeps({ perHour: 2 });
    const draft = await draftOf(d);
    for (let i = 0; i < 2; i++) await confirmForgeMail(ctx(), draft, { label: "Me" }, d.deps);
    d.record.mockClear();
    expect(await status(confirmForgeMail(ctx(), draft, { label: "Me" }, d.deps))).toBe(429);
    expect(await status(sendForgeMail(ctx(), { ...input(), to: ["x@other.com"] }, d.deps))).toBe(429);
    expect(d.record).not.toHaveBeenCalled();
  });
});
