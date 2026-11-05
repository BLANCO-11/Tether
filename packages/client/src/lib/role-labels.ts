/**
 * The four built-in workspace roles as a person sees them (rbac-observability, 2026-10-15).
 *
 * The stored keys never change — `viewer` / `author` / `approver` / `admin` are what the server, the database and
 * every grant row hold. Only the words on screen are here, so renaming a role is one edit and never a migration.
 */
import type { WorkspaceRole } from "./types";

/** Smallest first: every role holds everything the one before it does. */
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ["viewer", "author", "approver", "admin"];

export const ROLE_LABEL: Readonly<Record<WorkspaceRole, string>> = {
  viewer: "Observer",
  author: "Creator",
  approver: "Reviewer",
  admin: "Admin",
};

export const ROLE_HINT: Readonly<Record<WorkspaceRole, string>> = {
  viewer: "Sees what's running and how it went. Can't change anything.",
  author: "Builds and tests their own automations.",
  approver: "Checks other people's automations and puts them live.",
  admin: "Manages the workspace, its people and its settings. Sees everything.",
};

/** The on-screen name for a stored role key; an unknown key is shown as itself rather than hidden. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return (ROLE_LABEL as Record<string, string>)[role] ?? role;
}
