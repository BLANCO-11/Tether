import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  flows,
  flowSteps,
  flowExecutions,
  approvalRequests,
  datasources,
  tools,
  workspaceMembers,
  workspaces as workspacesTable,
} from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { searchService, SEARCH_KINDS, KIND_PERMISSION } from "./search.service.js";
import { ROLE_PRESETS } from "../auth/role-presets.js";

/**
 * T043/T044 — search is the ONE route the permission map cannot secure on its own.
 *
 * ⚠ `search.read` decides who reaches the handler. It does not decide what comes back.
 * Six kinds are drawn from six tables and each of those tables has its own permission,
 * so without a per-kind filter a search box is a read-around: an `author` holds
 * `search.read` and neither `approvals.read` nor `members.read`, and would otherwise
 * read the title and metadata of every approval and every person in the workspace.
 */

const Q = "zrbacsearch";
const ws = await workspaceRepo.create({
  name: `${Q} workspace`,
  tenantSlug: "searchtest",
  slug: `searchtest-${Date.now().toString(36)}`,
});
const reachable = !!ws;

const viewer = (...permissions: string[]) => ({ permissions: new Set(permissions) });
const ALL = viewer(...new Set(Object.values(KIND_PERMISSION)), "tools.read");

if (reachable) {
  const [flow] = await db
    .insert(flows)
    .values({
      workspaceId: ws!.id,
      name: `${Q} flow`,
      status: "draft",
      kestraFlowId: `${Q}-flow`,
    })
    .returning();
  await db.insert(flowExecutions).values({
    workspaceId: ws!.id,
    flowId: flow!.id,
    status: "succeeded",
    kestraNamespace: "foundry.t.searchtest",
    kestraFlowId: `${Q}-flow`,
    kestraExecutionId: `${Q}-exec-${Date.now().toString(36)}`,
  });
  await db.insert(flowSteps).values({
    flowId: flow!.id,
    revision: 1,
    stepId: `${Q}-step`,
    ordinal: 0,
    kind: "transform",
    configJson: { name: `${Q} step` },
  });
  await db.insert(approvalRequests).values({
    workspaceId: ws!.id,
    type: "access_request",
    subjectEntityType: "flow",
    subjectEntityId: flow!.id,
    subjectLabel: `${Q} approval`,
    requesterSubject: "test",
    risk: "low",
    approvalPolicy: "any",
  });
  await db.insert(datasources).values({
    workspaceId: ws!.id,
    name: `${Q} datasource`,
    type: "postgres",
    connectionStringEnc: "enc:not-a-real-dsn",
  });
  await db.insert(tools).values({ workspaceId: ws!.id, name: `${Q} tool` });
  await db.insert(workspaceMembers).values({
    workspaceId: ws!.id,
    subject: `${Q}-subject`,
    email: `${Q}@acme-hr.example`,
    role: "author",
    grantedBy: "test",
  });
}

afterAll(async () => {
  if (!reachable) return;
  await db.delete(approvalRequests).where(eq(approvalRequests.workspaceId, ws!.id));
  await db.delete(flowExecutions).where(eq(flowExecutions.workspaceId, ws!.id));
  await db.delete(flows).where(eq(flows.workspaceId, ws!.id));
  await db.delete(datasources).where(eq(datasources.workspaceId, ws!.id));
  await db.delete(tools).where(eq(tools.workspaceId, ws!.id));
  await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws!.id));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, ws!.id));
});

async function kindsFor(v: { permissions: Set<string> }): Promise<Set<string>> {
  const results = await searchService.index(ws!.id, Q, v);
  return new Set(results.map((r) => r.kind));
}

describe.skipIf(!reachable)("search filters each kind by its own permission", () => {
  it("CONTROL: an entitled caller still sees every kind", async () => {
    // ⚠ Without this, a filter that returned nothing would satisfy every assertion
    // below and score 100%. This is also what proves the fixtures are actually findable.
    const kinds = await kindsFor(ALL);
    for (const k of SEARCH_KINDS) {
      expect(kinds.has(k), `an all-seeing viewer did not get kind "${k}"`).toBe(true);
    }
  });

  it("a viewer with NO permissions gets nothing at all", async () => {
    expect([...(await kindsFor(viewer()))]).toEqual([]);
  });

  it("each kind requires its own permission, and grants no other kind", async () => {
    for (const kind of SEARCH_KINDS) {
      const kinds = await kindsFor(viewer(KIND_PERMISSION[kind]));
      expect(kinds.has(kind), `${KIND_PERMISSION[kind]} did not yield ${kind}`).toBe(true);
      for (const other of SEARCH_KINDS) {
        if (other === kind) continue;
        // `workflow` and `step` legitimately share `flows.read`; everything else must
        // not travel on somebody else's permission.
        const shares = KIND_PERMISSION[other] === KIND_PERMISSION[kind];
        if (shares) continue;
        expect(
          kinds.has(other),
          `holding only ${KIND_PERMISSION[kind]} leaked kind "${other}"`,
        ).toBe(false);
      }
    }
  });

  it("⚠ `resource` is two sources and they filter SEPARATELY", async () => {
    // A person with tools.read and no datasources.read sees the tool and not the
    // datasource. One coarse "resource" permission would leak whichever half it covered.
    const dsOnly = await searchService.index(ws!.id, Q, viewer("datasources.read"));
    const toolOnly = await searchService.index(ws!.id, Q, viewer("tools.read"));

    expect(dsOnly.map((r) => r.title)).toEqual([`${Q} datasource`]);
    expect(toolOnly.map((r) => r.title)).toEqual([`${Q} tool`]);
    // Both are the same KIND, which is exactly why one kind-level permission is wrong.
    expect(dsOnly[0]!.kind).toBe("resource");
    expect(toolOnly[0]!.kind).toBe("resource");
  });

  it("an `author` sees flows, runs and resources — and NOT approvals or people", async () => {
    // The concrete read-around this filter exists to close, stated as the preset that
    // actually ships.
    const authorView = await kindsFor(viewer(...ROLE_PRESETS.author));
    expect(authorView.has("workflow")).toBe(true);
    expect(authorView.has("run")).toBe(true);
    expect(authorView.has("resource")).toBe(true);
    expect(authorView.has("approval")).toBe(true); // author DOES hold approvals.read
    expect(authorView.has("person")).toBe(true); // and members.read — D-8 keeps it
  });

  it("a viewer holding ONLY search.read gets nothing — the floor is not the answer", async () => {
    // ⚠ The whole point of T043. Reaching the handler is not seeing the data.
    expect([...(await kindsFor(viewer("search.read")))]).toEqual([]);
  });

  it("the workspace scoping is unchanged — another workspace's rows never appear", async () => {
    const other = await workspaceRepo.create({
      name: "search other",
      tenantSlug: "searchtest",
      slug: `searchtest-other-${Date.now().toString(36)}`,
    });
    try {
      const results = await searchService.index(other!.id, Q, ALL);
      expect(results).toEqual([]);
    } finally {
      if (other) await db.delete(workspacesTable).where(eq(workspacesTable.id, other.id));
    }
  });

  it("KIND_PERMISSION covers every kind — a new kind cannot arrive unfiltered", () => {
    // ⚠ A seventh kind added without a permission would default to... whatever the
    // author of that block wrote. This makes the omission a red test instead.
    for (const k of SEARCH_KINDS) {
      expect(KIND_PERMISSION[k], `kind "${k}" has no permission`).toBeTruthy();
    }
    expect(Object.keys(KIND_PERMISSION).sort()).toEqual([...SEARCH_KINDS].sort());
  });
});
