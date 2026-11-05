import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("attendance migration (B-17 idx 53)", () => {
  const sqlPath = join(process.cwd(), "drizzle/0053_attendance_b17.sql");
  const journalPath = join(process.cwd(), "drizzle/meta/_journal.json");

  it("migration file exists at idx 53", () => {
    expect(existsSync(sqlPath)).toBe(true);
  });

  it("defines attendance_daily with required columns and PK", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toContain("attendance_daily");
    expect(sql).toContain("workspace_id");
    expect(sql).toContain("subject");
    expect(sql).toContain("date");
    expect(sql).toContain("hours_in_office");
    expect(sql).toContain("source");
    expect(sql).toContain("PRIMARY KEY");
    expect(sql).toContain('REFERENCES "workspaces"');
    expect(sql).toContain("ON DELETE CASCADE");
  });

  it("defines attendance_compliance with required columns", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toContain("attendance_compliance");
    expect(sql).toContain("period");
    expect(sql).toContain("days_in_office");
    expect(sql).toContain("required_days");
    expect(sql).toContain("avg_hours");
    expect(sql).toContain("last_calculated_at");
    expect(sql).toContain("next_calculation_at");
    expect(sql).toContain("compliant");
    expect(sql).toContain("history");
    expect(sql).toContain("interval");
  });

  it("creates required indexes", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toContain("idx_attendance_daily_workspace_subject");
    expect(sql).toContain("idx_attendance_compliance_workspace_subject");
  });

  it("journal contains 0053_attendance_b17 at idx 53 and 0052 for B-18", () => {
    const j = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const tags = j.entries.map((e) => e.tag);
    expect(tags).toContain("0053_attendance_b17");
    expect(tags).toContain("0052_flow_test_scenarios");
    const entry53 = j.entries.find((e) => e.tag === "0053_attendance_b17");
    expect(entry53?.idx).toBe(53);
  });

  it("schema.ts defines attendanceDaily and attendanceCompliance with no any", () => {
    const schema = readFileSync(join(process.cwd(), "src/db/schema.ts"), "utf8");
    expect(schema).toContain("attendanceDaily");
    expect(schema).toContain("attendanceCompliance");
    expect(schema).toContain("attendance_daily");
    expect(schema).toContain("attendance_compliance");
    const service = readFileSync(join(process.cwd(), "src/services/attendance.service.ts"), "utf8");
    const route = readFileSync(join(process.cwd(), "src/routes/attendance.ts"), "utf8");
    for (const content of [service, route]) {
      const hasAny = /:\s*any\b|<any>/.test(content);
      expect(hasAny).toBe(false);
    }
  });
});
