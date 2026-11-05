// src/services/local-user.test.ts — the rules an account is created under.
//
// ⚠ Against the LIVE database, like `workspace-member.test.ts` beside it. The
// two refusals below are the whole of "a local account cannot be a platform
// super admin", and a mocked repo would let them pass over a table that does
// not enforce the unique username.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { localUsers } from "../db/schema.js";
import { config } from "../config/index.js";
import { localUserService, LOCAL_SUBJECT_PREFIX } from "./local-user.service.js";

const PREFIX = "zzlu";
const pw = "a-long-enough-passphrase";

/**
 * ⚠ `config.superAdminEmails` is the SAME `Set` the predicate reads, so tests
 * mutate it and restore it — the idiom `super-admin.test.ts` already uses,
 * because otherwise these assertions depend on whose machine they ran on.
 */
const REAL = [...config.superAdminEmails];
beforeEach(async () => {
  config.superAdminEmails.clear();
  for (const e of REAL) config.superAdminEmails.add(e);
  await db.delete(localUsers).where(like(localUsers.username, `${PREFIX}%`));
});
afterAll(async () => {
  await db.delete(localUsers).where(like(localUsers.username, `${PREFIX}%`));
});

describe("localUserService.create", () => {
  it("issues a stable, prefixed subject derived from the row's id", async () => {
    /**
     * ⚠ The subject is what `workspace_members` keys a role on. On 2026-08-21
     * one Entra user held five `platform_users` rows because the token signed a
     * ROTATING subject — an assignment silently stopped applying with the row
     * sitting right there. This one is the primary key.
     */
    const u = await localUserService.create({ username: `${PREFIX}_ops`, password: pw, createdBy: "s1" });
    expect(u.subject).toBe(`${LOCAL_SUBJECT_PREFIX}${u.id}`);
    const again = await localUserService.byUsername(`${PREFIX}_ops`);
    expect(`${LOCAL_SUBJECT_PREFIX}${again!.id}`).toBe(u.subject);
  });

  it("⚠ NEVER returns a password hash, on any path", async () => {
    const u = await localUserService.create({ username: `${PREFIX}_nohash`, password: pw, createdBy: null });
    expect(JSON.stringify(u)).not.toContain("scrypt");
    expect(JSON.stringify(await localUserService.list())).not.toContain("scrypt");
    expect(JSON.stringify(await localUserService.setActive(u.id, false))).not.toContain("scrypt");
  });

  it("⚠ REFUSES an email on the super-admin allowlist — the control, not a nicety", async () => {
    /**
     * ⚠ **THIS IS WHAT MAKES "LOCAL ACCOUNTS ARE WORKSPACE-SCOPED" TRUE.**
     * `config.isSuperAdmin` matches on subject **or email** — it was
     * subject-only once and that was a silent bug — and the email a local
     * account carries travels in its identity token. So omitting the
     * super-admin column and then accepting an allowlisted email grants
     * platform-wide rights through a form that deliberately has no such
     * switch, with nothing anywhere reporting it.
     */
    config.superAdminEmails.add("boss@example.com");
    await expect(
      localUserService.create({
        username: `${PREFIX}_boss`,
        password: pw,
        email: "boss@example.com",
        createdBy: null,
      }),
    ).rejects.toThrow(/super-admin allowlist/i);
    expect(await localUserService.byUsername(`${PREFIX}_boss`)).toBeUndefined();
  });

  it("⚠ the allowlist match is CASE-INSENSITIVE, as the predicate is", async () => {
    // A refusal defeated by the shift key is not a refusal.
    config.superAdminEmails.add("boss@example.com");
    await expect(
      localUserService.create({
        username: `${PREFIX}_boss2`,
        password: pw,
        email: "BOSS@Example.COM",
        createdBy: null,
      }),
    ).rejects.toThrow(/super-admin allowlist/i);
  });

  it("permits an ordinary email, so the refusal above is not refusing everything", async () => {
    // The control. Without it "refuses allowlisted emails" and "refuses every
    // email" score identically.
    config.superAdminEmails.add("boss@example.com");
    const u = await localUserService.create({
      username: `${PREFIX}_ok`,
      password: pw,
      email: "ops@example.com",
      createdBy: null,
    });
    expect(u.email).toBe("ops@example.com");
  });

  it("refuses a short password and a malformed username, each by name", async () => {
    await expect(
      localUserService.create({ username: `${PREFIX}_short`, password: "short", createdBy: null }),
    ).rejects.toThrow(/at least 12 characters/);
    for (const bad of ["ab", "Has Capitals", "has space", "-leading", "sym#bol", "x".repeat(70)]) {
      await expect(localUserService.create({ username: bad, password: pw, createdBy: null })).rejects.toThrow(
        /username must be/,
      );
    }
  });

  it("case-folds the username, so one person cannot become two accounts", async () => {
    const u = await localUserService.create({ username: `${PREFIX}_MiXeD`, password: pw, createdBy: null });
    expect(u.username).toBe(`${PREFIX}_mixed`);
    await expect(
      localUserService.create({ username: `${PREFIX}_MIXED`, password: pw, createdBy: null }),
    ).rejects.toThrow(/already exists/);
  });

  it("records who created it, from the caller's subject", async () => {
    const u = await localUserService.create({ username: `${PREFIX}_who`, password: pw, createdBy: "subject-9" });
    expect(u.createdBy).toBe("subject-9");
  });
});

describe("localUserService.verify", () => {
  it("accepts the right password and refuses the wrong one", async () => {
    await localUserService.create({ username: `${PREFIX}_v`, password: pw, createdBy: null });
    expect(await localUserService.verify(`${PREFIX}_v`, pw)).not.toBeNull();
    expect(await localUserService.verify(`${PREFIX}_v`, `${pw}x`)).toBeNull();
  });

  it("is case-insensitive on the username, matching how it was stored", async () => {
    await localUserService.create({ username: `${PREFIX}_case`, password: pw, createdBy: null });
    expect(await localUserService.verify(`${PREFIX}_CASE`, pw)).not.toBeNull();
  });

  it("⚠ a DEACTIVATED account cannot sign in, and reactivating restores it", async () => {
    const u = await localUserService.create({ username: `${PREFIX}_off`, password: pw, createdBy: null });
    await localUserService.setActive(u.id, false);
    expect(await localUserService.verify(`${PREFIX}_off`, pw)).toBeNull();
    await localUserService.setActive(u.id, true);
    expect(await localUserService.verify(`${PREFIX}_off`, pw)).not.toBeNull();
  });

  it("⚠ an unknown username is indistinguishable from a wrong password", async () => {
    // Both `null`, and the service does the scrypt work on the miss path too so
    // the response TIME does not answer either. Three distinguishable answers
    // is an account-enumeration oracle.
    expect(await localUserService.verify(`${PREFIX}_nobody`, pw)).toBeNull();
  });

  it("⚠ a new password takes effect and the OLD one stops working", async () => {
    // Half a rotation is worse than none: an old password that still works is
    // a credential the person believes they have changed.
    const u = await localUserService.create({ username: `${PREFIX}_rot`, password: pw, createdBy: null });
    await localUserService.setPassword(u.id, "a-different-passphrase");
    expect(await localUserService.verify(`${PREFIX}_rot`, pw)).toBeNull();
    expect(await localUserService.verify(`${PREFIX}_rot`, "a-different-passphrase")).not.toBeNull();
  });

  it("stamps last_sign_in_at on success and not on failure", async () => {
    const u = await localUserService.create({ username: `${PREFIX}_seen`, password: pw, createdBy: null });
    expect(u.lastSignInAt).toBeNull();
    await localUserService.verify(`${PREFIX}_seen`, "wrong-passphrase-here");
    let [row] = await db.select().from(localUsers).where(eq(localUsers.id, u.id));
    expect(row!.lastSignInAt).toBeNull();
    await localUserService.verify(`${PREFIX}_seen`, pw);
    // The write is unawaited by design — bookkeeping must not add latency to a
    // sign-in — so this polls rather than assuming it has landed.
    for (let i = 0; i < 40 && !row!.lastSignInAt; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      [row] = await db.select().from(localUsers).where(eq(localUsers.id, u.id));
    }
    expect(row!.lastSignInAt).not.toBeNull();
  });
});

describe("the shape of the service itself", () => {
  it("⚠ has NO role and NO super-admin field anywhere in its view", async () => {
    // An account is an identity. Rights live in `workspace_members`, keyed on
    // the subject — one place a person's rights are read from, whichever door
    // they came through. A field here would be a second authority.
    const u = await localUserService.create({ username: `${PREFIX}_shape`, password: pw, createdBy: null });
    for (const forbidden of ["role", "roles", "superAdmin", "isSuperAdmin", "permissions"]) {
      expect(Object.keys(u)).not.toContain(forbidden);
    }
  });
});
