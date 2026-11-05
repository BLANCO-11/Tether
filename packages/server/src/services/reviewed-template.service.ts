import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { reviewedTemplates } from "../db/schema.js";

/**
 * B-08 reviewed_templates + B-09 chips most-used derived.
 *
 * Platform catalogue: 34 reviewed templates, no workspace scoping.
 * - curated = is_curated true limit 3 (S-03 three cards)
 * - mostUsed = order by usage_count desc (derived) limit 3 (user chose Most-used)
 * - q search over name/description/slug (S-05 searchable grid, limit=3 vs q= works)
 * - chips GET /templates/suggestions?limit=4 reuses mostUsed 4
 *   — S-01 + S-03 share one PromptComposer component when wired later.
 *
 * Copy semantics (flow_templates) stay workspace-scoped and are unchanged.
 */

export type ReviewedTemplate = typeof reviewedTemplates.$inferSelect;

export type ReviewedTemplateKind = "curated" | "mostUsed";

export interface ReviewedTemplateListParams {
  q?: string;
  limit?: number;
  kind?: ReviewedTemplateKind;
}

function parseLimit(raw: number | undefined, fallback: number): number {
  if (raw === undefined || Number.isNaN(raw)) return fallback;
  const n = Math.trunc(raw);
  if (n < 1) return 1;
  if (n > 50) return 50;
  return n;
}

function normalizeKind(raw: string | undefined): ReviewedTemplateKind | undefined {
  if (!raw) return undefined;
  if (raw === "curated" || raw === "mostUsed" || raw === "most_used" || raw === "most-used") {
    return raw === "curated" ? "curated" : "mostUsed";
  }
  return undefined;
}

export const reviewedTemplateService = {
  normalizeKind,

  async list(params: ReviewedTemplateListParams): Promise<ReviewedTemplate[]> {
    const q = params.q?.trim();
    const kind = params.kind;
    const hasQ = Boolean(q && q.length > 0);

    let limit: number;
    if (hasQ) {
      limit = parseLimit(params.limit, 20);
    } else if (kind === "curated") {
      limit = parseLimit(params.limit, 3);
    } else if (kind === "mostUsed") {
      limit = parseLimit(params.limit, 3);
    } else {
      limit = parseLimit(params.limit, 20);
    }

    if (hasQ && q) {
      const pattern = `%${q}%`;
      const search = or(
        ilike(reviewedTemplates.name, pattern),
        ilike(reviewedTemplates.description, pattern),
        ilike(reviewedTemplates.slug, pattern),
      );
      if (kind === "curated") {
        return db
          .select()
          .from(reviewedTemplates)
          .where(and(eq(reviewedTemplates.isCurated, true), search))
          .orderBy(asc(reviewedTemplates.name))
          .limit(limit);
      }
      if (kind === "mostUsed") {
        return db
          .select()
          .from(reviewedTemplates)
          .where(search)
          .orderBy(desc(reviewedTemplates.usageCount), asc(reviewedTemplates.name))
          .limit(limit);
      }
      return db
        .select()
        .from(reviewedTemplates)
        .where(search)
        .orderBy(asc(reviewedTemplates.name))
        .limit(limit);
    }

    if (kind === "curated") {
      return db
        .select()
        .from(reviewedTemplates)
        .where(eq(reviewedTemplates.isCurated, true))
        .orderBy(asc(reviewedTemplates.name))
        .limit(limit);
    }

    if (kind === "mostUsed") {
      return db
        .select()
        .from(reviewedTemplates)
        .orderBy(desc(reviewedTemplates.usageCount), asc(reviewedTemplates.name))
        .limit(limit);
    }

    return db.select().from(reviewedTemplates).orderBy(asc(reviewedTemplates.name)).limit(limit);
  },

  async getBySlug(slug: string): Promise<ReviewedTemplate | null> {
    const rows = await db
      .select()
      .from(reviewedTemplates)
      .where(eq(reviewedTemplates.slug, slug))
      .limit(1);
    return rows[0] ?? null;
  },

  async incrementUsage(slug: string): Promise<ReviewedTemplate | null> {
    const rows = await db
      .update(reviewedTemplates)
      .set({ usageCount: sql`${reviewedTemplates.usageCount} + 1` })
      .where(eq(reviewedTemplates.slug, slug))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * B-09 chips: 4 suggestions for PromptComposer.
   * S-01 + S-03 share one component when wired later — this is the single source.
   */
  async suggestions(limit = 4): Promise<ReviewedTemplate[]> {
    const n = parseLimit(limit, 4);
    return db
      .select()
      .from(reviewedTemplates)
      .orderBy(desc(reviewedTemplates.usageCount), asc(reviewedTemplates.name))
      .limit(n);
  },
};
