/**
 * Mock dataset generation: deterministic seeded-RNG rows, 10/table, FK-coherent.
 *
 * Pure-function tests only (no DB, no fs, no clock): `generateMockRows` takes a
 * shape and returns rows, so determinism, row counts, coherence and datatype
 * coverage pin byte-identically. DB guards (not_postgres / no_schema /
 * unsupported_shape / already_has_fixture) are asserted on source
 * like `sandbox-autoprovision.test.ts` does — spinning a database to test a
 * refusal would make the test about the database, not the refusal.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  MOCK_ROWS_PER_TABLE,
  generateMockRows,
  partitionMockTables,
} from "./mock-dataset.service.js";
import type { SandboxColumn, SandboxShape, SandboxTable } from "./sandbox-ddl.service.js";

const SRC = new URL("./mock-dataset.service.ts", import.meta.url);

function col(
  name: string,
  kind: SandboxColumn["kind"],
  opts: Partial<SandboxColumn> = {},
): SandboxColumn {
  const sqlType =
    kind === "int"
      ? "integer"
      : kind === "decimal"
        ? "numeric"
        : kind === "bool"
          ? "boolean"
          : kind === "date"
            ? "date"
            : kind === "timestamp"
              ? "timestamp"
              : kind === "time"
                ? "time"
                : kind === "uuid"
                  ? "uuid"
                  : kind === "json"
                    ? "jsonb"
                    : kind === "array"
                      ? "integer[]"
                      : "text";
  return {
    name,
    sqlType,
    kind,
    nullable: true,
    isPrimaryKey: false,
    references: null,
    maxLength: null,
    ...opts,
  };
}

function table(name: string, columns: SandboxColumn[], schema: string | null = null): SandboxTable {
  return { schema, name, key: schema ? `${schema}.${name}` : name, sourceKind: "table", columns };
}

function shape(tables: SandboxTable[], fingerprint = "test-fingerprint-1"): SandboxShape {
  return {
    tables,
    schemas: ["public"],
    fingerprint,
    unsupported: [],
    notes: [],
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

describe("mock row budget", () => {
  it("is fixed at 10 rows per table", () => {
    expect(MOCK_ROWS_PER_TABLE).toBe(10);
  });

  /**
   * ⚠ **THE ROW COUNT IS THE ONLY SIZE BOUND, and a column cap is forbidden.**
   * `MAX_MOCK_COLUMNS_PER_TABLE = 5` was added on 2026-09-17 as a per-table
   * width bound and deleted the same day: a mock missing a column is not a
   * smaller schema, it is a different one, and a correct query against it dies
   * with `column "x" does not exist` on a draft run. Asserted against the SOURCE
   * so that reintroducing the constant fails here rather than on a tenant.
   */
  it("bounds ROWS and never columns", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src).not.toMatch(/export const MAX_MOCK_COLUMNS_PER_TABLE/);
    expect(src).not.toMatch(/narrowMockColumns\(/);
    // CONTROL: the row bound really is there to be found.
    expect(src).toMatch(/export const MOCK_ROWS_PER_TABLE = 10/);
  });

  it("emits exactly 10 rows for every table in the shape", () => {
    const s = shape([
      table("authors", [col("id", "int", { nullable: false, isPrimaryKey: true }), col("name", "text")]),
      table("books", [col("id", "int", { nullable: false, isPrimaryKey: true }), col("title", "text")]),
    ]);
    const rows = generateMockRows(s);
    expect(Object.keys(rows).sort()).toEqual(["authors", "books"]);
    expect(rows.authors).toHaveLength(10);
    expect(rows.books).toHaveLength(10);
  });
});

describe("determinism", () => {
  it("generates byte-identical rows for the same shape twice", () => {
    const s = shape([
      table("authors", [col("id", "int", { nullable: false, isPrimaryKey: true }), col("name", "text"), col("active", "bool")]),
    ]);
    expect(generateMockRows(s)).toEqual(generateMockRows(s));
  });

  it("seeds per fingerprint — a new shape version generates different rows", () => {
    const a = shape([table("t", [col("id", "int", { nullable: false, isPrimaryKey: true }), col("v", "int")])], "fp-one");
    const b = shape([table("t", [col("id", "int", { nullable: false, isPrimaryKey: true }), col("v", "int")])], "fp-two");
    expect(generateMockRows(a)).not.toEqual(generateMockRows(b));
  });
});

describe("foreign-key coherence", () => {
  it("resolves every child reference to a generated parent value", () => {
    const s = shape([
      table("authors", [col("id", "int", { nullable: false, isPrimaryKey: true }), col("name", "text")]),
      table("books", [
        col("id", "int", { nullable: false, isPrimaryKey: true }),
        col("author_id", "int", { nullable: false, references: "authors.id" }),
      ]),
    ]);
    const rows = generateMockRows(s);
    const parentIds = new Set(rows.authors.map((r) => r.id));
    expect(parentIds.size).toBe(10);
    for (const b of rows.books) {
      expect(parentIds.has(b.author_id)).toBe(true);
    }
  });

  it("follows natural (non-PK) keys too, not only surrogate ids", () => {
    const s = shape([
      table("contract_types", [
        col("id", "int", { nullable: false, isPrimaryKey: true }),
        col("code", "text", { nullable: false }),
      ]),
      table("contracts", [
        col("id", "int", { nullable: false, isPrimaryKey: true }),
        col("type_code", "text", { nullable: false, references: "contract_types.code" }),
      ]),
    ]);
    const rows = generateMockRows(s);
    const codes = new Set(rows.contract_types.map((r) => r.code));
    for (const c of rows.contracts) {
      expect(codes.has(c.type_code)).toBe(true);
    }
  });
});

describe("datatype coverage", () => {
  it("writes every value family the DDL emitter can produce", () => {
    const s = shape([
      table("allkinds", [
        col("id", "int", { nullable: false, isPrimaryKey: true }),
        col("n", "int"),
        col("amount", "decimal"),
        col("flag", "bool"),
        col("label", "text"),
        col("day", "date"),
        col("at", "timestamp"),
        col("tod", "time"),
        col("uid", "uuid"),
        col("meta", "json"),
        col("tags", "array"),
      ]),
    ]);
    const rows = generateMockRows(s).allkinds;
    expect(rows).toHaveLength(10);
    for (const r of rows) {
      expect(typeof r.n === "number" || r.n === null).toBe(true);
      expect(typeof r.amount === "number" || r.amount === null).toBe(true);
      expect(typeof r.flag === "boolean" || r.flag === null).toBe(true);
      expect(typeof r.label === "string" || r.label === null).toBe(true);
      expect(typeof r.day === "string" || r.day === null).toBe(true);
      expect(typeof r.at === "string" || r.at === null).toBe(true);
      expect(typeof r.tod === "string" || r.tod === null).toBe(true);
      if (r.uid !== null) expect(String(r.uid)).toMatch(UUID_RE);
      expect(Array.isArray(r.tags) || r.tags === null).toBe(true);
    }
  });

  it("never nulls a primary key, and nulls some nullable columns", () => {
    const s = shape([
      table("t", [
        col("id", "int", { nullable: false, isPrimaryKey: true }),
        col("nick", "text", { nullable: true }),
        col("req", "text", { nullable: false }),
      ]),
    ]);
    const rows = generateMockRows(s).t;
    expect(rows.every((r) => r.id !== null)).toBe(true);
    expect(rows.every((r) => r.req !== null)).toBe(true);
    expect(rows.some((r) => r.nick === null)).toBe(true);
  });

  it("respects characterMaximumLength", () => {
    const s = shape([
      table("t", [
        col("id", "int", { nullable: false, isPrimaryKey: true }),
        col("code", "text", { maxLength: 4 }),
      ]),
    ]);
    for (const r of generateMockRows(s).t) {
      expect(String(r.code).length).toBeLessThanOrEqual(4);
    }
  });

  it("keeps integer primary keys unique across the 10 rows", () => {
    const s = shape([
      table("t", [col("id", "int", { nullable: false, isPrimaryKey: true })]),
    ]);
    const ids = generateMockRows(s).t.map((r) => r.id);
    expect(new Set(ids).size).toBe(10);
  });
});

describe("loud refusals (source-pinned, like sandbox-autoprovision.test.ts)", () => {
  it("is reading the real builder", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src.length).toBeGreaterThan(8000);
    expect(src).toContain("requestMockBuild");
  });

  it("refuses a type with no mock engine by name with a failed row, like provisionIfAbsent", async () => {
    const src = await readFile(SRC, "utf8");
    // Both entry points (initial build + rebuild) carry the guard. It asks the
    // mock-engine REGISTRY (postgres, and sqlite since 2026-10-01), so a type
    // is buildable exactly when a draft run could read what gets built.
    expect(src.split("!supportsMockType(ds.type)").length - 1).toBeGreaterThanOrEqual(2);
    const { supportsMockType } = await import("./mock-engine/registry.js");
    expect(supportsMockType("postgres")).toBe(true);
    expect(supportsMockType("sqlite")).toBe(true);
    expect(supportsMockType("mysql")).toBe(false);
    expect(src.split('"not_postgres"').length - 1).toBeGreaterThanOrEqual(2);
    expect(src).toContain("writeFailedFixture");
  });

  it("has no table-count refusal left — a 46-table schema builds", async () => {
    const src = await readFile(SRC, "utf8");
    // ⚠ Matched on a USE, never on the word: the constant's replacement docblock
    // quotes the old message and names the old symbol on purpose (this repo
    // corrects comments in place), and a test that greps the noun would be
    // satisfied by the history it is meant to keep legible — I-62.
    expect(src).not.toMatch(/why: "too_many_tables"/);
    expect(src).not.toMatch(/stored\.length > MAX_MOCK_TABLES/);
    expect(src).not.toMatch(/an automatic mock build is capped at \$\{/);
  });

  it("takes the derived shape whole — no narrowing on either entry point", async () => {
    const src = await readFile(SRC, "utf8");
    // `guardShape` is the one path `requestMockBuild` and `rebuildMockDataset`
    // share, so a narrowing introduced there would silently amputate both.
    expect(src).toMatch(/const shape = deriveShape\(stored, \{ allowlist \}\)/);
    expect(src).not.toMatch(/narrowMockColumns/);
  });

  it("an existing fixture of an OLDER shape is rebuilt, not kept (2026-10-02, H02)", async () => {
    const src = await readFile(SRC, "utf8");
    const body = src.slice(src.indexOf("export async function requestMockBuild"), src.indexOf("export async function rebuildMockDataset"));
    // The CALL, not the comment: a moved fingerprint goes to the rebuild before "already has".
    const cmp = body.search(/latest\.schemaFingerprint !== current\.shape\.fingerprint\) return rebuildMockDataset\(/);
    expect(cmp).toBeGreaterThan(0);
    expect(cmp).toBeLessThan(body.lastIndexOf('why: "already_has_fixture"'));
  });

  it("stays additive: an existing fixture refuses the initial build", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src).toMatch(/already_has_fixture/);
    // …while the rebuild path deliberately bypasses that check.
    expect(src).toContain("rebuildMockDataset");
  });

  /**
   * WARNING: this used to be named "fails unsupported shapes loudly instead of
   * widening them", and as of 2026-09-17 the first half is no longer true while
   * the second half is the whole point.
   *
   * An unreproducible COLUMN is now dropped and the mock is built without it
   * (measured: a tenant's 46-table Prisma schema was refused outright over 14
   * enum columns). What is NOT done, and never was, is widening one to `text` —
   * that would accept values the real column rejects. Dropped, not widened.
   *
   * WARNING: this assertion is a source grep and passes against either
   * behaviour, which is why `partitionMockTables` is exported and tested below.
   */
  it("still has a refusal for a shape with nothing reproducible in it", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src).toMatch(/why: "unsupported_shape"/);
  });

  /**
   * ⚠ Was "never SELECTs production", matched as `/SELECT.*FROM/` — a pattern
   * that a Drizzle read of Foundry's OWN `datasources` table trips on one line
   * and passes across two, so it pinned formatting, not the property (I-62).
   * Since D-268 there IS one production read, and the property is where it
   * lives and what it may ask: (1) this service opens no database client of
   * its own and holds no raw SQL; (2) the hints module is the only reader, and
   * every query it issues is the read-only SET or the GROUP BY distinct-value
   * sample — never a row select.
   */
  it("reads production ONLY through the hints module's distinct-value sample (D-268)", async () => {
    const src = await readFile(SRC, "utf8");
    // The one `.query(` allowed is the hints module's sampler running `mock-links.ts`'s per-value counts.
    expect(src.replace("sampler.query(countsSql(table, col))", "")).not.toMatch(/pg\.Client|new Client\(|\.query\(/);
    expect(src).not.toMatch(/["'`]\s*SELECT\b/i);
    expect(src).toContain("generateMockRows");
    const hints = await readFile(new URL("./mock-value-hints.ts", import.meta.url), "utf8");
    // ⚠ Re-pinned 2026-10-12: the old scan expected literal GROUP BY queries the hints module no longer issues (it had
    // failed since the sample moved to `sampleSql`). What is pinned now is the WHOLE set of reads, by where they live:
    // the hints module's literal SQL is the read-only SET and `sampleSql` (one column, non-null, LIMITed — never a row);
    // its `query` hook runs only what it is handed, and the one caller hands it `mock-links.ts`'s profile statements.
    const literal = [...hints.matchAll(/client\.query(?:<[^>]*>)?\(\s*([`"'][\s\S]*?)\);/g)].map((m) => m[1]!);
    expect(literal).toEqual(['"SET default_transaction_read_only = on"']);
    expect(hints).toMatch(/const sampleSql = [^\n]*\n\s*`SELECT \$\{quoteIdent\(col\.name\)\} AS v FROM \$\{fromOf\(table\)\} WHERE \$\{quoteIdent\(col\.name\)\} IS NOT NULL LIMIT \$\{SAMPLE_ROWS\}`/);
    // `sampler.query` is handed only `mock-links.ts`'s statements: the link profile and the per-value counts.
    expect([...src.matchAll(/sampler\.query/g)]).toHaveLength(2);
    expect(src).toMatch(/profileShape\(shape, sampler\.query\)/);
    expect(src).toMatch(/sampler\.query\(countsSql\(table, col\)\)/);
    const links = await readFile(new URL("./mock-links.ts", import.meta.url), "utf8");
    const linkSql = [...links.matchAll(/`(SELECT [^`]*)`/g)].map((m) => m[1]!);
    expect(linkSql).toHaveLength(3); // CONTROL: the scan finds the statements at all
    for (const q of linkSql) expect(q, q).toMatch(/^SELECT (COUNT\(\*\) AS n, COUNT\(DISTINCT |DISTINCT CAST\(|CAST\(\$\{c\} AS TEXT\) AS v, COUNT\(\*\) AS n FROM .* GROUP BY )/);
    expect(links).not.toMatch(/writeFile|INSERT|UPDATE|DELETE/);
    expect(hints).not.toMatch(/SELECT \*/i);
  });
});

/**
 * **Width is reproduced, not bounded.** 2026-09-17
 *
 * ⚠ Every case uses a table far wider than the cap that used to exist, because
 * a "no cap" test over a 3-column table passes with the cap restored (I-38).
 */
describe("a wide table keeps every column", () => {
  /** 40 plain text columns, `c01…c40`, in declaration order. */
  function wide(n = 40): SandboxColumn[] {
    return Array.from({ length: n }, (_, i) => col(`c${String(i + 1).padStart(2, "0")}`, "text"));
  }

  it("reproduces all 40 columns in the source's own order", () => {
    const s = shape([table("t", wide())]);
    expect(s.tables[0]!.columns).toHaveLength(40);
    expect(s.tables[0]!.columns.map((c: SandboxColumn) => c.name)).toEqual(
      wide().map((c) => c.name),
    );
  });

  /**
   * ⚠ THE REGRESSION. Execution `23S9l7tIo2VCmy5p8L2vOt` died because the mock's
   * `offer_and_fitment` held five columns and the drafted query named eight
   * others — all of which exist in the real schema. Rows must carry every
   * column, or a correct query fails against the fixture alone.
   */
  it("generates rows carrying every column, not a selection", () => {
    const s = shape([
      table("t", [col("id", "int", { nullable: false, isPrimaryKey: true }), ...wide()]),
    ]);
    const rows = generateMockRows(s);
    expect(rows.t).toHaveLength(MOCK_ROWS_PER_TABLE);
    for (const r of rows.t) {
      expect(Object.keys(r)).toEqual(["id", ...wide().map((c) => c.name)]);
    }
  });

  it("leaves the fingerprint alone — it describes the SOURCE shape", () => {
    const s = shape([table("t", wide())], "fp-source-shape");
    expect(s.fingerprint).toBe("fp-source-shape");
  });

  it("keeps foreign-key coherence across a wide parent and child", () => {
    const parent = table("authors", [...wide(30), col("id", "int", { nullable: false, isPrimaryKey: true })]);
    const child = table("books", [
      ...wide(30),
      col("author_id", "int", { nullable: false, references: "authors.id" }),
      col("id", "int", { nullable: false, isPrimaryKey: true }),
    ]);
    const rows = generateMockRows(shape([parent, child]));
    const parentIds = new Set(rows.authors.map((r) => r.id));
    expect(parentIds.size).toBe(10);
    for (const r of rows.books) {
      expect(parentIds.has(r.author_id)).toBe(true);
    }
  });
});


/**
 * The rule that decides whether a mock can be built at all.
 *
 * Extracted and exported because the behaviour changed on 2026-09-17: one
 * unreproducible column anywhere used to refuse the whole datasource, which
 * meant a real Prisma schema (46 tables, 14 enum columns) had no mock data of
 * any kind. A source grep for `unsupported_shape` passes against both the old
 * and the new behaviour, so the rule needs a real test.
 */
describe("partitionMockTables", () => {
  const t = (key: string, cols: number) => ({
    key,
    name: key,
    schema: "public",
    columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}` })),
  });

  it("keeps a table that kept at least one column", () => {
    const { usable, empty } = partitionMockTables({ tables: [t("a", 1), t("b", 5)] } as never);
    expect(usable.map((x) => x.key)).toEqual(["a", "b"]);
    expect(empty).toEqual([]);
  });

  it("WARNING: builds the survivors rather than refusing over a lost column", () => {
    // The measured case: most tables fine, one stripped bare by unreproducible
    // types. The old behaviour refused all of it.
    const { usable, empty } = partitionMockTables({
      tables: [t("User", 5), t("AllEnums", 0), t("Post", 3)],
    } as never);
    expect(usable.map((x) => x.key)).toEqual(["User", "Post"]);
    expect(empty.map((x) => x.key)).toEqual(["AllEnums"]);
  });

  it("reports nothing usable when every table lost every column", () => {
    // The one case that must still refuse — the caller turns this into
    // `unsupported_shape`, because there is no mock to build.
    const { usable, empty } = partitionMockTables({ tables: [t("a", 0), t("b", 0)] } as never);
    expect(usable).toEqual([]);
    expect(empty).toHaveLength(2);
  });

  it("reports nothing usable for an empty schema", () => {
    expect(partitionMockTables({ tables: [] } as never).usable).toEqual([]);
  });
});

/**
 * ── 2026-09-17 — enum columns carry real members ───────────────────────────
 *
 * ⚠ Added after a perturbation found NOTHING covering this: replacing the
 * cycling with `members[0]` left every test green while every row of a
 * three-member enum held the same value. That is I-38 in my own tests, and it
 * matters here because the DDL now carries `CHECK (col IN (…))` — a generator
 * that invented a value would not merely be unrealistic, the fixture would fail
 * to load.
 */
describe("enum columns", () => {
  const enumCol = (over: Partial<SandboxColumn> = {}) =>
    col("status", "enum", { sqlType: "text", enumValues: ["NEW", "OPEN", "DONE"], ...over });

  it("writes only declared members", () => {
    const rows = generateMockRows(
      shape([
        table("t", [col("id", "int", { nullable: false, isPrimaryKey: true }), enumCol()]),
      ]),
    );
    for (const r of rows.t) {
      if (r.status === null) continue;
      expect(["NEW", "OPEN", "DONE"]).toContain(r.status);
    }
  });

  /**
   * ⚠ THE ONE THE PERTURBATION EXPOSED. Ten rows over three members must reach
   * every member, or a draft filtering `WHERE status = 'DONE'` reads zero rows
   * and looks broken — the silent-wrong-answer shape this whole patch is about.
   */
  it("reaches EVERY member across the ten rows", () => {
    const rows = generateMockRows(
      shape([
        table("t", [
          col("id", "int", { nullable: false, isPrimaryKey: true }),
          enumCol({ nullable: false }),
        ]),
      ]),
    );
    expect(new Set(rows.t.map((r) => r.status))).toEqual(new Set(["NEW", "OPEN", "DONE"]));
  });

  it("works when the enum IS the primary key", () => {
    const rows = generateMockRows(
      shape([table("t", [enumCol({ nullable: false, isPrimaryKey: true })])]),
    );
    expect(rows.t).toHaveLength(MOCK_ROWS_PER_TABLE);
    for (const r of rows.t) expect(["NEW", "OPEN", "DONE"]).toContain(r.status);
  });
});

describe("a column of UNDECLARED type is reproduced, empty (2026-10-02, H02)", async () => {
  const { deriveShape } = await import("./sandbox-ddl.service.js");
  const entity = (cols: Array<[string, string]>) => ({ name: "v", schema: "main", entityType: "view", rowCountEstimate: null,
    columns: cols.map(([name, type]) => ({ name, type, nullable: true, isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, characterMaximumLength: null })) });
  it("an \"any\" column is in the mock — so a read using it runs — and holds no value in any row", () => {
    const s = deriveShape([entity([["id", "integer"], ["days", "any"]])] as never, { allowlist: ["main"] });
    expect(s.unsupported).toEqual([]);
    const t = s.tables[0]!;
    expect(t.columns.map((c) => [c.name, c.kind])).toEqual([["id", "int"], ["days", "unknown"]]);
    const rows = generateMockRows(s)[t.key]!;
    expect(rows).toHaveLength(MOCK_ROWS_PER_TABLE);
    expect(rows.every((r) => (r as Record<string, unknown>).days === null)).toBe(true);
  });
  it("CONTROL: a type that is declared and unmappable is still refused by name — undeclared is not a wildcard", () => {
    const s = deriveShape([entity([["id", "integer"], ["g", "geometry"]])] as never, { allowlist: ["main"] });
    expect(s.unsupported.join(" ")).toMatch(/g: type "geometry" has no sandbox equivalent/);
  });
});
