"use client";

import { useAsync } from "@/lib/hooks";
import { foundryApi } from "@/lib/foundry-client";
import type { PermissionCatalogue } from "@/lib/types";
import { roleLabel } from "@/lib/role-labels";

/**
 * The permission catalogue, fetched from the server.
 *
 * ⚠ **THE LABELS AND THE PRESETS COME FROM THE SERVER, and that is the point of this
 * module.** `lib/capabilities.ts` used to hold both, plus its own `ROLE_CAPS` — and that
 * table **disagreed with the server's** about whether an `approver` may publish. Neither
 * was wrong on its own; there were simply two, and nothing could tell you which one
 * decided anything. It is deleted.
 *
 * ⚠ It also held `CAP_NAV` and `CAP_CONTROLS` — client-side claims about what a
 * capability unlocks. Those are gone rather than moved: a list of "the nav sections you
 * will gain" is a policy assertion the server never made, and it goes stale silently the
 * moment a route's permission changes. What replaces it is the permission diff itself,
 * which is the server's own vocabulary.
 *
 * ⚠ **Three states.** `loading`, the catalogue, or `error` — and a consumer must render
 * the third as *"the check did not run"*, never as an empty catalogue. An empty
 * catalogue would render as "there are no permissions", which is a claim nobody made.
 */
export function usePermissionCatalogue() {
  return useAsync<PermissionCatalogue>(
    () => foundryApi.permissionCatalogue() as unknown as Promise<PermissionCatalogue>,
    [],
  );
}

/** Label for one permission, falling back to the key rather than to a blank. */
export function labelFor(catalogue: PermissionCatalogue | null, key: string): string {
  return catalogue?.permissions.find((p) => p.key === key)?.label ?? key;
}

export function describeFor(catalogue: PermissionCatalogue | null, key: string): string {
  return catalogue?.permissions.find((p) => p.key === key)?.description ?? "";
}

/** The permissions a built-in preset carries, per the SERVER. */
export function presetPermissions(
  catalogue: PermissionCatalogue | null,
  role: string,
): string[] {
  return catalogue?.presets.find((p) => p.name === role)?.permissions ?? [];
}

/** What changes between two permission sets. Vocabulary only — no policy. */
export function permissionDiff(
  from: readonly string[],
  to: readonly string[],
): { granted: string[]; removed: string[] } {
  const a = new Set(from);
  const b = new Set(to);
  return {
    granted: to.filter((p) => !a.has(p)),
    removed: from.filter((p) => !b.has(p)),
  };
}

/** One band of the catalogue, named for the preset that first carries it. */
export interface PermissionGroup {
  /** The preset's own name from the server — `author`, `approver`, `admin`. */
  key: string;
  /** What this band is, in the heading. */
  label: string;
  /** One line under it. Says what holding the band means. */
  hint: string;
  permissions: string[];
}

/**
 * The catalogue banded by the preset that FIRST carries each permission.
 *
 * ## ⚠ Why bands rather than one list of 38
 *
 * The presets are built by UNION server-side — `approver` is literally `author` plus
 * four, `admin` is `approver` plus fifteen — so a flat list throws that away and asks a
 * person to hold `admin ⊇ approver ⊇ author` in their head while reading 38 checkboxes.
 * Banded, the same data says *"everyone here has these nineteen; an approver adds these
 * four; an admin adds these fifteen"*, which is the sentence the model is actually built
 * on.
 *
 * ⚠ **Derived from `catalogue.presets`, which is the SERVER's own answer.** No band list
 * is written down here — a client-side table of what each role carries is exactly
 * `lib/capabilities.ts`, whose `ROLE_CAPS` disagreed with the server's about whether an
 * approver may publish. That file is deleted and this must not become it.
 *
 * ## ⚠ IT IS A PARTITION, AND THAT IS THE PROPERTY THAT MATTERS
 *
 * Every permission in the tier appears in exactly one band. The failure mode this is
 * written against is a permission that quietly appears in NO band: it exists, the server
 * enforces it, and there is no box to tick — a capability the product does not have,
 * which is the defect this whole area was built to close.
 *
 * So the subtraction is CUMULATIVE against everything already placed, not
 * `admin \ approver`. The naive form is correct only while containment holds; if a
 * preset ever gains something a larger one lacks, the naive form puts that permission in
 * two bands and the counts stop adding up. Cumulative is a partition unconditionally.
 *
 * ⚠ **`ungrouped` is rendered, never dropped.** It is empty today — `admin` is all 38 —
 * and if it ever fills, that is a real finding: a permission no built-in role carries,
 * reachable only through a custom role or a direct grant.
 *
 * Bands come out smallest-preset-first, read off the data rather than a hardcoded
 * `["author","approver","admin"]` — a fourth preset should band itself, not vanish.
 */
export function groupByPreset(
  catalogue: PermissionCatalogue | null,
  tier: "workspace" | "platform" = "workspace",
): PermissionGroup[] {
  const all = (catalogue?.permissions ?? []).filter((p) => p.tier === tier).map((p) => p.key);
  if (all.length === 0) return [];

  const inTier = new Set(all);
  const presets = [...(catalogue?.presets ?? [])]
    .map((p) => ({ name: p.name, permissions: p.permissions.filter((k) => inTier.has(k)) }))
    .filter((p) => p.permissions.length > 0)
    .sort((a, b) => a.permissions.length - b.permissions.length);

  const out: PermissionGroup[] = [];
  const placed = new Set<string>();

  presets.forEach((preset, i) => {
    const band = preset.permissions.filter((k) => !placed.has(k));
    for (const k of preset.permissions) placed.add(k);
    if (band.length === 0) return; // a preset identical to a smaller one adds no band
    out.push({
      key: preset.name,
      label: i === 0 ? roleLabel(preset.name) : `${roleLabel(preset.name)} adds`,
      hint:
        i === 0
          ? `Everyone with a role in this workspace holds these ${band.length}.`
          : `A ${roleLabel(preset.name)} holds everything above, plus these ${band.length}.`,
      permissions: band,
    });
  });

  const ungrouped = all.filter((k) => !placed.has(k));
  if (ungrouped.length > 0) {
    out.push({
      key: "ungrouped",
      label: "Not carried by any built-in role",
      // ⚠ Not a tidy-up bucket. If this renders, a permission exists that no preset
      // grants — reachable only through a custom role or a direct grant, and worth
      // somebody asking why.
      hint: "No built-in role carries these. A custom role or a direct grant is the only way to hold one.",
      permissions: ungrouped,
    });
  }
  return out;
}
