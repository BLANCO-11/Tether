/**
 * Workflow references, against the real database: same workspace only, saved workflows only, never the chat's own,
 * at most 3, Workflow Builder only, pinned until the person moves it, and readable after the workflow is deleted.
 * Creates its own workspaces and removes them afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Opening a session warms a Forge process; none is needed here, so it is one that exits at once.
vi.hoisted(() => {
  process.env.PI_BIN = "/bin/true";
  delete process.env.FORGE_HOST;
});
import { inArray } from "drizzle-orm";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { db, pool } from "../db/index.js";
import { flows, workspaces } from "../db/schema.js";
import { workspaceService } from "../services/workspace.service.js";
import { piFlowService } from "../services/pi-flow.service.js";
import { systemAuthor } from "../services/revision-author.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { piChatRepo } from "../repositories/pi-chat.repo.js";
import { CATALOGUE_ROOT, SANDBOXES_ROOT } from "./paths.js";
import { piBuilderService } from "./service.js";
import { loadRefs, newRef, snapshotOf, storeRef } from "./reference-state.js";

const made: string[] = [];
let A = "";
let B = "";

const bundle = (label: string) => ({
  workflow: {
    name: label,
    inputs: { month: { type: "string", default: "2026-09" } },
    steps: [{ id: "report", entry: "steps/report/main.py", outputs: ["rows"], description: `Build ${label}.` }],
  },
  files: { "steps/report/main.py": `# ${label}\nthreshold = 9.5\n` },
});

async function saveFlow(ws: string, name: string, flowId: string | null = null) {
  return piFlowService.save({ workspaceId: ws, flowId, bundle: bundle(name) as never, name, description: `Purpose of ${name}`, author: systemAuthor() });
}

beforeAll(async () => {
  A = (await workspaceService.create({ name: `Refs A ${Date.now()}` })).id;
  B = (await workspaceService.create({ name: `Refs B ${Date.now()}` })).id;
  made.push(A, B);
});

afterAll(async () => {
  await db.delete(flows).where(inArray(flows.workspaceId, made));
  await db.delete(workspaces).where(inArray(workspaces.id, made));
  for (const ws of made) {
    rmSync(join(SANDBOXES_ROOT, ws), { recursive: true, force: true });
    rmSync(join(CATALOGUE_ROOT, ws), { recursive: true, force: true });
  }
  await pool.end();
});

describe("what can be referenced", () => {
  it("is this workspace's saved workflows only — not another workspace's, not one never saved, not the chat's own", async () => {
    const x = await saveFlow(A, "Attendance");
    const other = await saveFlow(B, "Elsewhere");
    const unsaved = await flowRepo.create({
      id: crypto.randomUUID(),
      workspaceId: A,
      name: "Never saved",
      description: null,
      kestraFlowId: `never-saved-${Date.now()}`,
      draftRevision: 0,
      status: "draft",
      runtime: "foundry",
    });

    const s = await piBuilderService.create(A, { goal: "" });
    const names = (await piBuilderService.referenceable(A, s.id)).map((w) => w.name);
    expect(names).toContain("Attendance");
    expect(names).not.toContain("Elsewhere");
    expect(names).not.toContain("Never saved");

    await expect(piBuilderService.addReference(A, s.id, other.flowId, null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(piBuilderService.addReference(A, s.id, unsaved!.id, null)).rejects.toMatchObject({ statusCode: 409 });

    const own = await piBuilderService.create(A, { flowId: x.flowId });
    expect((await piBuilderService.referenceable(A, own.id)).map((w) => w.flowId)).not.toContain(x.flowId);
    await expect(piBuilderService.addReference(A, own.id, x.flowId, null)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("a reference", () => {
  it("pins the latest saved version, stays there when a newer one is saved, and moves only when asked", async () => {
    const x = await saveFlow(A, "Pinned");
    const s = await piBuilderService.create(A, { goal: "" });
    let [ref] = await piBuilderService.addReference(A, s.id, x.flowId, "someone");
    expect(ref!.revision).toBe(1);
    expect(ref!.label).toBe("saved 1 · not approved");
    expect(ref!.newer).toBeNull();
    expect(ref!.cardMd).toContain("Saved version 1");

    await saveFlow(A, "Pinned", x.flowId);
    [ref] = await piBuilderService.references(A, s.id);
    expect(ref!.revision).toBe(1);
    expect(ref!.newer).toBe(2);
    expect(ref!.versions.map((v) => v.revision)).toEqual([1, 2]);

    [ref] = await piBuilderService.setReferenceVersion(A, s.id, ref!.id, 2);
    expect(ref!.revision).toBe(2);
    expect(ref!.newer).toBeNull();
    [ref] = await piBuilderService.setReferenceVersion(A, s.id, ref!.id, 1);
    expect(ref!.revision).toBe(1);
    await expect(piBuilderService.setReferenceVersion(A, s.id, ref!.id, 9)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("is refused past three, and a duplicate is refused", async () => {
    const s = await piBuilderService.create(A, { goal: "" });
    const ids = [];
    for (const n of ["One", "Two", "Three", "Four"]) ids.push((await saveFlow(A, `Limit ${n}`)).flowId);
    for (const id of ids.slice(0, 3)) await piBuilderService.addReference(A, s.id, id, null);
    await expect(piBuilderService.addReference(A, s.id, ids[0]!, null)).rejects.toMatchObject({ statusCode: 409 });
    await expect(piBuilderService.addReference(A, s.id, ids[3]!, null)).rejects.toThrow(/at most 3/);
    const views = await piBuilderService.references(A, s.id);
    await piBuilderService.removeReference(A, s.id, views[0]!.id);
    expect(await piBuilderService.addReference(A, s.id, ids[3]!, null)).toHaveLength(3);
  });

  it("is refused in Forge Agent mode", async () => {
    const C = (await workspaceService.create({ name: `Refs C ${Date.now()}`, assistant: true })).id;
    made.push(C);
    const x = await saveFlow(C, "Agentless");
    const s = await piBuilderService.create(C, { goal: "", mode: "agent" });
    expect(s.mode).toBe("agent");
    await expect(piBuilderService.addReference(C, s.id, x.flowId, null)).rejects.toThrow(/Workflow Builder only/);
  });

  it("is stored with its chat, and stays readable from its copy after the workflow is deleted", async () => {
    const x = await saveFlow(A, "Soon deleted");
    const chatId = await piChatRepo.create({ workspaceId: A, flowId: null, title: "t", goal: "", createdBy: null });
    await storeRef(A, chatId, newRef(await snapshotOf(A, x.flowId), "someone"));
    await db.delete(flows).where(inArray(flows.id, [x.flowId]));
    const [ref] = await loadRefs(A, chatId);
    expect(ref!.flowId).toBeNull();
    expect(ref!.name).toBe("Soon deleted");
    expect(ref!.bundle.files["steps/report/main.py"]).toContain("threshold = 9.5");

    const s = await piBuilderService.create(A, { chatId });
    const [view] = await piBuilderService.references(A, s.id);
    expect(view!.deleted).toBe(true);
    expect(view!.versions).toEqual([]);
    await expect(piBuilderService.setReferenceVersion(A, s.id, view!.id, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("only what the person may see (rbac-observability)", () => {
  // A Creator: sees their own drafts and anything published, not somebody else's private draft.
  const creator = { subject: "creator-a", all: false, reviewer: false, write: true };

  it("somebody else's private draft is neither offered nor addable; one's own and a published one are", async () => {
    const mine = await saveFlow(A, "Mine draft");
    const theirs = await saveFlow(A, "Their draft");
    const published = await saveFlow(A, "Their published");
    await flowRepo.setOwner(A, mine.flowId, "creator-a");
    await flowRepo.setOwner(A, theirs.flowId, "creator-b");
    await flowRepo.setOwner(A, published.flowId, "creator-b");
    // Shared with everyone by its PLACE, not by approval (0112; sharing-boundaries: the Workspace).
    await db.update(flows).set({ visibility: "public" }).where(inArray(flows.id, [published.flowId]));

    const s = await piBuilderService.create(A, { goal: "" });
    const names = (await piBuilderService.referenceable(A, s.id, creator)).map((w) => w.name);
    expect(names).toContain("Mine draft");
    expect(names).toContain("Their published");
    expect(names).not.toContain("Their draft");
    // Control: without a viewer (a harness) the private draft IS listed, so the filter is what removed it.
    expect((await piBuilderService.referenceable(A, s.id)).map((w) => w.name)).toContain("Their draft");

    // Named in the body: not found, exactly as a workflow that is not there.
    await expect(piBuilderService.addReference(A, s.id, theirs.flowId, "creator-a", creator)).rejects.toMatchObject({ statusCode: 404 });
    const added = await piBuilderService.addReference(A, s.id, published.flowId, "creator-a", creator);
    expect(added.map((r) => r.name)).toContain("Their published");
  });
});
