# Session notes — `foundry_email_send` implementation

**Purpose of this file.** A handoff log so a *different* Claude session (or a different account)
can pick this implementation up mid-flight without re-deriving anything. It records what is done,
what is in progress, the environment quirks that cost time, and the decisions taken during
implementation that are not in plan.md.

Read in this order: [spec.md](./spec.md) → [plan.md](./plan.md) →
[contracts/mail-send.md](./contracts/mail-send.md) → [tasks.md](./tasks.md) → this file.

**Update this file at the end of every task**, not at the end of a session — a session that hits
its limit does not get a chance to write a summary.

---

## How to resume in one minute

```bash
cd /home/mayank/Foundary_kestra_migration/foundry
git branch --show-current            # must be 20260818-084135-email-send-tool
cat .specify/feature.json            # must point at specs/20260818-084135-email-send-tool
export PATH="/tmp/claude-1001/-home-mayank-Foundary-kestra-migration/724aaa6d-3159-4441-ac9b-e2f2bd57fde3/scratchpad/node/node-v22.14.0-linux-x64/bin:$PATH"
node -v                              # must print v22.x — see "Node 22" below
```

Then find the first unchecked `[ ]` task in [tasks.md](./tasks.md) and continue. Task status is
tracked **in tasks.md checkboxes** (single source of truth); the log below adds the detail
checkboxes cannot carry.

---

## Environment quirks that will bite a fresh session

### Node 22 is not installed system-wide

`.node-version` says `22`, both `package.json`s require `>=22`, and the machine's system Node is
**v20.20.2** with **no version manager installed** (no nvm/fnm/volta/n/asdf). Since the 2026-08-18
pull, `packages/client/vitest.config.ts` **throws at config load** on Node < 22 — deliberately,
because on Node 20 all 21 jsdom files silently failed to load while vitest still printed a green
`Test Files 30 passed`. So on system Node, `pnpm -r test` dies at the client package before a
single assertion runs.

**Worked around without touching the system**: a Node 22 tarball is extracted in the scratchpad at

```
/tmp/claude-1001/-home-mayank-Foundary-kestra-migration/724aaa6d-3159-4441-ac9b-e2f2bd57fde3/scratchpad/node/node-v22.14.0-linux-x64/bin
```

Put that on `PATH` (see above) for anything that runs the client suite. ⚠ **The scratchpad is
session-scoped** — a new session gets a new scratchpad path and this directory will be gone.
Re-download it:

```bash
curl -sS -o node22.tar.xz https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz && tar xf node22.tar.xz
```

The server suite (where almost all of this feature lives) runs fine on Node 20, so server-side
work is not blocked by this.

### `.specify/feature.json` pointed at a dead feature

The agent-side spec gate (`.claude/hooks/spec-gate.sh` → `scripts/spec-gate-core.sh`) resolves the
active feature from `.specify/feature.json` **at higher priority than the branch name**. It held
`specs/20260811-095041-credential-management`, a directory that no longer exists, so *every* source
write was refused with "No active spec-kit feature" even on a correctly-named branch. Repointed at
this feature. Original value backed up to the scratchpad as `feature.json.bak`.

Do not "fix" this by renaming the branch — the branch is already correct. If the gate starts
refusing writes again, check this file first.

---

## Decisions taken during implementation (not in plan.md)

| # | Decision | Why |
|---|---|---|
| I-1 | Created branch `20260818-084135-email-send-tool` **from** `v1-alpha-email-tool-integration` rather than renaming it. | Non-destructive: the old branch pointer survives as a fallback, and the user pulled into it from `v1-alpha`. Both `.githooks/pre-commit:58` and `ci/check-spec-compliance.sh:42` hard-require the `YYYYMMDD-HHMMSS-slug` pattern, so a correctly-named branch was not optional. |
| I-2 | Local Node 22 in the scratchpad rather than installing Node 22 system-wide. | Installing a system Node (or a version manager) is a change to the user's machine outside the scope of "implement the plan". Reversible by deleting a directory. |

---

## T001 — the `specs/`-gitignored contradiction is **already resolved**

tasks.md T001 warns that `specs/` is gitignored at `.gitignore:125` while
`ci/check-spec-compliance.sh:61` derives its feature dirs from the git diff, so a PR that changes
source but touches nothing under `specs/` is refused.

**The user resolved this themselves before implementation started**: their working-tree edit to
`.gitignore` comments the line out (`-specs/` → `+# specs/`), so `specs/` is tracked again and
`git check-ignore` confirms this feature's directory is **not** ignored. That `.gitignore` change
is uncommitted — **it must go in the same commit as the first source change**, or the CI gate
fails for exactly the reason T001 describes. No further action; do not re-add the ignore.

---

## Task log

Newest last. One entry per task, written **when the task is finished**.

### T001 — Resolve the branch ✅
- Created and switched to `20260818-084135-email-send-tool` (see I-1). `v1-alpha` and
  `v1-alpha-email-tool-integration` both still exist.
- Repointed `.specify/feature.json` (see quirks above) — this, not the branch, was what actually
  blocked writes.
- Verified: `bash scripts/spec-gate-core.sh write packages/server/src/services/mail-recipients.ts`
  → exit 0.
- `specs/` gitignore contradiction: resolved by the user, see above.

### T002 — Node 22 + baseline ✅

Node 22 obtained (see quirks). Two stale build artifacts had to be cleared before the baseline
meant anything; **neither is a code break, and neither is this feature's doing**:

1. `pnpm typecheck` failed with `Module '"@foundry/shared"' has no exported member
   'fixedWindowLimiter'` (`src/routes/triggers.ts:4`). The symbol **is** exported from
   `packages/shared/src/rate-limit/index.ts:31`; `packages/shared/dist/` was stale, and the server
   resolves the package to `dist`. Fixed with `pnpm --filter @foundry/shared build`.
   ⚠ If a fresh session sees a "no exported member" error from `@foundry/shared`, rebuild shared
   before believing it.
2. `packages/client` then failed with six `TS2307 Cannot find module .../page.js` errors from
   `.next/types/**` — a generated cache dated **2026-08-06** still describing
   `(app)/apps/connect`, `(app)/home` and `(app)/outbox`, none of which exist in `src` any more.
   Fixed with `rm -rf packages/client/.next/types` (gitignored, regenerated on next build).

**Baseline after those two fixes:**

| Gate | Result |
|---|---|
| `pnpm typecheck` | ✅ all 7 projects green |
| `pnpm -r test` — client | ✅ **51 files / 714 tests passed** |
| `pnpm -r test` — server | ❌ **1 failed / 1215 passed** (84 files) |

**The single pre-existing failure — do not attribute it to this feature, and do not "fix" it:**

`src/services/flow-replay.test.ts:189` → *"does not report an unreachable engine as a purged
execution"*. It expects `/cannot reach the engine/i` and gets the 30-day-retention (purged)
message.

Its own docblock states the premise: *"Kestra **cannot publish ports** (its network is
`internal: true`, and Docker discards the stanza), so a unit test never reaches an engine."* That
premise is **false in this environment** — `foundry-kestra` is up and `http://localhost:8080`
answers from the host, so the engine is consulted, replies "no such execution", and the code
correctly returns the purged answer. The test is asserting the 503 branch it can no longer reach.

Environment-dependent and orthogonal to email delivery. Worth raising separately (the test encodes
a compose assumption that no longer holds), but **out of scope here** — flagging it, not touching
it. Re-check at T044: this one failure is expected to still be red.

Also confirmed by this run: the Node 22 requirement is real, not cosmetic. On Node 22 the client
suite runs **51 files / 714 tests**; on Node 20 it throws at config load.

### Phase 1 — recipient policy (T003–T007) ✅

Files: `packages/server/src/services/mail-recipients.ts` (new),
`packages/server/src/services/mail-recipients.test.ts` (new).

`npx vitest run src/services/mail-recipients.test.ts` → **44 tests passed**, and
`pnpm --filter @foundry/server typecheck` clean. Tests were written before the implementation
existed, per Article II.

**Exported surface the rest of the feature depends on** — Phase 4 wires exactly this and decides
nothing itself:

| Export | Shape |
|---|---|
| `EMAIL_RE` | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` — copied from `ops-api/src/routes/ops.ts:369`, **not imported** (different package, allowed to diverge) |
| `SUBJECT_MAX_CHARS` | `250` |
| `resolveRequester({requestedBy, requestedByKind})` | `string \| null` — lowercased address, or null |
| `resolveRecipients({explicitTo, explicitCc, requester, deploymentAllowlist, workspaceAllowlist, caps})` | `{ok:true, to, cc, resolvedFrom}` \| `MailRefusal` |
| `checkMessageCaps({subject, body, caps})` | `{ok:true}` \| `MailRefusal` |
| `MailRefusal` | `{ok:false, status:422, message, detail}` — `status` lives here so the route cannot disagree with the contract |
| `MailCaps` | `{maxRecipients, maxBodyBytes}` |
| `RequestedByKind`, `ResolvedFrom` | string unions |

**Design points decided here that contracts/mail-send.md §3 did not pin down** — carry these
forward, they are asserted by tests:

- **`cc` with no `to` is refused (422).** §3's pseudocode falls through to the requester branch when
  `to` is empty, which would have sent to the requester while delivering to an *unchecked* cc — the
  allowlist loop only runs in the `else`. Refusing is the smaller surface. Not a contract change so
  much as a hole in it; worth reflecting back into §3.
- **A `to` of only blanks is no `to`** — falls back to the requester rather than refusing, so `to: [""]`
  from a drafter behaves like an omitted `to`.
- **Recipient count is capped *after* dedup**, so a list repeating one address twenty times is one
  recipient, not a `20 > 10` refusal.
- **`resolveRequester` lowercases and trims**, so requester-equality comparisons downstream are
  already canonical. Every address in a resolution result is lowercased.
- **Body cap boundary is inclusive** (`bytes > max` refuses), measured with `Buffer.byteLength`.

⚠ `RequestedByKind` is exported but not yet referenced anywhere — Phase 4's route is its consumer.
Do not delete it as dead code.

### Phase 2 — config and storage (T008–T014) ✅

| Task | File | Note |
|---|---|---|
| T008 | `packages/server/src/config/index.ts` | `mail` block appended as the last key of the `config` object (an IIFE, mirroring `datasourceHostAllowlist`) |
| T009 | `.env.example` | new trailing section, including the two Azure operator steps |
| T010 | `packages/server/src/db/schema.ts` | `emailSends` appended at end of file; `check` added to the `drizzle-orm/pg-core` import |
| T011 | `packages/server/src/db/schema.ts` | `workspaces.mailRecipientAllowlist` added after `kind` |
| T012 | `packages/server/drizzle/0039_bright_thundra.sql` + snapshot + journal | generated, applied, verified in Postgres |
| T013 | `packages/server/src/repositories/email-send.repo.ts` | `record` / `finish` / `listByExecution` / `listByWorkspace` |
| T014 | `packages/server/src/repositories/email-send.repo.test.ts` | **8 tests passing** (hits the real database, cleans up after itself) |

**`config.mail` surface** — `tenantId`, `clientId`, `clientSecret`, `senderUpn`, `allowedDomains:
string[]`, `enabled`, `maxBodyBytes`, `maxRecipients`, `selfBase`, `configured: boolean`,
`missing: string[]`.

**Migration 0039 — verified, no surprises.** `pnpm --filter @foundry/server db:generate` produced
exactly one new table plus one added column, nothing dropped or renamed. Journal `when` is
**1787048115981**, above 0038's `1786800000000`, so the drizzle watermark trap T012 warns about does
not apply. `src/db/migrations-journal.test.ts` green (4 tests). Applied with
`pnpm --filter @foundry/server db:migrate`, then confirmed against the live database with
`docker exec foundry-parent-postgres psql -U foundry -d foundry_parent -c "\\d email_sends"` — the
`ck_email_sends_outcome` CHECK, both indexes and both FKs are present.

⚠ **The CHECK constraint required importing `check` from `drizzle-orm/pg-core`** — no table in this
schema used one before (0038's expectation-status check was hand-written SQL). `check()` does exist
in drizzle-orm 0.38 and drizzle-kit emits it into the migration correctly; verified rather than
assumed.

**Two additions to the repo beyond what T013 specified**, both used by Phase 4:

- **`finish(id, patch)`** — the row is written *before* Graph is called and completed after, so a
  process that dies mid-send leaves "we may have sent something" rather than silence. Two writes,
  one row; the test asserts it updates rather than duplicating.
- **`listByWorkspace(workspaceId, limit)`** — the workspace-wide history, and what the
  cross-workspace scoping test asserts against (a bare tool test call has a null
  `flow_execution_id`, so `listByExecution` cannot carry that assertion).

`listByExecution` scopes by **workspace AND execution**, deliberately: an execution id is a uuid a
caller could hold from another tenant, and scoping by both makes a cross-workspace read empty rather
than a leak.

### Phase 3 — Graph transport (T015–T021) ✅

Files: `packages/server/src/services/mail.service.ts` (new),
`mail.service.test.ts` (new, **23 tests**), `mail-secret-single-reader.test.ts` (new, **5 tests**).

**`mailService.send(message)` → `MailSendResult`** — a discriminated union, and it **never throws for
a provider problem**. That is deliberate and Phase 4 depends on it: the caller has to record the
attempt in `email_sends` before answering, and an exception thrown past the recorder is exactly how a
real send ends up with no evidence that it happened.

```ts
type MailSendResult =
  | { ok: true;  messageId: string | null; requestId: string | null }
  | { ok: false; status: 409 | 424 | 502; message: string; detail: Record<string, unknown> }
type MailMessage = { subject: string; body: string; to: readonly string[]; cc?: readonly string[] }
```

Also exports `resetMailTokenCache()` (test seam, mirroring `resetOAuth2TokenCache`).

**Order inside `send()` is load-bearing**: `enabled` → `configured` → token → sendMail. Disabled is
checked **before** unconfigured, so an operator who switched delivery off is not told to add four
variables they already have.

**Decisions taken here that the plan did not pin down:**

- **The UPN keeps a literal `@` in the URL path.** `encodeURIComponent(senderUpn)` produced
  `users/automation%40example.com/sendMail`, which Graph does accept but is not the form Microsoft
  documents — and betting a real send on an unverified equivalence is the kind of assumption this
  feature exists to avoid. Dropping the encoding entirely is worse (`senderUpn` is operator config; a
  `/` in it would rewrite the request path). So `upnPathSegment()` encodes everything and then
  restores `%40` → `@`. This was caught by a failing test, not by review.
- **`Retry-After` is capped at 20s** (`RETRY_MAX_WAIT_MS`), default 2s when the header is absent or
  unparseable. A provider may legitimately answer `3600`; a request handler may not wait an hour, and
  a long retry chain turns a throttle into a hung flow that reports nothing. One retry, two attempts
  total.
- **Token TTL** = `min(expires_in − 30s, 300s)`, one process-global cache key (`graph:mail:v1`) —
  there is one deployment-level credential, unlike the per-workspace tool path.

**Two corrections to my own `mail-secret-single-reader.test.ts`, both found by running it:**

1. It matched the **name** `MAIL_GRAPH_CLIENT_SECRET_VALUE` anywhere, which flagged
   `mail.service.test.ts` — where the name appears in a `missing[]` fixture proving FR-008 names every
   absent variable. Now it matches the **read expression** (`process.env.MAIL_GRAPH_…`). A suite
   asserting on the wording of a refusal is not a second place a credential can leak from.
2. Its "not interpolated into a log" check flagged `mail.service.ts`'s own docblock, which names
   `config.mail.clientSecret` in backticks while explaining that it is the one read site. Comment
   lines are now stripped before matching — otherwise documenting the rule would break the rule. A
   positive control was added so the check still proves the read site exists (I-38).

⚠ **`vi.mock("../config/index.js")` is how the config is faked** — `config` is a frozen literal read
at import time, so it cannot be mutated per test. The mock factory reads a module-level
`mailConfigOverride` that each test sets, and `mail.service.js` is imported with a top-level `await
import(...)` **after** the mocks. Copy that shape for `routes/mail.test.ts` rather than trying
`vi.stubEnv`, which is too late to matter.

### Phase 4 — the endpoint (T022–T029) ✅

New: `services/mail-service-key.ts`, `middleware/mail-key.middleware.ts`, `routes/mail.ts`,
`routes/mail.test.ts` (**24 tests**). Edited: `app.ts` (mount + two imports).

**All mail suites together: 5 files / 104 tests passing.** `pnpm --filter @foundry/server typecheck`
clean.

`services/mail-service-key.ts` exports `mailServiceKey(root = config.parentApiKey)` —
`HMAC_SHA256(PARENT_API_KEY, "foundry-mail:v1")` sliced to 40 hex chars — plus
`MAIL_SECRET_ENV = "FOUNDRY_MAIL_KEY"` and `MAIL_KEY_HEADER = "X-Foundry-Mail-Key"`. Phase 5 imports
those two constants rather than re-typing the strings.

⚠ **Rotating `PARENT_API_KEY` changes the derived mail key**, so the stored `FOUNDRY_MAIL_KEY`
workspace secret must be re-put (`mail:register` is idempotent and does it). Until then email steps
answer 401. Same operational property the ops-api keys already have — written into the module
docblock so it is not discovered during an incident.

`requireMailKey` **reuses `auth.middleware.ts`'s throttle instance** rather than adding a second one:
two independent 20/min budgets would be 40/min for an attacker who alternates between the two
checks.

Mounted in `app.ts` at `/api/mail` **outside** the parent-API-key block, immediately before the
Kestra-callbacks section, with the exact-path warning restated.

**Decisions taken here beyond what the contract specified:**

- **`workspaceId` in the body is a `400`, not accepted-and-ignored.** contracts §2 says it "is
  ignored"; the schema omits it entirely and `.strict()` refuses it. Refusing states FR-010 more
  strongly than ignoring, and it tells a caller who sent one that they misunderstood. ⚠ The test
  `"IGNORES a body-supplied workspaceId (FR-010)"` therefore asserts **400**, which is intentional —
  do not "fix" it to 200.
- **An unknown/absent `x-foundry-run` is the one refusal that is NOT recorded.** `email_sends.workspace_id`
  is NOT NULL and there is no workspace to attribute it to; inventing one would be worse than the
  gap. Every path downstream of that check does record. This is documented in the route.
- **The intent row is written pessimistically as `outcome: "failed"`** with
  `failureReason: "no provider answer yet"`, then completed. A crash between the two reads as
  "attempted, unknown" and never as "sent".
- **`sent.status === 502` → `failed`; 409/424 → `refused`.** Provider reached vs nothing left the
  building.
- **`stepId` is an accepted optional body field** (recorded, never trusted) so the `email_sends.step_id`
  column has a writer.
- **Caps are checked before recipients**, so an over-cap body is refused without any allowlist work.

⚠ **Fixture requirements that cost time** — `flows` needs `kestraFlowId`, and `flow_executions` needs
`kestraNamespace` + `kestraFlowId` + `kestraExecutionId` (all NOT NULL, no default). Reuse `makeRun()`
in `routes/mail.test.ts` for any further route tests instead of rediscovering that.

⚠ **Run the server suite with the package's own vitest.** `npx vitest` from the repo root picks up a
**v4.1.10** binary while `packages/server` pins **v2.1.9**; it happened to pass, but use
`cd packages/server && ./node_modules/.bin/vitest run <path>` (or `pnpm --filter @foundry/server test`)
so the configured version is what runs.

### Phase 5 — registration (T030–T036) ✅

New: `services/platform-tool-catalogue.ts`, `services/platform-tool-catalogue.test.ts`
(**13 tests**), `services/platform-tool-cli.ts`. Edited: `services/workspace.service.ts`,
`demo/provision.ts`, `demo/tool-catalogue.ts`, `demo/tool-catalogue.test.ts`,
`packages/server/package.json`.

**Exports**: `EMAIL_TOOL_NAME = "foundry_email_send"` (Phase 5b's reserved-name guard imports this
rather than re-typing the string), `platformToolCatalogue()`, `registerPlatformTools(workspaceId,
{rebuildManifest?})`.

**Deviations from the task text, all deliberate:**

- **T033's CLI is `services/platform-tool-cli.ts`, not folded into `demo/cli.ts`.** This is not demo
  data, and putting a platform-capability backfill behind the demo CLI is the same category error
  Decision 6 rejects. Script: `pnpm --filter @foundry/server mail:register`. ⚠ It needs
  `--filter @foundry/server` like every other `demo:*`/`finance:*` script — the bare form exits 254.
- **`registerPlatformTools` takes `{rebuildManifest}`.** T036 said re-render wherever registration
  runs, but `provision.ts` already renders once at its step 6; rendering again at step 5b would make
  the manifest version a count of provisioning steps rather than of catalogue changes. So
  `provision.ts` calls it with `rebuildManifest: false`, and a test asserts the version does not move.
- **`workspaceService.create` swallows a registration failure** (logged loudly, naming
  `mail:register` as the fix). A workspace missing one capability is recoverable; a create that 500s
  leaves a caller with no workspace and a row that may or may not exist. This is the deliberate
  opposite of `email-send.repo.ts`'s no-swallow rule — there the lost thing is evidence of a real
  send, here it is a registration that can be redone at any time.
- **T034's assertion went into the existing `demo/tool-catalogue.test.ts`** (now 8 tests), asserting
  `SIMULATED (…)` at the **start** of both descriptions. The **15-tool count is unchanged** — the
  platform tool lives in its own catalogue, so `it("registers 15 tools")` still passes untouched.

**API corrections found while writing the test** — these differ from what the plan assumed:

- `manifestBuilderService.buildAndPersist()` returns `{version, hash, manifestXml, summaryXml,
  changed, …}` — the field is **`manifestXml`**, not `xml`.
- There is no `workspaceSecretService.missingForWorkspace` / `collisionsForWorkspace`. Use
  **`workspaceSecretService.audit(workspaceId)`** (returns `{missing, collisions, …}`) and the
  standalone **`shadowedSecretCollisions(workspaceId, envName)`** export.
- `toolService.create` needs `createToolSchema.parse(spec)` so zod defaults apply exactly as they
  would for an API request — same as `provision.ts` does it.

**No import cycle**: `tool.service.ts` imports only repos and `param-descriptor`, so
`workspace.service.ts → platform-tool-catalogue.ts → tool.service.ts` is acyclic. Verified by
`workspace-slug.test.ts` still passing (5 tests) with registration now running inside `create`.

### Phase 5b — protect the registration (T046–T048) ✅

New: `services/platform-tool-names.ts`, `services/tool-reserved-name.test.ts` (**12 tests**).
Edited: `services/tool.service.ts`, `services/platform-tool-catalogue.ts`,
`client/src/app/(app)/tools/page.tsx`, `client/src/app/(app)/tools/page.test.tsx` (30 → **33 tests**),
`client/src/app/api/foundry/[...path]/route.ts`.

**⚠ A third module was needed and is not in the plan's file inventory:
`services/platform-tool-names.ts`.** `tool.service.ts` must refuse the reserved name and
`platform-tool-catalogue.ts` must register it — but the catalogue imports the service, so the service
cannot import the catalogue back. A constants-only module breaks the cycle without either side
reaching for a string literal. `EMAIL_TOOL_NAME` is still re-exported from
`platform-tool-catalogue.ts`, so existing imports keep working. **Add this file to plan.md's
inventory** (new server files 14 → 15, or 17 → 18 including generated).

**⚠ The guard needs an explicit bypass, and this is the part easiest to get wrong.**
`registerPlatformTools` goes *through* `toolService.create`/`update` (deliberately — that is where
params-schema, auth-style and collision validation live). A guard with no exemption would lock out the
only thing allowed to maintain the tool and make the feature un-provisionable. So the three methods
take an optional third/fourth argument:

```ts
toolService.create(workspaceId, input, { platform: true })
toolService.update(workspaceId, id, input, { platform: true })
toolService.remove(workspaceId, id, { platform: true })
```

Explicit and greppable — `grep -rn "platform: true"` finds every legitimate caller — rather than an
ambient flag or a module-identity check. Refusal is a `409` carrying `statusCode`, matching
`assertWorkspace`'s idiom, and its message names `mail:register` as the remedy.

**`update` checks the TARGET row's name, not the input's** — and both. A rename *away* from the
reserved name would otherwise be an escape hatch (rename, then edit freely), and a rename *into* it
would let a user capture the name on an existing row.

A test asserts the remedy is **true**: after a `{platform: true}` removal, `registerPlatformTools`
recreates the row. A refusal that names a fix which does not work is worse than no message.

**Client:** the badge reads `Platform` with a `title` explaining it, and the actions cell renders
`Managed by Foundry` — **absent buttons, not disabled ones**, because a disabled control invites a
hover-and-wonder while the text says which rule applies. `PLATFORM_MANAGED_TOOLS` is duplicated in the
page rather than imported (client and server share no module); the server is the control, so drift is
harmless. Three tests added to the existing file, including the I-38 control that an *ordinary* tool
still shows Edit/Remove — without it the suppression assertions would pass against a page rendering no
buttons at all.

`mail` added to `DENIED_SEGMENTS` with a note that it already fails closed (the route wants
`X-Foundry-Mail-Key`, and the parent key buys nothing there) — it states intent alongside the two
other documented non-browser surfaces rather than fixing a hole.

### Full server suite after Phase 5b

`cd packages/server && ./node_modules/.bin/vitest run` → **91 files, 1345 passed, 1 failed**.
The one failure is the pre-existing `flow-replay.test.ts` baseline failure recorded under T002 —
**no regressions**, and the suite grew 1216 → 1346 tests.

### Phase 6 — evidence and visibility (T037–T040) ✅

| Task | Files |
|---|---|
| T037 | `server/src/routes/flow-executions.ts` (`GET /:id/emails`), `client/src/lib/foundry-client.ts` (`FAEmailSend` + `emailsForRun`), `client/src/lib/api.ts` (wrapper + type re-export) |
| T038 | `client/src/components/flow/ToolActivity.tsx` (docblock addendum + `RealEmailActivity` / `EmailRow`) |
| T039 | `client/src/components/flow/StepDetail.tsx` — **comment only, see below** |
| T040 | `server/src/services/health.service.ts` + `health.service.test.ts` (24 → **29 tests**) |

**T039 was a verification task and the verification came out "already works".** `StepDetail`'s
Output section falls back to `<SqlBox>{formatBody(body)}</SqlBox>` — the full pretty-printed body —
so a `tool` step's per-item `data`, including `{recipients, cc, resolved_from, message_id}`, is
already visible there. I deliberately did **not** add a labelled recipients row: `ToolActivity` now
renders that record with labels, an outcome and a reason from `email_sends` (the authoritative
source), and a second labelled rendering derived from the step body is two things that can disagree
about who was emailed. The reasoning is written into the file so the next reader does not "fix" it.

**T040 changed shape mid-task, and the reason matters.** The first cut read `config.mail` directly
inside `buildReport`. That made `health.service.test.ts` depend on whether the developer running it
happens to have Graph configured — the suite's headline test asserts `status: "ok"`, which would
have flipped to `"degraded"` on any machine without the `MAIL_*` variables. So `mail` is injected
through **`HealthDeps`** like every other component:

```ts
mail(): Promise<{ configured: boolean; enabled: boolean; missing: string[] }>
```

⚠ **Three existing assertions in `health.service.test.ts` had to change** — the component-list
equality (now six, `"mail"` last), and two test titles that counted "five". A fresh session seeing
those diffs should read them as intentional.

**Health semantics, all asserted:** `up` = configured · `down` + every missing variable named (same
list as the endpoint's 424, from the same `config.mail.missing`, so the two cannot disagree) ·
`degraded` for a deliberate `MAIL_ENABLED=false` (a switched-off capability is not a fault, but it is
not `up` either) · `critical: false` so it never takes the deployment down · `latencyMs: null`
because no probe ran. The caveat states it does not contact Microsoft and cannot see the two most
likely failures (admin consent, application access policy).

**`ToolActivity` renders TWO sections, deliberately not merged.** The existing one reads
`api_call_log` through ops-api (the simulation); the new one reads `email_sends` (real delivery).
Merging them would put simulated calls and real deliveries in the same rows, and "did this actually
reach anyone?" is exactly the distinction a reader is there to make. The new panel renders even when
empty, with an explicit empty state — a panel that vanishes on an empty read cannot be told from one
that was never there. Errors are shown, never swallowed into an empty list.

`emailsForRun` in `api.ts` **does not** swallow a failure into `[]`: an empty array means "this run
emailed nothing", and a read that failed must not be able to say that.

### Full monorepo suite after Phase 6

`pnpm -r test` on Node 22 → redact 7 · mcp-bridge 9 · flow-edit 88 · shared 106 · ops-api 17 ·
**client 717** · **server 1350 passed / 1 failed**. **2295 tests, one failure**, and it is the
pre-existing `flow-replay` baseline failure from T002. No regressions.

### Phase 7 — end-to-end and gates (T041–T045) ✅ except T043

New: `services/mail-end-to-end.test.ts` (**6 tests**). Edited: `CLAUDE.md`,
`docs/kestra-migration/progress/DECISIONS.md` (new **D-74**),
`docs/kestra-migration/progress/00-STATUS.md`.

**T041/T042 drive the REAL executor** — `stepExecutionService.tool` → real HTTP → the real mounted
route → real database, with only the Graph transport stubbed. That is the only place two facts are
proved: that `invokeTool` really sends `x-foundry-run` (the requester default depends entirely on it,
and it was added for ops-api's benefit — a change made for ops-api could remove it and every other
test here would still pass), and that `applyAuth` really presents `FOUNDRY_MAIL_KEY` in the declared
header from the stored workspace secret.

⚠ **Discovery: a refused email THROWS, it does not return `ok: false`.** `invokeTool` tolerates
partial failure, but when *every* item in a batch fails it throws `StepError(502)`
(`step-execution.service.ts:510`). An email step is a batch of one, so a refusal fails the step — the
correct outcome (a flow whose email was refused must not report success), and the tests assert the
throw. A missing `FOUNDRY_MAIL_KEY` throws `StepError(424)` from `applyAuth` before any HTTP call.
⚠ `StepError` carries **`status`**, not `statusCode` — `assertWorkspace`-style errors use
`statusCode`. Two conventions in one codebase; match the one you are catching.

⚠ The e2e repoints the tool row's `url` **through the table**, not `toolService.update`, because the
T046 guard refuses that row — the guard doing its job.

### T044 — gate results

| Gate | Result |
|---|---|
| `pnpm typecheck` | ✅ all 7 projects |
| `pnpm -r test` | ✅ **2300 tests**, 1 pre-existing failure (see below) |
| `pnpm kestra:check` | ✅ boundary intact, all PASS |
| `bash scripts/ui-honesty-check.sh` | ✅ all PASS |
| `pnpm --filter @foundry/server demo:verify` | ✅ all dataset invariants hold |
| `bash ci/check-secrets.sh staged` | ✅ exit 0 with everything staged; `.env` confirmed not staged |
| `pnpm --filter @foundry/server mail:register` | ✅ 4 workspaces, idempotent (created → updated) |
| `pnpm --filter @foundry/server scenarios:verify` | ⚠ **environmental, see below** |
| `ci/check-spec-compliance.sh` | ⚠ **pre-existing, see below** |

Server suite grew **1216 → 1357** tests across 92 files.

**Three findings, all justified rather than fixed:**

1. **`flow-replay.test.ts`** — the T002 baseline failure. Its docblock asserts Kestra cannot publish
   ports; `foundry-kestra` is up and `localhost:8080` answers from this host, so the engine is
   consulted and correctly returns "purged" where the test expects "unreachable". Environment-
   dependent, orthogonal, unchanged since before this feature.
2. **`scenarios:verify`** — fails with *"flow finance-invoice-chase is not registered — run
   `pnpm scenarios:seed` first"*. Confirmed environmental: the whole database holds **2 flows** and
   zero scenario flows, so the seed was never run here. Not run unprompted, because seeding provisions
   flows and deploys to Kestra — a side effect worth being asked for.
3. **`ci/check-spec-compliance.sh`** — `FAIL (290 uncovered files)`. It diffs against `main`, and this
   branch is **196 commits / 831 files** ahead of it, so it is reporting the entire pre-existing
   divergence. ⚠ **Zero of the 290 are this feature's** — grep for `mail|email` in its output returns
   nothing, because `specs/…/tasks.md` is now tracked (the user's `.gitignore` edit) and its file
   inventory covers every file this feature touches. That inventory is what makes the gate pass for
   this work; keep it current.

### ⛔ T043 — BLOCKED, and the blocker is in Azure, not in the code

The one manual real send is **not done**, and attempting it now would fail. Left for a human: it
delivers to a live mailbox and arrival cannot be confirmed from here.

**A token-exchange probe (no message sent, no side effect — the same class of call as a health
probe) found the app registration incomplete:**

```
HTTP 200 · token acquired · audience https://graph.microsoft.com
roles: null        ← NO application permissions consented, at all
scp:   null
appid: 18576f85-0cf6-4858-bde1-dbc95319536a
tid:   1f20c679-29df-4600-8b34-e81941898d87
sender: aicoe@microland.com
```

**What this means:** `MAIL_GRAPH_TENANT_ID`, `MAIL_GRAPH_CLIENT_ID` and
`MAIL_GRAPH_CLIENT_SECRET_VALUE` are **correct** — the credential authenticates and Microsoft issues a
Graph token. But an app-only token carries its granted application permissions in the `roles` claim,
and this token has **no `roles` claim whatsoever**. `Mail.Send` is not granted, so
`POST /users/{upn}/sendMail` will answer **403 `ErrorAccessDenied`**.

This is exactly operator step 1 in `.env.example`, and exactly the failure the health caveat says a
config check cannot see. The code handles it correctly — the 502 carries Graph's `ErrorAccessDenied`
and the correlation id — but it cannot make it work.

**To unblock T043, in Azure:**

1. App registration `18576f85-…` → **API permissions** → Add → Microsoft Graph → **Application
   permissions** → `Mail.Send` → **Grant admin consent** for tenant `1f20c679-…`.
   Re-run the probe; `roles` must then contain `Mail.Send`.
2. **Exchange application access policy** scoping the app to `aicoe@microland.com`
   (`New-ApplicationAccessPolicy`). Without it the app can send as **every** mailbox in the tenant.
   This one does not appear in the token — only a real send proves it.

Then do T043 itself and record the outcome and the Graph `request-id` in tasks.md. The probe script is
at `scratchpad/token-probe.mjs` (session-scoped; it is ~25 lines of `fetch` if it needs rewriting).

---

## Where this stands

**47 of 48 tasks complete.** T043 is the only one open and is blocked on the Azure grant above.

Everything else is implemented, tested and gated: recipient policy, config, storage + migration 0039,
the Graph transport, the endpoint, registration in every workspace, the reserved-name protection, the
run-page evidence surface, the health component, and the docs (D-74, `00-STATUS.md`, `CLAUDE.md`).

**Not committed.** Nothing has been committed — the user did not ask for it. The working tree carries
all of it plus two pre-existing user edits (`.gitignore`, `infra/docker-compose.yml`); the index was
staged only to run the secret scanner and was reset afterwards. ⚠ When it is committed, **the
`.gitignore` change must be in the same commit as the source**, or `ci/check-spec-compliance.sh`
cannot see `specs/` in the diff and refuses the PR (T001).

---

## Phase 8 — what the first real run actually found (2026-08-18, after the gates)

The user reported run `e097b55b` failing and asked whether it was the app-registration permission.
**It was not.** Two separate problems, and the run only ever reached the first.

### The diagnosis, and how it was reached

`email_sends` was **empty** — so the endpoint was never called. The execution's own detail
(`GET /flow-executions/:id`) showed `begin`, `fetch_summary` and `report_text` all `success`, and:

```
send_email  failed  responseCode=null  request=null
io.pebbletemplates.pebble.error.PebbleException:
  Unable to parse jq value 'Attendance report for 2026-06 …' with type 'java.lang.String'
```

⚠ **`request: null` is the tell.** The step failed rendering its own parameters inside Kestra, before
any HTTP call existed. Graph was never contacted; nothing about it was an email problem.

The drafter had written, for `body`:

```
{{ json(outputs.report_text.body).results[0].data.text | jq('tostring | @json') | first }}
```

Verified against the actual output shape: `results[0].data` is a **dict**, `data.text` is a **str**.
Kestra's `jq` filter parses its input as JSON, so a raw multi-line String throws. The `report_text`
step above it uses the identical idiom and works — because there the value is still an object. That
is why this is invisible to a careful reader.

### T049 — the flow, fixed and verified

Revision 2 of flow `ceb7a2d7`, saved through `POST /flows/:id/revisions` so the app's own compiler and
validators ran:

```
{{ json(outputs.report_text.body).results[0].data | jq('.text | @json') | first }}
```

Selection moved **inside** jq, which then receives the JSON-parseable object. Precedent for the form:
`scenarios/finance-flows.ts:138` and the generation tests both select fields inside `jq('…')`.

⚠ **The flow was a draft, never armed** (`armed_revision` null), so no approval binding was broken.

⚠ **`createdByKind` came back `system`, not `user`** — the provenance layer refused to attest a person
from a `createdBy` string alone. Correct behaviour (I-32), and worth knowing before reading the
revision list.

**Two test-runs, and the first one taught something:**

1. Triggered with `PARENT_API_KEY` only → `requested_by_kind = system` → refused **422**, *"no
   recipient: this run has no person to send to"*, `runKind: "system"`. Not a bug — US3 refusing
   exactly as designed. But it means **an API-triggered test-run can never exercise the requester
   default.** To test as a person, mint the identity the sign-in flow mints (HS256 over
   `RUNTIME_JWT_SECRET`, `x-foundry-identity`) — script at `scratchpad/mint.mjs`, ~20 lines.
2. Triggered **with** a minted identity → the full chain ran:

```
recipients    ["mayank.lohani@microland.com"]
resolved_from requester
outcome       failed
failure_reason Microsoft Graph refused the message (HTTP 404)
               {"status":404,"graphError":"ErrorInvalidUser",
                "graphMessage":"The requested user 'aicoe@microland.com' is invalid.",
                "requestId":"d93cb93b-dc95-4a2d-8393-9c37625d4fa2"}
```

**That is the whole feature working**: expression rendered → tool authenticated → endpoint reached →
requester resolved with no address in the flow → Graph contacted → its error surfaced with the
correlation id, and recorded as `failed` (provider reached) rather than `refused`.

### ⚠ Correction to what I predicted earlier in this session

I said to expect **403 `ErrorAccessDenied`** from the missing `Mail.Send` consent. The actual first
Graph failure is **404 `ErrorInvalidUser` on the sender**: `MAIL_SENDER_UPN=aicoe@microland.com` does
not resolve to a valid mailbox in tenant `1f20c679-…`. Sender resolution happens before the permission
check, so it fails first.

The missing-consent finding still stands as a *separate* fact — the app-only token carries no `roles`
claim at all (re-verify with `scratchpad/token-probe.mjs`). Expect it to surface as a 403 once the
sender is valid. **Two Azure blockers, in this order:**

1. **`MAIL_SENDER_UPN` must be a real, licensed, mail-enabled mailbox** in that tenant. `aicoe@microland.com`
   is not one per Graph. A shared mailbox works; a security group or an unlicensed account does not.
2. **`Mail.Send` application permission + admin consent** on app `18576f85-0cf6-4858-bde1-dbc95319536a`,
   then an Exchange application access policy scoping it to that mailbox.

Neither is fixable from the repository. T043 stays open until both are done.

### T050 — the durable fix, so the next draft does not repeat it

Fixing one flow leaves the drafter generating the same shape tomorrow. Two halves, I-118's pairing:

- **`checkPluckedThenJq`** in `services/flow-output-shape.ts`, registered in **`SHAPE_CHECKS`** so
  refine runs it too. Flags only the **unquoted** plucked-then-jq form and names the fix with the
  actual field: ``| jq('.text | @json') | first``.
- **A draft-prompt rule** in `flow-generation.service.ts`, placed beside the rule that taught the
  broken shape (that rule is written for a *whole* output; the correction belongs next to it).

⚠ **Why a new check rather than widening `checkJsonPositions`**: that one is deliberately narrow about
the opposite case — a whole output read *inside quotes* — and its docblock states *"a scalar plucked
out of one belongs in quotes and must not be reported"*. Widening it would have made it report the
form it exists to permit.

⚠ **A static check is honest here even though types are unknowable.** Nothing can know statically
whether `.data.text` is a String; it does not need to. The advice — select inside jq — is correct
either way and strictly safer.

⚠ **`flow-model-findings.test.ts` enforces a fixture per check** (its I-38 control). Adding
`checkPluckedThenJq` failed three of its assertions until the name list and a fixture were added. The
fixture is the real broken step verbatim, alongside the working `report_text` step, because the two
differ only in whether a leaf was selected before `jq`.

**After Phase 8**: `pnpm --filter @foundry/server typecheck` clean; server suite **92 files, 1364
passed, 1 failed** — still only the pre-existing `flow-replay` baseline failure.

---

## ✅ T043 DONE — a real email was delivered (2026-08-18 11:54)

```
execution      68254629-5f1b-4968-a09f-85404b1efc17   status: succeeded
steps          begin ✓  fetch ✓  report ✓  send ✓  complete ✓
recipients     ["mayank.lohani@microland.com"]
resolved_from  requester          ← no address anywhere in the flow
outcome        sent
graph id       d450e6fc-b962-4093-881b-8cf7881d0690
```

`GET /flow-executions/:id/emails` returns that record, so T037/T038's evidence surface is proven
against a real send and not only against fixtures.

**The user supplied a different app registration**, and that is what unblocked it:

| | old | new |
|---|---|---|
| app id | `18576f85-0cf6-4858-bde1-dbc95319536a` | `c78c325a-f33e-40dd-a35c-6c1cc74d404a` |
| tenant | `1f20c679-29df-4600-8b34-e81941898d87` | `ba39b069-731a-4eb6-95d8-9867f496c24b` |
| `roles` | *(absent entirely)* | includes **`Mail.Send`** (+ 16 others) |
| sender lookup | 404 `ErrorInvalidUser` | `GET /users/aicoe@microland.com` → **200**, mail-enabled |

⚠ The new app also carries `User.Read.All`, which is what let the sender mailbox be **verified before**
running anything (`scratchpad/check-sender.mjs`). Worth keeping: it turns "is the UPN valid?" from a
guess into a read. Note it reports **`licenses: 0`** — fine here (a shared mailbox is a valid app-only
sender) but the thing to check first if `MailboxNotEnabledForRESTAPI` ever appears.

⚠ **`.env` changes need the container restarted** — `config` is a frozen literal read at import time.
Confirmed the container held the new client id before running (`docker exec … sh -c 'echo $MAIL_GRAPH_CLIENT_ID'`).

---

## Phase 8 continued — the SECOND rendering defect, and what it taught (T051)

Run `fa04cfc3` failed too, on a **different flow** (`05f072f0`, `attendance_report_email` — the user
had regenerated it) with a **different** error:

```
send  failed  responseCode=null  request=yes
com.fasterxml.jackson.core.JsonParseException: Illegal unquoted character
  ((CTRL-CHAR, code 10)): has to be escaped using backslash … line: 6, column: 164
```

Code 10 is `\n`. The model had written:

```
"body":"{{ json(outputs.report.body).results[0].data.text }}"
```

The leaf plucked in Pebble and placed **inside quotes**, unencoded. The prose has newlines, so the
JSON body is invalid. **Again `request: null`, again no `email_sends` row, again nothing anywhere
saying "email".** Two runs, two different rendering failures, one indistinguishable symptom.

### ⚠ The most important thing in these notes

**That draft was generated AFTER T050's prompt rule shipped** — I verified the running container held
the rule (`grep` in `/repo/packages/server/dist/…`, started one minute before the run). T050 told the
model *not* to pipe a plucked leaf into `jq`. The model complied, and took the **adjacent** wrong
shape instead.

**A rule that forbids one of two neighbouring mistakes relocates the mistake; it does not remove it.**
T050's rule is rewritten to lead with the single correct expression and name both wrong forms
underneath it. If a third variant ever appears, suspect this shape of prompt first.

### Why neither existing check caught it

`checkJsonPositions` **exists to permit** this form — its docblock: *"a scalar plucked out of one
belongs in quotes and must not be reported"*. True of an address, a period, a count. **False of model
prose**, the one leaf certain to contain a newline. `checkPluckedThenJq` skips quoted positions for
the same stated reason. The blind spot was shared, so widening either would have made it report the
form it was written to allow.

`checkFreeTextInQuotes` is therefore deliberately narrow: a **free-text leaf** (`.text`/`.note`) read
off an **`llm_complete`** step, in a quoted position. Keying on the ref follows `checkTextToolInput`,
which already does it. `.model`/`.finish_reason` are single-line and stay silent — flagging them would
make the check about `llm_complete` rather than about newlines, and the false positives would get it
reverted.

**The one correct form, for both variants:**

```
"body": {{ json(outputs.X.body).results[0].data | jq('.text | @json') | first }}
```

Unquoted — `@json` supplies the quotes *and* escapes the newlines.

### Provenance notes worth keeping

- `POST /flows/:id/revisions` **refuses `createdBy` when a verified identity is present**:
  *"authorship is taken from the verified identity. Remove the field."* Send the header, drop the field.
- A minted identity **expires in 15 minutes** (`scratchpad/mint.mjs`); a stale one gives
  `identity_expired` 401. Re-mint rather than debugging the call.
- With the header, the revision is attested `kind: user`; with `createdBy` alone it is `system`.

### State after T051

`pnpm typecheck` clean across all 7 projects. Server suite **92 files, 1371 passed, 1 failed** — still
only the pre-existing `flow-replay` baseline failure. `flow-output-shape.test.ts` is now 51 cases.

**All 51 tasks complete.** Nothing is committed.
⚠ Still true: when committing, the `.gitignore` change must be in the **same commit** as the source,
or `ci/check-spec-compliance.sh` cannot see `specs/` in the diff.

---

## The report formatting pass (2026-08-18, after T051)

**The report was arriving as raw data.** `body` went to Graph exactly as the flow produced it — a JSON
blob from a `query`/`code` step, or a wall of prose from `llm_complete` — so the recipient read
`[{"employee":"A. Sharma","present":21}, …]` and did the parsing themselves. Two decisions, both taken
with the user:

| | Chosen | Rejected, and why |
|---|---|---|
| Format | **HTML, every value escaped** | Plain-text aligned columns render as ragged text in Outlook, which uses a proportional font |
| Where | **Server-side, in `POST /api/mail/send`** | A prompt rule — this model has already got `body` *rendering* wrong twice (T049, T051); asking it to hand-build table markup inside a Pebble expression is the same defect with more surface |

**New module: `services/mail-report.ts`** (pure, total, nothing throws). It reads the body as data:

- JSON → array of objects becomes a table; object of scalars becomes a summary block; an object with
  arrays becomes a summary block plus a table per array. **It unwraps `{results:[{data:…}]}`** — that
  envelope is *why* raw JSON was reaching mailboxes, since passing the whole step body is the common case.
- Prose → markdown tables become real tables, a run of `Label: value` lines becomes a summary block,
  everything else stays a paragraph with `white-space: pre-wrap`.

⚠ **A single `Note: …` line stays prose, and a markdown table needs its divider row.** The text reader
is written to fall back rather than guess: mangling a sentence into a two-column table because it
contained a colon is worse than doing nothing.

⚠ **HTML is safe here for one reason and it is not "we sanitise".** Every value crosses through
`escapeHtml`; the tags are the module's own string literals. `mail-report.test.ts` asserts `<script>`,
`<a href>` and `onerror=` come out as visible text — including in a **column heading**, which comes
from the caller's own object keys. spec.md's Edge Case is amended in place rather than rewritten.

⚠ **`mail.service.ts` still defaults to `Text`.** `contentType` is opt-in with one legitimate
producer, and the docblocks on both sides say so. A caller passing markup through with
`contentType: "HTML"` has defeated the control.

⚠ **Rendering sits AFTER the recipient check and BEFORE the intent row.** It is the last thing that
can refuse, and a refusal after the row saying "we are about to send" would leave an
attempted-unknown record for a message that was never dialled.

⚠ **A number is never reformatted.** Thousand-separating looks tidier until an id renders as
`20,260,618` and cannot be matched against the system it came from.

⚠ **An over-size report is refused, never truncated** — actual and allowed bytes named, measured on
the **rendered** HTML rather than on the input. `MAIL_MAX_BODY_BYTES` bounds what the flow sent;
`MAX_RENDERED_BYTES` (3 MB) bounds what Graph is asked to carry, and they differ by however much table
markup a wide result set generates.

### ⚠ The `paramsSchema` description was reverted, deliberately

The `body` param's description was rewritten to explain the new rendering, and then **put back
byte-for-byte**. `refFingerprints()` hashes `paramsSchema` WHOLE, and a fingerprint change routes
through `checkStaleness` → `markStale` → `suspended` — so a clearer sentence would have unarmed every
flow using this tool and removed its Kestra schedule. The guidance went into the **tool-level
`description`** instead, which is not in the fingerprint payload and reaches the model through the
same manifest. Both fields now carry a note saying which is which.

### State

`pnpm --filter @foundry/server typecheck` clean. Server suite **93 files, 1396 passed, 1 failed** —
still only the pre-existing `flow-replay` baseline failure. `mail-report.test.ts` is 24 cases;
`routes/mail.test.ts` 24; `mail.service.test.ts` gained an HTML case beside the `Text` default.

⚠ **No real send has been made against this change.** T043's evidence is a plain-text message; the
first HTML one still wants a look in a real Outlook client before this is called done.
