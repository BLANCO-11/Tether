// src/services/local-user.service.ts — a username and password for a person
// with no AD identity.
//
// ── ⚠ WHAT THIS REPLACES, AND WHY IT WAS NOT EXTENSIBLE ─────────────────────
//
// `packages/client/src/auth.ts` has ONE credentials account, read from
// `LOCAL_ADMIN_EMAIL`/`LOCAL_ADMIN_PASSWORD` and compared with `!==` on a
// plain-text value. It cannot grow: a second person means a second pair of
// variables and a redeploy, every holder of the env file knows every password,
// and that one account is hardcoded to `["superadmin", "admin"]`.
//
// ── ⚠ AN ACCOUNT IS AN IDENTITY. IT IS NOT A PERMISSION ─────────────────────
//
// There is no role column and no super-admin flag. Workspace rights live in
// `workspace_members`, keyed on the subject this module issues, so a person's
// rights are read from one place whether they arrived through Entra or through
// here — and platform rights stay in `SUPER_ADMIN_EMAILS`, on the server, where
// creating an account cannot reach them.
//
// ⚠ **THE EMAIL REFUSAL IS WHAT MAKES THAT TRUE RATHER THAN MERELY INTENDED.**
// `config.isSuperAdmin` matches on subject **or email** (it was subject-only
// once, and that was a silent bug — see the 2026-08-21 follow-up). The email a
// local account carries travels in its identity token. So omitting the column
// and then accepting `SUPER_ADMIN_EMAILS[0]` as an account's email grants
// exactly what omitting the column excludes, through the back door, with no
// error anywhere. `create` refuses it by name.
//
// ── ⚠ THE SUBJECT MUST BE STABLE, AND THIS IS THE BUG THAT PROVES IT ────────
//
// `workspace_members.subject` is the key a role is looked up by. On 2026-08-21
// one Entra user held FIVE `platform_users` rows because `auth.ts` signed
// `token.sub`, which rotates — so an assignment silently stopped applying the
// next time they signed in, with the row sitting right there. A local account's
// subject is `local:<row uuid>`, which is why the row is DEACTIVATED and never
// deleted: a deleted row frees its username, and the membership rows keyed on
// the old subject would then apply to whoever took the name.
import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { localUsers, workspaceMembers, workspaces } from "../db/schema.js";
import { config } from "../config/index.js";

/** The prefix that makes a local subject unmistakable in `workspace_members`. */
export const LOCAL_SUBJECT_PREFIX = "local:";

/**
 * scrypt parameters.
 *
 * ⚠ **STORED WITH EVERY HASH, never read from here at verify time.** A cost
 * raised in this file while old rows carry the old cost would make every
 * existing password fail to verify — silently, and for everyone at once. The
 * hash string names its own parameters, so raising these affects new and
 * re-hashed passwords only.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 } as const;

/** `scrypt$N$r$p$salt$hash`, all base64. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keyLen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    // ⚠ scrypt's default 32 MB limit refuses N=16384,r=8 outright, and the
    // failure is a THROW at hash time — so without this, creating an account
    // 500s and verifying one never gets the chance.
    maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

/**
 * Does this password produce the stored hash?
 *
 * ⚠ **CONSTANT-TIME, and `timingSafeEqual` THROWS on a length mismatch** —
 * which would turn a malformed stored hash into a 500 a caller can trigger by
 * attempting a sign-in. Lengths are compared first, on the buffers, exactly as
 * `requireApiKey` does.
 *
 * ⚠ **Every failure path returns `false` and none of them says which.** "No
 * such user", "wrong password" and "this row's hash is corrupt" are one answer
 * to a caller, because three answers is an account-enumeration oracle.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P)) return false;
  // A stored cost far above anything this code ever wrote is a corrupt or
  // hostile row, not a password to spend a minute of CPU on.
  if (N > 1 << 20 || R > 32 || P > 16) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64");
    /**
     * ⚠ **A FLOOR ON THE STORED LENGTH, AND WITHOUT IT THIS FUNCTION WAS
     * BROKEN — found by its own test, not by reading.**
     *
     * The derivation below uses `expected.length` as the key length, which is
     * the standard shape and reads as obviously fine. It is not: scrypt output
     * is a prefix, so a hash TRUNCATED to one byte derives one byte and
     * matches ~1 in 256 passwords. The attacker-controlled value was the
     * stored length itself, so anything that could write or corrupt a row —
     * including a bad restore — turned a sign-in into a coin flip.
     *
     * 32 bytes (256 bits) is the floor rather than an exact equality so that
     * `SCRYPT.keyLen` can change without invalidating every existing password,
     * which is the same reason the cost travels with the hash.
     */
    if (expected.length < 32) return false;
    actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
      N,
      r: R,
      p: P,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export type LocalUserView = {
  id: string;
  subject: string;
  username: string;
  email: string | null;
  name: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  lastSignInAt: string | null;
};

/** ⚠ `passwordHash` is NEVER in this shape. There is no route that returns one. */
function toView(r: typeof localUsers.$inferSelect): LocalUserView {
  return {
    id: r.id,
    subject: `${LOCAL_SUBJECT_PREFIX}${r.id}`,
    username: r.username,
    email: r.email ?? null,
    name: r.name ?? null,
    isActive: r.isActive,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt.toISOString(),
    lastSignInAt: r.lastSignInAt ? r.lastSignInAt.toISOString() : null,
  };
}

function bad(message: string, statusCode = 400): Error & { statusCode?: number } {
  const e = new Error(message) as Error & { statusCode?: number };
  e.statusCode = statusCode;
  return e;
}

/**
 * ⚠ Deliberately conservative and deliberately NOT an email shape. A username
 * is typed at a sign-in box, so a leading space or a homoglyph-friendly
 * character is a person who cannot get in and cannot see why.
 */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/**
 * ⚠ **LENGTH IS THE ONLY RULE, and that is a decision rather than laziness.**
 * A composition rule ("one capital, one digit, one symbol") shrinks the search
 * space to what the rule permits and pushes people toward `Password1!`. Twelve
 * characters with no other constraint is the stronger requirement and the one
 * somebody can satisfy with a passphrase.
 */
const MIN_PASSWORD = 12;

export const localUserService = {
  async list(): Promise<LocalUserView[]> {
    const rows = await db.select().from(localUsers).orderBy(localUsers.username);
    return rows.map(toView);
  },

  async create(input: {
    username: string;
    password: string;
    email?: string | null;
    name?: string | null;
    createdBy: string | null;
  }): Promise<LocalUserView> {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw bad(
        "a username must be 3-64 characters of lower-case letters, digits, dot, dash or underscore, " +
          "and start with a letter or digit",
      );
    }
    if (input.password.length < MIN_PASSWORD) {
      throw bad(`a password must be at least ${MIN_PASSWORD} characters`);
    }
    const email = input.email?.trim() || null;
    /**
     * ⚠ **THE CONTROL THAT MAKES "NO SUPER ADMINS HERE" TRUE.**
     * `config.isSuperAdmin` matches on email as well as subject, so an account
     * created with an allowlisted email would arrive as a platform super admin
     * — through a form that deliberately has no such switch, with nothing
     * anywhere reporting it. Checked against the identity shape the token will
     * actually carry, not against the string, so the two cannot disagree.
     */
    if (config.isSuperAdmin({ subject: null, email })) {
      throw bad(
        "that email is on the deployment's super-admin allowlist, so this account would have " +
          "platform-wide rights. Local accounts are workspace-scoped by design — use a different " +
          "email, or grant the person workspace roles instead.",
      );
    }
    if (await this.byUsername(username)) {
      throw bad(`a local account named "${username}" already exists`, 409);
    }
    const [row] = await db
      .insert(localUsers)
      .values({
        username,
        email,
        name: input.name?.trim() || null,
        passwordHash: hashPassword(input.password),
        createdBy: input.createdBy,
      })
      .returning();
    return toView(row!);
  },

  async byUsername(username: string): Promise<typeof localUsers.$inferSelect | undefined> {
    const [row] = await db
      .select()
      .from(localUsers)
      .where(eq(localUsers.username, username.trim().toLowerCase()))
      .limit(1);
    return row;
  },

  /**
   * The one ACTIVE account with this email, or undefined.
   *
   * ⚠ **The sign-in form is one field**, so a person handed
   * `ops@example.com` as their address will type it — and refusing that reads
   * as a wrong password. Username is still tried first.
   *
   * ⚠ **`email` is NOT unique** (two people can share a mailbox), so two
   * matches means there is no answer and this returns undefined rather than
   * picking one — signing somebody in as the wrong person is far worse than
   * asking them to use their username.
   */
  async byUniqueEmail(email: string): Promise<typeof localUsers.$inferSelect | undefined> {
    const want = email.trim().toLowerCase();
    if (!want.includes("@")) return undefined;
    const rows = await db.select().from(localUsers).where(eq(localUsers.isActive, true));
    const hits = rows.filter((r) => (r.email ?? "").trim().toLowerCase() === want);
    return hits.length === 1 ? hits[0] : undefined;
  },

  /**
   * One account by its id, as the ADMIN surface sees it.
   *
   * ⚠ Returns the view, not the row — the row carries `passwordHash`, and a
   * getter that hands it to a route is one `res.json(row)` away from publishing
   * every hash on this deployment. `byUsername`/`byUniqueEmail` return rows
   * because verification needs the hash; nothing else does.
   */
  async byId(id: string): Promise<LocalUserView> {
    const [row] = await db.select().from(localUsers).where(eq(localUsers.id, id)).limit(1);
    if (!row) throw bad("no such local account", 404);
    return toView(row);
  },

  /**
   * The address to record on a workspace membership for this account.
   *
   * ── ⚠ WHY THIS IS NOT SIMPLY `row.email` ────────────────────────────────────
   *
   * `local_users.email` is nullable and display-only — an account is identified
   * by its username. `workspace_members.email` is **NOT NULL**, and `grantSchema`
   * validates it with zod's `.email()`.
   *
   * That combination is what made an email-less account UNGRANTABLE through the
   * members route: the obvious fallback, the `<username>@local` form
   * `packages/client`'s credentials provider already uses, **fails `.email()`**
   * because the domain has no dot. So the product could create an account it had
   * no way to authorise, and the error named a field the admin never filled in.
   *
   * ⚠ **`.invalid` is RFC 2606 reserved: it can never resolve or receive mail.**
   * That is the property that matters, not merely that it parses.
   * `workspace_members.email` is rendered beside a person's name, so a synthetic
   * value there must be unmistakably synthetic — a plausible-looking address
   * would be worse than a blank one, because somebody would eventually send to
   * it.
   *
   * ⚠ **The local part is SANITISED, and it has to be: `username` has no charset
   * restriction** (`z.string().min(1).max(128)`), so `ops viewer` is a legal
   * account name and `ops viewer@local.invalid` is not a legal address. Without
   * this, granting such an account would fail `grantSchema` with a validation
   * error about an email nobody typed — the same dead end one layer along.
   * Anything outside the email local-part charset becomes `.`, runs are
   * collapsed, and the ends are trimmed; an empty result falls back to the
   * account's id, which is always safe.
   */
  membershipEmail(view: LocalUserView): string {
    const real = (view.email ?? "").trim();
    if (real.includes("@")) return real;
    const local = view.username
      .toLowerCase()
      .replace(/[^a-z0-9._+-]+/g, ".")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.\-+]+|[.\-+]+$/g, "");
    return `${local || view.id}@local.invalid`;
  },

  /**
   * Every workspace this subject holds a role in, with the workspace's name.
   *
   * ⚠ **ONE SUBJECT, AND THE SUBJECT IS NOT A PARAMETER A CALLER CHOOSES.**
   * `routes/local-users.ts` derives it from a `local_users` row, so this cannot
   * be pointed at an Entra identity and there is no shape of request that
   * widens it to "everybody". See that route for why this is not the
   * cross-workspace member listing `members.ts` declines to build.
   *
   * ⚠ **Soft-deleted workspaces are EXCLUDED, and the membership row is not.**
   * A grant on a deleted workspace is history, not access; listing it would put
   * a workspace nobody can reach on screen beside ones they can. Deleting the
   * row instead would be this function — a read — writing.
   */
  async accessFor(
    subject: string,
  ): Promise<Array<{ workspaceId: string; workspaceName: string; role: string; grantedBy: string }>> {
    return db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        workspaceName: workspaces.name,
        role: workspaceMembers.role,
        grantedBy: workspaceMembers.grantedBy,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.subject, subject), isNull(workspaces.deletedAt)));
  },

  /** Permanently remove an account. See the route for what this costs. */
  async remove(id: string): Promise<LocalUserView> {
    const [row] = await db.delete(localUsers).where(eq(localUsers.id, id)).returning();
    if (!row) throw bad("no such local account", 404);
    return toView(row);
  },

  /**
   * Rename, or change the display fields.
   *
   * ⚠ **The SUBJECT does not change**, because it is derived from the row's id
   * — so a rename cannot detach the person from their `workspace_members`
   * rows. That is the whole reason the subject is not the username.
   */
  async update(
    id: string,
    input: { username?: string; email?: string | null; name?: string | null },
  ): Promise<LocalUserView> {
    const patch: Partial<typeof localUsers.$inferInsert> = { updatedAt: new Date() };
    if (input.username !== undefined) {
      const username = input.username.trim().toLowerCase();
      if (!USERNAME_RE.test(username)) {
        throw bad(
          "a username must be 3-64 characters of lower-case letters, digits, dot, dash or underscore, " +
            "and start with a letter or digit",
        );
      }
      const clash = await this.byUsername(username);
      if (clash && clash.id !== id) throw bad(`a local account named "${username}" already exists`, 409);
      patch.username = username;
    }
    if (input.email !== undefined) {
      const email = input.email?.trim() || null;
      // ⚠ The SAME refusal `create` carries, and for the same reason:
      // `config.isSuperAdmin` matches on email, so an EDIT to an allowlisted
      // address would grant platform rights the create path refuses. Omitting
      // it here would make the control one rename away from nothing.
      if (config.isSuperAdmin({ subject: null, email })) {
        throw bad(
          "that email is on the deployment's super-admin allowlist, so this account would have " +
            "platform-wide rights. Local accounts are workspace-scoped by design.",
        );
      }
      patch.email = email;
    }
    if (input.name !== undefined) patch.name = input.name?.trim() || null;
    const [row] = await db.update(localUsers).set(patch).where(eq(localUsers.id, id)).returning();
    if (!row) throw bad("no such local account", 404);
    return toView(row);
  },

  async setPassword(id: string, password: string): Promise<void> {
    if (password.length < MIN_PASSWORD) {
      throw bad(`a password must be at least ${MIN_PASSWORD} characters`);
    }
    const [row] = await db
      .update(localUsers)
      .set({ passwordHash: hashPassword(password), updatedAt: new Date() })
      .where(eq(localUsers.id, id))
      .returning();
    if (!row) throw bad("no such local account", 404);
  },

  async setActive(id: string, isActive: boolean): Promise<LocalUserView> {
    const [row] = await db
      .update(localUsers)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(localUsers.id, id))
      .returning();
    if (!row) throw bad("no such local account", 404);
    return toView(row);
  },

  /**
   * The sign-in check. `null` for every failure, and the reasons are NOT
   * distinguished — see `verifyPassword`.
   *
   * ⚠ **It does the scrypt work even when there is no such account**, against a
   * throwaway hash. Returning early on an unknown username makes the response
   * time an account-existence oracle: ~100 ms for a real name, ~0 for one that
   * is free. The dummy verify is what flattens that.
   */
  async verify(username: string, password: string): Promise<LocalUserView | null> {
    const row = (await this.byUsername(username)) ?? (await this.byUniqueEmail(username));
    if (!row || !row.isActive) {
      verifyPassword(password, DUMMY_HASH);
      return null;
    }
    if (!verifyPassword(password, row.passwordHash)) return null;
    // Best-effort, unawaited: bookkeeping on the sign-in path must not add
    // latency to it, nor turn a successful sign-in into a 500.
    void db
      .update(localUsers)
      .set({ lastSignInAt: new Date() })
      .where(and(eq(localUsers.id, row.id), eq(localUsers.isActive, true)))
      .catch((e) => console.warn(`[local-user] last_sign_in_at not recorded for ${row.id}`, e));
    return toView(row);
  },
};

/**
 * A real hash of a value nobody knows, for the unknown-username path.
 *
 * ⚠ Computed ONCE at module load rather than per attempt — hashing a random
 * string per request costs the same scrypt work twice and makes the miss path
 * *slower* than the hit path, which is the same oracle upside down.
 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString("hex"));
