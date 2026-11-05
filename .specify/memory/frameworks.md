# Frameworks Record

<!--
  Established retroactively by /speckit-start against an EXISTING codebase.
  Every row below was read off the repository on the date given, not chosen —
  this record documents the stack, it did not select it. Amend via
  /speckit-update-standards.

  The authoritative machine-readable UI flag lives in
  .specify/memory/standards.json (`has_ui`). This document explains the human
  reasoning behind it and must be kept in sync.
-->

**Project**: Foundry — parent application over the Tether Foundry Harness
**Established**: 2026-08-25
**Last amended**: 2026-08-25

## Chosen Frameworks

| Layer | Framework / Tool | Version | Rationale |
|-------|------------------|---------|-----------|
| Runtime | Node.js | `>=22` (pinned `22.23.2`) | Enforced in both `engines` fields, `.nvmrc` and `.node-version`. **Below 22 `packages/client`'s `vitest.config.ts` throws** — jsdom 30 needs a Node 22 API, and without the throw 21 render-test files silently do not run. |
| Package manager | pnpm workspaces | `10.29.2` | Seven packages in one repo with `workspace:*` links. `postinstall` builds `@foundry/redact`, `@foundry/flow-edit`, `@foundry/shared` in order. |
| Frontend | Next.js (App Router) | `14.2.15` | `packages/client`, port 4002. Server components hold `PARENT_API_KEY`; the browser never does. |
| UI runtime | React / React DOM | `18.3.1` | — |
| Styling | Tailwind CSS | `3.4.6` | Config maps **only** to the CSS custom properties in `globals.css`; components never write a hex. See `design.md`. |
| Canvas | `@xyflow/react` + `@dagrejs/dagre` | `12.11.2` / `3.0.0` | The flow DAG. Layout is derived every render — a node never carries an `x`/`y`. |
| Fonts | `@fontsource/inter`, `@fontsource/jetbrains-mono` | `5.2.8` | Self-hosted; no external font fetch at runtime. |
| Auth (client) | NextAuth | `5.0.0-beta.31` | Microsoft Entra ID SSO + a local credentials account. |
| Backend | Express | `4.21.2` | `packages/server`, API :4000 / WS :4001. |
| Backend | `ws` | `8.18.0` | Flow-progress socket, ticket-authorised. |
| ORM / migrations | Drizzle ORM + drizzle-kit | `0.38.3` / `0.30.1` | 41 migrations. ⚠ A new migration's `when` must exceed every applied `created_at`. |
| Validation | Zod | `3.24.1` | Route schemas; `@foundry/shared`'s `validate()` factory flows mismatches through one `ZodError` branch. |
| Database | PostgreSQL | 5433 (`+1` offset, load-bearing) | Five databases on one instance: `foundry_parent`, `foundry_ops`, `kestra`, and the demo domains. |
| DB drivers | `pg`, `mysql2` | `8.13.1` / `3.23.1` | The only two datasource types `schemaIntrospectorService.supports()` covers. |
| Tokens | `jose` | `5.x` | `RUNTIME_JWT_SECRET` identity attestation, separate from `PARENT_API_KEY`. |
| Workflow engine | Kestra | `foundry/kestra:v1.3.29-scripts` | ⚠ Base MUST stay `-no-plugins` — the full image registers 1404 plugins and OOMs the engine. Publishes **no port**, and cannot. |
| Fragment runtime | `foundry/fragment-base:py3.12-pandas2.2.3` | pinned by digest | `code` steps run as sibling containers with `networkMode: none`. Bump the tag, never re-point it. |
| Language | TypeScript | `5.7.3` | Strict across all packages. |
| Tests | Vitest | `2.1.8` | `pnpm test` = `pnpm -r test`. ⚠ `npx vitest run` at the repo root is **not** a supported entry point — the root has no config and no devDependencies. |
| Test DOM | jsdom + Testing Library | `30.0.1` / `16.3.2` | Client render tests. |
| Orchestration | Docker Compose | — | `infra/docker-compose.yml`. Run from the repo root with `--env-file .env`. |

## UI Determination

**Has UI: yes**

**How it was decided**: inferred from the stack and confirmed against the
filesystem — `packages/client` is a Next.js 14 App Router application serving
18 pages under `app/(app)/`, with 17 primitives in `src/components/ui/` and a
tokenised Tailwind theme. There was no ambiguity to ask about.

- Because this is **yes**, the Design step runs, `design.md` is required, and
  the design existence gate is active.

## Framework-Specific Conventions

- **Repo layout**: `packages/{server,client,ops-api,mcp-bridge,shared,redact,flow-edit}`.
  Ports are one block — 4000 API · 4001 WS · 4002 web · 4003 mcp-bridge · 4004 ops-api.
- **Commands**: `pnpm dev` · `pnpm build` · `pnpm typecheck` · `pnpm test`.
  ⚠ Every `demo:*`, `finance:*`, `legal:*`, `kestra:*` and `scenarios:*` script
  lives in `packages/server` and is **not** aliased at the root — use
  `pnpm --filter @foundry/server <script>`. `kestra:check`, `ca:check`, `backup`,
  `backup:verify`, `restore` and `e2e` **are** root scripts.
- **Build vs typecheck are two tsconfigs in `packages/server`**:
  `tsconfig.build.json` excludes `*.test.ts` from `dist/` (test code shipped in
  the image until 2026-08-18); `tsconfig.json` still typechecks them.
- **Client tests need the `@/*` alias mirrored in `vitest.config.ts`** — without
  it a suite reports "0 tests", which reads like an empty file rather than a
  broken alias.
- **`packages/client` has no ESLint config** (`next lint` prompts for interactive
  setup). Known, open, and not any one feature's to fix.
- **Structural checks** run alongside the unit suites: `scripts/ui-honesty-check.sh`
  (196 assertions over client source), `pnpm kestra:check` (25 boundary assertions
  after any infra change), `pnpm ca:check` (corporate CA trust, per built image).
- **No new build-time network dependencies** without checking them against the
  corporate-CA constraint — see the CA section of `CLAUDE.md`.

## Notes

- Changing the UI determination later is done via `/speckit-update-standards`,
  which updates both this record and the `has_ui` flag + `design` requirement in
  `standards.json`.
- ⚠ **`../Foundry-Harness/` (Tether) is a separate repository and a separate
  compose stack.** It is reached over `host.docker.internal:6800` and is not part
  of this workspace's build. Two changes have been taken in it; its public API is
  in `../Foundry-Harness/API.md`.
