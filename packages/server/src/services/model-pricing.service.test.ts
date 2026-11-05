import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { modelPrices, usageEvents, workspaces } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { costOf, modelPricingService } from "./model-pricing.service.js";

/**
 * The cost rules, against the real database (rbac-observability, 2026-10-15):
 *   - cached prompt tokens are PART of tokens_in and are charged at their own prices, else at the input price;
 *   - a price applies from when it was set — earlier usage keeps the price it had, or the reported cost;
 *   - a price that is REMOVED stops applying: the reported cost is used again;
 *   - spend by model says where each figure came from, and counts what nothing costed.
 */
const stamp = Date.now().toString(36);
const M = { cached: `m-cached-${stamp}`, removed: `m-removed-${stamp}`, none: `m-none-${stamp}` };
let ws = "";
const ids: string[] = [];
let reachable = true;

const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000);
async function row(id: string): Promise<number | null> {
  const [r] = await db.select({ c: costOf() }).from(usageEvents).where(eq(usageEvents.id, id));
  return r?.c == null ? null : Number(r.c);
}

beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
  } catch {
    reachable = false;
    return;
  }
  ws = (await workspaceRepo.create({ name: `pricing ${stamp}`, tenantSlug: "pricing", slug: `pricing-${stamp}` }))!.id;
  // `cached`: input 2, cached 0.5, cache write 2.5, output 8 — set 2 hours ago.
  await db.insert(modelPrices).values({
    model: M.cached, inputPer1m: "2", outputPer1m: "8", cachedInputPer1m: "0.5", cacheWritePer1m: "2.5", effectiveFrom: at(120),
  });
  // `removed`: priced 3 hours ago, removed 1 hour ago.
  await db.insert(modelPrices).values([
    { model: M.removed, inputPer1m: "10", outputPer1m: "10", effectiveFrom: at(180) },
    { model: M.removed, inputPer1m: null, outputPer1m: null, effectiveFrom: at(60) },
  ]);
  const ev = (model: string, minsAgo: number, over: Partial<typeof usageEvents.$inferInsert>) => {
    const id = randomUUID();
    ids.push(id);
    return { id, workspaceId: ws, purpose: "building", kind: "llm", source: "test", model, at: at(minsAgo), ...over };
  };
  await db.insert(usageEvents).values([
    // 1M in of which 400k cache read and 100k cache write, 1M out → 0.5×2 + 0.4×0.5 + 0.1×2.5 + 1×8 = 9.45
    ev(M.cached, 30, { tokensIn: 1_000_000, tokensCached: 400_000, tokensCacheWrite: 100_000, tokensOut: 1_000_000, costUsd: "999" }),
    // Before the price existed: the reported cost.
    ev(M.cached, 240, { tokensIn: 1_000_000, tokensOut: 0, costUsd: "1.25" }),
    // While priced: 1M in at 10.
    ev(M.removed, 120, { tokensIn: 1_000_000, tokensOut: 0, costUsd: "0.1" }),
    // After the removal: the reported cost again.
    ev(M.removed, 10, { tokensIn: 1_000_000, tokensOut: 0, costUsd: "0.2" }),
    // No price ever, nothing reported: costed by nothing.
    ev(M.none, 10, { tokensIn: 500, tokensOut: 500 }),
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  if (ids.length) await db.delete(usageEvents).where(inArray(usageEvents.id, ids));
  await db.delete(modelPrices).where(inArray(modelPrices.model, Object.values(M)));
  if (ws) await db.delete(workspaces).where(eq(workspaces.id, ws));
});

describe.skipIf(!reachable)("model costs", () => {
  it("charges cache reads and writes at their own prices, inside tokens_in", async () => {
    expect(await row(ids[0])).toBeCloseTo(9.45, 6);
  });

  it("keeps the reported cost for usage from before a price was set", async () => {
    expect(await row(ids[1])).toBeCloseTo(1.25, 6);
  });

  it("a removed price stops applying — and only from when it was removed", async () => {
    expect(await row(ids[2])).toBeCloseTo(10, 6);
    expect(await row(ids[3])).toBeCloseTo(0.2, 6);
  });

  it("CONTROL: with no price and nothing reported there is no cost at all, not zero", async () => {
    expect(await row(ids[4])).toBeNull();
  });

  it("spend by model splits priced from reported and counts what nothing costed", async () => {
    const spend = Object.fromEntries((await modelPricingService.spend(1)).map((s) => [s.model, s]));
    // Both `cached` calls are inside one day: one priced (9.45), one from before the price (reported 1.25).
    expect(spend[M.cached]).toMatchObject({ calls: 2, tokensCached: 400_000, uncostedCalls: 0 });
    expect(spend[M.cached].pricedUsd).toBeCloseTo(9.45, 6);
    expect(spend[M.cached].reportedUsd).toBeCloseTo(1.25, 6);
    expect(spend[M.cached].costUsd).toBeCloseTo(10.7, 6);
    // `removed`: one call while priced (10), one after the removal (reported 0.2).
    expect(spend[M.removed].pricedUsd).toBeCloseTo(10, 6);
    expect(spend[M.removed].reportedUsd).toBeCloseTo(0.2, 6);
    expect(spend[M.none]).toMatchObject({ calls: 1, uncostedCalls: 1, costUsd: 0 });
  });

  it("the current price list leaves out a removed price; the history keeps the removal", async () => {
    const current = (await modelPricingService.current()).map((p) => p.model);
    expect(current).toContain(M.cached);
    expect(current).not.toContain(M.removed);
    const removed = (await modelPricingService.history()).filter((h) => h.model === M.removed);
    expect(removed.map((h) => h.inputPer1m)).toEqual([null, 10]);
    expect((await modelPricingService.current()).find((p) => p.model === M.cached)).toMatchObject({ cachedInputPer1m: 0.5, cacheWritePer1m: 2.5 });
  });
});
