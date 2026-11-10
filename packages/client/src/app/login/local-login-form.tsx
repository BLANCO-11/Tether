// src/app/login/local-login-form.tsx — the email + password path (the "local"
// Credentials provider in src/auth.ts). Kept as its own client component so the
// login page itself can stay a server component and read the auth env at request
// time. Uses Foundry's own Field/Input/Button so it matches the rest of the app.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { CheckMark, Spinner } from "./email-otp-form";

export function LocalLoginForm({ defaultEmail, next = "/dashboard" }: { defaultEmail?: string; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // Which fields were empty on the last blocked submit — drives the danger border.
  const [blank, setBlank] = useState<{ email: boolean; password: boolean }>({ email: false, password: false });
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const emailBlank = !email.trim();
    const pwBlank = !password;
    if (emailBlank || pwBlank) {
      setBlank({ email: emailBlank, password: pwBlank });
      return setError("Enter your username or email, and your password.");
    }
    setBlank({ email: false, password: false });
    setLoading(true);
    setError("");
    try {
      const res = await signIn("local", { email: email.trim(), password, redirect: false });
      if (res?.error || res?.ok === false) {
        setError("That username or email and password didn't match. Try again.");
      } else {
        setDone(true);
        setTimeout(() => {
          router.push(next);
          router.refresh();
        }, 600);
      }
    } catch {
      setError("Couldn't sign in — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  const form = (
    <form onSubmit={submit} className="space-y-4">
      {/* Red alert sits above the form, so the reason is the first thing read. */}
      {error && (
        <p role="alert" className="lg-notice rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
      )}
      {/* ⚠ **`type="text"`, and it was `type="email"` — which is why a local
          account could not sign in AT ALL.** A browser refuses to submit
          `rachit.dhaka` from an email input, so the form never posted and the
          failure looked like the password being wrong. The provider's own
          `credentials` declaration was already `text`; NextAuth only uses that
          for its auto-generated page, and this hand-written form is the real
          one. Both now agree.

          ⚠ The label names BOTH because this one field serves both: the
          deployment's admin credentials (an email) and a created account (a
          username). */}
      <Field label="Username or work email">
        <Input
          type="text"
          autoComplete="username"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (blank.email) setBlank((b) => ({ ...b, email: false })); }}
          placeholder="you@work.com or ops.viewer"
          invalid={blank.email}
        />
      </Field>
      <Field label="Password">
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); if (blank.password) setBlank((b) => ({ ...b, password: false })); }}
          placeholder="••••••••"
          invalid={blank.password}
        />
      </Field>
      <Button type="submit" variant="ghost" className="lg-press w-full" disabled={loading || done}>
        {done ? <><CheckMark /> Signed in</> : loading ? <><Spinner /> Signing in…</> : "Sign in"}
      </Button>
    </form>
  );

  // Tucked away: an animated expander instead of a raw <details>. The form stays in the DOM (hidden, not focusable, when closed).
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="password-signin"
        onClick={() => setOpen((o) => !o)}
        className="lg-link mx-auto flex items-center gap-1 text-xs text-muted hover:text-text"
      >
        Sign in with password
        <svg aria-hidden="true" viewBox="0 0 24 24" className="lg-chevron h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div id="password-signin" className="lg-collapse" data-open={open}>
        <div>
          <div className="pt-3">{form}</div>
        </div>
      </div>
    </div>
  );
}
