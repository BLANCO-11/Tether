import pg from "pg";

// Read-only access to the parent app's schema store. The bridge exposes ONLY
// structural metadata + aggregate stats — never data rows (FEASIBILITY §5.6).
const { Pool } = pg;

// ── No baked-in credential, and no fallback ─────────────────────────────────
//
// This used to default to `postgres://foundry:foundry@localhost:5433/foundry_parent`
// — the parent database's OWNER credential, written into the source of a service
// whose whole job is read-only structural metadata. Two problems with a default
// like that, and the second is the one that bites: it is a real credential for
// this deployment (so the string is worth something to anyone who reads the
// repo), and a misconfigured deployment silently gets FULL access instead of an
// error naming the missing variable.
//
// So: required, and it throws at import. `index.ts` imports this module at boot,
// which makes a missing DSN a failed start rather than a service that answers
// /health and fails on the first tool call.
//
// ⚠ It still wants a least-privilege role. This reads `schemas` and
// `datasources` only; pointing it at the owner DSN (which `docker-compose.yml`
// still does) leaves it one query from `workspace_secrets`. Requiring the
// variable is what makes that a deliberate choice at deploy time instead of a
// default nobody chose.
const DSN = process.env.DATABASE_URL;
if (!DSN) {
  throw new Error(
    "mcp-bridge: DATABASE_URL is required. It is deliberately not defaulted — the previous " +
      "default was the parent database's owner credential, so a misconfigured deployment got " +
      "full read access rather than a startup error.",
  );
}

const pool = new Pool({ connectionString: DSN });

interface ColumnRow {
  entity_name: string;
  column_name: string | null;
  column_type: string | null;
  is_primary_key: boolean;
  is_foreign_key: boolean;
  foreign_key_reference: string | null;
  nullable: boolean;
  character_maximum_length: number | null;
  row_count_estimate: string | null;
}

// All schema rows for every datasource in a workspace.
async function rowsForWorkspace(workspaceId: string): Promise<ColumnRow[]> {
  const { rows } = await pool.query<ColumnRow>(
    `SELECT s.entity_name, s.column_name, s.column_type, s.is_primary_key,
            s.is_foreign_key, s.foreign_key_reference, s.nullable,
            s.character_maximum_length, s.row_count_estimate
     FROM schemas s
     JOIN datasources d ON d.id = s.datasource_id
     WHERE d.workspace_id = $1
     ORDER BY s.entity_name, s.column_name NULLS FIRST`,
    [workspaceId],
  );
  return rows;
}

export const schemaStore = {
  async listTables(workspaceId: string, prefix?: string) {
    const rows = await rowsForWorkspace(workspaceId);
    const tables = new Map<string, number | null>();
    for (const r of rows) {
      if (r.column_name === null) tables.set(r.entity_name, r.row_count_estimate ? Number(r.row_count_estimate) : null);
      else if (!tables.has(r.entity_name)) tables.set(r.entity_name, null);
    }
    let names = [...tables.entries()];
    if (prefix) names = names.filter(([n]) => n.startsWith(prefix));
    return names.map(([name, rowsEstimate]) => ({ name, rowsEstimate }));
  },

  async readTableSchema(workspaceId: string, tableName: string) {
    const rows = (await rowsForWorkspace(workspaceId)).filter((r) => r.entity_name === tableName);
    if (rows.length === 0) return null;
    const meta = rows.find((r) => r.column_name === null);
    return {
      table: tableName,
      rowsEstimate: meta?.row_count_estimate ? Number(meta.row_count_estimate) : null,
      columns: rows
        .filter((r) => r.column_name !== null)
        .map((r) => ({
          name: r.column_name,
          type: r.column_type,
          nullable: r.nullable,
          primaryKey: r.is_primary_key,
          foreignKey: r.is_foreign_key ? r.foreign_key_reference : null,
          maxLength: r.character_maximum_length,
        })),
    };
  },

  async describeRelationships(workspaceId: string, tableName: string) {
    const rows = await rowsForWorkspace(workspaceId);
    const outgoing = rows
      .filter((r) => r.entity_name === tableName && r.is_foreign_key && r.foreign_key_reference)
      .map((r) => ({ from: `${tableName}.${r.column_name}`, to: r.foreign_key_reference }));
    const incoming = rows
      .filter(
        (r) => r.is_foreign_key && r.foreign_key_reference?.startsWith(`${tableName}.`),
      )
      .map((r) => ({ from: `${r.entity_name}.${r.column_name}`, to: r.foreign_key_reference }));
    return { table: tableName, outgoing, incoming };
  },

  async getColumnStats(workspaceId: string, tableName: string, columnName: string) {
    const rows = await rowsForWorkspace(workspaceId);
    const col = rows.find((r) => r.entity_name === tableName && r.column_name === columnName);
    if (!col) return null;
    return {
      table: tableName,
      column: columnName,
      type: col.column_type,
      nullable: col.nullable,
      primaryKey: col.is_primary_key,
      foreignKey: col.is_foreign_key ? col.foreign_key_reference : null,
      maxLength: col.character_maximum_length,
    };
  },
};
