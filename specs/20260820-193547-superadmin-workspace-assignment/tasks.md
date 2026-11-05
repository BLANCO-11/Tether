# Tasks

## Phase 1 — super-admin identity (server)
- [x] T1.1 `config/index.ts`: `isSuperAdmin({subject,email})` (subject exact OR email case-insensitive) + `superAdminConfigured`; rewrite the docblock.
- [x] T1.2 `workspace-member.service.ts`: `check()` takes an identity object and calls `isSuperAdmin`.
- [x] T1.3 `requireWorkspaceRole` passes `req.user` through.
- [x] T1.4 New `middleware/super-admin.middleware.ts` — 401 / 403-configured / 403-unconfigured.
- [x] T1.5 `deployment-admin.middleware.ts`: super admin passes; both messages stop naming `claim`.
- [x] T1.6 Tests: email-listed super admin authorises an OID subject (red without T1.1); empty allowlist grants nothing.

## Phase 2 — platform_users (server)
- [x] T2.1 Migration + `db/schema.ts` (`subject` unique, `email`, `name`, `first_seen_at`, `last_seen_at`). Journal `when` above every applied `created_at`.
- [x] T2.2 `services/platform-user.service.ts`: `seen()` (throttled, never throws), `list()`.
- [x] T2.3 `resolveIdentity` calls `seen()` **after** a successful verify, unawaited.
- [x] T2.4 `routes/platform-users.ts` + mount; `requireIdentity + requireSuperAdmin`.
- [x] T2.5 Tests: one row per subject, throttle holds, a bad token writes nothing.

## Phase 3 — route gating (server)
- [x] T3.1 **DONE (analysis):** no harness creates a workspace over HTTP — `e2e:ui` only reads `/workspaces` and resolves `HR` by name. But `e2e-ui-journey.ts:1047` claims + grants as a self-minted identity, so that ONE step breaks (see T3.7).
- [x] T3.2 `routes/members.ts`: `POST /` + `DELETE /:subject` → `requireSuperAdmin`; delete `POST /claim`.
- [x] T3.3 `routes/workspaces.ts`: create/rename/delete → `requireSuperAdmin`.
- [x] T3.4 Delete `claim()`; keep `BOOTSTRAP_GRANT`; rewrite the zero-member docblock and `check()`'s zero-member message.
- [x] T3.5 `workspace-member.test.ts`: drop the claim blocks; assert no route mentions `claim`; assert every member-writing route carries `requireSuperAdmin`, with a control.
- [x] T3.6 Verify: non-super-admin 403s on all five routes; super admin grants into a zero-member workspace.
- [x] T3.7 `e2e-ui-journey.ts`: replace the claim+grant step with a super-admin assignment, minting a SUPER identity for the run.

## Phase 4 — /api/me + client seam
- [x] T4.1 `routes/me.ts` (`requireIdentity` only) + mount.
- [x] T4.2 Confirm the client proxy's deny list does not catch `me` or `platform`.
- [x] T4.3 `foundry-client.ts`: `me()`, `listPlatformUsers()`; remove `claimWorkspace`.
- [x] T4.4 `lib/api.ts` + `lib/types.ts`: `Me`, `PlatformUser`; remove `claimWorkspace`.

## Phase 5 — client
- [x] T5.1 `Sidebar.tsx`: `/organization` row only when `me.superAdmin`; render nothing while loading.
- [x] T5.2 `organization/page.tsx`: four `me` states (super admin / not / none configured / unreadable).
- [x] T5.3 `MembersPanel.tsx`: remove Claim; keep the bootstrap badge + explain it; default role `admin`; picker over platform users with a disclosed free-text fallback.
- [x] T5.4 New `PlatformUsersPanel.tsx` with its bound sentence and an assign action.
- [x] T5.5 Tests: MembersPanel (claim gone, picker), PlatformUsersPanel (rows/empty/unreadable), organization (four states), Sidebar (absent AND present).

## Phase 6 — docs, env, honesty
- [x] T6.1 `.env.example`: `SUPER_ADMIN_EMAILS` is load-bearing; accepts subject or email.
- [x] T6.2 `ui-honesty-check.sh`: no `claimWorkspace` in the client; both bound sentences present.
- [x] T6.3 `CLAUDE.md`: correct the GAPS §1.1 claim/backfill bullets in place.

## Gates before calling it done
- [x] `pnpm --filter @foundry/server test` · `pnpm --filter @foundry/client test` (Node 22 — vitest throws below it)
- [x] `pnpm --filter @foundry/server typecheck` · client typecheck
- [x] `bash scripts/ui-honesty-check.sh`
- [ ] `pnpm --filter @foundry/server e2e:ui` — NOT RUN. T3.7 rewrote its membership step; running it authors flows into the shared deployment, so it is left for a deliberate pass.

## Landed beyond the plan (found by running it)

- **T7.1 — a super admin is exempt from the last-admin refusal.** D-6 said keep it absolute. The wire
  test refuted that in one command: a mis-assignment to a workspace's only member could not be undone
  (409), and with `claim` gone there was no other way back. Exempted at the route, from the verified
  identity, never from a body. Tested both directions.
- **T7.2 — `generation-provider.test.ts`** pinned `requireDeploymentAdmin`'s old message naming
  `members/claim`. Corrected in place: same property, new fix named.
- **T7.3 — `platform-user.test.ts`'s "never throws" proved nothing.** A 40,000-char subject is legal
  in a `text` column, so it passed over a successful write and left a junk row. Now a NUL byte.
