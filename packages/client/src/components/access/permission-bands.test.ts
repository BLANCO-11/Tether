// src/components/access/permission-bands.test.ts
//
// `groupByPreset` — the catalogue banded by the preset that first carries each
// permission.
//
// ⚠ **THE PROPERTY UNDER TEST IS THAT IT IS A PARTITION.** The failure this is written
// against is a permission that quietly lands in NO band: it exists, the server enforces
// it, and there is no box to tick — a capability the product does not have, which is the
// class of defect this whole area was built to close. A grouping that merely "looks
// right" on today's three presets would pass a rendering test and lose a permission the
// day a fourth appears.

import { describe, it, expect } from "vitest";
import { groupByPreset } from "./permission-catalogue";
import type { PermissionCatalogue } from "@/lib/types";

/** Shaped like the server's: presets built by UNION, so admin ⊇ approver ⊇ author. */
function catalogue(over: Partial<PermissionCatalogue> = {}): PermissionCatalogue {
  const ws = (k: string) => ({ key: k, tier: "workspace" as const, label: k, description: "" });
  return {
    permissions: [
      ws("flows.read"),
      ws("flows.write"),
      ws("flows.approve"),
      ws("flows.arm"),
      ws("members.read"),
      ws("members.grant"),
      { key: "platform.users.read", tier: "platform", label: "p", description: "" },
    ],
    presets: [
      { name: "author", permissions: ["flows.read", "flows.write"] },
      { name: "approver", permissions: ["flows.read", "flows.write", "flows.approve", "flows.arm"] },
      {
        name: "admin",
        permissions: [
          "flows.read",
          "flows.write",
          "flows.approve",
          "flows.arm",
          "members.read",
          "members.grant",
        ],
      },
    ],
    platformConfers: {},
    conferrable: [],
    ...over,
  };
}

describe("groupByPreset", () => {
  it("bands by the preset that FIRST carries each permission, smallest first", () => {
    const groups = groupByPreset(catalogue());
    expect(groups.map((g) => g.key)).toEqual(["author", "approver", "admin"]);
    expect(groups[0]!.permissions).toEqual(["flows.read", "flows.write"]);
    // ⚠ The ADDITION, not the whole preset. "approver" carries four; two of them are
    // already the author band, and repeating them is the flat list with extra steps.
    expect(groups[1]!.permissions).toEqual(["flows.approve", "flows.arm"]);
    expect(groups[2]!.permissions).toEqual(["members.read", "members.grant"]);
  });

  it("⚠ IS A PARTITION — every permission in the tier appears exactly once", () => {
    const cat = catalogue();
    const groups = groupByPreset(cat);
    const banded = groups.flatMap((g) => g.permissions);
    const expected = cat.permissions.filter((p) => p.tier === "workspace").map((p) => p.key);

    expect([...banded].sort()).toEqual([...expected].sort()); // nothing lost
    expect(new Set(banded).size).toBe(banded.length); // nothing twice
  });

  it("the ORDER of presets from the server does not change the banding", () => {
    // Sorted by size, read off the data — not a hardcoded ["author","approver","admin"].
    const shuffled = catalogue();
    shuffled.presets = [shuffled.presets[2]!, shuffled.presets[0]!, shuffled.presets[1]!];
    expect(groupByPreset(shuffled).map((g) => g.key)).toEqual(["author", "approver", "admin"]);
  });

  it("⚠ a permission NO preset carries is rendered in its own band, never dropped", () => {
    const cat = catalogue();
    cat.permissions = [...cat.permissions, { key: "secrets.rotate", tier: "workspace", label: "s", description: "" }];
    const groups = groupByPreset(cat);
    const last = groups[groups.length - 1]!;
    expect(last.key).toBe("ungrouped");
    expect(last.permissions).toEqual(["secrets.rotate"]);
    // ⚠ Not a tidy-up bucket: if this renders, a permission exists that no built-in role
    // grants, and the copy has to say that rather than imply it is ordinary.
    expect(last.hint).toMatch(/custom role or a direct grant/);
  });

  it("⚠ STAYS A PARTITION even if preset containment breaks", () => {
    /**
     * `admin ⊇ approver ⊇ author` is true by construction server-side and asserted
     * there. The client must not DEPEND on it: the naive `admin \ approver` puts a
     * permission that approver has and admin lacks into two bands, and the counts stop
     * adding up with nothing saying why. The subtraction is cumulative against
     * everything already placed, so this holds unconditionally.
     */
    /**
     * ⚠ **THE FIRST VERSION OF THIS FIXTURE DID NOT EXERCISE THE BUG, and the
     * perturbation is what said so.** Swapping the cumulative subtraction for the naive
     * `preset \ previous preset` turned NOTHING red — because the fixture only had a
     * permission that author holds and approver lacks, and `admin` did not hold it
     * either, so it never came back.
     *
     * The duplication needs a permission that skips a GENERATION: held by `author`, not
     * by `approver`, and held again by `admin`. Naive subtraction then puts it in the
     * author band AND the admin band, the counts stop adding up, and nothing says why.
     */
    const cat = catalogue();
    cat.presets = [
      // `members.read` is in author, NOT in approver, and BACK in admin.
      { name: "author", permissions: ["flows.read", "members.read"] },
      { name: "approver", permissions: ["flows.read", "flows.write", "flows.approve"] },
      {
        name: "admin",
        permissions: ["flows.read", "flows.write", "flows.approve", "flows.arm", "members.read", "members.grant"],
      },
    ];
    const groups = groupByPreset(cat);
    const banded = groups.flatMap((g) => g.permissions);
    expect(new Set(banded).size).toBe(banded.length); // still nothing twice
    expect([...banded].sort()).toEqual(
      cat.permissions.filter((p) => p.tier === "workspace").map((p) => p.key).sort(),
    );
  });

  it("platform permissions are not banded into the workspace tier", () => {
    const banded = groupByPreset(catalogue()).flatMap((g) => g.permissions);
    // ⚠ INV-9 again, one layer down: the drawer must render no platform key, and the
    // banding must not be the thing that smuggles one in.
    expect(banded.some((k) => k.startsWith("platform."))).toBe(false);
    // CONTROL: the fixture really does carry a platform permission, so the filter is
    // doing work rather than passing over an absence.
    expect(catalogue().permissions.some((p) => p.tier === "platform")).toBe(true);
  });

  it("an unreadable catalogue bands nothing — it does not invent an empty role", () => {
    expect(groupByPreset(null)).toEqual([]);
  });

  it("a preset identical to a smaller one adds no band of its own", () => {
    const cat = catalogue();
    cat.presets = [
      { name: "author", permissions: ["flows.read"] },
      { name: "clone", permissions: ["flows.read"] },
    ];
    const keys = groupByPreset(cat).map((g) => g.key);
    // An empty band is a heading with nothing under it, which reads as a broken screen.
    expect(keys).not.toContain("clone");
  });
});
