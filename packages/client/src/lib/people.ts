/**
 * The People page's words and filters (admin simplify, phase 3). Pure, so the rules are tested apart from the screen.
 *
 * ⚠ Nothing here decides access. Every workspace, role and reach comes from `GET /api/platform/people`, which is the
 * guard's own answer; this file only filters what was returned and puts it into words.
 */
import type { FAAccessReach, FAInvitation, FAPerson } from "./foundry-client";

/** A local account's shortest password. ⚠ Mirrors `MIN_PASSWORD` in the server's `local-user.service.ts`, which is the AUTHORITY. */
export const MIN_PASSWORD = 12;

/** One short line on what a person can see in a workspace. */
export const REACH_LINE: Record<FAAccessReach, string> = {
  none: "No access",
  published: "Sees what is shared with them; changes nothing",
  own: "Builds their own; sees what is shared with them",
  review: "Also reviews workflows put in front of reviewers",
  everything: "Sees everything, including other people's chats and costs",
};

export interface PeopleFilter {
  q: string;
  workspaceId: string;
  /** A workspace role key, or "" for any. */
  role: string;
}

/** Search matches name or email; the workspace and role filters must hold in the SAME workspace. */
export function personMatches(p: FAPerson, f: PeopleFilter): boolean {
  const q = f.q.trim().toLowerCase();
  if (q && !`${p.name ?? ""} ${p.email}`.toLowerCase().includes(q)) return false;
  if (!f.workspaceId && !f.role) return true;
  return p.workspaces.some((w) => (!f.workspaceId || w.id === f.workspaceId) && (!f.role || w.role === f.role));
}

export function invitationMatches(i: FAInvitation, f: PeopleFilter): boolean {
  const q = f.q.trim().toLowerCase();
  if (q && !i.email.toLowerCase().includes(q)) return false;
  if (!f.workspaceId && !f.role) return true;
  return i.workspaces.some((w) => (!f.workspaceId || w.workspaceId === f.workspaceId) && (!f.role || w.role === f.role));
}

const DAY = 86_400_000;

/** "Expires in 12 days", "Expires today", "Expired". */
export function expiresLabel(i: Pick<FAInvitation, "expiresAt" | "expired">, now = Date.now()): string {
  if (i.expired) return "Expired";
  const days = Math.floor((new Date(i.expiresAt).getTime() - now) / DAY);
  if (days <= 0) return "Expires today";
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** "Today", "Yesterday", "3 days ago", a date, or "Not signed in yet". */
export function lastSeenLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "Not signed in yet";
  const days = Math.floor((now - new Date(iso).getTime()) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

/** What to call a person: their name, else their email, else "Unnamed". */
export function displayName(p: Pick<FAPerson, "name" | "email">): string {
  return p.name?.trim() || p.email || "Unnamed";
}
