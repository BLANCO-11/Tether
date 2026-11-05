/**
 * The read writer's third answer (2026-10-01): a read AND what it interpreted (`assumed`) or could not give (`leftOut`), passed on
 * as the proposer gave them — one question to the proposer, never a second one. A refusal means nothing of the need is there.
 */
import { describe, expect, it, vi } from "vitest";
import type { SchemaRow } from "../../repositories/schema.repo.js";

const calls: string[] = [];
const revised: unknown[] = [];
let reply: unknown;
let accepted: ((spec: unknown, said?: { values: Array<{ param: string; words: string }> }) => Promise<string[]> | string[]) | undefined;
vi.mock("../db-operation-proposal.service.js", () => ({ proposeOperation: vi.fn(async ({ need, revise, accept }: { need: string; revise?: unknown; accept?: (spec: unknown, said?: { values: Array<{ param: string; words: string }> }) => string[] }) => { calls.push(need); revised.push(revise); accepted = accept; return reply; }) }));
let dsType = "postgres";
vi.mock("../../repositories/datasource.repo.js", () => ({ datasourceRepo: { listByWorkspace: async () => [{ id: "d1", name: "ds", type: dsType }] } }));
const col = (columnName: string, columnType: string): SchemaRow => ({
  id: `s-${columnName}`, datasourceId: "d1", entityType: "table", entitySchema: "public", entityName: "t1", columnName, columnType,
  isPrimaryKey: false, isForeignKey: false, foreignKeyReference: null, nullable: false, characterMaximumLength: null,
  semanticTag: null, valueDomain: null, rowCountEstimate: null, nullPercentage: null, extractedAt: new Date("2026-09-27T00:00:00Z"),
});
vi.mock("../../repositories/schema.repo.js", () => ({ schemaRepo: { listByDatasource: async () => [col("id", "integer"), col("name", "text"), { ...col("contact", "text"), semanticTag: "email" }, col("joined", "date"), col("left_on", "date")] } }));

const { readWriter } = await import("./builder.service.js");
const SPEC = { base: { table: "t1" }, columns: [{ column: "name", alias: "name" }], joins: [], filters: [], having: [], aggregateJoins: [], sort: [], limit: 100 };

describe("the read writer passes the proposer's third answer through", () => {
  it("a read with what it assumed and left out — one question to the proposer", async () => {
    calls.length = 0;
    reply = { status: "ok", name: "people", spec: SPEC, assumed: [{ words: "deductions", as: "annual leave days" }], leftOut: [{ words: "bonus", why: "no column" }] };
    const r = await readWriter("ws")("ds", "names, deductions and bonus", []);
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ reader: { ref: "ds.query.people" }, assumed: [{ words: "deductions" }], leftOut: [{ words: "bonus" }] });
  });
  it("a REVISION hands the proposer the read as it stands and keeps its name — whatever the proposer calls it", async () => {
    revised.length = 0;
    reply = { status: "ok", name: "people_v2", spec: SPEC, assumed: [], leftOut: [] };
    const prior = { ref: "ds.query.people", datasource: "ds", name: "people", spec: { ...SPEC, limit: 50 } as never };
    const r = await readWriter("ws")("ds", "names, each day they were present", ["ds.query.people"], [], prior);
    expect(revised).toEqual([{ name: "people", spec: prior.spec }]);
    expect(r).toMatchObject({ reader: { ref: "ds.query.people", name: "people" } });
    // CONTROL: a first write is handed nothing to revise, takes the proposer's name, and steps past a taken one.
    revised.length = 0;
    const fresh = await readWriter("ws")("ds", "names", ["ds.query.people_v2"]);
    expect(revised).toEqual([undefined]);
    expect(fresh).toMatchObject({ reader: { ref: "ds.query.people_v2_2" } });
  });
  it("CONTROL: a refusal is stated as it came — no second question", async () => {
    calls.length = 0;
    reply = { status: "insufficient_schema", missing: ["a deductions column"], reason: "no column holds a deduction" };
    const r = await readWriter("ws")("ds", "only deductions", []);
    expect(calls).toHaveLength(1);
    expect(r).toEqual({ refused: "ds cannot give this: no column holds a deduction (not there: a deductions column)" });
  });
});

describe("a person is never asked for a reference table's code", async () => {
  const { keyParams } = await import("./builder.service.js");
  const R = [
    { entityName: "absence", columnName: "absence_type_id", columnType: "integer", isForeignKey: true, foreignKeyReference: "absence_type.absence_type_id" },
    { entityName: "absence", columnName: "employee_id", columnType: "text", isForeignKey: true, foreignKeyReference: "employee.employee_id" },
    { entityName: "absence_type", columnName: null, rowCountEstimate: 14 },
    { entityName: "absence_type", columnName: "absence_type_id", columnType: "integer" },
    { entityName: "absence_type", columnName: "name", columnType: "text" },
    { entityName: "employee", columnName: null, rowCountEstimate: 6800 },
    { entityName: "employee", columnName: "name", columnType: "text" },
  ];
  const at = (column: string) => ({ schema: "main", table: "absence", column });
  it("a code into a small list of kinds is refused, naming the table and its text to filter on", () => {
    expect(keyParams({ leave_type_id: at("absence_type_id") }, R)).toEqual([
      "parameter `leave_type_id` compares absence.absence_type_id, a code from the reference table absence_type — a person names one of its rows, never its code. Join absence_type and filter on its text (name) instead",
    ]);
  });
  it("CONTROL: a key into a large table (an employee) stays — a person can know that number; a plain column stays", () => {
    expect(keyParams({ employee: at("employee_id") }, R)).toEqual([]);
    expect(keyParams({ name: { schema: "main", table: "absence_type", column: "name" } }, R)).toEqual([]);
  });
});

describe("a number the person STATED is never fixed into a read (2026-10-01)", async () => {
  const { statedNumbers, statedConstantFindings } = await import("./builder.service.js");
  const GOAL = ["employees below 85 percent attendance for 1 August to 14 August 2026; 9.5+ hours is a full day, 0 hours is leave"];
  it("the person's quantities, without the dates they named", () => {
    expect([...statedNumbers(GOAL)].sort((a, b) => a - b)).toEqual([9.5, 85]);
  });
  it("a stated number written as a constant is refused, naming it; a number the rule needs is not", () => {
    const spec = { filters: [{ column: "pct", op: "lt", value: 85 }], aggregateJoins: [{ filters: [{ column: "hours", op: "eq", value: 0 }, { column: "flag", op: "eq", value: 1 }] }], columns: [{ compute: { percent: { part: { column: "a" }, whole: { column: "b" } } } }] };
    const f = statedConstantFindings(spec, GOAL);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/the number 85 is one the person STATED/);
    // CONTROL: 0 and 1 are what "none" and a flag are; 14 and 2026 were a date, not a quantity.
    expect(statedConstantFindings({ filters: [{ value: 0 }, { value: 1 }, { value: 14 }, { value: 2026 }] }, GOAL)).toEqual([]);
  });
});

describe("a fixed TEXT value is only the person's own words (P2-I4)", async () => {
  const { unstatedTextFindings } = await import("./builder.service.js");
  const GOAL = ["list the active employees on sick leave this month"];
  it("their words, any case, as whole words, are admitted; text they never said is refused by name", () => {
    expect(unstatedTextFindings({ filters: [{ value: "Active" }], aggregateJoins: [{ filters: [{ value: "Sick Leave" }] }] }, GOAL)).toEqual([]);
    const f = unstatedTextFindings({ filters: [{ value: "Terminated" }, { value: "Inactive" }] }, GOAL);
    expect(f.join("\n")).toMatch(/“Terminated” is not the person's words/);
    // “inactive” is not “active”: the match is on whole words.
    expect(f.join("\n")).toMatch(/“Inactive” is not the person's words/);
    // …and a word they said in another inflection is still theirs (builder-behaviour E03: “interns” admits `'Intern'`).
    expect(unstatedTextFindings({ filters: [{ value: "Intern" }] }, ["list the active interns with their department"])).toEqual([]);
    expect(unstatedTextFindings({ filters: [{ value: "Contractor" }] }, ["list the active interns with their department"]).join("\n")).toMatch(/“Contractor” is not the person's words/);
    // An address the person gave is who receives, never a filter on the rows — even when it is their own words.
    expect(unstatedTextFindings({ filters: [{ value: "a.person@acme.example" }] }, ["send it to a.person@acme.example"]).join("\n")).toMatch(/is an address — who receives/);
    // CONTROL: numbers and true/false are not text, and are left to their own rules.
    expect(unstatedTextFindings({ filters: [{ value: 3 }, { value: true }] }, GOAL)).toEqual([]);
  });
});

describe("the read writer holds every proposal to the stated-number rule", () => {
  it("its `accept` refuses a stated number fixed as a constant — the check is CALLED, not merely correct", async () => {
    reply = { status: "ok", name: "people", spec: SPEC, assumed: [], leftOut: [] };
    await readWriter("ws")("ds", "names below 85", [], ["names with a score below 85"]);
    const withConstant = { ...SPEC, filters: [{ column: "id", op: "lt", value: 85 }] };
    expect((await accepted!(withConstant)).join(" ")).toMatch(/the number 85 is one the person STATED/);
    // CONTROL: the same read with the number as a parameter is accepted by this rule.
    expect((await accepted!({ ...SPEC, filters: [{ column: "id", op: "lt", param: "max_score" }] }, { values: [{ param: "max_score", words: "below 85" }] })).join(" ")).not.toMatch(/STATED/);
  });
  it("its `accept` refuses text the person never said, with or without a contract — the check is CALLED (P2-I4)", async () => {
    reply = { status: "ok", name: "people", spec: SPEC, assumed: [], leftOut: [] };
    await readWriter("ws")("ds", "active names", [], ["the active names"], undefined, { params: [], words: [] });
    expect((await accepted!({ ...SPEC, filters: [{ column: "name", op: "eq", value: "Retired" }] })).join(" ")).toMatch(/“Retired” is not the person's words/);
    // CONTROL: their own word is accepted by this rule.
    expect((await accepted!({ ...SPEC, filters: [{ column: "name", op: "eq", value: "Active" }] })).join(" ")).not.toMatch(/person's words/);
  });
  it("with a CONTRACT, the contract is the one authority: a stated number it names no parameter for may be fixed (2026-10-02, H06)", async () => {
    reply = { status: "ok", name: "people", spec: SPEC, assumed: [], leftOut: [] };
    await readWriter("ws")("ds", "names below 85", [], ["names with a score below 85"], undefined, { params: [], words: [] });
    expect((await accepted!({ ...SPEC, filters: [{ column: "id", op: "lt", value: 85 }] })).join(" ")).not.toMatch(/STATED/);
    // CONTROL: when the contract DOES name it, fixing it instead is refused — as the contract's parameter left unused.
    await readWriter("ws")("ds", "names below 85", [], ["names with a score below 85"], undefined, { params: [{ name: "threshold", type: "number", words: "below 85", value: 0 }], words: [] });
    expect((await accepted!({ ...SPEC, filters: [{ column: "id", op: "lt", value: 85 }] })).join(" ")).toMatch(/"threshold".*is not used/);
  });
  it("a parameter the CONTRACT does not name is refused — a number nobody stated is a question nobody should be asked (phase 1)", async () => {
    reply = { status: "ok", name: "people", spec: SPEC, assumed: [], leftOut: [] };
    await readWriter("ws")("ds", "names over budget", [], ["names that are over budget"], undefined, { params: [], words: [] });
    const invented = { ...SPEC, filters: [{ column: "id", op: "gt", param: "overage_threshold" }] };
    expect((await accepted!(invented)).join(" ")).toMatch(/"overage_threshold" is not a parameter of the contract/);
    // CONTROL: the parameter the contract names for the person's stated number is accepted.
    await readWriter("ws")("ds", "names over 10", [], ["names with an id over 10"], undefined, { params: [{ name: "threshold", type: "number", words: "over 10", value: 0 }], words: [] });
    expect((await accepted!({ ...SPEC, filters: [{ column: "id", op: "gt", param: "threshold" }] })).join(" ")).not.toMatch(/contract/);
  });
});

describe("a goal that sends to the people each row is about needs their address IN the row (2026-10-01, H06)", () => {
  it("its `accept` refuses a read with no address column, judged on the types", async () => {
    reply = { status: "ok", name: "people", spec: SPEC, assumed: [], leftOut: [] };
    await readWriter("ws")("ds", "names, emailed to their managers", [], ["email their managers"], undefined, { params: [], address: "their managers", words: [] });
    expect((await accepted!(SPEC)).join(" ")).toMatch(/sends to “their managers”.*no column of this read is an address/);
    // CONTROL: the same read carrying the email-tagged column passes this rule.
    expect((await accepted!({ ...SPEC, columns: [...SPEC.columns, { column: "contact", alias: "manager_email" }] })).join(" ")).not.toMatch(/is an address/);
  });
  it("CONTROL: a goal that sends to nobody in the rows asks for no address", async () => {
    await readWriter("ws")("ds", "names", [], ["names"]);
    expect((await accepted!(SPEC)).join(" ")).not.toMatch(/is an address/);
  });
  it("`peopleInRows` is a recipient whose words are not an address — never “me”, never a stated address", async () => {
    const { peopleInRows } = await import("./builder.service.js");
    const v = (quote: string, from: "goal" | "requester") => ({ sources: [], sinks: [], values: [{ role: "recipient" as const, from, quote, fills: "none" }], conditions: [], schedule: null, missing: null });
    expect(peopleInRows(v("their project managers", "goal"))).toBe("their project managers");
    expect(peopleInRows(v("me", "requester"))).toBeUndefined();
    expect(peopleInRows(v("ops@x.com", "goal"))).toBeUndefined();
  });
  it("…and never people the plan said NO data holds (`field: none` — \"a ticket for HR\"): their address is not the read's to carry (2026-10-04)", async () => {
    const { peopleInRows } = await import("./builder.service.js");
    const v = (field?: string) => ({ sources: [], sinks: [], values: [{ role: "recipient" as const, from: "goal" as const, quote: "the desk", fills: "t.to", ...(field ? { field } : {}) }], conditions: [], schedule: null, missing: null });
    expect(peopleInRows(v("none"))).toBeUndefined();
    // CONTROL: people the rows DO hold (a named field, or a new read's) still require the address in the read.
    expect(peopleInRows(v("new_read"))).toBe("the desk");
    expect(peopleInRows(v("owner_email"))).toBe("the desk");
    expect(peopleInRows(v())).toBe("the desk");
  });
});

describe("a read must run on its OWN engine (2026-10-01, H10)", () => {
  const CAST = { ...SPEC, columns: [...SPEC.columns, { compute: { diffDays: { start: { column: "joined" }, end: { column: "left_on" } } }, alias: "tenure_days" }] };
  // 2026-10-04: "days between" WAS this test's example of a construct SQLite cannot run — because the compiler wrote it in Postgres
  // for every engine, so no read using it could ever be written for SQLite. It is compiled for the read's own engine now.
  const BUSINESS = { ...SPEC, columns: [...SPEC.columns, { compute: { businessMinutes: { start: { column: "joined" }, end: { column: "left_on" } } }, alias: "bm" }] };
  it("on SQLite, days between is written for SQLite and accepted; a construct SQLite cannot run is refused, naming it", async () => {
    dsType = "sqlite";
    reply = { status: "ok", name: "people", spec: SPEC, assumed: [], leftOut: [] };
    await readWriter("ws")("ds", "names and tenure", [], ["names and tenure"]);
    expect((await accepted!(CAST)).join(" ")).not.toMatch(/Postgres cast|this datasource is SQLite/);
    expect((await accepted!(BUSINESS)).join(" ")).toMatch(/businessMinutes.*SQLite/);
    // CONTROL: the plain read runs on SQLite, and passes this rule.
    expect((await accepted!(SPEC)).join(" ")).not.toMatch(/this datasource is SQLite/);
  });
  it("CONTROL: on Postgres the same proposal is the engine's own SQL", async () => {
    dsType = "postgres";
    await readWriter("ws")("ds", "names and tenure", [], ["names and tenure"]);
    expect((await accepted!(CAST)).join(" ")).not.toMatch(/this datasource is SQLite/);
  });
});

