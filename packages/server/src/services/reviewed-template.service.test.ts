import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db/index.js";
import { reviewedTemplateService } from "./reviewed-template.service.js";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { SignJWT } from "jose";

const reachable = await (async () => {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
})();

describe("migration 0049_reviewed_templates (B-08)", () => {
  it("sql file exists and defines reviewed_templates with required columns and indexes", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const sql = await readFile(path.join(dir, "0049_reviewed_templates.sql"), "utf8");
    expect(sql).toContain("reviewed_templates");
    expect(sql).toContain("slug");
    expect(sql).toContain("eyebrow");
    expect(sql).toContain("name");
    expect(sql).toContain("description");
    expect(sql).toContain("includes");
    expect(sql).toContain("text[]");
    expect(sql).toContain("usage_count");
    expect(sql).toContain("is_curated");
    expect(sql).toContain("review_status");
    expect(sql).toContain("created_at");
    expect(sql).toContain("uq_reviewed_templates_slug");
    expect(sql).toContain("idx_reviewed_templates_curated");
    expect(sql).toContain("idx_reviewed_templates_usage");
    expect(sql).toContain("Monthly compliance check");
    expect(sql).toContain("Chase missing submissions");
    expect(sql).toContain("New joiner setup");
  });

  it("journal contains idx 49 for 0049_reviewed_templates", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const txt = await readFile(path.join(dir, "meta/_journal.json"), "utf8");
    const j = JSON.parse(txt) as { entries: Array<{ idx: number; tag: string }> };
    const e = j.entries.find((x) => x.tag === "0049_reviewed_templates");
    expect(e).toBeDefined();
    expect(e?.idx).toBe(49);
  });

  it("sql seeds 34 rows (3 curated + 31 filler) so limit=3 vs q= works", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const sql = await readFile(path.join(dir, "0049_reviewed_templates.sql"), "utf8");
    const insertSection = sql.split("INSERT INTO")[1] ?? "";
    // Count value tuples: each row starts with '(' after VALUES
    const rows = insertSection.split("),").length;
    // Alternative: count slug occurrences
    const slugMatches = insertSection.match(/'[^']+-check'|'[a-z-]+'/g) ?? [];
    // Simple: count number of "reviewed" occurrences should be >=34 plus header
    expect(insertSection).toContain("monthly-compliance-check");
    // Ensure 34 DISTINCT slugs inserted
    const slugCount = (insertSection.match(/'([a-z-]+)'/g) ?? []).filter((s) => s.includes("-")).length;
    expect(slugCount).toBeGreaterThanOrEqual(34);
    // More precise: count VALUES lines
    const valuesLines = insertSection.split("\n").filter((l) => l.trim().startsWith("(")).length;
    expect(valuesLines).toBe(34);
  });
});

describe.skipIf(!reachable)("reviewedTemplateService integration (B-08 + B-09)", () => {
  it("list curated returns exactly 3 curated rows", async () => {
    const rows = await reviewedTemplateService.list({ kind: "curated", limit: 3 });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.isCurated).toBe(true);
    }
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["Chase missing submissions", "Monthly compliance check", "New joiner setup"].sort());
  });

  it("list mostUsed returns 3 ordered by usage_count desc", async () => {
    const rows = await reviewedTemplateService.list({ kind: "mostUsed", limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0].usageCount).toBeGreaterThanOrEqual(rows[1].usageCount);
    expect(rows[1].usageCount).toBeGreaterThanOrEqual(rows[2].usageCount);
    // Top should be the filler high-usage rows, not curated (curated max 120)
    expect(rows[0].slug).toBe("monthly-compliance-report");
    expect(rows[1].slug).toBe("chase-missing-timesheets");
    expect(rows[2].slug).toBe("weekly-leave-digest");
  });

  it("list q filters by name/description/slug", async () => {
    const rows = await reviewedTemplateService.list({ q: "compliance", limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      const hay = `${r.name} ${r.description} ${r.slug}`.toLowerCase();
      expect(hay).toContain("compliance");
    }
  });

  it("getBySlug returns single row and 404 helper", async () => {
    const row = await reviewedTemplateService.getBySlug("new-joiner-setup");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("New joiner setup");
    const missing = await reviewedTemplateService.getBySlug("does-not-exist-xyz");
    expect(missing).toBeNull();
  });

  it("suggestions limit=4 returns 4 mostUsed for chips (B-09)", async () => {
    const rows = await reviewedTemplateService.suggestions(4);
    expect(rows).toHaveLength(4);
    expect(rows[0].usageCount).toBeGreaterThanOrEqual(rows[1].usageCount);
    expect(rows[3].usageCount).toBeGreaterThan(120); // still high, not curated
  });

  it("incrementUsage increments count", async () => {
    const before = await reviewedTemplateService.getBySlug("monthly-compliance-check");
    expect(before).not.toBeNull();
    const after = await reviewedTemplateService.incrementUsage("monthly-compliance-check");
    expect(after?.usageCount).toBe((before?.usageCount ?? 0) + 1);
    // revert
    await reviewedTemplateService.incrementUsage("monthly-compliance-check"); // increment again to check idempotence? Actually we need to decrement back
    // decrement via raw query to restore
    // revert via direct SQL to restore - use pool query
    await pool.query(`UPDATE reviewed_templates SET usage_count = usage_count - 2 WHERE slug = 'monthly-compliance-check'`);
  });
});

describe("reviewedTemplateService no any", () => {
  it("source contains no ': any' or 'as any'", async () => {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "reviewed-template.service.ts");
    const src = await readFile(p, "utf8");
    expect(src).not.toMatch(/:\s*any\b/);
    expect(src).not.toMatch(/\bas\s+any\b/);
  });
});

describe("reviewed-templates route file no any and platform level", () => {
  it("route file exists, has requireIdentity, no any, and suggestions before :slug", async () => {
    const p = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../routes/reviewed-templates.ts",
    );
    const src = await readFile(p, "utf8");
    expect(src).toContain("requireIdentity");
    expect(src).toContain("/suggestions");
    expect(src).toContain("reviewedTemplateService");
    expect(src).not.toMatch(/:\s*any\b/);
    expect(src).not.toMatch(/\bas\s+any\b/);
    // suggestions must be registered before :slug
    const suggIdx = src.indexOf('"/suggestions"');
    const slugIdx = src.indexOf('"/:slug"');
    expect(suggIdx).toBeLessThan(slugIdx);
    expect(src).toContain("PromptComposer");
  });
});

describe.skipIf(!reachable)("reviewedTemplates routes 200 (B-08 + B-09)", () => {
  it("GET /api/templates?kind=curated&limit=3 returns 200 with 3 curated", async () => {

    const app = createApp();
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    const secret = new TextEncoder().encode(config.identity.secret || "test-secret-for-ci");
    const token = await new SignJWT({ email: "test@example.com", name: "Test" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("test-sub-123")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(secret);
    try {
      const res = await fetch(`${base}/api/templates?kind=curated&limit=3`, {
        headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": token },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { templates: Array<{ slug: string }> };
      expect(body.templates).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("GET /api/templates?q=compliance returns 200 filtered", async () => {

    const app = createApp();
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    const secret = new TextEncoder().encode(config.identity.secret || "test-secret-for-ci");
    const token = await new SignJWT({ email: "test2@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("test-sub-456")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(secret);
    try {
      const res = await fetch(`${base}/api/templates?q=compliance`, {
        headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": token },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { templates: Array<{ name: string }> };
      expect(body.templates.length).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("GET /api/templates/:slug and /api/templates/suggestions?limit=4 return 200", async () => {

    const app = createApp();
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    const secret = new TextEncoder().encode(config.identity.secret || "test-secret-for-ci");
    const token = await new SignJWT({ email: "test3@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("test-sub-789")
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(secret);
    try {
      const r1 = await fetch(`${base}/api/templates/new-joiner-setup`, {
        headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": token },
      });
      expect(r1.status).toBe(200);
      const b1 = await r1.json() as { template: { slug: string } };
      expect(b1.template.slug).toBe("new-joiner-setup");

      const r2 = await fetch(`${base}/api/templates/suggestions?limit=4`, {
        headers: { "x-api-key": config.parentApiKey, "x-foundry-identity": token },
      });
      expect(r2.status).toBe(200);
      const b2 = await r2.json() as { suggestions: Array<{ name: string }> };
      expect(b2.suggestions).toHaveLength(4);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

