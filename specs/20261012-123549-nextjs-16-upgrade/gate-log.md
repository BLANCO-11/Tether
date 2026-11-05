# Gate log

Each entry: phase · commit/working-tree note · each gate item · result. No commits are made during this implementation, so
the "commit" is the working tree on branch `20261012-123549-nextjs-16-upgrade` at the time stated.

Baseline numbers are in `baseline.md`. Pre-existing failures (typecheck 5 errors in `MockPanel.test.tsx`; 3 failing tests;
5 failing honesty checks) are expected to stay exactly as they are.

---

## Phase 0 — the net · 2026-10-12

New / changed tests (all green on the UNMODIFIED Next 14 code):

| File | Change | Tests |
| :--- | :--- | :--- |
| `src/lib/test-dual-params.ts` (+ `.test.ts`) | new helper: a value that reads as an object AND a Promise | 3 |
| `src/app/api/foundry/proxy.test.ts` | `ctx` now dual-shape; + every verb, every deny-list segment on every verb, `mail`, key never returned, query string | 14 (was 9) |
| `src/app/login/page.params.test.tsx` | new: `callbackUrl` / `expired` read correctly (the pre-existing `page.test.tsx` is untouched) | 7 |
| `src/app/record-pages.test.tsx` | new: each `[id]` page uses THE id it was given | 8 |
| `src/app/routes.smoke.test.tsx` | `params` handed dual-shape, `useParams()` mocked to the route's id | 39 (unchanged count) |
| `src/gate.test.ts` | new: G-1…G-13, the matcher, exactly one gate file | 13 |

**Perturbation proofs (SC-009 / T014)** — each code change made, the test run, then restored from a saved copy:

| # | Perturbation | Result |
| :--- | :--- | :--- |
| P1 | proxy route reads `ctx.params.paths` | `proxy.test.ts` **11 failed** |
| P2 | the `mail` deny-list entry removed | **2 failed** |
| P3 | login reads `expired === "2"` | **1 failed** |
| P3b | login ignores `callbackUrl` | **1 failed** |
| P4 | `flows/[id]` ignores its id | `record-pages.test.tsx` **2 failed** |
| P4b | `runs/[id]` ignores its id | **1 failed** |
| P5 | the gate returns `NextResponse.next()` always | `gate.test.ts` **6 failed** |

After restoring: the four files are 42/42 green and `git status` shows no source file modified.

**Incident, recorded rather than hidden**: my first `login/page.test.tsx` overwrote an existing test file of that name (local
sign-in visibility). Caught by `git status` showing it as modified; restored with `git checkout -- <file>` and my test moved
to `page.params.test.tsx`. Note for phase 1: the original renders `<LoginPage />` synchronously, which will not work once
the page is `async`.

**Design change found while writing these** (also recorded in `research.md` D-6): **React 18.3.1 has no `use()` hook**
(`typeof require("react").use === "undefined"`), so a page written `use(params)` cannot be rendered by this suite until React
is upgraded — it would force phase 3 into phase 1. Client pages will read their id with `useParams()` from `next/navigation`
instead, which exists on 14, 15 and 16 and returns a plain object. `data-sources/[id]` already does this; `resources/[id]`
already reads both.

Smoke script written: `smoke.md` (not yet run by a person on the baseline — requires a signed-in session).

---

## Phase 1 — Next 15.5.27, next-auth 5.0.0-beta.32, React 18.3.1 unchanged · 2026-10-12

Changed: `packages/client/package.json` + lockfile (the lockfile diff is large, +501 lines — `pnpm add` re-resolved; review before any
merge); proxy route (`ctx.params` Promise, one `handle` for all five verbs); login page (`async`, awaits `searchParams`);
six `[id]` pages now read the id with `useParams()` and take no `params` prop; Suspense around `useSearchParams` in 8 static pages
(`ai-provider`, `flows`, `flows/new`, `resources`, `resources/new`, `approvals`, `admin/audit`, `admin/members`); `runs/[id]` did
not need one (it is dynamic) and got none. Tests updated: 6 per-page test files moved off the `params` prop onto
`lib/test-route-params.ts`; the pre-existing `login/page.test.tsx` awaits the now-async page (and preloads
`react/jsx-dev-runtime` — see its comment: the file's JSX used to load it before NODE_ENV changed).
`scripts/ui-honesty-check.sh`: the ≥15 branch now asserts (it only printed a pass before) and a second rule bans `use(params)`
while React < 19; **both proven to fire** (a real `use(params)` → red; a plain-object prop → red; restored → green).

| Gate item | Result vs baseline |
| :--- | :--- |
| Typecheck | **5 errors, all `MockPanel.test.tsx`** — identical to baseline (+0) |
| Tests | **151 files / 2116 tests, 3 failed** (baseline 147 / 2080, 3 failed) — the 3 are exactly the baseline's |
| Honesty | **168 PASS / 5 FAIL** (baseline 167 / 5) — same five FAILs, +1 PASS from the new rule |
| Build | **exit 0** on Next 15.5.27. Same single warning (jose / Edge runtime, via the middleware bundle) |
| Matrix, built app (:4012, no session) | **identical** to baseline for G-1…G-7, G-13, `?expired=1`, `?callbackUrl=` and all 8 redirects (307/308 as before) |
| Smoke (`smoke.md`) / authenticated rows G-8…G-12, G-14 | **NOT RUN — needs a signed-in person.** I did not use the account credentials in `.env`. |
| Image build + start | not yet run (done in phase 2/US4) |

Facts worth keeping:
- Next 15 did **not** reject the missing Suspense boundaries at build in the first attempt — the build's only failure before the
  edits was the `params` type check on `approvals/[id]`. The Suspense wraps are kept (the guide requires them for static pages
  using `useSearchParams`), but were not what broke the build; they are unproven as a *need* on 15.5.27.
- A `pkill -f next-server` during cleanup was too broad (it can match the Docker `web` container's server process on the host).
  The container was unaffected (verified: Up, `/login` → 200). Stop the spare server by PID from now on.

---

## Phase 2 — Next 16.4.0 + the gate becomes `proxy.ts` · 2026-10-12

Changed: `next` → 16.4.0; `src/middleware.ts` → `src/proxy.ts` (`export const proxy = auth(...)`, matcher unchanged, plain `mv`);
`tsconfig.json` (`jsx: react-jsx` and `.next/dev/types` — Next 16 requires them; diff kept to those two lines); `lint` script removed;
`MockPanel.test.tsx` fixtures fixed; comments that named `middleware.ts` updated; `CLAUDE.md` and `azure-pipelines.yml` updated.

**Findings from Next 16 itself** (each would have been a surprise later):
1. `next build` **type-checks test files** (14/15 did not). The five `tsc` errors in `MockPanel.test.tsx` that had been tolerated since
   before the baseline became a **build failure** and had to be fixed (4 fixtures missing `error`/`fingerprint`; 1 untyped `vi.fn`).
2. It **rewrote `tsconfig.json`** on first build. Reverted the reformatting, kept the two semantic changes.
3. It prints **"React 18 support is deprecated … will be removed in Next.js 17"**.
4. The `jose` / Edge-runtime build warning **disappeared** (the gate is no longer an Edge bundle), as predicted.
5. `auth(...)` **does work as the `proxy` export** in next-auth beta.32 (research D-2's open question): the built app's matrix is
   identical to baseline.

| Gate item | Result vs baseline |
| :--- | :--- |
| Typecheck | **0 errors** (baseline 5 — the five were fixed, not hidden) |
| Tests | **151 files / 2116 tests, 3 failed** — exactly the baseline's 3 |
| Honesty | **168 PASS / 5 FAIL** — same five FAILs |
| Build (Turbopack, default) | **exit 0**; one warning: the React 18 deprecation |
| Build (`--webpack`) | **exit 0**; CSS 121,002 B vs 120,993 B; 30 font files both; version inlined both; same classes (15 selector differences are escaping of arbitrary-value classes) |
| Matrix, built app, no session | **identical** to baseline (G-1…G-7, G-13, `expired`, `callbackUrl`, 8 redirects incl. 308s) |
| Image | built (`docker build`, 2 min), started on a spare port: `/login` 200, `/dashboard` 307 → login, `/api/foundry/x` 401 JSON, `/create/templates` 308, `/home` 307. Test image and container removed; the real `foundry-parent-web` container was never touched |
| Version label / styling / fonts | present in the built output (checked in `.next`, not visually) |
| Smoke by a person; identity subject; authenticated rows | **NOT RUN** |

## Phase 3 (React 19) — **not taken**. See `tasks.md` STATUS.

## Final state

Final verification after the last edit: typecheck 0 · tests 151 files / 2116 (3 baseline failures) · honesty 168/5 · build exit 0.
36 tracked files modified, 8 untracked (this spec directory, `src/proxy.ts`, 6 new test/helper files). **Nothing committed.**
The lockfile moved by ~400 lines: Next's optional `sharp` image binaries and `@auth/core` 0.41.2 → 0.41.3 — review it before a merge.
