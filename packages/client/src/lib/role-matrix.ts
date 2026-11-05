/**
 * The Roles table's rows live in `@foundry/shared/rules` (so the server can check them against its presets); this adds
 * the one client half — reading the built-in roles out of the server's role list.
 */
import type { WorkspaceRole } from "./types";

export { MATRIX_ROWS, cellFor, type MatrixRow, type Cell } from "@foundry/shared/rules";

/** The built-in roles' permissions from the server's role list; a role it did not send is absent, never empty. */
export function presetsFrom(roles: readonly { name: string; builtin: boolean; permissions: readonly string[] }[]) {
  const out: Partial<Record<WorkspaceRole, readonly string[]>> = {};
  for (const r of roles) if (r.builtin) out[r.name as WorkspaceRole] = r.permissions;
  return out;
}
