# Evidence — Automation UI redesign

Browser-walk and gate evidence for `specs/20260812-205352-automation-ui-redesign`.

## Browser walks (2026-08-12)

Harness: `plans/frontend-2026-08-12/phase-3-chat/browser-walk/` (Playwright, HR workspace).
Walk script: `walk-redesign.mjs`.

| Surface | Result | Evidence |
|---|---|---|
| Manual builder (Langflow) | PASS | three-region `[data-variant="inspector"]` present; palette search box present; category headers **Data / Logic / Human & model** present; search filters to "Tool call" and hides "Named query". Screenshot `shots/redesign-builder.png`. |
| Template shelf (StackAI) | PASS | `[data-shelf="blueprint"]` present; shelf search box present; cards in a responsive grid. Screenshot `shots/redesign-template.png`. |
| Chat (Langdock) | PASS | split grid (`grid-template-columns`) present; first-message composer ("Draft this flow") present; user messages are bubbles, computed results are cards. Screenshot `shots/redesign-chat.png`. |
| Flow page / Run page | PASS (by construction) | both render through the shared `FlowCanvas`/`FlowReview`, so the node anatomy, status language and minimap/zoom are the same as the builder; the run page passes no edit/move handlers (read-only). |

## Gates

- `pnpm exec tsc --noEmit` (client) — **clean**.
- Client vitest — **615/615 passed** (47 files), including updated `FlowBuilder.test.tsx` (seven kinds) and unchanged `FlowLibrary.test.tsx`, `ChatPanel.test.tsx`, `ChatWorkbench.test.tsx`.
- `scripts/ui-honesty-check.sh` — **0 FAIL** (166 PASS).

## Design-language note

The redesign reuses the existing token system end-to-end (no new colours, FR-007): the palette
groups are presentation-only; search filters on existing label/body/description text; chat bubbles
reuse `--accent-bg`/`--accent`; the shelf grid reuses `--line`/`--surface`. The type scale, spacing
rhythm and motion vocabulary were already shared across surfaces via the de facto scale and the
`transition` utilities, so no new tokens were introduced (YAGNI — see research.md D-5's
alternatives-considered).
