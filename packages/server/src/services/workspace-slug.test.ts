/**
 * A workspace created through the product must be able to run something.
 *
 * ── The defect this pins ─────────────────────────────────────────────────────
 *
 * `slug` and `tenant_slug` were added by migration 0010 with a one-time backfill
 * and `workspaceService.create` never set them, so every workspace created after
 * that migration carried NULL for both. Nothing noticed, because the workspace
 * is fine in every visible way — tools, datasource, named queries, manifest — and
 * only `tenantMapper.namespacesFor` fails, at the first deploy, with a 409 that
 * reads like a Kestra problem. It was found by provisioning a second real domain
 * and looking at the row.
 *
 * So the assertion here is deliberately end-to-end rather than "the column is
 * not null": create a workspace, and require that it can address a Kestra
 * namespace. That is the property that was actually broken, and a test on the
 * column alone would pass against a slug of `""`, which `namespaceFor` rejects.
 *
 * These hit the real database — same as `agent-runtime.test.ts` — and clean up
 * after themselves.
 */
import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { workspaceService } from "./workspace.service.js";
import { tenantMapper } from "./tenant-mapper.service.js";

const created: string[] = [];

async function make(name: string) {
  const ws = await workspaceService.create({ name });
  created.push(ws.id);
  return (await workspaceRepo.get(ws.id))!;
}

afterAll(async () => {
  if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  await pool.end();
});

describe("a new workspace gets an immutable namespace slug", () => {
  it("can address a Kestra namespace immediately after creation", () => {
    return make("Slug Test Alpha").then((ws) => {
      // The real assertion. `namespacesFor` throws a 409 on a NULL or empty
      // slug, which is exactly what happened in production.
      const ns = tenantMapper.namespacesFor(ws);
      expect(ns.live.value).toBe("foundry.default.slug-test-alpha");
      expect(ns.draft.value).toBe("foundry.default.slug-test-alpha.draft");
    });
  });

  it("slugifies the same way migration 0010 backfilled existing rows", async () => {
    // Two deployments of the same product must derive the same namespace from
    // the same name, or a backfilled workspace and a newly created one address
    // different places.
    const ws = await make("HR (alt — swap rehearsal) COPY");
    expect(ws.slug).toBe("hr-alt-swap-rehearsal-copy");
    expect(ws.tenantSlug).toBe("default");
  });

  it("gives a second workspace of the same name a distinct slug", async () => {
    // `getBySlugs` resolves the pair to ONE row, so a collision is two tenants'
    // flows in one namespace — not a cosmetic clash.
    const a = await make("Duplicate Name Test");
    const b = await make("Duplicate Name Test");
    expect(a.slug).toBe("duplicate-name-test");
    expect(b.slug).toBe("duplicate-name-test-2");
    expect(b.slug).not.toBe(a.slug);
  });

  it("falls back rather than producing an empty segment", async () => {
    // A name that is entirely punctuation slugifies to "", and `namespaceFor`
    // rejects an empty segment with a message about slugification — thrown from
    // a stack that started at "create workspace".
    const ws = await make("!!!");
    expect(ws.slug).not.toBe("");
    expect(() => tenantMapper.namespacesFor(ws)).not.toThrow();
  });

  it("does not move the slug when the workspace is renamed", async () => {
    // Approval, deployed flows and execution history all hang off the namespace.
    // A rename that moved it would detach them.
    const ws = await make("Renameable Workspace");
    const before = ws.slug;
    await workspaceService.update(ws.id, { name: "Something Else Entirely" });
    const after = await workspaceRepo.get(ws.id);
    expect(after!.slug).toBe(before);
    expect(after!.name).toBe("Something Else Entirely");
  });
});
