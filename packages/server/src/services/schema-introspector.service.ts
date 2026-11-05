import { schemaRepo, type NewSchemaRow } from "../repositories/schema.repo.js";
import { postgresIntrospector } from "./introspect/postgres.introspector.js";
import { mysqlIntrospector } from "./introspect/mysql.introspector.js";
import { sqliteIntrospector, describeSqliteQuery } from "./introspect/sqlite.introspector.js";
import { describePostgresQuery } from "./introspect/postgres.introspector.js";
import type { DescribedQuery } from "./introspect/types.js";
import type { Introspector, IntrospectOptions } from "./introspect/types.js";
import { applyColumnTags } from "./datasource-column-tags.js";

const REGISTRY: Record<string, Introspector> = {
  postgres: postgresIntrospector,
  postgresql: postgresIntrospector,
  mysql: mysqlIntrospector,
  mariadb: mysqlIntrospector,
  sqlite: sqliteIntrospector,
};

export function introspectorFor(type: string): Introspector | undefined {
  return REGISTRY[type.toLowerCase()];
}

export const schemaIntrospectorService = {
  supports(type: string) {
    return Boolean(introspectorFor(type));
  },

  async test(type: string, connectionString: string) {
    const impl = introspectorFor(type);
    if (!impl) return { ok: false, detail: `unsupported datasource type: ${type}` };
    return impl.testConnection(connectionString);
  },

  /**
   * Introspect a live datasource and (re)store its schema rows.
   *
   * WS-C.1: `opts.schemas` comes from `datasources.schema_allowlist`, so the
   * `table_schema = 'public'` hardcode no longer decides what a production
   * database is allowed to expose.
   */
  async refresh(
    datasourceId: string,
    type: string,
    connectionString: string,
    opts: IntrospectOptions & {
      /** The owner's column declarations (`datasources.column_tags`), applied to what was introspected. */
      columnTags?: Record<string, string>;
      /** Refuse (400, nothing stored) when a declaration cannot be honoured — how SAVING a declaration checks it. */
      strictTags?: boolean;
    } = {},
  ) {
    const impl = introspectorFor(type);
    if (!impl) throw new Error(`unsupported datasource type: ${type}`);

    const result = await impl.introspect(connectionString, opts);
    const tagProblems = applyColumnTags(result.entities, opts.columnTags);
    if (tagProblems.length && opts.strictTags) {
      throw Object.assign(new Error(`column tags cannot be applied: ${tagProblems.join("; ")}`), { statusCode: 400, problems: tagProblems });
    }
    if (tagProblems.length) console.warn(`[introspect] datasource ${datasourceId}: column tags not applied — ${tagProblems.join("; ")}`);
    if (result.truncated) {
      // C.3: a truncated schema that presents itself as complete is worse than
      // one that says what is missing.
      console.warn(
        `[introspect] datasource ${datasourceId}: ${result.truncated.total} entities found, ` +
          `only ${result.truncated.limit} stored — the manifest is INCOMPLETE. Narrow ` +
          "schema_allowlist or raise the limit.",
      );
    }
    const rows: NewSchemaRow[] = [];
    for (const entity of result.entities) {
      // Entity-level row (columnName = null) carries the row-count estimate.
      rows.push({
        datasourceId,
        entityType: entity.entityType,
        entityName: entity.name,
        entitySchema: entity.schema ?? null,
        columnName: null,
        rowCountEstimate: entity.rowCountEstimate ?? null,
      });
      for (const col of entity.columns) {
        rows.push({
          datasourceId,
          entityType: entity.entityType,
          entityName: entity.name,
          entitySchema: entity.schema ?? null,
          columnName: col.name,
          columnType: col.type,
          isPrimaryKey: col.isPrimaryKey,
          isForeignKey: col.isForeignKey,
          foreignKeyReference: col.foreignKeyReference,
          nullable: col.nullable,
          characterMaximumLength: col.characterMaximumLength,
          semanticTag: col.tag ?? null,
          valueDomain: col.domain ?? null,
        });
      }
    }
    await schemaRepo.replaceForDatasource(datasourceId, rows);
    return {
      tables: result.entities.length,
      columns: rows.length - result.entities.length,
      views: result.entities.filter((e) => e.entityType === "view" || e.entityType === "materialized_view").length,
      truncated: result.truncated ?? null,
      tagProblems,
    };
  },

  /**
   * Describe a saved query's parameters and result columns without reading a row (compiled-builder I-271, G13).
   * Postgres and SQLite; any other type answers `null` (the query stays untyped, which the catalogue already handles).
   */
  async describeQuery(type: string, connectionString: string, sql: string, paramOrder: string[]): Promise<DescribedQuery | null> {
    const t = type.toLowerCase();
    if (t === "sqlite") return describeSqliteQuery(connectionString, sql, paramOrder);
    if (t !== "postgres" && t !== "postgresql") return null;
    return describePostgresQuery(connectionString, sql, paramOrder);
  },

  async getStored(datasourceId: string) {
    const rows = await schemaRepo.listByDatasource(datasourceId);
    // Reassemble into a nested entity view for API/UI consumption.
    const byEntity = new Map<
      string,
      {
        entityType: string;
        name: string;
        schema: string | null;
        rowCountEstimate: number | null;
        columns: unknown[];
      }
    >();
    for (const r of rows) {
      const key = `${r.entityType}:${r.entitySchema ?? ""}:${r.entityName}`;
      let e = byEntity.get(key);
      if (!e) {
        e = {
          entityType: r.entityType,
          name: r.entityName,
          schema: r.entitySchema ?? null,
          rowCountEstimate: null,
          columns: [],
        };
        byEntity.set(key, e);
      }
      if (r.columnName == null) {
        e.rowCountEstimate = r.rowCountEstimate ?? null;
      } else {
        e.columns.push({
          name: r.columnName,
          type: r.columnType,
          nullable: r.nullable,
          isPrimaryKey: r.isPrimaryKey,
          isForeignKey: r.isForeignKey,
          foreignKeyReference: r.foreignKeyReference,
          characterMaximumLength: r.characterMaximumLength,
          valueDomain: r.valueDomain ?? null,
          // The column's tag — the schema's own or the owner's declaration (P5-I11); the data-source page shows and edits it.
          tag: r.semanticTag ?? null,
        });
      }
    }
    return [...byEntity.values()];
  },
};
