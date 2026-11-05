/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE READBACK — FR-022, FR-023, SC-007
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The readback is the artefact a person approves. Everything downstream of the
 * approval — that a proposed operation becomes a real ref, callable from a
 * `query` step, in a flow that can be armed — rests on that "yes" meaning
 * something, so the properties asserted here are the ones that decide whether it
 * can also be a "no":
 *
 *  1. **Exhaustive.** Every `kind`, every `op`, every `dir`, every aggregate has
 *     words. An operator with no sentence renders as nothing and is approved by
 *     a reader who saw no reason to object.
 *  2. **Non-collapsing.** `inner` and `left` must not read the same, and no two
 *     filter operators may either. A readback whose distinctions have collapsed
 *     still LOOKS like a readback — which is worse than not having one, because
 *     it manufactures the confidence FR-024 rejects sample rows for.
 *  3. **Pure.** Asserted against the module's own source, not inferred from its
 *     behaviour.
 *  4. **In agreement with the compiler.** The one claim the readback makes that
 *     `compileOperation` also decides — how many rows come back once a column is
 *     aggregated — is checked against the SQL actually emitted.
 *
 * ⚠ **What is NOT asserted, deliberately**: that the English is *good*. There is
 * no test for that and there cannot be; T23 measures whether people accept
 * proposals, and FR-025 bounds what accepting one is worth.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readback, type ReadbackClause } from "./db-operation-readback.js";
import {
  AGGREGATES,
  FILTER_OPS,
  JOIN_KINDS,
  SORT_DIRS,
  compileOperation,
  type DbOperationSpecInput,
} from "./db-operation.service.js";
import type { SchemaRow } from "../repositories/schema.repo.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const only = (cs: ReadbackClause[], label: ReadbackClause["label"]) =>
  cs.filter((c) => c.label === label);
const one = (cs: ReadbackClause[], label: ReadbackClause["label"]) => {
  const hit = only(cs, label);
  expect(hit).toHaveLength(1);
  return hit[0]!;
};

/** The spec from plan Decision 10's worked example, minus the parts under test. */
const INVOICES: DbOperationSpecInput = {
  base: { table: "invoices" },
  columns: [
    { column: "id", alias: "invoice_id" },
    { column: "amount", alias: "amount" },
    { column: "due_date", alias: "due_date" },
    { column: "name", alias: "customer_name" },
  ],
  joins: [{ table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" }],
  filters: [{ column: "due_date", op: "lt", param: "as_of" }],
  sort: [{ column: "amount", dir: "desc" }],
  limit: 500,
};

function schemaRow(entityName: string, columnName: string | null, columnType: string | null): SchemaRow {
  return {
    id: `${entityName}.${columnName ?? "_"}`,
    datasourceId: "ds1",
    entityType: "table",
    entitySchema: null,
    entityName,
    columnName,
    columnType,
    isPrimaryKey: false,
    isForeignKey: false,
    foreignKeyReference: null,
    nullable: true,
    characterMaximumLength: null,
    rowCountEstimate: null,
    nullPercentage: null,
    extractedAt: new Date("2026-08-27T00:00:00Z"),
  } as SchemaRow;
}

const SCHEMA: SchemaRow[] = [
  schemaRow("invoices", null, null),
  schemaRow("invoices", "id", "uuid"),
  schemaRow("invoices", "amount", "numeric"),
  schemaRow("invoices", "due_date", "date"),
  schemaRow("invoices", "customer_id", "uuid"),
  schemaRow("customers", null, null),
  schemaRow("customers", "id", "uuid"),
  schemaRow("customers", "name", "text"),
  schemaRow("customers", "region", "text"),
];

// ── 1. exhaustive over every enum ────────────────────────────────────────────

describe("SC-007 — every spec value has words", () => {
  it("renders a distinct phrase for every one of the eight filter operators", () => {
    const rendered = new Map<string, string>();
    for (const op of FILTER_OPS) {
      const cs = readback({ ...INVOICES, filters: [{ column: "due_date", op, param: "as_of" }] });
      const kept = one(cs, "Kept when");
      // Words, not a placeholder: an operator whose entry is missing renders
      // `undefined` through the template and would otherwise pass a
      // "contains the column name" assertion.
      expect(kept.text).not.toContain("undefined");
      expect(kept.text).toContain("due_date");
      expect(kept.text).toContain("(as_of)");
      expect(kept.text.length).toBeGreaterThan("due_date  (as_of)".length + 8);
      rendered.set(op, kept.text);
    }
    // ⚠ THE COLLAPSE CONTROL, over the whole set. Eight phrases, eight distinct
    // strings — if any two operators are given the same words this fails, and
    // the pair is named rather than the count being off by one.
    const seen = new Map<string, string>();
    for (const [op, text] of rendered) {
      const prior = seen.get(text);
      expect(prior, `"${op}" renders exactly as "${prior}" — the distinction is gone`).toBeUndefined();
      seen.set(text, op);
    }
    expect(rendered.size).toBe(FILTER_OPS.length);
  });

  it("⚠ keeps `lt` and `lte` apart — FR-023's named pair", () => {
    const at = (op: "lt" | "lte") =>
      one(readback({ ...INVOICES, filters: [{ column: "due_date", op, param: "as_of" }] }), "Kept when")
        .text;
    // The trap this pair exists for: a boundary off by one day looks correct in
    // every sample of rows anyone would inspect, and is only visible in words.
    expect(at("lt")).toContain("is BEFORE");
    expect(at("lte")).toContain("is ON OR BEFORE");
    expect(at("lt")).not.toBe(at("lte"));
    // And `lt` must not merely be a prefix-sharing variant that a reader skims
    // past: "ON OR" appears in exactly one of them.
    expect(at("lt")).not.toContain("ON OR");
  });

  it("renders a note for every join kind, and the two notes DIFFER", () => {
    const notes = new Map<string, string | undefined>();
    for (const kind of JOIN_KINDS) {
      const cs = readback({
        ...INVOICES,
        joins: [{ table: "customers", onLeft: "customer_id", onRight: "id", kind }],
      });
      const from = only(cs, "From");
      expect(from).toHaveLength(2); // the base, then the join
      notes.set(kind, from[1]!.note);
    }
    for (const [kind, note] of notes) {
      expect(note, `join kind "${kind}" renders no note`).toBeTruthy();
      // Both tables named. "rows are left out" is true of every inner join ever
      // written and gives the reader nothing to disagree with.
      expect(note).toContain("invoices");
      expect(note).toContain("customers");
    }
    // ⚠ THE COLLAPSE CONTROL FR-023 IS ABOUT. If these two ever render the same
    // note this test fails — which is the whole reason it is written as an
    // inequality over the enum rather than as two independent assertions.
    expect(new Set(notes.values()).size).toBe(JOIN_KINDS.length);
    expect(notes.get("inner")).toContain("LEFT OUT");
    expect(notes.get("left")).toContain("KEPT");
    // Each says only its own thing: a note containing both words would be
    // technically distinct and useless.
    expect(notes.get("inner")).not.toContain("KEPT");
    expect(notes.get("left")).not.toContain("LEFT OUT");
  });

  it("renders a distinct phrase for both sort directions", () => {
    const texts = SORT_DIRS.map(
      (dir) => one(readback({ ...INVOICES, sort: [{ column: "amount", dir }] }), "Ordered by").text,
    );
    for (const t of texts) {
      expect(t).toContain("amount");
      expect(t).not.toContain("undefined");
    }
    expect(new Set(texts).size).toBe(SORT_DIRS.length);
  });

  it("renders a distinct phrase for every aggregate", () => {
    const texts = AGGREGATES.map(
      (aggregate) =>
        one(readback({ ...INVOICES, columns: [{ column: "amount", aggregate, alias: "v" }] }), "You get")
          .text,
    );
    for (const t of texts) {
      expect(t).toContain("amount");
      expect(t).not.toContain("undefined");
    }
    expect(new Set(texts).size).toBe(AGGREGATES.length);
  });
});

// ── 2. the clauses a spec's SILENCE produces ─────────────────────────────────

describe("what the spec does NOT say is stated too", () => {
  it("says EVERY row when there is no filter, rather than rendering nothing", () => {
    // Silence under "Kept when" is indistinguishable on a screen from a section
    // that failed to render — and the two mean opposite things.
    const kept = one(readback({ ...INVOICES, filters: [] }), "Kept when");
    expect(kept.text).toContain("EVERY row");
    expect(kept.note).toContain("no value is supplied");
  });

  it("says NO LIMIT when the spec has none — because the compiler emits none", () => {
    const spec = { ...INVOICES };
    delete spec.limit;
    const at = one(readback(spec), "At most");
    expect(at.text).toContain("NO LIMIT");
    expect(at.note).toBeTruthy();
    // Not a claim about the readback — a claim about the compiler it describes.
    expect(compileOperation(spec, SCHEMA).sql).not.toContain("LIMIT");
  });

  it("⚠ escalates when a limit is set and nothing orders the rows", () => {
    const cs = readback({ ...INVOICES, sort: [] });
    const ordered = one(cs, "Ordered by");
    expect(ordered.text).toContain("any order");
    // "the first 500" of an unordered result is an arbitrary 500 that can differ
    // between two runs over identical data: a flow that passes its test run and
    // is not stable.
    expect(ordered.note).toContain("500");
    expect(ordered.note).toContain("arbitrary");
  });

  it("and does NOT escalate when there is no limit to be arbitrary about", () => {
    const spec = { ...INVOICES, sort: [] };
    delete spec.limit;
    expect(one(readback(spec), "Ordered by").note).toBeUndefined();
  });

  it("singularises a limit of one", () => {
    expect(one(readback({ ...INVOICES, limit: 1 }), "At most").text).toBe("1 row");
    expect(one(readback({ ...INVOICES, limit: 2 }), "At most").text).toBe("2 rows");
  });

  it("tolerates a spec with the optional arrays absent, as the compiler does", () => {
    // zod's `.default([])` applies on `.parse()` only, and the proposal loop
    // renders a spec while it is still deciding whether to keep it.
    const cs = readback({ base: { table: "invoices" }, columns: [{ column: "id", alias: "id" }] });
    expect(only(cs, "From")).toHaveLength(1);
    expect(one(cs, "Kept when").text).toContain("EVERY row");
    expect(one(cs, "Ordered by").text).toContain("any order");
    expect(one(cs, "At most").text).toContain("NO LIMIT");
  });
});

// ── 3. agreement with the compiler ───────────────────────────────────────────

/**
 * ⚠ The readback's row-count note restates `compileOperation`'s GROUP BY rule,
 * which is the same rule in two places — something this repo normally refuses.
 * It is allowed *because of this block*: `compileOperation` is pure, so the
 * claim is checked against the SQL actually emitted rather than against a copy
 * of the rule. Delete these tests and the comment in the readback module that
 * points at them becomes false.
 */
describe("the row-count note agrees with the SQL the compiler emits", () => {
  const AGG_SPEC: DbOperationSpecInput = {
    base: { table: "invoices" },
    columns: [
      { column: "name", alias: "customer_name" },
      { column: "amount", aggregate: "sum", alias: "total" },
    ],
    joins: [{ table: "customers", onLeft: "customer_id", onRight: "id", kind: "inner" }],
  };

  it("mixed aggregate and plain → GROUP BY, and the note names the grouping columns", () => {
    expect(compileOperation(AGG_SPEC, SCHEMA).sql).toContain("GROUP BY");
    const got = one(readback(AGG_SPEC), "You get");
    expect(got.note).toContain("one row per distinct combination of customer_name");
  });

  it("every column aggregated → NO GROUP BY, and the note says one row in total", () => {
    const spec: DbOperationSpecInput = {
      ...AGG_SPEC,
      columns: [{ column: "amount", aggregate: "sum", alias: "total" }],
    };
    expect(compileOperation(spec, SCHEMA).sql).not.toContain("GROUP BY");
    expect(one(readback(spec), "You get").note).toContain("ONE row in total");
  });

  it("no aggregate at all → no GROUP BY and no note", () => {
    expect(compileOperation(INVOICES, SCHEMA).sql).not.toContain("GROUP BY");
    expect(one(readback(INVOICES), "You get").note).toBeUndefined();
  });
});

// ── 4. FR-011's output columns, on the compiler's side ───────────────────────

describe("FR-011 — output columns carry provenance", () => {
  it("names the QUALIFIED TABLE, never the t0/t1 SQL alias", () => {
    // Provenance only: `nullable` has its own tests (db-operation-nullability.test.ts).
    const out = compileOperation(INVOICES, SCHEMA).outputColumns.map(({ nullable: _n, ...c }) => c);
    expect(out).toEqual([
      { alias: "invoice_id", source: "invoices.id", type: "uuid" },
      { alias: "amount", source: "invoices.amount", type: "numeric" },
      { alias: "due_date", source: "invoices.due_date", type: "date" },
      { alias: "customer_name", source: "customers.name", type: "text" },
    ]);
    // ⚠ The whole point. `t1.name` is meaningless to the person approving this.
    for (const c of out) expect(c.source).not.toMatch(/^t\d\./);
  });

  it("appears in the same order as the select list it was projected from", () => {
    const { sql, outputColumns } = compileOperation(INVOICES, SCHEMA);
    expect(outputColumns.map((c) => c.alias)).toEqual([
      "invoice_id",
      "amount",
      "due_date",
      "customer_name",
    ]);
    // Not an agreement between two lists — one is projected from the other.
    for (const c of outputColumns) expect(sql).toContain(`AS "${c.alias}"`);
  });

  it("says which column an aggregate summarised", () => {
    const out = compileOperation(
      {
        base: { table: "invoices" },
        columns: [{ column: "id", aggregate: "count", alias: "invoice_count" }],
      },
      SCHEMA,
    ).outputColumns.map(({ nullable: _n, ...c }) => c);
    expect(out).toEqual([{ alias: "invoice_count", source: "count(invoices.id)", type: "uuid" }]);
  });

  it("qualifies a table that lives in a named schema", () => {
    const rows = [
      ...SCHEMA,
      schemaRow("staff", null, null),
      schemaRow("staff", "full_name", "text"),
    ].map((r) => (r.entityName === "staff" ? ({ ...r, entitySchema: "hr" } as SchemaRow) : r));
    const out = compileOperation(
      { base: { schema: "hr", table: "staff" }, columns: [{ column: "full_name", alias: "who" }] },
      rows,
    ).outputColumns;
    expect(out[0]!.source).toBe("hr.staff.full_name");
  });
});

// ── 5. the shape of the whole thing ─────────────────────────────────────────

describe("the worked example reads as the plan says it does", () => {
  it("produces the five labels in order, base first", () => {
    const cs = readback(INVOICES);
    expect(cs.map((c) => c.label)).toEqual([
      "From",
      "From",
      "Kept when",
      "You get",
      "Ordered by",
      "At most",
    ]);
    expect(cs[0]!.text).toBe("invoices");
    expect(cs[1]!.text).toContain("each row matched to customers");
    expect(cs[1]!.text).toContain("customer_id = customers.id");
    expect(cs[1]!.note).toContain("LEFT OUT");
    expect(cs[2]!.text).toBe("due_date is BEFORE the value you supply — for a number, LESS THAN it (as_of)");
    expect(cs[3]!.text).toBe("invoice_id ← id · amount ← amount · due_date ← due_date · customer_name ← name");
    expect(cs[4]!.text).toContain("largest first");
    expect(cs[5]!.text).toBe("500 rows");
  });

  it("qualifies the base table when the spec names a schema", () => {
    const cs = readback({ ...INVOICES, base: { schema: "billing", table: "invoices" } });
    expect(cs[0]!.text).toBe("billing.invoices");
    // And the join note uses the qualified name too, so the two halves of the
    // same sentence cannot name the table two different ways.
    expect(cs[1]!.note).toContain("billing.invoices with no matching row in customers");
  });
});

// ── 6. the purity control ───────────────────────────────────────────────────

/**
 * ⚠ Asserted against the SOURCE, not inferred from behaviour. "It is pure"
 * cannot be observed by calling it: a module that read a repository on some
 * other branch would pass every test above.
 */
describe("the readback module is a pure leaf", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./db-operation-readback.ts", import.meta.url)),
    "utf8",
  );

  /**
   * ⚠ **CODE ONLY.** The first version of these assertions ran against the raw
   * file and failed on the module's own comments — the docblock that says *"no
   * `inference` import"* contains the word `inference`, and the one explaining
   * *"a `default:` case here is how a new operator ships with no sentence"*
   * contains `default:`. A prose-scanning version of this test is not merely
   * noisy: it is satisfiable by DELETING the explanation, which is the opposite
   * of what it exists to protect.
   *
   * `flow-chat-imports.test.ts` records the same class of mistake from the other
   * direction (a regex that returned 30 "symbols", most of them comment prose).
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  /** ⚠ The control: the file this read is really the readback module. */
  it("and the file it read is really the readback module", () => {
    expect(source.length).toBeGreaterThan(3000);
    expect(code).toContain("export function readback");
    expect(code).toContain("ReadbackClause");
    // And the comment stripper left the code behind rather than the file.
    expect(code.length).toBeGreaterThan(1200);
  });

  it("has exactly ONE import, and it is a type-only import", () => {
    const imports = code.match(/^import[\s\S]*?;$/gm) ?? [];
    expect(imports).toHaveLength(1);
    // Type-only ⇒ erased at compile time ⇒ no runtime dependency on anything at
    // all, which is what makes the next assertion a statement about the module
    // rather than about this test's import list.
    expect(imports[0]).toMatch(/^import type /);
  });

  it("names no repository, no zod, no inference and no model", () => {
    for (const forbidden of [
      "repositories/",
      'from "zod"',
      "inference",
      "InferenceClient",
      "schemaRepo",
      "dbOperationRepo",
      "process.env",
    ]) {
      expect(code, `readback module must not name ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("is exhaustive by construction, not by a default case", () => {
    // ⚠ A `switch` with a `default:` is how a new operator ships with no
    // sentence describing it. The `Record<...>` types are what make adding one
    // to FILTER_OPS a compile error instead.
    expect(code).toContain("Record<FilterOp, string>");
    expect(code).toContain("Record<JoinKind,");
    expect(code).toContain("Record<SortDir, string>");
    expect(code).toContain("Record<Aggregate, string>");
    expect(code).not.toMatch(/\bdefault:/);
  });
});

describe("a fixed NUMBER reads as itself; a month as the month of a date (2026-10-01)", () => {
  it("“is EXACTLY 0”, never “the value you supply”", () => {
    const text = readback({ base: { table: "t" }, columns: [{ column: "a", alias: "a" }], filters: [{ column: "hours", op: "eq", value: 0 }, { column: "d", op: "month", param: "period" }] } as never)
      .map((c) => c.text).join(" | ");
    expect(text).toContain("hours is EXACTLY 0");
    expect(text).toContain("falls in the calendar month of the date you supply");
    expect(text).not.toContain("YYYY-MM");
    // CONTROL: a supplied value still names its parameter.
    expect(readback({ base: { table: "t" }, columns: [{ column: "a", alias: "a" }], filters: [{ column: "hours", op: "eq", param: "h" }] } as never).map((c) => c.text).join(" ")).toContain("(h)");
  });
});
