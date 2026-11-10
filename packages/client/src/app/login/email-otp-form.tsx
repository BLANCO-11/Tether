// src/app/login/email-otp-form.tsx — the primary sign-in: email, then a 6-digit code (the
// "email-otp" Credentials provider in src/auth.ts). Same Field/Input/Button as the password form.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { requestLoginCode } from "./actions";

export function EmailOtpForm({ next = "/dashboard" }: { next?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendCode() {
    const res = await requestLoginCode(email.trim());
    if (res.ok) {
      setStep("code");
      setCode("");
      return true;
    }
    setError(res.message);
    return false;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (step === "email") {
        if (!email.trim()) return setError("Enter your email.");
        await sendCode();
      } else {
        const res = await signIn("email-otp", { email: email.trim(), code, redirect: false });
        if (res?.error || res?.ok === false) {
          setError("That code didn't work. Check it, or request a new one.");
        } else {
          router.push(next);
          router.refresh();
        }
      }
    } catch {
      setError(step === "email" ? "Couldn't send a code right now. Try again." : "That code didn't work. Check it, or request a new one.");
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setError("");
    setLoading(true);
    try {
      await sendCode();
    } catch {
      setError("Couldn't send a code right now. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
      )}
      {step === "email" ? (
        <>
          <Field label="Email">
            <Input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Sending…" : "Email me a code"}
          </Button>
        </>
      ) : (
        <>
          <p role="status" className="text-xs text-muted">
            If {email.trim()} is allowed to sign in, a 6-digit code is on its way. It expires in 10 minutes.
          </p>
          <Field label="Code">
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
          <div className="flex justify-between">
            <button type="button" onClick={resend} disabled={loading} className="text-xs text-muted underline hover:text-text">
              Send a new code
            </button>
            <button
              type="button"
              onClick={() => { setStep("email"); setCode(""); setError(""); }}
              className="text-xs text-muted underline hover:text-text"
            >
              Use a different email
            </button>
          </div>
        </>
      )}
    </form>
  );
}
