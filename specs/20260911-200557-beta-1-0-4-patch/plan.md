# beta-1.0.4 implementation plan — as actually built

## Technical context

- Stack: Next.js 14 + React 18 + Tailwind 3.4 (client), Express + Zod (server),
  `@foundry/flow-edit` (authored-model ops), Vitest + jsdom (client tests).
- No new dependencies, no new abstractions, no migrations. One small new
  module (`lib/flow-naming.ts`) per the one-definition-per-fact rule; one new
  component (`FlowRenameSection`) beside its test.

## What changed, file by file

| File | Change |
|---|---|
| `packages/client/src/app/globals.css` | `--l-*` values → ivory porcelain; `--l-grad` flat under its old name; `--l-glow` zeroed; `--l-frost` / `--l-frost-modal` added and wired in both branches; dark `--frost*` + blur radii added (inert); `.frost` / `.frost-modal` + reduced-transparency and no-backdrop-filter fallbacks |
| `packages/server/src/services/flow-chat-op.ts` | `add_arm.conditionExpr`: `""` → absent via `z.preprocess` |
| `packages/server/src/services/flow-chat.service.ts` | CHAT_RULES: whole-body-jq wiring recipe for `conditionExpr`, one arm per turn |
| `packages/server/src/services/flow-drafted-shape.ts` | `draftedBranchTestSchema` added; `test` carried on branch/approval steps |
| `packages/flow-edit/src/from-model.ts` | stored `""` treated as absent; unrendered typed test omits display key |
| `packages/flow-edit/src/ops.ts` | terminal-otherwise checks display string, typed `test`, and `conditions` rows |
| `packages/client/src/lib/flow-naming.ts` | NEW: `defaultFlowName()` |
| `packages/client/src/app/(app)/flows/new/page.tsx` | 4 fallbacks → helper |
| `packages/client/src/components/flow/ChatWorkbench.tsx` | 1 fallback → helper |
| `packages/client/src/components/flow/FlowRenameSection.tsx` | NEW: Settings rename via `renameFlow` |
| `packages/client/src/app/(app)/flows/[id]/page.tsx` | section mounted, `key={flow.name}` |
| `packages/client/src/components/shell/Sidebar.tsx` | `will-change-[width]` removed |
| `docs/VERSIONING.md` | publishing + untagged-chore rules (docs-only) |

## Verification (all run)

- `theme.test.ts` 21/21; honesty gate exit 0; client `tsc` clean; server `tsc`
  clean; touched suites 93/93 + 5/5 new; flow-edit 136/136; server chat-op 31/31.
- Full client suite: 9 failures in `runs/[id]/page.test.tsx`, reproduced on the
  pristine tree (8–9, flaky) — pre-existing, unrelated, not introduced here.
