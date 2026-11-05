import { describe, expect, it } from "vitest";
import {
  deriveShape,
  fingerprintShape,
  isSafeIdentifier,
  isQuotableIdentifier,
  renderDdl,
  type SandboxTable,
} from "./sandbox-ddl.service.js";
import type { IntrospectedEntity } from "./introspect/types.js";

/**
 * The sandbox's SHAPE, tested where it is pure.
 *
 * Everything else in Stage 4 needs a database, a model or a running engine, and
 * lives in `kestra:sandbox`. This file covers the half that decides whether the
 * sandbox is a faithful copy — and the failure mode it exists for is a copy that
 * is subtly WRONG, which runs the query and returns a different answer.
 */

const col = (over: Partial<IntrospectedEntity["columns"][number]> = {}) => ({
  name: "c",
  type: "integer",
  nullable: true,
  isPrimaryKey: false,
  isForeignKey: false,
  foreignKeyReference: null,
  characterMaximumLength: null,
  ...over,
});

const entity = (over: Partial<IntrospectedEntity> = {}): IntrospectedEntity => ({
  entityType: "table",
  name: "t",
  schema: null,
  rowCountEstimate: null,
  columns: [col()],
  ...over,
});

describe("identifiers", () => {
  it("accepts a plain lower_snake_case name", () => {
    expect(isSafeIdentifier("attendance_monthly")).toBe(true);
  });
  it("refuses anything that would need quoting rules this module does not have", () => {
    for (const bad of ["Employees", "a-b", 'a"b', "a b", "1a", "", "a".repeat(64)]) {
      expect(isSafeIdentifier(bad)).toBe(false);
    }
  });
});

describe("type mapping is an allowlist, and the unmapped case REFUSES", () => {
  it("maps the ordinary families", () => {
    const shape = deriveShape(
      [
        entity({
          columns: [
            col({ name: "id", type: "integer", isPrimaryKey: true, nullable: false }),
            col({ name: "rate", type: "numeric" }),
            col({ name: "code", type: "character varying", characterMaximumLength: 16 }),
            col({ name: "period", type: "character", characterMaximumLength: 7 }),
            col({ name: "when_", type: "timestamp with time zone" }),
            col({ name: "flag", type: "boolean" }),
          ],
        }),
      ],
      { allowlist: ["public"] },
    );
    expect(shape.unsupported).toEqual([]);
    const types = Object.fromEntries(shape.tables[0]!.columns.map((c) => [c.name, c.sqlType]));
    expect(types).toEqual({
      id: "integer",
      rate: "numeric",
      code: "varchar(16)",
      period: "char(7)",
      when_: "timestamptz",
      flag: "boolean",
    });
  });

  /**
   * ⚠ The important one. Widening an enum to `text` would let the fixture hold a
   * value the real column rejects — which is the "invented enum value" failure
   * mode the migration measured. It has to be a refusal, and it has to name the
   * column, or nobody can act on it.
   */
  it("refuses a user-defined type rather than widening it to text", () => {
    const shape = deriveShape(
      [entity({ columns: [col({ name: "mood", type: "user-defined:mood_enum" })] })],
      { allowlist: ["public"] },
    );
    // Two findings, and both are wanted: the column has no equivalent, and the
    // entity is therefore left with nothing reproducible. Reporting only the
    // second would name a table and not the reason.
    expect(shape.unsupported[0]).toContain("mood");
    expect(shape.unsupported[0]).toContain("members");
    expect(shape.unsupported[1]).toContain("no reproducible columns");
    expect(() => renderDdl(shape)).toThrow(/cannot be reproduced/);
  });

  it("refuses an array whose element type has no equivalent", () => {
    const shape = deriveShape(
      [entity({ columns: [col({ name: "grid", type: "array:_point" })] })],
      { allowlist: ["public"] },
    );
    expect(shape.unsupported[0]).toContain("grid");
  });
});

describe("what the copy does NOT reproduce is stated, not hidden", () => {
  it("materialises a view as a table and says the join is not reproduced", () => {
    const shape = deriveShape(
      [entity({ entityType: "view", name: "presence_vs_policy" })],
      { allowlist: ["public"] },
    );
    expect(shape.tables[0]!.sourceKind).toBe("view");
    expect(shape.notes.join(" ")).toMatch(/presence_vs_policy is a view .* plain TABLE/);
  });

  /** Introspection records primary keys only, so the sandbox is more permissive. */
  it("says UNIQUE constraints are not reproduced", () => {
    const shape = deriveShape([entity()], { allowlist: ["public"] });
    expect(shape.notes.join(" ")).toContain("UNIQUE constraints are not reproduced");
  });

  it("names a foreign key whose target is outside the allowlist as unchecked", () => {
    const shape = deriveShape(
      [
        entity({
          name: "orders",
          columns: [col({ name: "customer_id", foreignKeyReference: "customers.id" })],
        }),
      ],
      { allowlist: ["public"] },
    );
    expect(shape.notes.join(" ")).toContain("referential integrity for it is NOT checked");
  });
});

describe("the DDL", () => {
  it("emits the primary key and NOT the foreign keys", () => {
    const shape = deriveShape(
      [
        entity({
          name: "employees",
          columns: [
            col({ name: "id", type: "integer", isPrimaryKey: true, nullable: false }),
            col({ name: "dept_id", type: "integer", foreignKeyReference: "departments.id" }),
          ],
        }),
      ],
      { allowlist: ["public"] },
    );
    const ddl = renderDdl(shape);
    expect(ddl).toContain('PRIMARY KEY ("id")');
    // Deliberate: an enforced FK turns one invented parent id into a failure that
    // aborts the whole fixture and names a constraint instead of a row.
    // `verifyIntegrity` checks the same property afterwards, in SQL.
    expect(ddl).not.toContain("REFERENCES");
    expect(ddl).not.toContain("FOREIGN KEY");
  });

  it("creates a named schema but never `public`", () => {
    const shape = deriveShape([entity({ schema: "hr", name: "staff" })], { allowlist: ["hr"] });
    const ddl = renderDdl(shape);
    expect(ddl).toContain('CREATE SCHEMA IF NOT EXISTS "hr"');
    expect(ddl).not.toContain('CREATE SCHEMA IF NOT EXISTS "public"');
    expect(ddl).toContain('CREATE TABLE "hr"."staff"');
  });

  it("quotes every identifier, so a column called `order` still compiles", () => {
    const shape = deriveShape([entity({ columns: [col({ name: "order" })] })], {
      allowlist: ["public"],
    });
    expect(renderDdl(shape)).toContain('"order" integer');
  });
});

describe("the fingerprint", () => {
  const table = (over: Partial<SandboxTable> = {}): SandboxTable => ({
    schema: null,
    name: "t",
    key: "t",
    sourceKind: "table",
    columns: [
      { name: "id", sqlType: "integer", kind: "int", nullable: false, isPrimaryKey: true, references: null, maxLength: null },
    ],
    ...over,
  });

  it("is stable under column ORDER — the source can reorder without a false drift", () => {
    const a = table({
      columns: [
        { name: "a", sqlType: "integer", kind: "int", nullable: true, isPrimaryKey: false, references: null, maxLength: null },
        { name: "b", sqlType: "text", kind: "text", nullable: true, isPrimaryKey: false, references: null, maxLength: null },
      ],
    });
    const b = table({ columns: [...a.columns].reverse() });
    expect(fingerprintShape([a])).toBe(fingerprintShape([b]));
  });

  it("moves when a column's TYPE changes", () => {
    const a = table();
    const b = table({
      columns: [{ ...a.columns[0]!, sqlType: "bigint" }],
    });
    expect(fingerprintShape([a])).not.toBe(fingerprintShape([b]));
  });

  it("moves when a column becomes nullable", () => {
    const a = table();
    const b = table({ columns: [{ ...a.columns[0]!, nullable: true }] });
    expect(fingerprintShape([a])).not.toBe(fingerprintShape([b]));
  });

  it("moves when a column is added", () => {
    const a = table();
    const b = table({
      columns: [
        ...a.columns,
        { name: "x", sqlType: "text", kind: "text", nullable: true, isPrimaryKey: false, references: null, maxLength: null },
      ],
    });
    expect(fingerprintShape([a])).not.toBe(fingerprintShape([b]));
  });
});


/**
 * -----------------------------------------------------------------------------
 * TWO identifier rules, and the asymmetry is a security property.
 * -----------------------------------------------------------------------------
 *
 * A tenant's Prisma-shaped database (46 PascalCase tables, camelCase columns)
 * could not have mock data at all, because one predicate served two jobs. The
 * refusal claimed the module lacked "quoting rules this module deliberately
 * does not have" - and it had them all along: five emission sites, both insert
 * paths, and a mock engine whose own IDENT already accepted mixed case.
 *
 * WARNING: the two must NOT be merged back. `isSafeIdentifier` guards names that
 * reach SQL UNQUOTED (`CREATE ROLE ${role}`, `GRANT USAGE ON SCHEMA ${schema}`
 * in `sandbox.service.ts`); `isQuotableIdentifier` guards names that are always
 * emitted quoted. Widening the first is an injection hole; narrowing the second
 * puts a whole class of real database back out of reach.
 */
describe("the two identifier rules", () => {
  it("isSafeIdentifier still refuses mixed case - it guards UNQUOTED SQL", () => {
    // The regression that matters. If this ever passes, sandbox role/database/
    // schema names are interpolated bare from a widened rule.
    expect(isSafeIdentifier("Employees")).toBe(false);
    expect(isSafeIdentifier("firstName")).toBe(false);
    for (const bad of ["a-b", 'a"b', "a b", "1a", "", "a".repeat(64)]) {
      expect(isSafeIdentifier(bad)).toBe(false);
    }
  });

  it("isQuotableIdentifier accepts what a real schema actually contains", () => {
    // Every one of these is a real name from the tenant's database.
    for (const ok of ["User", "ActivityFeedAction", "firstName", "createdAt", "isReviewed", "l1Approvers"]) {
      expect(isQuotableIdentifier(ok), ok).toBe(true);
    }
    // ...and it must not stop accepting the snake_case names that always worked.
    for (const ok of ["attendance_monthly", "due_date", "_private"]) {
      expect(isQuotableIdentifier(ok), ok).toBe(true);
    }
  });

  it("still refuses a name that could close its own quoting", () => {
    // `quoteIdent` and `qualify` WRAP. A name carrying a double quote is the one
    // shape that turns a quoted identifier back into SQL.
    expect(isQuotableIdentifier('a"b')).toBe(false);
    expect(isQuotableIdentifier('"; DROP TABLE x; --')).toBe(false);
  });

  it("refuses empty, over-long and control characters", () => {
    expect(isQuotableIdentifier("")).toBe(false);
    expect(isQuotableIdentifier("a".repeat(64))).toBe(false);
    expect(isQuotableIdentifier("a" + "\u0000" + "b")).toBe(false);
    expect(isQuotableIdentifier("a" + "\n" + "b")).toBe(false);
  });

  it("bounds on BYTES, not characters - Postgres truncates at 63 bytes", () => {
    // 32 three-byte characters is 32 `.length` and 96 bytes. A `.length` check
    // would admit it, Postgres would truncate it, and two distinct columns could
    // collide into one.
    const wide = "\u3042".repeat(32);
    expect(wide.length).toBe(32);
    expect(isQuotableIdentifier(wide)).toBe(false);
  });

  it("a hyphen is fine QUOTED, though never bare", () => {
    // The clearest statement of the split: the same name, two answers.
    expect(isQuotableIdentifier("a-b")).toBe(true);
    expect(isSafeIdentifier("a-b")).toBe(false);
  });
});

/** Every case below uses the default allowlist; the schema rules are tested above. */
const OPTS = { allowlist: ["public"] };

/**
 * ── 2026-09-17 — an enum is reproduced, and NOTHING vanishes silently ───────
 *
 * The refusal this replaces was right about the risk and wrong about the
 * premise: it said *"introspection does not record an enum's members"*, which
 * stopped being true when `postgres.introspector.ts` started reading `pg_enum`.
 * Its actual concern — a column widened to `text` accepts values the real one
 * rejects — is honoured by the `CHECK`, not dropped.
 *
 * Measured cost of the old behaviour: 14 columns across 10 tables of a real
 * tenant were absent from the mock, so a correct query touching one died with
 * `column "partnerType" does not exist`.
 */
describe("a user-defined type with members is reproduced", () => {
  const enumCol = (members: string) =>
    entity({
      name: "partners_user",
      columns: [
        col({ name: "id", type: "text", nullable: false, isPrimaryKey: true }),
        col({ name: "partnerType", type: `user-defined:partner_type(${members})`, nullable: false }),
      ],
    });

  it("keeps the column, as text with its members", () => {
    const shape = deriveShape([enumCol("AGENCY,DIRECT,REFERRAL")], OPTS);
    expect(shape.unsupported).toEqual([]);
    const c = shape.tables[0]!.columns.find((x) => x.name === "partnerType")!;
    expect(c.kind).toBe("enum");
    expect(c.sqlType).toBe("text");
    expect(c.enumValues).toEqual(["AGENCY", "DIRECT", "REFERRAL"]);
  });

  /**
   * ⚠ THE LOAD-BEARING HALF. Without the CHECK this is a `text` column, and the
   * objection the old refusal raised becomes true: the copy accepts values the
   * source rejects.
   */
  it("emits a CHECK so the copy refuses what the source refuses", () => {
    const ddl = renderDdl(deriveShape([enumCol("AGENCY,DIRECT")], OPTS));
    expect(ddl).toContain(`"partnerType" text NOT NULL CHECK ("partnerType" IN ('AGENCY', 'DIRECT'))`);
  });

  it("escapes a quote in a member rather than breaking the statement", () => {
    const ddl = renderDdl(deriveShape([enumCol("O'Brien,Smith")], OPTS));
    expect(ddl).toContain(`'O''Brien'`);
  });

  /**
   * ⚠ A domain and a composite are `USER-DEFINED` too and have no members. They
   * must keep falling through to the refusal — an empty member list would read
   * as an enum that permits nothing, and the CHECK would refuse every row.
   */
  it("still refuses a user-defined type with NO members", () => {
    const shape = deriveShape(
      [
        entity({
          columns: [
            // A survivor, so the TABLE is still emitted and the assertion is
            // about the column rather than about the table disappearing.
            col({ name: "id", type: "integer", nullable: false, isPrimaryKey: true }),
            col({ name: "addr", type: "user-defined:address_domain" }),
          ],
        }),
      ],
      OPTS,
    );
    expect(shape.tables[0]!.columns.find((c) => c.name === "addr")).toBeUndefined();
    expect(shape.unsupported.join(" ")).toMatch(/no members recorded/);
  });

  it("refuses an empty member list rather than emitting CHECK (x IN ())", () => {
    const shape = deriveShape([entity({ columns: [col({ name: "e", type: "user-defined:t()" })] })], OPTS);
    expect(shape.unsupported.join(" ")).toMatch(/no members recorded/);
  });
});

/**
 * **THE ACCOUNTING IDENTITY — every source column is reproduced or named.**
 *
 * ⚠ This is the structural guarantee, and it is the one assertion here that
 * survives a rewrite of everything above it. The failure this feature exists to
 * end is a column going MISSING QUIETLY: the mock had a five-column cap, then an
 * enum exclusion, and in both cases the symptom arrived much later as a correct
 * query dying against the fixture. A column may be absent — some types genuinely
 * cannot be reproduced — but it may never be absent without a reason on the
 * record.
 */
describe("no column vanishes without a reason", () => {
  const everyType = entity({
    name: "wide",
    columns: [
      col({ name: "id", type: "integer", nullable: false, isPrimaryKey: true }),
      col({ name: "t", type: "text" }),
      col({ name: "v", type: "character varying", characterMaximumLength: 20 }),
      col({ name: "n", type: "numeric" }),
      col({ name: "b", type: "boolean" }),
      col({ name: "u", type: "uuid" }),
      col({ name: "j", type: "jsonb" }),
      col({ name: "d", type: "date" }),
      col({ name: "ts", type: "timestamp with time zone" }),
      col({ name: "arr", type: "array:_text" }),
      col({ name: "en", type: "user-defined:kind(a,b)" }),
      col({ name: "dom", type: "user-defined:some_domain" }),
      col({ name: "weird", type: "tsvector" }),
    ],
  });

  it("reproduced + named-as-unsupported === every source column", () => {
    const shape = deriveShape([everyType], OPTS);
    const reproduced = shape.tables[0]!.columns.map((c) => c.name);
    const named = everyType.columns
      .map((c) => c.name)
      .filter((n) => shape.unsupported.some((u) => u.includes(`.${n}:`)));
    expect([...reproduced, ...named].sort()).toEqual(
      everyType.columns.map((c) => c.name).sort(),
    );
  });

  it("and only the two genuinely unreproducible ones are missing", () => {
    const shape = deriveShape([everyType], OPTS);
    const reproduced = new Set(shape.tables[0]!.columns.map((c) => c.name));
    // ⚠ `en` is IN. It was the 14-column regression, and it is the case this
    // identity would otherwise pass over quietly with a reason attached.
    expect(reproduced.has("en")).toBe(true);
    expect(reproduced.has("arr")).toBe(true);
    expect(reproduced.has("dom")).toBe(false);
    expect(reproduced.has("weird")).toBe(false);
    expect(shape.unsupported).toHaveLength(2);
  });

  /** CONTROL — the identity can fail, so passing it means something. */
  it("CONTROL: a column that is neither reproduced nor named breaks the identity", () => {
    const shape = deriveShape([everyType], OPTS);
    const reproduced = shape.tables[0]!.columns.map((c) => c.name).filter((n) => n !== "t");
    const named = everyType.columns
      .map((c) => c.name)
      .filter((n) => shape.unsupported.some((u) => u.includes(`.${n}:`)));
    expect([...reproduced, ...named].sort()).not.toEqual(
      everyType.columns.map((c) => c.name).sort(),
    );
  });
});
