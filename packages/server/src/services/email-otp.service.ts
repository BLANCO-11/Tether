import crypto from "node:crypto";
import { config } from "../config/index.js";
import { allowedUserService } from "./allowed-user.service.js";
import { sendSystemMail } from "./mail.service.js";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const EMAIL_REQUEST_LIMITS = [
  { windowMs: 60_000, max: 1 },
  { windowMs: 3_600_000, max: 5 },
];
export const IP_REQUEST_LIMITS = [{ windowMs: 15 * 60_000, max: 20 }];
export const IP_VERIFY_LIMITS = [{ windowMs: 15 * 60_000, max: 30 }];

export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function createSlidingWindowLimiter(rules: Array<{ windowMs: number; max: number }>, now: () => number) {
  const hits = new Map<string, number[]>();
  const largest = Math.max(0, ...rules.map((r) => r.windowMs));
  return {
    hit(key: string): LimitResult {
      const t = now();
      const stamps = (hits.get(key) ?? []).filter((s) => t - s < largest);
      let retryMs = 0;
      for (const r of rules) {
        const inWindow = stamps.filter((s) => t - s < r.windowMs);
        if (inWindow.length >= r.max) {
          // The oldest hit that must age out before there is room again.
          const frees = inWindow[inWindow.length - r.max] + r.windowMs - t;
          retryMs = Math.max(retryMs, frees);
        }
      }
      if (retryMs > 0) {
        if (stamps.length) hits.set(key, stamps);
        else hits.delete(key);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
      }
      stamps.push(t);
      hits.set(key, stamps);
      return { ok: true };
    },
    reset() {
      hits.clear();
    },
  };
}

export type OtpRequestResult = { status: "ok" } | { status: "rate_limited"; retryAfterSeconds: number };
export type OtpVerifyResult =
  | { status: "ok"; email: string }
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfterSeconds: number };

type Entry = { hash: Buffer; expiresAt: number; attempts: number };

export function createEmailOtp(deps: {
  secret: string;
  now?: () => number;
  randomCode?: () => string;
  lookup: (email: string) => Promise<{ allowed: boolean }>;
  send: (email: string, code: string) => Promise<boolean>;
  onLogin?: (email: string) => Promise<void>;
}) {
  const now = deps.now ?? Date.now;
  const randomCode = deps.randomCode ?? (() => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0"));
  const entries = new Map<string, Entry>();
  const ipRequest = createSlidingWindowLimiter(IP_REQUEST_LIMITS, now);
  const emailRequest = createSlidingWindowLimiter(EMAIL_REQUEST_LIMITS, now);
  const ipVerify = createSlidingWindowLimiter(IP_VERIFY_LIMITS, now);

  const hash = (email: string, code: string) =>
    crypto.createHmac("sha256", deps.secret).update(`${email}:${code}`).digest();

  return {
    async request(rawEmail: string, ip: string): Promise<OtpRequestResult> {
      const email = rawEmail.trim().toLowerCase();
      const byIp = ipRequest.hit(ip);
      if (!byIp.ok) return { status: "rate_limited", retryAfterSeconds: byIp.retryAfterSeconds };
      const byEmail = emailRequest.hit(email);
      if (!byEmail.ok) return { status: "rate_limited", retryAfterSeconds: byEmail.retryAfterSeconds };

      if (!deps.secret || !email.includes("@")) return { status: "ok" };
      if (!(await deps.lookup(email)).allowed) return { status: "ok" };

      const code = randomCode();
      entries.set(email, { hash: hash(email, code), expiresAt: now() + CODE_TTL_MS, attempts: 0 });
      const sent = await deps.send(email, code);
      if (!sent) {
        entries.delete(email);
        console.warn("[email-otp] sign-in code could not be sent");
      }
      return { status: "ok" };
    },

    async verify(rawEmail: string, code: string, ip: string): Promise<OtpVerifyResult> {
      const email = rawEmail.trim().toLowerCase();
      const byIp = ipVerify.hit(ip);
      if (!byIp.ok) return { status: "rate_limited", retryAfterSeconds: byIp.retryAfterSeconds };
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) return { status: "invalid" };
      const entry = entries.get(email);
      if (!entry) return { status: "invalid" };
      if (now() > entry.expiresAt) {
        entries.delete(email);
        return { status: "invalid" };
      }
      entry.attempts += 1;
      if (entry.attempts > MAX_ATTEMPTS) {
        entries.delete(email);
        return { status: "invalid" };
      }
      const given = hash(email, code);
      const match = given.length === entry.hash.length && crypto.timingSafeEqual(given, entry.hash);
      if (!match) {
        if (entry.attempts >= MAX_ATTEMPTS) entries.delete(email);
        return { status: "invalid" };
      }
      entries.delete(email);
      if (!(await deps.lookup(email)).allowed) return { status: "invalid" };
      await deps.onLogin?.(email);
      return { status: "ok", email };
    },

    _size: () => entries.size,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const emailOtpService = createEmailOtp({
  secret: config.identity.secret,
  lookup: (e) => allowedUserService.accessFor(e),
  send: async (to, code) =>
    (
      await sendSystemMail(
        to,
        "Your Tether sign-in code",
        `Your Tether sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.`,
        `<p>Your Tether sign-in code is <strong>${escapeHtml(code)}</strong></p><p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p>`,
      )
    ).ok,
  onLogin: (e) => allowedUserService.markLogin(e),
});
