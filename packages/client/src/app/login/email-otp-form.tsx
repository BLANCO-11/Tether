// src/app/login/email-otp-form.tsx — the primary sign-in: email, then a 6-digit code (the
// "email-otp" Credentials provider in src/auth.ts). Animated: the email step slides into the code step, the card height
// follows, the code is six digit boxes (auto-advance, paste, auto-submit) and a wrong code shakes. Motion is CSS only
// (classes `lg-*` in globals.css) and switches off under prefers-reduced-motion.
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GoogleMark } from "@/components/ui/GoogleMark";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { requestLoginCode } from "./actions";

const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;
const BAD_CODE = "That code didn't work. Check it, or request a new one.";

/** Small inline spinner for pending buttons. */
export function Spinner() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Animated checkmark for the short success state before the redirect. */
export function CheckMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="lg-check lg-check-pop h-4 w-4" fill="none">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Submit button of the Google server-action form (the action itself stays in page.tsx). Shows a spinner while pending. */
export function GoogleButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" className="lg-press w-full gap-2.5" disabled={pending}>
      {pending ? <Spinner /> : <GoogleMark />}
      Continue with Google
    </Button>
  );
}

/** Six digit boxes. Reports the combined string on every change and calls `onComplete` when all six are filled. */
function CodeBoxes({ value, onChange, onComplete, disabled, shake, inputRef }: {
  value: string;
  onChange: (v: string) => void;
  onComplete: (v: string) => void;
  disabled: boolean;
  shake: boolean;
  inputRef: React.MutableRefObject<(HTMLInputElement | null)[]>;
}) {
  const refs = inputRef;
  const digits = Array.from({ length: CODE_LENGTH }, (_, i) => value[i] ?? "");

  function fill(from: number, raw: string) {
    let incoming = raw.replace(/\D/g, "");
    if (!incoming) return;
    // Typing into a box that already holds a digit gives e.g. "12": keep the newly typed one.
    if (incoming.length === 2 && digits[from]) incoming = incoming.replace(digits[from], "") || incoming.slice(-1);
    const next = digits.slice();
    let i = from;
    for (const ch of incoming) {
      if (i >= CODE_LENGTH) break;
      next[i++] = ch;
    }
    const joined = next.join("");
    onChange(joined);
    refs.current[Math.min(i, CODE_LENGTH - 1)]?.focus();
    if (joined.length === CODE_LENGTH && next.every(Boolean)) onComplete(joined);
  }

  function onKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      e.preventDefault();
      const next = digits.slice();
      if (next[i]) {
        next[i] = "";
        onChange(next.join(""));
      } else if (i > 0) {
        next[i - 1] = "";
        onChange(next.join(""));
        refs.current[i - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) {
      e.preventDefault();
      refs.current[i + 1]?.focus();
    }
  }

  return (
    <div role="group" aria-label="6-digit code" className={`grid grid-cols-6 gap-2 ${shake ? "lg-shake" : ""}`}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1} of ${CODE_LENGTH}`}
          className="lg-digit"
          data-filled={d ? "true" : "false"}
          value={d}
          disabled={disabled}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => fill(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={(e) => {
            e.preventDefault();
            fill(i, e.clipboardData.getData("text"));
          }}
        />
      ))}
    </div>
  );
}

export function EmailOtpForm({ next = "/dashboard" }: { next?: string }) {
  const router = useRouter();
  // `shown` is what is rendered; `step` is where we are headed — they differ for the 160ms exit animation.
  const [step, setStep] = useState<"email" | "code">("email");
  const [shown, setShown] = useState<"email" | "code">("email");
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [shake, setShake] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const panel = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);

  // Card height follows the visible panel so the swap does not jump.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    setHeight(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const go = useCallback((to: "email" | "code", direction: "fwd" | "back") => {
    setDir(direction);
    setStep(to);
    setTimeout(() => setShown(to), 160);
  }, []);

  // Land on the first box when the code step appears.
  useEffect(() => {
    if (shown === "code") boxes.current[0]?.focus();
  }, [shown]);

  async function sendCode() {
    const res = await requestLoginCode(email.trim());
    if (res.ok) {
      setCode("");
      setCooldown(RESEND_SECONDS);
      return true;
    }
    setError(res.message);
    return false;
  }

  async function verify(value: string) {
    if (busy.current) return;
    busy.current = true;
    setError("");
    setLoading(true);
    try {
      const res = await signIn("email-otp", { email: email.trim(), code: value, redirect: false });
      if (res?.error || res?.ok === false) {
        fail();
      } else {
        setDone(true);
        setTimeout(() => {
          router.push(next);
          router.refresh();
        }, 600);
      }
    } catch {
      fail();
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }

  function fail() {
    setError(BAD_CODE);
    setCode("");
    setShake(true);
    setTimeout(() => setShake(false), 450);
    setTimeout(() => boxes.current[0]?.focus(), 0);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (step === "code") return verify(code);
    setError("");
    setLoading(true);
    try {
      if (!email.trim()) return setError("Enter your email.");
      if (await sendCode()) go("code", "fwd");
    } catch {
      setError("Couldn't send a code right now. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    if (cooldown > 0) return;
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

  const exiting = shown !== step;
  const motion = exiting ? `lg-out-${dir}` : `lg-in-${dir}`;
  const codeBusy = loading || done;

  return (
    <form onSubmit={submit} className="space-y-4">
      <div aria-live="polite">
        {error && (
          <p role="alert" className="lg-notice rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
        )}
      </div>
      <div className="lg-height" style={height === undefined ? undefined : { height }}>
        <div ref={panel} key={shown} className={`space-y-4 ${motion}`}>
          {shown === "email" ? (
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
              <Button type="submit" className="lg-press w-full" disabled={loading || exiting}>
                {loading ? <><Spinner /> Sending…</> : "Email me a code"}
              </Button>
            </>
          ) : (
            <>
              <p role="status" className="text-xs text-muted">
                If {email.trim()} is allowed to sign in, a 6-digit code is on its way. It expires in 10 minutes.
              </p>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-text">{email.trim()}</span>
                <button
                  type="button"
                  onClick={() => { go("email", "back"); setCode(""); setError(""); }}
                  disabled={codeBusy}
                  className="lg-link shrink-0 text-muted underline hover:text-text"
                >
                  Change
                </button>
              </div>
              <CodeBoxes value={code} onChange={setCode} onComplete={verify} disabled={codeBusy} shake={shake} inputRef={boxes} />
              <Button type="submit" className="lg-press w-full" disabled={codeBusy || code.length < CODE_LENGTH}>
                {done ? <><CheckMark /> Signed in</> : loading ? <><Spinner /> Signing in…</> : "Sign in"}
              </Button>
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={resend}
                  disabled={loading || done || cooldown > 0}
                  className="lg-link text-xs text-muted underline hover:text-text disabled:no-underline disabled:opacity-60"
                >
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </form>
  );
}
