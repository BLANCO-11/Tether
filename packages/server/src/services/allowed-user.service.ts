import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { allowedUsers } from "../db/schema.js";
import { config } from "../config/index.js";

export type AllowedRole = "admin" | "user";

export type AllowedUserView = {
  id: string;
  email: string;
  role: AllowedRole;
  enabled: boolean;
  createdAt: string;
  createdBy: string | null;
  lastLoginAt: string | null;
};

export const normalizeEmail = (s: string): string => s.trim().toLowerCase();

function httpError(message: string, status: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}

const PLAUSIBLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Row = typeof allowedUsers.$inferSelect;

function view(r: Row): AllowedUserView {
  return {
    id: r.id,
    email: r.email,
    role: r.role as AllowedRole,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy ?? null,
    lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
  };
}

async function rowByEmail(email: string): Promise<Row | null> {
  const [row] = await db.select().from(allowedUsers).where(eq(allowedUsers.email, normalizeEmail(email))).limit(1);
  return row ?? null;
}

export const allowedUserService = {
  async list(): Promise<AllowedUserView[]> {
    const rows = await db.select().from(allowedUsers).orderBy(allowedUsers.email);
    return rows.map(view);
  },

  async findByEmail(email: string): Promise<AllowedUserView | null> {
    const row = await rowByEmail(email);
    return row ? view(row) : null;
  },

  async add(input: { email: string; role: AllowedRole; createdBy?: string | null }): Promise<AllowedUserView> {
    const email = normalizeEmail(input.email);
    if (email.length > 320 || !PLAUSIBLE_EMAIL.test(email)) {
      throw httpError("that does not look like an email address", 400);
    }
    if (await rowByEmail(email)) throw httpError("that email is already on the list", 409);
    try {
      const [row] = await db
        .insert(allowedUsers)
        .values({ email, role: input.role, createdBy: input.createdBy ?? null })
        .returning();
      return view(row);
    } catch (e) {
      // Lost a race with the unique index.
      if ((e as { code?: string }).code === "23505") throw httpError("that email is already on the list", 409);
      throw e;
    }
  },

  async update(id: string, patch: { role?: AllowedRole; enabled?: boolean }): Promise<AllowedUserView> {
    const set: Partial<{ role: AllowedRole; enabled: boolean }> = {};
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (Object.keys(set).length === 0) {
      const [row] = await db.select().from(allowedUsers).where(eq(allowedUsers.id, id)).limit(1);
      if (!row) throw httpError("no such user", 404);
      return view(row);
    }
    const [row] = await db.update(allowedUsers).set(set).where(eq(allowedUsers.id, id)).returning();
    if (!row) throw httpError("no such user", 404);
    return view(row);
  },

  async remove(id: string): Promise<void> {
    const rows = await db.delete(allowedUsers).where(eq(allowedUsers.id, id)).returning({ id: allowedUsers.id });
    if (rows.length === 0) throw httpError("no such user", 404);
  },

  /** Never throws, and never logs the email. */
  async markLogin(email: string): Promise<void> {
    try {
      await db
        .update(allowedUsers)
        .set({ lastLoginAt: sql`now()` })
        .where(eq(allowedUsers.email, normalizeEmail(email)));
    } catch {
      console.warn("[allowed-users] could not record last login");
    }
  },

  async accessFor(email: string): Promise<{ allowed: boolean; role: AllowedRole | null }> {
    const e = normalizeEmail(email);
    if (config.isSuperAdmin({ email: e })) return { allowed: true, role: "admin" };
    const row = await rowByEmail(e);
    if (!row) return { allowed: false, role: null };
    return { allowed: row.enabled, role: row.role as AllowedRole };
  },

  async isUserAdmin(identity: { subject?: string | null; email?: string | null } | null | undefined): Promise<boolean> {
    if (!identity) return false;
    if (config.isSuperAdmin(identity)) return true;
    if (!identity.email) return false;
    const row = await rowByEmail(identity.email);
    return !!row && row.enabled && row.role === "admin";
  },

  superAdminEmails(): string[] {
    return [...config.superAdminEmails].filter((s) => s.includes("@")).map((s) => s.toLowerCase());
  },
};
