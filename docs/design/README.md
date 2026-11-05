# Foundry design system — how to build pages and components

**Status:** current, 2026-10-11. Derived from the Forge builder redesign (beta-2.23 → 2.26), which is the reference
implementation. When this file and older docs disagree, this file wins; when this file and the code disagree, fix one
of them in the same change.

Where things live:

| What | Where |
| :-- | :-- |
| Colour, depth and motion tokens | `packages/client/src/app/globals.css` (`:root`, light theme block, `.depth-*`) |
| Type scale, radius, shadow (Tailwind names) | `packages/client/tailwind.config.ts` |
| Page skeleton | `components/layout/Page.tsx` (`Page`, `Zone`), `PageHeader.tsx`, `usePageHeader` (`lib/page-header`) |
| Primitives | `components/ui/*` — `Button`, `Notice`, `EmptyState`, `Skeleton`, `DataTable`, `Modal`, `Drawer`, `Field`, `CopyableId`, `icons` |
| The builder (reference screens) | `components/pi-builder/*` — see `docs/canvas/README.md` |

---

## 1. Principles

1. **The data is the interface.** Show the thing itself (a step, a run, a value) before any sentence about it. A
   label names; it does not explain. Explanations live one click away (hover, pane, "Show details").
2. **One place for each fact.** Something is said once, where it is acted on. A status shown in the header is not
   repeated in the body; a step's properties live in its pane, not on the card, the chat and a toast.
3. **Plain words.** Write for the person running the business, not the engine: "Stopped at *send report* — the mail
   service refused it", never `run.failed`, `403 terminated` or an id alone. The raw text is kept, behind
   "Show details".
4. **Every state is designed.** Each surface that loads data has four states and draws all four: *loading*
   (skeleton in the content's footprint), *empty* (what will appear here and how), *error* (what failed + a way to
   try again), *data*. "Could not check" is never drawn as "none".
5. **Calm by default, loud on purpose.** Colour is for meaning (ok, warn, danger, accent = "you / selected / act"),
   never for decoration. One primary action per view.
6. **Nothing moves without a reason.** Motion explains a change of place or state (a pane sliding in, a path lighting
   up). It is short, eased, and off under `prefers-reduced-motion`.
7. **Never silently stop.** A dropped connection retries and says so; an ended session goes to sign-in; a long wait
   shows elapsed time. A screen that looks live must be live.

---

## 2. Visual hierarchy

Read order on every screen, top to bottom: **where am I → what is this → what can I do → the content → what else**.

| Level | Role | Treatment |
| :-- | :-- | :-- |
| L1 | Page title | `PageHeader`: `<h1 class="text-xl font-medium">`; a full-height workbench puts it in the top bar instead (`usePageHeader`, 14px `font-medium`) — one per page |
| L2 | Section heading | `text-body font-semibold` (13px), sentence case |
| L3 | Item title (card, row, pane title) | 13–14px, `font-medium`/`600`, max **2 lines**, then ellipsis |
| L4 | Body text | `text-body` 13px / 1.5 (chat 13.5px / 1.6) |
| L5 | Secondary / meta | `text-muted`, 11.5–12px |
| L6 | Eyebrow / port label / caption | `text-caption` 11px or `text-micro` 10px, `uppercase tracking-[0.07em] text-dim` — sparingly |
| Code / ids | `font-mono` 11–12px, `text-dim` unless it is the subject |

Rules:
- **One L1, one primary button** per view. Everything else is ghost/subtle.
- Weight before size, size before colour: make a thing more important by weight first.
- **Truncate, never wrap ids and port names**: one line + ellipsis + full value in `title`. Titles clamp to 2 lines.
- Numbers that change in place use `tabular-nums`.

---

## 3. Depth — the elevation ladder

Elevation is **tonal**: each level is a lighter surface (`--elev-1…4`), with blur and shadow added from level 4 up.
Use the level for the job, never a custom shadow.

| Level | Class / token | Used for |
| :-- | :-- | :-- |
| 0 ground | `--bg` | Page background, canvas, chat column |
| 1 | `.depth-1` / `--surface` | Rows, table body, quiet panels |
| 2 card | `.depth-2` / `--card-bg` + `--card-border` | Cards, canvas cards, tiles |
| 3 pane | `.depth-3` / `--surface` + border | Side panes, docked panels (`.pis-pane`) |
| 4 controls | `.depth-4` | Floating controls: zoom bar, legend, composer (`.pi-composer`) |
| 5 sticky head | `.depth-5` | Sticky headers over scrolling content |
| 6 overlay | `.depth-6` | Popovers, menus, dropdowns |
| 7 floating | `.depth-7` | Modals, command palette |
| inset | `--sunken` | Wells *inside* a surface: code, file contents, inputs-in-a-card |

Rules:
- A child is never on a lower level than its parent; an inset (`--sunken`) is the only way "down".
- Borders are hairlines (`--line`) that whisper; a raised thing is separated by tone first, border second.
- **Floating things float**: a pane or composer over content keeps a **12px margin** from every edge it does not
  belong to (`top/right/bottom: 12px` for a side pane) and a radius — it never runs into the screen edge.
- No band behind floating controls: content fades out beneath them (`linear-gradient(transparent, var(--bg) 46%)`).

---

## 4. Tokens and formulas

### Colour
Use the CSS variables (or their Tailwind names), never a hex in a component:

| Meaning | Token |
| :-- | :-- |
| Text: primary / secondary / faint | `--text` / `--muted` / `--dim` |
| Act, selected, "you" | `--accent` (+ `--accent-bg` fill, `--accent-line` border) |
| Outcome | `--ok`, `--warn`, `--danger` (+ `-bg` fills, `-line` borders) |
| Step kinds | `--k-code`, `--k-approval`, `--k-loop`, `--k-tool`, … ; a choice's path is `--path` |
| Tint formula | `color-mix(in srgb, var(--x) N%, transparent)` — **12–16%** fill, **30–40%** border, **50–55%** dot at rest |

Never use colour alone: pair it with a word, icon or shape (a dashed line means "then", solid means data).

### Spacing — a 4px grid
`4 · 8 · 12 · 16 · 24 · 32 · 40 · 48`. Inside a component use 4–12; between components 16–24; between sections
24–48. **Components never touch**: the minimum gap between two independent things is 12px (16px in a list, 40px+
between canvas columns — see the canvas formula).

### Radius — by size
`radius ≈ height × 0.3`, snapped: **6px** chips/inputs ≤28px tall · **8px** buttons, rows (`rounded-md`) · **12px**
cards, panes (`rounded-lg`) · **14–18px** floating panels, frames · **999px** pills. A nested radius is the outer
radius minus the padding between them.

### Size
- Control heights: **28** (icon button, tiny) · **32** (`Button size="sm"`) · **36** (`md`). Hit area ≥ 28×28.
- Icons: **14px** in text and buttons, **16px** in pane headers, inside a **26–30px** rounded square when it heads a
  card or pane.
- Status dots: **6–8px**. Port dots on the canvas: **6px** with a 2px ring in the card's colour — subtle, never the
  focus of the card.

### Motion
| Kind | Duration | Easing |
| :-- | :-- | :-- |
| Hover, colour, small state | 150ms | ease |
| Enter (fade + 3–4px rise) | 180ms | ease-out |
| Pane / panel slide | 320ms | `cubic-bezier(.2,.8,.2,1)` |
| Zoom (buttons) | 220ms | same; **none** while dragging or wheel-zooming |
| Live indicator pulse | 1.2–2s loop | ease-in-out |
Everything animated has a `prefers-reduced-motion: reduce` override in the same block.

---

## 5. Building a page

Every page under `app/(app)/` follows this recipe.

```tsx
export default function ThingsPage() {
  usePageHeader({ title: "Things", actions: <Button size="sm">New thing</Button> }); // or <PageHeader/>
  const { data, loading, error, reload } = useAsync(() => listThingsPage(filters), [filters]);
  return (
    <Page>
      <Zone name="notices">{error && <Notice tone="danger" action={<Button variant="ghost" onClick={reload}>Try again</Button>}>{error}</Notice>}</Zone>
      <Zone name="controls">{/* search, filters */}</Zone>
      <Zone name="content">{loading ? <Skeleton rows={4} /> : data?.length ? <DataTable … /> : <EmptyState … />}</Zone>
      <Zone name="related">{/* optional, secondary links */}</Zone>
    </Page>
  );
}
```

Zones, in this order: `header → notices → controls → content → related`. Only `related` has chrome of its own.

Data rules (each one is a bug that happened):
- **One request per view, not one per row.** A list endpoint returns what its rows print; the full record loads when
  a row is opened. (History made 68 requests for 67 runs — beta-2.26.0.)
- **Lists page**: 50 per request, newest first, keyed on the last item shown (a cursor, never an offset), with
  "Load more" and a line saying when everything is shown.
- **Search and filters run on the server**, over every item, debounced ~300ms — never over what happens to be loaded.
- **Every `useAsync` reads `error`** and draws it; an unreadable list is not an empty one.
- An ended session (`401 not_authenticated | identity_expired`) goes to sign-in and back (`lib/session-expiry`); never
  catch it into an empty state.
- A live stream (SSE/WebSocket) **reconnects** with backoff 1s → 2s → 4s … ≤30s, says "Reconnecting…", and catches up
  from the source of truth when it returns.

---

## 6. Building a component

1. **Compose primitives first** (`components/ui/*`). Add a primitive only when a second screen needs the same thing.
2. **Props are data, not layout.** A card takes a step, not a title + subtitle + 6 flags.
3. **Fixed geometry for repeated things**: cards in a list or on a canvas have a fixed width and capped content
   (≤2-line title, ≤4 ports a side, "+N more"), so one long value cannot reshape its neighbours.
4. **States**: default · hover (border toward `--accent-line`, ≤1px lift) · selected (`--accent` border + 4px
   `--accent-bg` ring) · focus-visible (2px `--accent` outline, 2px offset) · disabled (40% opacity, no pointer) ·
   dimmed (45% when something else is in focus).
5. **Keyboard**: everything clickable is a `button` or has `role` + `tabIndex` + Enter/Space; `Esc` closes the topmost
   pane, bound on the document.
6. **Styles**: Tailwind with tokens for one-off layout; a prefixed class block in `globals.css` for a component with
   states and motion (`.pic-*` canvas, `.pis-*` side pane, `.pi-*` chat). **One block per concern, each with its own
   header comment** — never interleave blocks (a rewrite of one deleted another's styles in beta-2.25.1).
7. **Copy lives with the component** and is tested when it encodes a rule ("never says *retry* on a refusal").
8. **Test what it promises**: a render test for each state; a test that the stylesheet still carries rules the render
   test cannot see (`PiFlowCanvas.test.tsx`).

---

## 7. Patterns

| Pattern | Use | Reference |
| :-- | :-- | :-- |
| **Side pane** | Properties of a selected thing, or a secondary view (Files). Slides in from the right over the content, floats 12px from the edges, tabs for sections, `Esc`/✕ closes, keeps its content while sliding out | `PiSidePane.tsx` |
| **Tabs** | 2–4 sections of one subject. Underline 2px `--accent`; a status dot on a tab may summarise it (Last run ✓/✕) | `.pis-tabs` |
| **Hover detail** | Where a value comes from, what a port gives — a dark tooltip, max 260px, plus lighting the related link | `.pic-tip` |
| **Failure card** | A turn or action that did not finish: title in plain words, what to do, Try again only if it can help, raw error behind "Show details" | `FailureCard` |
| **Working line** | Something running: a pulsing dot + one sentence of what it is doing; elapsed time after 15s; warn tone while retrying | `Thinking` |
| **Connection pill** | A live link being retried: small floating pill, warn dot, "Reconnecting…" | `.pi-link` |
| **Empty state** | One sentence of what will appear and how to get it; one action at most | `EmptyState` |
| **Notice** | Page-level message: `danger` (failed) · `warn` (needs attention) · `info` · `ok` | `Notice` |
| **Ids** | 5 characters + "…", full id in `title`, copy button before the text, link when it has a page | `CopyableId` |

---

## 8. Review checklist (before merging UI)

- [ ] One L1, one primary action; hierarchy reads in order (§2).
- [ ] Surfaces use the depth ladder; floating things have margins and no band behind them (§3).
- [ ] Only tokens — no hex, no ad-hoc shadow, spacing on the 4px grid (§4).
- [ ] Loading, empty, error and data states all drawn; errors offer a way out.
- [ ] One request per view; lists page; filters on the server (§5).
- [ ] Hover, selected, focus-visible, disabled and dimmed states; keyboard reachable; `Esc` closes.
- [ ] Long text truncates with `title`; nothing reflows a neighbour.
- [ ] Motion within the table above and off under reduced motion.
- [ ] Styles in their own commented block; a test that pins anything a render test cannot see.
- [ ] Checked in light and dark.

---

*Older documents in this directory (`component-panel.md`, `component-model-gaps.md`) describe the compiled builder's
step panel, which now opens only for flows not built by Forge. Their panel rules are folded into §6–§7 above.*
