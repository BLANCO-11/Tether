/**
 * Personal Foundry fork — product surface cut.
 *
 * Enterprise admin / org / compliance chrome is not part of the personal product.
 * Routes below stay in the tree for now but redirect to Home and are absent from
 * nav and the command palette. Do not re-link them without an explicit product decision.
 *
 * ⚠ **Always on in this repository.** Sign-in must never dump someone on
 * /no-access — the API ensures a Personal home workspace instead.
 */
export const PERSONAL_PRODUCT = true;

/** Paths (and prefixes) removed from the personal product surface. */
export const PERSONAL_REMOVED_PREFIXES = [
  "/admin",
  "/organization",
  "/incidents",
  "/admin/people",
  "/admin/workspaces",
  "/admin/roles",
  "/admin/gates",
  "/admin/audit",
  "/admin/incidents",
  "/incidents/break-glass",
  "/reports",
] as const;

/** True when this path is enterprise-only for the personal fork. */
export function isPersonalRemovedPath(pathname: string): boolean {
  const path = pathname.split("?")[0] || pathname;
  return PERSONAL_REMOVED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/"),
  );
}
