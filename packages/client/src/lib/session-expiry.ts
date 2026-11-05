/**
 * A session that has ended sends the person to sign in again (2026-10-11), and back to where they were afterwards.
 *
 * It used to leave them on a page that looked signed in while every read and write failed — an empty History, a
 * builder that would not send. Two answers mean "signed out", and only these two:
 *   - `not_authenticated` — the web app's own session is gone (the proxy says so, `app/api/foundry/[...path]`);
 *   - `identity_expired`  — the identity the server checks ran out (`identity.middleware.ts`).
 * Every other 401 (a malformed token, a missing permission) is a real refusal and is shown as one — redirecting on it
 * would loop a person between the page and the login screen.
 */
const SIGNED_OUT = new Set(["not_authenticated", "identity_expired"]);
let leaving = false;

/** Whether a response says the session ended. Reads the body text the caller already has. */
export function isSessionEnded(status: number, body: string): boolean {
  if (status !== 401) return false;
  try {
    return SIGNED_OUT.has((JSON.parse(body) as { error?: string }).error ?? "");
  } catch {
    return false;
  }
}

/** Go to sign-in once, remembering this page; later calls while leaving do nothing. */
export function toSignIn(): void {
  if (leaving || typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/login")) return;
  leaving = true;
  const back = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?expired=1&callbackUrl=${encodeURIComponent(back)}`);
}

/** Both at once: when the response says the session ended, go to sign-in and report true. */
export function signInIfEnded(status: number, body: string): boolean {
  if (!isSessionEnded(status, body)) return false;
  toSignIn();
  return true;
}

/**
 * Where to go after signing in: the page the person was on, when it is a page of THIS app — a path starting with one
 * `/` (never `//host`, which a browser reads as another site), and never the login page itself.
 */
export function safeNext(raw: string | string[] | undefined | null): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") && !v.startsWith("/login") ? v : "/dashboard";
}
