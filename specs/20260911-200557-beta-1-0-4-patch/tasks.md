# beta-1.0.4 tasks — backfilled from the working tree, all complete

## Backfilled 2026-09-11 from working tree on release/beta

- [X] Ivory porcelain `--l-*` values + frost tokens/classes in `globals.css`
  (covers `packages/client/src/app/globals.css`)
- [X] Wire `--frost` in both light branches; dark inert values; header comments
  (covers `packages/client/src/app/globals.css`, verified by `theme.test.ts`)
- [X] `add_arm` empty-string coercion + whole-body-jq prompt recipe
  (covers `flow-chat-op.ts`, `flow-chat.service.ts`, `flow-chat-op.test.ts`)
- [X] Typed branch `test` carried end to end, never stripped
  (covers `flow-drafted-shape.ts`, `from-model.ts`, `ops.ts` + their tests)
- [X] `defaultFlowName()` + all five creation sites
  (covers `lib/flow-naming.ts`, `flows/new/page.tsx`, `ChatWorkbench.tsx`)
- [X] Settings rename section with refusal reporting
  (covers `FlowRenameSection.tsx`, `flows/[id]/page.tsx`)
- [X] Sidebar `will-change-[width]` removal (covers `Sidebar.tsx`)
- [X] `docs/VERSIONING.md` publishing + chore rules (docs-only, no coverage needed)
- [X] Throwaway proof scripts deleted (`packages/server/*.ts` x5, uncommitted)
