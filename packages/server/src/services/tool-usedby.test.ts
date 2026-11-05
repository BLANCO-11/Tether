import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { flowSteps, flows, tools, workspaces } from "../db/schema.js";
import { toolService } from "./tool.service.js";

/**
 * `tool.usedBy` — distinct flows (across revisions) whose steps reference the
 * tool's NAME, counted from `flow_steps.manifest_refs_json` keys (Phase 7).
 *
 * The count is denormalised from the same column the staleness sweep reads
 * (`manifestRefsJson` is queried per step to detect approval staleness), so
 * this can never disagree with what a flow actually uses. Per-key
 * `COUNT(DISTINCT flow_id)` over `jsonb_object_keys` is exactly the contract:
 * a flow referencing the tool in TWO revisions counts ONCE (the "any revision"
 * in the contract), and a datasource/operation ref like `hr_demo.attendance`
 * never inflates a tool count because a tool name is an env-var identifier and
 * cannot contain a dot.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[usedBy] SKIPPING — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

let wsId: string;
let otherWsId: string;
let mailSendId: string;

beforeAll(async () => {
  if (!reachable) return;
  const [ws] = await db
    .insert(workspaces)
    .values({ name: `tool-usedby-test-${Date.now()}` })
    .returning();
  wsId = ws.id;
  const [other] = await db
    .insert(workspaces)
    .values({ name: `tool-usedby-other-${Date.now()}` })
    .returning();
  otherWsId = other.id;

  const created = await db
    .insert(tools)
    .values([
      { workspaceId: wsId, name: "mail_send" },
      { workspaceId: wsId, name: "lonely_tool" },
      { workspaceId: wsId, name: "attendance" },
    ])
    .returning({ id: tools.id, name: tools.name });
  mailSendId = created.find((t) => t.name === "mail_send")!.id;

  // Flow A references mail_send in TWO revisions — still ONE distinct flow.
  // Flow B references mail_send once — second distinct flow.
  // Flow C references a DATASOURCE ref (dot grammar) — must not count for any tool.
  // Flow D lives in ANOTHER workspace and references mail_send — tenancy boundary.
  const [flowA, flowB, flowC] = await db
    .insert(flows)
    .values([
      { workspaceId: wsId, name: "a", kestraFlowId: `usedby-a-${Date.now()}` },
      { workspaceId: wsId, name: "b", kestraFlowId: `usedby-b-${Date.now()}` },
      { workspaceId: wsId, name: "c", kestraFlowId: `usedby-c-${Date.now()}` },
    ])
    .returning({ id: flows.id });
  const [flowD] = await db
    .insert(flows)
    .values({ workspaceId: otherWsId, name: "d", kestraFlowId: `usedby-d-${Date.now()}` })
    .returning({ id: flows.id });

  await db.insert(flowSteps).values([
    { flowId: flowA.id, revision: 1, stepId: "s1", ordinal: 1, kind: "tool", configJson: {}, manifestRefsJson: { mail_send: "sha256:rev1" } },
    { flowId: flowA.id, revision: 2, stepId: "s1", ordinal: 1, kind: "tool", configJson: {}, manifestRefsJson: { mail_send: "sha256:rev2" } },
    { flowId: flowB.id, revision: 1, stepId: "s1", ordinal: 1, kind: "tool", configJson: {}, manifestRefsJson: { mail_send: "sha256:rev1" } },
    { flowId: flowC.id, revision: 1, stepId: "s1", ordinal: 1, kind: "query", configJson: {}, manifestRefsJson: { "hr_demo.attendance": "sha256:rev1" } },
    { flowId: flowD.id, revision: 1, stepId: "s1", ordinal: 1, kind: "tool", configJson: {}, manifestRefsJson: { mail_send: "sha256:rev1" } },
  ]);
});

afterAll(async () => {
  if (reachable) {
    if (wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
    if (otherWsId) await db.delete(workspaces).where(eq(workspaces.id, otherWsId));
  }
  await pool.end().catch(() => {});
});

describe.skipIf(!reachable)("tool.usedBy — distinct flows per tool name (Phase 7)", () => {
  it("counts DISTINCT flows: two revisions of one flow referencing the tool count once", async () => {
    const listed = await toolService.list(wsId);
    const mailSend = listed.find((t) => t.name === "mail_send");
    expect(mailSend).toBeDefined();
    expect(mailSend!.usedBy).toBe(2); // flow A (both revisions) + flow B
  });

  it("reads 0 for a tool no flow references, never absent", async () => {
    const listed = await toolService.list(wsId);
    const lonely = listed.find((t) => t.name === "lonely_tool");
    expect(lonely).toBeDefined();
    expect(lonely!.usedBy).toBe(0);
  });

  it("never counts a datasource/operation ref as a tool — dots cannot collide", async () => {
    const listed = await toolService.list(wsId);
    const attendance = listed.find((t) => t.name === "attendance");
    expect(attendance).toBeDefined();
    // flow C references "hr_demo.attendance"; the tool is named "attendance".
    expect(attendance!.usedBy).toBe(0);
  });

  it("scopes the count to the workspace — another workspace's flows do not leak in", async () => {
    const listed = await toolService.list(wsId);
    const mailSend = listed.find((t) => t.name === "mail_send");
    expect(mailSend!.usedBy).toBe(2); // flow D is in otherWsId
  });

  it("get() carries the same count", async () => {
    const tool = await toolService.get(wsId, mailSendId);
    expect(tool?.usedBy).toBe(2);
  });
});
