# Implementation plan — pointer

⚠ **The real plan is [`plans/frontend-2026-08-12/plan.md`](../../plans/frontend-2026-08-12/plan.md).**
Read [`findings.md`](../../plans/frontend-2026-08-12/findings.md) first — it carries what was
measured and what is true today, with file:line references. Each phase has its own directory under
`plans/frontend-2026-08-12/phase-*/` with `checkpoint.md` (status + task list + exit criterion +
gates + resume note), `decisions.md`, `issues.md` and `evidence.md` — **the phase directory is where
work is recorded as it happens**.

This file exists only because `scripts/spec-gate-core.sh` requires a `plan.md` beside `spec.md` and
`tasks.md` before it will permit a source write — the same mechanism the foundations programme uses
(see `specs/20260810-093000-foundations/`). **Do not maintain this file in parallel with the real
one** — a second copy of a plan is how the two drift and a reader trusts the wrong one.

## Summary

Rethink the four automation pages (`/flows`, `/flows/new`, `/flows/[id]`, `/runs/[id]`) around
**three authoring modes** (chat, template, manual builder) with the **DAG editable everywhere**
(nodes, links, inputs, outputs). The backend is already most of the way there: chat is built, the
revision gate already binds to revisions never flows, templates already save/plan/instantiate, the
catalogue serves caps/expressions/outputs. The genuinely new backend work is **one table**
(`flow_step_positions`, decision ②, the plan's only migration) and **two client-routed decisions**
(chat's first-message goal/outline split, blueprint curation). The rest is client work over a
complete server.

## Technical Context

**Language/Version**: TypeScript, Node ≥ 22 (`.nvmrc`)

**Primary Dependencies**: pnpm monorepo. `@foundry/client` — Next.js 14.2.15, React 18.3.1,
`@xyflow/react` 12.11.2, `@dagrejs/dagre`, Tailwind 3.4.6, vitest + jsdom (jsdom performs no
layout; `@xyflow/react` is mocked in tests). `@foundry/server` — Express-style API, drizzle + SQLite.
`@foundry/flow-edit` — pure flow-edit ops (D-121).

**Storage**: SQLite via drizzle. The plan's only migration: `flow_step_positions` keyed `(flow,
step)`, **outside** the revision, workspace-scoped.

**Testing**: `pnpm typecheck` (0 in all packages) · `pnpm --filter @foundry/client test` ·
`pnpm --filter @foundry/server test` · `bash scripts/ui-honesty-check.sh` (0 FAIL — the `max-w-`
assertion lives here) · `pnpm kestra:check` (0 SKIP) · `e2e:ui` (at TWO periods) ·
`scenarios:verify` (13/13) · `finance:verify` · `demo:verify && demo:rehearse` · `backup:verify`
(after EVERY migration) · `showcase:seed` immediately before `showcase:verify` (I-33).

**Target Platform**: Browser (Next.js app at port 4002; server 4001). The containers run `dist/` —
a server change needs `docker compose build server web`.

**Project Type**: Full-stack web app (client + server packages in a pnpm workspace).

**Performance Goals**: No new latency targets; the chat turn cap (`CHAT_TURN_MAX_TOKENS = 1024`)
and generation budget (max 3 attempts) are untouched. Layout must not reflow from `foldWidth()`
breakpoint literals (pinned by `workbench.test.ts`).

**Constraints**: ⚠ `workbench.test.ts` pins the breakpoint literals (1544/1608/1190) to
`foldWidth()` — change geometry in both or the test fails. ⚠ Only `Page.tsx` may set a width
(`max-w-` honesty assertion). ⚠ No raw `height` prop on canvas (D-102, honesty-asserted). ⚠ No
goal-taking chat route (allowlist pinned by `flow-chat-imports.test.ts`). ⚠ Any `DRAFT_RULES` edit
owes `outline:measure` AND `draft:measure` re-taken in the same commit (phases here should not
touch it). ⚠ No `slate:clear` while a report is outstanding. ⚠ Nothing in this repo has been seen
rendered in a browser (I-80) — every phase owns a browser walk of its surfaces. ⚠
`chat:measure` (foundations 2.11) is owed before chat can be a default mode; every measurement
records the model it was taken on.

**Scale/Scope**: Four pages, ~10 source files at the heart of it (`Page.tsx`, `globals.css`,
`FlowCanvas.tsx`, `FlowBuilder.tsx`, `ChatPanel`, `flow/[id]/page.tsx`, `runs/[id]/page.tsx`,
`canvas-model.ts`, `canvas-layout.ts`, `workbench.ts`); dashboard/history/org-admin out of scope
(user decision 2026-08-12).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Article | Check |
| :--- | :--- |
| I. Spec-First | ✅ This feature exists (`spec.md`/`plan.md`/`tasks.md` complete); branch is a spec-kit timestamp branch |
| II. Test-First | ✅ Every phase gates on the repo's test set; positions-write boundary and `foldWidth()`/`max-w-` guards are pinned by existing tests, extended by the work |
| III. Code Review | ✅ `/speckit-comply` before declaring complete; human review per phase PR |
| IV. Simplicity | ✅ No new dependencies planned; one migration; no new safety machinery (revision gate reused, decision ④) |
| V. Observability | ✅ New failure paths log context per existing conventions; refusal findings flow to "Fix in chat" without auto-fix (D-55) |
| VI. Branch Discipline | ✅ Branch `20260812-102907-frontend-ui-rework` created by spec-kit git extension |
| VII. Doc Currency | ✅ The authoritative plan/evidence lives in `plans/frontend-2026-08-12/` and is updated in the same PR as the code |
| VIII. Secrets | ✅ No credentials introduced; refs/keys read from env (`.env` gitignored); blueprint curation adds no secrets |

Gates: no violations. All design research (Phase 0) already exists in `plans/frontend-2026-08-12/findings.md`
(recovered 2026-08-12 from the research session; gaps stated therein). Phase 1 design artifacts live
as the six phase checkpoints + `boards.md`. Re-checked post-design: nothing in the design adds
dependencies, migrations beyond the one table, or new auth surfaces → constitution check still
passes.

## Project Structure

### Documentation (this feature)

```text
specs/20260812-102907-frontend-ui-rework/
├── plan.md              # This file (gate-facing pointer — NOT the real plan)
├── spec.md              # /speckit-specify output (gate-facing contract)
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks output (gate-facing pointer)

plans/frontend-2026-08-12/   # THE authoritative plan (gitignored, this machine only)
├── plan.md                  # master index: state, decisions ①-④, order, gates
├── boards.md                # FE-<phase>.<n> board tickets
├── findings.md              # what is true today, file:line references
└── phase-1..6/<dir>         # checkpoint/decisions/issues/evidence per phase
```

### Source Code (repository root)

```text
packages/client/src/
├── app/(app)/
│   ├── flows/page.tsx           # Phase 1.4 — list density + template shelf spot
│   ├── flows/new/page.tsx       # Phases 1/2/3/4/6 — chooser, modes, panels
│   ├── flows/[id]/page.tsx      # Phases 1/5 — flow page, draft-revision editing, banner
│   └── runs/[id]/page.tsx       # Phase 1 — stays read-only (decision ④)
├── components/
│   ├── layout/Page.tsx          # Phase 1.2 — measures/zones (only width-setter)
│   ├── layout/Workbench.tsx     # Phase 1.2 — 3-pane grid + foldWidth() literals
│   └── flow/
│       ├── FlowCanvas.tsx       # Phases 1/2 — node anatomy, drag, connect, undo
│       ├── FlowBuilder.tsx      # Phase 2 — editable canvas call site
│       ├── ChatPanel.tsx        # Phase 3 — split surface
│       ├── FlowReview.tsx       # Phase 5 — becomes editable
│       └── StepInspector.tsx    # Phase 2 — on-canvas field editing
├── lib/
│   ├── canvas-model.ts          # Phase 2 — CanvasGraph (positions-aware)
│   ├── canvas-layout.ts         # Phase 2 — dagre fallback + re-arrange
│   └── workbench.ts             # Phase 1.2 — constants pinned by test
└── app/globals.css              # Phase 1.2 — tokens (--w-page/--w-form/--w-wide)

packages/server/src/
├── db/                          # Phase 2 — flow_step_positions migration (plan's only one)
├── routes/flow-positions.ts     # Phase 2 — workspace-scoped GET/PUT behind requireApiKey
└── (chat, templates, revisions unchanged — decisions ①③④ reuse them)
```

**Structure Decision**: The repo is an existing pnpm workspace (`packages/client`,
`packages/server`, `@foundry/flow-edit`, …). This feature adds no packages and moves no
directories — it edits surfaces in place and adds one server route module + one migration. The
structure above is the map of what each phase touches, not a new layout.

## Complexity Tracking

No violations to justify — no new packages, one migration, no new safety machinery; the phases
reuse the existing revision gate, chat backend, template machinery and catalogue.

## Notes

- The real plan's order: 1 shell → 2 editable DAG → (3 chat ‖ 4 templates) → 5 armed editing →
  6 journey + full verification. Phases 3 and 4 are independent and can run in parallel.
- Phase directories record work as it happens; the plan directory is `*.md` and always editable,
  the implementation is not (spec gate).
