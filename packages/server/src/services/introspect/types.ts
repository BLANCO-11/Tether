// Shared shape produced by every datasource introspector.
// Structure + aggregate stats ONLY — never data rows (FEASIBILITY §5.6, G6).
export interface IntrospectedColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyReference: string | null; // "referenced_table.column"
  characterMaximumLength: number | null;
  /**
   * A tag the schema owner declared in a column comment `foundry:tag=<spec>` (compiled-builder I-278): the text after
   * `foundry:tag=`, verbatim. `null` when the column carries no such comment. Never inferred from the name.
   */
  tag?: string | null;
  /** A VIEW column's source column, when the database can name it (SQLite reports it per result column). Absent: unknown. */
  origin?: { schema?: string | null; table: string; column: string };
  /**
   * The values the column can hold, when known (compiled-builder I-301). `declared`: an enum type or a single-column
   * `CHECK (col IN (…))`. `observed`: the distinct values of a set-of-choices column read at introspection (choice-set.ts). Absent = unknown.
   */
  domain?: ValueDomain | null;
}

export interface ValueDomain { values: string[]; source: "declared" | "observed" }

/**
 * What a saved query takes and returns, described by the database without reading a row (compiled-builder I-271, G13).
 * `nullable` is true for a computed column (no source column to ask) and for any column whose source allows NULL.
 */
export interface DescribedQuery {
  params: Array<{ name: string; type: string }>;
  columns: Array<{ name: string; type: string; nullable: boolean; tag: string | null }>;
}

/**
 * WS-C.2 — views are first-class in production.
 *
 * Both SQL introspectors used to hardcode `entityType: "table"`, so a view was
 * described to the agent as a table with a meaningless row estimate. This matters
 * more than it looks: the safest production wiring (WS-A.7) grants SELECT on
 * purpose-built VIEWS rather than base tables, so in production most of what the
 * manifest describes will be views.
 */
export type EntityKind =
  | "table"
  | "view"
  | "materialized_view"
  | "foreign_table"
  | "collection"
  | "key_space";

export interface IntrospectedEntity {
  entityType: EntityKind;
  name: string;
  /**
   * WS-C.1 — the schema/database the entity lives in. `null` means "the
   * connection's default", which is what a single-schema datasource reports.
   * When set, generated SQL must qualify the name.
   */
  schema?: string | null;
  /**
   * Aggregate estimate, not an exact count/scan. NULL is meaningful and must be
   * preserved: it is what a never-analysed table (`reltuples = -1`) and a view
   * (no meaningful count at all) both report. WS-C.4 — rendering `~-1` into the
   * manifest was worse than saying nothing.
   */
  rowCountEstimate: number | null;
  columns: IntrospectedColumn[];
}

/** Introspection options. WS-C.1: which schemas to read. */
export interface IntrospectOptions {
  /**
   * Schemas (Postgres) / databases (MySQL) to include. Defaults to the
   * connection's default schema. Introspecting EVERY non-system schema is
   * deliberately not the default — a production database may hold hundreds of
   * irrelevant tables and the manifest is already ~60% of the prompt.
   */
  schemas?: string[];
  /** Cap on entities returned, so a 400-table schema cannot hang provisioning. */
  maxEntities?: number;
  /** Per-statement timeout, ms. */
  statementTimeoutMs?: number;
}

export interface IntrospectionResult {
  entities: IntrospectedEntity[];
  /** Set when `maxEntities` truncated the result — never truncate silently. */
  truncated?: { limit: number; total: number };
}

export interface Introspector {
  testConnection(connectionString: string): Promise<{ ok: boolean; detail?: string }>;
  introspect(connectionString: string, opts?: IntrospectOptions): Promise<IntrospectionResult>;
}
