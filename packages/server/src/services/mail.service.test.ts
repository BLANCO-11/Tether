/**
 * The SMTP transport — the only module that reads the mail credential.
 *
 * ⚠ **Zero real network calls.** `nodemailer` is mocked, and every assertion is
 * about what we would have handed it and how we read what came back.
 *
 * The most valuable assertions here are the negative ones:
 *
 *  - an unconfigured deployment names **every** missing variable at once,
 *  - `MAIL_ENABLED=false` is a **different** answer from unconfigured,
 *  - and the failure detail **never** carries the message body or the password.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mailConfigOverride: Record<string, unknown> = {};

vi.mock("../config/index.js", () => ({
  get config() {
    return {
      parentApiKey: "test-parent-key",
      mail: {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        user: "smtp-user",
        pass: "smtp-password-value",
        from: "Tether <automation@example.com>",
        allowedDomains: ["example.com"],
        enabled: true,
        maxBodyBytes: 262_144,
        maxRecipients: 10,
        selfBase: "http://localhost:4000",
        configured: true,
        missing: [] as string[],
        ...mailConfigOverride,
      },
    };
  },
}));

const sendMail = vi.hoisted(() => vi.fn());
const createTransport = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({ default: { createTransport } }));

const { mailService, resetMailTokenCache } = await import("./mail.service.js");

const MESSAGE = {
  subject: "Q3 close summary",
  body: "line one\nline two",
  to: ["her@example.com"],
  cc: [] as string[],
};

beforeEach(() => {
  mailConfigOverride = {};
  sendMail.mockReset();
  createTransport.mockReset();
  createTransport.mockImplementation(() => ({ sendMail, close: () => {} }));
  resetMailTokenCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("an unconfigured deployment says so, and never reports a false green", () => {
  it("refuses with 424 naming EVERY missing variable at once", async () => {
    mailConfigOverride = { host: "", from: "", configured: false, missing: ["SMTP_HOST", "MAIL_FROM"] };

    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(424);
    expect(r.detail).toMatchObject({ missing: ["SMTP_HOST", "MAIL_FROM"] });
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("gives MAIL_ENABLED=false a DISTINCT answer from unconfigured", async () => {
    mailConfigOverride = { enabled: false };

    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(409);
    expect(r.message).toMatch(/MAIL_ENABLED/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("checks disabled BEFORE unconfigured", async () => {
    mailConfigOverride = { enabled: false, configured: false, missing: ["MAIL_FROM"] };
    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(409);
  });
});

describe("the transport", () => {
  it("creates one transport from config.mail and reuses it across sends", async () => {
    sendMail.mockResolvedValue({ messageId: "<m1@example.com>" });
    await mailService.send(MESSAGE);
    await mailService.send(MESSAGE);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "smtp-user", pass: "smtp-password-value" },
    });
  });

  it("omits auth when no SMTP_USER is set", async () => {
    mailConfigOverride = { user: "", pass: "" };
    sendMail.mockResolvedValue({ messageId: "<m@example.com>" });
    await mailService.send(MESSAGE);
    expect(createTransport.mock.calls[0][0].auth).toBeUndefined();
  });

  it("resetMailTokenCache() gives a suite a cold transport", async () => {
    sendMail.mockResolvedValue({ messageId: "<m@example.com>" });
    await mailService.send(MESSAGE);
    resetMailTokenCache();
    await mailService.send(MESSAGE);
    expect(createTransport).toHaveBeenCalledTimes(2);
  });
});

describe("the message", () => {
  beforeEach(() => {
    sendMail.mockResolvedValue({ messageId: "<abc@example.com>" });
  });

  it("sends from MAIL_FROM as plain text by default, and returns the message id", async () => {
    const r = await mailService.send(MESSAGE);

    const sent = sendMail.mock.calls[0][0];
    expect(sent.from).toBe("Tether <automation@example.com>");
    expect(sent.to).toEqual(["her@example.com"]);
    expect(sent.subject).toBe("Q3 close summary");
    expect(sent.text).toBe("line one\nline two");
    expect(sent.html).toBeUndefined();
    expect(sent.cc).toBeUndefined();
    expect(r).toEqual({ ok: true, messageId: "<abc@example.com>", requestId: null });
  });

  it("sends html only when the caller asks for HTML", async () => {
    await mailService.send({ ...MESSAGE, body: "<table></table>", contentType: "HTML" });
    const sent = sendMail.mock.calls[0][0];
    expect(sent.html).toBe("<table></table>");
    expect(sent.text).toBeUndefined();
  });

  it("includes cc when there is one", async () => {
    await mailService.send({ ...MESSAGE, cc: ["c@example.com"] });
    expect(sendMail.mock.calls[0][0].cc).toEqual(["c@example.com"]);
  });

  it("passes attachments through as buffers", async () => {
    const data = Buffer.from("a,b\n1,2\n");
    await mailService.send({ ...MESSAGE, attachments: [{ name: "r.csv", contentType: "text/csv", data }] });
    expect(sendMail.mock.calls[0][0].attachments).toEqual([
      { filename: "r.csv", contentType: "text/csv", content: data },
    ]);
  });
});

describe("SMTP failures", () => {
  it("maps a connection error to 502 with a short detail", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:587"), { code: "ECONNECTION" }));
    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(502);
    expect(r.detail).toMatchObject({ code: "ECONNECTION" });
  });

  it("maps responseCode 552 to the too-large result", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("552 message exceeds limit"), { responseCode: 552 }));
    const r = await mailService.send(MESSAGE);
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(413);
    expect(r.detail).toMatchObject({ responseCode: 552 });
  });

  it("never puts the message body or the password into a failure", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("535 authentication failed"), { responseCode: 535 }));
    const r = await mailService.send({ ...MESSAGE, body: "SENTINEL-BODY payroll 3184.22" });
    if (r.ok) throw new Error("unreachable");
    expect(r.status).toBe(502);
    const s = JSON.stringify(r);
    expect(s).not.toContain("SENTINEL-BODY");
    expect(s).not.toContain("smtp-password-value");
  });
});
