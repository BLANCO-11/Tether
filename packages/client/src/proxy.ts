// src/proxy.ts — the server-side gate (named `middleware.ts` until Next 16, which renamed the convention and runs it on Node). Every page requires a signed-in
// session: requests without one are sent to /login, and already-signed-in users
// are bounced off /login back into the app. Fail closed.
import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/session-expiry";

// ⚠ One gate, one file. `middleware.ts` and `proxy.ts` must never both exist (`gate.test.ts` asserts it); Next 16 deprecates the
// old name, and the named `proxy` export is what it looks for. The auth wrapper is what makes a request carry `req.auth`.
export const proxy = auth((req) => {
  const { nextUrl } = req;
  const isAuthed = !!req.auth;
  const isLoginPage = nextUrl.pathname === "/login";

  // An API call is answered, never redirected: a redirect hands `fetch` the login page's HTML with a 200, which the
  // app cannot tell from data. A 401 in the proxy's own words is what sends the page to sign-in (lib/session-expiry).
  // ⚠ One exception: `/api/oauth/callback` is a provider sending the BROWSER back after a sign-in — a page visit, not
  // a fetch — so a signed-out person is sent to sign in and back (the route checks the session itself, too).
  if (!isAuthed && nextUrl.pathname.startsWith("/api/") && nextUrl.pathname !== "/api/oauth/callback") {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  if (!isAuthed && !isLoginPage) {
    // Back to this page after signing in (an ended session mid-use must not lose where the person was).
    const login = new URL("/login", nextUrl);
    login.searchParams.set("callbackUrl", `${nextUrl.pathname}${nextUrl.search}`);
    return NextResponse.redirect(login);
  }
  // `expired=1` is the app saying the session ended while it still reads as signed in here (the server's identity ran
  // out): show the login page rather than bouncing back to a page whose every request is refused.
  if (isAuthed && isLoginPage && nextUrl.searchParams.get("expired") !== "1") {
    return NextResponse.redirect(new URL(safeNext(nextUrl.searchParams.get("callbackUrl")), nextUrl));
  }
  return NextResponse.next();
});

export const config = {
  // Run on all routes except the auth API, Next.js internals, and static assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
