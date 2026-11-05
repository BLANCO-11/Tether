/** Tables against a workspace File cannot match on invented test rows (chat eb205c03); tables alone can. */
import { describe, expect, it } from "vitest";
import { allowedEmptyOutputs, emptyReadsOf, filesBesideTables, inconclusiveSummary, largeTablesRead, realDataVerdict, type TableSize } from "./test-data-kind.js";

describe("a workflow comparing tables with a File", () => {
  it("names the Files read beside a table, inside a loop too", () => {
    const wf = {
      steps: [
        { id: "att", entry: "a.py", uses: ["read:attendance"] },
        { id: "each", foreach: "att.rows", steps: [{ id: "hc", entry: "h.py", uses: ["file:Headcount.xlsx", "file:Headcount.xlsx"] }] },
      ],
    };
    expect(filesBesideTables(wf)).toEqual(["Headcount.xlsx"]);
  });

  it("CONTROL: tables alone, or a File alone, is not that case", () => {
    expect(filesBesideTables({ steps: [{ id: "a", entry: "a.py", uses: ["read:attendance", "tool:foundry_email_send"] }] })).toEqual([]);
    expect(filesBesideTables({ steps: [{ id: "a", entry: "a.py", uses: ["file:Rates.xlsx"] }] })).toEqual([]);
    expect(filesBesideTables(null)).toEqual([]);
  });
});

describe("inconclusiveSummary", () => {
  it("names one File in the sentence", () => {
    expect(inconclusiveSummary(["Headcount.xlsx"])).toBe(
      'Inconclusive on test data: this workflow compares its tables with "Headcount.xlsx", which invented test rows cannot match. Test it on real data.',
    );
  });

  it("quotes and comma-joins two Files", () => {
    expect(inconclusiveSummary(["Headcount.xlsx", "Rates.xlsx"])).toBe(
      'Inconclusive on test data: this workflow compares its tables with "Headcount.xlsx", "Rates.xlsx", which invented test rows cannot match. Test it on real data.',
    );
  });
});

describe("largeTablesRead", () => {
  const TABLES: TableSize[] = [
    { datasource: "HR", name: "attendance_day", rows: 108190 },
    { datasource: "HR", name: "leave", rows: 80000 },
    { datasource: "HR", name: "employee", rows: 900 },
    { datasource: "HR", name: "audit", rows: null },
    { datasource: "Fin", name: "ledger", rows: 500000 },
  ];

  it("counts a FROM on a schema-qualified big table, and skips a small one", () => {
    const reads = { a: { datasource: "HR", sql: "SELECT * FROM hr.attendance_day a JOIN employee e ON e.id=a.emp" } };
    expect(largeTablesRead(reads, TABLES)).toEqual([{ name: "attendance_day", rows: 108190 }]);
  });

  it("counts a JOIN in upper case", () => {
    const reads = { a: { datasource: "HR", sql: "select 1 from employee join LEAVE l on true" } };
    expect(largeTablesRead(reads, TABLES)).toEqual([{ name: "leave", rows: 80000 }]);
  });

  it("does not match a name that is only a substring", () => {
    const reads = { a: { datasource: "HR", sql: "select * from leave_type join annual_leave_x on true" } };
    expect(largeTablesRead(reads, TABLES)).toEqual([]);
  });

  it("ignores a table that belongs to another datasource", () => {
    const reads = { a: { datasource: "HR", sql: "select * from ledger" } };
    expect(largeTablesRead(reads, TABLES)).toEqual([]);
  });

  it("ignores a table with null rows", () => {
    const reads = { a: { datasource: "HR", sql: "select * from audit" } };
    expect(largeTablesRead(reads, TABLES)).toEqual([]);
  });

  it("dedupes by name and sorts largest first", () => {
    const reads = {
      a: { datasource: "HR", sql: "select * from leave join attendance_day on true" },
      b: { datasource: "HR", sql: "select * from attendance_day" },
    };
    expect(largeTablesRead(reads, TABLES)).toEqual([
      { name: "attendance_day", rows: 108190 },
      { name: "leave", rows: 80000 },
    ]);
  });

  it("returns [] when reads is null or not a plain object", () => {
    expect(largeTablesRead(null, TABLES)).toEqual([]);
    expect(largeTablesRead("select * from leave", TABLES)).toEqual([]);
    expect(largeTablesRead([{ datasource: "HR", sql: "select * from leave" }], TABLES)).toEqual([]);
  });
});

describe("emptyReadsOf", () => {
  const ERR =
    'step load returned empty data: "rows" came back with nothing in it. Its data was empty before the step did anything (0 row(s) from read monthly_hours): the read found nothing for these values.';

  it("picks the 0-row read from a failed step", () => {
    expect(emptyReadsOf([{ status: "failed", error: ERR }])).toEqual(["monthly_hours"]);
  });

  it("ignores a read that returned 12 rows", () => {
    expect(emptyReadsOf([{ status: "failed", error: ERR.replace("0 row(s)", "12 row(s)") }])).toEqual([]);
  });

  it("ignores succeeded steps and null errors", () => {
    expect(emptyReadsOf([{ status: "succeeded", error: ERR }, { status: "failed", error: null }])).toEqual([]);
  });

  it("dedupes across two failed steps", () => {
    expect(emptyReadsOf([{ status: "failed", error: ERR }, { status: "failed", error: ERR }])).toEqual(["monthly_hours"]);
  });

  it("keeps no dot when the name is followed by a period", () => {
    expect(emptyReadsOf([{ status: "failed", error: "Nothing (0 row(s) from read hours). Done" }])).toEqual(["hours"]);
    expect(emptyReadsOf([{ status: "failed", error: "Nothing was in 0 row(s) from read hours." }])).toEqual(["hours"]);
  });
});

describe("realDataVerdict", () => {
  const base = { realData: false, emptyData: true, emptyReads: ["monthly_hours"], files: [] as string[], inputs: { year: 2026, month: 10 } };

  it("says there are no rows for these values", () => {
    expect(realDataVerdict(base)).toEqual({
      kind: "no-rows",
      summary:
        "The test data has no rows from monthly_hours for year = 2026, month = 10. Test data is invented and only covers some dates and values, so this test cannot judge the workflow. Run the test on real data (an admin can start it).",
    });
  });

  it("leaves out the for clause when there are no inputs", () => {
    expect(realDataVerdict({ ...base, inputs: {} })?.summary).toMatch(/^The test data has no rows from monthly_hours\. Test data is invented/);
  });

  it("gives the files verdict when only files are beside the tables", () => {
    expect(realDataVerdict({ ...base, emptyReads: [], files: ["Headcount.xlsx"] })).toEqual({
      kind: "files",
      summary: inconclusiveSummary(["Headcount.xlsx"]),
    });
  });

  it("gives null on real data, when not empty, or with no reads and no files", () => {
    expect(realDataVerdict({ ...base, realData: true })).toBeNull();
    expect(realDataVerdict({ ...base, emptyData: false })).toBeNull();
    expect(realDataVerdict({ ...base, emptyReads: [] })).toBeNull();
  });

  it("no-rows wins over files", () => {
    expect(realDataVerdict({ ...base, files: ["Headcount.xlsx"] })?.kind).toBe("no-rows");
  });
});

describe("allowed-empty outputs on invented data", () => {
  const wf = {
    steps: [
      { id: "match", entry: "m.py", uses: ["read:t", "file:F.xlsx"], allow_empty: [{ output: "file", reason: "none" }, { output: "rows", reason: "x" }] },
      { id: "other", entry: "o.py", allow_empty: [{ output: "file", reason: "x" }] },
      { id: "plain", entry: "p.py" },
    ],
  };
  it("finds an allowed output that came back empty, ignoring non-empty, undeclared and failed", () => {
    const steps = [
      { stepId: "match", status: "succeeded", outputJson: { file: "", rows: [1], other: "" } },
      { stepId: "other", status: "failed", outputJson: { file: "" } },
      { stepId: "plain", status: "succeeded", outputJson: { file: "" } },
    ];
    expect(allowedEmptyOutputs(wf, steps)).toEqual(["match.file"]);
  });

  it("ignores a loop item's row — only the workflow-level result counts", () => {
    const steps = [{ stepId: "match", status: "succeeded", outputJson: { file: "" }, scope: "0" }];
    expect(allowedEmptyOutputs(wf, steps)).toEqual([]);
  });

  it("makes the files verdict through realDataVerdict", () => {
    const emptyData = allowedEmptyOutputs(wf, [{ stepId: "match", status: "succeeded", outputJson: { file: "" } }]).length > 0;
    const v = realDataVerdict({ realData: false, emptyData, emptyReads: [], files: filesBesideTables(wf), inputs: {} });
    expect(v?.kind).toBe("files");
  });
});
