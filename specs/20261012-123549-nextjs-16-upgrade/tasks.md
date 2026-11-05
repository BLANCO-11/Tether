---

description: "Task list: upgrade the web client from Next.js 14.2.35 to 16.4.0"
---

# Tasks: Upgrade the web client's framework to the current major release

**Input**: Design documents in `/specs/20261012-123549-nextjs-16-upgrade/` — [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: **Required.** Spec FR-002 and SC-009 demand new checks that are each proven able to fail, written *before* any dependency moves.

**Organization**: by user story. The stories are also the *phases of the upgrade*, so they are NOT independent in the usual sense: US1 must be done first, US2 before US3, US4 after US3, US5 last and optional. Each ends at the same **GATE** and is a separate revertable commit.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no unfinished dependency)
- **[Story]**: US1…US5, from the spec
- Paths are relative to the repo root. `C/` means `packages/client/src/` and `F/` means `specs/20261012-123549-nextjs-16-upgrade/`.

## STATUS — 2026-10-12 (implementation pass; nothing committed)

**Done**: phases 1–6 and the Polish items that did not need a person. **Not done, and why:**

| Task | State |
| :--- | :--- |
| T008, T042 | **Not done** — need a signed-in session to read the identity subject; I did not use the account credentials in `.env`. |
| T041 | **Partly** — every unauthenticated row of the matrix (G-1…G-7, G-13) matched the baseline on the built Next 15 and Next 16 apps; G-8…G-12 and G-14 need a session. The same logic is asserted by `gate.test.ts`. |
| T015 | Smoke script **written**, not run by a person (needs a session). |
| T017, T038 | The codemods were **not run**; every change was made by hand (the codemod cannot know the proxy route's `Ctx`). |
| T020–T026, T036 | Done **differently**: `useParams()` instead of `use(params)` (React 18 has no `use()`); see `research.md` D-6. |
| T022 | `runs/[id]` is dynamic and needed **no** Suspense; the other eight pages got one. |
| T046 | Done; both bundlers equivalent (CSS 120,993 vs 121,002 bytes) — **shipped the default (Turbopack)**. |
| T049 | Done with a separate tag and spare port; the running `web` container was not touched. |
| T051–T054 | **Phase 7 (React 19) deliberately not taken.** Next 16 now prints *"React 18 support is deprecated … removed in Next.js 17"*. |
| T057, T058, T059 | **Not done**: the quickstart was not re-run from a clean clone; `/speckit-comply` was not run (instructed not to use speckit); no PR (instructed not to commit). |

## The GATE (referenced by every phase)

Typecheck clean · full client tests (file and test count ≥ baseline, all pass) · `bash scripts/ui-honesty-check.sh` (PASS ≥ baseline, 0 FAIL) · `pnpm --filter @foundry/client build` exit 0 with no new warning · the request matrix of [contracts/sign-in-gate.md](contracts/sign-in-gate.md) against the **built** app (`start`, not `dev`) · `F/smoke.md` by hand · image build + start. Append each result, with the commit hash, to `F/gate-log.md`. **A red item means `git revert` to the previous phase's commit, not patching forward** (FR-019).

Run everything on **Node 22** (`node -v`).

---

## Phase 1: Setup

- [x] T001 Confirm `node -v` is 22.x, the working tree is clean on branch `20261012-123549-nextjs-16-upgrade`, and run `pnpm install --frozen-lockfile` from the repo root.
- [x] T002 [P] Create empty `F/baseline.md`, `F/gate-log.md` and `F/smoke.md` with the headings from [data-model.md](data-model.md) so later tasks have somewhere to write.

---

## Phase 2: Foundational — the recorded baseline (blocks everything)

**⚠ Nothing in the repo may change until T003–T008 are saved.** Run on the untouched code.

- [x] T003 Delete `packages/client/.next`, run `pnpm --filter @foundry/client typecheck`, and record the exit code and error list in `F/baseline.md` (the 4 known stale `admin/downtime` / `admin/policies` type errors come from `.next/types`; expect 0 after the delete — if not, record what remains).
- [x] T004 Run `pnpm --filter @foundry/client test`; record file count, test count, pass/fail and run time in `F/baseline.md` (expected ≈ 51 files / ≈ 750 tests, exit 0).
- [x] T005 Run `bash scripts/ui-honesty-check.sh`; record the PASS / FAIL counts in `F/baseline.md` (expected 196 / 0).
- [x] T006 Run `pnpm --filter @foundry/client build`; record the exit code, every warning line verbatim and the route list in `F/baseline.md`.
- [x] T007 With the stack up and the **built** app running (`pnpm --filter @foundry/client start`), run every row G-1…G-14 of [contracts/sign-in-gate.md](contracts/sign-in-gate.md) with no session / a valid session / an expired one, and every legacy redirect from [quickstart.md](quickstart.md) §3; record status, content type and `Location` for each in `F/baseline.md`.
- [ ] T008 Sign in once as a known test account and record its identity subject (one `platform_users` row, read-only query) in `F/baseline.md` as the reference for FR-012 / SC-005.

**Checkpoint**: `F/baseline.md` is complete and committed. Do not start Phase 3 without it.

---

## Phase 3: User Story 1 — a baseline and a net that can actually fail (P1) 🎯 MVP

**Goal**: new checks that cover the behaviours the old suite cannot see, each shown to fail on broken code, plus a smoke script.

**Independent test**: all new tests green on the *unmodified* Next 14 code, and each one red under its perturbation (T014).

> The new tests use a **dual-shape** helper: an object that is both a plain object and a Promise, e.g. `Object.assign(Promise.resolve(v), v)`. It satisfies a Next 14 synchronous read *and* a Next 15/16 `await`/`use()`, so the same test is green before and after the upgrade and goes red only when the code misreads its input. Put it in `C/lib/test-dual-params.ts` (T009) and delete the plain-object half in T036.

- [x] T009 [US1] Create the dual-shape helper `C/lib/test-dual-params.ts` exporting `dualParams<T>(value: T): T & Promise<T>`, with a small test `C/lib/test-dual-params.test.ts` proving both `v.id` and `(await v).id` work.
- [x] T010 [P] [US1] Extend `C/app/api/foundry/proxy.test.ts`: call each exported verb of `C/app/api/foundry/[...path]/route.ts` with `ctx = { params: dualParams({ path: [...] }) }`; assert P-1 (unsigned → 401 JSON from the route itself), P-2 (one case per deny-list segment `test-oracle`, `steps`, `executions`, `mail` refused), P-3 (other paths forwarded with the key and `x-foundry-identity`, never `authorization`), P-4 (every verb reads the path), P-6 (the key never appears in a response). Keep the existing cases.
- [x] T011 [P] [US1] Create `C/app/login/page.test.tsx`: render the sign-in page with `searchParams` as `dualParams({ callbackUrl, expired })` for (a) a safe return address, (b) an off-site return address (must fall back), (c) `expired=1` (must show the expired state); handle both a sync and an async page by awaiting the call result. Behaviour per `safeNext` in `C/lib/session-expiry.ts`.
- [x] T012 [P] [US1] Update `C/app/routes.smoke.test.tsx`: give every dynamic route `params: dualParams({ id })` instead of the plain object (lines ≈ 149–204), keep `resources/[id]` also rendering with **no** params, and fix the header comment that says Next 14 passes plain objects.
- [x] T013 [P] [US1] Create `C/gate.test.ts` covering G-1…G-13 of [contracts/sign-in-gate.md](contracts/sign-in-gate.md) by importing the exported gate from `C/middleware.ts` with `@/auth` mocked so `auth(cb)` runs `cb` with a chosen session; assert redirect targets with the preserved `callbackUrl`, the `401` JSON for `/api/` paths, the `expired=1` exception, and that `safeNext` rejects an off-site address. Add a control: with the session mocked **valid**, an app page is *not* redirected.
- [x] T014 [US1] Prove each new check can fail (SC-009): for T010–T013 apply the matching perturbation from [quickstart.md](quickstart.md) §2 (read `ctx.params.path` as if undefined; drop one deny-list segment; read `searchParams` wrongly; read `.id` off a Promise; make the gate return `NextResponse.next()` always), confirm **red**, revert, confirm **green**; record each in `F/gate-log.md`.
- [x] T015 [P] [US1] Write `F/smoke.md`: ordered manual steps with an expected result each — local sign-in, sign-in with a return address, session-expiry banner, open a workflow, builder canvas hover and click, a run, an action through the proxy, approvals, members, audit, data sources, legacy links, version label, and a clearly-stated note on the identity-provider path if no test tenant exists. Run it once on the unmodified code and record that it passes.

**Checkpoint / GATE (baseline)**: all new tests green on Next 14; T014 done; smoke passes. Commit: `spec(nextjs-16): phase 0 — baseline and net`.

---

## Phase 4: User Story 2 — hop one: Next 15 (P1)

**Goal**: record pages, the sign-in page and the API proxy work on Next 15; the nine address-parameter pages build.

**Independent test**: GATE on Next 15 with React still 18.3.1.

- [x] T016 [US2] In `packages/client/package.json` set `next` to the latest 15.x (resolve with `npm view next@15 version`) and `next-auth` to `5.0.0-beta.32`; do **not** touch `react`, `react-dom` or `@xyflow/react` (FR-005); run `pnpm install` and commit the lockfile with the version bump alone.
- [x] T017 [US2] Run `npx @next/codemod@canary next-async-request-api packages/client` and **review every hunk** — do not accept it blindly: it cannot know the proxy route's local `Ctx` type. Keep only what T018–T026 describe.
- [x] T018 [P] [US2] `C/app/api/foundry/[...path]/route.ts`: change `Ctx` to `{ params: Promise<{ path: string[] }> }` and make each exported handler `async (req, ctx) => forward(req, (await ctx.params).path)` ([contracts/api-proxy.md](contracts/api-proxy.md)). Keep `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
- [x] T019 [P] [US2] `C/app/login/page.tsx`: make it `async` and read `searchParams` with `await`; keep `export const dynamic = "force-dynamic"` and the existing metadata.
- [x] T020 [P] [US2] `C/app/(app)/flows/[id]/page.tsx`: drop the `params` prop and read the id with `useParams<{ id: string }>()` from `next/navigation`; **rewrite** (do not delete) the comment at lines ≈ 25–27 to say why: `use(params)` threw React #438 on Next 14 and does not exist on React 18, and `useParams()` is the form that is valid on 14, 15 and 16.
- [x] T021 [P] [US2] `C/app/(app)/flows/[id]/builder/page.tsx`: drop the `params` prop, use `useParams()` (two call sites read `params.id`).
- [x] T022 [P] [US2] `C/app/(app)/runs/[id]/page.tsx`: `useParams()`, **and** wrap the `useSearchParams` consumer in `<Suspense>` with the page's existing loading state as the fallback.
- [x] T023 [P] [US2] `C/app/(app)/resources/[id]/page.tsx`: drop the optional `params` prop; it already calls `useParams()` and falls back to `""`.
- [x] T024 [P] [US2] `C/app/(app)/resources/[id]/impact/page.tsx`: use `useParams()`, keeping the `"leave-management-db"` fallback.
- [x] T025 [P] [US2] `C/app/(app)/approvals/[id]/page.tsx`: use `useParams()`, keeping the `PACK.id` fallback.
- [x] T026 [P] [US2] `C/app/(app)/data-sources/[id]/page.tsx`: **no change** — it already uses `useParams()`; confirm only.
- [x] T027 [P] [US2] Wrap the `useSearchParams` consumer in `<Suspense>` (existing skeleton as fallback) in `C/app/(app)/ai-provider/page.tsx`.
- [x] T028 [P] [US2] Same for `C/app/(app)/flows/page.tsx`.
- [x] T029 [P] [US2] Same for `C/app/(app)/flows/new/page.tsx`.
- [x] T030 [P] [US2] Same for `C/app/(app)/resources/page.tsx`.
- [x] T031 [P] [US2] Same for `C/app/(app)/resources/new/page.tsx`.
- [x] T032 [P] [US2] Same for `C/app/(app)/approvals/page.tsx`.
- [x] T033 [P] [US2] Same for `C/app/(app)/admin/audit/page.tsx`.
- [x] T034 [P] [US2] Same for `C/app/(app)/admin/members/page.tsx`.
- [x] T035 [US2] `scripts/ui-honesty-check.sh` (≈ lines 525–556): the rule is already version-aware and flips on its own, but its `>= 15` branch only prints a pass and asserts nothing. Add a real assertion there — fail if any `[id]` page under `C/app/(app)` still types `params` as a plain `{ id: string }` — and prove it fires by reverting one page. Keep the `< 15` branch intact until the version actually moves.
- [x] T036 [US2] Switch the helper to Promise-only where a Promise is the real shape: `dualParams` in `C/lib/test-dual-params.ts` → a real Promise for the proxy route and login page tests (the `[id]` pages no longer take `params`, so `record-pages.test.tsx` and `routes.smoke.test.tsx` stop passing the prop); delete the plain-object case (do not skip it) per [contracts/api-proxy.md](contracts/api-proxy.md). Also update the **pre-existing** `C/app/login/page.test.tsx`, which renders `<LoginPage />` synchronously and cannot render an `async` component — `await` the call first.
- [x] T037 [US2] Run the **GATE** on Next 15; record in `F/gate-log.md`. Commit: `feat(client): next 15 — async request APIs and Suspense`.

**Checkpoint**: every record page opens by direct link; the nine pages build; the matrix equals the baseline.

---

## Phase 5: User Story 3 — hop two: Next 16 and the sign-in gate (P1)

**Goal**: the gate re-declared in the form Next 16 requires, with identical behaviour and identity.

**Independent test**: GATE on Next 16.4.0, with the matrix run against the **built** app.

- [x] T038 [US3] Set `next` to `16.4.0` in `packages/client/package.json` (re-confirm with `npm view next dist-tags.latest`); keep React at 18.3.1; `pnpm install`; commit the bump alone. Run `npx @next/codemod@canary upgrade latest packages/client` only as a starting point and review every hunk (it also rewrites `next lint` and `tsconfig`; accept only what T039–T044 call for).
- [x] T039 [US3] `git mv packages/client/src/middleware.ts packages/client/src/proxy.ts`, rename the export to `proxy`, keep the `config.matcher` byte-for-byte, and point `C/gate.test.ts` at the new module. **Exactly one gate file may exist** ([contracts/sign-in-gate.md](contracts/sign-in-gate.md)).
- [x] T040 [US3] Prove that next-auth `5.0.0-beta.32`'s `auth(...)` works as the `proxy` export: build, start, run the matrix. If it does not, use the fallback from [research.md](research.md) D-2 (`export const proxy = auth(...)`, or a thin wrapper), and record the decision and evidence in `F/research.md` under "Unknowns that remain".
- [ ] T041 [US3] Run G-1…G-14 against the built app with no / valid / expired session and compare row by row to `F/baseline.md`; any difference is a failure, not a note.
- [ ] T042 [US3] Identity invariant: sign in as the T008 account again and confirm it is the **same** subject and still one `platform_users` row ([contracts/sign-in-gate.md](contracts/sign-in-gate.md), FR-012).
- [x] T043 [P] [US3] Update comments that name the old gate file where they mean the *client* gate: `C/app/page.tsx` (line ≈ 15), the docblock of `C/app/api/foundry/proxy.test.ts` (lines ≈ 9, 13, 49, 76), and any `middleware.ts` mention found by `grep -rn "middleware" packages/client/src`. Leave references to the **server's** `identity.middleware` and `auth.middleware` unchanged — they are different things.
- [x] T044 [US3] Run the **GATE** on Next 16.4.0; record in `F/gate-log.md`. Commit: `feat(client): next 16 — proxy gate`.

---

## Phase 6: User Story 4 — build, redirects and image parity (P2)

**Goal**: the build looks the same, old links redirect the same way, the version label shows, and the image builds and starts.

**Independent test**: the comparison steps below against `F/baseline.md`.

- [x] T045 [US4] `packages/client/package.json`: remove the `"lint": "next lint"` script (decision D-4); confirm `pnpm --filter @foundry/client` has no other script naming the removed command. Do **not** add ESLint.
- [x] T046 [US4] Build with the default bundler and with `--webpack` ([quickstart.md](quickstart.md) §4); compare: the generated CSS contains the app's Tailwind classes, both `@fontsource` families' files are in the output, and the version label shows the root `package.json` version on a page. Record the decision (D-5) in `F/research.md`.
- [x] T047 [P] [US4] Compare every legacy redirect (`/home`, `/workflows`, `/workflows/:path*`, `/runs`, `/create`, `/create/:path*`, the two template bookmarks) with `F/baseline.md`: same destination and same 307/308 status, with `/create/templates` and `/workflows/templates` still matching before the wildcards in `packages/client/next.config.mjs`.
- [x] T048 [P] [US4] Check the three behaviour changes that need no code unless found: `grep -n "scroll-behavior" packages/client/src/app/globals.css` (a global `smooth` now needs `data-scroll-behavior` on `<html>` in `C/app/layout.tsx`); confirm nothing parses `next build` output (the `size` / `First Load JS` columns are gone); confirm `next.config.mjs` does not depend on `process.argv` containing `dev`.
- [x] T049 [US4] Build the image from a clean checkout — `docker compose --env-file .env -f infra/docker-compose.yml build web` — start it, and confirm `GET /login` returns 200 on :4002; if the image lacks a file Next 16 now needs, fix `packages/client/Dockerfile` (it copies only `.next` and `next.config.mjs`).
- [x] T050 [US4] Run the **GATE**; record in `F/gate-log.md`. Commit: `chore(client): next 16 — drop lint script, parity checks`.

---

## Phase 7: User Story 5 — React 19 and the canvas (P3, OPTIONAL)

**Goal**: only if phase 2's smoke shows a React mismatch, or the team wants it. Skip the whole phase otherwise and say so in `F/gate-log.md`.

**Independent test**: the canvas acceptance scenarios of User Story 5, plus the GATE.

- [ ] T051 [US5] Bump `react`, `react-dom` to 19.x and `@types/react`, `@types/react-dom` to 19.x in `packages/client/package.json`; check `@xyflow/react` 12.12.0's peer range; `pnpm install`.
- [ ] T052 [US5] Fix the type errors React 19 produces (`useRef` initial values, the `JSX` namespace, `ref` as a prop, removed `defaultProps`), file by file, in the files `pnpm --filter @foundry/client typecheck` names.
- [ ] T053 [US5] Run `C/components/flow/FlowCanvas.test.tsx` and the 28 test files that `vi.mock("next/navigation")`; open the builder and a run page and check that edges stay drawn while hovering, node sizes still match the declared constants, and a click does not recompute layout (I-59, I-66).
- [ ] T054 [US5] Run the **GATE**; record in `F/gate-log.md`. Commit: `feat(client): react 19`.

---

## Phase 8: Polish and cross-cutting concerns

- [x] T055 [P] Update `CLAUDE.md`: every statement that says Next 14, `middleware.ts` as the client gate, or that `use(params)` must not be used, in the same PR (Constitution VII, FR-018). Keep history in place per the file's own convention (correct, don't delete).
- [x] T056 [P] `azure-pipelines.yml` (the "Client gates" step, ≈ lines 85–95): add `pnpm --filter @foundry/client build` after the tests, non-blocking like its neighbours — CI currently never builds the client, so a build break would reach `main`.
- [ ] T057 [P] Re-run [quickstart.md](quickstart.md) end to end from a clean clone to confirm it is accurate; correct it where it is not.
- [ ] T058 Run `/speckit-comply` and resolve every CRITICAL finding; confirm FR-001…FR-020 and SC-001…SC-009 each have evidence in `F/gate-log.md`.
- [ ] T059 Final `F/gate-log.md` entry: the three (or four) phase results side by side with the baseline; open the PR.

---

## Dependencies and order

- **Phase 1 → 2 → 3**, strictly: the baseline (Phase 2) is taken on untouched code, and the net (Phase 3) is written against it.
- **Phase 3 → 4 → 5 → 6**: each phase starts from the previous phase's committed, gated state (FR-004).
- **Phase 7** only after Phase 6; optional.
- **Phase 8** can start for T055/T056 alongside Phase 4+, but T058/T059 are last.
- Within a phase, `[P]` tasks touch different files and may run in parallel; T017 (codemod review) and T036 (helper switch) are sequential barriers.

### Parallel examples

```text
Phase 3:  T010 · T011 · T012 · T013 · T015        (five different files)  → then T014
Phase 4:  T018 · T019 · T020 … T026               (nine different files)
          T027 … T034                             (eight different files)
Phase 6:  T047 · T048
Phase 8:  T055 · T056 · T057
```

## Implementation strategy

- **MVP = Phases 1–3.** After them nothing in the product has changed, but the team has a recorded baseline and checks that can fail — which is the part that was missing and the part that makes the rest safe. Stop here if the upgrade is deferred.
- **Then one phase per commit**, running the GATE each time. Merge phases 4–6 together only if all three are green; if any phase fails, revert it alone.
- **Do not combine** the React move (Phase 7) with the framework hops; if a hop fails, you must be able to say which change did it.
- **Do not add anything not listed**: no ESLint, no `next/image`, no caching or PPR flags, no server changes (FR-020, Constitution IV).
