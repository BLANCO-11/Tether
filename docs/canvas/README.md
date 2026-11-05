# The workflow builder — canvas, side pane and chat

**Status:** current, 2026-10-11 (beta-2.23.0 → 2.26.0). The Forge builder (`components/pi-builder/*`) is what every
workflow opens in. General rules (tokens, depth, page recipe) are in `docs/design/README.md`; this file is the
builder's own spec. The four drafts beside it (`add-step.md`, `card-and-container.md`, `connections.md`,
`run-and-debug.md`) describe the compiled builder's canvas and are kept for that history.

```
┌ top bar ── workflow name · state chip ──────────────── [Files] [Test] [Save] ┐
├ chat (immersive) ┬ canvas ───────────────────────────────┬ side pane ───────┤
│ turns, no boxes  │  cards · ports · links · loop frames   │ slides in, 12px  │
│ floating composer│  zoom bar (bottom-left), legend (right)│ from the edges   │
└──────────────────┴────────────────────────────────────────┴──────────────────┘
```

| Part | Code | Styles |
| :-- | :-- | :-- |
| Model: workflow → cards, ports, links, frames, columns | `lib/pi-canvas.ts` (pure, tested) | — |
| Canvas | `PiFlowCanvas.tsx` | `.pic-*` in `globals.css` |
| Side pane (step, Files) | `PiSidePane.tsx` | `.pis-*` |
| Chat, composer, connection | `PiBuilderWorkbench.tsx` | `.pi-*` |

---

## 1. The canvas model

Everything drawn comes from `piCanvasModel(workflow)`; the component only measures and paints it.

**Cards** — one per step, approval and choice, plus **Start** and **End**:

| Kind | Icon / hue | Shows |
| :-- | :-- | :-- |
| step (code) | `Code`, `--k-code` | Inputs, Settings (fixed values), Outputs |
| approval | `Shield`, `--k-approval` | Inputs (what is reviewed), outputs read later (`decision`, …) |
| choice | `Fork`, `--path` | Paths (If / Else if / Otherwise + condition in words), Outputs |
| Start / End | `Play`, muted | What the run is given / hands back |

A **loop** is not a card: it is a dashed frame (`--k-loop`) around its steps, labelled
"For each *person* in *review.short*". The list enters at its left edge; its counts (`succeeded`, `failed`, …) leave
from its right edge.

**Links** — three kinds, and nothing else:

| Kind | Drawn | Means |
| :-- | :-- | :-- |
| data | solid `--accent` | an input reads this output (`find.rows`, `$input.week`) |
| path | solid `--path` | a choice's path runs this step |
| then | dashed `--dim` | runs after, with no data between — drawn **only** where nothing else leads to a node |

Every binding is a link from the output it reads to the input that reads it. Literal parameters are **Settings**,
never links. A choice's following step is drawn from the choice once, never from every path's end.

## 2. Layout formula

Measured, never guessed: cards are rendered, their heights read, then placed.

| Constant | Value | Meaning |
| :-- | :-- | :-- |
| `W` | 244px | card width (fixed) |
| `GAP_X` | 120px | between columns |
| `GAP_Y` | 44px | between cards in a column |
| `PAD` | 40px | frame padding; each frame opening/closing at a column adds `PAD` to x |
| `MARGIN` | 60px | around the whole picture |
| `MAX_PORTS` | 4 | per side; the rest become "+N more" (opens the pane on Inputs & outputs) |

```
x(col)   = MARGIN + Σ (W + GAP_X) over earlier columns + PAD × (frames opened up to col) + PAD × (frames closed before col)
y(card)  = mid − colHeight/2 + Σ (h + GAP_Y) over cards above it in the column
mid      = MARGIN + depth × (PAD + 14) + max(colHeight)/2        // depth = deepest loop nesting
frame    = bounds(members ∪ inner frames) grown by PAD (+8 at the top for its label)
```

Columns: Start is column 0, then each step in order; a choice's paths run in parallel columns after it; a loop's steps
take columns inside its frame; End is last. A dragged card keeps its position (`flow_step_positions`, per saved
flow), and its frame still wraps it.

Port positions come from each port's `offsetTop` inside its card, so links stay attached at any zoom.

## 3. Cards — anatomy and caps

```
┌────────────────────────────────┐
│ [icon] Title, two lines max…   │  ← 13px/500, clamp 2; sub-line = step id, mono 11px dim
├────────────────────────────────┤
│ INPUTS                          │  ← eyebrow 10px uppercase dim
│●week_start                      │  ← port: name only, mono 11px, one line, ellipsis
│ SETTINGS                        │
│ limit                     40    │
│ OUTPUTS                         │
│                      short ●    │
│                     +2 more     │
└────────────────────────────────┘
```

- Port names only — where a value comes from is on hover ("From *rows of find*"), and that one link lights up.
- Port dots 6px, 50% tint at rest, full colour on hover/selection.
- **Compact mode below 75% zoom**: icon + title only; ports collapse to the card's middle so links still land.

## 4. Interaction

| Gesture | Result |
| :-- | :-- |
| Drag the background | pan freely (works even when everything fits) |
| Scroll / trackpad | pan · **Ctrl/⌘ + scroll or pinch**: zoom at the cursor (0.4–1.4) |
| Drag a card | move it; kept per saved flow · reset button (bottom-left) puts every card back |
| Click a card | select + open the side pane (Overview) · click empty canvas: deselect |
| Hover a card | its whole path lights (upstream + downstream), one glowing pulse travels it start → finish (600ms per link, `pulseTiming`), everything else dims to 45% |
| Hover a port | tooltip with its source / type; its link lights |
| Fit button | zoom to fit, centred |

The hover pulse is the same flow as the compiled builder's canvas; its styles are pinned by `PiFlowCanvas.test.tsx`.

## 5. Side pane

One pane, two subjects, sliding in from the right (320ms), floating 12px from the canvas edges, `Esc` or ✕ to close.
It keeps its content while sliding out.

- **A step** (click a card): header = icon in the kind's hue, title (its description), id. Tabs:
  **Overview** (what it does, reads, actions, may-be-empty, connections) · **Inputs & outputs** · **Code** ·
  **Last run** (✓/✕ dot on the tab). Approvals and choices: Overview + Last run.
- **Files** (top-bar button, toggles): a code editor's explorer — slim header, collapsible folder tree with type
  glyphs (`py`, `{}`), **A**/**M** marks for what was added/changed since your last message (pulsing while Forge
  writes), the open file as a tab with breadcrumbs, new lines with a green bar, "Only new lines" filter. Shows
  `workflow.json` and every `steps/**`.

## 6. Chat

- **Immersive**: turns run on the page's background, not in boxes. A person's message is an accent bubble
  (radius 16/16/5/16); Forge's reply sits beside a 22px gradient mark.
- **Floating composer**: 16px radius, `--line-interactive` border, focus ring 4px `--accent-bg`; the conversation
  fades out beneath it — **no band behind the input**. A test-run approval sits just above it.
- **Working line**: pulsing dot + what Forge is doing ("Writing the *send report* step…"), clock after 15s, warn tone
  while the AI service is retried.
- **Failure card** on a turn that did not finish, with Try again when it can help.
- **Connection**: a dropped stream retries (1s, 2s, 4s… ≤30s) with a "Reconnecting to the builder…" pill, then catches
  up from the session; if the server restarted, a saved workflow reopens itself and an unsaved one says so with Reload.

## 7. Adding to the builder

- New step kind → add it to `piCanvasModel` (its ports and links), an icon + hue row in §1, and a pane view; the card
  anatomy and caps stay.
- New link meaning → don't. Three kinds is the vocabulary; a fourth needs a decision here first.
- New pane → a tab in the existing pane, not a second pane. The pane is the one place properties live.
- Keep the model pure and tested (`lib/pi-canvas.test.ts`); keep each style block separate and commented.
