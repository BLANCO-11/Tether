# Implementation Plan: Chat Builder Cleanup

**Branch**: `20260908-120000-chat-builder-cleanup` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/20260908-120000-chat-builder-cleanup/spec.md`

## Summary

Remove the `ChatInputValues` strip mount from `ChatWorkbench` (right-side `TestWorkbenchPanel` already owns test inputs), and make the `ChatPanel` suggestion row vertically collapsible/expandable via session-local state. Clean up strip-only plumbing; keep all shared test-run props.

## Technical Context

**Language/Version**: TypeScript 5.7 / Node 22 / Next 14.2.15 / React 18.3.1

**Primary Dependencies**: Tailwind 3.4.6, vitest 2.1.8, existing `TestWorkbenchPanel`, `suggestChatActions`

**Storage**: N/A (collapse state is `useState` only)

**Testing**: vitest (`ChatWorkbench.test.tsx`, `ChatPanel.test.tsx`, builder `page.test.tsx`)

**Target Platform**: Web (Foundry client)

**Project Type**: Web application (frontend-only change)

**Performance Goals**: No layout jump; collapse toggle is a local state flip, no re-fetch

**Constraints**: No new persistence; no visual regression outside the two rows; keep a11y labels

**Scale/Scope**: 2 components (`ChatWorkbench.tsx`, `ChatPanel.tsx`) + tests

## Constitution Check

- Simplicity: deleting a duplicate surface, not adding abstraction. Pass.
- Honesty: suggestions still send via ordinary turn path; collapse sends nothing. Pass.
- No new endpoints, storage, or auth surface. Pass.

## Project Structure

### Documentation (this feature)

```text
specs/20260908-120000-chat-builder-cleanup/
├── plan.md              # This file
├── spec.md              # Feature spec
└── tasks.md             # Task list
```

### Source Code (repository root)

```text
packages/client/src/components/flow/
├── ChatWorkbench.tsx        # remove ChatInputValues mount + dead plumbing
├── ChatWorkbench.test.tsx   # update strip assertion
├── ChatPanel.tsx            # collapsible suggestion row
└── ChatPanel.test.tsx       # collapse/expand coverage
```

**Structure Decision**: Frontend-only change in existing `packages/client/src/components/flow/`; no new files.

## Complexity Tracking

None — no constitution violations.
