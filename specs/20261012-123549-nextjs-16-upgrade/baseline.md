# Baseline — taken 2026-10-12 on Next 14.2.35, React 18.3.1, Node 22.23.2

Commit `57a2e9db` (branch `20261012-123549-nextjs-16-upgrade`, working tree clean except this spec directory).

⚠ **The baseline is NOT clean, and the CLAUDE.md figures (51 files / ~750 tests, honesty 196/0) are out of date.** What
follows is what was measured; later phases are compared to *these* numbers, and a pre-existing failure staying red is not
a regression.

## Preparation

`packages/{redact,shared,flow-edit}/dist` were stale: the first typecheck reported errors about `@foundry/flow-edit`
having no export `toLegacyInputSpelling` / `EFlow`. Rebuilt with `pnpm --filter @foundry/{redact,shared,flow-edit} build`
(what the root `postinstall` does). **Anyone repeating the gate must do this first.** `packages/client/.next` was deleted
before the typecheck.

## Typecheck — `pnpm --filter @foundry/client typecheck`

**Exit 2 — 5 errors, all in `src/components/data/MockPanel.test.tsx`** (lines ≈ 201–215: a `FADatasourceMock` fixture
missing `error` and `fingerprint`, and a `[]` tuple index). Pre-existing, in a test file, unrelated to Next.
Gate rule: the count must stay **5, same file**.

## Tests — `pnpm --filter @foundry/client test`

**Test Files 3 failed | 144 passed (147) · Tests 3 failed | 2077 passed (2080)** · 87 s. Failing, all pre-existing:

1. `src/lib/local-auth-wiring.test.ts` — "checks the ENV admin FIRST, so a broken API server cannot lock everybody out"
2. `src/lib/theme.test.ts` — "finds no var(--x) with no declaration behind it"
3. `src/lib/workspace-placeholder.test.ts` — "CONTROL: getMe is still the only consumer of the raw context value"

Gate rule: totals must be **≥ 147 files / ≥ 2080 tests**, with exactly these 3 failing and no others.

(1) is worth a look during phase 2 because it concerns the sign-in path, but it fails *before* any change.

## UI honesty check — `bash scripts/ui-honesty-check.sh`

**Exit 1 — 167 PASS, 5 FAIL.** Failing, pre-existing:

- browser storage is allowlisted (unexpected users)
- no colour literal outside globals.css
- no second step renderer (pages) — still referenced
- canvas size is a name, not a number — still referenced
- `/history updates itself` — missing statement on screen

Gate rule: PASS ≥ 167, and the FAIL set is exactly these five.

## Build — `pnpm --filter @foundry/client build`

**Exit 0.** One warning (kept verbatim in kind): `⚠ Compiled with warnings` — `jose@6.2.4/dist/webapi/lib/deflate.js`:
*"A Node.js API is used (CompressionStream) which is not supported in the Edge Runtime"*, import trace through
`@auth/core` into the Edge **middleware** bundle (`ƒ Middleware 85.4 kB`). Gate rule: no *new* warning. Note this warning
is about the Edge runtime that `middleware.ts` uses; `proxy.ts` is Node-only, so it is expected to **disappear** in phase 2.

Routes: 36 pages. `○` static: every page using `useSearchParams` (flows, resources, approvals, admin/audit, admin/members,
ai-provider, flows/new, resources/new). `ƒ` dynamic: `/login`, `/approvals/[id]`, `/data-sources/[id]`, `/flows/[id]`,
`/flows/[id]/builder`, `/resources/[id]`, `/resources/[id]/impact`, `/runs/[id]`, and the three API routes. (`/runs/[id]`
is dynamic, so it is not at risk of the Suspense build error; the eight `○` pages are.)

## Request matrix — against the running Next 14 `web` container on :4002 (no session)

| Request | Answer |
| :--- | :--- |
| G-1 `GET /dashboard` | 307 → `/login?callbackUrl=%2Fdashboard` |
| G-2 `GET /flows?view=live` | 307 → `/login?callbackUrl=%2Fflows%3Fview%3Dlive` |
| G-3 `GET /api/foundry/x` | 401 `application/json` |
| G-4 `GET /api/foundry-config` | 401 `application/json` |
| G-5 `GET /api/auth/session`, `/api/auth/providers` | 200 `application/json` (not gated) |
| G-6 `GET /favicon.ico` | 404 `text/html` (not gated — it reaches Next, which has none) |
| G-7 `GET /login` | 200 `text/html` |
| G-13 `GET /` | 307 → `/login?callbackUrl=%2F` |
| `GET /login?expired=1` | 200 |
| `GET /login?callbackUrl=https://evil.example/` | 200 (no session, nothing to bounce) |

**Not captured here** (need a signed-in session, which needs credentials this task does not hold): G-8…G-12, G-14, and the
identity subject (T008). They are covered by the unit-level gate test (T013) and by `smoke.md` run by a person.

## Legacy redirects (same container, no session — `redirects()` runs before the gate)

| Path | Answer |
| :--- | :--- |
| `/home` | 307 → `/dashboard` |
| `/workflows` | 307 → `/flows` |
| `/workflows/abc` | 307 → `/flows/abc` |
| `/runs` | 307 → `/history` |
| `/create` | 307 → `/flows/new` |
| `/create/abc` | 307 → `/flows/new/abc` |
| `/create/templates` | **308** → `/flows/new` |
| `/workflows/templates` | **308** → `/flows/new` |
