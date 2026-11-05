# beta-1.0.4 grouped patch — backfilled from the working tree

[BACKFILLED - verify with author] Reverse-engineered from the uncommitted diff on
`release/beta` on 2026-09-11. Five user-visible changes, one removal, one scoped
follow-up. All items implemented and tested; this record exists so the release
line stays spec-covered (constitution article I).

## User stories

1. **Light theme reads as porcelain, not sand.** As a user on the light theme, I
   see ivory-porcelain surfaces (`#FDFCF9` cards on `#EDEBE4` ground), one blue
   accent (`#1D4ED8`), and no gradients or glows — so the app reads clean and
   bright. Frosted panes (sticky bars, modals, floating toolbar) are available
   as opt-in `.frost` / `.frost-modal` classes with contrast-derived opacity.
2. **Branched flows survive a chat turn.** As a builder, when the model writes an
   otherwise arm as `conditionExpr: ""`, or guards a branch with a typed `test`
   the renderer cannot display, the turn applies instead of failing on shape —
   so `add_arm` after an inspector-guarded `if` is no longer refused.
3. **New flows never share a name.** As a user creating a flow without typing a
   name, I get `Untitled flow XXXX` with a random suffix — so the list never
   shows five identical "Untitled flow" rows.
4. **Rename without fear.** As a flow owner, I edit the name in Settings and it
   saves through the metadata-only route — so approvals and schedules survive a
   rename, and a refusal is reported rather than swallowed.
5. **Sidebar collapses cleanly.** As a user toggling the rail, no compositor
   layer is held for a layout property (`will-change: width` removed) — the one
   objectively wrong frame cost in the collapse path.

## Functional requirements

- FR-1: every `--l-*` value resolves through the existing token names; no
  component changes; both light branches stay identical (theme.test.ts 21/21).
- FR-2: `""` conditionExpr coerces to absent (otherwise arm); stored `""`
  defers to the typed-test render; an unrenderable typed test omits the display
  key while `test` is carried; terminal-otherwise checks all three guard forms.
- FR-3: `defaultFlowName()` is the single definition; all five creation sites
  use it; 50 consecutive calls are unique.
- FR-4: Settings Name section saves via `renameFlow`, trims, disables Save
  unless dirty, reports errors in a live region, reloads the flow on success.
- FR-5: no visual or structural change to the rail.

## Out of scope (beta-1.0.5)

- `/new` Canvas mode vs `/builder` converge: both already compose the same
  atoms (`FlowCanvas`, `StepInspector`, `ChatWorkbench`); the delta is
  composition chrome (wizard footer vs lifecycle bar) plus the test panel,
  which `/new` lacks. Unifying state ownership (creation draft vs persisted
  flow) is a structural refactor and ships next, not here.
