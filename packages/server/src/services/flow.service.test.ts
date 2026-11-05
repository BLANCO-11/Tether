import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { flowService } from "./flow.service.js";

/**
 * The TOCTOU race behind the "duplicate flow" bug: `flowService.create`
 * pre-checks `getByKestraFlowId` before inserting, so two concurrent creates
 * with the same `model.id` can both pass the check before either writes. The
 * loser used to hit the raw `uq_flows_workspace_flow_id` constraint directly
 * and surface as an unhandled Postgres error.
 *
 * This stays at the REPOSITORY layer on purpose, mirroring
 * `flow-replay.test.ts`'s own rule: a plain `vitest` run never reaches a live
 * Kestra (its network publishes no port), and `flowService.create` reaches
 * one via `writeRevision` → `assertKestraAccepts`. The race itself lives
 * entirely in `flowRepo.create`'s conflict handling — testing it here proves
 * the fix without depending on infra no other unit test in this file depends on.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[flow.service] SKIPPING race test — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

let workspaceId: string;

beforeAll(async () => {
  if (!reachable) return;
  const [ws] = await db
    .insert(workspaces)
    .values({ name: `flow-race-${Date.now()}`, description: "flow.repo race test; safe to delete" })
    .returning();
  workspaceId = ws.id;
});

afterAll(async () => {
  if (reachable && workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
});

describe.skipIf(!reachable)("flowRepo.create — concurrent inserts with the same (workspaceId, kestraFlowId)", () => {
  it("lets exactly one insert win and returns undefined to the other, never a raw pg error", async () => {
    const kestraFlowId = `race-${Date.now()}`;
    const row = () => ({
      workspaceId,
      name: "Race test flow",
      description: null,
      kestraFlowId,
      draftRevision: 0,
      status: "draft" as const,
    });

    const results = await Promise.all([flowRepo.create(row()), flowRepo.create(row())]);

    const won = results.filter((r) => r !== undefined);
    const lost = results.filter((r) => r === undefined);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `hideRevision` — the Versions tab's "Delete"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **The load-bearing property is the one that is easy to leave untested: the
 * row is still there afterwards.** A test that only checks the revision left
 * the list would pass just as happily over a hard `DELETE` — and the damage
 * from that is invisible until somebody replays a run or opens a diff, which is
 * days later and nowhere near this code.
 *
 * At the repository/service layer for the same reason the race test above is:
 * a plain `vitest` run reaches no Kestra, and `writeRevision` does.
 */
/**
 * -----------------------------------------------------------------------------
 * `saveDraft` - one version per conversation, not one per sentence
 * -----------------------------------------------------------------------------
 *
 * WARNING **Reported from use:** "in chat when we make a change it increments the
 * version for each change instead of session as a whole, also version should
 * not show up until user says save draft."
 *
 * Measured on the live database: one authoring conversation left SIX revisions
 * from five turns - one per applied turn plus one for a canvas gesture made in
 * chat mode. `ChatWorkbench` said so in its own comment ("Every op writes a
 * revision immediately - this surface cannot stage") and nothing acted on it.
 *
 * WARNING **The mechanism is `hidden_at`, which already existed**, and the tests
 * below are about the two halves that make reuse honest: the intermediate
 * revisions stay READABLE (a hide is not a delete), and saving is IDEMPOTENT
 * (pressing it twice asks for a state that already holds).
 */
describe.skipIf(!reachable)("flowService.saveDraft", () => {
  const mkFlow = async (hiddenRevisions: number[]) => {
    const stamp = `save-${Date.now()}-${Math.random()}`;
    const flow = await flowRepo.create({
      workspaceId,
      name: stamp,
      description: null,
      kestraFlowId: stamp,
      draftRevision: 3,
      status: "draft" as const,
    });
    for (const revision of [1, 2, 3]) {
      await flowRepo.insertRevision({
        flowId: flow!.id,
        revision,
        modelJson: { name: "m", steps: [] } as never,
        compiledYamlHash: `h${revision}`,
        structureHash: `s${revision}`,
        createdByKind: "system",
        hiddenAt: hiddenRevisions.includes(revision) ? new Date() : null,
      });
    }
    return flow!;
  };

  it("WARNING a conversation leaves NOTHING in the list until it is saved", async () => {
    const flow = await mkFlow([1, 2, 3]);
    // The control: this is the state a chat session produces - three turns,
    // three revisions, an empty version list.
    expect(await flowRepo.listRevisions(flow.id)).toEqual([]);

    await flowService.saveDraft(workspaceId, flow.id);

    // One entry, and it is the draft - not three.
    expect((await flowRepo.listRevisions(flow.id)).map((r) => r.revision)).toEqual([3]);
  });

  /**
   * WARNING The half that makes this a hide and not a loss. The intermediate turns
   * are still readable, so a diff against them, a replay of a run that used one,
   * and any approval pointing at one all keep working. A version of this that
   * deleted them would pass the test above.
   */
  it("leaves every intermediate revision READABLE, just not listed", async () => {
    const flow = await mkFlow([1, 2, 3]);
    await flowService.saveDraft(workspaceId, flow.id);

    for (const revision of [1, 2]) {
      const still = await flowRepo.getRevision(flow.id, revision);
      expect(still, `revision ${revision} was destroyed, not hidden`).toBeDefined();
      expect(still!.hiddenAt).toBeTruthy();
    }
  });

  it("is idempotent, and says which case it was", async () => {
    const flow = await mkFlow([1, 2, 3]);
    expect((await flowService.saveDraft(workspaceId, flow.id)).alreadyVisible).toBe(false);
    // Pressing it again asks for a state that already holds. Refusing would be
    // a refusal about bookkeeping rather than about the flow.
    expect((await flowService.saveDraft(workspaceId, flow.id)).alreadyVisible).toBe(true);
    expect((await flowRepo.listRevisions(flow.id)).map((r) => r.revision)).toEqual([3]);
  });

  /**
   * WARNING A flow authored anywhere ELSE is untouched. Only the chat turn opts into
   * a hidden write; `writeRevision` defaults to visible, because a default of
   * hidden would silently empty the version list for every path in the product.
   */
  it("does nothing to a flow whose revisions were never hidden", async () => {
    const flow = await mkFlow([]);
    const before = (await flowRepo.listRevisions(flow.id)).map((r) => r.revision);
    expect(before).toEqual([3, 2, 1]);
    expect((await flowService.saveDraft(workspaceId, flow.id)).alreadyVisible).toBe(true);
    expect((await flowRepo.listRevisions(flow.id)).map((r) => r.revision)).toEqual(before);
  });
});

describe.skipIf(!reachable)("flowService.hideRevision", () => {
  const mkFlow = async () => {
    const flow = await flowRepo.create({
      workspaceId,
      name: `hide-${Date.now()}-${Math.random()}`,
      description: null,
      kestraFlowId: `hide-${Date.now()}-${Math.random()}`,
      draftRevision: 3,
      status: "draft" as const,
    });
    for (const revision of [1, 2, 3]) {
      await flowRepo.insertRevision({
        flowId: flow!.id,
        revision,
        modelJson: { name: "m", steps: [] } as never,
        compiledYamlHash: `h${revision}`,
        structureHash: `s${revision}`,
        createdByKind: "system",
      });
    }
    return flow!;
  };

  it("removes a revision from the list and LEAVES THE ROW", async () => {
    const flow = await mkFlow();
    await flowService.hideRevision(workspaceId, flow.id, 1);

    const listed = await flowRepo.listRevisions(flow.id);
    expect(listed.map((r) => r.revision).sort()).toEqual([2, 3]);

    // ⚠ The half that makes it a hide and not a delete. `getRevision` is
    // deliberately unfiltered, so a replay of a run that used revision 1, and a
    // diff against it, both still work.
    const still = await flowRepo.getRevision(flow.id, 1);
    expect(still).toBeDefined();
    expect(still!.hiddenAt).toBeTruthy();
  });

  it("refuses the DRAFT, and says which revision and why", async () => {
    const flow = await mkFlow();
    await expect(flowService.hideRevision(workspaceId, flow.id, 3)).rejects.toThrow(
      /current draft/i,
    );
    expect((await flowRepo.listRevisions(flow.id)).length).toBe(3);
  });

  it("refuses the LIVE revision, and points at stopping it first", async () => {
    const flow = await mkFlow();
    await flowRepo.update(flow.id, { armedRevision: 2 });
    await expect(flowService.hideRevision(workspaceId, flow.id, 2)).rejects.toThrow(/live/i);
    // And the sentence names the way out rather than only the refusal.
    await expect(flowService.hideRevision(workspaceId, flow.id, 2)).rejects.toThrow(
      /Stop using it first/i,
    );
  });

  it("is idempotent — hiding a hidden revision is not an error", async () => {
    const flow = await mkFlow();
    await flowService.hideRevision(workspaceId, flow.id, 1);
    const again = await flowService.hideRevision(workspaceId, flow.id, 1);
    expect(again.alreadyHidden).toBe(true);
  });

  it("404s on a revision that does not exist", async () => {
    const flow = await mkFlow();
    await expect(flowService.hideRevision(workspaceId, flow.id, 99)).rejects.toThrow(
      /does not exist/i,
    );
  });
});
