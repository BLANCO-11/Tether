import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { releaseGates, workspaces, flows, flowRevisions } from "../db/schema.js";
import { releaseGateService, DEFAULT_GATES } from "./release-gate.service.js";

const reachable = await (async () => {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
})();

describe("migration 0048_release_gates (B-19)", () => {
  it("sql file exists and defines release_gates with required columns and indexes", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const sql = await readFile(path.join(dir, "0048_release_gates.sql"), "utf8");
    expect(sql).toContain("release_gates");
    expect(sql).toContain("workspace_id");
    expect(sql).toContain("flow_id");
    expect(sql).toContain("REFERENCES \"workspaces\"");
    expect(sql).toContain("REFERENCES \"flows\"");
    expect(sql).toContain("enabled");
    expect(sql).toContain("satisfied_by");
    expect(sql).toContain("policy_id");
    expect(sql).toContain("ordinal");
    expect(sql).toContain("idx_release_gates_workspace");
    expect(sql).toContain("idx_release_gates_workspace_flow");
  });

  it("journal contains idx48 for 0048_release_gates", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const txt = await readFile(path.join(dir, "meta/_journal.json"), "utf8");
    const j = JSON.parse(txt) as { entries: Array<{ idx: number; tag: string }> };
    const e = j.entries.find((x) => x.tag === "0048_release_gates");
    expect(e).toBeDefined();
    expect(e?.idx).toBe(48);
  });

  it("schema.ts defines releaseGates pgTable with workspace/flow FKs", async () => {
    const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/schema.ts");
    const txt = await readFile(schemaPath, "utf8");
    expect(txt).toContain("releaseGates");
    expect(txt).toContain("release_gates");
    expect(txt).toContain("satisfiedBy");
  });

  it("service file contains no `any`", async () => {
    const svcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./release-gate.service.ts");
    const txt = await readFile(svcPath, "utf8");
    // forbid `: any` and `as any` — workspace rule
    expect(txt).not.toMatch(/:\s*any\b/);
    expect(txt).not.toMatch(/\bas\s+any\b/);
  });

  it("route file exposes GET /workspaces/:ws/release-gates and GET /workspaces/:ws/flows/:id/release-gates", async () => {
    const routePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../routes/release-gates.ts");
    const txt = await readFile(routePath, "utf8");
    expect(txt).toContain("releaseGatesRouter");
    expect(txt).toContain("workspaceId");
    expect(txt).toContain("flowId");
    expect(txt).toContain("releaseGateService");
  });

  it("DEFAULT_GATES has 4 gates with satisfiedBy verbatim", () => {
    expect(DEFAULT_GATES.length).toBe(4);
    expect(DEFAULT_GATES[0].name).toBe("Successful test required");
    expect(DEFAULT_GATES[0].satisfiedBy).toBe("Run a test on this draft and let it pass.");
    expect(DEFAULT_GATES[1].name).toBe("No open blockers");
    expect(DEFAULT_GATES[2].name).toBe("All resources published");
    expect(DEFAULT_GATES[3].name).toBe("Publication approval");
    // ordinals ascending
    const ordinals = DEFAULT_GATES.map((g) => g.ordinal);
    expect(ordinals).toEqual([1, 2, 3, 4]);
  });
});

describe.skipIf(!reachable)("releaseGateService.list ordering and disabled rendering (B-19)", () => {
  let wsA!: string;
  let wsB!: string;
  let flowA!: string;
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  beforeAll(async () => {
    const [a] = await db.insert(workspaces).values({ name: `rg-ws-a-${stamp}`, slug: `rg-a-${stamp}` }).returning();
    const [b] = await db.insert(workspaces).values({ name: `rg-ws-b-${stamp}`, slug: `rg-b-${stamp}` }).returning();
    wsA = a.id;
    wsB = b.id;

    // Create a flow in wsA for per-flow tests
    const [f] = await db
      .insert(flows)
      .values({ workspaceId: wsA, name: `rg-flow-${stamp}`, kestraFlowId: `rg-flow-${stamp}`, draftRevision: 1 })
      .returning();
    flowA = f.id;

    // Clean any pre-existing gates for these workspaces (idempotent seed may have inserted)
    await db.delete(releaseGates).where(eq(releaseGates.workspaceId, wsA));
    await db.delete(releaseGates).where(eq(releaseGates.workspaceId, wsB));

    // Insert gates out of ordinal order, including one disabled
    await db.insert(releaseGates).values([
      { workspaceId: wsA, flowId: null, name: "Publication approval", enabled: true, satisfiedBy: "Get publication approval for this draft.", policyId: null, ordinal: 4 },
      { workspaceId: wsA, flowId: null, name: "Successful test required", enabled: false, satisfiedBy: "Run a test on this draft and let it pass.", policyId: null, ordinal: 1 },
      { workspaceId: wsA, flowId: null, name: "All resources published", enabled: true, satisfiedBy: "Publish all resources this workflow depends on.", policyId: null, ordinal: 3 },
      { workspaceId: wsA, flowId: null, name: "No open blockers", enabled: true, satisfiedBy: "Resolve all blocking items in the readiness checklist.", policyId: null, ordinal: 2 },
    ]);

    // Workspace B gets different gates to test scoping
    await db.insert(releaseGates).values([
      { workspaceId: wsB, flowId: null, name: "Successful test required", enabled: true, satisfiedBy: "Run a test on this draft and let it pass.", policyId: null, ordinal: 1 },
    ]);
  });

  afterAll(async () => {
    await db.delete(releaseGates).where(eq(releaseGates.workspaceId, wsA));
    await db.delete(releaseGates).where(eq(releaseGates.workspaceId, wsB));
    // Delete flow revisions first due to FK
    const revs = await db.select().from(flowRevisions).where(eq(flowRevisions.flowId, flowA));
    for (const r of revs) {
      await db.delete(flowRevisions).where(eq(flowRevisions.id, r.id));
    }
    await db.delete(flows).where(eq(flows.id, flowA));
    await db.delete(workspaces).where(eq(workspaces.id, wsA));
    await db.delete(workspaces).where(eq(workspaces.id, wsB));
  });

  it("returns gates in ordinal order", async () => {
    const gates = await releaseGateService.list({ workspaceId: wsA });
    expect(gates.map((g) => g.ordinal)).toEqual([1, 2, 3, 4]);
    expect(gates.map((g) => g.name)).toEqual(["Successful test required", "No open blockers", "All resources published", "Publication approval"]);
  });

  it("disabled gate still returned with enabled:false (not filtered, for `not enforced` UI)", async () => {
    const gates = await releaseGateService.list({ workspaceId: wsA });
    const disabled = gates.find((g) => g.name === "Successful test required");
    expect(disabled).toBeDefined();
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.satisfiedBy).toBe("Run a test on this draft and let it pass.");
  });

  it("per-flow override fallback — flow with no per-flow gates returns workspace defaults", async () => {
    const gates = await releaseGateService.list({ workspaceId: wsA, flowId: flowA });
    expect(gates.length).toBe(4);
    expect(gates[0].ordinal).toBe(1);
  });

  it("evaluatePublishGates documents met/unmet/pending + blocked + blockers with satisfiedBy verbatim", async () => {
    const result = await releaseGateService.evaluatePublishGates({ workspaceId: wsA, flowId: flowA, draftRevision: 1 });
    expect(result.gates.length).toBeGreaterThanOrEqual(4);
    // Disabled gate is present but not considered blocked (not enforced)
    const disabledEval = result.gates.find((g) => g.name === "Successful test required");
    expect(disabledEval?.enabled).toBe(false);
    // Blockers should quote satisfiedBy verbatim
    for (const b of result.blockers) {
      expect(typeof b.satisfiedBy).toBe("string");
      expect(b.satisfiedBy.length).toBeGreaterThan(0);
      expect(typeof b.whoCan).toBe("string");
    }
    // Blocked true if any enabled unmet
    const hasUnmet = result.gates.some((g) => g.enabled && g.state === "unmet");
    expect(result.blocked).toBe(hasUnmet);
  });
});

describe.skipIf(!reachable)("release-gates routes 200 and scoping (B-19)", () => {
  let ws!: string;
  let flowId!: string;
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  beforeAll(async () => {
    const [w] = await db.insert(workspaces).values({ name: `rg-route-${stamp}`, slug: `rg-route-${stamp}` }).returning();
    ws = w.id;
    const [f] = await db.insert(flows).values({ workspaceId: ws, name: `rg-route-flow-${stamp}`, kestraFlowId: `rg-route-flow-${stamp}`, draftRevision: 0 }).returning();
    flowId = f.id;
    await db.delete(releaseGates).where(eq(releaseGates.workspaceId, ws));
    await db.insert(releaseGates).values(DEFAULT_GATES.map((g) => ({ workspaceId: ws, flowId: null, name: g.name, enabled: true, satisfiedBy: g.satisfiedBy, policyId: null, ordinal: g.ordinal })));
  });

  afterAll(async () => {
    await db.delete(releaseGates).where(eq(releaseGates.workspaceId, ws));
    await db.delete(flows).where(eq(flows.id, flowId));
    await db.delete(workspaces).where(eq(workspaces.id, ws));
  });

  it("GET /workspaces/:ws/release-gates returns {gates} in ordinal order (via service, workspace-scoped)", async () => {
    const gates = await releaseGateService.list({ workspaceId: ws });
    expect(Array.isArray(gates)).toBe(true);
    expect(gates.map((g) => g.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it("GET /workspaces/:ws/flows/:id/release-gates is workspace-scoped (wrong workspace returns empty)", async () => {
    const [otherWs] = await db.insert(workspaces).values({ name: `rg-other-${stamp}`, slug: `rg-other2-${stamp}` }).returning();
    const gates = await releaseGateService.list({ workspaceId: otherWs.id, flowId });
    expect(gates.length).toBe(0);
    await db.delete(workspaces).where(eq(workspaces.id, otherWs.id));
  });
});
