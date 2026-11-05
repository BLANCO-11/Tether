/**
 * Model prices — US dollars per 1M tokens, per model (rbac-observability, 2026-10-15).
 *
 * Set on the model settings page by whoever holds `platform.generation.write`. Insert-only: every change is a new row,
 * so what a model cost last month stays what it cost last month. `costOf` is the ONE definition of a usage row's cost
 * and every summary sums it:
 *
 *   - a price in effect when the usage happened → tokens × price. Cached prompt tokens are part of `tokens_in`: a
 *     cache READ is charged at the cached-input price and a cache WRITE at the cache-write price, each falling back to
 *     the input price when not set (0104);
 *   - no price in effect (none ever set, or the latest change REMOVED it) → the cost the producer reported (the
 *     gateway's or Pi's own figure), or nothing.
 */
import { desc, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { modelPrices, usageEvents } from "../db/schema.js";

export interface ModelPriceView {
  model: string;
  inputPer1m: number | null;
  outputPer1m: number | null;
  /** A cache read. Null: charged at the input price. */
  cachedInputPer1m: number | null;
  /** A cache write. Null: charged at the input price. */
  cacheWritePer1m: number | null;
  effectiveFrom: string;
  updatedBy: string | null;
}

export interface ModelPriceInput {
  inputPer1m: number | null;
  outputPer1m: number | null;
  cachedInputPer1m?: number | null;
  cacheWritePer1m?: number | null;
}

/** What each model cost over a window, and where each figure came from. */
export interface ModelSpend {
  model: string;
  calls: number;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  /** Everything: priced + reported. */
  costUsd: number;
  /** From a price set here. */
  pricedUsd: number;
  /** From what the producer reported, where no price was in effect. */
  reportedUsd: number;
  /** Calls with no price in effect AND no reported cost — missing from every total until a price is set. */
  uncostedCalls: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * The cost of one `usage_events` row under the price in effect at its time, as SQL — NULL when no price is in effect
 * (never set, or the latest row is a removal with every price NULL).
 */
function pricedCostOf(): SQL<string> {
  return sql<string>`(
    select case
      when p.input_per_1m is null and p.output_per_1m is null then null
      else (
        greatest(coalesce(${usageEvents.tokensIn}, 0) - coalesce(${usageEvents.tokensCached}, 0) - coalesce(${usageEvents.tokensCacheWrite}, 0), 0)
          * coalesce(p.input_per_1m, 0)
        + coalesce(${usageEvents.tokensCached}, 0) * coalesce(p.cached_input_per_1m, p.input_per_1m, 0)
        + coalesce(${usageEvents.tokensCacheWrite}, 0) * coalesce(p.cache_write_per_1m, p.input_per_1m, 0)
        + coalesce(${usageEvents.tokensOut}, 0) * coalesce(p.output_per_1m, 0)
      ) / 1000000
    end
      from ${modelPrices} p
     where p.model = ${usageEvents.model} and p.effective_from <= ${usageEvents.at}
     order by p.effective_from desc
     limit 1
  )`;
}

/** The cost of one `usage_events` row, as SQL. The price in effect at the row's time wins; else what was reported. */
export function costOf(): SQL<string> {
  return sql<string>`coalesce(${pricedCostOf()}, ${usageEvents.costUsd})`;
}

function view(r: typeof modelPrices.$inferSelect): ModelPriceView {
  return {
    model: r.model,
    inputPer1m: num(r.inputPer1m),
    outputPer1m: num(r.outputPer1m),
    cachedInputPer1m: num(r.cachedInputPer1m),
    cacheWritePer1m: num(r.cacheWritePer1m),
    effectiveFrom: r.effectiveFrom.toISOString(),
    updatedBy: r.updatedBy,
  };
}

const price = (n: number | null | undefined) => (n == null ? null : n.toFixed(6));

export const modelPricingService = {
  /** The price currently in effect for every model that has ever had one (a removed price is omitted). */
  async current(): Promise<ModelPriceView[]> {
    const rows = await db
      .selectDistinctOn([modelPrices.model])
      .from(modelPrices)
      .orderBy(modelPrices.model, desc(modelPrices.effectiveFrom));
    return rows.filter((r) => r.inputPer1m != null || r.outputPer1m != null).map(view);
  },

  /** Every change, newest first — removals included, so the history says when a price stopped applying. */
  async history(limit = 500): Promise<ModelPriceView[]> {
    const rows = await db.select().from(modelPrices).orderBy(desc(modelPrices.effectiveFrom)).limit(limit);
    return rows.map(view);
  },

  /** Every model usage has been recorded for — what there is to price. */
  async modelsSeen(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ model: usageEvents.model })
      .from(usageEvents)
      .where(sql`${usageEvents.model} is not null and ${usageEvents.kind} = 'llm'`);
    return rows.map((r) => r.model!).sort();
  },

  /** What each model cost across the deployment over the last `days`, split by where the cost came from. */
  async spend(days: number): Promise<ModelSpend[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const priced = pricedCostOf();
    const rows = await db
      .select({
        model: usageEvents.model,
        calls: sql<string>`count(*)`,
        tokensIn: sql<string>`coalesce(sum(${usageEvents.tokensIn}), 0)`,
        tokensCached: sql<string>`coalesce(sum(${usageEvents.tokensCached}), 0)`,
        tokensOut: sql<string>`coalesce(sum(${usageEvents.tokensOut}), 0)`,
        pricedUsd: sql<string>`coalesce(sum(${priced}), 0)`,
        reportedUsd: sql<string>`coalesce(sum(case when ${priced} is null then ${usageEvents.costUsd} end), 0)`,
        uncosted: sql<string>`count(*) filter (where ${priced} is null and ${usageEvents.costUsd} is null)`,
      })
      .from(usageEvents)
      .where(sql`${usageEvents.kind} = 'llm' and ${usageEvents.model} is not null and ${usageEvents.at} >= ${since}`)
      .groupBy(usageEvents.model);
    return rows
      .map((r) => {
        const pricedUsd = Number(r.pricedUsd);
        const reportedUsd = Number(r.reportedUsd);
        return {
          model: r.model!,
          calls: Number(r.calls),
          tokensIn: Number(r.tokensIn),
          tokensCached: Number(r.tokensCached),
          tokensOut: Number(r.tokensOut),
          costUsd: pricedUsd + reportedUsd,
          pricedUsd,
          reportedUsd,
          uncostedCalls: Number(r.uncosted),
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));
  },

  /** Set a model's price from now on. Null input and output removes it (reported costs are used again). */
  async set(model: string, p: ModelPriceInput, updatedBy: string | null): Promise<void> {
    const removing = p.inputPer1m == null && p.outputPer1m == null;
    await db.insert(modelPrices).values({
      model,
      inputPer1m: price(p.inputPer1m),
      outputPer1m: price(p.outputPer1m),
      cachedInputPer1m: removing ? null : price(p.cachedInputPer1m),
      cacheWritePer1m: removing ? null : price(p.cacheWritePer1m),
      updatedBy,
    });
  },
};
