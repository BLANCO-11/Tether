import { describe, expect, it } from "vitest";
import {
  dropOrphaned,
  dropSpot,
  layout,
  rekeyPosition,
  MARGIN,
  MAX_CARD_ROWS,
  MAX_NODE_H,
  MAX_NODE_W,
  NODE_H,
  NODE_SEP,
  NODE_W,
  PORT_ROW,
  RANK_SEP,
  heightFor,
  inletTop,
  inputRowTop,
  keyRows,
  portTop,
  shownInputRows,
  widthFor,
  type Positioned,
  type SavedPosition,
} from "@/lib/canvas-layout";
describe("dropSpot — a drag moves one node and never overlaps", () => {
  const box = (x: number, y: number, w = NODE_W, h = NODE_H) => ({ x, y, w, h });
  const free = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

  it("a free drop lands where pointed", () => {
    const rows = new Map([["a", { x: 0, y: 0 }]]);
    expect(dropSpot([{ id: "a" }, { id: "b" }], rows, "b", 500, 500)).toEqual({ x: 500, y: 500 });
  });

  it("a drop onto another card slides down until the boxes are free", () => {
    const rows = new Map([["a", { x: 0, y: 0 }]]);
    const spot = dropSpot([{ id: "a" }, { id: "b" }], rows, "b", 10, 10);
    expect(spot.x).toBe(10);
    expect(spot.y).toBeGreaterThan(10);
    expect(free(box(spot.x, spot.y), box(0, 0))).toBe(true);
  });

  it("re-dropping where it already sits is a no-op", () => {
    const rows = new Map([["a", { x: 0, y: 0 }], ["b", { x: 500, y: 500 }]]);
    expect(dropSpot([{ id: "a" }, { id: "b" }], rows, "b", 500, 500)).toEqual({ x: 500, y: 500 });
  });
});
import type { CanvasNode, FieldPort } from "@/lib/canvas-model";

/**
 * Phase 2 — the saved arrangement (plan decision ②, D-150).
 *
 * The organising rule: a flow model has no coordinates, but a FLOW may carry a
 * saved arrangement outside the model and the revision. Three behaviours are
 * pinned here:
 *
 *   1. Rows win — a step with a saved row sits exactly where the row says.
 *   2. The fallback stays dagre — a graph with no rows is laid out exactly as
 *      it always was (this is the "a drag must not change what an unarranged
 *      flow looks like" property).
 *   3. Reconciliation — deleted steps' rows are dropped (b); a rename re-keys
 *      the row so the step keeps its place (c).
 */
function node(id: string): CanvasNode {
  return {
    id,
    kind: "tool",
    label: id,
    ref: "q",
    platform: false,
  } as CanvasNode;
}

const THREE: CanvasNode[] = [node("a"), node("b"), node("c")];
const CHAIN = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
];

function pos(ps: Positioned[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(ps.map((p) => [p.id, { x: p.x, y: p.y }]));
}

describe("saved positions override dagre", () => {
  it("a step with a row sits exactly where the row says, whatever dagre would do", () => {
    const saved = new Map<string, SavedPosition>([
      ["b", { x: 5000, y: 3000 }],
    ]);
    const ps = pos(layout(THREE, CHAIN, saved));
    expect(ps.b).toEqual({ x: 5000, y: 3000 });
  });
  it("one saved row leaves every other node exactly where dagre put it (2026-09-03)", () => {
    // THE REPORTED BUG: dragging the first node in a flow re-placed every
    // other node, because one saved row abandoned dagre entirely and every
    // unsaved node fell to nearest-neighbour. The base layer is dagre's
    // picture; a saved row moves one node, never the rest.
    const bare = pos(layout(THREE, CHAIN));
    const saved = new Map<string, SavedPosition>([["b", { x: 5000, y: 3000 }]]);
    const ps = pos(layout(THREE, CHAIN, saved));
    expect(ps.b).toEqual({ x: 5000, y: 3000 });
    expect(ps.a).toEqual(bare.a);
    expect(ps.c).toEqual(bare.c);
  });


  it("with NO rows the graph is dagre's — an unarranged flow looks exactly as before", () => {
    const plain = pos(layout(THREE, CHAIN));
    const withEmpty = pos(layout(THREE, CHAIN, new Map()));
    expect(withEmpty).toEqual(plain);
    // And it is the real dagre geometry, not a coincidence: the chain is LR,
    // spaced by the exported constants.
    expect(plain.b.x).toBeGreaterThan(plain.a.x);
    expect(plain.c.x).toBeGreaterThan(plain.b.x);
    expect(plain.b.x - plain.a.x).toBe(NODE_W + RANK_SEP);
  });

  it("an unplaced step keeps the dagre spot dagre would give it when NO rows exist", () => {
    // The fallback path is unchanged: every node derives from dagre.
    const plain = layout(THREE, CHAIN);
    for (const n of plain) {
      expect(n.x).toBeGreaterThanOrEqual(MARGIN - NODE_W / 2);
      expect(n.y).toBeGreaterThanOrEqual(MARGIN - NODE_H / 2);
    }
  });
});

describe("nearest-neighbour placement (D-150(d))", () => {
  it("a step beside a saved neighbour keeps its dagre spot (narrowed 2026-09-03)", () => {
    // "b" is hand-placed; "a" and "c" neighbour it but have no rows. The old
    // midpoint-plus-offset snapping moved them to b's row — the cliff that
    // re-placed the graph on the first drag. Now they keep dagre's spots, and
    // the chain's dagre adjacency survives the overlay untouched.
    const bare = pos(layout(THREE, CHAIN));
    const saved = new Map<string, SavedPosition>([["b", { x: 1000, y: 1000 }]]);
    const ps = pos(layout(THREE, CHAIN, saved));
    expect(ps.b).toEqual({ x: 1000, y: 1000 });
    expect(ps.a).toEqual(bare.a);
    expect(ps.c).toEqual(bare.c);
    expect(ps.c.x - ps.a.x).toBe(2 * (NODE_W + RANK_SEP));
  });

  /**
   * ⚠ **THIS TEST NAMED THE PROPERTY AND ASSERTED THE OPPOSITE OF IT.**
   *
   * Its title said *"so they never stack"* and its body required successive
   * adds to be exactly `NODE_SEP` apart — 26 pixels, on a card `NODE_H` = 76
   * tall. It passed for months over a layout that overlapped every pass-3 node
   * with the one before it by 50 pixels, reported from use as *"when nodes
   * increase they get messy and overlap"*.
   *
   * ⚠ **The lesson is the assertion, not the arithmetic.** A step of `NODE_SEP`
   * is a plausible-looking constant and it is the wrong quantity: 26 is the gap
   * BETWEEN two cards, and the distance from one card's top to the next card's
   * top is the card plus the gap. Asserting the PROPERTY — no two cards
   * overlap — cannot be satisfied by the wrong constant, and does not have to
   * be rewritten the next time the spacing changes.
   */
  const overlaps = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    w = NODE_W,
  ) => a.x < b.x + w && a.x + w > b.x && a.y < b.y + NODE_H && a.y + NODE_H > b.y;

  it("successive unplaced adds cascade downward so they never stack", () => {
    // Anchor is arranged but shares no edges with the adds: x, y and z have
    // no saved neighbour, so all three take the narrowed pass-3 placement.
    const all = [node("anchor"), node("x"), node("y"), node("z")];
    const saved = new Map<string, SavedPosition>([["anchor", { x: 100, y: 100 }]]);
    const ps = pos(layout(all, [], saved));
    expect(ps.anchor).toEqual({ x: 100, y: 100 });
    // The property, over every pair — including the anchor, which the old
    // version never compared against at all.
    const all4 = [ps.anchor, ps.x, ps.y, ps.z];
    for (let i = 0; i < all4.length; i += 1) {
      for (let j = i + 1; j < all4.length; j += 1) {
        expect(overlaps(all4[i]!, all4[j]!), `${i} vs ${j}`).toBe(false);
      }
    }
    // And they still cascade in order rather than scattering.
    expect(ps.x.y).toBeLessThan(ps.y.y);
    expect(ps.y.y).toBeLessThan(ps.z.y);
  });

  it("a connected add with no saved neighbour lands beside its placed kin", () => {
    // s is arranged but edgeless; a→b share no edges with it. a takes the
    // isolated branch, b takes the midpoint branch off a — one card right and
    // clear of it. This is the pass-3 branch the narrowing kept.
    const all = [node("s"), node("a"), node("b")];
    const edges = [{ source: "a", target: "b" }];
    const saved = new Map<string, SavedPosition>([["s", { x: 100, y: 100 }]]);
    const ps = pos(layout(all, edges, saved));
    // ⚠ `heightFor(node)`, not `NODE_H`: the fixture carries a `ref` and no
    // status, so its card renders a ref line and a kind row and is taller than
    // the base. Writing `NODE_H` here would pin the arithmetic to a card this
    // test does not actually draw.
    expect(ps.a).toEqual({ x: 100, y: 100 + heightFor(node("a")) + NODE_SEP });
    // To the right of its kin, clear of the card rather than a fixed constant.
    expect(ps.b.x).toBeGreaterThanOrEqual(ps.a.x + NODE_W);
    expect(overlaps(ps.a, ps.b)).toBe(false);
    expect(overlaps(ps.s, ps.b)).toBe(false);
  });


  it("an isolated step spawns below the lowest placed node", () => {
    const all = [node("alone"), node("a"), node("b")];
    const edges = [{ source: "a", target: "b" }];
    const saved = new Map<string, SavedPosition>([
      ["a", { x: 100, y: 100 }],
      ["b", { x: 400, y: 100 }],
    ]);
    const ps = pos(layout(all, edges, saved));
    // "alone" has no edges → must be BELOW the lowest placed node (a or b,
    // both at y=100 → bottom edge at 100 + that card's own height), x near the
    // flow's mean. The height is `heightFor` and not `NODE_H`: these fixtures
    // carry a `ref` and no status, so their cards render more rows than the
    // base holds.
    const bottom = 100 + heightFor(node("a"));
    expect(ps.alone.y).toBeGreaterThanOrEqual(bottom);
    expect(ps.alone.y - bottom).toBeLessThanOrEqual(NODE_SEP);
    expect(ps.alone.x).toBeGreaterThanOrEqual(100);
    expect(ps.alone.x).toBeLessThanOrEqual(400);
  });
});

describe("reconciliation (D-150)", () => {
  it("drops rows for deleted steps — the mirror never keeps a corpse", () => {
    const rows = new Map<string, SavedPosition>([
      ["alive", { x: 1, y: 2 }],
      ["gone", { x: 3, y: 4 }],
    ]);
    const reconciled = dropOrphaned(rows, new Set(["alive"]));
    expect([...reconciled.keys()]).toEqual(["alive"]);
    expect(reconciled.get("alive")).toEqual({ x: 1, y: 2 });
  });

  it("re-keys a renamed step's row — 'a freshly renamed step keeps its place'", () => {
    const rows = new Map<string, SavedPosition>([
      ["old_name", { x: 77, y: 88 }],
    ]);
    const rekeyed = rekeyPosition(rows, "old_name", "new_name");
    expect(rekeyed.get("new_name")).toEqual({ x: 77, y: 88 });
    expect(rekeyed.has("old_name")).toBe(false);
  });

  it("a no-op rename leaves the map untouched (same reference)", () => {
    const rows = new Map([["same", { x: 1, y: 2 }]]);
    expect(rekeyPosition(rows, "same", "same")).toBe(rows);
  });

  it("a rename onto an id that already has a row does not double-write", () => {
    const rows = new Map<string, SavedPosition>([
      ["from", { x: 1, y: 1 }],
      ["existing", { x: 9, y: 9 }],
    ]);
    const rekeyed = rekeyPosition(rows, "from", "existing");
    expect(rekeyed.get("existing")).toEqual({ x: 9, y: 9 });
    expect(rekeyed.has("from")).toBe(false);
  });
});


/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REPORTED FROM USE — "when nodes increase they get messy and overlap"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two separate defects arrived in one sentence and they are tested separately,
 * because fixing either one alone still looks broken:
 *
 *   the MESS    pass 3 staggered by NODE_SEP (26) on a card NODE_H (76) tall,
 *               and never checked whether the spot it computed was occupied
 *   the NAMES   a fixed 232px card with `truncate`, so any real step name was
 *               an ellipsis on the surface whose job is reading a flow
 *
 * ⚠ The first bit only a graph with a SAVED arrangement — pass 3 is the
 * remainder after saved rows and their neighbours — which is why the demo
 * flows looked fine and a flow somebody had actually dragged did not.
 */
describe("no two cards overlap, at any size", () => {
  const boxes = (ps: Positioned[], nodes: CanvasNode[]) =>
    ps.map((p) => ({ ...p, w: widthFor(nodes.find((n) => n.id === p.id)!) }));

  const anyOverlap = (bs: Array<{ id: string; x: number; y: number; w: number }>) => {
    for (let i = 0; i < bs.length; i += 1) {
      for (let j = i + 1; j < bs.length; j += 1) {
        const a = bs[i]!;
        const b = bs[j]!;
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + NODE_H && a.y + NODE_H > b.y) {
          return `${a.id} overlaps ${b.id}`;
        }
      }
    }
    return null;
  };

  it("twelve unconnected adds around one saved row", () => {
    // The reported shape: a flow that has been arranged, then grown. Twelve is
    // past the point the old stagger turned into a solid stack.
    const nodes = [node("anchor"), ...Array.from({ length: 12 }, (_, i) => node(`step_${i}`))];
    const saved = new Map<string, SavedPosition>([["anchor", { x: 300, y: 200 }]]);
    expect(anyOverlap(boxes(layout(nodes, [], saved), nodes))).toBeNull();
  });

  it("a chain grown off a saved row", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => node(`s${i}`));
    const edges = nodes.slice(1).map((n, i) => ({ source: `s${i}`, target: n.id }));
    const saved = new Map<string, SavedPosition>([["s0", { x: 0, y: 0 }]]);
    expect(anyOverlap(boxes(layout(nodes, edges, saved), nodes))).toBeNull();
  });

  it("long names, which are wider and therefore easier to collide", () => {
    // The two fixes interact: wider cards make the old stagger worse, so this
    // is the case that must hold for both of them at once.
    const nodes = [
      node("anchor"),
      ...Array.from({ length: 8 }, (_, i) =>
        ({ ...node(`s${i}`), label: `Chase the tickets that missed their target ${i}` }) as CanvasNode,
      ),
    ];
    const saved = new Map<string, SavedPosition>([["anchor", { x: 0, y: 0 }]]);
    expect(anyOverlap(boxes(layout(nodes, [], saved), nodes))).toBeNull();
  });

  it("the unarranged (dagre) path too — the control", () => {
    // dagre has always spaced correctly, and this asserts the per-node widths
    // reached it: handing dagre a fixed NODE_W while drawing a 384px card is
    // exactly how a correct layout engine produces overlapping pictures.
    // ⚠ UNIFORMLY long. The first version alternated short and long names and
    // PASSED with dagre handed a fixed `NODE_W` — a 232-wide gap happens to
    // clear a 346-wide card when its neighbours are 232. A control that cannot
    // fail is worse than none (I-38); found by perturbation.
    // ⚠ Long enough to reach `MAX_NODE_W`. At 346px the excess a wrong
    // centre-to-top-left conversion produces (57px) still fits inside
    // `RANK_SEP`, so the test passed with that bug present. At the ceiling it
    // does not. Second perturbation finding in this describe.
    const nodes = Array.from({ length: 8 }, (_, i) =>
      ({ ...node(`s${i}`), label: `a genuinely long step name, indeed a very long one, number ${i}` }) as CanvasNode,
    );
    const edges = nodes.slice(1).map((n, i) => ({ source: `s${i}`, target: n.id }));
    expect(anyOverlap(boxes(layout(nodes, edges), nodes))).toBeNull();
  });
});

describe("widthFor — the card grows with its name and then stops", () => {
  it("a short name gets the minimum, never less", () => {
    expect(widthFor({ id: "a" })).toBe(NODE_W);
    expect(widthFor({ id: "fetch" })).toBe(NODE_W);
  });

  it("a long name gets a wider card", () => {
    const w = widthFor({ id: "chase_tickets_that_missed_their_target" });
    expect(w).toBeGreaterThan(NODE_W);
    expect(w).toBeLessThanOrEqual(MAX_NODE_W);
  });

  it("stops at the ceiling — dagre spaces ranks by the widest node in them", () => {
    // Without a ceiling one pathological step id pushes every other column off
    // the screen, which is the same complaint from the other direction.
    expect(widthFor({ id: "x".repeat(500) })).toBe(MAX_NODE_W);
  });

  it("reads the LABEL when there is one, because that is what is drawn", () => {
    const long = "a name long enough to need more than the minimum width";
    expect(widthFor({ id: "s", label: long })).toBe(widthFor({ id: long }));
    // And the id when there is not — an outline node has no label yet.
    expect(widthFor({ id: long, label: null })).toBeGreaterThan(NODE_W);
  });
  it("a boundary sizes to its declaration rows, a step does not", () => {
    // The Start card draws meta + facts; "Start" alone would truncate them.
    const facts = [{ label: "timer", value: "none — nothing runs this on a schedule" }];
    const boundary = { id: "start", label: "Start", boundary: "start", meta: "Manual only · 2 inputs", facts };
    expect(widthFor(boundary)).toBeGreaterThan(NODE_W);
    // The same facts on a step card buy no width — steps draw neither row.
    expect(widthFor({ id: "s", label: "Start", meta: boundary.meta, facts })).toBe(NODE_W);
  });
  it("a boundary GROWS TALL for its content — the scrollbar/truncation this fixes", () => {
    // Two facts, one of which wraps at the card's own width — the exact
    // shape that used to need a scrollbar to read.
    const start = {
      id: "__start__",
      label: "Start",
      boundary: "start",
      meta: "Manual only · 1 input",
      facts: [
        { label: "timer", value: "none — nothing runs this on a schedule" },
        { label: "from_date", value: "date · required · no default — a scheduled run cannot supply it" },
      ],
    };
    expect(heightFor(start)).toBeGreaterThan(NODE_H);
    // A step card with the same facts does not grow — steps draw neither
    // meta nor facts, so its height stays exactly what ports/arms declare.
    expect(heightFor({ id: "s", label: "Start", meta: start.meta, facts: start.facts })).toBe(NODE_H);
    // ⚠ NOT clamped at MAX_NODE_H — a boundary is the only node in its rank
    // (one Start, one End per graph), so a long fact keeps growing the card
    // rather than clipping it. A pathological fact must still grow past the
    // ceiling that bounds an ordinary step card.
    const huge = { ...start, facts: [{ label: "note", value: "x ".repeat(400) }] };
    expect(heightFor(huge)).toBeGreaterThan(MAX_NODE_H);
  });
  it("a ref widens the card — the pill draws it", () => {
    expect(widthFor({ id: "overdue", ref: "finance_demo.invoices_overdue" })).toBeGreaterThan(
      widthFor({ id: "overdue" }),
    );
  });
});


/**
 * ⚠ **THE STAGGER AND THE COLLISION NUDGE ARE REDUNDANT, AND SAYING SO IS THE
 * POINT.** Reverting either one alone leaves the "no two cards overlap"
 * assertions above green, because each is sufficient on its own — measured by
 * perturbation, not assumed.
 *
 * That is a good state to be in and a bad state to leave untested: the nudge is
 * BOUNDED at 64 iterations, and the bound exists because an unbounded loop in a
 * render path takes the page down. The stagger is what keeps the first guess
 * right so the nudge normally does nothing; without it the nudge does the work
 * every time and the bound stops being slack.
 *
 * So this pins the first guess EXACTLY. A wrong stagger still produces a
 * non-overlapping picture (the nudge repairs it) at different coordinates, so
 * exact positions discriminate where the property alone does not.
 */
/**
 * ⚠ **TWO THINGS IN THIS CHANGE ARE NOT COVERED, AND THE HONEST RECORD IS HERE
 * RATHER THAN AN ASSERTION THAT LOOKS LIKE ONE.** Both were perturbed and both
 * stayed green:
 *
 *  1. **The collision nudge.** Reverting it leaves every overlap assertion
 *     above passing, because the stagger alone is sufficient for every case
 *     these tests build. It is a backstop against a SAVED row sitting where
 *     pass 3 computes — which a person creates by dragging, not by adding — and
 *     no fixture here reproduces that. It stays because the situation is real;
 *     it is not claimed to be tested.
 *
 *  2. **The dagre centre-to-top-left conversion using `widthFor` rather than
 *     `NODE_W`.** Getting it wrong shifts every card right by the same amount,
 *     so no two cards overlap at any width — verified up to `MAX_NODE_W`. What
 *     it actually breaks is where an EDGE attaches, and jsdom performs no
 *     layout, so no client test can assert on edges at all (I-66's own note).
 *
 * Writing "covered" over either of these would be worse than leaving them
 * uncovered, because the next person would stop looking.
 */
describe("the first guess is already clear, so the nudge is slack and not the mechanism", () => {
  it("isolated adds step down by a whole card plus the gap", () => {
    const all = [node("anchor"), node("x"), node("y"), node("z")];
    const saved = new Map<string, SavedPosition>([["anchor", { x: 100, y: 100 }]]);
    const ps = pos(layout(all, [], saved));
    const step = heightFor(node("x")) + NODE_SEP;
    // Not `NODE_SEP`, which is the gap BETWEEN cards. The distance from one
    // card's top to the next card's top is the card plus the gap — the
    // arithmetic the original bug got wrong.
    expect(ps.x.y).toBe(100 + step);
    expect(ps.y.y).toBe(ps.x.y + step);
    expect(ps.z.y).toBe(ps.y.y + step);
  });
});


/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REPORTED FROM USE — "if there are multiple inputs/outputs the height should
 * also grow"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It should, and three comments in `FlowCanvas` said it must not: *"the card is
 * NOT allowed to grow for them, and that is I-66 … a long chain crowds rather
 * than resizes."* That reads I-66 too broadly. Its rule is that the DECLARED
 * size, dagre's spacing and the drawn card must AGREE — when they do not,
 * `parseHandles` discards the handle bounds and every edge unmounts. Crowding
 * kept them agreeing by never moving; `heightFor` keeps them agreeing by moving
 * all three together.
 *
 * Handles sit at fractional offsets of the card's height, so at a fixed 76px a
 * fifth port lands 12px from its neighbour and the `text-micro` labels collide.
 */
/**
 * ⚠ These tests are about the COUNT of ports and nothing else — `portRows`
 * reads `.length`. `FieldPort` carries binding state for the CARD's benefit;
 * naming that state here would tie a geometry test to a rendering decision.
 */
const fp = (...names: string[]): FieldPort[] => names.map((name) => ({ name, source: { kind: "unset" } }));
const fpN = (n: number): FieldPort[] => fp(...Array.from({ length: n }, (_, i) => `f${i}`));

describe("heightFor — the card grows for params (capped), arms and outputs", () => {
  it("zero ports stay at the base; params buy rows up to the cap", () => {
    // Dify parity: the card names its key config, so params buy rows again —
    // but at most MAX_CARD_ROWS of them. Past the cap the last row is
    // "+N more" and the card stops.
    expect(heightFor({})).toBe(NODE_H);
    const one = heightFor({ inputHandles: fp("a") });
    expect(one).toBeGreaterThan(NODE_H);
    expect(heightFor({ inputHandles: fp("a", "b") })).toBeGreaterThan(one);
    expect(heightFor({ inputHandles: fpN(6) })).toBe(heightFor({ inputHandles: fpN(4) }));
    expect(heightFor({ inputHandles: fpN(9) })).toBe(heightFor({ inputHandles: fpN(4) }));
    const out1 = heightFor({ outputHandles: [{ id: "a", label: "a" }] });
    expect(out1).toBeGreaterThan(NODE_H);
    expect(heightFor({ outputHandles: [{ id: "a", label: "a" }, { id: "b", label: "b" }] })).toBeGreaterThan(out1);
  });

  it("output rows grow it monotonically", () => {
    const o2 = [{ id: "a", label: "a" }, { id: "b", label: "b" }];
    const o3 = [...o2, { id: "c", label: "c" }];
    expect(heightFor({ outputHandles: o3 })).toBeGreaterThan(heightFor({ outputHandles: o2 }));
  });

  it("a chain of arms grows it", () => {
    expect(heightFor({ arms: [1, 2, 3].map((i) => ({ id: `a${i}`, label: `arm ${i}` })) }))
      .toBeGreaterThan(NODE_H);
    // One arm draws the plain unnamed handle and costs no row — the guard is
    // load-bearing now that every other row grows the card (it survived the
    // free-rows era as documentation when it was unreachable either way).
    expect(heightFor({ arms: [{ id: "a", label: "if" }] })).toBe(NODE_H);
  });

  it("takes the BUSIEST side, not the sum", () => {
    // Arms and outputs share the right edge and params the left; every side
    // draws on the same row grid, so a card with three in and three out
    // needs the room for three, not six — and not nine.
    const three = ["a", "b", "c"];
    const outs = three.map((id) => ({ id, label: id }));
    const both = heightFor({
      inputHandles: fp(...three),
      outputHandles: outs,
    });
    expect(both).toBe(heightFor({ outputHandles: outs }));
  });

  it("stops at the ceiling — dagre's nodesep is the VERTICAL gap in an LR graph", () => {
    // An uncapped card pushes every sibling in its rank apart, so one
    // eight-armed branch would make the whole graph unfittable. Param rows
    // are capped, so forty params never reach the ceiling — but an eight-armed
    // branch still does, which is where the ceiling engages now.
    expect(heightFor({ inputHandles: fpN(40) })).toBeLessThanOrEqual(MAX_NODE_H);
    expect(heightFor({ arms: fpN(8).map((f) => ({ id: f.name, label: f.name })) })).toBe(MAX_NODE_H);
  });

  it("a whole-object feed buys the inlet row and trims a param row, never growing past the cap", () => {
    // A 6-param whole-fed tool draws the inlet + 3 params + "+N more" — the
    // same 4 rows as a 6-param per-field card, so the ceiling holds.
    const whole = { inputHandles: fpN(6), wholeFrom: "route" };
    expect(keyRows(whole)).toBe(MAX_CARD_ROWS);
    expect(shownInputRows(whole)).toBe(MAX_CARD_ROWS - 2);
    expect(heightFor(whole)).toBe(heightFor({ inputHandles: fpN(6) }));
    expect(heightFor(whole)).toBeLessThanOrEqual(MAX_NODE_H);
    // Below the cap the inlet is one more drawn row.
    expect(keyRows({ inputHandles: fpN(2), wholeFrom: "route" })).toBe(3);
    expect(shownInputRows({ inputHandles: fpN(2), wholeFrom: "route" })).toBe(2);
  });

  it("per-field dots sit one row lower when the inlet takes row 0", () => {
    const whole = { inputHandles: fpN(2), wholeFrom: "route" };
    expect(inletTop(whole)).toBe(portTop(whole, 0));
    expect(inputRowTop(whole, 0) - inletTop(whole)).toBe(PORT_ROW);
    // Without an inlet the dots sit on the same grid as the rows.
    const plain = { inputHandles: fpN(2) };
    expect(inputRowTop(plain, 0)).toBe(portTop(plain, 0));
  });
});

describe("a tall card is spaced as a tall card", () => {
  const wide = (id: string, ports: number): CanvasNode =>
    ({ ...node(id), outputHandles: fpN(ports).map((f) => ({ id: f.name, label: f.name })) }) as CanvasNode;

  const anyOverlapMixed = (ps: Positioned[], nodes: CanvasNode[]) => {
    const bs = ps.map((p) => {
      const n = nodes.find((x) => x.id === p.id)!;
      return { ...p, w: widthFor(n), h: heightFor(n) };
    });
    for (let i = 0; i < bs.length; i += 1) {
      for (let j = i + 1; j < bs.length; j += 1) {
        const a = bs[i]!;
        const b = bs[j]!;
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
          return `${a.id} overlaps ${b.id}`;
        }
      }
    }
    return null;
  };

  it("dagre gets the real height, so tall siblings do not collide", () => {
    // Two tall cards in the same rank is the case that fails if dagre is handed
    // NODE_H: they are laid out 76 apart and drawn 208 tall.
    const nodes = [node("head"), wide("a", 8), wide("b", 8), wide("c", 8)];
    const edges = [
      { source: "head", target: "a" },
      { source: "head", target: "b" },
      { source: "head", target: "c" },
    ];
    expect(anyOverlapMixed(layout(nodes, edges), nodes)).toBeNull();
  });

  it("and the arranged path staggers by the card that is actually there", () => {
    const nodes = [node("anchor"), wide("x", 8), wide("y", 8), wide("z", 8)];
    const saved = new Map<string, SavedPosition>([["anchor", { x: 0, y: 0 }]]);
    expect(anyOverlapMixed(layout(nodes, [], saved), nodes)).toBeNull();
  });
});


/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REPORTED FROM USE, WITH A SCREENSHOT — the BODY was clipped, not the ports
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     warn_shape          warn
 *     transform           tool call
 *     TRANSFORM           mail_send_template
 *     ONLY WHEN if ←cut   TOOL CALL ←cut
 *
 * The card is `overflow-hidden` — it has to be, for the rounded corners — so a
 * body taller than the declared height does not spill, it **disappears**. The
 * body is header text + one caption row (the pill): question, ref, flag, meta
 * and arm buy no rows, and these tests pin that. Height has three drivers —
 * capped param rows, arms and code-output fields.
 */
describe("the fixed body fits inside the card", () => {
  const card = (over: Partial<CanvasNode>): CanvasNode =>
    ({ id: "s", kind: "tool", label: "s", platform: false, ...over }) as CanvasNode;

  it("the plainest card still fits the base height", () => {
    // Header text + one caption row, which every card draws. If this ever
    // exceeds NODE_H then NODE_H is wrong, not the node.
    expect(heightFor(card({ ref: null }))).toBe(NODE_H);
  });

  it("a ref buys no row — it lives in the pill", () => {
    expect(heightFor(card({ ref: "mail_send_template" }))).toBe(NODE_H);
  });

  it("an arm chip buys no row either", () => {
    expect(heightFor(card({ ref: "mail_send_template", arm: { branchId: "b", armId: "b", label: "if" } }))).toBe(NODE_H);
  });

  it("a question buys no row — it reads in the panel, not on the card", () => {
    const arm = { branchId: "b", armId: "b", label: "if" };
    expect(heightFor(card({ ref: null, arm, question: "which month?" }))).toBe(NODE_H);
  });

  it("no combination of body fields buys a row", () => {
    // Ordinal, status, meta, flag, question, ref, arm — the whole second axis
    // of the old height, now fixed. Deleting any one of these from the card
    // must not move this number, because the number no longer reads them.
    const arm = { branchId: "b", armId: "b", label: "if" };
    expect(
      heightFor(card({ ref: "r", ordinal: 2, status: "success", meta: "1.2s", flag: "f", question: "q", arm })),
    ).toBe(NODE_H);
  });

  it("ports take the card past the body, never added to it", () => {
    // The body is fixed, so a card with ports needs the ports' room once.
    const outputs = fpN(6).map((f) => ({ id: f.name, label: f.name }));
    const portsOnly = heightFor(card({ ref: null, outputHandles: outputs }));
    expect(portsOnly).toBeGreaterThan(NODE_H);
    expect(
      heightFor(card({ ref: "r", arm: { branchId: "b", armId: "b", label: "if" }, question: "q", outputHandles: outputs })),
    ).toBe(portsOnly);
  });
});

describe("cards pinned small and then grown keep a clear gap, in whole pixels (I-318)", () => {
  // The reported shape: a drag pins the whole picture while the cards are short; a chat build then fills their ports in and
  // they grow into each other. Rows saved NODE_H + NODE_SEP apart, then each card given four params.
  const grown = (id: string) => ({ ...node(id), inputHandles: fpN(4) }) as CanvasNode;
  const ids = ["a", "b", "c"];
  const saved = new Map<string, SavedPosition>(ids.map((id, i) => [id, { x: 100, y: i * (NODE_H + NODE_SEP) }]));

  it("no two grown cards are closer than NODE_SEP", () => {
    const nodes = ids.map(grown);
    const ps = layout(nodes, [], saved);
    const h = heightFor(nodes[0]!);
    expect(h).toBeGreaterThan(NODE_H + NODE_SEP); // the control: these rows DO collide as saved
    const ys = ps.map((p) => p.y).sort((x, y) => x - y);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(h + NODE_SEP);
  });

  it("a saved row that crowds nothing stays exactly where it was saved", () => {
    const ps = layout(ids.map(node), [], saved);
    expect(pos(ps)).toEqual(Object.fromEntries(ids.map((id) => [id, saved.get(id)!])));
  });

  it("every position is a whole pixel — the positions API stores integers", () => {
    const nodes = [node("a"), grown("b"), { ...node("c"), label: "an odd-length name" } as CanvasNode];
    const edges = [{ source: "a", target: "b" }, { source: "a", target: "c" }];
    for (const ps of [layout(nodes, edges), layout(nodes, edges, new Map([["a", { x: 0.5, y: 3.25 }]]))]) {
      for (const p of ps) expect(Number.isInteger(p.x) && Number.isInteger(p.y), `${p.id} ${p.x},${p.y}`).toBe(true);
    }
    const spot = dropSpot(nodes, new Map(), "a", 10.4, 20.6);
    expect(spot).toEqual({ x: 10, y: 21 });
  });
});
