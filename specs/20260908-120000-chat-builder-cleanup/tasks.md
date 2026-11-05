# Tasks: Chat Builder Cleanup

**Input**: Design documents from `/specs/20260908-120000-chat-builder-cleanup/`

**Prerequisites**: plan.md (required), spec.md (required)

## Phase 1: US1 — Remove chat-top input strip

- [ ] T001 [US1] Remove `ChatInputValues` mount from `ChatWorkbench.tsx` (lines ~1209-1217) plus strip-only plumbing (`inputSuggestions` state, `pendingRequiredInputs`, `unresolvedInputs`/`ChatInputValues` imports, `onTestValues` prop if unused elsewhere) in `packages/client/src/components/flow/ChatWorkbench.tsx`
- [ ] T002 [US1] Update `ChatWorkbench.test.tsx` strip test ("shows a generated suggestion beside an empty field") to assert the strip is gone and testing-pane path remains, in `packages/client/src/components/flow/ChatWorkbench.test.tsx`
- [ ] T003 [US1] Remove/ignore now-unused `onTestValues` wiring in builder page (`openTestWithValues` call site) only if lint fails; keep `TestWorkbenchPanel` inputs path intact in `packages/client/src/app/(app)/flows/[id]/builder/page.tsx`

## Phase 2: US2 — Collapsible suggestions

- [ ] T004 [US2] Add vertical collapse/expand control to suggestion row in `packages/client/src/components/flow/ChatPanel.tsx` (session `useState`, default expanded, `aria-expanded`, hides chip row when collapsed)
- [ ] T005 [US2] Cover collapse/expand in `packages/client/src/components/flow/ChatPanel.test.tsx` (expand by default, collapses on toggle, expands back, sends nothing)

## Phase 3: Verification

- [ ] T006 Run targeted vitest suites for `ChatWorkbench`, `ChatPanel`, and builder page; fix fallout

## Dependencies & Execution Order

- T001 before T002/T003 (strip removal first)
- T004 before T005
- T006 last
