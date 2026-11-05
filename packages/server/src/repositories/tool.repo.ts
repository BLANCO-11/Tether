import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { flows, flowSteps, tools } from "../db/schema.js";

export type NewTool = typeof tools.$inferInsert;
export type Tool = typeof tools.$inferSelect;

export const toolRepo = {
  listByWorkspace(workspaceId: string): Promise<Tool[]> {
    return db
      .select()
      .from(tools)
      .where(eq(tools.workspaceId, workspaceId))
      .orderBy(desc(tools.createdAt));
  },

  /**
   * usedBy — distinct flows per referenced ref, in ONE query for the workspace.
   *
   * `flow_steps.manifest_refs_json` is `{ "<ref>": "<fingerprint>" }` captured
   * at revision-write time: the key is the ref a step uses, by construction the
   * same string a tool step's `ref` holds (tool name for `tool` steps,
   * `<datasource>.<query>` / `<datasource>.<operation>` for the other two kinds —
   * see `flow.service.ts` and `flowCompiler.refsOf`). So per-key DISTINCT
   * `flow_id` is exactly "distinct flows (across revisions) whose steps
   * reference this ref". A tool name is an env-var identifier and can never
   * contain a dot, so a tool name can never collide with a datasource/operation
   * key; the refs of non-tool kinds simply sit in the map unused by the caller.
   *
   * The workspace scope comes from the flows join, NOT from filtering
   * `flow_steps` — a step row only says `flow_id`, and tenancy lives on the
   * flow (risk 1c, the same reason every flow read takes the workspace id).
   *
   * `COUNT(DISTINCT …)::int` — Postgres counts in int8 and the driver returns
   * int8 as a STRING; the cast keeps the JSON number the client expects.
   */
  async usedByIn(workspaceId: string): Promise<Record<string, number>> {
    const rows = await db.execute(sql`
      SELECT refs.key AS ref, COUNT(DISTINCT fs.flow_id)::int AS used_by
      FROM ${flowSteps} fs
      JOIN ${flows} f ON f.id = fs.flow_id
      CROSS JOIN LATERAL jsonb_object_keys(fs.manifest_refs_json) AS refs(key)
      WHERE f.workspace_id = ${workspaceId}
      GROUP BY refs.key
    `);
    const out: Record<string, number> = {};
    for (const row of rows.rows as Array<{ ref: string; used_by: number }>) {
      out[row.ref] = row.used_by;
    }
    return out;
  },

  async get(workspaceId: string, id: string): Promise<Tool | undefined> {
    const rows = await db
      .select()
      .from(tools)
      .where(and(eq(tools.id, id), eq(tools.workspaceId, workspaceId)))
      .limit(1);
    return rows[0];
  },

  async getByName(workspaceId: string, name: string): Promise<Tool | undefined> {
    const rows = await db
      .select()
      .from(tools)
      .where(and(eq(tools.name, name), eq(tools.workspaceId, workspaceId)))
      .limit(1);
    return rows[0];
  },

  async create(data: NewTool): Promise<Tool> {
    const rows = await db.insert(tools).values(data).returning();
    return rows[0];
  },

  async update(workspaceId: string, id: string, data: Partial<NewTool>): Promise<Tool | undefined> {
    const rows = await db
      .update(tools)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(tools.id, id), eq(tools.workspaceId, workspaceId)))
      .returning();
    return rows[0];
  },

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(tools)
      .where(and(eq(tools.id, id), eq(tools.workspaceId, workspaceId)))
      .returning({ id: tools.id });
    return rows.length > 0;
  },
};
