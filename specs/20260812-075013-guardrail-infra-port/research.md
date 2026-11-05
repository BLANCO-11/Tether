# Phase 0 Research: Guardrail Infrastructure Port (V1/V3/V6/V7 → v1-alpha)

This resolves every `NEEDS CLARIFICATION` the spec's Assumptions section deferred to
planning, grounded in a direct audit of the current `v1-alpha` codebase (not
assumed, not carried over from `krt/guardrail_validation`). Evidence citations are
file:line as read on 2026-08-12.

## Technical Context (resolved)

- **Language/Version**: TypeScript, `NodeNext` module resolution, ES2022 target
  (matches every existing package's `tsconfig.json`, e.g. `packages/redact/tsconfig.json`).
- **Primary Dependencies**: Express 4 (`packages/server`), Next.js (`packages/client`),
  `zod` (already the de facto validation library on ~20 of 23 route files), `jose`
  (already used by `identity.middleware.ts`), `drizzle-orm`/`drizzle-kit` (already
  the server's only DB access layer).
- **Storage**: Postgres (already running, port 5433) is the only shared datastore.
  No Redis (removed deliberately — `infra/docker-compose.yml`, `.env.example:26-27`,
  `config/index.ts` — re-adding one would contradict a documented prior decision).
- **Testing**: Vitest (`^2.1.8`) in both `packages/server` and `packages/client`,
  colocated `*.test.ts` files beside implementation — no `__tests__/` anywhere.
  `supertest`-style route tests are not confirmed present; new route-level tests
  will follow whatever pattern `*.test.ts` files in `routes/` already use (checked
  during `/speckit-tasks`).
- **Target Platform**: Linux server (Docker Compose), Node.js server process.
- **Project Type**: Web service (Express API) + web client (Next.js), pnpm
  monorepo, `packages/*` at repo root.
- **Performance Goals**: Not a throughput feature — goal is correctness of
  rejection paths (400/429/refusal), not new latency budgets. No new p95 target.
- **Constraints**: Must not add new runtime infrastructure (no new Redis, no new
  service) — single Express process, single Postgres instance, is the deployment
  reality per §8 of the audit.
- **Scale/Scope**: Single-tenant-per-workspace, single server instance today
  (`packages/server/src/index.ts` — one `app.listen`, no `deploy.replicas` in
  `infra/docker-compose.yml`). Sized for that reality, not a hypothetical
  multi-replica future (Constitution IV — YAGNI).

## Decision 1 — Rate-limit / concurrency state store: in-memory, not Postgres

**Decision**: Per-process in-memory counters (sliding window / token bucket for
rate limits, a plain in-flight counter for concurrency ceilings), scoped per
route class. No new Postgres table, no Redis.

**Rationale**: The server runs as exactly one process today (audited: no
`deploy.replicas`, no clustering, no `owner_instance`-style reconciliation
outside Tether's own unrelated orphan-run recovery). Building a
Postgres-backed distributed counter for a single-process deployment is
solving a problem that does not exist yet — Constitution Article IV
(Simplicity/YAGNI: "new dependencies, new abstractions... require explicit
justification"; "prefer deleting code over adding it"). A restart clearing
rate-limit counters is an acceptable, explicitly-documented tradeoff: the
counters exist to blunt abuse within a session, not to persist a ban across
restarts.

**Alternatives considered**:
- *Postgres-backed counters* — rejected: adds migration surface, write load on
  the one shared datastore for a purely operational concern, and a real
  behavior difference (surviving restarts) nothing in the spec asks for.
  Revisit only if `v1-alpha` actually moves to multiple replicas — at that
  point this decision's premise (single process) no longer holds and the
  module boundary (see Decision 4) makes swapping the store an internal change.
- *Redis* — rejected outright: reintroducing Redis contradicts a documented,
  deliberate prior removal (`infra/docker-compose.yml`'s own comment block).

## Decision 2 — Egress/SSRF policy: two profiles, not one denylist

**Decision**: The shared egress checker exposes a single classifier
(`classifyHost`, generalized from the existing `NEVER_A_DATABASE` logic in
`packages/server/src/services/datasource-target.service.ts:403-424`) plus a
caller-supplied **policy profile**:

- `strict` (loopback + link-local + RFC 1918 private ranges denied) — applied
  to the three genuinely new call sites this feature adds coverage to: poll
  trigger firing (`trigger-scheduler.ts:98`), tool endpoint invocation
  (`step-execution.service.ts:254,279`), and the ops-proxy LLM `baseUrl`
  write path (`routes/ops-proxy.ts` → `inference.service.ts:187`).
- `permissive` (link-local + unspecified/broadcast + multicast only — loopback
  AND RFC 1918 both allowed) — this is `datasource-target.service.ts`'s
  *existing, already-tested* `NEVER_A_DATABASE` policy, preserved byte-for-byte.
  Its own docblock (lines ~370-476) documents *why* private ranges — and, read
  precisely, loopback too — are allowed there: this deployment's demo Postgres
  databases live on private/internal/loopback Docker addresses
  (`host.docker.internal:5433`, `localhost:5433`), and refusing them would
  break `demo:seed`/`finance:seed` and the whole regression net.

**Rationale**: The spec's User Story 3 and FR-009 ask for an RFC-1918-inclusive
denylist "at minimum." Applying that literally to datasource registration
would regress a real, already-working, already-tested feature (violates
FR-013 and SC-007 — "no behavior change... for requests that were already
valid"). The two-profile design satisfies FR-009's letter (the `strict`
profile exists and is the default for anything without a documented reason to
be more permissive) while explicitly not touching
`datasource-target.service.ts`'s own tested behavior — consistent with FR-012's
spirit (don't rewrite an existing, working, already-audited check) even though
that file isn't literally on FR-012's excluded list.
**This is a scope decision, not an oversight**: `datasource-target.service.ts`
itself is not modified by this feature; only the shared classifier it could
*optionally* migrate to later is introduced.

**Alternatives considered**:
- *One strict-only policy applied everywhere, including datasources* —
  rejected: breaks `demo:seed`/`finance:seed`, a direct SC-007 violation.
- *Leave datasources on their own separate, unrelated implementation forever*
  — rejected as the long-term shape (worth a future note in the shared
  package's docs) but not blocking: this feature's job is to close the three
  genuinely open gaps, not to unify every existing check the moment a shared
  module exists.

**Re-check at dial time (FR-008)**: both `trigger-scheduler.ts`'s fetch and
`step-execution.service.ts`'s tool-endpoint fetch currently dial directly.
The shared package exposes a `guardedFetch(url, init, profile)` wrapper that
re-resolves and re-classifies the host immediately before calling the
underlying `fetch`, closing the DNS-rebinding gap User Story 3 names. Both
call sites are updated to call `guardedFetch` instead of the bare `fetch`;
this is the only change to those two files (registration path elsewhere
already calls the classifier once — it now also calls it again at dial time
via the wrapper).

## Decision 3 — V1 validation kernel: close measured gaps, do not retrofit compliant routes

**Decision**: The audit (§6) found ~20 of 23 route files already validate
`params`/`query`/`body` with `zod` inline, per-route. Only three concrete gaps
exist: `catalogue.ts` (workspace-id path param used with no format check),
`ops-proxy.ts`'s `/llm/provider|models|test` routes (manual property coercion,
no schema), and the complete absence of a non-leaking-error guarantee in
`error.middleware.ts`'s fallback branches (§5 — raw `err.message` reaches the
response body for any thrown error carrying no `statusCode`, or a
`statusCode >= 500`).

This feature:
- Adds a small shared validation-primitives module (UUID/path-param
  refinements, a `validate({params, query, body})` middleware factory) to the
  new shared package.
- Applies that middleware **only** to `catalogue.ts` and `ops-proxy.ts`'s three
  write routes — the two measured gaps.
- Fixes `error.middleware.ts`'s two leaking branches (the `statusCode >= 500`
  "upstream_error" path and the untyped fallback "internal_error" path) to
  return an opaque code + request id instead of `err.message`, logging the
  real message server-side against that request id.
- Does **not** touch any of the ~20 already-zod-validated route files. They
  already satisfy FR-001/FR-002's intent (reject before reaching a service or
  the database); wrapping them in a new middleware abstraction they don't need
  is exactly the "premature abstraction" Article IV warns against, and
  touching 20 working, tested files multiplies SC-007 regression risk for zero
  behavioral gain.

**Rationale**: Constitution Article IV; FR-013/SC-007's strong
no-regression bar; the audit's own evidence that the gap is narrow, not
repo-wide.

**Alternatives considered**:
- *Global `validate()` middleware retrofit across all routes* — this was the
  spec's literal FR-001 wording before this audit. Rejected after auditing the
  real codebase: the gap it would close (few files) does not justify the
  regression surface (all files). FR-001 is satisfied by the shared module
  existing and being available/adopted where gaps are real; it does not
  require replacing working code.

## Decision 4 — New shared package: `packages/shared`, mirroring `packages/redact`

**Decision**: New package `packages/shared` → `@foundry/shared`, workspace
dependency of both `packages/server` and `packages/client`. Layout, build, and
`package.json`/`tsconfig.json` shape copied exactly from `packages/redact`
(the only existing minimal leaf package): `"type": "module"`, `NodeNext`,
`declaration: true`, raw `tsc` build (no bundler), tests excluded from
`tsc`'s `include`, added to root `postinstall`'s build-order filter list
alongside `@foundry/redact`/`@foundry/flow-edit`.

**Exports** (four cohesive modules, one per ported slice, re-exported from
`src/index.ts`):
- `validation/` — primitives + `validate()` middleware factory (V1).
- `rate-limit/` — rate limiter + concurrency ceiling factories (V3), returning
  Express middleware; the in-memory store itself lives here (Decision 1).
- `egress/` — `classifyHost`, `guardedFetch`, the `strict`/`permissive`
  profiles (V6, Decision 2).
- `rules/` — the actual cross-client/server validation *rules* proper (V7):
  starts with `ENV_NAME_RE` (currently duplicated in
  `packages/client/src/lib/secret-edit.ts` and `tool-edit.ts`, each with a
  comment admitting the drift risk) and `AUTH_STYLES`, migrated into the
  shared package and re-exported from both call sites so the existing
  duplication is closed, not joined by a third copy.

**Rationale**: `packages/redact` is proven, minimal, and already wired into
the build order — reusing its shape exactly is the smallest-diff way to add a
new workspace package. Splitting into four submodules (rather than one flat
file) mirrors the four FRs and keeps each concern independently testable,
without introducing a package-per-slice (which the audit's `postinstall`
finding shows would be four more build-order entries for no benefit — one
package is enough).

**Alternatives considered**:
- *Four separate packages* (`@foundry/validation`, `@foundry/rate-limit`,
  `@foundry/egress`, `@foundry/rules`) — rejected: more `postinstall`
  build-order entries and more `workspace:*` dependency lines for no
  isolation benefit; none of the four is independently reusable outside this
  monorepo today.
- *Put the code directly in `packages/server/src/` with no new package* —
  rejected: FR-010 explicitly requires a package importable from **both**
  client and server, and `packages/client` cannot import from
  `packages/server`.

## Decision 5 — Rate limiting scope, corrected after a file-level pass: concurrency ceilings on generation and execution ALREADY EXIST

**This decision was revised during `/speckit-tasks`'s file-level audit** (the
plan's own "confirmed during tasks" placeholder — this is that confirmation,
and it overturned the assumption). Reading the actual service files, not just
the routes, found FR-006 (concurrency ceiling on flow generation and
execution, refuse-not-queue) is **already fully implemented, three times
over**, all pre-existing and already tested:

- **Chat-mode generation**: `flow-chat.service.ts:380-392` — one turn per
  thread (409, "still working on the previous message") plus
  `MAX_CONCURRENT_CHAT_TURNS` per workspace (429), backed by a Postgres
  `runningCount`/`runningTurn` query — not in-memory, contradicting nothing in
  Decision 1 (that decision is about *this feature's own new* state, not a
  claim that no other Postgres-backed counter exists anywhere in the repo).
- **Goal/outline-mode generation**: `flow-generation-job.service.ts:136,436-441`
  — `MAX_CONCURRENT_GENERATIONS = 3` per workspace, refused with 429 before
  starting, immediately, never queued.
- **Execution starts**: `routes/executions.ts:205-223` + `tenant-budget.service.ts`
  (the "M3" concept `CLAUDE.md`'s Kestra-migration section documents) — a
  per-workspace `maxConcurrentExecutions` ceiling, checked at `POST
  /api/executions/begin`, 429 on exceed. `tenant-budget.service.ts` also
  covers a **daily** agent-run ceiling ("M4") — a rate limit in substance,
  scoped to a resource this feature's FR-005 didn't anticipate existing
  already.

**Revised decision**: This feature adds **no new concurrency ceiling or
rate limit** for flow generation or execution starts. Building a second,
generic one via the shared package would either (a) sit in front of the
existing checks doing nothing (if sized loosely) or (b) create two
independent refusal paths for the same resource that can disagree (if sized
tightly) — a strictly worse outcome than the single, workspace-scoped,
already-tested mechanisms that exist today. FR-006 is satisfied by *existing*
code; this feature's job here is to recognize that in `tasks.md` (so a future
reader doesn't rediscover the same three call sites and build a fourth
ceiling) rather than to write new code.

**What FR-005/FR-007 still require** (genuinely open, unaffected by the above):
- **Authentication attempts**: this server has no `/login` route — callers
  present `x-api-key`/`Authorization: Bearer` or a `x-foundry-identity` JWT on
  every request, checked in `auth.middleware.ts`/`identity.middleware.ts`.
  Neither logs nor throttles a repeated **failure** today (`requireApiKey`
  returns a bare 401; `resolveIdentity` silently leaves `req.user` unset on a
  bad JWT — confirmed by reading both files in full). This is the one truly
  open FR-005/FR-007 gap: log every auth failure with enough context to
  investigate (caller IP, path, timestamp — never the presented credential
  value), and throttle an IP once its failure count crosses a threshold
  within a window, keyed by IP (no stable per-caller identity exists for a
  request that fails auth by definition).

**Rationale**: Constitution Article IV applies with more force here than
originally written — this isn't "prefer the simpler design," it's "don't
build a second implementation of something that already works, is tested,
and is documented." Discovering this before `tasks.md` was written (rather
than after implementation) is the entire reason planning reads the real
service files instead of only the route-mounting layer.

**Alternatives considered**: *Migrate the three existing ceilings onto the
new shared `rate-limit/` module for consistency* — rejected for this feature:
each has workspace-specific nuance (chat's per-thread 409 vs per-workspace
429; execution's M3/M4 split feeding a `/budget` management endpoint this
feature doesn't touch) that a generic middleware would have to special-case
back in, for a consistency benefit nobody asked for and at real regression
risk to three already-correct, already-tested code paths (FR-013/SC-007).
Worth a future, separately-scoped refactor if the shared module ever needs a
fourth consumer with the same shape — not this feature's job.

## Decision 6 — Request id (FR-003) is server-generated, never trusted from the caller

**Decision**: A new `request-id.middleware.ts`, mounted first (before the
existing permissive-CORS/identity middleware in `app.ts`), always generates a
fresh id server-side (`crypto.randomUUID()`) and ignores any inbound
`X-Request-Id` header from the caller. Sets `req.id` and the `X-Request-Id`
response header on every response, including error responses.

**Rationale**: Trusting a caller-supplied request id would let a caller
correlate/inject id values into server logs it doesn't control the rest of;
server-generated-only avoids that with no loss of diagnosability (the id is
still returned to the caller in the response, so they can quote it back for
support).

**Alternatives considered**: Echo an inbound id if present, generate
otherwise — rejected as unnecessary complexity for no stated requirement
(FR-003 only asks for a request id to exist and be threaded through, not for
client-supplied correlation across independent requests).

## Summary of what changes vs. what is added

| Slice | New code | Existing files touched (and why) |
|---|---|---|
| V1 | `packages/shared/src/validation/` | `routes/catalogue.ts`, `routes/ops-proxy.ts` (close 2 real gaps); `middleware/error.middleware.ts` (stop leaking `err.message` on 2 fallback branches); `app.ts` (mount request-id + the 2 new validated routes' middleware — no reordering of existing mounts) |
| V3 | `packages/shared/src/rate-limit/` (auth-failure throttle only — no generic rate limiter/concurrency-ceiling factory needed, Decision 5), `middleware/request-id.middleware.ts` | `app.ts` (mount request-id middleware); `middleware/auth.middleware.ts`/`identity.middleware.ts` (log+throttle on failure branch only — no change to the success path). **No changes to `flow-chat.service.ts`, `flow-generation-job.service.ts`, `tenant-budget.service.ts`, or `routes/executions.ts` — their existing concurrency ceilings already satisfy FR-006 (Decision 5).** |
| V6 | `packages/shared/src/egress/` | `services/trigger-scheduler.ts`, `services/step-execution.service.ts` (swap bare `fetch` for `guardedFetch` at the two named call sites); `routes/ops-proxy.ts` (validate `baseUrl` with the `strict` profile before persisting/forwarding) |
| V7 | `packages/shared/src/rules/` | `packages/client/src/lib/secret-edit.ts`, `tool-edit.ts` (import `ENV_NAME_RE`/`AUTH_STYLES` from `@foundry/shared` instead of each defining its own copy) |

Not touched anywhere: `auth.middleware.ts`'s success path,
`identity.middleware.ts`'s verification logic, `revision-provenance.middleware.ts`,
`run-requester.middleware.ts`, `step-token.middleware.ts`,
`flow-validator.service.ts`, `datasource-target.service.ts`'s existing
classifier/policy, and every route file already validating with inline `zod`
(per FR-012 and Decisions 2/3 above).
