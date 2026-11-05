# Implementation Plan: DB operation row detail (expand/collapse)

**Spec**: `spec.md` in this directory
**Branch**: `fix/ui-bugs` (no new branch)

## Summary

Turn each static row in `DbOperationsPanel.tsx`'s operations list into a
`<button>`-driven, per-row expandable section. Reuse the existing hand-rolled
accordion idiom already in the codebase (`AssetRow` in `AssetTree.tsx`:
per-row `useState`, header `<button aria-expanded>`, rotating chevron from
`@/components/ui/icons`) rather than introducing a new pattern or a library.

No server changes. No new API calls. Everything the detail view needs
(`spec`, `compiledSql`, `paramsSchema`) is already on the `FADatasourceOperation`
object `listOperations` returns.

## Technical Context

- **Language/Runtime**: TypeScript, React 19, Next.js (client component,
  already `"use client"`).
- **Existing patterns to reuse**:
  - Chevron rotate-on-open: `ChevronRight` from `@/components/ui/icons`,
    `transition-transform duration-fast ease-app` + `rotate-90` when open
    (`InspectorSection.tsx`, `AssetTree.tsx`).
  - `Params` component from `./OperationReview` — already renders a
    `paramsSchema` map as a labeled list; reuse verbatim for the filter/param
    section instead of hand-rolling a second renderer.
  - Existing color token for the "query" kind chip: `var(--k-datasource)`.
- **Storage**: none — purely client-side render state.
- **Testing**: extend `DbOperationsPanel.test.tsx` (existing file) with
  render tests for expand/collapse per FR-001/002/003/005/006.

## Constitution Check

- No new dependency, no new backend surface, no new persisted state. Pure UI
  affordance on data already fetched. Consistent with existing accordion
  idioms in the codebase (no new UI pattern introduced).
- `ui-honesty-check.sh`: no claim of data this component doesn't have — the
  detail is 1:1 derived from `op.spec` / `op.compiledSql` / `op.paramsSchema`,
  nothing invented or previewed (no row *data* is shown, consistent with the
  panel's existing "schema-only visibility" rule — this only reveals more of
  the operation's own *definition*, never a data preview).

## Project Structure

### Files touched

- `packages/client/src/components/data/DbOperationsPanel.tsx` — replace the
  static row `<div>` with an `OperationRow` component carrying its own
  `useState` open/closed, a button header, and a conditionally-rendered
  detail body.
- `packages/client/src/components/data/DbOperationsPanel.test.tsx` — add
  coverage for expand, collapse, and independent multi-row state.

No other files change. No new files needed (detail rendering is local to
`DbOperationsPanel.tsx`; it reuses `Params`/`CollapsedSql`-adjacent styling
inline rather than adding new shared components, since the target/columns/
joins/sort summary has no existing shared renderer to reuse — it's the same
scope-of-detail already used by nothing else).

## Complexity Tracking

None — this is an additive, local change to one existing component using an
established in-repo pattern.
