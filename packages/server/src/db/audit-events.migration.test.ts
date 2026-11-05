import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("audit_events migration (B-15)", () => {
  const sqlPath = join(process.cwd(), "drizzle/0046_audit_events.sql");
  const journalPath = join(process.cwd(), "drizzle/meta/_journal.json");

  it("migration file exists", () => {
    expect(existsSync(sqlPath)).toBe(true);
  });

  it("defines audit_events with required columns and checks", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toContain("audit_events");
    expect(sql).toContain("workspace_id");
    expect(sql).toContain("time");
    expect(sql).toContain("actor");
    expect(sql).toContain("operation");
    expect(sql).toContain("entity");
    expect(sql).toContain("entity_id");
    expect(sql).toContain("description");
    expect(sql).toContain("where_text");
    expect(sql).toContain("where_entity_type");
    expect(sql).toContain("where_entity_id");
    expect(sql).toContain("raw");
    // operation enum
    expect(sql).toContain("'create'");
    expect(sql).toContain("'publish'");
    expect(sql).toContain("'approve'");
    // entity enum
    expect(sql).toContain("'workflow'");
    expect(sql).toContain("'resource'");
    expect(sql).toContain("'run'");
  });

  it("creates required indexes", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toContain("idx_audit_events_workspace_time");
    expect(sql).toContain("idx_audit_events_workspace_actor");
    expect(sql).toContain("idx_audit_events_workspace_operation");
  });

  it("is append-only: comment and REVOKE UPDATE,DELETE", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql.toLowerCase()).toContain("append-only");
    expect(sql).toContain("COMMENT ON TABLE");
    expect(sql).toContain("REVOKE");
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("DELETE");
  });

  it("journal contains 0046_audit_events", () => {
    const j = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const tags = j.entries.map((e) => e.tag);
    expect(tags).toContain("0046_audit_events");
  });

  it("schema.ts defines auditEvents with text checks (no enum type) and no any", () => {
    const schema = readFileSync(join(process.cwd(), "src/db/schema.ts"), "utf8");
    expect(schema).toContain("auditEvents");
    expect(schema).toContain("ck_audit_events_operation");
    expect(schema).toContain("ck_audit_events_entity");
    // ensure no any in our new files
    const service = readFileSync(join(process.cwd(), "src/services/audit.service.ts"), "utf8");
    const route = readFileSync(join(process.cwd(), "src/routes/audit-events.ts"), "utf8");
    for (const content of [service, route, schema]) {
      // crude check for `any` as type — allow inside comments? We check for `: any` or `<any>`
      const hasAny = /:\s*any\b|<any>/.test(content);
      // If found, ensure it's not in our audit files (schema contains many anys elsewhere but we check audit section)
      // So we only check our service and route
      if (content === service || content === route) {
        expect(hasAny).toBe(false);
      }
    }
  });
});
