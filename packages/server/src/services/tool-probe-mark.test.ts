import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { tools, workspaces } from "../db/schema.js";
import { toolService } from "./tool.service.js";
import { markFor, resetProbeMarks, setMark, type ToolProbeMark } from "./tool-probe-mark.js";

/**
 * The tested marker — `specs/20260818-123807-tool-probe` · P3 · T23.
 *
 * ⚠ **The property that matters is DROPPING, not remembering.** A marker that is
 * kept across an edit that repointed the URL is worse than no marker at all: it
 * looks current, and it is the one line on the row a person would trust. So every
 * test below that asserts survival is paired with one that asserts a drop, and the
 * "description-only edit keeps it" case is the control that stops `dropMark` being
 * satisfied by dropping on every write.
 *
 * ⚠ Against a REAL database, like `tool-usedby.test.ts` — `toolService.update`'s
 * whole job here is comparing the row before the write to the row after it, and a
 * mocked repo would be asserting my own arithmetic rather than the service's.
 *
 * ⚠ **ONE workspace, and the tenancy case uses a random id instead of a second
 * one.** `datasource-target.test.ts`' negative control documents the reason: test
 * FILES run in parallel against one database, and every additional file that
 * creates and deletes workspaces raises the chance of a concurrent sweep in
 * another file timing out or hitting a foreign-key race. Measured — adding this
 * file took that control from 0 failures in 6 full-suite runs to 1. The marker is
 * an in-process `Map` keyed by a STRING, so proving it does not cross a tenant
 * needs no second row at all.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[probe-mark] SKIPPING — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

let wsId: string;
let toolId: string;

const MARK: ToolProbeMark = {
  at: "2026-08-24T09:00:00.000Z",
  verdict: "ok",
  mode: "live",
  status: 200,
};

beforeAll(async () => {
  if (!reachable) return;
  const [ws] = await db
    .insert(workspaces)
    .values({ name: `probe-mark-test-${Date.now()}` })
    .returning();
  wsId = ws.id;
});

/** A fresh tool per test — `update` mutates the row the previous test asserted on. */
beforeEach(async () => {
  if (!reachable) return;
  resetProbeMarks();
  const [t] = await db
    .insert(tools)
    .values({
      workspaceId: wsId,
      name: `probe_mark_subject_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      description: "the subject",
      url: "https://api.example.com/incidents",
      method: "GET",
    })
    .returning({ id: tools.id });
  toolId = t.id;
});

afterAll(async () => {
  if (reachable && wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  await pool.end().catch(() => {});
});

describe.skipIf(!reachable)("the marker travels on `list` and `get`", () => {
  it("attaches the mark to the listed row", async () => {
    setMark(wsId, toolId, MARK);

    const listed = (await toolService.list(wsId)).find((t) => t.id === toolId)!;
    expect(listed.lastProbe).toEqual(MARK);
    expect((await toolService.get(wsId, toolId))!.lastProbe).toEqual(MARK);
  });

  /**
   * ⚠ **`null`, not a zero-value stand-in.** The opposite convention to `usedBy`,
   * and deliberately: `usedBy: 0` is a real count, while "not tested" is the
   * absence of a fact. The client's rule (T22) is that absence renders NOTHING, so
   * it needs a field it can distinguish from a verdict.
   */
  it("reads `null` — never a placeholder — for a tool nobody has probed", async () => {
    const listed = (await toolService.list(wsId)).find((t) => t.id === toolId)!;
    expect(listed.lastProbe).toBeNull();
  });

  /**
   * ⚠ The key is `${workspaceId}:${toolId}`, so a mark cannot cross a tenant.
   *
   * ⚠ A random workspace id, not a second real row — see the header. The marker is
   * a `Map` keyed by a string; a workspace that exists proves nothing extra here,
   * and creating one costs a real database another insert/delete under a suite that
   * already runs in parallel with twenty others.
   */
  it("does not leak a mark into another workspace's read of the same id", async () => {
    setMark(wsId, toolId, MARK);
    expect(markFor(crypto.randomUUID(), toolId)).toBeUndefined();
  });
});

describe.skipIf(!reachable)("an edit that moves a DIALLED field forgets the verdict", () => {
  it.each([
    ["url", { url: "https://api.example.com/v2/incidents" }],
    ["method", { method: "POST" }],
    ["authStyle", { authStyle: "bearer" as const, secretEnvName: "SOME_KEY" }],
    ["secretEnvName", { secretEnvName: "OTHER_KEY", authStyle: "bearer" as const }],
  ])("drops it when %s moves", async (_field, patch) => {
    setMark(wsId, toolId, MARK);

    await toolService.update(wsId, toolId, patch as Parameters<typeof toolService.update>[2]);

    expect(markFor(wsId, toolId)).toBeUndefined();
  });

  /**
   * ⚠ **THE CONTROL.** Without this, `dropMark` could be called on every write and
   * every test above would still pass — and "tested" would vanish whenever
   * somebody fixed a typo in a description, which is how a marker becomes a thing
   * people stop looking at.
   */
  it("KEEPS it across a description-only edit", async () => {
    setMark(wsId, toolId, MARK);

    await toolService.update(wsId, toolId, { description: "a better sentence" });

    expect(markFor(wsId, toolId)).toEqual(MARK);
  });

  /**
   * ⚠ A PATCH that names a dialled field with the value it already has has moved
   * nothing. The comparison is before-row vs after-row for exactly this reason —
   * reading the request body would drop the mark here.
   */
  it("KEEPS it when a dialled field is re-sent unchanged", async () => {
    setMark(wsId, toolId, MARK);

    await toolService.update(wsId, toolId, { method: "GET" });

    expect(markFor(wsId, toolId)).toEqual(MARK);
  });

  /**
   * ⚠ The trio follows the STYLE, not the payload: switching away from oauth2
   * clears `tokenUrl` and both refs even though the body never names them. That is
   * a dial that moved, and only a before/after comparison sees it.
   */
  it("drops it when a style switch silently clears the OAuth2 trio", async () => {
    await toolService.update(wsId, toolId, {
      authStyle: "oauth2_client_credentials",
      tokenUrl: "https://api.example.com/oauth/token",
      clientIdSecretRef: "CLIENT_ID",
      clientSecretSecretRef: "CLIENT_SECRET",
    });
    setMark(wsId, toolId, MARK);

    // The body says nothing about tokenUrl or the refs; the write clears all three.
    await toolService.update(wsId, toolId, { authStyle: "none" });

    expect(markFor(wsId, toolId)).toBeUndefined();
  });

  it("drops it unconditionally on remove", async () => {
    setMark(wsId, toolId, MARK);

    await toolService.remove(wsId, toolId);

    expect(markFor(wsId, toolId)).toBeUndefined();
  });
});
