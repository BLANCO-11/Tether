import { WORKSPACE_PERMISSIONS, type WorkspacePermission } from "./permissions.js";

/**
 * The three built-in workspace roles, expressed as sets over the catalogue.
 *
 * CODE, not rows (FR-007): these are not editable and not deletable. A preset somebody
 * can edit is a preset that can be edited into something nobody reviewed, and every
 * workspace on the deployment would inherit the edit.
 *
 * ## ⚠ This REPLACES `RANK`, and the replacement is not a refactor
 *
 * `requireWorkspaceRole` compared an integer rank — `author` 0, `approver` 1, `admin` 2 —
 * so "an admin satisfies approver" was arithmetic. It is now **set containment**
 * (INV-4), which is the same answer for these three and a *different kind* of answer in
 * general: a custom role is not on the line at all, and there is no integer that could
 * place it there. The property survives; the mechanism does not. `workspace-member.test.ts`
 * asserts the property and its comment must not go on naming `RANK`.
 *
 * ## ⚠ `approver` GAINS `flows.arm`, AND THAT IS A WIDENING
 *
 * Do not read this table as "today's roles, written down". One cell is new.
 *
 * There are two `ROLE_CAPS` in this repo and they disagree about exactly this cell:
 * `services/workspace-member-capabilities.service.ts` gives `approver`
 * `["edit-workflows", "approve"]` — **no `publish`** — and
 * `packages/client/src/lib/capabilities.ts` gives it
 * `["edit-workflows", "publish", "approve"]`. Neither is wrong on its own; there are
 * simply two of them, and they have been out of step. Decided 2026-09-12 (spec D-4):
 * **an approver may arm.** The client's reading wins.
 *
 * So FR-006's "reproduce today's roles exactly" is **false for this one cell**, and it
 * says so here rather than riding in silently inside a preset. `rbac-backfill`'s dry run
 * lists approvers gaining `flows.arm` as one of its three expected differences; a fourth
 * kind of difference is a defect in this file.
 *
 * ## ⚠ `author` does NOT get every read (spec D-8)
 *
 * The first draft of this table said `author` = "all `*.read`". Four sensitive reads sit
 * with `admin` instead — `secrets.read` (the credential NAME list), `audit.read`,
 * `breakglass.read` and `budget.read`. `members.read` deliberately **stays** with
 * `author`: it is the one read in that group with a real answer today
 * (`requireWorkspaceRole("author")`), and a member who cannot approve still has to be
 * able to find out who can.
 *
 * **Nothing is taken from anybody by that choice.** The secrets, audit, break-glass and
 * budget routes are among the 106 that carry no authorisation check at all today, so
 * there is no behaviour to carry forward. It is a free choice, not a narrowing.
 */
export type PresetRole = "viewer" | "author" | "approver" | "admin";

/**
 * What a viewer — shown as OBSERVER — may do: read the published automations, their live runs, and who is here.
 * Read-only by construction: no `.write`, `.run`, `.decide` or `.approve` (rbac-observability, 2026-10-15).
 * `author` contains all of it, so `admin ⊇ approver ⊇ author ⊇ viewer` stays true by union.
 */
const VIEWER = [
  "bootstrap.read",
  "flows.read",
  "members.read",
  "runs.read",
  "search.read",
] as const satisfies readonly WorkspacePermission[];

/** What an author may do: build automations and run them, and read most of the rest. */
const AUTHOR = [
  ...VIEWER,
  "approvals.read",
  // The OWNER of a workflow decides its run's pauses (sharing-boundaries 2026-10-30); `requireNotRunRequester` holds
  // the decision to them per request. Reviewers judge the workflow, not its execution.
  "approvals.decide",
  "bootstrap.read",
  "catalogue.read",
  "catalogue.write",
  "datasources.query.write",
  "datasources.read",
  /**
   * ⚠ **Onboarding a datasource is an AUTHOR's job, and the SCOPE is chosen on
   * the form — 2026-09-17.** This sat in `ADMIN_ADDS` until now, which made
   * `POST …/datasources` a 403 for every author on this deployment: all seven
   * memberships are `author`, so nobody but a super admin could connect a
   * database at all. The symptom was badly placed — `/data-sources/new` renders
   * every failure as the literal pill "Couldn't connect", so a permission
   * refusal was indistinguishable from the database being unreachable.
   *
   * ⚠ **This is a real widening and it is deliberate, not an oversight being
   * corrected.** What makes it defensible is that the dangerous half was never
   * the ROLE — it is what the datasource may DO, and that is now a separate,
   * explicit choice on the row: `access_policy` (`read` / `read_write` /
   * `full`), enforced by `BEGIN READ ONLY` in the executor, where **Postgres
   * refuses the write itself** even for a superuser credential. An author
   * connecting a database gets `read` by default (`DEFAULT_ACCESS_POLICY`) and
   * has to choose otherwise on purpose.
   *
   * ⚠ **So the control this leans on is layer 3 of `datasource-access-policy.ts`,
   * and that module says what happens if it goes: `access_policy` becomes a
   * documentation-only field and the screen claims read-only while nothing
   * makes it so.** If the read-only transaction is ever removed, this line goes
   * back to `ADMIN_ADDS` in the same commit.
   *
   * ⚠ Stated as temporary by the person who asked for it ("for now"). It is one
   * line to move back, and the two tests below pin the sizes so moving it is
   * never silent.
   */
  "datasources.write",
  "flows.read",
  "flows.run",
  "flows.write",
  "gates.read",
  "incidents.read",
  "members.read",
  "resources.read",
  "runs.read",
  "scenarios.read",
  "search.read",
  "steps.try",
  "templates.read",
  "tools.read",
  // Seeing which services are connected is part of building with them; connecting one is an admin's (below).
  "plugins.read",
] as const satisfies readonly WorkspacePermission[];

/**
 * What an approver adds: the decisions.
 *
 * ⚠ `flows.arm` is the widening described above — an approver may now create and enable
 * triggers. `runs.replay` is here rather than with `author` because a replay re-applies
 * the approval gate, mints execution credentials and takes a budget slot: it is an
 * execution of an already-approved revision, which is an approver's business (spec D-7).
 * In the first draft of this table it belonged to nobody at all.
 */
const APPROVER_ADDS = [
  "flows.approve",
  "flows.arm",
  "runs.replay",
] as const satisfies readonly WorkspacePermission[];

/** What an admin adds: everything else in the workspace. */
const ADMIN_ADDS = [
  "audit.read",
  "content.read.others",
  "breakglass.activate",
  "breakglass.read",
  "budget.read",
  "budget.write",
  // `datasources.write` MOVED to AUTHOR on 2026-09-17 — see the note there.
  // Admin still holds it, by union rather than by this list.
  "gates.write",
  "incidents.write",
  "members.grant",
  "realdata.use",
  "reports.read",
  "roles.write",
  "secrets.read",
  "secrets.write",
  "templates.write",
  "tools.write",
  "plugins.enable",
] as const satisfies readonly WorkspacePermission[];

function frozenSorted(
  ...groups: ReadonlyArray<readonly WorkspacePermission[]>
): readonly WorkspacePermission[] {
  return Object.freeze([...new Set(groups.flat())].sort()) as readonly WorkspacePermission[];
}

/**
 * ⚠ **Built by union, not by transcription.** `approver` is literally `author` plus four,
 * and `admin` is literally `approver` plus fifteen, so INV-4's containment is true by
 * construction rather than by three lists happening to agree. Transcribing three flat
 * lists is how the containment quietly stops holding when somebody edits one of them.
 */
export const ROLE_PRESETS: Readonly<Record<PresetRole, readonly WorkspacePermission[]>> =
  Object.freeze({
    viewer: frozenSorted(VIEWER),
    author: frozenSorted(AUTHOR),
    approver: frozenSorted(AUTHOR, APPROVER_ADDS),
    admin: frozenSorted(AUTHOR, APPROVER_ADDS, ADMIN_ADDS),
  });

export const PRESET_ROLES: readonly PresetRole[] = Object.freeze([
  "viewer",
  "author",
  "approver",
  "admin",
]);

/**
 * ⚠ The single declared exception to "the presets reproduce today's roles exactly".
 * Exported so the test can spell it out rather than fold it into an expected set, and so
 * the backfill's dry run can name it. If this list ever grows, the growth is a decision
 * and belongs in spec.md before it belongs here.
 */
export const DECLARED_WIDENINGS: ReadonlyArray<{
  role: PresetRole;
  permission: WorkspacePermission;
  why: string;
}> = Object.freeze([
  Object.freeze({
    role: "approver" as const,
    permission: "flows.arm" as const,
    why: "Spec D-4. The server's ROLE_CAPS withheld `publish` from an approver and the client's granted it; the two have disagreed for months. Decided in the client's favour — an approver may arm.",
  }),
]);

export function isPresetRole(value: string): value is PresetRole {
  return (PRESET_ROLES as readonly string[]).includes(value);
}

/** The permissions a preset role carries, or `[]` for a name that is not a preset. */
export function presetPermissions(role: string): readonly WorkspacePermission[] {
  return isPresetRole(role) ? ROLE_PRESETS[role] : Object.freeze([]);
}

/**
 * INV-4 expressed as a function rather than as a number: does `a` carry everything `b`
 * does? This is what replaces `RANK`'s `>=`.
 */
export function containsAll(
  a: readonly WorkspacePermission[],
  b: readonly WorkspacePermission[],
): boolean {
  const set = new Set<string>(a);
  return b.every((p) => set.has(p));
}

/**
 * `admin` is the WHOLE workspace catalogue — and that is deliberate and
 * asserted: an administrator of a workspace can do everything inside it and nothing
 * outside it. The "nothing outside it" half is the platform tier's business.
 */
export const ADMIN_IS_THE_WHOLE_WORKSPACE_CATALOGUE =
  ROLE_PRESETS.admin.length === WORKSPACE_PERMISSIONS.length;
