// src/lib/canvas-layout.ts — where the nodes go.
//
// ── Why a layout library and not coordinates ─────────────────────────────────
//
// A flow model has no coordinates and must not gain any — but a FLOW may carry
// a saved arrangement, in the `flow_step_positions` table OUTSIDE the model and
// the revision (plan decision ②, D-150). The two live together like this:
//
//   * A step WITH a saved row sits where the row says.
//   * A step WITHOUT one is placed by `nearestNeighbour` below — midpoint of its
//     neighbours' positions, offset one node to the right, staggered downward
//     per successive unplaced add so they never stack (D-150(d)).
//   * When there are NO rows at all, the whole graph is dagre's (the fallback —
//     the layout this file has always derived, unchanged).
//
// So position is still derived, every render, from the edges AND the rows; the
// rows are the part a human owns. The model itself stays coordinate-free, which
// is what keeps two people reviewing the same revision looking at the same
// picture: a step deleted from `dependsOn` leaves its box gone, not floating.
import dagre from "@dagrejs/dagre";
import type { CanvasEdge, CanvasFrame, CanvasNode } from "@/lib/canvas-model";

/**
 * The card's MINIMUM width, and its fixed height. Both must move together with
 * the node component — see `widthFor` for what varies.
 */
export const NODE_W = 232;
export const NODE_H = 76;

/**
 * The card's ceiling. A name longer than this still truncates, because a card
 * wide enough for any name is a card that stops being a card: dagre spaces
 * ranks by the widest node in them, so one 90-character step id would push
 * every other column off the screen. 384 holds ~43 characters, which covers
 * every step id and label in this deployment.
 */
export const MAX_NODE_W = 384;

/**
 * ⚠ **THE CARD GROWS FOR ITS PORTS TOO, AND THE COMMENTS THAT SAID IT MUST NOT
 * WERE READING I-66 TOO BROADLY.**
 *
 * `FlowCanvas` carried *"the card is NOT allowed to grow for them, and that is
 * I-66 … a long chain crowds rather than resizes"* in three places. I-66's
 * actual rule is narrower and is about AGREEMENT, not fixity: `stepNodes`
 * declares a size to React Flow, dagre spaces by a size, and the card draws at
 * a size — and when those three disagree, `parseHandles` discards the handle
 * bounds, `getEdgePosition` returns null and **every edge unmounts**.
 *
 * Crowding was one way to keep them agreeing. Deriving all three from one
 * function is another, and it is the one that lets a card with six ports be
 * readable. Handles are spaced at fractional offsets of the card's height, so
 * at a fixed 76px a fifth port sits 12px from its neighbour and the labels
 * collide — reported as *"if there are multiple inputs/outputs the height
 * should grow"*, and correct.
 *
 * `PORT_ROW` is the vertical room one labelled port needs: the label is
 * `text-micro` at ~11px with `tracking-label`, so 22px is the line plus air.
 * Every port row grows the card past the header — no free rows, because a
 * "free" row is a row whose dot has no line to sit beside.
 *
 * ⚠ **The ceiling is not cosmetic.** dagre's `nodesep` is the vertical gap in
 * an LR graph, so a tall node pushes every sibling in its rank apart; an
 * uncapped card turns one eight-armed branch into a graph nobody can fit on
 * screen. Past the cap the ports crowd again, which is the old behaviour
 * arriving where it belongs — at the extreme, not at three.
 */
export const MAX_NODE_H = 208;
/**
 * One labelled port row needs 22px: a `text-micro` label plus air. Exported —
 * the card draws its port rows at exactly this pitch (see `portTop`), so the
 * dots and the rows cannot drift apart into a second copy of the number.
 */
export const PORT_ROW = 22;
/**
 * Breathing room between the header block and the first port row. It doubles
 * as the card-level target's landing strip: the `__params__` dot centres here,
 * so it never stacks onto a named port's dot.
 */
export const PORT_LANDING = 14;
/** Bottom air under the last port row — the body's `py-2` bottom half. */
export const PORT_BOTTOM = 8;

/** The most key rows a card draws — past this, params collapse to a "+N more" row. Dify parity: the card shows its key config, not every field. */
export const MAX_CARD_ROWS = 4;

/**
 * The content rows the card draws. Params buy rows again (capped — the diet's
 * "never for inputs" rule was more minimal than Dify, and the user chose
 * Dify): the first rows name the bound params, and past the cap the last row
 * is "+N more". A whole-object feed takes row 0 for its labelled inlet (see
 * `inletTop`). A real fork (arms) and code-output fields cost rows exactly
 * as before, and the card clears whichever side is busiest.
 *
 * ⚠ `FlowCanvas` draws EXACTLY this many rows — same function, both sides —
 * which is what keeps the I-66 agreement (declared size = dagre spacing =
 * drawn card) now that the card moves again.
 */
export function keyRows(node: {
  arms?: Array<unknown> | null;
  inputHandles?: Array<unknown> | null;
  outputHandles?: Array<unknown> | null;
  wholeFrom?: string | null;
}): number {
  const params = node.inputHandles?.length ?? 0;
  // ⚠ A whole-object feed buys a row for its labelled inlet: row 0 reads
  // `all inputs ← the whole of <step>`, and the per-field rows follow it.
  // Past the cap the last row is "+N more" as before — the inlet never pushes
  // the card past `MAX_NODE_H`, it trims a param row instead.
  const whole = node.wholeFrom ? 1 : 0;
  const paramRows = params === 0 ? 0 : Math.min(params, MAX_CARD_ROWS - whole) + whole;
  const arms = node.arms?.length ?? 0;
  return Math.max(paramRows, arms > 1 ? arms : 0, node.outputHandles?.length ?? 0);
}

/**
 * How many input dots sit beside a drawn row. Past the cap the last row is
 * "+N more", so only the first params have a row — the rest crowd below the
 * content (see `inputHandleTop`). The renderer uses this too: a dot beside a
 * row for `i < shown`, a crowded dot otherwise.
 *
 * ⚠ Counted WITHOUT the whole inlet: the inlet takes row 0 (see
 * `inputRowTop`), so a whole-fed card with a full house draws the inlet plus
 * `MAX_CARD_ROWS - 2` param rows plus "+N more".
 */
export function shownInputRows(node: { inputHandles?: Array<unknown> | null; wholeFrom?: string | null }): number {
  const params = node.inputHandles?.length ?? 0;
  if (params === 0) return 0;
  const whole = node.wholeFrom ? 1 : 0;
  return params > MAX_CARD_ROWS - whole ? Math.max(0, MAX_CARD_ROWS - whole - 1) : params;
}

/**
 * The dot beside parameter `index`'s drawn row. The whole inlet takes row 0,
 * so every per-field dot sits one row lower on a whole-fed card — same
 * function the renderer uses, so dots and rows cannot drift apart.
 */
export function inputRowTop(node: SizingNode, index: number): number {
  return portTop(node, index + (node.wholeFrom ? 1 : 0));
}

/**
 * The card-level inlet: on the whole row when there is one, else the landing
 * strip. The renderer draws the `__params__` dot here in both branches, so an
 * edge always lands on a labelled row rather than an unnamed strip.
 */
export function inletTop(node: SizingNode): number {
  return node.wholeFrom ? portTop(node, 0) : headerHeight(node) + PORT_LANDING / 2;
}

/**
 * ⚠ **THE BODY IS FIXED, AND THE CARD NO LONGER GROWS FOR ITS TEXT.**
 *
 * Reported from use with a screenshot: `TRANSFORM`, `ONLY WHEN if` and
 * `TOOL CALL` sliced off mid-glyph at the bottom of their cards. The card is
 * `overflow-hidden` — it has to be, for the rounded corners — so a body taller
 * than the declared height does not spill, it **disappears**.
 *
 * The diet fixes the body at header text + one caption row (`ROW_TITLE` +
 * `ROW_CAPTION`, plus `py-2` top and bottom). Question, ref, flag, meta and
 * arm no longer buy rows: they live in the pill and the earned description
 * line, which share the caption row's room. Only arms and code-output fields
 * still grow the card (see `portRows`).
 *
 * ⚠ **Rounded UP, deliberately.** The constants below are each a hair above the
 * real line box. An overestimate costs a few pixels of empty card; an
 * underestimate silently eats a line of text, which is the bug being fixed —
 * and the same reason `widthFor` errs wide.
 *
 * ⚠ **`depth` is not read here.** In `technical` depth the second line is
 * `text-micro` rather than `text-caption`, 1.4px shorter, and `depth` is a
 * prop of the CANVAS rather than a field of the node — threading it in would
 * make the layout depend on a display toggle. The caption figure is the taller
 * of the two, so technical depth gets the same card with slightly more air.
 */
const PAD_Y = 16;
const ROW_TITLE = 20;
const ROW_CAPTION = 18;

type SizingNode = {
  id?: string;
  label?: string | null;
  arms?: Array<unknown> | null;
  inputHandles?: Array<unknown> | null;
  outputHandles?: Array<unknown> | null;
  ref?: string | null;
  meta?: string | null;
  flag?: string | null;
  question?: string | null;
  ordinal?: unknown;
  arm?: unknown;
  wholeFrom?: string | null;
  status?: string | null;
  boundary?: unknown;
  facts?: Array<{ label: string; value: string }> | null;
};

function bodyHeight(_n: SizingNode): number {
  // Fixed: header text + one caption row (the pill). Question, ref, flag,
  // meta and arm buy no rows — the pill names the concrete thing and the key
  // rows below name the config. The drawn rows must total `keyRows(n)`.
  return PAD_Y + ROW_TITLE + ROW_CAPTION;
}

/**
 * The header block without its trailing half-pad: once ports exist the rows
 * follow immediately, so the bottom 8px belong to the section gap instead.
 * The renderer draws rows from this same origin (see `portTop`) — which is
 * what keeps dots beside their lines instead of drifting with percentages.
 */
export function headerHeight(n: SizingNode): number {
  return bodyHeight(n) - PAD_Y / 2;
}

/**
 * ⚠ **BOUNDARY CARDS GROW FOR THEIR CONTENT TOO — the height counterpart of
 * `widthFor`'s own estimate, below.**
 *
 * Start and End used to fix at `NODE_H` and scroll their body internally
 * (`overflow-y-auto`), with a long fact value truncating past `MAX_NODE_W`
 * on top of that. Reported from use on both: Start's declared inputs needed
 * a scrollbar to read, and End's result sentence cut off mid-word. This is
 * the same "grow the card, don't hide the content" move `widthFor` already
 * makes for a boundary's longest line — kept as an estimate rather than a
 * measurement for the same reason (layout runs before first paint and in
 * jsdom, where a DOM measurement is always zero), and it errs high for the
 * same reason too: a few pixels of empty card beats a clipped line.
 *
 * ⚠ **NOT capped at `MAX_NODE_H` — reported from use a SECOND time, on the
 * SAME two nodes, after the first fix above still clipped a long result
 * sentence.** `MAX_NODE_H`'s own note is about a branch's many arms crowding
 * dagre's rank spacing; a boundary card is the only node in its rank (there is
 * exactly one Start and one End per graph), so nothing else in the layout
 * pays for it growing.
 *
 * ⚠ **`overflow-hidden` is GONE from the boundary card too, and the char-width
 * constants below now err wider than the earlier reading.** The estimate is
 * still an estimate — no DOM to measure before first paint — and a card whose
 * `description` is rendered TWICE (once as `meta`, once as the `which is`
 * fact, deliberately — see `withEnd`) has more surface for that estimate to
 * miss on. Without the clip, a miss now costs a few px of harmless overflow
 * past the pill instead of a silently vanished line.
 */
const BOUNDARY_PAD_Y = 20; // px-3.5 py-2.5's vertical half
const BOUNDARY_TITLE_ROW = 18; // icon + label row, text-[13px]
const BOUNDARY_META_GAP = 4; // mt-1
const BOUNDARY_META_LINE = 14; // text-[11px] line box
const BOUNDARY_META_CHAR_W = 6.2;
const BOUNDARY_FACTS_GAP = 6; // mt-1.5
const BOUNDARY_FACT_ROW_GAP = 4; // space-y-1
const BOUNDARY_FACT_LINE = 13; // text-[10px] line box
const BOUNDARY_FACT_CHAR_W = 5.8;
/** `<dt>` is `shrink-0`, so it claims real width before the value ever
 * wraps — subtracted up front rather than measured, same reasoning as the
 * rest of this estimate. */
const BOUNDARY_FACT_LABEL_W = 56;
const BOUNDARY_INNER_PAD_X = 28; // px-3.5, left + right

/**
 * How many lines plain text needs at a given pixel width — the wrapping
 * counterpart of `widthFor`'s single-line character estimate.
 */
function wrapLines(text: string, widthPx: number, charW: number): number {
  if (!text) return 0;
  const perLine = Math.max(1, Math.floor(widthPx / charW));
  return Math.max(1, Math.ceil(text.length / perLine));
}

function boundaryHeight(node: SizingNode): number {
  const innerW =
    widthFor({ id: node.id ?? "", label: node.label, ref: node.ref, boundary: node.boundary, meta: node.meta, facts: node.facts }) -
    BOUNDARY_INNER_PAD_X;
  let h = BOUNDARY_PAD_Y + BOUNDARY_TITLE_ROW;
  const meta = node.meta ?? "entry point";
  h += BOUNDARY_META_GAP + wrapLines(meta, innerW, BOUNDARY_META_CHAR_W) * BOUNDARY_META_LINE;
  const facts = node.facts ?? [];
  if (facts.length) {
    h += BOUNDARY_FACTS_GAP;
    for (const f of facts) {
      const valueW = Math.max(40, innerW - BOUNDARY_FACT_LABEL_W);
      h += BOUNDARY_FACT_ROW_GAP + wrapLines(f.value, valueW, BOUNDARY_FACT_CHAR_W) * BOUNDARY_FACT_LINE;
    }
  }
  return h;
}

export function heightFor(node: SizingNode): number {
  if (node.boundary != null) {
    return Math.max(NODE_H, boundaryHeight(node));
  }
  const rows = keyRows(node);
  const ports = rows === 0 ? 0 : PORT_LANDING + rows * PORT_ROW + PORT_BOTTOM;
  return Math.min(MAX_NODE_H, Math.max(NODE_H, headerHeight(node) + ports));
}

/**
 * Pixel offset from the card's top edge to an output/arm row's vertical centre.
 * Fractional offsets are what stacked the old labels onto the header: a
 * percentage of a grown card is a different place than the line it names.
 *
 * ⚠ The body is fixed, so a dot can sit a hair low of its line's true centre —
 * adjacent, never on the wrong row (the pitch is 22). Past the ceiling the
 * rows crowd and dots clamp onto the bottom edge: crowding arrives at the
 * extreme, where it belongs.
 */
export function portTop(node: SizingNode, index: number): number {
  const raw = headerHeight(node) + PORT_LANDING + index * PORT_ROW + PORT_ROW / 2;
  return Math.min(raw, heightFor(node) - 12);
}

/**
 * Pixel offset for an input dot PAST the drawn rows. Shown params sit beside
 * their row (see `portTop`); overflow params crowd on a 12px pitch below the
 * content instead of buying rows — clamped to the card edge, so many inputs
 * stack rather than resize.
 */
export function inputHandleTop(node: SizingNode, index: number): number {
  const rows = keyRows(node);
  const shown = shownInputRows(node);
  const raw =
    headerHeight(node) + PORT_LANDING + rows * PORT_ROW + PORT_BOTTOM + 8 + Math.max(0, index - shown) * 12;
  return Math.min(raw, heightFor(node) - 12);
}

/**
 * ⚠ **THE CARD IS SIZED FROM ITS TEXT, AND THREE PLACES HAVE TO AGREE.**
 *
 * Reported from use: *"when nodes increase they get messy and overlap, and the
 * names are not visible"*. The name half is this function; the overlap half is
 * the stagger in `arrangedLayout` below, which was a separate bug.
 *
 * The card was a fixed 232px with `truncate` on the name, so
 * `chase_tickets_that_missed_target` and `Chase tickets that missed their
 * target` both rendered as an ellipsis — on a canvas whose entire purpose is
 * to let someone read the shape of a flow at a glance.
 *
 * ⚠ **`NODE_W`/`NODE_H` are read in THREE places** — dagre's spacing, React
 * Flow's declared `measured` size, and the card's own `style` — and I-66 is the
 * record of what happens when they disagree: React Flow compares nodes by
 * identity, `parseHandles` discards handle bounds it cannot confirm, and
 * **every edge unmounts** with nothing flickering to say why. So a
 * content-sized card cannot be a CSS change. Every one of those three call
 * sites now asks this function, and `FlowCanvas.test.tsx` pins the rendered
 * card against it.
 *
 * ⚠ **It is an ESTIMATE and it is deliberately not a measurement.** Measuring
 * text needs a DOM, and layout runs before first paint and in jsdom, where
 * every measurement is zero. An estimate that is a little wide costs some
 * whitespace; a measurement that silently returns 0 collapses every card. The
 * estimate errs high for that reason.
 *
 * ⚠ **`topology` in `FlowCanvas` must include the labels**, because this makes
 * `layout()` read something beyond node ids and edges. That comment says the
 * key "has to grow the same day" and names this exact failure — *"sometimes the
 * boxes overlap"*.
 */
const CARD_CHROME = 102;
const CHAR_W = 6.6;

export function widthFor(node: {
  id: string;
  label?: string | null;
  ref?: string | null;
  boundary?: unknown;
  meta?: string | null;
  facts?: Array<{ label: string; value: string }> | null;
}): number {
  // The pill draws `kind · ref`, so a card sized to the label alone would
  // truncate its own pill on every short-named tool step. Step cards draw
  // neither meta nor facts (panel-only), so those stay boundary-only.
  const texts = [node.label ?? node.id];
  if (node.ref) texts.push(node.ref);
  if (node.boundary != null) {
    if (node.meta) texts.push(node.meta);
    for (const f of node.facts ?? []) texts.push(`${f.label} ${f.value}`);
  }
  const longest = texts.reduce((m, t) => Math.max(m, t.length), 0);
  const want = Math.ceil(CARD_CHROME + longest * CHAR_W);
  return Math.min(MAX_NODE_W, Math.max(NODE_W, want));
}

/** dagre's spacing, exported so the threshold below is derived and not a copy. */
export const NODE_SEP = 36;
/** A loop box (phase F): its header's height and the gap between the box and the cards inside it. */
export const FRAME_HEAD = 30;
export const FRAME_PAD = 14;
/** A box's id on the canvas — never a step id (a step id cannot start with `__`). */
export const FRAME_PREFIX = "__frame:";

/**
 * A loop box's rectangle, fitted around its members' cards as they are drawn now (phase F): the header on top, a margin on the
 * other sides. Null when none of its members is drawn.
 */
/** A loop's box stacks between the steps outside it (0, behind it) and its own steps (on it) — the box is a section, not an outline. */
export const LOOP_FRAME_Z = 1;
export const LOOP_MEMBER_Z = 2;
/** Each node's stacking over the loops' boxes: a loop's own step on its box, every other step behind it. */
export function stackOnLoops<N extends { id: string }>(nodes: N[], members: ReadonlySet<string>): Array<N & { zIndex: number }> {
  return nodes.map((n) => ({ ...n, zIndex: members.has(n.id) ? LOOP_MEMBER_Z : 0 }));
}
/** A wire between two of a loop's own steps sits on its box with them; every other wire passes behind it, as the steps do. */
export function stackEdgesOnLoops<E extends { source: string; target: string }>(edges: E[], members: ReadonlySet<string>): E[] {
  return edges.map((e) => (members.has(e.source) && members.has(e.target) ? { ...e, zIndex: LOOP_MEMBER_Z } : e));
}
export function frameBox(members: Array<{ x: number; y: number; w: number; h: number }>): { x: number; y: number; width: number; height: number } | null {
  if (!members.length) return null;
  const x0 = Math.min(...members.map((m) => m.x)) - FRAME_PAD, y0 = Math.min(...members.map((m) => m.y)) - FRAME_PAD - FRAME_HEAD;
  const x1 = Math.max(...members.map((m) => m.x + m.w)) + FRAME_PAD, y1 = Math.max(...members.map((m) => m.y + m.h)) + FRAME_PAD;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
export const RANK_SEP = 96;
export const MARGIN = 8;

/**
 * The narrowest container in which a graph can show a RELATIONSHIP: three nodes
 * in a row and the two gaps between them.
 *
 * ⚠ **This is D-79's threshold, and the point of computing it here is that it
 * stays true.** D-79 says the number comes from the three-node minimum *"not
 * from a breakpoint that looked round"* — so it is read off the same four
 * constants `layout()` is handed. Widen the card or the rank separation and the
 * threshold moves with them; write it down as `840` somewhere and it does not,
 * and the day it goes stale nothing says so.
 *
 * It is **840**, and the `form` measure is 680. That inequality is the whole of
 * D-104: a canvas in a reading column cannot show what a canvas is for.
 */
export const MIN_CANVAS_W = NODE_W * 3 + RANK_SEP * 2 + MARGIN * 2;

export type Positioned = { id: string; x: number; y: number };

/** One saved row, as the positions API carries it. */
export type SavedPosition = { x: number; y: number };

/**
 * Left-to-right layered layout — with the saved arrangement overlaid.
 *
 * Left-to-right rather than top-down: a flow reads as a sequence, the node cards
 * are wider than they are tall, and the page it sits on already scrolls
 * vertically — a top-down graph would fight the page for the same axis.
 *
 * `saved` is the positions map keyed by step id (from `flow_step_positions`,
 * D-150). Null/empty ⇒ pure dagre, the behaviour this function always had.
 * Otherwise dagre is STILL the base layer — every node starts where dagre put
 * it — and every step WITH a row takes it. `nearestNeighbour` below applies
 * ONLY to a step with no saved row AND no graph-neighbour that has one: a node
 * dagre could not place near the arranged cluster, i.e. a genuinely new or
 * disconnected step (D-150(d), narrowed 2026-09-03).
 *
 * ⚠ **THE CLIFF (2026-09-03).** This function used to abandon dagre entirely
 * the moment ONE row existed, re-placing every unsaved node by
 * `nearestNeighbour` — midpoint-plus-offset coordinates, nothing like the
 * picture on screen. So dragging the FIRST node in a flow visibly moved every
 * other node. The next person reaching for "place everything unsaved by
 * neighbour" is re-deriving that cliff: the base layer stays dagre so an
 * arrangement can only ever move the node it names.
 *
 * Determinism survives the narrowing: dagre is deterministic for a given
 * node/edge set, saved rows are overlaid verbatim, and the remaining unplaced
 * are walked in the graph's own order — never in drag order. A reload with the
 * same rows produces the same picture.
 */
export function layout(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  saved?: Map<string, SavedPosition> | null,
  frames?: CanvasFrame[] | null,
): Positioned[] {
  const base = new Map(dagreLayout(nodes, edges, frames).map((p) => [p.id, p] as const));
  if (!saved || saved.size === 0) return separate(nodes, nodes.map((n) => base.get(n.id)!), new Set());

  const savedIds = new Set(saved.keys());
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    for (const [a, b] of [
      [e.source, e.target],
      [e.target, e.source],
    ]) {
      const list = neighbours.get(a);
      if (list) list.push(b);
      else neighbours.set(a, [b]);
    }
  }

  /** Every node by id, so a placed neighbour's WIDTH can be looked up. */
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const placed = new Map<string, Positioned>();

  // Pass 1: every SAVED row, so the passes below always compute against the
  // arrangement — a row is never displaced by anything walked later.
  for (const n of nodes) {
    const row = saved.get(n.id);
    if (row) placed.set(n.id, { id: n.id, x: row.x, y: row.y });
  }

  // Pass 2: the unsaved that dagre already placed near the arranged cluster —
  // every node WITH a saved graph-neighbour keeps its dagre spot. This is the
  // pass that fixes the cliff: one saved row moves one node, never the rest.
  for (const n of nodes) {
    if (placed.has(n.id)) continue;
    const nearSaved = (neighbours.get(n.id) ?? []).some((id) => savedIds.has(id));
    if (nearSaved) placed.set(n.id, base.get(n.id)!);
  }

  // Pass 3: the remainder — no row, no saved neighbour — in graph order, by
  // nearest-neighbour (D-150(d)): the midpoint of the neighbours already
  // placed, offset one card to the right along the rank axis, staggered down
  // by one separation per unplaced add already placed this pass.
  let unplacedSoFar = 0;
  for (const n of nodes) {
    if (placed.has(n.id)) continue;

    const near = (neighbours.get(n.id) ?? []).filter((id) => placed.has(id));
    const others = [...placed.values()];
    let x: number;
    let y: number;
    if (near.length > 0) {
      const midX = near.reduce((a, id) => a + placed.get(id)!.x, 0) / near.length;
      const midY = near.reduce((a, id) => a + placed.get(id)!.y, 0) / near.length;
      // One card to the right of the neighbours' midpoint. The card is the
      // WIDEST of the neighbours, not this node — the gap has to clear what is
      // actually drawn to the left of it.
      const clear = Math.max(...near.map((id) => widthFor(byId.get(id)!)));
      x = midX + clear + NODE_SEP;
      y = midY;
    } else if (others.length > 0) {
      // Isolated: below the lowest SAVED node, x-aligned to the arranged
      // mean — plus the pass stagger below. Saved, not all placed: nodes this
      // pass already put down by midpoint would otherwise compound under the
      // stagger and the gaps would widen per add instead of stepping evenly.
      const rows = [...saved.entries()];
      // The lowest saved BOTTOM, which needs each row's own card height now
      // that a card with many ports is taller than `NODE_H`.
      const lowest = Math.max(...rows.map(([id, p]) => p.y + heightFor(byId.get(id) ?? {})));
      const meanX = rows.reduce((a, [, p]) => a + p.x, 0) / rows.length;
      x = meanX;
      y = lowest + NODE_SEP;
    } else {
      // Defensive: saved named steps this graph does not have (orphaned rows
      // `dropOrphaned` drops at save time, but layout never assumes it).
      x = MARGIN;
      y = MARGIN;
    }
    /**
     * ⚠ **THE STAGGER WAS `NODE_SEP` AND THE CARD IS `NODE_H` TALL, SO EVERY
     * PASS-3 NODE OVERLAPPED THE ONE BEFORE IT BY 50 PIXELS.**
     *
     * Reported from use as *"when nodes increase they get messy and overlap"*,
     * and `FlowCanvas`'s own `topology` comment names this symptom as the thing
     * it would look like. It was not that: it was arithmetic. 26 is the gap
     * BETWEEN cards; the distance from one card's top to the next card's top is
     * the card plus the gap. Two added steps overlapped, five were a stack.
     *
     * It only ever bit a graph with a saved arrangement (pass 3 is the
     * remainder after saved rows and their neighbours), which is why the
     * unarranged demo flows looked fine and a flow somebody had actually
     * dragged did not.
     */
    y += unplacedSoFar * (heightFor(n) + NODE_SEP);
    unplacedSoFar += 1;

    /**
     * ⚠ **And then move down until the spot is genuinely free.** The stagger
     * alone spaces this pass's own nodes; it says nothing about the SAVED rows
     * and dagre-placed nodes already sitting there, and `midX + card + sep`
     * lands on top of one whenever the arrangement happens to put a node there.
     *
     * Bounded, and the bound is not decoration: an unbounded nudge on a
     * pathological arrangement is an infinite loop in a render path, which
     * takes the page down rather than drawing it badly.
     */
    const w = widthFor(n);
    const h = heightFor(n);
    for (let guard = 0; guard < 64; guard += 1) {
      const clash = [...placed.values()].some((p) => {
        const other = byId.get(p.id);
        const pw = widthFor(other ?? { id: p.id });
        const ph = other ? heightFor(other) : NODE_H;
        return x < p.x + pw && x + w > p.x && y < p.y + ph && y + h > p.y;
      });
      if (!clash) break;
      y += h + NODE_SEP;
    }

    placed.set(n.id, { id: n.id, x, y });
  }

  return separate(nodes, nodes.map((n) => placed.get(n.id)!), savedIds);
}

/** Two boxes closer than `NODE_SEP` on both axes — touching counts as a clash, so cards always keep a clear gap. */
function crowds(a: Positioned, aw: number, ah: number, b: Positioned, bw: number, bh: number): boolean {
  return a.x < b.x + bw + NODE_SEP && a.x + aw + NODE_SEP > b.x && a.y < b.y + bh + NODE_SEP && a.y + ah + NODE_SEP > b.y;
}

/**
 * The last pass, over EVERY node: whole pixels, and no two cards closer than `NODE_SEP`.
 *
 * ⚠ **A saved row is a position, not a size.** A card pinned by a drag keeps growing as its ports are filled in (a chat build
 * binds them turn by turn), so rows that were clear when saved come to overlap — the reported stack of cards. Only what is
 * CURRENTLY drawn decides a clash, so it is resolved here, at render, from today's heights: saved rows settle first (in graph
 * order), then the rest; a node that crowds one already settled moves straight down past it. A node that crowds nothing never
 * moves, so a drag still moves only the card it names. Bounded, like every nudge in a render path.
 *
 * Whole pixels because the positions API stores integers and dagre reports centres — a half-height card lands on `.5`, and the
 * whole picture is pinned on the first drag (I-318).
 */
function separate(nodes: CanvasNode[], ps: Positioned[], savedIds: Set<string>): Positioned[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = [...ps].sort((a, b) => Number(savedIds.has(b.id)) - Number(savedIds.has(a.id)));
  const settled: Array<{ p: Positioned; w: number; h: number }> = [];
  const out = new Map<string, Positioned>();
  for (const raw of order) {
    const n = byId.get(raw.id);
    const w = widthFor(n ?? { id: raw.id });
    const h = n ? heightFor(n) : NODE_H;
    const p = { id: raw.id, x: Math.round(raw.x), y: Math.round(raw.y) };
    for (let guard = 0; guard < 64; guard += 1) {
      const hit = settled.find((o) => crowds(p, w, h, o.p, o.w, o.h));
      if (!hit) break;
      p.y = hit.p.y + hit.h + NODE_SEP;
    }
    settled.push({ p, w, h });
    out.set(p.id, p);
  }
  return ps.map((p) => out.get(p.id)!);
}

/**
 * Where a dropped card actually lands: the drop point, nudged down until its
 * box is free. Bounded like the pass-3 guard — an unbounded nudge in a commit
 * path is a hang, not a layout.
 *
 * ⚠ **Two nodes NEVER overlap, and a drag NEVER moves another node.** The
 * caller pins the whole current picture first (every visible node gets a row
 * from where it already is), so pass 3 has nothing to re-place — and the one
 * row this names is the clash-free spot, not the raw pointer.
 */
export function dropSpot(
  nodes: Array<
    SizingNode & {
      id: string;
      label?: string | null;
      ref?: string | null;
      boundary?: unknown;
      meta?: string | null;
      facts?: Array<{ label: string; value: string }> | null;
    }
  >,
  rows: Map<string, { x: number; y: number }>,
  id: string,
  x: number,
  y: number,
): { x: number; y: number } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const me = byId.get(id);
  const w = widthFor(me ?? { id });
  const h = me ? heightFor(me) : NODE_H;
  let ny = y;
  for (let guard = 0; guard < 64; guard += 1) {
    const clash = [...rows].some(([oid, p]) => {
      if (oid === id) return false;
      const other = byId.get(oid);
      const ow = widthFor(other ?? { id: oid });
      const oh = other ? heightFor(other) : NODE_H;
      return crowds({ id, x, y: ny }, w, h, { id: oid, x: p.x, y: p.y }, ow, oh);
    });
    if (!clash) break;
    ny += h + NODE_SEP;
  }
  return { x: Math.round(x), y: Math.round(ny) };
}

/** The dagre answer — what every unarranged graph gets. */
function dagreLayout(nodes: CanvasNode[], edges: CanvasEdge[], frames?: CanvasFrame[] | null): Positioned[] {
  // A loop's box (phase F) is a dagre CLUSTER, so the layout keeps every step that is not inside a loop outside its box — the
  // frame drawn around the members could otherwise enclose a step that runs once, which reads as running per item.
  const boxed = (frames ?? []).filter((f) => f.members.length);
  const g = new dagre.graphlib.Graph(boxed.length ? { compound: true } : undefined);
  g.setGraph({ rankdir: "LR", nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: widthFor(n), height: heightFor(n) });
  for (const f of boxed) {
    const cluster = `${FRAME_PREFIX}${f.id}`;
    g.setNode(cluster, { paddingTop: FRAME_HEAD + FRAME_PAD, paddingBottom: FRAME_PAD, paddingLeft: FRAME_PAD, paddingRight: FRAME_PAD });
    for (const m of f.members) if (g.hasNode(m)) g.setParent(m, cluster);
  }
  for (const e of edges) {
    // dagre throws on an edge naming a node it does not have. The model adapters
    // already drop dangling edges; this is the second belt, because a layout
    // crash takes the whole page down and the thing it would be protecting
    // against is a malformed model — exactly when someone most needs to see it.
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  // dagre reports centres; React Flow positions by top-left.
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { id: n.id, x: (p?.x ?? 0) - widthFor(n) / 2, y: (p?.y ?? 0) - heightFor(n) / 2 };
  });
}

/**
 * The save-time reconciliation (D-150(b/c)): rows for steps that no longer
 * exist are DROPPED. Called when building a PUT payload — the server stores
 * exactly what it is given, so this is where the mirror stays honest.
 *
 * Rename re-keying (D-150(c)) is NOT here: a rename IS `replaceStep` with a new
 * id, and only the session that ran the op knows old-id → new-id. It is applied
 * at the edit site (`rekeyPosition` below), before this ever runs.
 */
export function dropOrphaned(positions: Map<string, SavedPosition>, stepIds: Set<string>): Map<string, SavedPosition> {
  const out = new Map(positions);
  for (const id of positions.keys()) {
    if (!stepIds.has(id)) out.delete(id);
  }
  return out;
}

/**
 * Re-key one row old-id → new-id, coordinates untouched — the rename rule,
 * D-150(c). `replaceStep(flow, from, next)` with `next.id !== from` renames a
 * step, so its saved row must travel with the id or "a freshly renamed step
 * keeps its place" (the phase's browser row) fails.
 *
 * ⚠ A rename onto an id that already has a row (refused by `replaceStep`
 * itself, belt-and-braces here) DROPS the newcomer: "existing" was already
 * placed, and the step that now owns that id keeps the place it always had.
 */
export function rekeyPosition(
  positions: Map<string, SavedPosition>,
  from: string,
  to: string,
): Map<string, SavedPosition> {
  if (from === to) return positions;
  const row = positions.get(from);
  if (!row) return positions;
  const out = new Map(positions);
  out.delete(from);
  if (!out.has(to)) out.set(to, row);
  return out;
}
