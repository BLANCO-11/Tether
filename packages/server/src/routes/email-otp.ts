// src/routes/email-otp.ts — the email sign-in code, asked for and checked before
// anybody has a session. There is no identity here: it is what mints one, so the
// API key (checked at the mount) is all it has, and the service carries its own
// per-address and per-IP throttles.
//
// The caller is the web server holding the API key, so the client IP it forwards
// in `clientIp` is trusted over `req.ip`. The code is never logged.
import { Router, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { emailOtpService } from "../services/email-otp.service.js";
import { allowedUserService, normalizeEmail } from "../services/allowed-user.service.js";

export const emailOtpRouter = Router();

const requestSchema = z
  .object({ email: z.string().max(320), clientIp: z.string().max(100).optional() })
  .strict();

const verifySchema = z
  .object({ email: z.string().max(320), code: z.string().max(12), clientIp: z.string().max(100).optional() })
  .strict();

const statusSchema = z.object({ email: z.string().max(320) }).strict();

function rateLimited(res: Response, retryAfterSeconds: number) {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error: "rate_limited",
    retryAfterSeconds,
    message: "Too many sign-in code requests. Wait a few minutes and try again.",
  });
}

emailOtpRouter.post(
  "/request",
  asyncHandler(async (req, res) => {
    const body = requestSchema.parse(req.body);
    const ip = body.clientIp || req.ip || "unknown";
    const result = await emailOtpService.request(body.email, ip);
    if (result.status === "rate_limited") return rateLimited(res, result.retryAfterSeconds);
    // Always the same answer: never say whether the address is allowed.
    res.json({ ok: true });
  }),
);

emailOtpRouter.post(
  "/verify",
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body);
    const ip = body.clientIp || req.ip || "unknown";
    const result = await emailOtpService.verify(body.email, body.code, ip);
    if (result.status === "rate_limited") return rateLimited(res, result.retryAfterSeconds);
    if (result.status === "invalid") {
      res.status(401).json({ error: "invalid_code" });
      return;
    }
    // The subject is stable per address; workspace membership is keyed on it.
    res.json({ user: { subject: `email:${result.email}`, email: result.email, name: null } });
  }),
);

/** The web server re-checks live sessions with this. */
emailOtpRouter.post(
  "/status",
  asyncHandler(async (req, res) => {
    const { email } = statusSchema.parse(req.body);
    res.json(await allowedUserService.accessFor(normalizeEmail(email)));
  }),
);
