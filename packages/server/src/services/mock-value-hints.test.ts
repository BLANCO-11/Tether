/**
 * I-230 / D-268 — value hints for draft-run mocks. The bounds are the point:
 * each exclusion has a firing case and a control, because a hint rule that
 * admits a name or an address is the D-54 line crossed by accident.
 */
import { describe, expect, it } from "vitest";
import {
  authoredLiteralsFromFlows,
  authoredLiteralsFromSql,
  dateRangeFor,
  hintFor,
  isDateRangeCandidate,
  withFallbackRange,
  MAX_CATEGORIES,
  mergeHints,
  domainCategories,
  dateRangeOf,
  isNumberRangeCandidate,
  MIN_RANGE_VALUES,
  numberRangeOf,
  readRangeHints,
} from "./mock-value-hints.js";
import { generateMockRows } from "./mock-dataset.service.js";
import type { SandboxColumn, SandboxShape, SandboxTable } from "./sandbox-ddl.service.js";

const col = (name: string, over: Partial<SandboxColumn> = {}): SandboxColumn => ({
  name, sqlType: "text", kind: "text", nullable: false, isPrimaryKey: false, references: null, maxLength: null, ...over,
});

describe("authored literals", () => {
  it("reads =, <>, IS DISTINCT FROM and IN lists from SQL", () => {
    const sql = `SELECT * FROM invoices i WHERE i.status IS DISTINCT FROM 'void' AND kind = 'std' AND region IN ('north', 'south') AND x <> 'it''s'`;
    expect(authoredLiteralsFromSql(sql)).toEqual(
      expect.arrayContaining([
        { column: "status", value: "void" },
        { column: "kind", value: "std" },
        { column: "region", value: "north" },
        { column: "region", value: "south" },
        { column: "x", value: "it's" },
      ]),
    );
  });
  it("NOT IN names the column, never the word NOT", () => {
    expect(authoredLiteralsFromSql("WHERE status NOT IN ('void', 'credit')").map((l) => l.column)).toEqual(["status", "status"]);
  });
  it("CONTROL: a parameter is not a literal", () => {
    expect(authoredLiteralsFromSql("SELECT 1 FROM t WHERE status = $1")).toEqual([]);
  });
  const ops = [{ ref: "hr_demo.staff_by_status", table: "employees", filters: [{ column: "status", param: "not_exited" }] }];
  it("maps a flow's literal binding onto the column the operation's filter tests (R08's case)", () => {
    const model = { steps: [{ id: "q", kind: "query", ref: "hr_demo.staff_by_status", inputs: [{ name: "not_exited", source: { from: "literal", value: "exited" } }] }] };
    expect(authoredLiteralsFromFlows([model], ops)).toEqual([{ table: "employees", column: "status", value: "exited" }]);
  });
  it("reads a legacy paramsExpr of plain strings too, but never a template", () => {
    const legacy = { steps: [{ ref: "hr_demo.staff_by_status", paramsExpr: '[{"not_exited":"exited"}]' }] };
    const templ = { steps: [{ ref: "hr_demo.staff_by_status", paramsExpr: '[{"not_exited":"{{ inputs.s }}"}]' }] };
    expect(authoredLiteralsFromFlows([legacy], ops)).toHaveLength(1);
    expect(authoredLiteralsFromFlows([templ], ops)).toEqual([]);
  });
  it("CONTROL: a step on another ref contributes nothing", () => {
    const other = { steps: [{ ref: "hr_demo.else", inputs: [{ name: "not_exited", source: { from: "literal", value: "x" } }] }] };
    expect(authoredLiteralsFromFlows([other], ops)).toEqual([]);
  });
});

describe("merge and use", () => {
  const table: SandboxTable = { schema: null, name: "employees", key: "employees", sourceKind: "table", columns: [col("id", { kind: "int", isPrimaryKey: true, sqlType: "int" }), col("status"), col("period", { maxLength: 7 })] };
  const shape: SandboxShape = { tables: [table], schemas: ["public"], fingerprint: "fp", unsupported: [], notes: [] };

  it("categories first, authored appended and deduped, provenance per source", () => {
    const h = mergeHints({ "employees.status": ["active", "exited"] }, [
      { table: "employees", column: "status", value: "exited" },
      { table: "employees", column: "status", value: "on_leave" },
      { table: null, column: "period", value: "2026-06" },
    ]);
    expect(h.byColumn["employees.status"]).toEqual(["active", "exited", "on_leave"]);
    expect(h.provenance["employees.status"]).toEqual({ categories: 2, authored: 1 });
    expect(hintFor(h, table, table.columns[2]!)).toEqual(["2026-06"]);
  });

  it("an empty authored literal (`col <> ''`) is not a hint", () => {
    expect(mergeHints({}, [{ table: null, column: "owner_email", value: "" }]).byColumn).toEqual({});
  });

  it("a hinted column cycles its values, so a filter on any one matches a row", () => {
    const rows = generateMockRows(shape, mergeHints({ "employees.status": ["active", "exited"] }, [{ table: null, column: "period", value: "2026-06" }])).employees!;
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["active", "exited"]));
    expect(rows.filter((r) => r.period === "2026-06").length).toBe(rows.length);
  });

  it("CONTROL: with no hints the rows are byte-identical to before (the RNG is still drawn)", () => {
    const shapeTwo: SandboxShape = { ...shape, tables: [{ ...table, columns: [...table.columns, col("other")] }] };
    const plain = generateMockRows(shapeTwo);
    const hinted = generateMockRows(shapeTwo, mergeHints({ "employees.status": ["active"] }, []));
    expect(hinted.employees!.map((r) => r.other)).toEqual(plain.employees!.map((r) => r.other));
    expect(plain.employees!.every((r) => String(r.status).startsWith("mock_status_"))).toBe(true);
  });
});

describe("date spans (D-268 option A, B as fallback)", () => {
  const dcol = (name: string, kind: "date" | "timestamp" = "date") => col(name, { kind, sqlType: kind });
  it("reads a date column's span, but never one named for a person or a birth", () => {
    expect(isDateRangeCandidate(dcol("due_date"))).toBe(true);
    expect(isDateRangeCandidate(dcol("created_at", "timestamp"))).toBe(true);
    for (const n of ["date_of_birth", "dob", "birth_date", "employee_start", "candidateCreatedAt"])
      expect(isDateRangeCandidate(dcol(n)), n).toBe(false);
    // a date KEY is read (its span is a day range, not a person); a date that REFERENCES another table is not
    expect(isDateRangeCandidate({ ...dcol("work_date"), isPrimaryKey: true })).toBe(true);
    expect(isDateRangeCandidate({ ...dcol("due_date"), references: "cal.day" } as never)).toBe(false);
  });
  const table: SandboxTable = { schema: null, name: "invoices", key: "invoices", sourceKind: "table", columns: [
    col("id", { kind: "int", isPrimaryKey: true, sqlType: "int" }), dcol("due_date"), dcol("paid_at", "timestamp"), col("contact_email"),
  ] };
  const shape: SandboxShape = { tables: [table], schemas: ["public"], fingerprint: "fp", unsupported: [], notes: [] };

  it("spreads mock dates across the real span, both ends included", () => {
    const hints = withFallbackRange({ byColumn: {}, provenance: {}, notes: [], dateRanges: { "invoices.due_date": { min: "2026-04-01", max: "2026-06-30" } } }, new Date("2026-09-24"));
    const rows = generateMockRows(shape, hints).invoices!;
    const due = rows.map((r) => String(r.due_date)).filter((d) => d !== "null");
    expect(due.every((d) => d >= "2026-04-01" && d <= "2026-06-30")).toBe(true);
    expect(due).toContain("2026-04-01");
    expect(due.some((d) => d.startsWith("2026-06"))).toBe(true);
  });
  it("B: a column with no span of its own takes the datasource's union", () => {
    const hints = withFallbackRange({ byColumn: {}, provenance: {}, notes: [], dateRanges: { "invoices.due_date": { min: "2026-04-01", max: "2026-06-30" } } }, new Date("2026-09-24"));
    expect(dateRangeFor(hints, table, table.columns[2]!)).toEqual({ min: "2026-04-01", max: "2026-06-30" });
  });
  it("B: nothing read at all → the 90 days to today", () => {
    expect(withFallbackRange({ byColumn: {}, provenance: {}, notes: [] }, new Date("2026-09-24T10:00:00Z")).fallbackRange).toEqual({ min: "2026-06-26", max: "2026-09-24" });
  });
  it("an address-named column is a reserved-domain address, not mock_…", () => {
    const rows = generateMockRows(shape).invoices!;
    expect(rows.map((r) => r.contact_email).every((v) => /^contact_email_\d+@mock\.example$/.test(String(v)))).toBe(true);
  });
  it("CONTROL: with no hints, dates keep the old deterministic 2024 anchor", () => {
    expect(String(generateMockRows(shape).invoices![0]!.due_date)).toMatch(/^2024-01/);
  });
});

describe("hinted columns do not move in lockstep (r6)", () => {
  it("two 3-value columns joined through the same row index still produce every combination somewhere", () => {
    const emp: SandboxTable = { schema: null, name: "employees", key: "employees", sourceKind: "table", columns: [col("id", { kind: "int", isPrimaryKey: true, sqlType: "int" }), col("status")] };
    const att: SandboxTable = { schema: null, name: "attendance_monthly", key: "attendance_monthly", sourceKind: "table", columns: [col("id", { kind: "int", isPrimaryKey: true, sqlType: "int" }), col("employee_id", { kind: "int", sqlType: "int", references: "employees.id" }), col("period")] };
    const shape: SandboxShape = { tables: [emp, att], schemas: ["public"], fingerprint: "fp", unsupported: [], notes: [] };
    const hints = mergeHints({ "employees.status": ["active", "exited", "on_leave"], "attendance_monthly.period": ["2026-04", "2026-05", "2026-06"] }, []);
    const rows = generateMockRows(shape, hints);
    const statusOf = new Map(rows.employees!.map((e) => [e.id, e.status]));
    const combos = new Set(rows.attendance_monthly!.map((a) => `${a.period}/${statusOf.get(a.employee_id)}`));
    expect(combos.has("2026-06/active")).toBe(true);
    expect(new Set(rows.employees!.map((e) => e.status))).toEqual(new Set(["active", "exited", "on_leave"]));
  });
});

describe("the values the schema already knows are a mock's categories (2026-10-02, H02)", () => {
  const table: SandboxTable = { schema: "main", name: "v_absence", key: "v_absence", sourceKind: "view", columns: [col("absence_type"), col("full_name"), col("code", { isPrimaryKey: true }), col("days", { kind: "int", sqlType: "integer" })] };
  const shape = { tables: [table] } as unknown as SandboxShape;
  const known = [
    { entityName: "v_absence", entitySchema: "main", columnName: "absence_type", valueDomain: { values: ["Annual Leave", "Sick Leave"] } },
    { entityName: "v_absence", entitySchema: "main", columnName: "full_name", valueDomain: { values: ["A B", "C D"] } },
    { entityName: "v_absence", entitySchema: "main", columnName: "code", valueDomain: { values: ["x"] } },
  ];
  it("a text column takes its known values — whatever its name, on any engine — and the generated rows hold them", () => {
    const cats = domainCategories(shape, known);
    expect(cats).toEqual({ "v_absence.absence_type": ["Annual Leave", "Sick Leave"] });
    const rows = generateMockRows(shape, mergeHints(cats, []));
    const held = new Set((Object.values(rows)[0] as Array<Record<string, unknown>>).map((r) => r.absence_type));
    expect(held.has("Sick Leave")).toBe(true);
  });
  it("CONTROL: an identifying column, a key, and a column with no known values take nothing; too many values take nothing", () => {
    expect(domainCategories(shape, known)["v_absence.full_name"]).toBeUndefined();
    expect(domainCategories(shape, known)["v_absence.code"]).toBeUndefined();
    const many = [{ entityName: "v_absence", entitySchema: "main", columnName: "absence_type", valueDomain: { values: Array.from({ length: MAX_CATEGORIES + 1 }, (_, i) => `v${i}`) } }];
    expect(domainCategories(shape, many)).toEqual({});
  });
});

describe("number and date spans from the real data — summaries only (2026-10-10)", () => {
  const ncol = (name: string, kind: "int" | "decimal" = "decimal", over: Partial<SandboxColumn> = {}) => col(name, { kind, sqlType: kind === "int" ? "int" : "real", ...over });

  it("a number span is the 5th–95th percentile, rounded OUTWARD to two significant figures — no real value is carried", () => {
    // 100 values 0.5 … 50 plus two outliers; the outliers must not set the span
    const values = [...Array.from({ length: 100 }, (_, i) => (i + 1) / 2), 9999, -50];
    const r = numberRangeOf(values)!;
    expect(r.min).toBeLessThanOrEqual(2.5);
    expect(r.max).toBeGreaterThanOrEqual(47.5);
    expect(r.max).toBeLessThan(9999);
    expect(r.integer).toBe(false);
    expect(numberRangeOf([1471.37, ...Array(30).fill(2000), 6116.52])).toEqual({ min: 2000, max: 2000, integer: false });
    expect(numberRangeOf([...Array(20).fill(8.0333)])).toEqual({ min: 8, max: 8.1, integer: false });
  });

  it("fewer than MIN_RANGE_VALUES values is a handful of real values, not a spread — no span", () => {
    expect(numberRangeOf(Array.from({ length: MIN_RANGE_VALUES - 1 }, (_, i) => i))).toBeNull();
    // control: at the bound it is a span
    expect(numberRangeOf(Array.from({ length: MIN_RANGE_VALUES }, (_, i) => i))).not.toBeNull();
  });

  it("a date span reads Date objects (Postgres) and ISO text (SQLite) alike, to the day", () => {
    expect(dateRangeOf([new Date("2026-08-31T10:00:00Z"), "2026-08-01", "2026-08-15 09:00:00", "not a date", null])).toEqual({ min: "2026-08-01", max: "2026-08-31" });
    expect(dateRangeOf(["x"])).toBeNull();
  });

  it("keys, references and number columns named for a person or an identifier are never summarised", () => {
    expect(isNumberRangeCandidate(ncol("hours_worked"))).toBe(true);
    expect(isNumberRangeCandidate(ncol("al_balance"))).toBe(true);
    for (const c of [ncol("id", "int", { isPrimaryKey: true }), ncol("dept_id", "int", { references: { table: "d", column: "id" } } as never), ncol("employee_number", "int"), ncol("phone", "int")])
      expect(isNumberRangeCandidate(c), c.name).toBe(false);
  });

  it("reads every candidate through ONE sampler, and only summaries come out; a column that fails is a note", async () => {
    const t: SandboxTable = { schema: "main", name: "attendance_day", key: "main.attendance_day", sourceKind: "table", columns: [
      col("emp_id", { isPrimaryKey: true }), ncol("hours_worked"), col("work_date", { kind: "date", sqlType: "date" }), ncol("broken"),
    ] };
    const shape: SandboxShape = { tables: [t], schemas: ["main"], fingerprint: "fp", unsupported: [], notes: [] };
    const asked: string[] = [];
    const r = await readRangeHints(shape, async (_t, c) => {
      asked.push(c.name);
      if (c.name === "broken") throw new Error("no such column");
      return c.name === "work_date" ? ["2026-08-01", "2026-08-31"] : Array.from({ length: 40 }, (_, i) => 6 + (i % 5));
    });
    expect(asked).toEqual(["hours_worked", "work_date", "broken"]);
    expect(r.dateRanges).toEqual({ "attendance_day.work_date": { min: "2026-08-01", max: "2026-08-31" } });
    expect(r.numberRanges["attendance_day.hours_worked"]).toEqual({ min: 6, max: 10, integer: true });
    expect(r.notes.some((n) => n.includes("broken") && n.includes("no such column"))).toBe(true);
  });

  it("generated numbers fall inside the span; CONTROL: without one they are the old random 1,000–91,000", () => {
    const t: SandboxTable = { schema: null, name: "attendance_day", key: "attendance_day", sourceKind: "table", columns: [ncol("hours_worked")] };
    const shape: SandboxShape = { tables: [t], schemas: ["public"], fingerprint: "fp", unsupported: [], notes: [] };
    const hinted = generateMockRows(shape, { byColumn: {}, provenance: {}, notes: [], numberRanges: { "attendance_day.hours_worked": { min: 6, max: 10, integer: false } } }).attendance_day!;
    expect(hinted.every((r) => (r.hours_worked as number) >= 6 && (r.hours_worked as number) <= 10)).toBe(true);
    const plain = generateMockRows(shape).attendance_day!;
    expect(plain.some((r) => (r.hours_worked as number) > 100)).toBe(true);
  });
});

describe("a date KEY stays distinct inside the real span (2026-10-10)", () => {
  it("spreads one distinct day per row when the span holds them, and runs consecutively when it cannot", async () => {
    const { distinctDayIn } = await import("./mock-dataset.service.js");
    const wide = Array.from({ length: 10 }, (_, i) => distinctDayIn({ min: "2026-08-01", max: "2026-08-31" }, i));
    expect(new Set(wide).size).toBe(10);
    expect(wide.every((d) => d >= "2026-08-01" && d <= "2026-08-31")).toBe(true);
    const narrow = Array.from({ length: 10 }, (_, i) => distinctDayIn({ min: "2026-08-01", max: "2026-08-03" }, i));
    expect(new Set(narrow).size).toBe(10);
  });

  it("a keyed date column takes the span in generated rows; CONTROL: without one it keeps the 2024 anchor", () => {
    const t: SandboxTable = { schema: null, name: "attendance_day", key: "attendance_day", sourceKind: "table", columns: [
      col("work_date", { kind: "date", sqlType: "date", isPrimaryKey: true }),
    ] };
    const shape: SandboxShape = { tables: [t], schemas: ["public"], fingerprint: "fp", unsupported: [], notes: [] };
    const rows = generateMockRows(shape, { byColumn: {}, provenance: {}, notes: [], dateRanges: { "attendance_day.work_date": { min: "2026-08-01", max: "2026-08-31" } } }).attendance_day!;
    expect(rows.every((r) => String(r.work_date).startsWith("2026-08"))).toBe(true);
    expect(String(generateMockRows(shape).attendance_day![0]!.work_date)).toMatch(/^2024-01/);
  });
});
