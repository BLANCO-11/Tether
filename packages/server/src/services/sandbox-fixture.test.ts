import { describe, expect, it } from "vitest";
import {
  TAXONOMY,
  TAXONOMY_CHECK_IDS,
  bindValue,
  buildTablePrompt,
  extractJsonObject,
  topoOrder,
} from "./sandbox-fixture.service.js";
import { deriveShape, type SandboxTable } from "./sandbox-ddl.service.js";
import type { IntrospectedEntity } from "./introspect/types.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fixture generator's pure half.
 *
 * The taxonomy CHECKS need a loaded database and live in `kestra:sandbox`. What
 * is testable here is the part most likely to rot silently: whether the prompt
 * and the checks still describe the same seven things, and whether the prompt
 * can reach data.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const shapeOf = (entities: IntrospectedEntity[]) => deriveShape(entities, { allowlist: ["public"] });

describe("the taxonomy is asked for and checked as one set", () => {
  /**
   * ⚠ The control that stops a category becoming decorative. A category listed
   * in the prompt with no checker is a promise nothing verifies, and it reads on
   * screen exactly like one that was checked.
   */
  it("every category in the prompt has a checker, and every checker has a category", () => {
    expect([...TAXONOMY.map((t) => t.id)].sort()).toEqual([...TAXONOMY_CHECK_IDS].sort());
  });

  it("has seven categories", () => {
    expect(TAXONOMY).toHaveLength(7);
  });

  it("every category states what it wants concretely enough to act on", () => {
    for (const t of TAXONOMY) expect(t.ask.length).toBeGreaterThan(30);
  });
});

describe("the prompt cannot reach data", () => {
  /**
   * ⚠ The property the whole stage rests on: the generator adds ZERO exposure,
   * because it sees only the schema — which the drafting prompt already contains.
   * Asserted against the source, because the failure would be someone adding a
   * "a few example rows help the model" parameter, and no behavioural test would
   * catch it (the fixture would still load, and would look better).
   */
  it("takes no database handle, DSN, datasource id or row sample", () => {
    const src = fs.readFileSync(path.join(HERE, "sandbox-fixture.service.ts"), "utf8");
    const signature = src.slice(
      src.indexOf("export function buildTablePrompt"),
      src.indexOf("): string {", src.indexOf("export function buildTablePrompt")),
    );
    for (const forbidden of ["Client", "dsn", "connectionString", "datasourceId", "sample", "rowsFrom"]) {
      expect(signature).not.toContain(forbidden);
    }
  });

  it("names the schema, the required properties and the date window — and nothing else", () => {
    const shape = shapeOf([
      {
        entityType: "table",
        name: "employees",
        schema: null,
        rowCountEstimate: null,
        columns: [col({ name: "id", isPrimaryKey: true, nullable: false }), col({ name: "full_name", type: "text" })],
      },
    ]);
    const prompt = buildTablePrompt({
      table: shape.tables[0]!,
      shape,
      parentKeys: {},
      rows: 12,
      window: { from: "2026-05-01", to: "2026-08-02" },
    });
    expect(prompt).toContain("employees");
    expect(prompt).toContain("full_name");
    expect(prompt).toContain("Write exactly 12 rows");
    // The measured failure: a valid fixture dated 2023 that a 2026 flow reads as empty.
    expect(prompt).toContain("2026-05-01");
    expect(prompt).toContain("2026-08-02");
    for (const t of TAXONOMY) expect(prompt).toContain(t.ask);
    // RFC 2606 only, the same rule the demo datasets follow.
    expect(prompt).toContain("RFC 2606");
  });

  it("hands a child table its parent's actual key values, so a foreign key can be satisfied", () => {
    const shape = shapeOf([
      {
        entityType: "table",
        name: "attendance",
        schema: null,
        rowCountEstimate: null,
        columns: [col({ name: "employee_id", foreignKeyReference: "employees.id" })],
      },
    ]);
    const prompt = buildTablePrompt({
      table: shape.tables[0]!,
      shape,
      parentKeys: { "employees.id": [1, 2, 3] },
      rows: 12,
      window: { from: "2026-05-01", to: "2026-08-02" },
    });
    expect(prompt).toContain("employee_id must be one of: [1,2,3]");
  });
});

describe("insert order", () => {
  const t = (name: string, refs: Array<[string, string]> = []): SandboxTable => ({
    schema: null,
    name,
    key: name,
    sourceKind: "table",
    columns: [
      { name: "id", sqlType: "integer", kind: "int", nullable: false, isPrimaryKey: true, references: null, maxLength: null },
      ...refs.map(([c, r]) => ({
        name: c,
        sqlType: "integer",
        kind: "int" as const,
        nullable: true,
        isPrimaryKey: false,
        references: r,
        maxLength: null,
      })),
    ],
  });

  it("puts a parent before its child", () => {
    const order = topoOrder([t("employees", [["dept_id", "departments.id"]]), t("departments")]);
    expect(order.map((x) => x.name)).toEqual(["departments", "employees"]);
  });

  it("does not stall on a self-reference — `employees.manager_id` is one", () => {
    const order = topoOrder([t("employees", [["manager_id", "employees.id"]])]);
    expect(order.map((x) => x.name)).toEqual(["employees"]);
  });

  /**
   * A circular foreign key is legal in Postgres. It must not hang provisioning —
   * and it is safe to place arbitrarily here precisely because the DDL does not
   * enforce foreign keys.
   */
  it("terminates on a cycle rather than looping", () => {
    const order = topoOrder([t("a", [["b_id", "b.id"]]), t("b", [["a_id", "a.id"]])]);
    expect(order).toHaveLength(2);
  });
});

describe("reading the model's answer", () => {
  it("finds the object inside a fenced block", () => {
    expect(extractJsonObject('```json\n{"rows":[{"a":1}]}\n```')).toEqual({ rows: [{ a: 1 }] });
  });

  it("finds it after a sentence of preamble", () => {
    expect(extractJsonObject('Here you go:\n{"rows":[]}')).toEqual({ rows: [] });
  });

  it("is not confused by a brace inside a string", () => {
    expect(extractJsonObject('{"rows":[{"note":"a } b"}]}')).toEqual({ rows: [{ note: "a } b" }] });
  });

  /**
   * ⚠ Truncation must be LOUD. A cut-off answer would otherwise parse as "no
   * JSON object" and be reported as the model misbehaving, when what happened is
   * that it ran out of output budget — a different problem with a different fix.
   */
  it("says a truncated answer is truncated", () => {
    expect(() => extractJsonObject('{"rows":[{"a":1}')).toThrow(/not closed|truncated/);
  });
});

describe("binding a value", () => {
  it("stringifies json, because pg would otherwise send an object literal", () => {
    expect(bindValue("json", { a: 1 })).toBe('{"a":1}');
  });
  it("passes an array through for an array column", () => {
    expect(bindValue("array", [1, 2])).toEqual([1, 2]);
  });
  /**
   * Deliberately NOT coercive. A number for a text column, a string for a
   * numeric — the database is the authority on what the column accepts, and a
   * helpful coercion here is how a fixture ends up holding something production
   * would reject.
   */
  it("does not coerce a scalar to fit its column", () => {
    expect(bindValue("text", 42)).toBe(42);
    expect(bindValue("int", "80.95")).toBe("80.95");
  });
  it("maps undefined to NULL", () => {
    expect(bindValue("text", undefined)).toBeNull();
  });
});

/**
 * -----------------------------------------------------------------------------
 * WARNING: NATURAL-KEY FOREIGN KEYS -- found by RUNNING, not by reading
 * -----------------------------------------------------------------------------
 *
 * Publishing parent values read `if (!c.isPrimaryKey) continue;`, so a foreign
 * key pointing at a UNIQUE column that is NOT the primary key never had its
 * parent's values handed over. `buildTablePrompt` fell through to its own
 * else-branch -- "whose rows are not yet decided, use plausible values" -- and
 * the model invented values that matched nothing.
 *
 * Measured 2026-09-04, provisioning all seven demo datasources:
 *
 *     legal    contracts.type_code -> contract_types.code    12 of 12 dangling
 *     finance  expense_claims.category -> expense_policy.category   1 dangling
 *
 * `topoOrder` already generates the parent first, so the values existed the
 * whole time. Nothing handed them over.
 *
 * WARNING: **It failed LOUDLY** -- the integrity check refused it and no
 * sandbox was left behind, which is the difference between this and a silent
 * bug. But it failed only on the two schemas whose codes carry meaning, and
 * every surrogate-key schema passed, so "the generator works" was true of the
 * easy half and nothing said which half you were in.
 */
describe("a foreign key to a natural key gets its parent's values", () => {
  const parent = {
    entityType: "table" as const,
    name: "contract_types",
    schema: null,
    rowCountEstimate: null,
    columns: [
      col({ name: "id", isPrimaryKey: true, nullable: false }),
      col({ name: "code", type: "text" }),
    ],
  };
  const child = {
    entityType: "table" as const,
    name: "contracts",
    schema: null,
    rowCountEstimate: null,
    columns: [
      col({ name: "id", isPrimaryKey: true, nullable: false }),
      col({ name: "type_code", type: "text", isForeignKey: true, foreignKeyReference: "contract_types.code" }),
    ],
  };

  it("names the allowed values instead of asking for plausible ones", () => {
    const shape = shapeOf([parent, child]);
    const prompt = buildTablePrompt({
      table: shape.tables.find((t) => t.name === "contracts")!,
      shape,
      // What the fixed publisher produces: a referenced NON-primary-key column.
      parentKeys: { "contract_types.code": ["NDA", "MSA", "SOW"] },
      rows: 12,
      window: { from: "2026-07-01", to: "2026-09-04" },
    });
    expect(prompt).toContain('type_code must be one of: ["NDA","MSA","SOW"]');
    // The else-branch is what produced the twelve invented codes. Its presence
    // here would mean the parent's values never arrived.
    expect(prompt).not.toContain("use plausible values");
  });

  it("still asks for plausible values when the parent genuinely has none", () => {
    // The control. Without it the assertion above is satisfied by a version
    // that deleted the else-branch entirely, which would turn a missing parent
    // into silence rather than into an instruction.
    const shape = shapeOf([parent, child]);
    const prompt = buildTablePrompt({
      table: shape.tables.find((t) => t.name === "contracts")!,
      shape,
      parentKeys: {},
      rows: 12,
      window: { from: "2026-07-01", to: "2026-09-04" },
    });
    expect(prompt).toContain("use plausible values");
  });

  it("the publisher keeps every referenced column, not only primary keys", () => {
    const src = fs.readFileSync(path.join(HERE, "sandbox-fixture.service.ts"), "utf8");
    // The control: a moved file reads as "" and the assertions pass over it.
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("export async function generateFixture");
    // The regression, stated as the thing that was wrong: a bare primary-key
    // filter with no reference check beside it.
    // ⚠ Anchored to the start of a line (whitespace then `if`), so it matches
    // CODE and not the docblock above it, which quotes the old line verbatim
    // on purpose — the first version of this assertion was red against the
    // fixed source because of its own comment.
    expect(src).not.toMatch(/\n\s*if \(!c\.isPrimaryKey\) continue;/);
    expect(src).toMatch(/if \(!c\.isPrimaryKey && !referenced\.has\(ref\)\) continue;/);
  });
});
