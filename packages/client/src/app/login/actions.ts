"use server";
// src/app/login/actions.ts — asks the API server to email a sign-in code. Server-side only, so
// PARENT_API_KEY never reaches the browser. The answer is deliberately generic.
import { headers } from "next/headers";

type Result = { ok: true } | { ok: false; message: string };

const GENERIC_FAILURE = "Couldn't send a code right now. Try again.";

export async function requestLoginCode(email: string): Promise<Result> {
  const base = process.env.PARENT_API_URL ?? "http://localhost:4000";
  const key = process.env.PARENT_API_KEY ?? "";
  if (!key) return { ok: false, message: GENERIC_FAILURE };
  const h = await headers();
  const clientIp = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || undefined;
  try {
    const r = await fetch(`${base}/api/email-otp/request`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ email, clientIp }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 429) {
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      return { ok: false, message: body.message ?? "Too many requests. Wait a few minutes and try again." };
    }
    return { ok: false, message: GENERIC_FAILURE };
  } catch {
    return { ok: false, message: GENERIC_FAILURE };
  }
}
