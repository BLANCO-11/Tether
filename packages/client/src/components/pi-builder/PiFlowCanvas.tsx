"use client";

/**
 * Forge's canvas (2026-10-11): cards with named ports, links that follow the data, loops as frames.
 *
 * Layout is measured, never guessed: each card is rendered, its height read, and the columns placed with fixed gaps
 * between them — so nothing touches however many ports a card has. Links are drawn from the ports' own offsets inside
 * their card, which do not change with zoom or scroll. A link that runs outside every loop is drawn UNDER the loop
 * frames, so where it passes behind one it reads faded; a link into or out of a loop is drawn above.
 *
 * To stay readable as workflows grow: a card shows port NAMES only (where a value comes from is on hover, with its
 * link lit), one line per port and two lines of title, at most four ports a side ("+N more" opens the step).
 *
 * ⚠ 2026-10-12: zooming out SCALES the workflow, it never changes it. Below 75% a card used to collapse to its icon and
 * title, which turned the picture into a single line of boxes — the workflow's shape is the point of the canvas, so a
 * card looks the same at every zoom. And the canvas opens fitted: the whole workflow (or as near as a readable zoom
 * allows) in view, re-fitted when steps are added or removed, never when a person has only moved or zoomed.
 *
 * A card can be dragged; where it was put is kept per saved flow (flow_step_positions, outside the revision), and
 * "Tidy" puts every card back. Hovering a card lights everything upstream and downstream of it, and one glowing pulse
 * travels that path from start to finish — the same flow the compiled builder's canvas shows.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Code, Fork, Frame, Minus, Play, Plus, RefreshCw, Shield } from "@/components/ui/icons";
import { pulseTiming } from "@/components/flow/FlowCanvas";
import { connectedTo, pathDepths, type CanvasEdge } from "@/lib/canvas-model";
import { getFlowPositions, putFlowPositions } from "@/lib/api";
import type { PiWorkflow } from "@/lib/pi-builder";
import { END, START, fromWords, piCanvasModel, type CanvasPort, type PiCanvasLink, type PiCanvasModel, type PiCanvasNode, type PortRef } from "@/lib/pi-canvas";

/** An edge label's pill height, in canvas units. */
const EDGE_LABEL_H = 17;

const W = 244;
const GAP_X = 120;
const GAP_Y = 44;
const PAD = 40;
const MARGIN = 60;
const MAX_PORTS = 4;
const HEAD_MID = 26;
/** The farthest out a person (or Fit) may zoom: far enough to see a large workflow whole, near enough to read titles. */
const MIN_ZOOM = 0.25;

type Box = { x: number; y: number; w: number; h: number };
/** What the rendered cards say about themselves: heights, and where each port sits inside its card. */
type Measured = { heights: Map<string, number>; portY: Map<string, number> };
type Layout = {
  boxes: Map<string, Box>;
  frames: Map<string, Box>;
  /** `${node}|${port}` → the port's vertical middle inside its card. */
  portY: Map<string, number>;
  width: number;
  height: number;
  /**
   * How far everything was moved right/down so the leftmost and topmost thing sits at the margin. A dragged card may be
   * put ABOVE or LEFT of every other — its kept place is then negative — and the drawing grows that way instead of
   * clamping the card at the edge. Kept places are stored unshifted; the shift is applied only to draw.
   */
  shift: { x: number; y: number };
};

const ICON: Record<PiCanvasNode["kind"], (p: { className?: string }) => ReactNode> = {
  code: Code,
  approval: Shield,
  branch: Fork,
  io: Play,
};

export function PiFlowCanvas({
  workflow,
  selectedId,
  onSelect,
  flowId,
  emptyMessage = "Describe the workflow in chat — its steps appear here as Forge builds them.",
}: {
  workflow: PiWorkflow;
  /** The saved flow, when there is one: a dragged card's place is then kept. */
  flowId?: string | null;
  selectedId: string | null;
  /** `tab`: which part of the step to open — "io" when a card's "+N more" was clicked. */
  onSelect: (id: string | null, tab?: "io") => void;
  emptyMessage?: string;
}) {
  const model = useMemo(() => piCanvasModel(workflow), [workflow]);
  const [zoom, setZoom] = useState(1);
  const worldRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [hot, setHot] = useState<{ node: string; port: string; text: ReactNode; x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  // Where a person put cards. Kept per flow once it is saved; before that it lasts the session.
  const [arranged, setArranged] = useState<Map<string, { x: number; y: number }>>(new Map());
  useEffect(() => {
    if (!flowId) return;
    let live = true;
    getFlowPositions(flowId).then((m) => live && setArranged(new Map(m))).catch(() => {});
    return () => {
      live = false;
    };
  }, [flowId]);
  const keep = useCallback(
    (next: Map<string, { x: number; y: number }>) => {
      if (flowId) void putFlowPositions(flowId, [...next].map(([stepId, p]) => ({ stepId, x: p.x, y: p.y }))).catch(() => {});
    },
    [flowId],
  );

  // Measure the cards, then place them. Runs again when the workflow changes.
  useLayoutEffect(() => {
    if (worldRef.current) setMeasured(measureCards(worldRef.current));
  }, [model]);
  // Fonts landing late change heights; re-measure once they are in.
  useLayoutEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && worldRef.current && setMeasured(measureCards(worldRef.current)));
    return () => {
      live = false;
    };
  }, [model]);
  const layout = useMemo(() => (measured ? place(model, measured, arranged) : null), [model, measured, arranged]);

  // The hovered card's path: everything upstream and downstream, and how far along it each node sits.
  const edges = useMemo<CanvasEdge[]>(() => model.links.map((l) => ({ source: l.from.node, target: l.to.node }) as CanvasEdge), [model]);
  const lit = useMemo(() => (hovered ? connectedTo(hovered, edges) : null), [hovered, edges]);
  const depth = useMemo(() => (lit ? pathDepths(lit, edges) : null), [lit, edges]);
  const slots = useMemo(() => (depth ? Math.max(1, ...depth.values()) : 1), [depth]);

  // The view: a free pan (the background drags anywhere, not only where there is room to scroll) and a zoom.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [smooth, setSmooth] = useState(false);
  const view = useRef({ zoom, pan });
  view.current = { zoom, pan };
  /** Zoom to `z`, keeping the point `at` (in the canvas box) where it is — the cursor, or the box's centre. */
  const zoomTo = useCallback((z: number, at?: { x: number; y: number }, animate = true) => {
    const el = scrollRef.current;
    const next = Math.min(1.4, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
    const { zoom: was, pan: p } = view.current;
    const c = at ?? (el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 });
    setSmooth(animate);
    setZoom(next);
    setPan({ x: c.x - ((c.x - p.x) * next) / was, y: c.y - ((c.y - p.y) * next) / was });
  }, []);
  const fit = useCallback((animate = true) => {
    const el = scrollRef.current;
    if (!el || !layout) return;
    const z = Math.min(1, Math.max(MIN_ZOOM, Math.min((el.clientWidth - 48) / layout.width, (el.clientHeight - 48) / layout.height)));
    setSmooth(animate);
    setZoom(z);
    setPan({ x: Math.max(0, (el.clientWidth - layout.width * z) / 2), y: Math.max(0, (el.clientHeight - layout.height * z) / 2) });
  }, [layout]);
  // When the drawing grows up or left (a card dragged past the edge), everything in it moves down/right by the growth;
  // move the view back by the same amount so nothing appears to jump and the dragged card stays under the pointer.
  const lastShift = useRef({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!layout) return;
    const dx = layout.shift.x - lastShift.current.x;
    const dy = layout.shift.y - lastShift.current.y;
    lastShift.current = layout.shift;
    if (dx || dy) {
      setSmooth(false);
      setPan((p) => ({ x: p.x - dx * view.current.zoom, y: p.y - dy * view.current.zoom }));
    }
  }, [layout]);
  // Open fitted, and re-fit when the SET of steps changes (one added or removed) — never on a drag, a zoom or a
  // re-measure, which would snatch the view from a person mid-look.
  const shape = useMemo(() => model.nodes.map((n) => n.id).join("|"), [model]);
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!layout || fittedFor.current === shape) return;
    fit(fittedFor.current !== null);
    fittedFor.current = shape;
  }, [layout, shape, fit]);
  // Scroll pans; Ctrl/⌘ + scroll (and a trackpad pinch) zooms at the cursor. A native listener: React's is passive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomTo(view.current.zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top }, false);
      } else {
        setSmooth(false);
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo, workflow.steps?.length]);

  // Drag the background to pan, or a card to move it. A press that did not move is a click.
  const drag = useRef<{ x: number; y: number; l: number; t: number; moved: boolean; card?: string; ox?: number; oy?: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    const card = target.closest<HTMLElement>(".pic-node")?.dataset.id;
    const box = card ? layout?.boxes.get(card) : undefined;
    // `ox`/`oy` are the card's KEPT place — its drawn place less the drawing's shift.
    const sh = layout?.shift ?? { x: 0, y: 0 };
    drag.current = { x: e.clientX, y: e.clientY, l: pan.x, t: pan.y, moved: false, ...(card && box ? { card, ox: box.x - sh.x, oy: box.y - sh.y } : {}) };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    if (!d.moved) return;
    if (d.card) {
      // Anywhere — above or left of every other card too: the drawing grows that way (`Layout.shift`).
      const at = { x: Math.round(d.ox! + dx / zoom), y: Math.round(d.oy! + dy / zoom) };
      setArranged((m) => new Map(m).set(d.card!, at));
    } else {
      setSmooth(false);
      setPan({ x: d.l + dx, y: d.t + dy });
    }
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved && d.card) setArranged((m) => (keep(m), m));
    else if (!d.moved) onSelect(d.card ?? null);
  };
  const tidy = () => {
    setArranged(new Map());
    keep(new Map());
  };

  const showPort = (e: React.PointerEvent, node: PiCanvasNode, port: string, p: CanvasPort) => {
    const box = scrollRef.current!.getBoundingClientRect();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const text = p.from ? (
      <>
        From <b className="font-mono font-medium">{fromWords(p.from, model)}</b>
      </>
    ) : (
      <>
        Gives <b className="font-mono font-medium">{p.name}</b>
        {p.type ? ` · ${p.type}` : ""}
      </>
    );
    setHot({ node: node.id, port, text, x: Math.max(8, r.left - box.left), y: r.bottom - box.top + 6 });
  };

  if (!workflow.steps?.length) {
    return (
      <div className="pic-canvas grid flex-1 place-items-center">
        <p className="max-w-xs text-center text-sm text-muted">{emptyMessage}</p>
      </div>
    );
  }

  const flow = (l: PiCanvasLink) =>
    lit && lit.has(l.from.node) && lit.has(l.to.node) ? { order: depth?.get(l.from.node) ?? 0, slots } : lit ? "dim" : null;
  const isHot = (l: PiCanvasLink) =>
    (selectedId != null && (l.from.node === selectedId || l.to.node === selectedId)) ||
    (hot != null && ((l.from.node === hot.node && l.from.port === hot.port) || (l.to.node === hot.node && l.to.port === hot.port)));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className={`pic-canvas min-h-0 flex-1 overflow-hidden${drag.current?.moved && !drag.current.card ? " panning" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => (drag.current = null)}
      >
          <div
            ref={worldRef}
            className="pic-world"
            style={{
              width: layout?.width,
              height: layout?.height,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: smooth ? undefined : "none",
              visibility: layout ? "visible" : "hidden",
            }}
          >
            {layout ? <Wires model={model} layout={layout} back isHot={isHot} flow={flow} /> : null}
            {model.frames.map((f) => {
              const b = layout?.frames.get(f.id);
              return b ? (
                <div key={f.id} className="pic-frame" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
                  <span className="pic-frame-label" title={f.label}>
                    {f.label}
                  </span>
                </div>
              ) : null;
            })}
            {layout ? <Wires model={model} layout={layout} isHot={isHot} flow={flow} /> : null}
            {model.nodes.map((n) => (
              <Card
                key={n.id}
                node={n}
                box={layout?.boxes.get(n.id)}
                selected={selectedId === n.id}
                dim={lit != null && !lit.has(n.id)}
                onHover={(on) => setHovered((h) => (on ? n.id : h === n.id ? null : h))}
                onOpen={(tab) => onSelect(n.id, tab)}
                onPort={showPort}
                onPortLeave={() => setHot(null)}
              />
            ))}
          </div>
      </div>
      {hot ? (
        <div className="pic-tip" style={{ left: hot.x, top: hot.y }} role="tooltip">
          {hot.text}
        </div>
      ) : null}
      <div className="pic-zoom" aria-label="Zoom">
        <button type="button" onClick={() => zoomTo(zoom - 0.1)} aria-label="Zoom out" title="Zoom out">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => fit()} aria-label="Fit to view" title="Fit to view">
          <Frame className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => zoomTo(zoom + 0.1)} aria-label="Zoom in" title="Zoom in">
          <Plus className="h-3.5 w-3.5" />
        </button>
        {arranged.size ? (
          <button type="button" onClick={tidy} aria-label="Tidy" title="Put every card back in its place">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="pic-legend" aria-hidden>
        <span>
          <i /> data
        </span>
        <span>
          <i className="p" /> path
        </span>
        <span>
          <i className="o" /> then
        </span>
      </div>
    </div>
  );
}

/** A port list capped at MAX_PORTS: the rest collapse into "+N more", kept (at no height) so their links still land. */
function capped(list: CanvasPort[], render: (p: CanvasPort, hidden: boolean) => ReactNode, more: () => void): ReactNode {
  if (list.length <= MAX_PORTS) return list.map((p) => render(p, false));
  const shown = list.slice(0, MAX_PORTS - 1);
  const rest = list.slice(MAX_PORTS - 1);
  return (
    <>
      {shown.map((p) => render(p, false))}
      <button
        type="button"
        className="pic-port more"
        onClick={(e) => {
          e.stopPropagation();
          more();
        }}
      >
        +{rest.length} more
      </button>
      {rest.map((p) => render(p, true))}
    </>
  );
}

function Card({
  node,
  box,
  selected,
  dim,
  onHover,
  onOpen,
  onPort,
  onPortLeave,
}: {
  node: PiCanvasNode;
  box: Box | undefined;
  selected: boolean;
  dim: boolean;
  onHover: (on: boolean) => void;
  onOpen: (tab?: "io") => void;
  onPort: (e: React.PointerEvent, node: PiCanvasNode, port: string, p: CanvasPort) => void;
  onPortLeave: () => void;
}) {
  const Icon = ICON[node.kind];
  const port = (dir: "in" | "out") => (p: CanvasPort, hidden: boolean) => (
    <div
      key={`${dir}:${p.name}`}
      className={`pic-port ${dir}${hidden ? " hidden" : ""}`}
      data-port={`${dir}:${p.name}`}
      onPointerEnter={(e) => onPort(e, node, `${dir}:${p.name}`, p)}
      onPointerLeave={onPortLeave}
    >
      <span>{p.name}</span>
    </div>
  );
  const sections: ReactNode[] = [];
  if (node.ins.length)
    sections.push(
      <div key="in">
        <div className="pic-ptitle">Inputs</div>
        {capped(node.ins, port("in"), () => onOpen("io"))}
      </div>,
    );
  if (node.sets.length)
    sections.push(
      <div key="set">
        <div className="pic-ptitle">Settings</div>
        {node.sets.slice(0, MAX_PORTS).map((s) => (
          <div key={s.name} className="pic-port set" title={`${s.name}: ${s.value}`}>
            <span>{s.name}</span>
            <span className="v">{s.value}</span>
          </div>
        ))}
      </div>,
    );
  if (node.paths.length)
    sections.push(
      <div key="paths">
        <div className="pic-ptitle">Paths</div>
        {node.paths.map((p, i) => (
          <div key={i} className="pic-port out path" data-port={`path:${i}`} title={p.when ? `${p.label} ${p.when}` : "When no path above matches"}>
            <b>{p.label}</b>
            <span>{p.when || (p.to ? "nothing else matched" : "nothing else matched — do nothing")}</span>
          </div>
        ))}
      </div>,
    );
  if (node.outs.length)
    sections.push(
      <div key="out">
        <div className="pic-ptitle">Outputs</div>
        {capped(node.outs, port("out"), () => onOpen("io"))}
      </div>,
    );
  return (
    <div
      className={`pic-node k-${node.kind}${selected ? " sel" : ""}${dim ? " dim" : ""}`}
      style={box ? { left: box.x, top: box.y } : undefined}
      data-id={node.id}
      role="button"
      tabIndex={0}
      aria-label={node.title}
      aria-pressed={selected}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="pic-head">
        <span className="pic-ico">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="pic-title" title={node.title}>
            {node.title}
          </div>
          {node.sub && node.sub !== node.title ? <div className="pic-sub">{node.sub}</div> : null}
        </div>
      </div>
      {sections.length ? <div className="pic-ports">{sections}</div> : null}
    </div>
  );
}

/** Where a link's end sits, in world coordinates. */
function pointOf(ref: PortRef, layout: Layout, side: "from" | "to"): { x: number; y: number } | null {
  if (ref.port === "frame:in" || ref.port === "frame:out") {
    const f = layout.frames.get(ref.node);
    if (!f) return null;
    return { x: ref.port === "frame:in" ? f.x : f.x + f.w, y: f.y + Math.min(f.h / 2, 60) };
  }
  const b = layout.boxes.get(ref.node);
  if (!b) return null;
  const dy = layout.portY.get(`${ref.node}|${ref.port}`) ?? HEAD_MID;
  const leftSide = side === "to";
  return { x: leftSide ? b.x - 1 : b.x + b.w + 1, y: b.y + dy };
}

type Flow = { order: number; slots: number } | "dim" | null;

function Wires({
  model,
  layout,
  back,
  isHot,
  flow,
}: {
  model: PiCanvasModel;
  layout: Layout;
  back?: boolean;
  isHot: (l: PiCanvasLink) => boolean;
  /** On the hovered card's path: where along it the link sits; off it while something is hovered: "dim". */
  flow: (l: PiCanvasLink) => Flow;
}) {
  const inLoop = new Set(model.nodes.filter((n) => n.loops.length).map((n) => n.id));
  const touchesLoop = (l: PiCanvasLink) =>
    inLoop.has(l.from.node) || inLoop.has(l.to.node) || l.from.port.startsWith("frame") || l.to.port.startsWith("frame");
  const mine = model.links.filter((l) => (back ? !touchesLoop(l) : touchesLoop(l)));
  return (
    <svg className={`pic-wires${back ? " back" : ""}`} width={layout.width} height={layout.height} aria-hidden>
      {mine.map((l, i) => {
        const a = pointOf(l.from, layout, "from");
        const b = pointOf(l.to, layout, "to");
        if (!a || !b) return null;
        const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
        const d = `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
        const f = flow(l);
        const on = f != null && f !== "dim";
        const vars = on ? ({ ["--flow-order" as string]: f.order, ["--flow-slots" as string]: f.slots } as React.CSSProperties) : undefined;
        return (
          <g key={i}>
            <path className={`pic-wire ${l.kind}${isHot(l) ? " hot" : ""}${on ? " flowing" : f === "dim" ? " dim" : ""}`} d={d} style={vars} />
            {on ? <path d={d} pathLength={100} className="pic-pulse" style={{ ...vars, ...pulseTiming(vars) }} fill="none" /> : null}
          </g>
        );
      })}
      {back
        ? null
        : model.links.map((l, i) => {
            if (!l.label) return null;
            const a = pointOf(l.from, layout, "from");
            const b = pointOf(l.to, layout, "to");
            if (!a || !b) return null;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const w = l.label.length * 6.2 + 12;
            return (
              <g key={`l${i}`}>
                <rect className="pic-wlabel-bg" x={mx - w / 2} y={my - 9} width={w} height={EDGE_LABEL_H} rx={5} />
                <text className="pic-wlabel" x={mx} y={my + 3.5} textAnchor="middle">
                  {l.label}
                </text>
              </g>
            );
          })}
    </svg>
  );
}

/** Read each rendered card's height and where its ports sit inside it. Positions do not matter here. */
function measureCards(world: HTMLElement): Measured {
  const heights = new Map<string, number>();
  const portY = new Map<string, number>();
  world.querySelectorAll<HTMLElement>(".pic-node").forEach((n) => {
    const id = n.dataset.id!;
    heights.set(id, n.offsetHeight);
    n.querySelectorAll<HTMLElement>("[data-port]").forEach((p) => portY.set(`${id}|${p.dataset.port}`, p.offsetTop + p.offsetHeight / 2));
  });
  return { heights, portY };
}

/**
 * Place every card: columns left to right with GAP_X between them; a column's cards stacked with GAP_Y and centred
 * on one line; a loop's frame padded PAD around everything inside it, with the columns spread to make room for its
 * edges. A card a person moved goes where they put it, and its loop's frame still wraps it.
 */
export function place(model: PiCanvasModel, m: Measured, arranged: Map<string, { x: number; y: number }>): Layout {
  const h = (id: string) => m.heights.get(id) ?? 60;
  const colH = model.columns.map((ids) => ids.reduce((a, id) => a + h(id), 0) + GAP_Y * Math.max(0, ids.length - 1));
  const depthMax = Math.max(0, ...model.frames.map((f) => f.depth + 1));
  const mid = MARGIN + depthMax * (PAD + 14) + Math.max(0, ...colH) / 2;
  const boxes = new Map<string, Box>();
  let x = MARGIN;
  model.columns.forEach((ids, ci) => {
    x += PAD * (model.opens[ci] ?? 0);
    let y = mid - colH[ci]! / 2;
    for (const id of ids) {
      const moved = arranged.get(id);
      boxes.set(id, { x: moved?.x ?? x, y: moved?.y ?? y, w: W, h: h(id) });
      y += h(id) + GAP_Y;
    }
    x += W + GAP_X + PAD * (model.closes[ci] ?? 0);
  });
  // Frames, innermost first, so an outer frame wraps the inner ones.
  const frames = new Map<string, Box>();
  for (const f of [...model.frames].sort((a, b) => b.depth - a.depth)) {
    const parts = [...f.members.map((id) => boxes.get(id)), ...f.frames.map((id) => frames.get(id))].filter((b): b is Box => !!b);
    if (!parts.length) continue;
    const l = Math.min(...parts.map((b) => b.x));
    const t = Math.min(...parts.map((b) => b.y));
    const r = Math.max(...parts.map((b) => b.x + b.w));
    const btm = Math.max(...parts.map((b) => b.y + b.h));
    frames.set(f.id, { x: l - PAD, y: t - PAD - 8, w: r - l + PAD * 2, h: btm - t + PAD * 2 + 8 });
  }
  const all = [...boxes.values(), ...frames.values()];
  const minX = Math.min(...all.map((b) => b.x));
  const minY = Math.min(...all.map((b) => b.y));
  const shift = { x: minX < MARGIN ? MARGIN - minX : 0, y: minY < MARGIN ? MARGIN - minY : 0 };
  if (shift.x || shift.y) {
    for (const b of all) {
      b.x += shift.x;
      b.y += shift.y;
    }
  }
  return {
    boxes,
    frames,
    portY: m.portY,
    width: Math.max(...all.map((b) => b.x + b.w)) + MARGIN,
    height: Math.max(...all.map((b) => b.y + b.h)) + MARGIN,
    shift,
  };
}

export { START as PI_START, END as PI_END };
