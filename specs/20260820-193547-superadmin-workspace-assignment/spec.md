# Super-admin workspace assignment

**Status:** planned · **Created:** 2026-08-20 · **Branch:** v1-alpha

## The ask, verbatim

1. Remove "Claim this workspace" from the Manage Workspaces tab.
2. Add a list of users **who have logged in to the platform**.
3. **Only a super admin** may assign a user to a workspace; an assigned user gets
   **all access** for that workspace.
4. The Manage Workspaces tab is **not accessible to anyone but a super admin**.

## What is true today (measured from the code, not assumed)

| Fact | Where |
| :--- | :--- |
| A super-admin concept **already exists**: `config.superAdminEmails`, from `SUPER_ADMIN_EMAILS`, empty by default. `workspaceMemberService.check` short-circuits it to `role: "admin"` in every workspace. | `packages/server/src/config/index.ts:80`, `services/workspace-member.service.ts:167` |
| ⚠ It matches on the identity **subject**, while the variable is named `…_EMAILS`. For an Entra sign-in the subject is the **OID**, not the email — so a deployment that lists emails there grants nothing to Entra users. The local admin's subject is the literal `local-admin`. | `middleware/identity.middleware.ts` (`FoundryIdentity.subject`), `packages/client/src/auth.ts` (`authorize` returns `id: "local-admin"`) |
| `POST /api/workspaces/:ws/members/claim` is the bootstrap: identity-only, no role, first claimant becomes `admin`, refused once the workspace has any member. | `routes/members.ts`, `workspace-member.service.ts` `claim()` |
| Roles are `author` < `approver` < `admin` (ordered `RANK`). `admin` is already "all access" for a workspace. | `workspace-member.service.ts` |
| Grant/revoke are `requireIdentity + requireWorkspaceRole("admin")`; list is `("author")`. | `routes/members.ts` |
| **There is no record of who has signed in.** Auth.js logs `[audit] sign-in …` to stdout and persists nothing; there is no users table anywhere in `db/schema.ts`. The server sees a verified identity on every proxied request (`resolveIdentity`) and discards it after the request. | `packages/client/src/auth.ts` `events.signIn`, `middleware/identity.middleware.ts` |
| The "Manage Workspaces" tab is `/organization`, linked unconditionally in the sidebar. It hosts workspace CRUD **and** `MembersPanel`. Nothing on it is role-gated, client- or server-side. | `components/shell/Sidebar.tsx:82`, `app/(app)/organization/page.tsx:241` |
| `requireDeploymentAdmin` (the `/ai-provider` generation-model gate) resolves "admin in at least one workspace" and both of its refusal messages tell the person to **claim** a workspace. | `middleware/deployment-admin.middleware.ts` |
| `MembersPanel` renders the Claim button only in its `members.error` branch — i.e. it is the intended first state of an unclaimed workspace. | `components/workspace/MembersPanel.tsx` |

## Functional requirements

**FR-1 — Claim is removed, not hidden.** `POST …/members/claim`, `claim()`,
`foundryApi.claimWorkspace`, `api.claimWorkspace` and the panel button all go.
The `BOOTSTRAP_GRANT` literal **stays**: existing rows carry `granted_by =
'bootstrap'` and the "claimed" badge must keep explaining them.

**FR-2 — A workspace with no members is bootstrapped by a super admin, not by
whoever arrives first.** This is what makes FR-1 safe: `check()` already returns
`allowed` for a super admin *before* it looks at the member list, so a super
admin can grant the first member of an empty workspace today. Removing claim
therefore removes a self-service escalation path and adds no dead end — **but
only on a deployment where `SUPER_ADMIN_EMAILS` is set.** On an empty allowlist
FR-1 makes every unclaimed workspace permanently unmanageable over HTTP.
That is stated, gated and surfaced (FR-7), not discovered later.

**FR-3 — A record of who has signed in.** New table `platform_users`
(`subject` unique, `email`, `name`, `first_seen_at`, `last_seen_at`), upserted
from `resolveIdentity` on every request that presents a valid identity token —
the one place a verified identity already exists server-side, so no new trust
boundary and no client-settable field. Read by
`GET /api/platform/users`, super-admin-only.

⚠ **Naming is load-bearing.** It is a list of *identities that have presented a
verified token*, not a directory of accounts and not proof of who anyone is
(anything holding `RUNTIME_JWT_SECRET` mints one — I-13). The screen and the
route both say so. It is deliberately **not** called `users`.

**FR-4 — Assignment is super-admin-only.** `POST …/members` and
`DELETE …/members/:subject` swap `requireWorkspaceRole("admin")` for a new
`requireSuperAdmin`. `GET …/members` keeps `requireWorkspaceRole("author")` — a
member who cannot approve must still be able to see who can, and that refusal
already names its next step.

**FR-5 — An assigned user gets all access.** Assignment writes role `admin`. The
three-role vocabulary stays in the service (approvals, provenance and
`requireDeploymentAdmin` all read it); the assignment **UI** offers the roles it
can honestly explain, with `admin` the default, and the ask's "all access" is
`admin`.

**FR-6 — `/organization` is super-admin-only.** Three layers, because each
catches a different failure:
* the sidebar link is hidden for a non-super-admin (a link to a 403 is a bug report);
* the page itself refuses with an explanation rather than rendering panels that all fail;
* every route it calls refuses server-side — workspace create/rename/delete gain
  `requireSuperAdmin` too. ⚠ **The server layer is the control**; hiding the link
  is presentation. Say it that way.

**FR-7 — The client must be able to ask whether it is a super admin.** New
`GET /api/me` → `{ subject, email, superAdmin, superAdminConfigured }`.
`superAdminConfigured` is what lets a screen distinguish *"you are not a super
admin"* from *"this deployment has no super admins, so nobody can manage
workspaces — set `SUPER_ADMIN_EMAILS`"*. Two refusals, two actions — the same
distinction `requireDeploymentAdmin` already draws.

⚠ **`session.user.roles` must NOT be the source.** `auth.ts` already puts
`["superadmin","admin"]` on the local credentials account, client-side, from a
password check. Reading that in the client would be a second definition of super
admin that can disagree with the server's, and the server's is the only one that
refuses anything. The client asks; it never decides.

**FR-8 — Super-admin matching is fixed to subject *or* email.** `check()` and the
new `requireSuperAdmin` share one predicate that matches either, case-insensitively
on email. Without this the feature is unusable for Entra sign-ins with the
variable's own documented value, and the failure is silent (a correct email in
`SUPER_ADMIN_EMAILS` grants nothing).

**FR-9 — `requireDeploymentAdmin` stops pointing at a deleted endpoint.** Its two
messages name super-admin assignment instead of `claim`, and a super admin
passes it directly rather than by owning an `admin` row somewhere.

## Out of scope, deliberately

* **No deployment-role table.** `requireDeploymentAdmin`'s option (c) stays
  unbuilt; `SUPER_ADMIN_EMAILS` is server-side env, which is the point — a super
  admin cannot be granted from inside the product, so no one can escalate to it
  through the UI they were just given.
* **No "last active" column** beyond `platform_users.last_seen_at`. The panel's
  existing `—` becomes real only for users that row exists for; it is not
  back-filled and not guessed.
* **No change to any approval gate.** Super admin is an **access** grant. The
  self-approval refusal, the run-requester refusal and the provenance escalation
  all still apply to a super admin exactly as to anybody else, and none of this
  is separation of duties (I-13).
* **No sign-out/session listing.** `platform_users` records that an identity was
  seen, never that a session is live.

## Acceptance

1. `grep -rn "claim" packages/server/src/routes packages/client/src/lib packages/client/src/components/workspace` finds no endpoint, method or button — only the `bootstrap` badge explanation.
2. As a signed-in non-super-admin: `/organization` renders a refusal, no sidebar link, and `POST /api/workspaces` / `POST …/members` / `DELETE …/members/:s` / `GET /api/platform/users` each return 403.
3. As a super admin: the users list shows every identity that has signed in since the migration, assigning one to a workspace with **zero** members succeeds, and that user then passes an `approver` check in it.
4. `SUPER_ADMIN_EMAILS` containing an **email** authorises an Entra identity whose subject is an OID (FR-8's regression).
5. `SUPER_ADMIN_EMAILS` empty: `/organization` states that no super admin is configured and names the variable — it does not render an empty, silently broken page.
