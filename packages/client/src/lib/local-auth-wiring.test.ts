// src/lib/local-auth-wiring.test.ts — the properties of `auth.ts`'s local
// sign-in path, asserted by reading it off disk.
//
// ⚠ **WHY SOURCE-READING RATHER THAN BEHAVIOURAL.** `auth.ts` is a NextAuth
// module: importing it constructs providers, reads the environment and expects
// a request context. What matters here is not what one call returns but what
// the file is ALLOWED to contain — no database import, no role granted to a
// database account, no password in a log line. Those are absences, and an
// absence is what a behavioural test is worst at: it passes for ever once the
// code path it exercises stops being reached (I-38).
//
// This is the idiom `kestra:check`'s `TETHER_API_KEY`-in-three-files assertion
// and `manifest-builder.service.test.ts` already use, and it carries the same
// obligation: **a control per scan**, so a renamed or moved file cannot pass by
// reading as an empty string.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "auth.ts"), "utf8");

/** ⚠ The control for every assertion below. A path that stopped resolving would
 *  otherwise make each `not.toContain` vacuously true. */
it("can read auth.ts at all", () => {
  expect(SRC.length).toBeGreaterThan(2000);
  expect(SRC).toContain("verifyLocalUser");
  expect(SRC).toContain("Credentials({");
});

describe("the local sign-in path", () => {
  it("⚠ holds NO database credential and imports no database client", () => {
    // The web container has none, which is the whole reason the check is a
    // route. An import here would either fail at build or quietly acquire one.
    for (const forbidden of ["drizzle-orm", "@/db", "../db", "node-postgres", "pg", "postgres.js"]) {
      expect(SRC).not.toContain(`from "${forbidden}"`);
    }
  });

  it("⚠ grants NO roles to a database account", () => {
    /**
     * The env admin is hardcoded `["superadmin", "admin"]` and must stay so —
     * it is how this deployment is administered. A database account gets `[]`,
     * because its rights live in `workspace_members` on the server, keyed on
     * the subject the row issues. A role granted in this callback would be a
     * second authority the server never consults.
     */
    expect(SRC).toContain('roles: ["superadmin", "admin"]');
    expect(SRC).toContain("roles: []");
    // And exactly one place grants the elevated pair.
    expect(SRC.split('roles: ["superadmin", "admin"]').length - 1).toBe(1);
  });

  it("⚠ checks the ENV admin FIRST, so a broken API server cannot lock everybody out", () => {
    // If the database path ran first, a migration not yet applied or an API
    // server still starting would refuse the one account that administers the
    // deployment.
    // The CALL, not the first mention: the helper is defined above `authorize`, so "verifyLocalUser(" alone matched
    // its definition and the order this asserts read as reversed when it was not.
    expect(SRC.indexOf("await verifyLocalUser("), "CONTROL: the call is found").toBeGreaterThan(0);
    expect(SRC.indexOf("LOCAL_ADMIN_PASSWORD")).toBeLessThan(SRC.indexOf("await verifyLocalUser("));
  });

  it("⚠ NEVER logs the password, on any branch", () => {
    // A log line that carries a credential is a credential store with worse
    // access control than the database.
    const logs = [...SRC.matchAll(/console\.(warn|error|log|info)\(([\s\S]*?)\);/g)].map((m) => m[2]!);
    expect(logs.length).toBeGreaterThan(0); // control: there ARE log lines here
    for (const line of logs) {
      expect(line).not.toContain("password");
      expect(line).not.toContain("credentials.");
    }
  });

  it("⚠ takes the subject from the SERVER's answer, never from a rotating token field", () => {
    /**
     * `workspace_members.subject` is the key a role is looked up by. On
     * 2026-08-21 one Entra user held five `platform_users` rows because this
     * file signed `token.sub`, which rotates — an assignment silently stopped
     * applying with the row sitting right there. A local account's subject is
     * derived from its row's primary key and comes back from the verify call.
     */
    expect(SRC).toContain("id: verified.subject");
    // And the Entra path still prefers the STABLE oid over `sub`.
    expect(SRC).toContain("(token.oid as string | undefined) ?? token.sub");
  });

  it("⚠ bounds the verify call, so a sign-in form cannot hang on it", () => {
    expect(SRC).toContain("AbortSignal.timeout(");
  });

  it("⚠ refuses to verify when PARENT_API_KEY is unset rather than allowing", () => {
    // Fails closed. An unset key must not read as "no check required".
    const fn = SRC.slice(SRC.indexOf("async function verifyLocalUser"), SRC.indexOf("declare module"));
    expect(fn).toContain("if (!key)");
    expect(fn).toContain("return null");
  });

  it("⚠ the sign-in field is TEXT, not email — a username is not an address", () => {
    // A browser refuses to submit `ops.viewer` from an email input, and the
    // failure looks exactly like the account not existing.
    expect(SRC).toContain('email: { label: "Username or email", type: "text" }');
  });

  it("has an email-otp provider with a rolling 7-day session and an allowlist re-check", () => {
    expect(SRC).toContain('id: "email-otp"');
    expect(SRC).toContain("maxAge: 60 * 60 * 24 * 7");
    expect(SRC).toContain("updateAge: 60 * 60 * 24");
    const at = SRC.indexOf("await checkEmailAllowed(");
    expect(at, "CONTROL: the call is found").toBeGreaterThan(0);
    expect(SRC.indexOf("return null", at)).toBeGreaterThan(at);
  });
});

describe("the Google sign-in path", () => {
  it("registers Google only when both env vars are set", () => {
    expect(SRC).toContain('from "next-auth/providers/google"');
    expect(SRC).toContain("googleId && googleSecret");
    expect(SRC).toContain("Google({ clientId: googleId, clientSecret: googleSecret })");
  });

  it("refuses unverified or non-allowlisted emails", () => {
    const at = SRC.indexOf('account?.provider === "google"');
    expect(at, "CONTROL: the branch is found").toBeGreaterThan(0);
    const branch = SRC.slice(at, at + 500);
    expect(branch).toContain("email_verified !== true");
    expect(branch).toContain("return false");
    expect(branch).toContain("(await checkEmailAllowed(g.email.toLowerCase())) === true");
  });

  it("shares the email-otp identity and the allowlist re-check", () => {
    expect(SRC).toContain("token.sub = `email:${email}`");
    expect(SRC).toContain('token.authMethod === "google"');
  });
});
