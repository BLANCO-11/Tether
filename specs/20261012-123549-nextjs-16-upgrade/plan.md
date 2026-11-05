# Implementation Plan: Upgrade the web client's framework to the current major release

**Branch**: `20261012-123549-nextjs-16-upgrade` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/20261012-123549-nextjs-16-upgrade/spec.md`

## Summary

Move `packages/client` from Next.js 14.2.35 to 16.4.0 in two hops (14 → 15 → 16), with React held at 18.3.1 and
`@xyflow/react` untouched until both hops pass; an optional third phase moves React to 19. The work is mostly **mechanical
re-declaration** (async `params`/`searchParams`, `middleware` → `proxy`, Suspense around `useSearchParams`, the dead
`next lint` script) but sits on two safety-critical surfaces: the API proxy route that holds `PARENT_API_KEY`, and the
server-side sign-in gate. Because the existing client tests stall the data layer and give pages the Next 14 plain-object
`params`, they would stay green while those surfaces broke. So **phase 0 builds the net first**: a recorded baseline, new
tests proven able to fail, and a manual smoke script. Research (see [research.md](research.md)) confirmed the Next 16
requirements against the official upgrade guide dated 2026-10-02 and found that this repo has **no custom webpack config,
no `next/image`, no `next/font`, no parallel routes, no AMP, no runtime config and no `cookies()`/`headers()` calls** —
which removes most of Next 16's listed breaking changes from scope.

## Technical Context

**Language/Version**: TypeScript 5.7 (Next 16 needs ≥ 5.1); Node 22 (Next 16 needs ≥ 20.9); React 18.3.1 through phase 2

**Primary Dependencies**: `next` 14.2.35 → 15.x → 16.4.0; `next-auth` 5.0.0-beta.31 → 5.0.0-beta.32 (peer `next ^14 || ^15 || ^16`);
`@xyflow/react` 12.11.2 (12.12.0 is current; peer React `^17 || ^18 || ^19` is not a blocker); `@dagrejs/dagre`, `jose`, Tailwind 3.4.6 and PostCSS 8.4.39 unchanged

**Storage**: N/A — the client holds no data; nothing in `packages/server`, the schema or any route changes (FR-020)

**Testing**: Vitest 2 + jsdom 30 + Testing Library 16 under Node 22 (51 files / ~750 tests baseline); `scripts/ui-honesty-check.sh`
(196 assertions, one of them Next-version-aware); `next build`; a manual smoke script; an image build + start

**Target Platform**: Linux container (`node:22-slim`), served by `next start -p 4002`; browsers per Next 16 (Chrome/Edge/Firefox 111+, Safari 16.4+)

**Project Type**: web application — only the `packages/client` frontend is touched

**Performance Goals**: none; the success measure is "nothing a person could do before has stopped working" (spec, Assumptions)

**Constraints**: the sign-in gate must stay a single control; `PARENT_API_KEY` must stay server-side; the proxy route must still
refuse unsigned requests itself and keep its deny-list; the stable identity subject must not change; every phase must be a
separate revertable commit

**Scale/Scope**: 1 `next.config.mjs`, 1 gate file, 1 proxy route, 1 server page (`login`), 7 `[id]` client pages,
9 pages using `useSearchParams`, 28 test files that mock `next/navigation`, 1 Dockerfile, 1 honesty-check rule, 1 CI step

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passes.*

| Article | Status | Note |
| :--- | :--- | :--- |
| I. Spec-first | **Pass** | This feature directory; `tasks.md` follows. No source file is edited before it exists (the repo's spec gate enforces this). |
| II. Test-first | **Pass, and it shapes the order** | Phase 0 writes every new check *before* any dependency moves and proves each can fail. Changed source files without a test: `next.config.mjs`, `Dockerfile`, `package.json` — justified, they are configuration verified by the build and the image start (tasks T045, T046, T049). |
| III. Review | **Pass** | `/speckit-comply` before review; the reviewer reads the diff against FR-001…FR-020. |
| IV. Simplicity | **Pass** | One new dependency version bump per package, **no new dependency**, no new abstraction. React 19 and a lint setup are deliberately **not** added (see Decisions D-3, D-4). |
| V. Observability | **Pass** | No new failure path is introduced; the proxy and gate keep their existing logged refusals. The phase gate is itself the record that a refusal is still refused. |
| VI. Branch discipline | **Pass** | Timestamp branch `20261012-123549-nextjs-16-upgrade`, one spec directory. |
| VII. Documentation currency | **Pass, with work** | CLAUDE.md, the `params` comments and the honesty check name Next 14 and `middleware.ts`; they are updated in the same PR (FR-018, tasks T043, T055). |
| VIII. Secrets hygiene | **Pass** | No credential is read, written or logged by this work; `.env` is untouched. |

## Decisions (each is argued in [research.md](research.md))

| # | Decision | Chosen | Why, in one line |
| :--- | :--- | :--- | :--- |
| D-1 | Hop order | 14 → latest 15.x → 16.4.0 | Next 15 changes request APIs and Suspense; Next 16 changes the gate file and the build tool. Separate causes, separate commits. |
| D-2 | The gate in Next 16 | Rename `src/middleware.ts` → `src/proxy.ts`, export `proxy` | The `middleware` name is deprecated; nothing here needs the Edge runtime, and `proxy` is Node-only. Verify the auth wrapper works there before relying on it. |
| D-3 | React | Stay 18.3.1 through phase 2; React 19 is phase 3, optional | Next 16.4.0 declares `react ^18.2 \|\| ^19`. Moving React changes tests, types and the canvas for no required benefit. Revisit only if phase 2's smoke shows a runtime mismatch. |
| D-4 | `next lint` | **Remove the `lint` script**; do not add ESLint | The client has no ESLint config today (documented open gap); the script already could not run non-interactively. A replacement is a separate decision. |
| D-5 | Bundler | Build with the default (Turbopack) **and** with `--webpack`; ship the default if both pass | There is no custom `webpack` config, so Next 16's "build fails when a webpack config exists" rule does not apply. Run both once to separate a Tailwind/font difference from a bundler difference. |
| D-6 | `params` in `"use client"` pages | **`useParams()` from `next/navigation`**, not `use(params)` | **Revised during implementation:** React 18.3.1 has no `use()` hook, so `use(params)` cannot render under the test suite (or on React 18 at all) until React 19 — which would pull phase 3 into phase 1. `useParams()` exists on Next 14, 15 and 16, returns a plain object, needs no React 19, and `data-sources/[id]` already uses it. |
| D-7 | `useSearchParams` | Wrap each of the nine pages in `<Suspense>` | Keeps the build static; the alternative (`force-dynamic`) would make nine pages dynamic for no reason. |
| D-8 | Image-related config | None | `next/image` is unused. |

## Project Structure

### Documentation (this feature)

```text
specs/20261012-123549-nextjs-16-upgrade/
├── spec.md
├── plan.md                 # this file
├── research.md             # Phase 0 — what the upgrade guide and the repo scan established
├── data-model.md           # Phase 1 — the four artefacts the work produces (baseline, gate, smoke script, gate decision table)
├── quickstart.md           # Phase 1 — how to run each gate
├── contracts/
│   ├── sign-in-gate.md     # the request matrix the gate must answer identically before and after
│   └── api-proxy.md        # the proxy route's behaviour that must not change
├── checklists/requirements.md
└── tasks.md                # produced by /speckit-tasks
```

### Source code touched (repository root)

```text
packages/client/
├── package.json                                   # next, next-auth versions; drop `lint`
├── next.config.mjs                                # review only; add nothing unless a gate fails
├── Dockerfile                                     # review; verify build outputs still copied
├── src/
│   ├── middleware.ts  →  proxy.ts                 # phase 2 (rename + export name)
│   ├── app/
│   │   ├── login/page.tsx                         # searchParams → Promise
│   │   ├── api/foundry/[...path]/route.ts         # ctx.params → Promise  (⚠ holds PARENT_API_KEY)
│   │   ├── api/foundry/proxy.test.ts              # + Promise-shaped ctx, + deny-list via awaited path
│   │   ├── routes.smoke.test.tsx                  # params handed as Promises (was plain objects)
│   │   └── (app)/
│   │       ├── flows/[id]/page.tsx                # read the id with useParams(); drop the `params` prop
│   │       ├── flows/[id]/builder/page.tsx        # read the id with useParams(); drop the `params` prop
│   │       ├── runs/[id]/page.tsx                 # read the id with useParams(); drop the `params` prop
│   │       ├── resources/[id]/page.tsx            # read the id with useParams(); drop the `params` prop
│   │       ├── resources/[id]/impact/page.tsx     # read the id with useParams(); drop the `params` prop
│   │       ├── approvals/[id]/page.tsx            # read the id with useParams(); drop the `params` prop
│   │       ├── data-sources/[id]/page.tsx         # read the id with useParams(); drop the `params` prop
│   │       └── ai-provider, flows, flows/new, resources, resources/new,
│   │           approvals, admin/audit, admin/members   # Suspense around useSearchParams
│   └── (new) gate tests, login-page test          # written in phase 0, before any change
scripts/ui-honesty-check.sh                        # the Next-major-aware rule: flip its direction
azure-pipelines.yml                                # add `next build` to the client gates (non-blocking, as today)
CLAUDE.md                                          # Next 14 / middleware.ts statements
```

**Structure Decision**: single existing frontend package; no new directories in source. The new tests live beside what
they cover, following the repo's existing idiom (`proxy.test.ts` already calls the route handler directly, which is
exactly the state a gate misconfiguration would create).

## Phases and gates

Every phase ends at the **same gate** and is one commit (or a small series) that can be reverted alone.

**Gate** = client typecheck clean · full client test run (count ≥ baseline, all pass) · `ui-honesty-check.sh` (≥ baseline PASS, 0 FAIL)
· `next build` exit 0 with no new warnings · the sign-in-gate request matrix ([contracts/sign-in-gate.md](contracts/sign-in-gate.md))
identical to baseline · the manual smoke script · image build and start.

| Phase | Content | Exit |
| :--- | :--- | :--- |
| **0 — Net** | Record the baseline. Write the new tests (gate matrix, login `searchParams`, proxy `ctx.params`, `[id]` pages given Promise params). Prove each fails against deliberately broken code. Write the smoke script. | Baseline saved; every new test green on Next 14 **and** shown red on its perturbation. |
| **1 — Next 15** | Bump `next` and `next-auth`. Async `params`/`searchParams`. Suspense on nine pages. Flip the honesty check's rule and the two comments. | Gate. |
| **2 — Next 16** | Bump `next` to 16.4.0. `middleware.ts` → `proxy.ts`. Remove `lint`. Build with both bundlers; choose. Re-check redirects, version label, fonts, Tailwind, image. | Gate, plus a built-app request against the matrix (not the dev server). |
| **3 — React 19 (optional)** | Move React, its types and, if needed, the canvas library. | Gate, plus the canvas checks in spec User Story 5. |
| **4 — Docs** | CLAUDE.md, comments, CI step. (Lands with phases 1–2 where a statement became false there; this is the sweep for the rest.) | `/speckit-comply` clean. |

## Risks (in the order the spec ranks them)

1. **Proxy route** — `ctx.params` becomes a Promise; a wrong read gives `path` of `undefined` on the one route that carries every browser call. *Mitigation*: phase 0 test calls the handler with both shapes; deny-list asserted through the awaited path.
2. **Sign-in gate** — a wrong form leaves pages open or locks everyone out, and nothing looks broken to a developer already signed in. *Mitigation*: request matrix run against the **built** app with no / valid / expired session; exactly one gate file exists.
3. **Suspense** — a build failure rather than a runtime one; loud. *Mitigation*: the nine pages are enumerated; the build is in the gate.
4. **React Flow canvas** — only if phase 3 is taken. The flicker fixes (I-59, I-66) depend on identity and declared sizes. *Mitigation*: separate phase; `FlowCanvas.test.tsx` plus a hover/click check.
5. **Turbopack output** — Tailwind classes, fonts, the version label. *Mitigation*: build both ways, compare, decide (D-5).
6. **React copy mismatch** *(new, from research)* — Next's App Router bundles its own React; with `react` pinned to 18.3.1 in `node_modules`, tests run on 18 while the built app may run on Next's copy. *Mitigation*: the smoke script runs against the **built** app, not only the test suite; if it shows a mismatch, take phase 3.
7. **CI does not run `next build`** *(new)* — the client gates are typecheck, test and honesty check, all `continueOnError`. A build break would reach `main`. *Mitigation*: add the build to the gate (task), non-blocking like its neighbours.

## Complexity Tracking

No constitution violations to justify.
