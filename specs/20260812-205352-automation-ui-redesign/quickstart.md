# Quickstart — Validation guide

Validation for `specs/20260812-205352-automation-ui-redesign`. Proves the redesign renders and that
no behaviour regressed. Presentation-only: no new setup, no new data.

## Prerequisites

- Running stack (server + web), or the client dev/test toolchain (`pnpm` in `packages/client`).
- Local admin login (`LOCAL_ADMIN_EMAIL`/`LOCAL_ADMIN_PASSWORD` from `.env`).

## Static / unit validation

```bash
# client + server typecheck and tests (must stay green)
cd packages/client && pnpm exec tsc --noEmit && pnpm test
cd packages/server && pnpm exec tsc --noEmit && pnpm test

# UI honesty gate
bash scripts/ui-honesty-check.sh

# workbench-derived widths still hold (palette variant pinned)
cd packages/client && pnpm test workbench.test.ts
```

## Visual validation (browser walks)

Run the Playwright harness for each touched surface (see `plans/frontend-2026-08-12/phase-3-chat/browser-walk/`):

1. **Approach doors** — `/flows/new` shows exactly three doors (Chat / Template / Manual builder).
2. **Manual builder** — three regions (palette / canvas / inspector); palette search filters; a
   component added from the palette renders as a node with a category marker and kind in words;
   selecting a node opens its inspector; minimap/zoom present.
3. **Chat** — conversation and live workflow side by side; an applied turn updates the canvas
   without navigation; a dragged node keeps its position after a later turn; narrow window folds.
4. **Template** — shelf browsable/searchable/category-grouped; each card states its refs; empty
   workspace shows an honest empty state.
5. **Flow page** — same DAG anatomy; armed/draft banner still names both revisions.
6. **Run page** — same DAG anatomy, read-only (no edit affordance).

## Regression gate

```bash
bash scripts/scenarios-verify.sh        # 13/13
# e2e:ui at two periods (per gate set)
```

## Expected outcome

- All suites green; `ui-honesty-check.sh` reports 0 FAIL; `scenarios:verify` 13/13.
- Each of the six surfaces above has a filled browser-walk row in the feature evidence.
- No new colours introduced (diff on `globals.css`/`tailwind.config.ts` touches only structure and
  type/spacing/motion tokens).
