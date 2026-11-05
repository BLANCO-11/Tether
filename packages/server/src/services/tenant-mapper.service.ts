import { namespaceFor, KestraError, type NamespaceRef } from "./kestra-client.service.js";

/**
 * Maps one parent Workspace to the pair of **Kestra namespaces** it owns.
 *
 * ── ⚠ WHY THE FILE IS STILL CALLED "tenant-mapper" ──────────────────────────
 *
 * It used to do two unrelated things, and Phase 1 task 1.8 deleted one of them:
 * `provisionForWorkspace()` created a tenant in an external agent runtime, plus
 * an admin key, and stored both on `workspaces`. Those columns are gone. It was
 * unreachable — the flag that reached it defaulted to `false` and no caller
 * anywhere passed `true`, so both columns were permanently NULL (measured at the
 * time of deletion: **4 workspaces, 0 with either value**) and the public field
 * reporting it was permanently `false`. That is Redis's lesson from GAPS §6.4 in
 * a second shape — every signal a reader could look at said the feature existed,
 * and only a grep said otherwise.
 *
 * The name survives because it is still **true of what remains**, in the other
 * sense of the word: the "tenant" here is Foundry's own `workspaces.tenant_slug`,
 * the first segment of `<prefix>.<tenantSlug>.<slug>`. This module maps a
 * workspace to that address, and never had anything to do with the other kind of
 * tenant beyond the half that is now deleted.
 *
 * ⚠ **Do not delete this file** on the strength of I-131's heading, which reads
 * *"`tenant-mapper.service.ts` … unreachable"*. Only `provisionForWorkspace` was.
 * `namespacesFor` is the single minter of a workspace's namespace pair and has
 * live callers in `flow.service.ts` and five `kestra:*` harnesses.
 */

/**
 * Both Kestra namespaces a workspace owns (§5.0).
 *
 * They come as a PAIR because every lifecycle operation needs both: a draft
 * deploy writes to one, approval promotes into the other, revoking removes from
 * the other. Handing callers one name at a time is how the two drift.
 */
export interface WorkspaceNamespaces {
  live: NamespaceRef;
  draft: NamespaceRef;
  tenantSlug: string;
  slug: string;
}

/** The subset of a workspace row this module needs. */
export interface SluggedWorkspace {
  id: string;
  name: string;
  slug: string | null;
  tenantSlug: string | null;
}

export const tenantMapper = {
  /**
   * The single source for a workspace's namespace names (§7.2).
   *
   * Callers used to assemble these themselves from `namespaceFor(ws.tenantSlug,
   * ws.slug)`, which has two traps. Both slug columns are NULLABLE — a workspace
   * created before slugs existed produces `namespaceFor(null, null)`, and the
   * failure surfaces as a namespace that does not resolve rather than as a
   * missing slug. And a caller wanting the draft namespace had to remember the
   * third argument, so "deploy the draft" and "remove the live trigger" could
   * disagree about which environment they were addressing.
   *
   * `namespaceFor()` remains the only place a `NamespaceRef` is minted — the R4
   * brand is worth exactly as much as the number of modules that can produce it.
   */
  namespacesFor(ws: SluggedWorkspace): WorkspaceNamespaces {
    if (!ws.tenantSlug || !ws.slug) {
      throw new KestraError(
        `workspace "${ws.name}" (${ws.id}) has no immutable slug pair ` +
          `(tenant="${ws.tenantSlug ?? ""}", workspace="${ws.slug ?? ""}"); ` +
          "it cannot address a Kestra namespace until one is assigned",
        409,
        null,
      );
    }
    return {
      live: namespaceFor(ws.tenantSlug, ws.slug, "live"),
      draft: namespaceFor(ws.tenantSlug, ws.slug, "draft"),
      tenantSlug: ws.tenantSlug,
      slug: ws.slug,
    };
  },
};
