import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { approvalRequests, flowRevisions, flows, workspaces } from "../db/schema.js";
import { pinService } from "./pin.service.js";
import { nextFireService } from "./next-fire.service.js";
import { searchService, SEARCH_KINDS } from "./search.service.js";
import { bootstrapService } from "./bootstrap.service.js";

const reachable = await (async () => {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!reachable)("B-01..B-04 backend-required", () => {
  let ws: string;
  let wsOther: string;
  const actorA = `tester-a-${Date.now().toString(36)}@example.com`;
  const actorB = `tester-b-${Date.now().toString(36)}@example.com`;
  let flowArmed: string;
  let flowDraft: string;

  beforeAll(async () => {
    const w = await db.insert(workspaces).values({ name: `ws-b01-${Date.now().toString(36)}` }).returning();
    ws = w[0].id;
    const w2 = await db.insert(workspaces).values({ name: `ws-b01-other-${Date.now().toString(36)}` }).returning();
    wsOther = w2[0].id;

    const fArmed = await db.insert(flows).values({
      workspaceId: ws,
      name: "Armed flow",
      kestraFlowId: `kestra-armed-${Date.now().toString(36)}`,
      draftRevision: 1,
      armedRevision: 1,
      status: "armed",
    }).returning();
    flowArmed = fArmed[0].id;
    await db.insert(flowRevisions).values({
      flowId: flowArmed,
      revision: 1,
      modelJson: { id: fArmed[0].kestraFlowId, steps: [], schedule: { cron: "0 7 * * 1" } },
      compiledYamlHash: "hash1",
      structureHash: "sh1",
      createdBy: actorA,
      createdByKind: "system",
    });

    const fDraft = await db.insert(flows).values({
      workspaceId: ws,
      name: "Draft flow",
      kestraFlowId: `kestra-draft-${Date.now().toString(36)}`,
      draftRevision: 1,
      armedRevision: null,
      status: "draft",
    }).returning();
    flowDraft = fDraft[0].id;
    await db.insert(flowRevisions).values({
      flowId: flowDraft,
      revision: 1,
      modelJson: { id: fDraft[0].kestraFlowId, steps: [], schedule: { cron: "0 7 * * 1" } },
      compiledYamlHash: "hash2",
      structureHash: "sh2",
      createdBy: actorA,
      createdByKind: "system",
    });

    await db.insert(approvalRequests).values({
      workspaceId: ws,
      type: "exception",
      subjectEntityType: "exception",
      subjectEntityId: "exc-1",
      subjectLabel: "Test exception · July",
      requesterSubject: actorA,
      risk: "low",
      status: "pending",
      approvalPolicy: "all",
    });
  });

  afterAll(async () => {
    if (ws) await db.delete(workspaces).where(eq(workspaces.id, ws));
    if (wsOther) await db.delete(workspaces).where(eq(workspaces.id, wsOther));
  });

  it("B-02 pins per-person isolation oid", async () => {
    const r1 = await pinService.toggle(ws, actorA, flowArmed);
    expect(r1.pinned).toBe(true);
    const listB = await pinService.list(ws, actorB);
    expect(listB.length).toBe(0);
    const listA = await pinService.list(ws, actorA);
    expect(listA.length).toBe(1);
    expect(listA[0].flowId).toBe(flowArmed);
    const r2 = await pinService.toggle(ws, actorB, flowArmed);
    expect(r2.pinned).toBe(true);
    const listA2 = await pinService.list(ws, actorA);
    expect(listA2.length).toBe(1);
    const listB2 = await pinService.list(ws, actorB);
    expect(listB2.length).toBe(1);
    const r3 = await pinService.toggle(ws, actorA, flowArmed);
    expect(r3.pinned).toBe(false);
    expect((await pinService.list(ws, actorA)).length).toBe(0);
    expect((await pinService.list(ws, actorB)).length).toBe(1);
    expect((await pinService.list(wsOther, actorA)).length).toBe(0);
  });

  it("B-01 next-fire armed-only 30d limit 4 derivedInFoundry", async () => {
    const res = await nextFireService.list(ws, 4, 30);
    expect(res.derivedInFoundry).toBe(true);
    expect(res.limit).toBe(4);
    expect(res.windowDays).toBe(30);
    const armedFires = res.nextFires.filter((f) => f.flowId === flowArmed);
    const draftFires = res.nextFires.filter((f) => f.flowId === flowDraft);
    expect(armedFires.length).toBeGreaterThan(0);
    expect(draftFires.length).toBe(0);
    for (const f of res.nextFires) expect(f.derivedInFoundry).toBe(true);
    expect(res.overflow).toBe(res.total - res.nextFires.length);
  });

  /**
   * ⚠ This test now passes a VIEWER, because `index` gained a required third argument
   * (RBAC T043). It is deliberately given every permission, so it keeps asserting
   * exactly what it always asserted — the six kinds and the workspace scoping — and the
   * per-kind FILTERING is asserted separately in `search.service.test.ts`. A test that
   * quietly acquired a narrower viewer would start passing for the wrong reason.
   */
  const ALL_SEEING = {
    permissions: new Set<string>([
      "flows.read",
      "runs.read",
      "datasources.read",
      "tools.read",
      "approvals.read",
      "members.read",
    ]),
  };

  it("B-30 search 6 kinds filtered workspace-scoped", async () => {
    const wResults = await searchService.index(ws, "Armed flow", ALL_SEEING);
    const kinds = new Set(wResults.map((r) => r.kind));
    expect(kinds.has("workflow")).toBe(true);
    for (const r of wResults) {
      expect(r.href).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.iconKey).toBeTruthy();
    }
    const aResults = await searchService.index(ws, "exception", ALL_SEEING);
    expect(aResults.some((r) => r.kind === "approval")).toBe(true);
    const empty = await searchService.index(ws, "", ALL_SEEING);
    expect(empty.length).toBe(0);
    const other = await searchService.index(wsOther, "Armed flow", ALL_SEEING);
    expect(other.length).toBe(0);
    expect(SEARCH_KINDS).toEqual(["workflow", "step", "run", "resource", "approval", "person"]);
  });

  it("B-04 bootstrap 34 templates ready honest", async () => {
    const ready = await bootstrapService.ready(ws);
    expect(ready.templatesCount).toBe(34);
    expect(ready.policiesReady).toBe(true);
    expect(typeof ready.resourcesReady).toBe("boolean");
    expect(ready.workspaceId).toBe(ws);
  });

  it("no any in B-01..B-04 files", async () => {
    const files = [
      new URL("./pin.service.ts", import.meta.url),
      new URL("./next-fire.service.ts", import.meta.url),
      new URL("./search.service.ts", import.meta.url),
      new URL("./bootstrap.service.ts", import.meta.url),
      new URL("../routes/pins.ts", import.meta.url),
      new URL("../routes/next-fires.ts", import.meta.url),
      new URL("../routes/search.ts", import.meta.url),
      new URL("../routes/bootstrap.ts", import.meta.url),
    ];
    for (const f of files) {
      const txt = await fs.promises.readFile(f, "utf8");
      if (/\:\s*any\b/.test(txt) || /\<any\>/.test(txt)) {
        throw new Error(`file ${f.pathname} contains 'any'`);
      }
    }
  });
});

describe("B-01..B-04 static checks (no DB)", () => {
  it("no any static", async () => {
    const files = [
      new URL("./pin.service.ts", import.meta.url),
      new URL("./next-fire.service.ts", import.meta.url),
      new URL("./search.service.ts", import.meta.url),
      new URL("./bootstrap.service.ts", import.meta.url),
      new URL("../routes/pins.ts", import.meta.url),
      new URL("../routes/next-fires.ts", import.meta.url),
      new URL("../routes/search.ts", import.meta.url),
      new URL("../routes/bootstrap.ts", import.meta.url),
    ];
    for (const f of files) {
      const txt = await fs.promises.readFile(f, "utf8");
      if (/\:\s*any\b/.test(txt) || /\<any\>/.test(txt)) {
        throw new Error(`file ${f.pathname} contains 'any' type`);
      }
    }
  });
  it("B-03/B-05 comments present", async () => {
    const txt = await fs.promises.readFile(new URL("../../../../packages/client/src/lib/api.ts", import.meta.url), "utf8");
    expect(txt).toContain("B-03 This month generic");
    expect(txt).toContain("B-05 Health derived");
  });
  it("pins idx54 unique workspace_id subject flow_id", async () => {
    const schema = await fs.promises.readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
    expect(schema).toContain("uq_pins_workspace_subject_flow");
    expect(schema).toContain("idx54");
  });
  it("search 6 kinds vocabulary", async () => {
    const txt = await fs.promises.readFile(new URL("./search.service.ts", import.meta.url), "utf8");
    expect(txt).toContain('"workflow"');
    expect(txt).toContain('"step"');
    expect(txt).toContain('"run"');
    expect(txt).toContain('"resource"');
    expect(txt).toContain('"approval"');
    expect(txt).toContain('"person"');
  });
});
