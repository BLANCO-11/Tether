# Design Standard

<!--
  Established retroactively by /speckit-start against an EXISTING, shipped UI.

  ⚠ THIS DID NOT RUN A DESIGN WORKSHOP, AND THAT IS THE CORRECT OUTCOME.
  The workshop protocol exists to CHOOSE a design system before component code
  exists. Foundry's was chosen, argued and measured across two completed
  programmes (`ui-upgrade`, D-74…D-112, and the old-app reconciliation), and its
  mockups and revision record are already in `docs/design/`. Proposing new tokens
  here would have replaced a system with recorded contrast arithmetic and a
  passing 196-assertion structural check with something invented in one session.

  So the tokens below are TRANSCRIBED from `packages/client/src/app/globals.css`
  and `tailwind.config.ts`, which remain the implementation. This file is the
  contract those two satisfy; it is not a second definition. Amend via
  /speckit-update-standards.
-->

**Project**: Foundry — parent application over the Tether Foundry Harness
**Established**: 2026-08-25
**Last amended**: 2026-08-25
**Design mode used**: neither — **documented from the shipped implementation**
**Reference (if any)**: `Foundry-UX-Design.pdf`; the earthy light theme and the
layout grammar were settled in the `ui-upgrade` programme (D-74…D-112)

## 1. Design Principles

1. **No component writes a colour.** Every colour resolves through a CSS custom
   property. A hex or a `text-black` in a component is a bug, because a
   theme-dependent value cannot be a Tailwind literal.
2. **Honesty over polish.** A surface that cannot report failure renders a lie.
   Three states, always: the answer, nothing found, and *could not be checked* —
   and the third must never render as the second.
3. **Contrast is arithmetic, not judgement.** Every light foreground was computed
   against all three light grounds and the worst taken. Do not lighten one by eye.
4. **One definition per fact.** A number used by two surfaces has one token. The
   two theme application lists are asserted identical by `theme.test.ts` because
   CSS cannot share a block between a media query and an attribute selector.
5. **A canvas is never the only representation.** A picture-only view is a flow
   some people cannot read.
6. **Density suits an operator console**, not a marketing page — 13px body, 52px
   top bar, hairline borders.

## 2. Design Tokens (the contract)

**Two themes. Dark is the base**, because it is what the product shipped before a
second theme existed — someone who upgrades having expressed no preference sees no
change. Light is earthy: dry clay pulled toward olive, so it reads as stone rather
than as an unprinted page, keeping the blue accent because that is already what
the app means by "this is a link".

⚠ **Every light value is written exactly once**, in the `--l-*` block. The two
rules that *apply* light only ever say `--x: var(--l-x)`.

### Color — core

| Token | Dark | Light (`--l-*`) | Usage |
|-------|------|-----------------|-------|
| `--bg` | `#0b0d12` | `#e8e3d6` | page background |
| `--surface` | `#14161d` | `#f2eee4` | cards, rows |
| `--surface-2` | `#1b1e26` | `#ddd7c6` | stat tiles, hover, raised |
| `--line` | `#262a33` | `#cdc5b0` | hairline borders |
| `--line-2` | `#313641` | — | hover border |
| `--sunken` | `#10131a` | — | inset wells: YAML gutters, code, diffs |
| `--dots` / `--dash` | `#1e222b` / `#2b3040` | — | canvas dot grid · dashed drop targets |
| `--text` | `#e6e8ec` | `#241f17` | primary text |
| `--muted` | `#8a8f9a` | `#564e3f` | secondary text |
| `--dim` | `#868b96` | — | faint labels / eyebrows (AA on `--bg`) |
| `--accent` | `#4c8dff` | `#295bb1` | links, steps, primary actions |
| `--on-accent` | `#0b0d12` | `#f2eee4` | text **on** a solid accent fill |
| `--scrim` / `--mask` | `rgba(0,0,0,.6)` / `rgba(11,13,18,.72)` | — | modal dim · minimap out-of-view |

⚠ **`--surface-2`, not `--bg`, is the binding ground for contrast** — chips, tags,
hover rows and the strip all carry text on it. Headroom is 0.01–0.05 above 4.5:1.

⚠ **`--on-accent` FLIPS between themes and can never be `text-black`/`text-white`.**
Dark's accent is a light blue needing dark text; light's is a deep blue needing
pale text. It was written as `text-black` on two buttons — correct in dark and
unreadable in earth.

### Color — semantic, and they are not interchangeable

| Token | Dark | Light | Means |
|-------|------|-------|-------|
| `--ok` | `#34d399` | `#346940` | succeeded |
| `--warn` | `#fbbf24` | `#7e5607` | **this automation needs your attention** |
| `--orange` | `#fb923c` | — | **changes real data** |
| `--danger` | `#f87171` | `#9c3327` | failed / destructive |
| `--alpha` | `#c084fc` | — | **this part of Foundry is unfinished** |

⚠ **`--alpha` is deliberately NOT `--warn` (D-86).** One hue for both makes a
permanent product disclaimer and a live incident look identical — and since the
disclaimer is on every page, it is the *incident* that stops being read.

Each of `ok` / `warn` / `orange` / `danger` has a matching translucent pill
background (`--*-bg`) and, where used as a border, a `--*-line`.

### Color — step kinds

`--k-datasource` `#58a6ff` · `--k-transform` `#94a3b8` · `--k-code` `#a78bfa` ·
`--k-tool` `#2dd4bf` · `--k-approval` `#f472b6` · `--k-agent` `#f0b429` ·
`--k-unknown` `#6b7280`

⚠ These are tokens **because** they were previously reachable only through inline
`style`, which is how the two canvas renderers drifted apart. `--k-unknown` exists
so a step whose ref could not be read renders as *unknown*, never as safe.

### Typography

| Token | Value |
|-------|-------|
| `--font-sans` | `"Inter", system-ui, -apple-system, "Segoe UI", sans-serif` (self-hosted) |
| `--font-mono` | `"JetBrains Mono", ui-monospace, "SFMono-Regular", monospace` |
| Base body size | **13px** (`text-body`, line-height 1.5) |
| `--letter-spacing.label` | `0.08em` |

**The type scale is CLOSED — seven steps, and nothing else may set a size:**

| Class | Size |
|-------|------|
| `text-micro` | 10px / 1.4 |
| `text-caption` | 11px / 1.4 |
| `text-xs` | 12px |
| `text-body` | 13px / 1.5 |
| `text-sm` | 14px |
| `text-lg` | 18px |
| `text-xl` | 20px |

⚠ A surface reaching for `text-[…px]` outside this scale is the hierarchy
breaking. The three named steps replace hand-written `text-[10px]`,
`text-[11px]`, `text-[13px]` and the half-pixel `text-[11.5px]`/`text-[12.5px]`.

### Spacing / Radius / Elevation / Motion

| Token | Value |
|-------|-------|
| Spacing | Tailwind's default 4px scale, **unmodified** — deliberately not re-derived |
| `radius.md` / `radius.lg` | `8px` / `12px` |
| `shadow.raised` | `0 8px 28px -12px var(--shadow)` |
| `--topbar` | `52px` — the one number the top bar and anything sticking below it share |
| `--dur-fast` | `120ms` — hover / active feedback |
| `--dur-base` | `180ms` — layout movement (panels, tabs, folds) |
| `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` |

Every transition picks one of the two durations rather than a raw millisecond
literal.

## 3. Responsive Rules (NON-NEGOTIABLE)

- **Breakpoints** are Tailwind's defaults: `sm` 640px · `md` 768px · `lg` 1024px ·
  `xl` 1280px. In use across the client: `sm` and `lg` predominantly, `md` and `xl`
  sparingly.
- **No horizontal overflow** at any width ≥ 320px. Wide content — tables, the
  canvas, code blocks, YAML — scrolls inside its **own** `overflow-x: auto`
  container; the page body never scrolls sideways.
- **No overlapping or clipped content** at any defined breakpoint.
- **Touch targets ≥ 44×44px** on mobile.
- Every layout is verified in a browser at **~375px**, **~768px** and **~1280px**
  before it is done.
- ⚠ **jsdom performs no layout, so NO client test can assert any of this.** A
  render test over an empty edge set passes for ever (the repo's I-38 lesson).
  Responsiveness is a browser check, and this section is the standard it is checked
  against — not something the suite can be trusted to have covered.

## 4. Layout & Grid

- **Three measures, and a page picks one by ARCHETYPE** — this is the whole point
  of the tokens, so that `<Page measure>` is the only thing setting a width:

  | Token | Value | Archetype |
  |-------|-------|-----------|
  | `max-w-page` | `1160px` | index · detail · console |
  | `max-w-form` | `680px` | wizard · single-record form |
  | `max-w-wide` | `1440px` | workbench — a canvas is content, not a column |

  ⚠ A page reaching for `max-w-page` directly is the old per-file free-for-all
  with tokenised names.
- **Shell**: fixed sidebar navigation (grouped; **an empty group renders no
  heading** — a label for a capability you cannot reach reads as a broken page)
  plus a 52px top bar. `/dashboard` is the landing page for all five landing paths.
- **Canvas layout is DERIVED every render and must never become state.** A model
  has no coordinates; the moment a node carries an `x`/`y`, layout can drift from
  the graph. `nodesDraggable` stays false even in edit mode.
  - ⚠ **`stepNodes` must declare `measured` / `width` / `height` from `NODE_W` /
    `NODE_H`, and the card must take its size from the same constants.** React Flow
    compares nodes by identity, so a rebuild resets `measured` and every edge
    unmounts — the flicker that fired on every hover and every poll. `measured` is
    the half that does the work; `width`/`height` alone do not satisfy
    `parseHandles`. **A card that outgrows the declared size attaches edges to the
    wrong place with nothing flickering to say so.**

## 5. Component Inventory

`packages/client/src/components/ui/` — 17 primitives. New UI composes from these.

| Component | Purpose | States |
|-----------|---------|--------|
| `Button` | primary (gradient) / secondary / danger / ghost | default · hover · active · disabled · busy |
| `Field` | labelled form control wrapper | default · focus · error · disabled |
| `DynamicForm` | manifest/schema-driven form | validates `required` / `min` / `max` / `integer` |
| `Choice` | radio / segmented selection | default · selected · disabled |
| `DataTable` | index tables | loading · empty · error · rows |
| `RowMenu` | per-row actions | closed · open |
| `Badge` | status and kind pills | ok · warn · orange · danger · alpha · neutral |
| `Notice` | inline banner | info · warn · danger · alpha |
| `Strip` | compact horizontal summary | — |
| `Tile` | stat / metric card | — |
| `Modal` | overlay dialog (`--scrim`) | open · closed |
| `Confirm` | destructive confirmation | — |
| `EmptyState` | nothing-here surface | — |
| `Skeleton` | loading placeholder | — |
| `Avatar` | identity chip | — |
| `MicrosoftMark` | Entra sign-in mark | — |
| `icons.tsx` | the icon set | — |

⚠ **Three-state rendering is a component-level rule, not a page-level habit.** A
data surface renders the data, *or* nothing-matched, *or* **could-not-be-checked**.
`PromptBoundaryWarnings` is the reference implementation: an empty list draws
nothing (an absence of findings is not a safety claim) and an unreadable check says
the check did not run. ⚠ **Never catch-and-return-empty** — that is the deleted
`faFallback` shape, which returned fabricated rows on any server error behind a
`console.warn`.

⚠ **`StepStrip` is the canvas's text equivalent and must not be deleted as a
duplicate.**

## 6. Accessibility Baseline

- **WCAG AA contrast**: 4.5:1 body text, 3:1 large text and UI. Verified by
  computation against all three light grounds, worst case taken; the table is in
  `docs/programmes/ui-upgrade/evidence.md` §3. Re-run it rather than adjusting by eye.
- All interactive elements keyboard-operable with a visible focus ring.
- Semantic HTML; ARIA only where semantics do not reach.
- `color-scheme` is declared per theme so native controls — select popups,
  scrollbars, date pickers — match.
- The theme follows the OS preference by default and an explicit attribute when
  set, and **both directions must be honoured** so a toggle wins either way.
- Meaning is never carried by colour alone: every status pill carries a word.

## 7. Component Library Location

- **Framework**: Next.js 14 (App Router) + React 18 + Tailwind CSS 3.4
- **Tokens module**: `packages/client/src/app/globals.css` (the values) and
  `packages/client/tailwind.config.ts` (the class surface). **These two are the
  implementation; §2 above is the contract they satisfy.**
- **Primitives**: `packages/client/src/components/ui/` (17 components)
- **Domain components**: `packages/client/src/components/{flow,data,shell,workspace}/`
- **Copy modules**: `packages/client/src/lib/{policy-copy,prompt-boundary-copy,generation-findings}.ts`
  — user-facing strings live outside the components **so the RULES can be
  asserted** (e.g. no refusal string contains "error" / "failed" / "retry"; no
  all-clear string exists for the injection panel).
- **Mockups / approval artifacts**: `docs/design/mockups/` (gitignored scratch —
  `dashboard.html`, `components.html`, `styles.css`, `REVISION.md`).

## Conformance Notes

- UI changes are reviewed against this standard by `/speckit-comply` and the
  pull-time review. Amend via `/speckit-update-standards`, never by silent edit.
- **`scripts/ui-honesty-check.sh` is the mechanical half of this standard** — 196
  assertions, currently 196 PASS / 0 FAIL. Among what it enforces: no `faFallback`;
  every `useAsync` consumer reads `error`; every page under `(app)` has a render
  test; `llm_complete` is compared in exactly one file; no `createFlow` in the
  client; no canvas graph built inline in a `graph=` prop; no client-side read of
  `session.user.roles` for authorization. ⚠ **It greps, and greps pass** — it was
  satisfied for months by 21 render-test files that never executed a single
  assertion. Treat it as necessary and not sufficient.
- ⚠ **A copy string must never come from a model.** The chat builder's welcome
  bubble is a constant chosen by mode; assistant bubbles render only computed
  fields. The moment a greeting comes from a model, the ban on rendering `turn.text`
  is being satisfied by a different field name.
