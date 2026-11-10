// src/app/login/page.tsx — sign-in screen. Three ways in:
//   • an emailed 6-digit code (always shown, the primary method),
//   • your work account (Microsoft Entra ID SSO), when its env is configured, and
//   • local credentials (email + password) — the env admin and created accounts, tucked under
//     "Sign in with password" unless LOCAL_LOGIN=off. Real
// sign-in replaced the earlier mock; components elsewhere still use useAuth().
import { signIn } from "@/auth";
import type React from "react";
import { Button } from "@/components/ui/Button";
import { Cube } from "@/components/ui/icons";
// A third party's brand mark, quarantined in its own file because it is the one
// thing in `src/**` that legitimately holds colour literals — see that file.
import { MicrosoftMark } from "@/components/ui/MicrosoftMark";
import { LocalLoginForm } from "./local-login-form";
import { EmailOtpForm, GoogleButton } from "./email-otp-form";
import { safeNext } from "@/lib/session-expiry";

// "or" divider whose rules grow outward on load.
function OrDivider() {
  return (
    <div className="lg-divider my-5" aria-hidden="true">
      <span /> <b>or</b> <span />
    </div>
  );
}

// Must be dynamic so the auth env (LOCAL_ADMIN_PASSWORD, Entra credentials) is
// read at request time from the container environment — not baked in at build.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in · Tether",
};

// Expose the configured admin email to the client form for pre-fill. The
// password is validated server-side only and never sent to the client.
// The email is pre-filled only when the env admin account is actually configured.
const LOCAL_ADMIN_EMAIL = process.env.LOCAL_ADMIN_PASSWORD ? (process.env.LOCAL_ADMIN_EMAIL ?? "aicoe@microland.com") : undefined;
// Local sign-in is shown in EVERY environment, production included (2026-10-04): the credentials provider is always registered and
// accepts the env admin AND the accounts created under Organization (`local_users`, verified by the API server) — keying the form on
// LOCAL_ADMIN_PASSWORD hid it from every created account wherever the env admin was not set. `LOCAL_LOGIN=off` turns it off.
const LOCAL_LOGIN_ENABLED = process.env.LOCAL_LOGIN !== "off";
const SSO_ENABLED = !!(
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET
);
const GOOGLE_ENABLED = !!(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

// ⚠ `searchParams` is a PROMISE from Next 15 (a plain object on 14, the synchronous form removed in 16). Reading it without
// `await` leaves `callbackUrl` and `expired` undefined: the page still renders, the return address is silently `/dashboard`
// and the "your session ended" line never shows — which is why `page.params.test.tsx` asserts both.
export default async function LoginPage({ searchParams }: { searchParams?: Promise<{ callbackUrl?: string; expired?: string; error?: string }> }) {
    const query = (await searchParams) ?? {};
  // Where the person was, when their session ended or they opened a link signed out — they go back there.
  const next = safeNext(query.callbackUrl);
  const expired = query.expired === "1";
  const accessDenied = query.error === "AccessDenied";

  return (
    <main className="relative flex min-h-screen items-center justify-center p-6">
      {/* Slowly drifting blurred orbs in Tether's accent. */}
      <div aria-hidden="true" className="lg-backdrop">
        <div className="lg-orb lg-orb-a" />
        <div className="lg-orb lg-orb-b" />
        <div className="lg-orb lg-orb-c" />
      </div>

      <div className="lg-card w-full max-w-sm rounded-2xl p-8">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="lg-logo btn-grad mb-4 flex h-12 w-12 items-center justify-center rounded-lg text-[color:var(--on-cta)]">
            <Cube s={24} />
          </span>
          <p className="lg-rise text-xs font-semibold uppercase tracking-[0.3em] text-muted" style={{ "--d": "200ms" } as React.CSSProperties}>Tether</p>
          <h1 className="lg-rise mt-2 text-lg font-semibold" style={{ "--d": "260ms" } as React.CSSProperties}>Welcome to Tether</h1>
          <p className="lg-rise mt-1 text-sm text-muted" style={{ "--d": "320ms" } as React.CSSProperties}>Sign in to your Automation Studio.</p>
        </div>

        {expired ? (
          <p role="status" className="lg-notice mb-5 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-center text-xs text-text">
            Your session ended. Sign in again to carry on where you were.
          </p>
        ) : null}

        {accessDenied ? (
          <p role="alert" className="lg-notice mb-5 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-center text-xs text-text">
            This Google account is not allowed. Ask an admin to add your email.
          </p>
        ) : null}

        {GOOGLE_ENABLED && (
          <div className="lg-rise" style={{ "--d": "380ms" } as React.CSSProperties}>
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: next });
              }}
            >
              <GoogleButton />
            </form>
            <OrDivider />
          </div>
        )}

        {/* Email code — the primary method. */}
        <div className="lg-rise" style={{ "--d": "440ms" } as React.CSSProperties}>
          <EmailOtpForm next={next} />
        </div>

        {/* Divider — before the work-account button. */}
        {SSO_ENABLED && <OrDivider />}

        {/* Microsoft Entra ID — the work-account path. */}
        {SSO_ENABLED && (
          <form
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: next });
            }}
          >
            <Button type="submit" variant="ghost" className="lg-press w-full gap-2.5">
              <MicrosoftMark />
              Sign in with your work account
            </Button>
          </form>
        )}

        {/* Password — kept in the DOM, behind an animated expander (inside LocalLoginForm). */}
        {LOCAL_LOGIN_ENABLED && (
          <div className="mt-5">
            <LocalLoginForm defaultEmail={LOCAL_ADMIN_EMAIL} next={next} />
          </div>
        )}

        {/* Footer note — reflects which methods are on. */}
        <p className="lg-rise mt-6 text-center text-xs text-dim" style={{ "--d": "520ms" } as React.CSSProperties}>
          {SSO_ENABLED && LOCAL_LOGIN_ENABLED
            ? "Work account, email code or password"
            : SSO_ENABLED
            ? "Work account or email code"
            : LOCAL_LOGIN_ENABLED
            ? "Email code or password"
            : "Email code"}
        </p>
      </div>
    </main>
  );
}
