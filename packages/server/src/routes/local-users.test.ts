/**
 * src/routes/local-users.test.ts — the gate on creating accounts, and the
 * sign-in surface, over real HTTP through `createApp()`.
 *
 * ⚠ **THE SPLIT BETWEEN THE TWO ROUTERS IS THE SUBJECT.** `/api/local-users` is
 * the admin surface and must be unreachable without a super admin.
 * `/api/local-auth/verify` answers *before anybody has a session*, because it
 * is what mints one — so it cannot require an identity, and the API key is all
 * it has. That makes it the only route in the product that takes a password,
 * and the properties worth pinning are that it says nothing about WHY it
 * refused and that it is throttled.
 *
 * Over HTTP rather than by calling the handlers, because the thing under test
 * is which middleware runs — which a direct call skips entirely.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { like } from "drizzle-orm";
import { db } from "../db/index.js";
import { localUsers } from "../db/schema.js";
import { config } from "../config/index.js";
import { localUserService } from "../services/local-user.service.js";

const { createApp } = await import("../app.js");
const app = createApp();
let base = "";
let server: ReturnType<typeof app.listen>;

const PREFIX = "zzrt";
const PW = "a-long-enough-passphrase";
const KEY = config.parentApiKey;
const SUPER = "super@example.com";
const ORDINARY = "ordinary@example.com";

/** A verified identity token — the same secret `resolveIdentity` checks. */
async function identity(email: string, subject = email): Promise<string> {
  return new SignJWT({ sub: subject, email, name: email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(config.identity.secret));
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; key?: string | null } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.key !== null) headers["x-api-key"] = opts.key ?? KEY;
  if (opts.token) headers["x-foundry-identity"] = opts.token;
  const r = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body is itself the finding */
  }
  return { status: r.status, body: json as Record<string, unknown> | null, text };
}

const REAL = [...config.superAdminEmails];
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    // Express 5 hands a listen failure to this callback; passing `resolve` straight in would resolve on it.
    server = app.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await db.delete(localUsers).where(like(localUsers.username, `${PREFIX}%`));
  config.superAdminEmails.clear();
  for (const e of REAL) config.superAdminEmails.add(e);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  config.superAdminEmails.clear();
  config.superAdminEmails.add(SUPER);
  await db.delete(localUsers).where(like(localUsers.username, `${PREFIX}%`));
});

describe("the admin surface is super-admin only", () => {
  it("⚠ refuses the API KEY ALONE — a request is not a person", () => {
    // The API key authorises the request; it does not name anybody. Creating an
    // account with it and no identity would record `created_by: null` for a
    // decision nobody is accountable for.
    return call("/api/local-users", { method: "POST", body: { username: `${PREFIX}_x`, password: PW } }).then(
      (r) => expect(r.status).toBe(401),
    );
  });

  it("refuses a signed-in NON-super-admin", async () => {
    const r = await call("/api/local-users", {
      method: "POST",
      body: { username: `${PREFIX}_x`, password: PW },
      token: await identity(ORDINARY),
    });
    expect(r.status).toBe(403);
    expect(await localUserService.byUsername(`${PREFIX}_x`)).toBeUndefined();
  });

  it("refuses a non-super-admin on the LIST too, not only on the writes", async () => {
    // The list carries usernames and who created them; it is not public.
    expect((await call("/api/local-users", { token: await identity(ORDINARY) })).status).toBe(403);
  });

  it("lets a super admin create, list, reset and deactivate", async () => {
    const token = await identity(SUPER);
    const made = await call("/api/local-users", {
      method: "POST",
      body: { username: `${PREFIX}_ops`, password: PW, name: "Ops", email: "ops@example.com" },
      token,
    });
    expect(made.status).toBe(201);
    const user = (made.body as { user: { id: string; subject: string } }).user;
    expect(user.subject).toBe(`local:${user.id}`);

    const listed = await call("/api/local-users", { token });
    expect(listed.status).toBe(200);
    expect((listed.body as { users: Array<{ username: string }> }).users.map((u) => u.username)).toContain(
      `${PREFIX}_ops`,
    );

    expect(
      (await call(`/api/local-users/${user.id}/password`, {
        method: "POST",
        body: { password: "another-long-passphrase" },
        token,
      })).status,
    ).toBe(204);

    const off = await call(`/api/local-users/${user.id}/active`, {
      method: "POST",
      body: { isActive: false },
      token,
    });
    expect((off.body as { user: { isActive: boolean } }).user.isActive).toBe(false);
  });

  it("⚠ REFUSES an unknown field rather than dropping it — `superAdmin` above all", async () => {
    /**
     * A caller who sends `{"superAdmin": true}` must learn the field does not
     * exist, not watch it be ignored and assume it worked. `.strict()` is what
     * makes "there is no such switch" legible from outside.
     */
    /**
     * ⚠ `createdBy` is in this list and it is the load-bearing entry.
     * Perturbing the handler to read `req.body.createdBy` turns NOTHING red,
     * because `.strict()` refuses the request before the handler runs — so
     * `.strict()` IS the control for the body-derived-author rule here, not the
     * `actorOf` line. Said in the route too, because a reader checking that
     * rule will look at the handler first.
     */
    for (const extra of [
      { superAdmin: true },
      { role: "admin" },
      { subject: "local:someone-else" },
      { createdBy: "somebody-else" },
    ]) {
      const r = await call("/api/local-users", {
        method: "POST",
        body: { username: `${PREFIX}_strict`, password: PW, ...extra },
        token: await identity(SUPER),
      });
      expect(r.status).toBe(400);
      expect(await localUserService.byUsername(`${PREFIX}_strict`)).toBeUndefined();
    }
  });

  it("⚠ no response on any admin path carries a password or a hash", async () => {
    const token = await identity(SUPER);
    const made = await call("/api/local-users", {
      method: "POST",
      body: { username: `${PREFIX}_leak`, password: PW, email: "leak@example.com" },
      token,
    });
    const listed = await call("/api/local-users", { token });
    for (const r of [made, listed]) {
      expect(r.text).not.toContain(PW);
      expect(r.text).not.toContain("scrypt");
      expect(r.text).not.toContain("password_hash");
      expect(r.text).not.toContain("passwordHash");
    }
  });
});

describe("the sign-in surface", () => {
  it("verifies a real account and returns its subject, with no hash", async () => {
    const u = await localUserService.create({ username: `${PREFIX}_in`, password: PW, createdBy: null });
    const r = await call("/api/local-auth/verify", {
      method: "POST",
      body: { username: `${PREFIX}_in`, password: PW },
    });
    expect(r.status).toBe(200);
    expect((r.body as { user: { subject: string } }).user.subject).toBe(u.subject);
    expect(r.text).not.toContain("scrypt");
  });

  it("⚠ needs NO identity — it is what mints one", async () => {
    // A `requireIdentity` here would make it impossible to sign in at all, and
    // the symptom would be a sign-in form that always says the password is
    // wrong.
    await localUserService.create({ username: `${PREFIX}_noid`, password: PW, createdBy: null });
    const r = await call("/api/local-auth/verify", {
      method: "POST",
      body: { username: `${PREFIX}_noid`, password: PW },
    });
    expect(r.status).toBe(200);
  });

  it("⚠ still needs the API KEY — it is not a public route", async () => {
    await localUserService.create({ username: `${PREFIX}_key`, password: PW, createdBy: null });
    const r = await call("/api/local-auth/verify", {
      method: "POST",
      body: { username: `${PREFIX}_key`, password: PW },
      key: null,
    });
    expect(r.status).toBe(401);
    // And it did not answer the question on the way out.
    expect(r.text).not.toContain("subject");
  });

  it("⚠ EVERY failure is the same 401 with no detail", async () => {
    /**
     * "No such account", "wrong password" and "deactivated" are one answer,
     * because three answers let anybody holding the key enumerate accounts —
     * and the key is held by the web container, which serves a public sign-in
     * form.
     */
    const u = await localUserService.create({ username: `${PREFIX}_same`, password: PW, createdBy: null });
    await localUserService.setActive(u.id, false);
    const bodies = [
      { username: `${PREFIX}_nobody_at_all`, password: PW },
      { username: `${PREFIX}_same`, password: "wrong-passphrase-entirely" },
      { username: `${PREFIX}_same`, password: PW },
    ];
    const seen = new Set<string>();
    for (const body of bodies) {
      const r = await call("/api/local-auth/verify", { method: "POST", body });
      expect(r.status).toBe(401);
      seen.add(r.text);
    }
    // One distinct body across all three — not three messages.
    expect(seen.size).toBe(1);
  });
});

/**
 * ── Workspace access, set from the local-accounts surface ───────────────────
 *
 * ⚠ **THE PROPERTY THIS FEATURE EXISTS FOR: an account that has NEVER SIGNED
 * IN can be granted access.** `MembersPanel`'s picker is built from
 * `platform_users` — identities this API has *seen* — so a freshly created
 * account is absent from it, and granting meant pasting `local:<uuid>` into a
 * free-text field in another panel.
 *
 * ⚠ **And an account with NO EMAIL is grantable**, which it was not: the
 * members route validates `email` with zod's `.email()`, and the
 * `<username>@local` form fails it. That was the product creating an account it
 * could not authorise.
 */
describe("a local account's workspace access", () => {
  const WS_PREFIX = "zzrt-access-ws";

  /** A real workspace to grant in, cleaned up by name prefix. */
  async function workspace(name: string): Promise<string> {
    const { workspaceService } = await import("../services/workspace.service.js");
    const ws = await workspaceService.create({ name: `${WS_PREFIX} ${name}` });
    return ws.id;
  }

  async function mk(username: string, email?: string) {
    const token = await identity(SUPER);
    const r = await call("/api/local-users", {
      method: "POST",
      body: { username, password: PW, ...(email ? { email } : {}) },
      token,
    });
    expect(r.status).toBe(201);
    return (r.body!.user as { id: string; subject: string });
  }

  it("grants, lists and revokes — for an account with NO email and no sign-in", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_noemail`);
    const ws = await workspace("a");

    // Nothing yet, and it is an empty LIST rather than a 404 — "no access" is a
    // real answer about a real account.
    expect((await call(`/api/local-users/${u.id}/access`, { token })).body).toEqual({ access: [] });

    const g = await call(`/api/local-users/${u.id}/access/${ws}`, {
      method: "PUT",
      body: { role: "admin" },
      token,
    });
    expect(g.status).toBe(200);
    const member = g.body!.member as { subject: string; email: string; role: string };
    // ⚠ The subject is the account's, derived server-side — the client never
    // sent one.
    expect(member.subject).toBe(u.subject);
    expect(member.role).toBe("admin");
    // ⚠ `.invalid` is RFC 2606 reserved: it cannot resolve or receive mail, so a
    // synthetic address rendered beside a name is unmistakably synthetic.
    expect(member.email).toBe(`${PREFIX}_noemail@local.invalid`);

    const listed = (await call(`/api/local-users/${u.id}/access`, { token })).body!.access as Array<
      Record<string, unknown>
    >;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.workspaceId).toBe(ws);
    expect(listed[0]!.role).toBe("admin");
    expect(String(listed[0]!.workspaceName)).toContain(WS_PREFIX);

    const d = await call(`/api/local-users/${u.id}/access/${ws}`, { method: "DELETE", token });
    expect(d.status).toBe(200);
    expect((await call(`/api/local-users/${u.id}/access`, { token })).body).toEqual({ access: [] });
  });

  it("a real email is recorded as itself, never replaced by the synthetic one", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_withemail`, "zzrt.person@example.com");
    const ws = await workspace("b");
    const g = await call(`/api/local-users/${u.id}/access/${ws}`, {
      method: "PUT",
      body: { role: "author" },
      token,
    });
    expect((g.body!.member as { email: string }).email).toBe("zzrt.person@example.com");
  });

  it("changing the role UPDATES the one row rather than adding a second", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_change`);
    const ws = await workspace("c");
    await call(`/api/local-users/${u.id}/access/${ws}`, { method: "PUT", body: { role: "author" }, token });
    await call(`/api/local-users/${u.id}/access/${ws}`, { method: "PUT", body: { role: "approver" }, token });
    const listed = (await call(`/api/local-users/${u.id}/access`, { token })).body!.access as unknown[];
    expect(listed).toHaveLength(1);
    expect((listed[0] as { role: string }).role).toBe("approver");
  });

  /**
   * ⚠ "There was nothing to remove" and "removed" are different answers. A 200
   * for both would report success for a revoke that found nothing.
   */
  it("revoking access that was never granted is a 404, not a cheerful 200", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_norow`);
    const ws = await workspace("d");
    expect((await call(`/api/local-users/${u.id}/access/${ws}`, { method: "DELETE", token })).status).toBe(404);
  });

  it("refuses a role the product does not have, rather than storing it", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_badrole`);
    const ws = await workspace("e");
    const r = await call(`/api/local-users/${u.id}/access/${ws}`, {
      method: "PUT",
      body: { role: "superadmin" },
      token,
    });
    expect(r.status).toBe(400);
    expect((await call(`/api/local-users/${u.id}/access`, { token })).body).toEqual({ access: [] });
  });

  /**
   * ⚠ THE GATE. These three routes are on the super-admin router, and a test
   * that only proved the happy path would pass just as well if they were not.
   */
  it("is super-admin only — all three, not just the writes", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_gate`);
    const ws = await workspace("f");
    const ord = await identity(ORDINARY);
    expect((await call(`/api/local-users/${u.id}/access`, { token: ord })).status).toBe(403);
    expect(
      (await call(`/api/local-users/${u.id}/access/${ws}`, { method: "PUT", body: { role: "admin" }, token: ord }))
        .status,
    ).toBe(403);
    expect((await call(`/api/local-users/${u.id}/access/${ws}`, { method: "DELETE", token: ord })).status).toBe(
      403,
    );
    // …and the API key alone is not a person.
    expect((await call(`/api/local-users/${u.id}/access`)).status).toBe(401);
    // Nothing was written by any of the four.
    expect((await call(`/api/local-users/${u.id}/access`, { token })).body).toEqual({ access: [] });
  });

  /**
   * ⚠ **A LEGAL USERNAME IS NOT ALWAYS A LEGAL EMAIL LOCAL PART, and this is the
   * gap.** `USERNAME_RE` is `/^[a-z0-9][a-z0-9._-]{2,63}$/`, which permits
   * consecutive dots (`a..b`) and a trailing `.` or `-` — all of which zod's
   * `.email()` rejects. So without the sanitising in `membershipEmail`, one of
   * these accounts would be creatable and then **ungrantable**, failing
   * `grantSchema` with a validation error about an email nobody typed: exactly
   * the dead end this feature exists to remove, one layer along.
   *
   * Found by perturbing, not by reading — the first version of this test used a
   * username with a space and creation refused it, which is what sent me to the
   * regex.
   */
  it("sanitises a legal username that is not a legal email local part", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}..odd.`);
    const ws = await workspace("h");
    const g = await call(`/api/local-users/${u.id}/access/${ws}`, {
      method: "PUT",
      body: { role: "author" },
      token,
    });
    expect(g.status).toBe(200);
    expect((g.body!.member as { email: string }).email).toBe(`${PREFIX}.odd@local.invalid`);
  });

  /**
   * ⚠ A grant on a soft-deleted workspace is HISTORY, not access. Listing it
   * would put a workspace nobody can reach on screen beside ones they can.
   */
  it("does not list access to a soft-deleted workspace", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_deleted`);
    const ws = await workspace("i");
    await call(`/api/local-users/${u.id}/access/${ws}`, { method: "PUT", body: { role: "admin" }, token });
    expect(((await call(`/api/local-users/${u.id}/access`, { token })).body!.access as unknown[])).toHaveLength(1);

    const { workspaceService } = await import("../services/workspace.service.js");
    await workspaceService.remove(ws);
    expect((await call(`/api/local-users/${u.id}/access`, { token })).body).toEqual({ access: [] });
  });

  /**
   * ⚠ **THE SECURITY PROPERTY, AND IT HAD NO TEST UNTIL A PERTURBATION SAID SO.**
   * `accessSchema` is `.strict()`, so a body carrying a `subject` is a 400 and
   * not a silently ignored field — the same reason `createSchema` refuses one.
   * Without this, a caller could attach an existing person's `workspace_members`
   * rows to a new account, which is precisely what deriving the subject
   * server-side exists to prevent.
   *
   * Adding `subject` to the schema and preferring it over the row's turned NO
   * test red. That is I-38, in the one place it would matter most.
   */
  it("⚠ refuses a body that names a SUBJECT — it is derived, never accepted", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_nosubj`);
    const victim = await mk(`${PREFIX}_victim`);
    const ws = await workspace("j");
    const r = await call(`/api/local-users/${u.id}/access/${ws}`, {
      method: "PUT",
      body: { role: "admin", subject: victim.subject },
      token,
    });
    expect(r.status).toBe(400);
    // Neither account was touched.
    expect((await call(`/api/local-users/${u.id}/access`, { token })).body).toEqual({ access: [] });
    expect((await call(`/api/local-users/${victim.id}/access`, { token })).body).toEqual({ access: [] });
  });

  it("⚠ the subject WRITTEN is the account's own, whatever else is sent", async () => {
    const token = await identity(SUPER);
    const u = await mk(`${PREFIX}_ownsubj`);
    const ws = await workspace("k");
    const g = await call(`/api/local-users/${u.id}/access/${ws}`, {
      method: "PUT",
      body: { role: "author" },
      token,
    });
    // Derived from the row's uuid — `local:<id>` — and not from anything sent.
    expect((g.body!.member as { subject: string }).subject).toBe(`local:${u.id}`);
    expect(u.subject).toBe(`local:${u.id}`);
  });

  it("a missing account is a 404, and does not reach the members writer", async () => {
    const token = await identity(SUPER);
    const ws = await workspace("g");
    const gone = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect((await call(`/api/local-users/${gone}/access`, { token })).status).toBe(404);
    expect(
      (await call(`/api/local-users/${gone}/access/${ws}`, { method: "PUT", body: { role: "admin" }, token }))
        .status,
    ).toBe(404);
  });

  afterAll(async () => {
    const { workspaces, workspaceMembers } = await import("../db/schema.js");
    const { inArray, like: lk } = await import("drizzle-orm");
    const rows = await db.select({ id: workspaces.id }).from(workspaces).where(lk(workspaces.name, `${WS_PREFIX}%`));
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await db.delete(workspaceMembers).where(inArray(workspaceMembers.workspaceId, ids));
      await db.delete(workspaces).where(inArray(workspaces.id, ids));
    }
  });
});
