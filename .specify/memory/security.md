# Security Standard

<!--
  Established retroactively by /speckit-start against an EXISTING codebase. Every
  control below was read off the repository, its tests, or a recorded measurement
  on the date given. Where a control is WEAKER than its obvious name suggests,
  that is stated here rather than left to be discovered — an overstated control is
  worse than an absent one, because nobody looks at it again.

  NON-NEGOTIABLE (constitution article VIII): no real credential value appears in
  this file. Secrets are referenced by VARIABLE NAME only.
-->

**Project**: Foundry — parent application over the Tether Foundry Harness
**Established**: 2026-08-25
**Last amended**: 2026-08-25

## 1. Authentication

- **Mechanism**: two credentials that do different jobs and must never be
  conflated. `PARENT_API_KEY` authorises a **request**; `RUNTIME_JWT_SECRET`
  attests a **person**. `pnpm kestra:check` asserts the two values differ.
- **Identity source**: Microsoft Entra ID SSO via NextAuth, plus a local
  credentials account for single-operator deployments.
- **The signed subject is `token.oid ?? token.sub`, and this is load-bearing.**
  Entra's `sub` is **not stable** here — one user was measured holding five
  `platform_users` rows, one per sign-in. `workspace_members.subject` is keyed on
  that value, so a rotating subject silently revokes a real membership with the
  row still sitting there. ⚠ Do not "simplify" it back to `token.sub`.
- **Identity transport**: the Next.js proxy forwards the token as
  `x-foundry-identity` — never `authorization`, which `requireApiKey` also reads.
- **A present-but-invalid identity token is a 401, never treated as absent.** The
  fallback would record an action attributed to nobody, in a field that now looks
  verified.
- **Session/token policy**: identity resolution is global; the requirement is
  per-route, because Kestra step callbacks and every harness hold the API key and
  no session.
- **MFA**: delegated entirely to the Entra tenant. Foundry neither enforces nor
  observes it.

⚠ **Never write "authenticated user" unqualified.** Anything holding
`RUNTIME_JWT_SECRET` can mint an identity, and the `e2e:ui` harness does. The
defensible sentence is *"holding the API key no longer lets you name a person."*

## 2. Authorization & Access Control

- **Model**: workspace-scoped RBAC over a **permission catalogue** — 49 named
  permissions (38 workspace + 11 platform) in `packages/server/src/auth/permissions.ts`,
  **code and never a table**, so no administrator can invent, rename or delete one.
  `admin ⊇ approver ⊇ author` survives as **set containment** over that catalogue
  (INV-4); the integer `RANK` that expressed it is deleted, because a custom role is not
  on any ladder and no integer could place it. Membership stays in `workspace_members`,
  keyed on the identity **subject**. Above it sits a real **platform tier**
  (`platform_roles`), and above that the `SUPER_ADMIN_EMAILS` allowlist.

### ⚠ 2.1 What the 2026-09-13 RBAC feature changed — EIGHT behaviour changes

Amended under Article VII. Every one of these is a change to who can do what, and the
three widenings are named as widenings.

1. ⚠ **106 previously unguarded workspace-scoped routes are now closed.** Of 142
   workspace-scoped routes, 36 carried a role check and **106 carried nothing at all** —
   `DELETE /flows/:flowId` and `POST /flows/:flowId/test-run` among them. Every route now
   declares a permission in a **generated** map, and a route that declares none fails a
   test rather than shipping open.
2. **The workspace list is filtered per grant.** `GET /api/workspaces` returns only
   workspaces the caller holds something in. ⚠ An **auditor sees zero**, which is correct
   rather than a bug: they read across tenants through the audit record, and the list is
   tenant metadata they hold no permission for.
3. ⚠ **WIDENING — a workspace administrator may now grant members.** It was
   `requireSuperAdmin` alone. The rule is now super admin **OR** `members.grant`, resolved
   from an AND/OR contradiction between two artefacts. Keeping both guards would have
   meant AND, which is *narrower* than before.
4. ⚠ **NARROWING — the generation model needs an explicit platform grant.**
   `requireDeploymentAdmin` (satisfied by being an admin in ANY workspace) is **deleted**,
   so one tenant's administrator can no longer change a deployment-wide setting.
5. ⚠ **WIDENING — an `approver` gains `flows.arm`.** Two `ROLE_CAPS` disagreed about this
   for months; the client's reading won.
6. ⚠ **On this deployment every workspace becomes unusable to every non-super-admin on day
   one.** Measured: **zero members and zero capability grants across eight workspaces**.
   Accepted rather than fixed, and stated in four places rather than discovered.
   `SUPER_ADMIN_EMAILS` is the only way in.
7. **The browser stops deciding access questions.** `packages/client/src/lib/capabilities.ts`
   — a second `ROLE_CAPS` that disagreed with the server's — is deleted, along with
   `CAP_NAV`/`CAP_CONTROLS` (client-side claims the server never made) and
   `filterByCapabilities`.
8. ⚠ **WIDENING — a platform administrator can see and change EVERY workspace's member
   list.** `platform.members.grant` confers `members.read` + `members.grant` in every
   workspace (spec D-9), because a platform admin could otherwise create a workspace and
   put nobody in it.

   **The bound is the number two.** The conferral is **exactly** those two permissions —
   asserted as a **set equality**, not a subset, because a subset assertion passes while
   somebody adds `flows.read`. `rbac:platform-verify` asserts a platform admin reaches
   **exactly 11** workspace-scoped routes, not "at least".

   ⚠ **THE SENTENCE TO USE IS:** *a platform administrator cannot see a tenant's data, but
   can give themselves the ability to, and doing so leaves an audit entry naming them.*
   **Never** the unqualified *"a platform admin cannot access tenant data"* — it is false:
   they can grant themselves a workspace role, and that grant is a write on the record.

⚠ **NONE OF THIS IS SEPARATION OF DUTIES AND D-9 DOES NOT MOVE IT CLOSER.** The allowlist
remains the un-grantable root, and anything holding `RUNTIME_JWT_SECRET` still mints any
identity it likes. See the existing subsection below, which is unchanged and still governs.
- **Enforcement point is the ROUTE, never the service.** A service-level check
  needs `req.user`, which a harness has none of — there it would be satisfied by
  a constant or would break the whole regression net. A test reads the route tree
  for the call sites, **and a second test asserts that scan finds anything at
  all**, so a rename cannot leave it scanning nothing.
- **Default posture**: deny by default. A workspace with zero members refuses
  approvals; migration 0027 backfills nobody on purpose.
- ⚠ **`SUPER_ADMIN_EMAILS` IS LOAD-BEARING, NOT OPTIONAL.** With
  `POST …/members/claim` deleted, an empty allowlist means no workspace can be
  created and no memberless workspace can ever get a member. The state is
  surfaced (`config.superAdminConfigured`, `GET /api/me`, a distinct refusal from
  `requireSuperAdmin`) rather than left to be discovered.
- **Matching is subject OR email** through the single predicate
  `config.isSuperAdmin` — subject exactly, email case-insensitively. It matched
  on subject alone until 2026-08-21, which meant a deployment listing emails, i.e.
  doing what the variable name says, granted nothing at all with no error anywhere.
- ⚠ **THIS IS NOT SEPARATION OF DUTIES, AND MUST NEVER BE CALLED THAT.**
  - Gate 2's self-approval refusal and gate 3's self-decision refusal both
    **stand down for a super admin** (recorded in
    `flow_approvals.self_approved_override`; logged for gate 3). The correct
    sentence is *"a **non-super-admin** cannot approve their own revision."*
  - `flow_revisions.created_by` is self-asserted whenever a revision came from a
    harness, a seed, an import or the drafter — which is what `created_by_kind`
    records.
  - Exemption flags come from the **verified identity** and are never in a schema.
    `approveSchema` is `.strict()` precisely so an approver cannot name themselves.
- **The approval gate binds to a REVISION, never to a flow.** Approve-once against
  a flow is a blank cheque redeemable by editing — privilege escalation by edit.
  Revisions, steps and approvals are insert-only.
- **`flow-approval.service.ts` is the only module that writes the live Kestra
  namespace.** That keeps "editing cannot change what the schedule runs" checkable
  by grepping for a caller instead of reading every path. **Do not add a live
  deploy anywhere else.**

## 3. Data Protection

- **In transit**: TLS to every external endpoint. ⚠ On a TLS-intercepting
  corporate network, build-time trust is established explicitly per image via
  `CORP_CA_FILE` — see the CA section of `CLAUDE.md`. Trust follows the **build
  argument**, never the presence of a file.
- **At rest**: datasource DSNs and tool secrets are encrypted with
  `CREDENTIAL_ENC_KEY`. Backups carry the key's **fingerprint** and never the key
  — key-beside-ciphertext makes every backup a credential compromise, and omitting
  it *silently* means a restore under the wrong key succeeds and fails hours later.
  `restore.sh` refuses on a fingerprint mismatch.
- **Tenant datasource credentials are read-only, and the control is the ABSENT
  GRANT** — never `default_transaction_read_only`, which a session can turn off.
  Verified by catalogue reads (`has_*_privilege`), never by a trial write, which
  would insert a row into a customer's database in exactly the case being detected.
  Unreachable ⇒ refuse.
- **A datasource is also refused for WHERE it points.** Registration asks the
  target *who it is* — `(system_identifier, current_database())` plus a
  table-name signature — because a **read-only** credential on `foundry_parent`
  passes the privilege check and is precisely the credential that reads every
  workspace's secrets. ⚠ `DATASOURCE_HOST_ALLOWLIST` is the **weaker** half and
  must never be called the control: unset it cannot fail, and set it is walked
  past by spelling the same database differently.
- **Link-local `169.254.0.0/16` is refused on every deployment**, allowlist or
  not, and **before** the identity probe so nothing dials the metadata endpoint.
  Loopback and RFC 1918 are deliberately **not** refused for datasources — that is
  where the demo databases live.
- **All demo data is SYNTHETIC**, on RFC 2606 reserved `.example` domains that
  cannot resolve or receive mail. **Never replace with real data.**
- **Retention** is a scheduled Kestra flow (`KESTRA_RETENTION_DAYS`,
  `KESTRA_PURGE_CRON`), terminal states only — purging a `PAUSED` execution
  destroys a live human approval. That number **is** the replay window; both read
  it from one place so two defaults cannot promise 30 days while purging at 7.
- **Redaction is server-side and stays there.** `begin`'s response body carries an
  execution token and Kestra persists task outputs; redacting in the browser would
  be theatre. **Never add a path that fetches a raw execution.**

## 4. Secrets Management

- **Source of truth**: environment variables, and `workspace_secrets`
  (name → encrypted value, per workspace) for tenant credentials. `tools` and
  `datasources` reference an entry by its **env-var name**, which is also what the
  manifest renders — one identifier, so manifest, prompt, row and flag cannot
  disagree. Local values live in `.env` (gitignored); every variable has a
  placeholder in `.env.example`.
- **There is deliberately NO endpoint that returns a secret value**, and no
  `?reveal=`. `GET …/secrets/audit` returns `{configured, missing, collisions}`.
- **A shadowed-secret collision fails the step (409)** — a shadowed credential
  must present as a wrong key, not as a silent misconfiguration. The refusal lives
  in `invokeTool`, **before** the value is decrypted and used; it lived in a path
  only the audit called from 2026-07 until 2026-08-10, i.e. it was a correct
  detector nothing consulted.
- **`redactSecrets()` is load-bearing** — a key sent as `?api_key=…` was being
  written verbatim into `api_call_log.query`. It redacts credential-shaped *keys*,
  so it holds for parameters not yet thought of. **Never remove it to debug a 401.**
- **Variables in use** — NAMES ONLY:
  - `PARENT_API_KEY` — authorises a request to the parent API
  - `RUNTIME_JWT_SECRET` — signs/verifies the identity token; **must differ** from the above
  - `CREDENTIAL_ENC_KEY` — encrypts stored DSNs and tool secrets
  - `SUPER_ADMIN_EMAILS` — deployment-level super-admin allowlist (subject or email)
  - `DATABASE_URL` — parent Postgres DSN
  - `TETHER_BASE_URL` / `TETHER_API_KEY` — agent runtime; the key is read in exactly three files, asserted
  - `KESTRA_BASE_URL` / `KESTRA_AUTH` / `KESTRA_CALLBACK_SECRET` — engine access and callback attestation
  - `KESTRA_NAMESPACE_PREFIX` / `KESTRA_RETENTION_DAYS` / `KESTRA_PURGE_CRON` / `KESTRA_FRAGMENT_IMAGE`
  - `OPS_API_KEY` — root key for the tool layer; the six service keys are **derived** from it
  - `MCP_BRIDGE_API_KEY` — guards `POST /mcp`; fails closed (missing ⇒ 500)
  - `LLM_BASE_URL` / `LLM_API_KEY` — generation gateway; **`required()`**, so a deployment that would generate through the agent runtime cannot boot
  - `LLM_FAST_MODEL` / `LLM_REASONING_MODEL` — generation fallback when the `generation_llm` row is empty
  - `MAIL_GRAPH_TENANT_ID` / `MAIL_GRAPH_CLIENT_ID` / `MAIL_GRAPH_CLIENT_SECRET_VALUE` / `MAIL_SENDER_UPN` / `MAIL_ALLOWED_RECIPIENT_DOMAINS` — real outbound mail via Microsoft Graph
  - `BUDGET_DEFAULT_MAX_CONCURRENT` / `BUDGET_DEFAULT_MAX_AGENT_RUNS_PER_DAY` — the M3 tenant budget
  - `PUBLIC_RECEIVER_RATE_PER_MINUTE` / `POLL_TRIGGERS_PER_TICK` — abuse and fairness bounds
  - `CORP_CA_FILE` / `CORP_CA_SOURCE` — build-time corporate CA (a CA **public** certificate is not a secret; it is untracked because it is organisation-specific)
- **Rotation**: on leak, immediately, and purged from git history before the
  branch is pushed (article VIII). The demo read-only password is **derived** from
  `CREDENTIAL_ENC_KEY` rather than random per seed, because `demo:reset` reseeds
  without re-registering the datasource — set `DEMO_DB_RO_PASSWORD` to rotate
  deliberately.

## 5. Input Handling & Common Vulnerabilities

- **Validation**: Zod at the route, plus `@foundry/shared`'s `validate({params,
  query, body})` factory, which calls `next(zodError)` so there is one response
  shape and not two. ~20 routes already validating inline were deliberately **not**
  retrofitted.
- **Injection**: parameterized queries throughout. `datasource` steps run **named
  queries**, never generated SQL — which is the single reason
  `generation-audit.service.ts` was deletable. ⚠ **If a generated-SQL step kind is
  ever introduced, resurrect that audit for that kind alone**, with its
  `attempted_write` negative tests.
- **Generated expressions are ALLOWLISTED before reaching the compiler** — five
  roots, four functions, everything else fails by name. The check lives in
  `flowService.writeRevision`, the one function every revision passes through.
  ⚠ It listed **seven** functions until 2026-08-07 and three did not exist, so the
  prompt taught a runtime failure and the control waved it through. **Every name
  on that list has been RUN against the engine; never add one from memory.**
- **Prompt injection**: `packages/server/src/prompt-boundary/` wraps manifest text
  in a provenance envelope at the one site manifest text enters a generation
  prompt, and `detectInjection` reports findings on the tools page. It **reports
  and does not refuse** — a refusal blocks every draft in a workspace on one
  pattern match over ordinary prose. Excerpts are not logged; they stay behind the
  parent key.
- **SSRF / egress**: `@foundry/shared/egress` exposes `STRICT` (denies loopback,
  link-local, RFC 1918, CGNAT `100.64.0.0/10`, IPv6 ULA `fc00::/7`, multicast) and
  `PERMISSIVE`. `canonicalizeHost` closes **every alternate encoding** of a
  reserved address (`2130706433`, `0x7f000001`, `127.1`, `::ffff:127.0.0.1`, …),
  and STRICT **fails closed on an unresolvable host**.
  - ⚠ **`guardedFetch` NARROWS the DNS-rebinding gap; it does not close it.** The
    check resolves the host and `fetch` resolves it again to open the socket, so
    the address classified is not provably the address dialled. Closing it needs a
    connection-time hook Node's global `fetch` does not expose.
  - ⚠ **Tool-endpoint SSRF is out of scope** — `tool()` uses `PERMISSIVE` because
    registered endpoints legitimately resolve to `172.17.0.1` on this stack.
  - **The two reserved-address classifiers are NOT merged**, and a parity test
    holds them in agreement where they must agree and asserts they disagree where
    they must, with a control that each can produce both answers.
- **Fragment containment is structural, not advisory.** `networkMode: none` on
  Kestra's **Docker** task runner — measured, with a positive control on `bridge`
  that connects, so the test discriminates. ⚠ **`…runner.process.Process` runs the
  fragment inside the Kestra container**; one word and every containment property
  disappears. Nothing in the product may set `KESTRA_FRAGMENT_NETWORK_MODE`.
- **A `code` fragment is a function BODY, not a program.** A fixed compiler-emitted
  wrapper does all I/O, checks declared output keys inside the container, and
  enforces a 1 MB cap. `validateFragment` rejects `print()` for that reason.
- **Error responses do not echo upstream detail.** The `>= 500` branch, the
  untyped fallback and `TetherError` all return `{error, requestId}`; the real
  message is logged against the same server-generated `X-Request-Id` (never
  trusted from a caller's header). A malformed uuid (`22P02`) is a **400**, and a
  control test asserts `42P01` and friends stay 500.

## 6. Dependency & Supply-Chain Posture

- **Pinned lockfile**, pnpm workspaces, `onlyBuiltDependencies: ["esbuild"]`.
- **Base images are pinned and must not float**: `foundry/kestra:v1.3.29-scripts`
  on `kestra/kestra:v1.3.29-no-plugins` (⚠ dropping `-no-plugins` registers 1404
  plugins and OOMs the engine — it died with exit 0 and `OOMKilled: false`, so the
  obvious check said it was not memory), and `foundry/fragment-base` on a
  digest-pinned `python:3.12-slim`. Every plugin jar version is resolved against
  Maven Central by hand; **`…:1.3.29` is a 404** because plugin artefacts do not
  track the engine's patch version.
- **The fragment image tag names both versions on purpose** — every existing
  fragment was generated against that import set. **Bump it, never re-point it.**
- **Vulnerability scanning**: not currently automated. Recorded as a **known gap**
  rather than implied — see Conformance Notes.
- **The API server holds no Docker socket and its image has no Docker CLI.**
  Kestra is the sole holder. `kestra:check` fails if the mount comes back.

## 7. Logging, Audit & Incident Response

- **Security events logged**: auth failures with IP, path and timestamp — **never
  the presented credential value**; authz denials; admin actions. Tool invocations
  are captured in ops-api's `api_call_log`, read through `opsClient.callLog()` and
  never by SQL (the parent holds no credential for the ops database and must not
  acquire one).
- **Auth-failure throttling**: one shared in-memory instance across
  `auth.middleware.ts` and `identity.middleware.ts`, per-IP, 20 failures/60s → 429
  + `Retry-After`. A single failure is still a plain 401. Per-process is
  deliberate — this server runs as one process, so a restart clearing the throttle
  is an accepted tradeoff, not a gap.
- **The public receivers are rate-limited as a DoS bound, NOT as authentication.**
  The token in the URL is the credential; the IP key is spoofable-by-proxy and
  shared behind NAT. It bounds unauthenticated **lookups**, never executions —
  those are bounded by the M3 tenant budget. ⚠ `/api/health` is deliberately not
  throttled: a limiter on a liveness probe turns a busy moment into a restart loop.
- **`GET /api/signals` is a second endpoint and is NOT `/api/health`.** Health
  answers *can this process serve a request*; signals answers *is the system still
  doing its job* — the four things that fail with nothing raising an error
  anywhere. It is authenticated because it names workspaces and flows. **Never
  merge it into `/api/health`.** `unknown` is a real state and ranks *below*
  `warn`: a signal with nothing to go on must not say `ok`, and must not shout
  over a real warning.
- **Backups stop the writers by default.** Five databases share one instance and
  three are mutually referential; `pg_dump` guarantees nothing across databases.
  `--online` warns and stamps `crossDbConsistent: false`. `roles.sql` carries SCRAM
  hashes, so the artifact dir is `0700` and the file `0600`.
- **Incident response**: rotate on leak immediately and purge from history before
  push (article VIII). ⚠ **`DEMO_DBS` in `backup.sh` must gain every new demo
  database** — one in neither list is silently in no backup at all, and the
  manifest names what it *has*, never what it skipped.

## 8. Threat Notes (framework-specific)

- **Next.js — the proxy route is the highest-value target in the client.**
  `app/api/foundry/[...path]/route.ts` holds `PARENT_API_KEY` and now performs its
  **own** session check, answering 401 JSON. Previously the only control was
  `middleware.ts`'s redirect, whose matcher is a single negative-lookahead regex —
  and the idiom every Next codebase reaches for, adding `api` to that exclusion,
  would have handed the entire parent API to anonymous callers with the root key,
  silently, with no test failing.
  - It is a short **DENY** list (`test-oracle`, `steps`, `executions`), not an
    allowlist: the client's surface is ~200 paths and a hand-transcribed allowlist
    fails as a broken screen with an error that never names the list.
  - ⚠ **Say what this is**: every `requireApiKey` route stays reachable by any
    signed-in user, because this route holds the one shared key. The control for
    that is `requireWorkspaceRole` on the API side, not here.
- **Next.js server/client boundary**: the browser never holds `PARENT_API_KEY`.
  A WebSocket cannot use the proxy, so the progress socket redeems a **60s,
  single-use ticket** bound to one (workspace, execution) minted by an
  API-key-authenticated route. **Never add a socket that takes an execution id
  directly** — that would be the only unauthenticated read path in the product.
  The deleted `/ws/generation` was exactly that shape.
- **Kestra**: its only network is `internal: true` — no route to the internet,
  cloud metadata, Tether or ops-api. It reaches Foundry :4000 and its own database.
  It connects as a dedicated `kestra` role reaching only the `kestra` database,
  never the `foundry` superuser, which would put `workspace_secrets` one query
  away. It **cannot publish ports**, and `kestra-ui` is for internal engineers
  only — no tenant isolation. **Never proxy it, iframe it, or give a client the URL.**
- **`POST /api/executions/begin` reads the namespace FROM KESTRA, never from the
  request body.** Validating the body instead reads as authorisation and is not —
  another workspace's namespace parses and resolves fine. It fails closed:
  unknown execution ⇒ 403, Kestra unreachable ⇒ 503.
- **Postgres**: `REVOKE … FROM <role>` does **not** remove a privilege held via
  the pseudo-role `PUBLIC`. Revoke from `PUBLIC` first. This bit twice.
- **`packages/mcp-bridge` is off by default** (`profiles: ["mcp-bridge"]`) and its
  DSN is required rather than defaulted — it used to default to the **owner**
  credential on `foundry_parent` in its own source. ⚠ **Still open**: its tools
  take `workspaceId` from the caller's arguments under one shared key, so any
  holder reads every workspace's schema. Fix that and give it a least-privilege
  role before putting it on a live path.

## Conformance Notes

- Changes are reviewed against this standard by `/speckit-comply` and the
  pull-time review. Deviations must be justified or the standard amended via
  `/speckit-update-standards`.
- ⚠ **KNOWN OPEN GAPS, recorded so their absence is a bound and not an assumed
  capability.** None is this standard's to close today; each is named so that a
  future reader does not mistake silence for coverage.
  1. **No automated dependency vulnerability scanning.** No Dependabot, no `audit`
     step in CI.
  2. **`packages/client` has no ESLint configuration at all.**
  3. **mcp-bridge has no tenant model** (above).
  4. **DNS rebinding is narrowed, not closed** (§5).
  5. **`git config core.hooksPath` is per-workstation and nothing in the repo can
     assert it.** ⚠ **On THIS machine it is now set to `.githooks` and verified
     firing** — a forced `git add -f` of staged key material is refused by name
     with exit 1 (re-measured 2026-08-25, after an earlier measurement on the same
     day found it unset and the same add succeeding). The residual gap is that a
     **fresh clone starts with it unset**, leaving article VIII's enforcement
     layer 2 and article I's commit-time gate inert until someone runs the command.
     `.githooks/post-checkout` and `post-merge` exist but cannot bootstrap this,
     because they are themselves only reached once `core.hooksPath` points at them.
     Layer 3 (CI) is unaffected either way and is the control that does not depend
     on a developer's local config.
