/**
 * The Roles page's "What each role can do" table, checked against the presets themselves (admin simplify,
 * 2026-10-30). The rows live in `@foundry/shared/rules`; the client ticks them from the server's role list, so this
 * is where a row that no longer matches the presets turns red.
 */
import { describe, expect, it } from "vitest";
import { MATRIX_ROWS, cellFor } from "@foundry/shared/rules";
import { ROLE_PRESETS } from "./role-presets.js";
import { WORKSPACE_PERMISSIONS } from "./permissions.js";

const ROLES = ["viewer", "author", "approver", "admin"] as const;

describe("the roles table, against the presets", () => {
  it("no built-in role holds a row only partly", () => {
    for (const row of MATRIX_ROWS) for (const r of ROLES) expect(cellFor(row, ROLE_PRESETS[r]), `${r}: ${row.label}`).not.toBe("partly");
  });

  it("reads as agreed: who has each row", () => {
    const table = Object.fromEntries(MATRIX_ROWS.map((row) => [row.label, ROLES.filter((r) => cellFor(row, ROLE_PRESETS[r]) === "yes")]));
    expect(table).toEqual({
      "See what is shared in the workspace, and its live runs": ["viewer", "author", "approver", "admin"],
      "See who is in the workspace": ["viewer", "author", "approver", "admin"],
      "Build and test their own workflows": ["author", "approver", "admin"],
      "Connect a database and write the reads that use it": ["author", "approver", "admin"],
      "Connect their own account to a service and switch on actions for themselves": ["author", "approver", "admin"],
      "Approve or reject a paused step": ["author", "approver", "admin"],
      "Review workflows, put them live and manage their schedules": ["approver", "admin"],
      "Run a past run again": ["approver", "admin"],
      "Connect a service for the whole workspace and choose its actions": ["admin"],
      "Add and remove people, and change their roles": ["admin"],
      "See everyone's private work, usage and cost": ["admin"],
      "Manage credentials, tools, limits and the audit history": ["admin"],
    });
  });

  it("every permission a row names is a workspace permission", () => {
    const known = new Set<string>(WORKSPACE_PERMISSIONS);
    for (const row of MATRIX_ROWS) for (const p of row.needs) expect(known.has(p), p).toBe(true);
  });
});
