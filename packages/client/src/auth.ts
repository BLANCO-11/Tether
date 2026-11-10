// src/auth.ts — Foundry's real sign-in, built on Auth.js (NextAuth v5).
// Two ways in, both env-driven (read at request time from .env.local):
//   • Microsoft Entra ID SSO — your work account, shown when the Entra app is set.
//   • Local credentials — the env admin (LOCAL_ADMIN_*) and created accounts; the form is shown unless LOCAL_LOGIN=off.
//   • Email code — a 6-digit code mailed to an allowlisted address (the "email-otp" provider); the primary
//     sign-in. Its session lasts 7 days and rolls forward, and the allowlist is re-checked while it lives.
// The auth env (Entra IDs, admin creds, secret) is shared with the Action Gateway
// stack, so a work account that signs in there signs in here too.
import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { SignJWT, decodeJwt } from "jose";

/**
 * The shape `POST /api/local-auth/verify` returns. ⚠ It carries no password
 * hash and no role — see the route, and see `authorize`'s note on why a role
 * granted here would be a second authority.
 */
type VerifiedLocalUser = {
  subject: string;
  username: string;
  email: string | null;
  name: string | null;
};

/**
 * Ask the API server whether this username and password match a local account.
 *
 * ⚠ **THIS PROCESS HOLDS NO DATABASE CREDENTIAL**, which is the whole reason
 * the check is a route rather than a query — the same constraint that puts
 * `platform_users`' write in `resolveIdentity` rather than in a NextAuth
 * callback. The two environment variables it needs are the ones the proxy route
 * already reads, so there is no new secret and no new base URL to disagree with
 * the existing one.
 *
 * ⚠ **EVERY FAILURE RETURNS `null` AND NONE OF THEM SAYS WHICH.** A 401, a
 * 429, a 500 and an unreachable server are one answer to `authorize`, because
 * anything more specific reaches a public sign-in form — where "no such
 * account" and "wrong password" is an enumeration oracle. What is logged is
 * the STATUS and never the username or the password, so a log line cannot
 * become a credential.
 */
async function verifyLocalUser(
  username: string,
  password: string,
): Promise<VerifiedLocalUser | null> {
  const base = process.env.PARENT_API_URL ?? "http://localhost:4000";
  const key = process.env.PARENT_API_KEY ?? "";
  if (!key) {
    console.warn("[auth] PARENT_API_KEY is unset; local accounts cannot be verified");
    return null;
  }
  try {
    const r = await fetch(`${base}/api/local-auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ username, password }),
      // ⚠ Bounded. A sign-in form hanging on an unreachable API server is
      // indistinguishable from a wrong password that takes for ever, and the
      // person retries — which is what fills the throttle.
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      if (r.status !== 401) console.warn(`[auth] local verify answered ${r.status}`);
      return null;
    }
    const body = (await r.json()) as { user?: VerifiedLocalUser };
    return body.user?.subject ? body.user : null;
  } catch (e) {
    console.warn("[auth] local verify failed", (e as Error).message);
    return null;
  }
}

// TypeScript augmentation so `session.backendToken` and `session.user.roles` are typed.
declare module "next-auth" {
  interface Session {
    backendToken?: string;
    user: {
      id?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      roles?: string[];
    };
  }
}

type VerifiedEmailUser = { subject: string; email: string; name: string | null };

function apiHeaders(key: string) {
  return { "content-type": "application/json", "x-api-key": key };
}

/**
 * Ask the API server to verify an emailed sign-in code. Every failure is `null`
 * and none says which; the code is never logged.
 */
async function verifyEmailOtp(
  email: string,
  code: string,
  clientIp: string | undefined,
): Promise<VerifiedEmailUser | null> {
  const base = process.env.PARENT_API_URL ?? "http://localhost:4000";
  const key = process.env.PARENT_API_KEY ?? "";
  if (!key) {
    console.warn("[auth] PARENT_API_KEY is unset; email codes cannot be verified");
    return null;
  }
  try {
    const r = await fetch(`${base}/api/email-otp/verify`, {
      method: "POST",
      headers: apiHeaders(key),
      body: JSON.stringify({ email, code, clientIp }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      if (r.status !== 401) console.warn(`[auth] email code verify answered ${r.status}`);
      return null;
    }
    const body = (await r.json()) as { user?: VerifiedEmailUser };
    return body.user?.subject ? body.user : null;
  } catch (e) {
    console.warn("[auth] email code verify failed", (e as Error).message);
    return null;
  }
}

/**
 * Is this email still on the sign-in allowlist? `true`/`false` from the server,
 * `null` when it cannot be reached or errors (the caller must not sign anyone out for that).
 */
async function checkEmailAllowed(email: string): Promise<boolean | null> {
  const base = process.env.PARENT_API_URL ?? "http://localhost:4000";
  const key = process.env.PARENT_API_KEY ?? "";
  if (!key) {
    console.warn("[auth] PARENT_API_KEY is unset; the email allowlist cannot be checked");
    return null;
  }
  try {
    const r = await fetch(`${base}/api/email-otp/status`, {
      method: "POST",
      headers: apiHeaders(key),
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      console.warn(`[auth] email allowlist check answered ${r.status}`);
      return null;
    }
    const body = (await r.json()) as { allowed?: boolean };
    return typeof body.allowed === "boolean" ? body.allowed : null;
  } catch (e) {
    console.warn("[auth] email allowlist check failed", (e as Error).message);
    return null;
  }
}

// Only emit Secure / __Secure- cookies when actually served over HTTPS. On
// http://localhost (dev) the browser would silently drop a Secure cookie and
// break the session — so key this off the deployment URL, not just NODE_ENV.
const isProd = process.env.NODE_ENV === "production";
const authUrl = process.env.AUTH_URL ?? "";
const useSecureCookies = isProd && authUrl.startsWith("https://");
const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(authUrl);

// `next build` imports this module to collect page data, but the auth env is only
// injected at runtime. Skip the runtime guards during the build phase so they
// don't fail closed on the (legitimately) empty build-time env.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
if (!isBuildPhase) {
  if (isProd && !useSecureCookies && !isLocalHttp) {
    throw new Error(
      "Refusing to start: a non-local AUTH_URL is not https:// — " +
        "session cookies would be sent without the Secure flag.",
    );
  }
  if (!process.env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required.");
  }
}

// The Entra tenant we trust. Derived from the issuer URL
// (https://login.microsoftonline.com/<TENANT_ID>/v2.0); sign-ins from any other
// tenant are rejected in the signIn callback below.
const ALLOWED_TENANT_ID =
  process.env.AUTH_ALLOWED_TENANT_ID ??
  (process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER ?? "").match(
    /login\.microsoftonline\.com\/([^/]+)/,
  )?.[1];

// Foundry-specific cookie name, so a Foundry session can never be replayed
// against another app on the same host.
const SESSION_COOKIE = useSecureCookies
  ? "__Secure-foundry.session-token"
  : "foundry.session-token";

const _backendSecret = new TextEncoder().encode(
  process.env.RUNTIME_JWT_SECRET ?? process.env.AUTH_SECRET ?? "dev-secret",
);

const entraId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
const entraSecret = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;

const googleId = process.env.AUTH_GOOGLE_ID;
const googleSecret = process.env.AUTH_GOOGLE_SECRET;

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Behind proxies/containers there's no host inference, so trust the host and
  // read the signing secret explicitly.
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  providers: [
    // Register the Entra provider only when its credentials are present. Passing
    // an undefined clientId makes NextAuth v5 throw at module init, which would
    // crash the login page even when only local login is needed.
    ...(entraId && entraSecret
      ? [
          MicrosoftEntraID({
            clientId: entraId,
            clientSecret: entraSecret,
            issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
          }),
        ]
      : []),
    // Google sign-in, registered only when both env vars are set. Gated by the email allowlist in signIn.
    ...(googleId && googleSecret
      ? [Google({ clientId: googleId, clientSecret: googleSecret })]
      : []),
    Credentials({
      id: "local",
      name: "Username and password",
      credentials: {
        // ⚠ Still `email`, and the label is now "Username or email" — the field
        // NAME is what the sign-in form posts, and renaming it would break the
        // form and every existing bookmark of it for a cosmetic gain. It is
        // `type: "text"` rather than `email`, because a browser refuses to
        // submit `ops.viewer` from an email input and the failure looks like
        // the account not existing.
        email: { label: "Username or email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      /**
       * ⚠ **TWO ACCOUNT SOURCES, AND THE ENV ONE IS CHECKED FIRST AND LEFT
       * EXACTLY AS IT WAS.** `LOCAL_ADMIN_*` is how this deployment is
       * administered today; a change that routed it through the database would
       * lock everybody out the moment the API server or the migration was
       * behind. It stays the bootstrap, and `local_users` is the surface that
       * grows.
       *
       * ⚠ **The database accounts are verified by the API SERVER, not here.**
       * This process holds no database credential — the same reason
       * `platform_users` is written from `resolveIdentity` rather than from a
       * NextAuth callback — so `authorize` calls `POST /api/local-auth/verify`
       * with `PARENT_API_KEY`, server-side, exactly as the proxy route does.
       *
       * ⚠ **A LOCAL ACCOUNT GETS NO ROLES HERE.** The env admin is hardcoded
       * `["superadmin","admin"]` and a database account is given `[]`, because
       * its rights live in `workspace_members` on the server, keyed on the
       * subject the row issues. Granting a role in this callback would be a
       * second authority the server never consults — and `session.user.roles`
       * is already something `ui-honesty-check.sh` forbids the client from
       * deciding anything from.
       */
      async authorize(credentials) {
        const identifier = typeof credentials?.email === "string" ? credentials.email.trim() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!identifier || !password) return null;

        const adminEmail = process.env.LOCAL_ADMIN_EMAIL ?? "aicoe@microland.com";
        const adminPassword = process.env.LOCAL_ADMIN_PASSWORD ?? "";
        if (adminPassword && identifier === adminEmail && password === adminPassword) {
          const adminName = process.env.LOCAL_ADMIN_NAME ?? "Local Admin";
          // The env account is a super admin: grant the elevated roles so the
          // session (session.user.roles) and any RBAC checks see it as such.
          return { id: "local-admin", email: adminEmail, name: adminName, roles: ["superadmin", "admin"] };
        }

        const verified = await verifyLocalUser(identifier, password);
        if (!verified) return null;
        /**
         * ⚠ **`id` IS THE SUBJECT AND IT MUST BE STABLE.**
         * `workspace_members.subject` is the key a role is looked up by, and on
         * 2026-08-21 one Entra user held five `platform_users` rows because
         * this file signed a rotating `token.sub` — an assignment silently
         * stopped applying with the row sitting right there. `local:<uuid>` is
         * derived from the row's primary key, which is why the row is
         * deactivated and never deleted.
         */
        return {
          id: verified.subject,
          email: verified.email ?? `${verified.username}@local`,
          name: verified.name ?? verified.username,
          roles: [],
        };
      },
    }),
    Credentials({
      id: "email-otp",
      name: "Email code",
      credentials: {
        email: { label: "Email", type: "email" },
        code: { label: "Code", type: "text" },
      },
      // Roles are always [] — rights are decided on the server, never here.
      async authorize(credentials, request) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim() : "";
        const code = typeof credentials?.code === "string" ? credentials.code.trim() : "";
        if (!email || !code) return null;
        const fwd = request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
        const clientIp = fwd || request?.headers?.get("x-real-ip") || undefined;
        const verified = await verifyEmailOtp(email, code, clientIp);
        if (!verified) return null;
        return { id: verified.subject, email: verified.email, name: verified.email, roles: [] };
      },
    }),
  ],
  session: {
    strategy: "jwt",
    // An active user's session rolls forward (refreshed at most daily); more than 7 days of inactivity ends it.
    maxAge: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
  },
  callbacks: {
    // Reject sign-ins from any tenant other than the one we're configured for.
    // Local-admin sign-ins bypass the tenant check — they're already validated
    // in authorize() above.
    async signIn({ profile, account }) {
      if (account?.provider === "google") {
        const g = profile as { email?: string; email_verified?: boolean } | undefined;
        if (g?.email_verified !== true || !g.email) return false;
        // Only an allowlisted email gets in; unreachable server (null) refuses too.
        return (await checkEmailAllowed(g.email.toLowerCase())) === true;
      }
      if (account?.provider === "local" || account?.provider === "email-otp") return true;
      if (!ALLOWED_TENANT_ID) return true;
      const tid = (profile as { tid?: string } | undefined)?.tid;
      return tid === ALLOWED_TENANT_ID;
    },
    async jwt({ token, account, profile, user }) {
      // Persist Entra OID + app roles on sign-in so downstream code can do RBAC.
      if (profile) {
        token.oid = (profile as { oid?: string }).oid ?? token.sub;
        const roles = (profile as { roles?: string[] }).roles;
        token.roles = Array.isArray(roles) ? roles : [];
      }
      // Local (credentials) sign-in carries roles on `user`, not `profile`.
      if (user) {
        const roles = (user as { roles?: string[] }).roles;
        if (Array.isArray(roles)) token.roles = roles;
      }
      if (account) {
        token.authMethod = account.provider;
        token.allowCheckedAt = Date.now();
        if (account.provider === "google") {
          // Same identity as an email-otp sign-in for this address (server issues `email:<lowercased email>`).
          const email = (token.email ?? "").toLowerCase();
          token.email = email;
          token.name = email;
          token.sub = `email:${email}`;
          token.oid = token.sub;
          token.roles = [];
        }
      }
      // Email-code and Google sessions re-check the allowlist every 5 minutes; others are untouched.
      if ((token.authMethod === "email-otp" || token.authMethod === "google") && Date.now() - ((token.allowCheckedAt as number | undefined) ?? 0) > 5 * 60 * 1000) {
        const allowed = await checkEmailAllowed(token.email ?? "");
        if (allowed === false) return null; // Auth.js clears the session cookie
        if (allowed === true) token.allowCheckedAt = Date.now();
        // null: server unreachable; leave the token as is so the check retries next request.
      }
      // Mint/refresh the HS256 backendToken the backend can validate.
      const tok = token as typeof token & { backendToken?: string };
      // Renewed while the session lives (2026-10-11): it was minted only at sign-in, so 8 hours after signing in the
      // server refused every request ("identity_expired") while the session — renewed on use — still read as
      // signed in. Re-signed when under an hour is left; the session's own expiry still ends everything.
      const expiresAt = (() => {
        try {
          return tok.backendToken ? (decodeJwt(tok.backendToken).exp ?? 0) * 1000 : 0;
        } catch {
          return 0;
        }
      })();
      if (account || !tok.backendToken || expiresAt - Date.now() < 60 * 60 * 1000) {
        /**
         * ⚠ **`sub` MUST be the STABLE identifier, and `token.sub` IS NOT ONE.**
         *
         * This signed `token.sub` and it was a real bug with two visible
         * symptoms. Measured on the live deployment: **one Entra user had FIVE
         * rows in `platform_users`**, one per sign-in, each with a different
         * subject and the same email — because NextAuth's `token.sub` is a
         * per-sign-in identifier here, not the person's identity.
         *
         * The second symptom is the serious one. Workspace membership is keyed
         * on this value (`workspace_members.subject`), so **a member's role
         * silently stopped applying the next time they signed in**: their
         * assignment still existed, their new token named somebody the server
         * had never seen, and the refusal they got said "you are not a member of
         * this workspace" — with the row sitting right there.
         *
         * `token.oid` is the Entra OID and is stable for a person across
         * sign-ins. `session.user.id` has always preferred it; this is the same
         * choice, applied to the token the API actually authorises against. The
         * `?? token.sub` tail is for the local credentials account, which sets
         * no `oid` and whose `sub` is the fixed literal `local-admin`.
         *
         * ⚠ Do not "simplify" this back to `token.sub`. It looks equivalent,
         * it type-checks, and every symptom appears a sign-in later in a
         * different part of the product.
         */
        tok.backendToken = await new SignJWT({
          sub: (token.oid as string | undefined) ?? token.sub ?? "",
          email: token.email ?? "",
          name: token.name ?? "",
        })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime("8h")
          .sign(_backendSecret);
      }
      return tok;
    },
    async session({ session, token }) {
      const tok = token as typeof token & { backendToken?: string };
      session.backendToken = tok.backendToken;
      if (session.user) {
        session.user.id = (token.oid as string) ?? (token.sub as string);
        session.user.roles = (token.roles as string[]) ?? [];
      }
      return session;
    },
  },
  events: {
    signIn({ user }) {
      console.log(`[audit] sign-in foundry user=${user?.email ?? user?.id ?? "?"}`);
    },
    signOut() {
      console.log(`[audit] sign-out foundry`);
    },
  },
  pages: {
    signIn: "/login",
  },
});
