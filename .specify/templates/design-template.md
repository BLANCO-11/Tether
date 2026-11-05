# Design Standard

<!--
  Produced by /speckit-start (Design step) ONLY when the project has a UI, and
  amended via /speckit-update-standards. This is an enforceable standard: when
  the project has a UI its existence is gated, and its content (design tokens,
  responsive rules, component conventions) is checked for conformance by
  /speckit-comply.

  The approved TOKENS in section 2 are the contract the scaffolded component
  library implements. Keep them in sync with the component library.
-->

**Project**: [PROJECT NAME]
**Established**: [DATE]
**Last amended**: [DATE]
**Design mode used**: [full workshop | reference/vibe]
**Reference (if any)**: [e.g. "clean modern", or a named product]

## 1. Design Principles

- [3-6 short principles that guide every UI decision, e.g. "content first",
  "mobile-first", "accessible by default"]

## 2. Design Tokens (the contract)

### Color

| Token | Value | Usage |
|-------|-------|-------|
| `color.bg` | [#hex] | page background |
| `color.fg` | [#hex] | primary text |
| `color.primary` | [#hex] | primary actions |
| `color.muted` | [#hex] | secondary text/borders |
| `color.danger` | [#hex] | destructive/error |

### Typography

| Token | Value |
|-------|-------|
| `font.family.base` | [stack] |
| `font.size.base` | [e.g. 16px] |
| `font.scale` | [e.g. 1.25 modular scale] |
| `font.weight.*` | [regular/medium/bold] |

### Spacing / Radius / Elevation

| Token | Value |
|-------|-------|
| `space.*` | [scale, e.g. 4/8/12/16/24/32] |
| `radius.*` | [sm/md/lg] |
| `shadow.*` | [elevation levels] |

## 3. Responsive Rules (NON-NEGOTIABLE)

- **Breakpoints**: `mobile` < 768px, `tablet` 768–1024px, `desktop` > 1024px
  (adjust as needed and keep in sync with the component library).
- **Mobile-first**: base styles target mobile; enhancements layer up.
- **No horizontal overflow** at any width ≥ 320px.
- **No overlapping or clipped content** at the defined breakpoints.
- **Touch targets** ≥ 44×44px on mobile.
- Every layout MUST be verified in a browser at ~375px, ~768px, and ~1280px
  before it is considered done (this is what the mockups prove).

## 4. Layout & Grid

- [Grid system, max content width, gutters, container behavior]

## 5. Component Inventory

| Component | Purpose | States |
|-----------|---------|--------|
| Button | [primary/secondary/danger] | default/hover/active/disabled |
| Input | [text/select/etc.] | default/focus/error/disabled |
| [others…] | | |

## 6. Accessibility Baseline

- Color contrast meets WCAG AA (4.5:1 text / 3:1 large text & UI).
- All interactive elements keyboard-operable with visible focus.
- Semantic HTML / ARIA where needed; images have alt text.

## 7. Component Library Location

- **Framework**: [chosen framework]
- **Tokens module**: [path in the project]
- **Components**: [path in the project]
- New UI composes from this library rather than re-deriving styling.

## Conformance Notes

- UI changes are reviewed against this standard by `/speckit-comply` and the
  pull-time review. Amend via `/speckit-update-standards`, never by silent edit.
