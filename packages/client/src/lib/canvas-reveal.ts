/**
 * The build-time choreography for the canvas (phase 4, D-247 — the user's
 * "shape being put in, links being connected, steps being spawned").
 *
 * Two jobs, both presentation only — neither changes WHAT is drawn:
 *
 * 1. **Reveal.** A stage delivers its steps together (the outline is one model
 *    reply), so newly seen nodes get a staggered entrance in reading order and a
 *    new link draws itself once both of its ends have landed. The steps are real;
 *    only their appearance is sequenced.
 * 2. **Glide.** When the layout moves — a card grew a port at the handoff, the
 *    saved arrangement arrived — node positions are TWEENED rather than jumped.
 *    React Flow computes edge paths from node positions, so edges follow the
 *    tween for free; a CSS transition on the node wrapper would leave them behind.
 *
 * ⚠ Both are opt-in per surface (`FlowCanvas`'s `reveal`/`glide`), because a
 * tween on a surface where a person drags would lag the drop.
 */
import { useLayoutEffect, useRef, useState } from "react";

/** Gap between two nodes' entrances. */
export const REVEAL_STEP_MS = 90;
/** No entrance waits longer than this, however large the batch. */
export const REVEAL_MAX_MS = 1400;
/** A link starts drawing this long after the later of its two ends. */
export const EDGE_LEAD_MS = 160;
/** How long an entrance class stays on after its delay — the animation's own length plus air. */
export const REVEAL_HOLD_MS = 700;
/** The glide's length. */
export const GLIDE_MS = 380;

export type Seen = Map<string, { delay: number; at: number }>;

type Placed = { id: string; position: { x: number; y: number } };

/**
 * Record every node not seen before, with its entrance delay. New nodes in one
 * batch are ordered by where they sit (left to right, then top to bottom), so the
 * entrance reads in the flow's direction. Mutates and returns `seen`.
 */
export function noteNodes(seen: Seen, nodes: readonly Placed[], now: number): Seen {
  const fresh = nodes
    .filter((n) => !seen.has(n.id))
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  fresh.forEach((n, i) => seen.set(n.id, { delay: Math.min(i * REVEAL_STEP_MS, REVEAL_MAX_MS), at: now }));
  return seen;
}

/**
 * Record every edge not seen before. A link between two nodes that entered in
 * THIS render waits for the later of them; a link added between nodes already on
 * screen draws at once.
 */
export function noteEdges(
  seen: Seen,
  nodesSeen: Seen,
  edges: ReadonlyArray<{ id: string; source: string; target: string }>,
  now: number,
): Seen {
  for (const e of edges) {
    if (seen.has(e.id)) continue;
    // When each end lands, measured from NOW. An end already settled lands "in
    // the past" and adds no wait; the memos that build nodes and edges may run
    // in different renders, so this never assumes they share a timestamp.
    const lands = [nodesSeen.get(e.source), nodesSeen.get(e.target)]
      .filter((x): x is { delay: number; at: number } => !!x)
      .map((x) => x.at + x.delay - now);
    const wait = lands.length ? Math.max(...lands) : -Infinity;
    const delay = wait > -EDGE_LEAD_MS ? Math.max(0, wait + EDGE_LEAD_MS) : 0;
    seen.set(e.id, { delay, at: now });
  }
  return seen;
}

/**
 * Is this element still inside its entrance? Past it, the class comes off — so a
 * node or link that RE-MOUNTS later (the edge type changes when the canvas turns
 * editable at the handoff) does not play its entrance a second time.
 */
export function entering(entry: { delay: number; at: number } | undefined, now: number): boolean {
  return !!entry && now - entry.at < entry.delay + REVEAL_HOLD_MS;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Tween node positions when the layout moves. Returns the nodes to draw this
 * frame: `nodes` itself when nothing is moving (identity preserved — I-66), an
 * interpolated copy while a glide runs.
 *
 * ⚠ A LAYOUT effect, and the first interpolated frame is set synchronously
 * inside it: with a plain effect the browser paints the target positions for one
 * frame before the tween starts, which is exactly the jump this exists to remove.
 */
export function useGlide<N extends Placed>(nodes: N[], on: boolean): N[] {
  const last = useRef(new Map<string, { x: number; y: number }>());
  const raf = useRef<number | null>(null);
  const [frame, setFrame] = useState<N[] | null>(null);

  useLayoutEffect(() => {
    const target = new Map(nodes.map((n) => [n.id, n.position]));
    const from = new Map(last.current);
    const canAnimate = on && typeof requestAnimationFrame === "function";
    const moved =
      canAnimate &&
      nodes.some((n) => {
        const f = from.get(n.id);
        return !!f && (Math.abs(f.x - n.position.x) > 0.5 || Math.abs(f.y - n.position.y) > 0.5);
      });
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!moved) {
      last.current = target;
      setFrame(null);
      return;
    }
    const at = (e: number): N[] =>
      nodes.map((n) => {
        const f = from.get(n.id);
        if (!f) return n;
        return { ...n, position: { x: f.x + (n.position.x - f.x) * e, y: f.y + (n.position.y - f.y) * e } };
      });
    setFrame(at(0));
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      const current = at(easeOut(t));
      last.current = new Map(current.map((n) => [n.id, n.position]));
      if (t < 1) {
        setFrame(current);
        raf.current = requestAnimationFrame(tick);
      } else {
        last.current = target;
        setFrame(null);
        raf.current = null;
      }
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [nodes, on]);

  return frame ?? nodes;
}
