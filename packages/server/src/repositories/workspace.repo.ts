import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaces } from "../db/schema.js";

export type NewWorkspace = typeof workspaces.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;

export const workspaceRepo = {
  async list(): Promise<Workspace[]> {
    return db
      .select()
      .from(workspaces)
      .where(isNull(workspaces.deletedAt))
      .orderBy(desc(workspaces.createdAt));
  },

  async get(id: string): Promise<Workspace | undefined> {
    const rows = await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      .limit(1);
    return rows[0];
  },

  /**
   * Resolve a workspace from its immutable namespace slugs (§5.0).
   *
   * Both segments are required. Matching on `slug` alone would resolve
   * `acme.hr` and `globex.hr` to whichever row was found first — a cross-tenant
   * leak, and the exact reason the tenant prefix is mandatory.
   */
  async getBySlugs(tenantSlug: string, slug: string): Promise<Workspace | undefined> {
    const rows = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.tenantSlug, tenantSlug),
          eq(workspaces.slug, slug),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    return rows[0];
  },

  async create(data: NewWorkspace): Promise<Workspace> {
    const rows = await db.insert(workspaces).values(data).returning();
    return rows[0];
  },

  async update(id: string, data: Partial<NewWorkspace>): Promise<Workspace | undefined> {
    const rows = await db
      .update(workspaces)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      .returning();
    return rows[0];
  },

  async softDelete(id: string): Promise<boolean> {
    const rows = await db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(and(eq(workspaces.id, id), isNull(workspaces.deletedAt)))
      .returning({ id: workspaces.id });
    return rows.length > 0;
  },
};
