import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PERMISSIONS,
  WORKSPACE_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  isPermission,
  isWorkspacePermission,
  isPlatformPermission,
  permissionEntry,
  permissionCheckSql,
} from "./permissions.js";

/**
 * The catalogue's own tests.
 *
 * ⚠ Every count here is READ FROM THE ARRAY, never written down. The `FOUNDRY_EMITS`
 * idiom: a number in a comment goes stale silently, a number a test computes does not.
 * The two exceptions are the totals in `describe("the catalogue is the size the design
 * says")`, which exist precisely to make a silent addition or deletion loud — if you
 * change the catalogue on purpose, change those two numbers in the same commit and say
 * why in the message.
 */

describe("the permission catalogue", () => {
  it("has no duplicate keys", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    const seen = new Map<string, number>();
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes, `duplicate permission keys: ${dupes.join(", ")}`).toEqual([]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every entry a label and a description", () => {
    for (const p of PERMISSIONS) {
      expect(p.label.trim(), `${p.key} has no label`).not.toBe("");
      expect(p.description.trim(), `${p.key} has no description`).not.toBe("");
      // A description that merely restates the key tells a role editor nothing.
      expect(p.description.length, `${p.key}'s description is a stub`).toBeGreaterThan(20);
      expect(p.label.endsWith("."), `${p.key}'s label is a sentence, not a label`).toBe(false);
    }
  });

  it("names every key <domain>.<action>, lower case", () => {
    for (const p of PERMISSIONS) {
      expect(p.key, `${p.key} is not <domain>.<action>`).toMatch(
        /^[a-z]+(\.[a-z]+)+$/,
      );
    }
  });

  it("prefixes every platform permission and no workspace permission with `platform.`", () => {
    for (const p of PERMISSIONS) {
      expect(p.key.startsWith("platform."), `${p.key} is tier ${p.tier}`).toBe(
        p.tier === "platform",
      );
    }
  });

  /**
   * INV-1. A catalogue a caller can mutate is a catalogue a caller can widen — and it
   * would stay widened for every request the process subsequently serves.
   */
  it("INV-1: is frozen at module load, entries included", () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
    for (const p of PERMISSIONS) expect(Object.isFrozen(p), `${p.key} is not frozen`).toBe(true);
    expect(() => {
      (PERMISSIONS as PermissionEntryArray).push({
        key: "smuggled.in",
        tier: "workspace",
        label: "x",
        description: "x".repeat(30),
      });
    }).toThrow();
    expect(isPermission("smuggled.in")).toBe(false);
  });

  it("partitions into workspace and platform, disjoint and exhaustive", () => {
    const ws = new Set<string>(WORKSPACE_PERMISSIONS);
    const pf = new Set<string>(PLATFORM_PERMISSIONS);
    for (const k of ws) expect(pf.has(k), `${k} is in both partitions`).toBe(false);
    expect(ws.size + pf.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(ws.has(p.key) || pf.has(p.key), `${p.key} is in neither partition`).toBe(true);
    }
  });

  // Was 38 + 11 = 49; `content.read.others` joined on 2026-10-15 (rbac-observability), the connector permissions (0106) and
  // `reports.read` (0116, 2026-10-26).
  it("the size the design says: 42 workspace + 12 platform = 54", () => {
    expect(WORKSPACE_PERMISSIONS.length).toBe(42);
    expect(PLATFORM_PERMISSIONS.length).toBe(12);
    expect(PERMISSIONS.length).toBe(54);
  });

  it("INV-3: no permission claims to return a secret value", () => {
    const secretsRead = permissionEntry("secrets.read");
    expect(secretsRead.description).toMatch(/never a value/i);
    // Nothing in the catalogue offers to reveal one.
    for (const p of PERMISSIONS) {
      expect(p.key, "a permission named for revealing a value").not.toMatch(
        /\.(reveal|decrypt)$/,
      );
    }
  });
});

describe("the narrowing guards", () => {
  it("admit every catalogue key and nothing else", () => {
    for (const p of PERMISSIONS) expect(isPermission(p.key)).toBe(true);
    for (const junk of ["", "flows", "flows.", ".read", "FLOWS.READ", "flows.read ", "nope.nope"]) {
      expect(isPermission(junk), `${JSON.stringify(junk)} was admitted`).toBe(false);
    }
  });

  it("sort each key into exactly one tier", () => {
    for (const p of PERMISSIONS) {
      expect(isWorkspacePermission(p.key)).toBe(p.tier === "workspace");
      expect(isPlatformPermission(p.key)).toBe(p.tier === "platform");
    }
    expect(isWorkspacePermission("nope.nope")).toBe(false);
    expect(isPlatformPermission("nope.nope")).toBe(false);
  });

  it("throws rather than inventing an entry for an unknown key", () => {
    expect(() => permissionEntry("nope.nope" as never)).toThrow(/unknown permission/);
  });
});

/**
 * INV-2 — the CHECK constraint and the catalogue are ONE list.
 *
 * ⚠ This is the assertion that stops a permission being added in code and refused by the
 * database, or accepted by the database and unknown to the code. The migration pastes
 * `permissionCheckSql`'s output; this test regenerates it and compares against the text
 * on disk. Adding a permission without touching the constraint fails HERE, in a second,
 * rather than failing a row insert in production six weeks later.
 */
describe("INV-2: the generated CHECK text and the catalogue cannot drift", () => {
  const drizzleDir = join(import.meta.dirname, "..", "..", "drizzle");

  /**
   * Every permission list that is part of a CHECK constraint, found by reading the
   * migrations off disk.
   *
   * ⚠ Matches BOTH forms the migrations use — `IN ('a', 'b')` for a scalar column and
   * `<@ ARRAY['a', 'b']` for an array column. It deliberately does NOT match a bare
   * `ARRAY[...]`, because the seeded built-in platform roles in 0063 are DATA, not
   * constraints: `auditor` legitimately holds one permission and `support` four, and a
   * parity check that tried to hold those to the whole catalogue would fail on correct
   * rows.
   */
  function constraintListsOnDisk(): Array<{ file: string; keys: string[] }> {
    // ⚠ Keyed by CONSTRAINT NAME and the LATEST migration wins (rbac-observability, 2026-10-15). A migration that
    // grows the catalogue drops and re-adds the constraint; the superseded text in an older, already-applied file
    // is history, not the live constraint, and must not be edited to keep this test green.
    const latest = new Map<string, { file: string; keys: string[] }>();
    for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(drizzleDir, file), "utf8");
      const re = /(?:\bIN\s*\(|<@\s*ARRAY\s*\[)((?:\s*'[a-z][a-z.]*'\s*,?)+)[\])]/g;
      for (const m of sql.matchAll(re)) {
        const keys = [...m[1]!.matchAll(/'([a-z][a-z.]*)'/g)].map((k) => k[1]!);
        // Only lists made entirely of catalogue-shaped keys; `IN ('grant','revoke')`
        // in 0064's action CHECK is a different vocabulary and is not our business.
        if (!keys.every((k) => k.includes("."))) continue;
        const before = sql.slice(0, m.index);
        const names = [...before.matchAll(/CONSTRAINT\s+"([a-z_]+)"/g)];
        const name = names.length ? names[names.length - 1]![1]! : `${file}#${m.index}`;
        latest.set(name, { file, keys });
      }
    }
    return [...latest.values()];
  }

  it("CONTROL: at least one migration constrains a permission column", () => {
    // Without this, the parity assertion below iterates an empty list and passes for
    // ever — a test over no rows reads exactly like a test that passed (I-38).
    const found = constraintListsOnDisk();
    expect(
      found.map((f) => f.file),
      "no migration constrains a permission column — the parity check below is vacuous",
    ).not.toEqual([]);
  });

  it("every permission list in a CHECK is exactly a list the catalogue generates", () => {
    const workspace = [...WORKSPACE_PERMISSIONS].sort().join(",");
    const platform = [...PLATFORM_PERMISSIONS].sort().join(",");
    const whole = PERMISSIONS.map((p) => p.key).sort().join(",");

    const found = constraintListsOnDisk();
    for (const { file, keys } of found) {
      const got = [...keys].sort().join(",");
      const which =
        got === workspace ? "workspace" : got === platform ? "platform" : got === whole ? "whole" : null;
      expect(
        which,
        `${file} carries a permission list the catalogue does not generate.\n` +
          `  missing from the file : ${[...WORKSPACE_PERMISSIONS, ...PLATFORM_PERMISSIONS]
            .filter((k) => !keys.includes(k))
            .join(", ")}\n` +
          `  unknown in the file   : ${keys.filter((k) => !isPermission(k)).join(", ")}`,
      ).not.toBeNull();
      // Order-independent above, but a list must also hold no duplicates.
      expect(new Set(keys).size, `${file} repeats a permission`).toBe(keys.length);
    }
  });

  it("covers both the workspace-tier and the platform-tier constraint", () => {
    // 0062/0065 constrain workspace permissions; 0063 constrains the platform array.
    // If either disappears, the catalogue can drift on that tier unnoticed.
    const found = constraintListsOnDisk();
    const workspace = [...WORKSPACE_PERMISSIONS].sort().join(",");
    const platform = [...PLATFORM_PERMISSIONS].sort().join(",");
    const tiers = new Set(
      found.map(({ keys }) => {
        const got = [...keys].sort().join(",");
        return got === workspace ? "workspace" : got === platform ? "platform" : "other";
      }),
    );
    expect([...tiers].sort()).toEqual(["platform", "workspace"]);
  });

  it("generates a narrower list for the workspace tier than for the whole catalogue", () => {
    // INV-8 leans on this: `workspace_role_permissions` must refuse `platform.*`.
    const ws = permissionCheckSql("permission", "workspace");
    expect(ws).not.toMatch(/'platform\./);
    expect(permissionCheckSql("permission")).toMatch(/'platform\./);
    expect(ws.length).toBeLessThan(permissionCheckSql("permission").length);
  });
});

/** Local alias so the INV-1 mutation attempt type-checks without weakening the export. */
type PermissionEntryArray = Array<{
  key: string;
  tier: "workspace" | "platform";
  label: string;
  description: string;
}>;
