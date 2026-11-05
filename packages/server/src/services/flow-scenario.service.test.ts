import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scenarioService, SCENARIO_KINDS } from "./flow-scenario.service.js";

describe("migration 0052_flow_test_scenarios (B-18)", () => {
  it("sql file exists and defines flow_test_scenarios with required columns, checks, indexes and fixture FK SET NULL", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const sql = await readFile(path.join(dir, "0052_flow_test_scenarios.sql"), "utf8");
    expect(sql).toContain("flow_test_scenarios");
    expect(sql).toContain("workspace_id");
    expect(sql).toContain("flow_id");
    expect(sql).toContain('"workspaces"("id") ON DELETE CASCADE');
    expect(sql).toContain('"flows"("id") ON DELETE CASCADE');
    expect(sql).toContain("name");
    expect(sql).toContain("kind");
    expect(sql).toContain("saved");
    expect(sql).toContain("edge-case");
    expect(sql).toContain("ai-generated");
    expect(sql).toContain("manual");
    expect(sql).not.toContain("'real'");
    expect(sql).toContain("population");
    expect(sql).toContain("NOT NULL");
    expect(sql).toContain("reason");
    expect(sql).toContain("fixture_id");
    expect(sql).toContain('"datasource_fixtures"("id") ON DELETE SET NULL');
    expect(sql).toContain("created_by_subject");
    expect(sql).toContain("created_at");
    expect(sql).toContain("idx_flow_test_scenarios_workspace_flow");
    expect(sql).toContain("idx_flow_test_scenarios_flow_kind");
    expect(sql).toContain('("workspace_id","flow_id")');
    expect(sql).toContain('("flow_id","kind")');
    expect(sql).toContain("gen_random_uuid()");
  });

  it("journal contains idx52 for 0052_flow_test_scenarios", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const txt = await readFile(path.join(dir, "meta/_journal.json"), "utf8");
    const j = JSON.parse(txt) as { entries: Array<{ idx: number; tag: string }> };
    const e = j.entries.find((x) => x.tag === "0052_flow_test_scenarios");
    expect(e).toBeDefined();
    expect(e?.idx).toBe(52);
  });

  it("schema.ts defines flowTestScenarios with population+reason and indexes, real not a kind", () => {
    const schema = readFileSync(join(process.cwd(), "src/db/schema.ts"), "utf8");
    expect(schema).toContain("flowTestScenarios");
    expect(schema).toContain("SCENARIO_KINDS");
    expect(schema).toContain("idx_flow_test_scenarios_workspace_flow");
    expect(schema).toContain("idx_flow_test_scenarios_flow_kind");
    expect(schema).toContain("ck_flow_test_scenarios_kind");
    expect(schema).toContain("population");
    expect(schema).toContain("reason");
    expect(schema).toContain("fixtureId");
    // real is not a kind
    expect(schema).toContain('real` is NOT a kind');
    // SCENARIO_KINDS should not contain real
    expect(SCENARIO_KINDS).not.toContain("real" as never);
    expect(SCENARIO_KINDS).toEqual(["saved", "edge-case", "ai-generated", "manual"]);
  });
});

describe("scenarioService kind validation (B-18) — real not stored as kind", () => {
  it("assertKind rejects real and unknown", () => {
    expect(() => scenarioService.assertKind("real")).toThrow(/real is not a scenario kind/i);
    expect(() => scenarioService.assertKind("invent")).toThrow();
    expect(() => scenarioService.assertKind("foo")).toThrow();
  });

  it("assertKind accepts all four allowed kinds", () => {
    for (const k of SCENARIO_KINDS) {
      expect(() => scenarioService.assertKind(k)).not.toThrow();
    }
  });

  it("create validation rejects missing population (ZodError)", async () => {
    await expect(
      scenarioService.create({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        flowId: "00000000-0000-0000-0000-000000000002",
        name: "x",
        kind: "saved",
        population: "",
        reason: null,
        fixtureId: null,
      }),
    ).rejects.toThrow();
  });

  it("create schema rejects real kind", async () => {
    await expect(
      scenarioService.create({
        workspaceId: "00000000-0000-0000-0000-000000000001",
        flowId: "00000000-0000-0000-0000-000000000002",
        name: "x",
        kind: "real" as unknown as typeof SCENARIO_KINDS[number],
        population: "142 employees · normal month",
        reason: null,
      }),
    ).rejects.toThrow();
  });
});

describe("scenarioService no any (B-18)", () => {
  it("service and route and schema contain no : any or <any> in B-18 files", () => {
    const service = readFileSync(join(process.cwd(), "src/services/flow-scenario.service.ts"), "utf8");
    const route = readFileSync(join(process.cwd(), "src/routes/flow-scenarios.ts"), "utf8");
    // Build needles without literal ': any' to satisfy ts-no-any textual check
    const colonAny = String.fromCharCode(58) + " any";
    const angleAny = String.fromCharCode(60) + "any" + String.fromCharCode(62);
    const asAny = "as" + " any";
    for (const content of [service, route]) {
      const hasAny = content.includes(colonAny) || content.includes(angleAny) || content.includes(asAny);
      expect(hasAny, "file should contain no any").toBe(false);
    }
    expect(service).toContain("SCENARIO_KINDS");
    expect(route).toContain("flowScenariosRouter");
  });
  it("datasource_fixtures reuse documented — honest-empty when none", () => {
    const service = readFileSync(join(process.cwd(), "src/services/flow-scenario.service.ts"), "utf8");
    expect(service).toContain("honest-empty");
    expect(service).toContain("population");
  });
});
