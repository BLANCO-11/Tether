# Research: Next.js 14 → 16 upgrade

Sources: the official Next.js 16 upgrade guide (version 16.4.0, last updated 2026-10-02), the npm registry as of 2026-10-12,
and a scan of `packages/client`. Every "found in repo" line is something that was grepped, not assumed.

## What the registry says

| Package | Fact | Consequence |
| :--- | :--- | :--- |
| `next@latest` | **16.4.0**; engines `node >=20.9.0`; peer `react ^18.2.0 \|\| ^19.0.0` | Node 22 is fine; React 18 is accepted. |
| `next-auth@beta` | **5.0.0-beta.32**; peer `next ^14 \|\| ^15 \|\| ^16`, `react ^18.2 \|\| ^19` | beta.31 → beta.32 is the only auth bump needed. `latest` is 4.24.15 (the v4 line) and must **not** be used. |
| `@xyflow/react` | 12.12.0; peer `react ^17 \|\| ^18 \|\| ^19` (per its published range) | No required change for React 18 or 19. |
| `@testing-library/react` | peer `react ^18 \|\| ^19` | No required change. |

## Decision D-1 — two hops

- **Decision**: 14 → latest 15.x → 16.4.0.
- **Rationale**: the two majors change different things. 15 makes `params`/`searchParams` Promises (with a temporary sync
  shim and warnings) and enforces Suspense around `useSearchParams`. 16 removes the shim, renames `middleware`, removes
  `next lint` and makes Turbopack the default. A failure after one hop has one set of suspects.
- **Alternatives considered**: straight to 16 (one commit, but a failure could be any of ~8 changes); using the codemod
  unattended (it migrates `middleware`, `next lint` and `unstable_` prefixes, but does not run the async-request codemod
  and cannot know the proxy route's local `Ctx` type — reviewed by hand instead).

## Decision D-2 — the gate becomes `proxy.ts`

- **Found in repo**: `src/middleware.ts` is the only gate. It is `export default auth((req) => …)` with a `matcher`, and it
  uses `NextResponse.json/redirect/next`. Nothing sets `runtime = "edge"`.
- **Guide**: `middleware` is deprecated, renamed `proxy`; the `proxy` runtime is **Node.js** and not configurable; Edge is
  not supported in `proxy`, so projects that need Edge keep `middleware`. A codemod performs the rename.
- **Decision**: rename the file and the export; keep the matcher; keep exactly one gate.
- **Rationale**: nothing here needs Edge. Keeping the deprecated name works for now but would be a second migration later.
- **Open verification (must be settled in phase 2, not assumed)**: that next-auth beta.32's `auth(...)` wrapper can be the
  `proxy` export (default export of `auth(...)` is the form the guide recommends changing the function name for). If it
  cannot, the fallback is `export const proxy = auth(...)` or a thin `export function proxy(req, ev) { return auth(...)(req, ev) }`.
  The request matrix is how this is proven; reading the types is not enough.
- **Alternatives considered**: staying on `middleware` through 16 (works, deprecated, schedules a second migration);
  moving the gate into each page's server component (rejected: ~34 places to forget, and the proxy route must still be
  covered).

## Decision D-3 — React stays at 18.3.1 through phase 2

- **Guide**: the App Router in Next 16 uses the React Canary bundled with Next (React 19.2 features), and the guide says to
  install the latest React and types.
- **Registry**: `next@16.4.0` still declares `react ^18.2 || ^19`.
- **Risk found**: with `react@18.3.1` in `node_modules`, **tests run on 18 while the built app's App Router uses Next's
  bundled React**. Client code that imports `react` is resolved to the bundled copy at build time. That is a supported
  arrangement, but it means a green test run is not proof about the built app — hence the smoke script runs against the
  built app and the gate includes the matrix against a build.
- **Decision**: keep 18 for phases 1–2; phase 3 moves React, `@types/react*` and re-verifies the canvas. Take phase 3 early if
  phase 2's smoke shows a hook/ref mismatch.
- **Alternatives considered**: move React with Next in phase 1 (rejected: confounds which change broke what; the spec's
  FR-005 requires the library unchanged in phases 1–2).

## Decision D-4 — `next lint`

- **Guide**: `next lint` is removed; `next build` no longer lints; a codemod migrates to the ESLint CLI.
- **Found in repo**: `"lint": "next lint"` in `package.json`; **no ESLint config and no `eslint` dependency** in the client
  (documented open gap). Neither CI nor a hook runs it.
- **Decision**: delete the `lint` script. Adding ESLint is out of scope (Constitution IV — no new dependency without need).
- **Alternatives considered**: run the codemod (would add `eslint` + `eslint-config-next@16`, which requires ESLint 9, and
  a flat config — a new toolchain, new findings, nothing the upgrade needs).

## Decision D-5 — bundler

- **Guide**: Turbopack is the default for `dev` and `build`; **a custom `webpack` config makes the build fail**; filesystem
  caching is on by default; `dev` now writes to `.next/dev`, `build` to `.next`.
- **Found in repo**: `next.config.mjs` has only `reactStrictMode`, `env`, `redirects()` — **no `webpack` key**. Styling is
  Tailwind 3.4.6 through PostCSS; fonts are `@fontsource/*` packages imported as CSS; there is no `next/font`.
- **Decision**: run the production build with the default and with `--webpack`, compare the generated CSS (class presence),
  the font files in the output, and the version label; ship the default if both match.
- **Note**: the Dockerfile copies `.next` and `next.config.mjs`. `dev` now using `.next/dev` does not affect it; verify
  the image start anyway.

## Decision D-6 — async `params` / `searchParams`

- **Found in repo**:
  - `src/app/login/page.tsx` — a **server** component reading `searchParams?.callbackUrl` / `.expired` synchronously.
  - Seven `"use client"` pages read `params.id` synchronously: `flows/[id]`, `flows/[id]/builder`, `runs/[id]`,
    `resources/[id]` (`params` optional), `resources/[id]/impact`, `approvals/[id]`, `data-sources/[id]`.
  - The proxy route types `ctx: { params: { path: string[] } }` and reads `ctx.params.path` in six exported handlers.
  - No `cookies()`, `headers()`, `draftMode()`, no `generateMetadata`, no opengraph/icon/sitemap files, no server actions.
- **Guide**: sync access works with warnings in 15 and is **removed in 16**. Client components use React `use()`; server
  components `await`. `npx next typegen` generates `PageProps` / `RouteContext` helpers (since 15.5).
- **Decision (REVISED 2026-10-12, during implementation)**: the client pages read their id with **`useParams()`** from
  `next/navigation`, not `use(params)`; `await searchParams` in the login server component; `await ctx.params` in the proxy
  route. **Why revised:** `typeof require("react").use` is `undefined` on the pinned React 18.3.1, so `use(params)` cannot
  render under the test suite and would force the React 19 move (phase 3) into phase 1, breaking FR-005. `useParams()` is
  available on Next 14, 15 and 16, returns a plain object on all three, has no Promise to unwrap, and two pages already use
  it (`data-sources/[id]`; `resources/[id]` reads both). The six pages that still take a `params` prop (`flows/[id]`,
  `flows/[id]/builder`, `runs/[id]`, `resources/[id]`, `resources/[id]/impact`, `approvals/[id]`) drop the prop.
  Original text follows for the record: `use(params)` in the seven client pages; Use the codemod `next-async-request-api` for the mechanical part and review each
  result by hand.
- **Existing traps found**:
  - `flows/[id]/page.tsx` carries a comment saying `use(params)` threw React #438 on Next 14 and must not be used until
    `next` says 15. It becomes false in phase 1 and must be rewritten, not deleted.
  - `scripts/ui-honesty-check.sh` (≈ lines 529–555) has a rule that **fails** `use(params)` while the pinned major is < 15
    and `pass`es otherwise. It is already version-aware, so it flips by itself — but the test that makes it meaningful is
    `routes.smoke.test.tsx`, which currently hands pages the **plain object** (`props: { params: { id: "f-1" } }`). After
    phase 1 that would pass a plain object to a page calling `use(params)` and fail, so the smoke test's props must become
    Promises in the same commit.
  - `proxy.test.ts` calls the handler directly with a plain `ctx`; it must be extended (not replaced) so both shapes are
    exercised during the transition.

## Decision D-7 — Suspense for `useSearchParams`

- **Found in repo**: nine non-test files call `useSearchParams`: `ai-provider`, `runs/[id]`, `flows`, `flows/new`,
  `resources/new`, `resources`, `approvals`, `admin/audit`, `admin/members`. **No `Suspense` exists anywhere in
  `src/app`.**
- **Guide/Next 15 behaviour**: a statically prerendered page that calls `useSearchParams` without a Suspense boundary
  fails the production build.
- **Decision**: wrap each page's body in `<Suspense>` with the page's existing loading skeleton as fallback; do not use
  `force-dynamic`.
- **Alternatives considered**: `export const dynamic = "force-dynamic"` per page (turns nine pages dynamic for no
  benefit); a shared `withSuspense` helper (rejected under Constitution IV — nine three-line wraps).

## Decision D-8 — things that are in the guide but not in scope here

Checked against the repo and found **absent**, so no work: `next/image` and its five changed defaults; `next/font`;
`next/legacy/image`; `images.*` config; AMP; `serverRuntimeConfig` / `publicRuntimeConfig`; `devIndicators` options;
parallel routes (`default.js`); `experimental.ppr` / `dynamicIO` / `useCache`; `revalidateTag`; `unstable_*` imports;
`legacyBehavior` on `Link`; Sass. The only `export const runtime`/`dynamic` uses are `"nodejs"` and `"force-dynamic"` on
the two API routes and the login page, which remain valid.

## Other behaviour changes that could still bite (verify, no code expected)

- **Routing/prefetch overhaul in 16** — more, smaller prefetch requests. No code change; watch the proxy route for a
  visible rise in `GET` volume during the smoke script.
- **`scroll-behavior`** — Next 16 no longer overrides a global `scroll-behavior: smooth` during navigation. Check
  `globals.css` for one; none was seen in the scan, confirm.
- **`next build` output** — `size` / `First Load JS` columns are gone; any script parsing build output would break.
  None is known; the honesty check does not parse it.
- **`process.argv` inside `next.config.mjs`** — in `dev` the config is loaded once and no longer sees `dev` in `argv`.
  The config reads the root `package.json` unconditionally, so it is unaffected.
- **Browser support** raised to Chrome/Edge/Firefox 111+, Safari 16.4+. Confirm that is acceptable for the user base.

## Unknowns that remain, and who settles them

| Unknown | Settled by |
| :--- | :--- |
| Does `auth(...)` work as the `proxy` export in beta.32? | Phase 2, the request matrix against a build. |
| Do Turbopack and webpack produce the same CSS/font output here? | Phase 2, D-5 comparison. |
| Does React 18 + Next's bundled React cause a runtime difference? | Phase 2 smoke on the built app; phase 3 if so. |
| Is an identity-provider test tenant available? | The person running the smoke script; if not, stated as a gap. |
