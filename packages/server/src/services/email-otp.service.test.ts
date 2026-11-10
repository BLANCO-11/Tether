import { describe, it, expect, vi } from "vitest";
import {
  createSlidingWindowLimiter,
  createEmailOtp,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
} from "./email-otp.service.js";

function setup(opts: { allowed?: () => boolean; secret?: string } = {}) {
  let t = 1_000_000;
  const sent: Array<{ email: string; code: string }> = [];
  const onLogin = vi.fn(async () => {});
  const otp = createEmailOtp({
    secret: opts.secret ?? "s3cret",
    now: () => t,
    lookup: async (e) => ({ allowed: e.endsWith("@x.com") && (opts.allowed ? opts.allowed() : true) }),
    send: async (email, code) => {
      sent.push({ email, code });
      return true;
    },
    onLogin,
  });
  return { otp, sent, onLogin, advance: (ms: number) => (t += ms) };
}

describe("sliding window limiter", () => {
  it("allows 1 then refuses within 60s and allows after 61s", () => {
    let t = 0;
    const l = createSlidingWindowLimiter([{ windowMs: 60_000, max: 1 }], () => t);
    expect(l.hit("k").ok).toBe(true);
    t = 30_000;
    const r = l.hit("k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSeconds).toBe(30);
    t = 61_000;
    expect(l.hit("k").ok).toBe(true);
  });
  it("enforces the 5/hour cap", () => {
    let t = 0;
    const l = createSlidingWindowLimiter(
      [
        { windowMs: 60_000, max: 1 },
        { windowMs: 3_600_000, max: 5 },
      ],
      () => t,
    );
    for (let i = 0; i < 5; i++) {
      expect(l.hit("k").ok).toBe(true);
      t += 61_000;
    }
    expect(l.hit("k").ok).toBe(false);
  });
});

describe("email otp", () => {
  it("sends nothing for a non-allowlisted email but answers ok", async () => {
    const { otp, sent } = setup();
    expect(await otp.request("n@other.com", "1.1.1.1")).toEqual({ status: "ok" });
    expect(sent).toHaveLength(0);
    expect(otp._size()).toBe(0);
  });
  it("sends one 6-digit code for an allowed email and keeps only a hash", async () => {
    const { otp, sent } = setup();
    expect(await otp.request("a@x.com", "1.1.1.1")).toEqual({ status: "ok" });
    expect(sent).toHaveLength(1);
    expect(sent[0].code).toMatch(/^\d{6}$/);
    expect(otp._size()).toBe(1);
    expect(JSON.stringify(otp)).not.toContain(sent[0].code);
    expect(await otp.verify("a@x.com", sent[0].code, "1.1.1.1")).toEqual({ status: "ok", email: "a@x.com" });
  });
  it("rate limits a second request within 60s even for a non-allowlisted email", async () => {
    const { otp } = setup();
    await otp.request("n@other.com", "1.1.1.1");
    expect((await otp.request("n@other.com", "2.2.2.2")).status).toBe("rate_limited");
  });
  it("code is single use", async () => {
    const { otp, sent } = setup();
    await otp.request("a@x.com", "i");
    const code = sent[0].code;
    expect((await otp.verify("a@x.com", code, "i")).status).toBe("ok");
    expect((await otp.verify("a@x.com", code, "i")).status).toBe("invalid");
  });
  it("exhausts attempts after 5 wrong codes", async () => {
    const { otp, sent } = setup();
    await otp.request("a@x.com", "i");
    const wrong = sent[0].code === "000000" ? "111111" : "000000";
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect((await otp.verify("a@x.com", wrong, "i")).status).toBe("invalid");
    expect((await otp.verify("a@x.com", sent[0].code, "i")).status).toBe("invalid");
  });
  it("expires after the TTL", async () => {
    const { otp, sent, advance } = setup();
    await otp.request("a@x.com", "i");
    advance(CODE_TTL_MS + 1);
    expect((await otp.verify("a@x.com", sent[0].code, "i")).status).toBe("invalid");
    expect(otp._size()).toBe(0);
  });
  it("rejects a non-numeric code", async () => {
    const { otp } = setup();
    await otp.request("a@x.com", "i");
    expect((await otp.verify("a@x.com", "abcdef", "i")).status).toBe("invalid");
  });
  it("sends nothing with an empty secret", async () => {
    const { otp, sent } = setup({ secret: "" });
    expect(await otp.request("a@x.com", "i")).toEqual({ status: "ok" });
    expect(sent).toHaveLength(0);
  });
  it("is case-insensitive on email", async () => {
    const { otp, sent } = setup();
    await otp.request("A@X.com", "i");
    expect((await otp.verify("a@x.com", sent[0].code, "i")).status).toBe("ok");
  });
  it("rate limits verify per IP", async () => {
    const { otp } = setup();
    let last = "";
    for (let i = 0; i < 31; i++) last = (await otp.verify("a@x.com", "123456", "ip")).status;
    expect(last).toBe("rate_limited");
  });
  it("refuses when lookup flips to not allowed", async () => {
    let allowed = true;
    const { otp, sent, onLogin } = setup({ allowed: () => allowed });
    await otp.request("a@x.com", "i");
    allowed = false;
    expect((await otp.verify("a@x.com", sent[0].code, "i")).status).toBe("invalid");
    expect(onLogin).not.toHaveBeenCalled();
  });
  it("calls onLogin once on success", async () => {
    const { otp, sent, onLogin } = setup();
    await otp.request("a@x.com", "i");
    await otp.verify("a@x.com", sent[0].code, "i");
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLogin).toHaveBeenCalledWith("a@x.com");
  });
});
