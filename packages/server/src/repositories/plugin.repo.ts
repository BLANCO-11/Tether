import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  pluginConnections,
  pluginDeclaredCalls,
  pluginInstalls,
  pluginOauthApps,
  pluginOauthStates,
  pluginPersonalActions,
  pluginPersonalPolicy,
  type PluginDeclaredCall,
  type PluginPersonalAction,
} from "../db/schema.js";

export type PluginInstall = typeof pluginInstalls.$inferSelect;
export type PluginConnection = typeof pluginConnections.$inferSelect;
export type PluginOauthApp = typeof pluginOauthApps.$inferSelect;
export type PluginOauthState = typeof pluginOauthStates.$inferSelect;

export const pluginRepo = {
  listInstalls(): Promise<PluginInstall[]> {
    return db.select().from(pluginInstalls).orderBy(asc(pluginInstalls.displayName));
  },

  /** A declared call by what it does (its hash) — the one the tool's address names. */
  async declaredCall(workspaceId: string, piece: string, hash: string): Promise<PluginDeclaredCall | undefined> {
    const [row] = await db
      .select()
      .from(pluginDeclaredCalls)
      .where(and(eq(pluginDeclaredCalls.workspaceId, workspaceId), eq(pluginDeclaredCalls.piece, piece), eq(pluginDeclaredCalls.hash, hash)))
      .limit(1);
    return row;
  },

  async declaredCalls(workspaceId: string, piece: string): Promise<PluginDeclaredCall[]> {
    return db
      .select()
      .from(pluginDeclaredCalls)
      .where(and(eq(pluginDeclaredCalls.workspaceId, workspaceId), eq(pluginDeclaredCalls.piece, piece)))
      .orderBy(asc(pluginDeclaredCalls.createdAt));
  },

  /** Insert-or-reword: the same hash is the same call, so only its wording (and pack) is refreshed. */
  async saveDeclaredCall(row: typeof pluginDeclaredCalls.$inferInsert): Promise<PluginDeclaredCall> {
    const [saved] = await db
      .insert(pluginDeclaredCalls)
      .values(row)
      .onConflictDoUpdate({
        target: [pluginDeclaredCalls.workspaceId, pluginDeclaredCalls.piece, pluginDeclaredCalls.hash],
        set: { name: row.name, displayName: row.displayName, description: row.description, pack: row.pack ?? null },
      })
      .returning();
    return saved!;
  },

  // ── Personal actions (0118) ──────────────────────────────────────────────────────────────────────────────────────

  /** One person's actions, for one piece or all; or every person's for a piece when `subject` is null. */
  personalActions(workspaceId: string, subject: string | null, piece?: string): Promise<PluginPersonalAction[]> {
    const where = [eq(pluginPersonalActions.workspaceId, workspaceId)];
    if (subject) where.push(eq(pluginPersonalActions.subject, subject));
    if (piece) where.push(eq(pluginPersonalActions.piece, piece));
    return db.select().from(pluginPersonalActions).where(and(...where)).orderBy(asc(pluginPersonalActions.createdAt));
  },

  async addPersonalActions(workspaceId: string, subject: string, piece: string, actions: string[]): Promise<void> {
    if (!actions.length) return;
    await db
      .insert(pluginPersonalActions)
      .values(actions.map((action) => ({ workspaceId, subject, piece, action })))
      .onConflictDoNothing();
  },

  async removePersonalActions(workspaceId: string, subject: string, piece?: string, actions?: string[]): Promise<number> {
    const where = [eq(pluginPersonalActions.workspaceId, workspaceId), eq(pluginPersonalActions.subject, subject)];
    if (piece) where.push(eq(pluginPersonalActions.piece, piece));
    if (actions) {
      if (!actions.length) return 0;
      where.push(inArray(pluginPersonalActions.action, actions));
    }
    const gone = await db.delete(pluginPersonalActions).where(and(...where)).returning({ id: pluginPersonalActions.id });
    return gone.length;
  },

  /** Whether members may switch this piece's actions on for themselves here — allowed unless an admin said no. */
  async personalAllowed(workspaceId: string, piece: string): Promise<boolean> {
    const [row] = await db
      .select()
      .from(pluginPersonalPolicy)
      .where(and(eq(pluginPersonalPolicy.workspaceId, workspaceId), eq(pluginPersonalPolicy.piece, piece)));
    return row ? row.allowed : true;
  },

  async setPersonalAllowed(workspaceId: string, piece: string, allowed: boolean, by: string): Promise<void> {
    await db
      .insert(pluginPersonalPolicy)
      .values({ workspaceId, piece, allowed, updatedBy: by })
      .onConflictDoUpdate({ target: [pluginPersonalPolicy.workspaceId, pluginPersonalPolicy.piece], set: { allowed, updatedBy: by, updatedAt: new Date() } });
  },

  async getInstall(piece: string): Promise<PluginInstall | undefined> {
    const [row] = await db.select().from(pluginInstalls).where(eq(pluginInstalls.piece, piece));
    return row;
  },

  /** One row per piece: a reinstall or an upgrade replaces the version, integrity and hosts in place. */
  async upsertInstall(row: Omit<typeof pluginInstalls.$inferInsert, "id" | "installedAt" | "updatedAt">): Promise<PluginInstall> {
    const [out] = await db
      .insert(pluginInstalls)
      .values(row)
      .onConflictDoUpdate({
        target: pluginInstalls.piece,
        set: {
          version: row.version,
          integrity: row.integrity,
          license: row.license ?? null,
          displayName: row.displayName,
          logoUrl: row.logoUrl ?? null,
          hosts: row.hosts,
          installedBy: row.installedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return out!;
  },

  async setHosts(piece: string, hosts: string[]): Promise<PluginInstall | undefined> {
    const [out] = await db.update(pluginInstalls).set({ hosts, updatedAt: new Date() }).where(eq(pluginInstalls.piece, piece)).returning();
    return out;
  },

  async removeInstall(piece: string): Promise<void> {
    await db.delete(pluginInstalls).where(eq(pluginInstalls.piece, piece));
  },

  /**
   * The workspace's connections, plus `viewer`'s own ("as me"). ⚠ Another person's connection is never listed: it is a
   * credential to THEIR account, and its name alone says whose services they reach.
   */
  listConnections(workspaceId: string, piece?: string, viewer?: string | null): Promise<PluginConnection[]> {
    const owner = viewer ? or(isNull(pluginConnections.ownerSubject), eq(pluginConnections.ownerSubject, viewer)) : isNull(pluginConnections.ownerSubject);
    const where = piece
      ? and(eq(pluginConnections.workspaceId, workspaceId), eq(pluginConnections.piece, piece), owner)
      : and(eq(pluginConnections.workspaceId, workspaceId), owner);
    return db.select().from(pluginConnections).where(where).orderBy(asc(pluginConnections.label));
  },

  /**
   * The connection that owns a credential, whoever it belongs to — for the OWNERSHIP check (plugin-credentials.ts),
   * never for listing: a personal one is returned here so the check can refuse a caller who is not its owner.
   */
  async connectionBySecret(workspaceId: string, secretName: string): Promise<PluginConnection | undefined> {
    const [row] = await db
      .select()
      .from(pluginConnections)
      .where(and(eq(pluginConnections.workspaceId, workspaceId), eq(pluginConnections.secretName, secretName)));
    return row;
  },

  /** Every credential name a connection owns in the workspace (everyone's) — to keep them off the secrets pages. */
  async secretNamesIn(workspaceId: string): Promise<Set<string>> {
    const rows = await db.select({ name: pluginConnections.secretName }).from(pluginConnections).where(eq(pluginConnections.workspaceId, workspaceId));
    return new Set(rows.map((r) => r.name));
  },

  /** Every workspace's connections to one piece — what an uninstall must name before it may proceed. */
  listConnectionsForPiece(piece: string): Promise<PluginConnection[]> {
    return db.select().from(pluginConnections).where(eq(pluginConnections.piece, piece));
  },

  async getConnection(workspaceId: string, id: string): Promise<PluginConnection | undefined> {
    const [row] = await db
      .select()
      .from(pluginConnections)
      .where(and(eq(pluginConnections.workspaceId, workspaceId), eq(pluginConnections.id, id)));
    return row;
  },

  async createConnection(row: typeof pluginConnections.$inferInsert): Promise<PluginConnection> {
    const [out] = await db.insert(pluginConnections).values(row).returning();
    return out!;
  },

  async updateConnection(
    workspaceId: string,
    id: string,
    set: Partial<Pick<PluginConnection, "label" | "fieldNames" | "lastTestedAt" | "lastTestOk" | "lastTestMessage" | "createdBy">>,
  ): Promise<PluginConnection | undefined> {
    const [out] = await db
      .update(pluginConnections)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(pluginConnections.workspaceId, workspaceId), eq(pluginConnections.id, id)))
      .returning();
    return out;
  },

  async removeConnection(workspaceId: string, id: string): Promise<void> {
    await db.delete(pluginConnections).where(and(eq(pluginConnections.workspaceId, workspaceId), eq(pluginConnections.id, id)));
  },

  // ── OAuth (phase 4) ─────────────────────────────────────────────────────────────────────────────────────────────────

  async getOauthApp(piece: string): Promise<PluginOauthApp | undefined> {
    const [row] = await db.select().from(pluginOauthApps).where(eq(pluginOauthApps.piece, piece));
    return row;
  },

  listOauthApps(): Promise<PluginOauthApp[]> {
    return db.select().from(pluginOauthApps);
  },

  async upsertOauthApp(row: Omit<typeof pluginOauthApps.$inferInsert, "id" | "createdAt" | "updatedAt">): Promise<PluginOauthApp> {
    const [out] = await db
      .insert(pluginOauthApps)
      .values(row)
      .onConflictDoUpdate({
        target: pluginOauthApps.piece,
        set: {
          useSignInApp: row.useSignInApp ?? false,
          clientId: row.clientId ?? null,
          clientSecretEnc: row.clientSecretEnc ?? null,
          scopes: row.scopes ?? [],
          updatedBy: row.updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return out!;
  },

  async removeOauthApp(piece: string): Promise<void> {
    await db.delete(pluginOauthApps).where(eq(pluginOauthApps.piece, piece));
  },

  async createOauthState(row: typeof pluginOauthStates.$inferInsert): Promise<void> {
    await db.delete(pluginOauthStates).where(lt(pluginOauthStates.expiresAt, new Date()));
    await db.insert(pluginOauthStates).values(row);
  },

  /** Single use: the row is deleted as it is read, so a replayed callback finds nothing. */
  async takeOauthState(stateHash: string): Promise<PluginOauthState | undefined> {
    const [row] = await db.delete(pluginOauthStates).where(eq(pluginOauthStates.stateHash, stateHash)).returning();
    return row;
  },
};
