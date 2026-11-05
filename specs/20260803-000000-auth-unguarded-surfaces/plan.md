# Implementation Plan: Authentication and authorization on the unguarded surfaces

**Branch**: `krt/guardrail_validation` | **Date**: 2026-08-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20260803-000000-auth-unguarded-surfaces/spec.md`

This is **V2** of the Validation & Guardrails programme. V1 (validation kernel)
is merged on this branch at `ef86fe1`.

## Summary

Close the three unauthenticated or under-authorized surfaces of the Foundry
stack, and make the `roles` claim mean something, using **one** new identity
primitive rather than three.

That primitive is a **workspace-scoped bearer credential, verified server-side
by salted digest**. It appears in two lifetimes: long-lived (a service
credential for the MCP bridge) and single-use with a 30-second TTL (a ticket the
browser presents when opening the progress WebSocket, since the browser
WebSocket API cannot send headers). One table, one verification routine, one
refusal shape.

The Next proxy gets an explicit in-route session check that does not depend on
the middleware matcher, plus a **role-aware** allowlist of upstream paths. That
allowlist is also where the `roles` claim is enforced — the only place in the
stack that has both a verified session and control over what reaches the parent
API, because §9 R2 is deferred (Q1) and so the parent API has no user identity.

Entitlement throughout is **workspace-level, never per-user**. Per-user
authorization is impossible until R2 is closed, and nothing here may be worded
as if it were.

## Technical Context

**Language/Version**: TypeScript 5.x on Node 22, ESM (`.js` import specifiers)

**Primary Dependencies**: Express 4.21/4.22, `ws`, Drizzle ORM + Postgres, Zod 3,
`next-auth` v5 (client), `@modelcontextprotocol/sdk` (bridge). **No new
dependency** — see [research.md](research.md) R6.

**Storage**: Postgres. One new table, `workspace_api_credentials`, workspace-
scoped and cascade-deleted. Drizzle-generated migration.

**Testing**: Vitest 2.1.9 with the `vitest.config.ts` V1 added. New suites for
the bridge (which has none today), the WebSocket, and the proxy route.

**Target Platform**: Linux containers via `infra/docker-compose.yml`; parent API
`:4000`, progress socket `:4001`, MCP bridge `:3015`, Next client `:4002`.

**Project Type**: pnpm workspace monorepo — `packages/server`, `packages/client`,
`packages/mcp-bridge`.

**Performance Goals**: verification is one indexed row fetch plus one `scrypt`
per authenticated request. The `keyId` prefix exists specifically so an
unauthenticated caller cannot force N hashes per request.

**Constraints**:
- FR-016 is the hard one: **no already-valid authenticated request may change
  behaviour.** The existing 194-test suite must pass untouched.
- The bridge is a separate package with its own `pg.Pool` and no dependency on
  `packages/server` (research R2).
- Browsers cannot set WebSocket request headers (research R3).
- No user identity at the server (Q1) — bounds what US4 can enforce and where.

**Scale/Scope**: 3 packages touched, 1 new table, 1 migration, ~4 new modules
and 4 new test suites. Two environment variables.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates derived from `.specify/memory/constitution.md` v1.2.0.

**Process gates (Articles I-VIII)**

- [x] **II. Test-First** — every behaviour change has a named test; the suites
      are enumerated in `quickstart.md` and become tasks before their
      implementation. FR-022 makes an automated test client the *acceptance
      condition* for keeping the WebSocket, since no UI exercises it.
- [x] **IV. Simplicity** — no new *runtime* dependency (research R6). One new
      table, not a credential subsystem. The single-primitive-two-lifetimes
      design exists specifically to avoid three parallel auth mechanisms.
      Explicitly **not** added "for later": no role hierarchy, no scopes beyond
      the two audiences actually used, no rotation endpoint.
      **One devDependency is added**: `packages/mcp-bridge` has no test runner at
      all today (no `vitest`, no `test` script). Article II requires tests for
      the bridge's new auth, so `vitest` is added to that package at the version
      already used by `server` and `client` (^2.1.x). Justified in Complexity
      Tracking; it is new to that manifest, not to the repository.
- [x] **V. Observability** — every refusal logs surface, reason, request id and
      `keyId` (never the secret). Auth-failure *rate limiting* is V3; auth-
      failure *logging* is here because a refusal nobody can see is not
      diagnosable (§8).
- [x] **VII. Documentation Currency** — `.env.example` placeholders, compose
      changes, and the `docs/` note ship in this feature. The `security.md`
      amendment for R3 is a `/speckit-update-standards` run **after** merge, as
      the roadmap §5 directs.
- [x] **VIII. Secrets Hygiene (NON-NEGOTIABLE)** — no credential in any tracked
      file. Bridge credentials are generated at issuance and stored as digests,
      so there is no new static secret at all. Two new non-secret variables get
      `.env.example` placeholders (research R7).

**Foundry gates (Articles IX-XV)**

- [x] **IX. Harness Boundary** — n/a to the mechanism, but respected: no change
      to `tether-client.service.ts`, no second HTTP path to Tether, no runtime
      code change. Note the gate's "no key validated by prefix": `keyId` is a
      **lookup** prefix, and the secret is verified by digest comparison. The
      prefix is never the credential check. Called out because a reviewer
      skimming for prefix-validation will see a prefix here.
- [x] **X. Generated Code Is Untrusted (NON-NEGOTIABLE)** — the script
      entitlement check is a server-side lookup of the script's owning
      workspace. No caller assertion, no self-reported signal. Nothing in this
      feature presents a signal as a gate.
- [x] **XI. Least-Privilege Data Access (NON-NEGOTIABLE)** — one credential per
      workspace (Q3), so a leaked credential exposes exactly one workspace. The
      bridge's Postgres pool is unchanged and still reads structural metadata
      only. FR-003's negative test is the deliberate over-grant test this
      article requires: a credential for workspace A is driven against
      workspace B and must fail.
- [x] **XII. Workspace Isolation** — `workspace_api_credentials.workspace_id` is
      `NOT NULL` with `ON DELETE CASCADE`; every query is workspace-scoped;
      SC-003 requires that a cross-workspace attempt cannot even reveal
      existence.
- [x] **XIII. Manifest Is the Contract** — n/a. No manifest, prompt-block or
      `-e` change; no new secret identifier reaches generated code.
- [x] **XIV. Synthetic Demo Data Only (NON-NEGOTIABLE)** — n/a to the mechanism.
      Respected: tests use generated fixtures, no real data. Relevant in one
      way — the role gate now protects `/demo/reset`, which strengthens rather
      than weakens the `DEMO_MODE` posture.
- [x] **XV. No Silent Side Effects** — this article is the feature's *motive*.
      An unenforced `roles` claim is exactly "a signal presented as a gate", and
      FR-014 removes it. Correspondingly, the plan states the role gate's honest
      limit: it constrains the browser through the proxy, **not** a holder of
      `PARENT_API_KEY` talking to `:4000` directly.

**Foundational standards**

- [x] **frameworks.md** — stays in the recorded stack: Drizzle-generated
      migration, Zod at the edge (reusing V1's primitives, not new ad-hoc
      schemas), existing layering (route → service → repository). No framework
      addition, so no amendment needed.
- [x] **security.md** — improves §9 R3 and does not worsen any other row. R2
      stays open **by explicit decision** (Q1) and is recorded as such, not
      quietly left. R10/R11 untouched and out of scope. New variables go into the
      §4 inventory by NAME only, at amendment time.
- [x] **design.md** — n/a for the server and bridge. The client change is a route
      handler with no UI surface; no component, token or breakpoint work.

**Gate result: PASS.** Nothing to justify in Complexity Tracking.

### Re-evaluation after Phase 1 design

Re-checked against the artifacts in this directory. Still PASS, with three
things the design surfaced that the pre-Phase-0 pass had not:

1. **Article IV pressure, resolved.** The bridge cannot import from
   `packages/server` (research R2). The tempting fix is a new `packages/shared`,
   which would touch every package's build — rejected as out of scope. The
   fallback (duplicate the verifier plus a shared conformance test proving the
   two agree) is recorded in research R2 and as an explicit task decision rather
   than left to whoever implements it.
2. **Article V vs. FR-003, tension resolved.** Indistinguishable refusals
   (SC-003) and diagnosable failures (Article V) pull opposite ways. Resolution:
   the *response* is uniform; the *log* carries the real reason. That is the
   only way to satisfy both, and it is now explicit in contracts.
3. **Article XV, sharpened.** The role gate's limit is stated in the Summary,
   in research R4, and must be repeated in the `security.md` amendment. A gate
   documented as broader than it is would reintroduce the defect under a new
   name.

## Project Structure

### Documentation (this feature)

```text
specs/20260803-000000-auth-unguarded-surfaces/
├── plan.md              # This file
├── spec.md              # Requirements + resolved decisions Q1-Q3
├── research.md          # Phase 0 — R1-R8
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1 — validation guide
├── checklists/
│   └── requirements.md
├── contracts/
│   ├── workspace-credential.contract.md
│   ├── mcp-bridge-auth.contract.md
│   ├── progress-socket-auth.contract.md
│   └── proxy-allowlist.contract.md
└── tasks.md             # Phase 2 — /speckit-tasks, NOT created here
```

### Source Code (repository root)

```text
foundry/packages/server/src/
├── auth/
│   ├── workspace-credential.ts        # NEW issue / verify / revoke; scrypt + timingSafeEqual
│   ├── workspace-credential.test.ts   # NEW incl. the deliberate over-grant test (Art. XI)
│   ├── progress-ticket.ts             # NEW mint / consume, 30s TTL, single use
│   └── progress-ticket.test.ts        # NEW
├── db/
│   └── schema.ts                      # EDIT + workspace_api_credentials
├── drizzle/
│   └── 0010_*.sql                     # NEW Drizzle-generated
├── routes/
│   ├── workspace-credentials.ts       # NEW issue/list/revoke, behind requireApiKey
│   └── scripts.ts                     # EDIT + POST /:scriptId/progress-ticket
├── validation/schemas/
│   └── workspace-credential.schema.ts # NEW reuses V1 primitives
├── ws/
│   ├── progress-server.ts             # EDIT noServer + upgrade auth + Origin + entitlement
│   └── progress-server.test.ts        # NEW the FR-022 test client
└── app.ts                             # EDIT mount the credentials router

foundry/packages/mcp-bridge/src/
├── index.ts                           # EDIT require auth; mount request-id + errorHandler
├── auth.ts                            # NEW verification entry point (see research R2)
├── auth.test.ts                       # NEW
└── schema-store.ts                    # unchanged

foundry/packages/client/src/
├── app/api/foundry/[...path]/route.ts  # EDIT in-route auth() + role-aware allowlist
├── lib/proxy-allowlist.ts              # NEW the allowlist, importable by its test
└── lib/proxy-allowlist.test.ts         # NEW FR-011 coverage test vs foundry-client.ts

foundry/
├── .env.example                        # EDIT WS_ALLOWED_ORIGINS, MCP_BRIDGE_REQUIRE_AUTH
└── infra/docker-compose.yml            # EDIT pass the new variables through
```

**Structure Decision**: follows the existing monorepo layout exactly. The one
new directory is `packages/server/src/auth/`, which is where the shared
credential logic lives so that both the HTTP routes and the WebSocket upgrade
handler use the same routine rather than each growing its own. `middleware/`
already holds request-scoped Express middleware and is the wrong home for a
verification routine the WebSocket also needs.

## Sequencing

Ordered so each slice is independently testable and green before the next, per
the working agreement for this programme.

| # | Slice | Delivers | Gate |
|---|---|---|---|
| 1 | Credential primitive + table + migration | R1's issue/verify/revoke, tested in isolation | over-grant test passes |
| 2 | MCP bridge auth | US1 — the largest exposure | bridge suite; unauthenticated call refused |
| 3 | Proxy in-route session check + allowlist | US3 | matcher-widening test fails without the check |
| 4 | Role-aware allowlist entries | US4 | `/demo/reset` refused without `admin` |
| 5 | Progress ticket + socket auth | US2 | FR-022 test client; all four refusal paths |

Slice 1 is a prerequisite for 2 and 5. Slice 4 depends on 3. Slice 5 is last
because it is the only one with no consumer, so it carries the least risk of
regression and the most need for its own test client.

## Complexity Tracking

> No Constitution Check violations. Nothing to justify.

One decision worth recording even though it is not a violation:

| Decision | Why | Alternative rejected because |
|---|---|---|
| Verifier possibly duplicated across `server` and `mcp-bridge`, with a shared conformance test | The bridge has no dependency on `server` and builds its own container from the repo root | A new `packages/shared` is the correct long-term fix but changes every package's build — its own feature, not a line item here |
| `vitest` added as a devDependency to `packages/mcp-bridge` | The package has **no test runner today**, and Article II requires tests for the auth this feature adds to it. Pinned to the version already used by `server` and `client` | Shipping the bridge's auth untested is not an option; running its tests from `packages/server` would mean the bridge's own `pnpm test` stays a no-op and the next change to it is again untested |

## Deferred, with reasons

Stated so the next slice inherits them explicitly rather than rediscovering
them:

- **§9 R2** — `backendToken` still unverified. Q1. Until it is closed there is
  no user identity at the parent API, so no per-user authorization or audit
  attribution is possible, and the role gate protects only the browser path.
- **§9 R10** — no rate limiting; `requireApiKey`'s `!==` comparison is still not
  timing-safe; auth failures are logged by this feature but not throttled. **V3.**
- **§9 R11** — `.env.example`'s missing client-auth and `DEMO_*` sets. Its own
  small feature, recommended before further variables accumulate.
- **`security.md` amendment** — R3's row changes once this merges; run
  `/speckit-update-standards` then, not now.
