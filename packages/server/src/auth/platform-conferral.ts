import type { PlatformPermission, WorkspacePermission } from "./permissions.js";

/**
 * Which workspace permissions a **platform** permission confers, in EVERY workspace.
 *
 * ⚠ **THIS FILE EXISTS BECAUSE OF A DEAD END, AND IT REVERSES `(currently: none)`.**
 * Spec D-9. Until it existed, platform roles conferred nothing inside a workspace — so a
 * `platform-admin` holding `platform.workspaces.write` could **create** a workspace and
 * then could not put anybody into it, including themselves, because
 * `POST /workspaces/:ws/members` wanted a super admin or `members.grant` and they had
 * neither. They had to go back to a `SUPER_ADMIN_EMAILS` holder to make their own new
 * workspace usable.
 *
 * It was also **inconsistent rather than merely restrictive**:
 * `PUT /api/local-users/:id/access/:workspaceId` writes `workspace_members` and takes
 * `platform.members.grant`, but is scoped by construction to LOCAL accounts — "it cannot
 * be pointed at an Entra identity". So the same act, put a person in a workspace, had two
 * routes and two different answers, decided by which identity provider that person
 * happens to sign in with.
 *
 * ## ⚠ Keyed on the PERMISSION, never on a role name
 *
 * A custom platform role holding `platform.members.grant` confers exactly what the
 * built-in `platform-admin` does. A role's *name* never decides anything — same reason
 * the catalogue is code-owned: one answer to "what does this string mean", everywhere. A
 * map keyed on `"platform-admin"` would silently give a custom role less than the
 * built-in one for no reason a reader could find.
 *
 * ## ⚠ The cost, stated rather than mitigated
 *
 * **A platform administrator can assign themselves `admin` in any workspace and thereby
 * reach that tenant's data.** True, and the price of closing the dead end. Two things
 * bound it, and the difference between them is the whole point:
 *
 *  - The conferral is `members.read` and `members.grant` — who is in the workspace, and
 *    the ability to change that. It is **not** `flows.read`, `secrets.read`, `runs.read`
 *    or anything else. Opening a tenant's automations requires FIRST granting themselves
 *    a workspace role.
 *  - That grant is a write and it is on the record (FR-033) — actor, subject, before,
 *    after, time.
 *
 * So the sentence to use is:
 *
 * > **A platform administrator cannot see a tenant's data, but can give themselves the
 * > ability to, and doing so leaves an audit entry naming them.**
 *
 * Never the unqualified *"a platform admin cannot access tenant data"*, which is false.
 *
 * ⚠ **None of this is separation of duties and D-9 does not move it closer.** The
 * allowlist remains the un-grantable root, and anything holding `RUNTIME_JWT_SECRET`
 * still mints any identity it likes.
 *
 * ## ⚠ INV-20 — the last-admin exemption does NOT extend to this tier
 *
 * `config.isSuperAdmin` keeps the last-workspace-admin exemption alone. The measured
 * incident that created it was a super admin making an irreversible mis-assignment with
 * *nobody above them to undo it*; a platform admin always has an allowlist holder above
 * them, so for them the refusal is recoverable and it stays. A platform admin who hits it
 * escalates. That rule is enforced in `workspace-member.service.ts`, not here — this file
 * is a declaration — but it is written down here because here is where somebody would
 * think to add the exemption.
 */
export const PLATFORM_CONFERS: Readonly<
  Partial<Record<PlatformPermission, readonly WorkspacePermission[]>>
> = Object.freeze({
  "platform.members.grant": Object.freeze([
    "members.read",
    "members.grant",
  ]) as readonly WorkspacePermission[],
});

/**
 * The workspace permissions a set of platform permissions confers, deduplicated.
 *
 * ⚠ **The resolver and every test go through THIS function.** INV-12 — "the auditor
 * confers nothing" — is asserted by calling it with the auditor's permissions and
 * expecting `[]`, never by inspecting the auditor's own permission list. The old form of
 * that assertion would pass while `platform.audit.read` quietly acquired a conferral.
 */
export function conferredByPlatform(
  platformPermissions: readonly string[],
): readonly WorkspacePermission[] {
  const out = new Set<WorkspacePermission>();
  for (const p of platformPermissions) {
    const confers = (PLATFORM_CONFERS as Record<string, readonly WorkspacePermission[] | undefined>)[
      p
    ];
    if (confers) for (const w of confers) out.add(w);
  }
  return Object.freeze([...out].sort()) as readonly WorkspacePermission[];
}

/**
 * Every workspace permission any platform permission can confer — the IMAGE of the map.
 *
 * ⚠ **INV-18 asserts this EQUALS `{members.read, members.grant}` — as a set, not as a
 * subset, and not as "does not contain anything sensitive".** Either weaker form passes
 * while somebody adds `flows.read`, and this one number is the entire bound on D-9's
 * cost. `rbac:platform-verify` asserts the same thing from the other end: a
 * `platform-admin` who is a member of nothing is permitted **exactly two**
 * workspace-scoped routes, not "at least two".
 */
export const CONFERRABLE: readonly WorkspacePermission[] = Object.freeze(
  [...new Set(Object.values(PLATFORM_CONFERS).flat())].sort(),
) as readonly WorkspacePermission[];
