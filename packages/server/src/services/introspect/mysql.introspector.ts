import mysql from "mysql2/promise";
import type {
  EntityKind,
  Introspector,
  IntrospectionResult,
  IntrospectedEntity,
  IntrospectOptions,
} from "./types.js";

/**
 * MySQL schema introspector — reads information_schema. TABLE_ROWS is the
 * engine's row estimate (no data scan).
 *
 * WS-C.2, and a CORRECTION to the plan's claim. §6.2 says this driver "filters
 * TABLE_TYPE = 'BASE TABLE' and so omits views entirely". Not quite: the filter
 * was only ever on the row-estimate query, while the COLUMNS query had no filter
 * — so a view's columns DID appear, but the entity was labelled `table` and got
 * `rowCountEstimate: null` by accident rather than by intent. The real defect was
 * the same as Postgres's: mislabelling, not omission. Both drivers now report the
 * true kind, and null row estimates are deliberate.
 */

/** information_schema.TABLES.TABLE_TYPE → our entity kind. */
const TABLE_TYPE: Record<string, EntityKind> = {
  "BASE TABLE": "table",
  VIEW: "view",
  "SYSTEM VIEW": "view",
};

export const mysqlIntrospector: Introspector = {
  async testConnection(connectionString) {
    let conn: mysql.Connection | undefined;
    try {
      conn = await mysql.createConnection(connectionString);
      await conn.query("SELECT 1");
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    } finally {
      await conn?.end().catch(() => {});
    }
  },

  async introspect(connectionString, opts: IntrospectOptions = {}): Promise<IntrospectionResult> {
    const conn = await mysql.createConnection(connectionString);
    try {
      const [dbRows] = await conn.query<mysql.RowDataPacket[]>("SELECT DATABASE() AS db");
      const defaultDb = dbRows[0]?.db as string | null;
      // C.1: MySQL's "schema" IS its database, so the allowlist selects databases.
      const schemaList = opts.schemas?.length ? opts.schemas : defaultDb ? [defaultDb] : [];
      if (schemaList.length === 0) {
        throw new Error("connection string must specify a database, or set a schema allowlist");
      }
      const singleSchema = schemaList.length === 1 ? schemaList[0] : null;
      const maxEntities = opts.maxEntities ?? 300;

      // C.2: read the kind, and include VIEWs explicitly rather than by accident.
      const [tbls] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA IN (?)
         ORDER BY TABLE_SCHEMA, TABLE_NAME`,
        [schemaList],
      );
      const total = tbls.length;
      const kept = tbls.slice(0, maxEntities);

      const [cols] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
                CHARACTER_MAXIMUM_LENGTH, COLUMN_KEY
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA IN (?)
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
        [schemaList],
      );

      // C.3: ORDINAL_POSITION pairs each column of a composite FK with the
      // referenced column at the same position; without it a multi-column FK is
      // reported with mismatched pairs.
      const [fks] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME,
                REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA IN (?) AND REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        [schemaList],
      );

      const fkMap = new Map<string, string>();
      for (const r of fks) {
        const ref =
          r.REFERENCED_TABLE_SCHEMA && r.REFERENCED_TABLE_SCHEMA !== singleSchema
            ? `${r.REFERENCED_TABLE_SCHEMA}.${r.REFERENCED_TABLE_NAME}.${r.REFERENCED_COLUMN_NAME}`
            : `${r.REFERENCED_TABLE_NAME}.${r.REFERENCED_COLUMN_NAME}`;
        fkMap.set(`${r.TABLE_SCHEMA}.${r.TABLE_NAME}.${r.COLUMN_NAME}`, ref);
      }

      const byTable = new Map<string, IntrospectedEntity>();
      for (const t of kept) {
        const kind = TABLE_TYPE[t.TABLE_TYPE as string] ?? "table";
        // C.4: a view has no meaningful row count; TABLE_ROWS is NULL for one, and
        // the old `?? 0` turned that into a confident, wrong "0 rows".
        const rows = t.TABLE_ROWS;
        byTable.set(`${t.TABLE_SCHEMA}.${t.TABLE_NAME}`, {
          entityType: kind,
          name: t.TABLE_NAME as string,
          // Always the real schema — see the note in postgres.introspector.ts.
          schema: t.TABLE_SCHEMA as string,
          rowCountEstimate: kind === "table" && rows != null ? Number(rows) : null,
          columns: [],
        });
      }

      for (const c of cols) {
        const entity = byTable.get(`${c.TABLE_SCHEMA}.${c.TABLE_NAME}`);
        if (!entity) continue; // truncated away
        const key = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}.${c.COLUMN_NAME}`;
        entity.columns.push({
          name: c.COLUMN_NAME as string,
          // C.3: DATA_TYPE is "enum" with no members and "int" with no width.
          // COLUMN_TYPE carries "enum('low','high')" and "int unsigned", which is
          // what someone writing a WHERE clause actually needs.
          type: (c.COLUMN_TYPE as string) || (c.DATA_TYPE as string),
          nullable: c.IS_NULLABLE === "YES",
          isPrimaryKey: c.COLUMN_KEY === "PRI",
          isForeignKey: fkMap.has(key),
          foreignKeyReference: fkMap.get(key) ?? null,
          characterMaximumLength:
            c.CHARACTER_MAXIMUM_LENGTH != null ? Number(c.CHARACTER_MAXIMUM_LENGTH) : null,
        });
      }

      return {
        entities: [...byTable.values()],
        ...(total > kept.length ? { truncated: { limit: maxEntities, total } } : {}),
      };
    } finally {
      await conn.end().catch(() => {});
    }
  },
};
