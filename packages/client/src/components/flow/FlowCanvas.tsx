// src/components/flow/FlowCanvas.tsx — a flow, drawn as the DAG it is.
// Programme 3, Stage 2.
//
// ── What this replaces, and why it was worth a dependency ────────────────────
//
// `StepGraph.tsx` drew one column per depth joined by a literal `→` character,
// with a comment arguing that importing a canvas renderer for 5-15 nodes would
// be "the expensive kind of shortcut". That was right for a diagnostic view of an
// execution and wrong for the thing this page actually has to do: somebody
// deciding whether to let an automation run unattended is reading the shape of
// it. A column list cannot show that a gate sits before the send rather than
// after it, which is the single most important fact about a flow with a gate in
// it — and gate placement is load-bearing (Kestra runs tasks in emission order,
// so a gate at the end stops nothing).
//
// ── The one claim this component makes about safety ──────────────────────────
//
// Nodes that send data to an external model carry a badge. The rule lives in
// `lib/canvas-model.ts` (`seamOf`) and is deliberately narrow:
// `tool` steps whose ref is `llm_complete`. It fails CLOSED — a `tool` step whose
// ref could not be read renders "cannot tell", not "safe" — and the legend states
// what the marking does and does not cover. A privacy marker that quietly means
// "probably" is worse than no marker.
//
// ── Read-only by DEFAULT, editable by opt-in (Stage 5, D-151) ────────────────
//
// `editable` turns on connecting and deleting. Arrangement is a SEPARATE switch:
// a step is draggable only when the surface hands this canvas an `onMoveStep`
// handler — the flow page (arrangement persisted, no structural edits, D-151),
// or the builder (arrangement, session-only until the flow exists). A surface
// that shows a saved arrangement but does not hand over a move handler (the run
// page, the flow page before Phase 5) renders the same picture with the cards
// pinned. Two properties survive the change deliberately:
//
//   * **Position is derived every render.** A step WITH a saved row (the
//     `flow_step_positions` table, OUTSIDE the model and the revision — plan
//     decision ②) sits where the row says; a step WITHOUT one is placed by
//     `canvas-layout.ts`'s nearest-neighbour rule (D-150(d)); a graph with no
//     rows at all is dagre's, exactly as before. The model itself still carries
//     no coordinates — the picture and the flow cannot disagree, because the
//     arrangement is keyed to the step ids the model names.
//   * **The canvas never writes.** It reports intents — move this step here,
//     connect these two, delete that one — and the page decides, using the pure
//     functions in `lib/flow-authoring.ts`. That is what keeps "a cycle is
//     refused" a property of a tested function rather than of an event handler,
//     and what keeps a drag from ever becoming a revision write.
"use client";

import { Tokens } from "@/components/flow/Tokens";
import type { Token } from "@/lib/engine-canvas";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StepState, StepStateResult } from "@/lib/step-state";
import type { StepStatus } from "@/lib/types";
import {
  connectedTo,
  pathDepths,
  SEAM_CAVEAT,
  STATUS_LABEL,
  type CanvasFrame,
  type CanvasGraph,
  type CanvasNode,
  type FieldPort,
  type Seam,
  type StepKind,
  STEP_KINDS,
  ARM_LABEL,
  BRANCH_LABEL,
  BRANCH_CAVEAT,
  START_ID,
  END_ID,
} from "@/lib/canvas-model";
import { connectionRefusal, type AuthoredFlow, type AuthoredStep } from "@foundry/flow-edit";
import { kindColour, kindIcon, kindLabel } from "@/lib/kind-meta";
import { Input } from "@/components/ui/Field";
import { paletteMatches } from "@/components/flow/builder/palette";
import { awaitingFirstStatus, edgeId, movingEdges, movingNodes } from "@/lib/run-animation";
import { entering, noteEdges, noteNodes, useGlide, type Seen } from "@/lib/canvas-reveal";
import type { StepPorts } from "@/lib/flow-field-drop";
import { FRAME_PREFIX, frameBox, LOOP_FRAME_Z, stackEdgesOnLoops, stackOnLoops, heightFor, inletTop, inputHandleTop, inputRowTop, layout, NODE_H, NODE_W, PORT_LANDING, PORT_ROW, portTop, shownInputRows, widthFor, type Positioned, type SavedPosition } from "@/lib/canvas-layout";
import { inputSourceText, stepIo, type IoCatalogue, type IoInput } from "@/lib/step-io";
import { isPaletteDrag, readPaletteDrag } from "@/lib/palette-drag";
import { typeErrorBadge, typeErrorTitle } from "@/lib/step-diagnostics";
import { listPhases, listFlags } from "@/lib/api";
import type { FlowPhase } from "@/lib/api";
import {
  Sparkle, CircleSlash, Cog,
  Frame, Minus, Plus, Trash, RefreshCw,
  ChevronLeft, ChevronRight, Play, CheckCheck, Search,
} from "@/components/ui/icons";
/**
 * How much room the canvas gets. **A closed list, and the only size knob there
 * is** — `height` was a raw number and six call sites each picked their own
 * (`220 · 200 · 280 · 320 · 400 · 420`), which is D-78's page-width finding one
 * component down. See **D-102**.
 *
 * ⚠ The middle one is `workbench` and NOT D-80's word "editable", although it is
 * the density the editable surface uses. `editable` is already a prop here and
 * it means something else — what the canvas may *do*, not how much room it has.
 * Two things spelled the same is how `density="editable" editable={false}`
 * becomes legal and meaningless.
 */
export const DENSITY = {
  /** A run view: the canvas shares the page with a step strip and a log. */
  compact: { height: 340 },
  /**
   * A flow's own page, where the shape IS the subject.
   *
   * ⚠ platform-coherence Phase 6.2, I-108. `/flows/[id]` used `compact`, which
   * is sized for a canvas sharing a page with other content — and on the flow
   * page the canvas is what the approval decision is about, sitting above eight
   * other panels of equal weight. The grouping in Phase 6.1 stopped it
   * COMPETING; this gives it the room, without moving the run page, whose 340 is
   * correct beside a step strip and a log.
   *
   * Between `compact` and `workbench` on purpose: taller than a shared view,
   * shorter than an authoring pane that has an inspector beside it and nothing
   * below it. 400px is the mock's `view-flows-id` canvas (D-19), and the rail
   * footer pins to its bottom edge.
   */
  detail: { height: 400 },
  /** The authoring pane, beside an inspector. */
  workbench: { height: 460 },
  /** Expanded — the canvas is the whole surface. Reached by the toolbar, never by a page. */
  full: { height: 720 },
} as const;

// S-07 builder canvas geometry — per reference/geometry.md §8
export const MIN_CANVAS = 840;
export const SHELL_CHROME = 120;
export const PANES = { builder: 708, inspector: 788, canvasOnly: 1006 } as const;
export const LANE_GAP = 56;


export type CanvasDensity = keyof typeof DENSITY;

// ── Kind → how it reads ──────────────────────────────────────────────────────
// Read from the registry (`lib/kind-meta.ts`), not written here: the label is
// what a person who knows the business and not the system would call it
// (`code` is "generated code" and not "code" because the distinction a
// reviewer needs is *who wrote the body*, which is the whole argument of
// `FlowReview`'s docblock). The four hand-synced copies had already drifted;
// this one cannot.
const KIND: Record<StepKind, { label: string; colour: string; Icon: (p: { s?: number }) => JSX.Element }> =
  Object.fromEntries(
    STEP_KINDS.map((kind) => [
      kind,
      { label: kindLabel(kind), colour: kindColour(kind), Icon: kindIcon(kind) },
    ]),
  ) as Record<StepKind, { label: string; colour: string; Icon: (p: { s?: number }) => JSX.Element }>;
/**
 * What the canvas menu offers. Exactly the kinds the server's `stepSchema`
 * compiles, minus `datasource` (named-query removal): seven entries.
 * Everything else still renders — offering and rendering are different
 * decisions, and old flows contain both.
 */
export const MENU_KINDS: ReadonlySet<StepKind> = new Set([
  "query",
  "tool",
  "transform",
  "code",
  "branch",
  "merge",
  "approval",
]);

/**
 * A task the compiler emitted — `begin`, `complete`, a gate's `_await`.
 *
 * ⚠ Its own label, distinct from `UNKNOWN_KIND`. "engine task" reads as *we
 * could not classify this*; "platform" says *this one is ours, not yours*, which
 * is the difference between a picture that looks broken and one that explains
 * itself. A two-step flow with a gate really is six Kestra tasks.
 */
const PLATFORM_KIND = { label: "platform", colour: "var(--k-unknown)", Icon: Cog };

/** Genuinely unclassifiable: a task with no declaration and no pointer row behind it. */
const UNKNOWN_KIND = { label: "engine task", colour: "var(--k-unknown)", Icon: CircleSlash };

/**
 * The flow's entry point — not a step and not a taskrun.
 *
 * ⚠ Needed because `kindOf` answers `UNKNOWN_KIND` for a null kind, i.e. *we
 * could not classify this*, which is the opposite of true here: this is the
 * one node whose meaning is certain. `PLATFORM_KIND` is not the fallback
 * either — that says *this one is ours, not yours* about a real Kestra task.
 */
/**
 * The card-level params target, and where the named ports begin below it.
 *
 * ⚠ **`PARAMS_HANDLE` must never collide with a parameter name.** A tool param
 * called `__params__` would make two handles share an id, and React Flow
 * resolves that by picking one — silently, and differently per render. The
 * double underscores match `START_ID`/`END_ID`'s convention for the same
 * reason: a name a catalogue cannot produce.
 */
export const PARAMS_HANDLE = "__params__";
/**
 * localStorage key for the data-reference overlay toggle (Phase 4.2).
 * `"true"` is on; absent or anything else is off. Read lazily in state so the
 * first paint already matches the stored choice — the `PANE_WIDTH_KEY`
 * pattern in `builder/StepPanel.tsx`.
 */
export const SHOW_DATA_REFS_KEY = "foundry.show-data-refs";

/**
 * The canvas model as a flow, for drag-time refusal (Phase 4.3).
 *
 * `connectionRefusal` reads `{ steps: [{ id, dependsOn }] }` and nothing else,
 * so the canvas rebuilds exactly that from its own graph — the same picture
 * the drop lands on. Each drawn step's `dependsOn` is its incoming drawn
 * edges (`sourceHandle ?? source`, so an edge leaving an arm counts for the
 * arm step). Boundary entry/exit ids are not steps and fall out through the
 * map lookups. Arm ids ride along as dependenceless steps so a drag from an
 * arm handle is judged on topology, never refused as an unknown end.
 * Anything this projection cannot see falls through to `connect` on drop,
 * which re-checks everything — this never authorises, it only names the
 * reason early.
 */
export function refusalFlowForGraph(graph: CanvasGraph): AuthoredFlow {
  const steps = new Map<string, { id: string; dependsOn: string[] }>();
  for (const n of graph.nodes) {
    if (n.boundary != null || n.id === START_ID || n.id === END_ID) continue;
    if (!steps.has(n.id)) steps.set(n.id, { id: n.id, dependsOn: [] });
    for (const a of n.arms ?? []) {
      if (!steps.has(a.id)) steps.set(a.id, { id: a.id, dependsOn: [] });
    }
  }
  for (const e of graph.edges) {
    const dep = e.sourceHandle ?? e.source;
    const target = steps.get(e.target);
    if (!target || !steps.has(dep) || target.dependsOn.includes(dep)) continue;
    target.dependsOn.push(dep);
  }
  return { id: "canvas", steps: [...steps.values()] } as unknown as AuthoredFlow;
}

/**
 * One dashed overlay link: which producer feeds the selected consumer, in words.
 */
export type DataRefLink = { producerId: string; consumerId: string; label: string };

/**
 * The data-reference overlay as data (Phase 4.2) — pure, so jsdom can pin it.
 *
 * One link per producer-fed input of the selected step, read through `stepIo`:
 * a `step` source draws `<producer title> → <field read>`; `whole` draws
 * `the whole of <producer>`; `self` (fan-out) draws the same for the step
 * fanned over (`overStepId`). Run inputs, literals, unset and unknown sources
 * name no producer node, and a producer with no drawn card (a collapsed arm)
 * offers nowhere to draw from — both are skipped, never invented. Identical
 * triples collapse to one link.
 */
export function dataRefLinksFor(input: {
  consumerId: string;
  inputs: IoInput[];
  overStepId: string | null;
  titleOf: (id: string) => string | undefined;
}): DataRefLink[] {
  const seen = new Set<string>();
  const out: DataRefLink[] = [];
  const push = (producerId: string, label: string) => {
    const key = `${producerId} ${input.consumerId} ${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ producerId, consumerId: input.consumerId, label });
  };
  for (const i of input.inputs) {
    const src = i.source;
    if (src.kind === "step") {
      const title = input.titleOf(src.stepId);
      if (title !== undefined) push(src.stepId, `${title} → ${src.field}`);
    } else if (src.kind === "whole") {
      const title = input.titleOf(src.stepId);
      if (title !== undefined) push(src.stepId, `the whole of ${title}`);
    } else if (src.kind === "self") {
      if (!input.overStepId) continue;
      const title = input.titleOf(input.overStepId);
      if (title !== undefined) push(input.overStepId, `the whole of ${title}`);
    }
    // `input` (a run input), `literal`, `unset` and `unknown` name no producer
    // step, so there is no edge to draw — skipping is the honest rendering.
  }
  return out;
}

/**
 * Which target handle an edge into `target` lands on.
 *
 * ⚠ **A PURE SEAM because jsdom cannot answer the question any other way.**
 * React Flow resolves an edge's endpoints from measured handle bounds and jsdom
 * performs no layout, so no client test can assert where an edge actually
 * attached — a test over an empty set would pass for ever (I-38). Extracting
 * the decision makes it assertable; the geometry stays unprovable here and
 * that bound is stated rather than papered over.
 *
 * `undefined` for a node with no named ports, so React Flow's single-handle
 * fallback stays in play for every other node in the product — the same rule
 * `CanvasEdge.sourceHandle` follows.
 */
/**
 * The PARAMETER a drop landed on, or null when the drop was onto the card.
 *
 * ⚠ **`PARAMS_HANDLE` IS NOT A PARAMETER, and the obvious one-liner binds one
 * called `__params__`.** The card-level target exists so an edge has an honest
 * place to land; a drop onto it means "link these steps". Passed to
 * `onConnectToField` it would reach `parseParams`, find no such param, and
 * rebuild the expression having silently dropped every binding the step had.
 *
 * A pure seam because a drop needs measured handle bounds, which jsdom does
 * not produce.
 */
export function fieldDropTarget(targetHandle: string | null | undefined): string | null {
  if (!targetHandle || targetHandle === PARAMS_HANDLE) return null;
  return targetHandle;
}
/**
 * Which target handle a drawn edge into `target` from `source` lands on.
 *
 * One upstream step feeding exactly one named parameter ⇒ the wire lands on
 * that parameter's row, so the picture says what the binding says. Anything
 * else (whole-object feed, several params from one step, no known fields) ⇒
 * the card-level `PARAMS_HANDLE`, exactly as before. A step whose params are
 * hand-written (`bindable` false) has no per-port dots at all, so its edges
 * always land on the inlet.
 */
export function edgeTargetHandle(
  source: string,
  target: string,
  ports?: Map<string, StepPorts>,
): string | undefined {
  const entry = ports?.get(target);
  const fields = entry?.fields;
  if (!fields?.length) return undefined;
  if (entry?.bindable === false) return PARAMS_HANDLE;
  const fed = fields.filter((f) => (f.source.kind === "step" || f.source.kind === "tokens") && f.source.stepId === source);
  if (fed.length === 1) return fed[0]!.name;
  return PARAMS_HANDLE;
}

const START_KIND = { label: "entry point", colour: "var(--accent)", Icon: Play };
/**
 * The EXIT point — where the flow's answer comes from.
 *
 * ⚠ A distinct glyph from `START_KIND`, and it has to be: the two boundaries
 * sit at opposite ends of the same rail with the same dashed pill shape, so
 * sharing an icon would make direction the only thing telling them apart, and
 * on a one-step flow they are adjacent.
 */
const END_KIND = { label: "exit point", colour: "var(--accent)", Icon: CheckCheck };

const BOUNDARY_KIND = { start: START_KIND, end: END_KIND } as const;

function kindOf(k: StepKind | null, platform = false) {
  if (k) return KIND[k];
  return platform ? PLATFORM_KIND : UNKNOWN_KIND;
}

/** `kindOf` for a whole node, so a boundary is never described as unclassifiable. */
function kindOfNode(n: Pick<CanvasNode, "kind" | "platform" | "boundary">) {
  return n.boundary != null ? BOUNDARY_KIND[n.boundary] : kindOf(n.kind, n.platform);
}

/** Abbreviate a task type for the technical view — strip `io.kestra.plugin.` prefix per S-11. */
export function abbreviateTaskType(taskType: string): string {
  return taskType.replace(/^io\.kestra\.plugin\./, "");
}

// ── Status → how the card is tinted ──────────────────────────────────────────
// Only on `/runs/[id]`; a declared flow has `status: null` and is drawn by kind
// alone. Tinting a never-run draft grey would make a perfectly good flow look
// like a stalled execution.
//
// ⚠ The ring is the D-162 build-state vocabulary (`.node-status-ok|busy|attn`,
// composed from `--ok`/`--alpha`/`--warn`) — the Langflow border-encodes-state
// language (D-161). The three classes cover ready / busy / needs-attention, so
// the seven run states fold into them: success is ok, running is busy, and
// warning/paused/failed are all attn. The WORD keeps its own hue (`text-danger`
// for failed, `text-accent` for running) — only the border folds into the
// three-state vocabulary. Neutral states carry no status class at all.
/**
 * ⚠ The COLOURS live here; the WORDS live in `lib/canvas-model.ts`'s
 * `STATUS_LABEL` and are read from it. More than one surface says these words
 * now (this canvas, its screen-reader node list, the builder inspector during a
 * test run), and two copies drift in the direction where one of them goes on
 * calling a paused run "running".
 */
const STATUS: Record<StepStatus, { ring: string; text: string; label: string }> = {
  success: { ring: "node-status-ok", text: "text-ok", label: STATUS_LABEL.success },
  warning: { ring: "node-status-attn", text: "text-warn", label: STATUS_LABEL.warning },
  failed: { ring: "node-status-attn", text: "text-danger", label: STATUS_LABEL.failed },
  cancelled: { ring: "border-line", text: "text-muted", label: STATUS_LABEL.cancelled },
  running: { ring: "node-status-busy", text: "text-accent", label: STATUS_LABEL.running },
  paused: { ring: "node-status-attn", text: "text-warn", label: STATUS_LABEL.paused },
  created: { ring: "border-line", text: "text-dim", label: STATUS_LABEL.created },
  skipped: { ring: "border-line", text: "text-dim", label: STATUS_LABEL.skipped },
};

/**
 * Phase 3 — the ONE state word on the card. When the parent supplies a
 * precomputed `stepState` record (`stepStates`, below) the card renders one
 * badge — `state · reason`, truncated to one line with the full sentence in
 * `title` — instead of the run-status word. Absent ⇒ today's rendering, so
 * the canvas works before parents wire it. `STATUS` stays for non-step uses
 * (aria labels, run surfaces); the tints reuse the same design tokens.
 */
export type StepStateBadges = Record<string, StepStateResult>;
const STEP_STATE_TEXT: Record<StepState, string> = {
  ready: "text-dim",
  incomplete: "text-danger",
  broken: "text-danger",
  failed: "text-danger",
  stale: "text-warn",
};

/** What the seam badge says, in words, on the node itself. */
const SEAM_LABEL: Record<NonNullable<Seam> | "unknown", string> = {
  llm: "sends data to a model",
  unknown: "cannot tell",
};

/**
 * Add/remove a contract field on a step, from the card itself. `(stepId,
 * which, op, name)` — `name` only for `remove`. The page applies it through
 * the same local-edit path as every other canvas gesture (never a save).
 * Only `code` steps carry author-owned I/O; every other kind is endpoint-,
 * query- or runtime-owned and the card offers nothing.
 */
export type StepIoEdit = (
  stepId: string,
  which: "input" | "output",
  op: "add" | "remove",
  name?: string,
) => void;

/** Everything the card renders, carried on the React Flow node's `data`. */
type StepNodeData = {
  step: CanvasNode;
  selected: boolean;
  /** False when another node is hovered and this one is not on its path. */
  lit: boolean;
  /** Present only when the surface is editable and owns renames — the card's inline rename. */
  onRename?: (nextId: string) => void;
  /** Present only when the surface is editable — the card's own delete affordance. */
  onDelete?: () => void;
  /** Present only when the surface is editable — add/remove contract fields on `code` cards. Wired like onDelete/onRename. */
  onEditStepIo?: (which: "input" | "output", op: "add" | "remove", name?: string) => void;
  /** B-12 flag badge — open flag count per node, FlagMark geometry greyscale-audited */
  flagCount?: number;
  /** Ephemeral test pulsating — data flowing component-to-component */
  testing?: boolean;
  /** S-11: Business shows `<Kind> · <ordinal>`; Technical shows abbreviated task type. Icon never changes. */
  depth?: "business" | "technical";
  /** Phase 3: this step's precomputed `stepState` result. Present ⇒ the header
   * renders the ONE `state · reason` badge instead of the run-status word.
   * Absent ⇒ today's rendering. The try-N chip and flag dot are untouched. */
  stateBadge?: StepStateResult;
};
function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const { step, selected, lit, onDelete, onRename, onEditStepIo, depth = "business", flagCount, testing, stateBadge } = data;
  // Inline rename — double-click (never single-click, which selects) turns the
  // title into an input; blur/Enter commits through `onRename`, Escape cancels.
  // `committed` guards the Enter-then-blur double fire (Enter unmounts the
  // input, and the unmount blur would commit twice).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(step.id);
  const committed = useRef(false);
  const commit = useCallback(() => {
    if (committed.current) return;
    committed.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== step.id) onRename?.(next);
    else setDraft(step.id);
  }, [draft, step.id, onRename]);
  const beginRename = useCallback(() => {
    committed.current = false;
    setDraft(step.id);
    setEditing(true);
  }, [step.id]);
  /**
   * ── THE ENTRY POINT ────────────────────────────────────────────────────────
   *
   * ⚠ **Its own early return, deliberately, rather than conditions threaded
   * through the step card.** Almost nothing below applies: it has no kind rail,
   * no status, no seam badge, no ref line, no ordinal, no task type, no
   * rename, no delete and no I/O controls. Adding `boundary &&` to twenty
   * expressions would leave a card that is mostly suppressed branches, and
   * each one is a place where a step affordance can reappear on a thing that
   * is not a step.
   *
   * ⚠ **It reads `step.facts`, which came from `withStart`, which read
   * `model.inputs`.** Every character on this card was declared by the flow —
   * no default, no guess, nothing inferred. That is what lets an entry point
   * exist on a canvas whose rule is that it draws only what the server sent.
   *
   * ⚠ **`widthFor`/`heightFor` still own the box.** I-66: dagre spaces the
   * graph by exactly these and `stepNodes` declares the same to React Flow, so
   * a card sized by its own content attaches every edge to the wrong place
   * with nothing flickering to say why. `heightFor` grows a boundary card for
   * its meta line and its facts the same way `widthFor` already grows it for
   * its longest line — declared, drawn and dagre-spaced from that one
   * estimate, capped at `MAX_NODE_H` rather than left to scroll or clip.
   */
  if (step.boundary != null) {
    return (
      <div
        className={
          "relative flex flex-col rounded-full border-2 border-dashed bg-surface-2 text-left shadow-sm transition " +
          (selected ? "border-accent ring-1 ring-accent/40 " : "border-line ") +
          (lit ? "opacity-100 " : "opacity-30 ")
        }
        // ⚠ NOT `overflow-hidden`. `heightFor`'s estimate errs high on purpose,
        // but it is still an estimate — jsdom/pre-paint layout can't measure the
        // real DOM (see canvas-layout.ts). Clipping on top of an estimate turns
        // every remaining miss back into invisible data loss; without it, a rare
        // miss shows as a few px of harmless overflow past the pill instead.
        style={{ width: widthFor(step), height: heightFor(step), borderRadius: 14 }}
      >
        <div className="min-w-0 flex-1 px-3.5 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-accent">
              {step.boundary === "end" ? <CheckCheck s={12} /> : <Play s={12} />}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
              {step.label ?? (step.boundary === "end" ? "End" : "Start")}
            </span>
          </div>
          {/* The count, then the declarations. `meta` is "3 inputs" or "no
              inputs" — the second is a fact somebody needs, not an empty
              state, which is why this node is drawn even for a flow that
              takes no parameters. The card is sized to this text by
              `heightFor` (canvas-layout.ts), so it wraps rather than
              truncating or scrolling. */}
          <p className="mt-1 text-[11px] text-muted">{step.meta ?? "entry point"}</p>
          {!!step.facts?.length && (
            <dl className="mt-1.5 space-y-1">
              {step.facts.map((f) => (
                <div key={f.label} className="flex min-w-0 items-baseline gap-1.5">
                  <dt className="shrink-0 font-mono text-[10px] text-text">{f.label}</dt>
                  <dd className="min-w-0 flex-1 text-[10px] text-muted">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        {/* ⚠ ONE handle each, and which one is the whole meaning of the node.
            A target on the entry point would offer to draw an edge INTO the
            start, i.e. a step that runs before the flow begins; a source on
            the exit point would offer a step that runs after it ends. */}
        {step.boundary === "end" ? (
          <Handle type="target" position={Position.Left} />
        ) : (
          <Handle type="source" position={Position.Right} />
        )}
      </div>
    );
  }

  const k = kindOf(step.kind, step.platform);
  const s = step.status ? STATUS[step.status] : null;
  const seam = step.seam;
  const ordinal = step.ordinal ?? null;
  // ⚠ No fallback: a step that declares no task type shows its business line
  // in both views. Engine task types are the compiler's business — a client
  // table claiming one is a claim the runtime may not honour (UXI-003).
  const taskType = step.taskType ?? null;
  const secondLine =
    depth === "technical"
      ? taskType
        ? abbreviateTaskType(taskType)
        : `${k.label}${ordinal ? ` · ${ordinal}` : ""}`
      : ordinal
        ? `${k.label} · ${ordinal}`
        : k.label;
  // Dify-style I/O editing, on the card. Only `code` steps own their inputs
  // and outputs (contract.input/output); every catalogue kind is endpoint-,
  // query- or runtime-owned, so the card offers nothing for them even when
  // the surface is editable.
  const canEditIo = step.kind === "code" && onEditStepIo != null;
  // The pill + the key rows (Dify parity). The pill names WHAT the step is in
  // words — kind first, then the concrete thing — because colour and icon
  // alone are not a carrier. Below it, the card draws EXACTLY
  // `keyRows(step)` content rows naming the key config: the first params
  // (past the cap, the last row is "+N more"). Arms and code-output labels
  // keep floating beside their source dots, exactly as before.
  const pill =
    step.flag ??
    (step.kind === "approval"
      ? (step.meta ?? "waits for a person")
      : step.kind === "branch"
        ? (step.arms && step.arms.length > 1
            ? step.arms.map((a) => a.label).join(" / ")
            : BRANCH_LABEL)
      : step.ref
        ? `${k.label} · ${step.ref}`
        : k.label);
  const ports = step.inputHandles ?? [];
  // ⚠ The SAME count the layout uses (`shownInputRows`) — the renderer draws
  // exactly the rows `keyRows` declares, which is the I-66 agreement. The
  // whole inlet takes row 0, so it is not one of these.
  const shownPorts = ports.slice(0, shownInputRows(step));
  const hiddenPorts = ports.length - shownPorts.length;
  return (
    <div
      // `group` so the seam badge and the ref line can respond to hover without
      // a second piece of state crossing the React Flow boundary. `.node-card`
      // owns bg/border/shadow from the `--card-*` role tokens — the
      // `bg-surface`/`border-line`/`shadow-sm` utilities it replaces would win
      // the cascade (utilities layer) and bury the tokens. State still wins:
      // status rings come later in the components layer, and the selected
      // `border-accent` is a utility.
      className={
        "group node-card relative flex items-stretch overflow-hidden rounded-xl border text-left transition " +
        (selected ? "border-accent ring-1 ring-accent/40 " : `${s?.ring ?? ""} `) +
        // Quieter, not hidden. A failed `begin` still has to be findable — it is
        // where the approval gate and the budget check live.
        (step.platform && step.status !== "failed" ? "opacity-70 " : "") +
        (lit ? "opacity-100 " : "opacity-30 ") +
        (testing ? "node-testing-pulse " : "")
      }
      // ⚠ The size comes from the LAYOUT module, and it is not a style choice.
      // dagre spaces the graph by exactly this, and `stepNodes` declares the
      // same to React Flow — three places that have to agree, so there is one
      // function rather than three copies of a number.
      //
      // ⚠ **The WIDTH now varies with the name** (`widthFor`), because a fixed
      // 232px card truncated every real step name on the surface whose job is
      // reading a flow. The height does not. I-66 is the record of what a
      // disagreement costs: React Flow compares nodes by identity,
      // `parseHandles` discards handle bounds it cannot confirm, and every edge
      // unmounts with nothing flickering to say why.
      style={{ width: widthFor(step), height: heightFor(step) }}
    >
      {/* The kind rail. Three pixels of colour is the fastest read on the card,
          and it is never the only one — the kind is also written below. */}
      <span aria-hidden className="w-[3px] shrink-0" style={{ background: k.colour }} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3 py-2">
        {/* ── Header: icon · name · status — the Langflow anatomy (FE-1.3) ──
            Status moved up out of the body row: on a run the "what happened"
            question is answered by the header, and the body keeps the fields
            (ref, flag, meta). On a declared flow status is null and the header
            is icon + name alone — the same box, no empty slot.

            ⚠ `pr-9` when a seam is present: the seam badge is absolutely
            positioned at the card's top-right, and the status/delete now live
            in this same header row — without the padding the badge would sit on
            top of them. */}
      <div className="shrink-0">
        <div className={`flex items-center gap-1.5 ${seam !== null ? "pr-9" : ""}`}>
          <span style={{ color: k.colour }} className="shrink-0">
            <k.Icon s={13} />
          </span>
          {/* The LABEL when there is one — an outline line's text — otherwise
              the id. They are separate fields because the id is the React key
              and must survive an edit; see `CanvasNode.id`. */}
          {editing && onRename ? (
            <input
              aria-label={`Rename ${step.id}`}
              value={draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              // A click or key inside the input is an edit, not a select: the
              // card click would otherwise toggle the selection mid-rename, a
              // Backspace would reach the canvas delete, and `f` would refit.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") {
                  committed.current = true;
                  setDraft(step.id);
                  setEditing(false);
                }
              }}
              onBlur={commit}
              className="min-w-0 flex-1 truncate rounded border border-accent bg-surface px-1 font-mono text-body text-text focus:outline-none"
            />
          ) : (
            <span
              title={step.label ?? step.id}
              onDoubleClick={
                onRename
                  ? (e) => {
                      e.stopPropagation();
                      beginRename();
                    }
                  : undefined
              }
              className={
                "truncate text-body text-text " + (step.label ? "" : "font-mono")
              }
            >
              {step.label ?? step.id}
            </span>
          )}
          {stateBadge ? (
            <span
              data-testid="step-state-badge"
              data-state={stateBadge.state}
              title={stateBadge.reason && stateBadge.reason !== stateBadge.state ? `${stateBadge.state} — ${stateBadge.reason}` : stateBadge.state}
              className={`ml-auto min-w-0 max-w-[140px] shrink-0 truncate text-micro uppercase tracking-label ${STEP_STATE_TEXT[stateBadge.state]}`}
            >
              {stateBadge.reason && stateBadge.reason !== stateBadge.state ? `${stateBadge.state} · ${stateBadge.reason}` : stateBadge.state}
            </span>
          ) : (
            s && (
              <span className={`ml-auto shrink-0 text-micro uppercase tracking-label ${s.text}`}>
                {s.label}
              </span>
            )
          )}
          {step.attempt != null && step.attempt > 1 && (
            <span className="shrink-0 rounded bg-warn-bg px-1 py-px text-micro text-warn">
              try {step.attempt}
            </span>
          )}
          {/* Typed-build phase 2: the checker's errors ON the step they name,
              so a refused save points at the card rather than at a sentence.
              ⚠ In the header row, not absolutely positioned: the card's size is
              fixed by `widthFor`/`heightFor` in `style`, so inline content can
              truncate but can never resize it — and every corner is already
              taken (seam badge, flag dot, the two add buttons). The CODE is
              written, never a bare red dot; the full list is the title and
              the accessible name. */}
          {step.typeErrors && step.typeErrors.length > 0 && (
            <span
              data-testid="type-error-badge"
              role="img"
              aria-label={`${step.typeErrors.length} type error${step.typeErrors.length === 1 ? "" : "s"}: ${typeErrorTitle(step.typeErrors)}`}
              title={typeErrorTitle(step.typeErrors)}
              className={
                "shrink-0 rounded border border-danger/50 bg-danger-bg px-1 py-px font-mono text-micro text-danger " +
                (!stateBadge && !s ? "ml-auto" : "")
              }
            >
              {typeErrorBadge(step.typeErrors)}
            </span>
          )}
          {onDelete && selected && (
            <button
              type="button"
              title="Delete this step"
              aria-label={`Delete ${step.label ?? step.id}`}
              onClick={(e) => {
                // A click that deletes is not a click that selects: the card
                // would otherwise re-open the inspector for the step being
                // removed. `onNodeClick` fires for the parent — stop it here.
                e.stopPropagation();
                onDelete();
              }}
              className="shrink-0 rounded p-0.5 text-dim transition hover:bg-surface-2 hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            >
              <Trash s={12} />
            </button>
          )}
        </div>

        {/* S-11 second line in `technical` depth only: the abbreviated task type
            in mono dim tone. In business depth the kind word lives in the pill
            below, so there is no second line — the diet rule. */}
        {depth === "technical" && (
          <div className="mt-0.5 truncate font-mono text-micro text-dim">
            {secondLine}
          </div>
        )}
      </div>
      {/* ── Pill → key rows (Dify parity). The pill names the concrete thing
          (or the flag, or the arm chain); the meta rides at its right end.
          Below it, one row per shown param — EXACTLY `keyRows(step)` rows in
          total — so each row's dot (see `portTop`) sits beside its line. Rows
          start one landing strip below the pill, the same origin the layout
          measures from. */}
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <span
          className={
            "shrink-0 truncate rounded border px-1.5 py-px text-micro " +
            (step.flag
              ? "border-danger/50 bg-danger-bg text-danger"
              : "border-line bg-surface-2 text-text")
          }
          title={pill}
        >
          {pill}
        </span>
        {step.meta && step.kind !== "approval" && (
          <span className="ml-auto shrink-0 truncate font-mono text-micro text-dim" title={step.meta}>
            {step.meta}
          </span>
        )}
      </div>
      {step.wholeFrom || shownPorts.length > 0 || hiddenPorts > 0 ? (
        <div className="min-w-0" style={{ marginTop: PORT_LANDING - 4 }}>
          {step.wholeFrom ? (
            <div
              style={{ height: PORT_ROW }}
              className="flex min-w-0 items-center gap-1.5 truncate text-caption text-muted"
              title={`${ports.length} inputs, all from ${step.wholeFrom}`}
            >
              <span className="shrink-0 truncate font-mono">all inputs</span>
              <span className="ml-auto shrink-0 truncate">← the whole of {step.wholeFrom}</span>
            </div>
          ) : null}
          {shownPorts.map((port) => {
            const text = inputSourceText(port.source);
            const weak = port.source.kind === "unset" || port.source.kind === "unknown";
            return (
              <div
                key={port.name}
                style={{ height: PORT_ROW }}
                className="flex min-w-0 items-center gap-1.5 truncate text-caption text-muted"
                title={text}
              >
                <span className="shrink-0 truncate font-mono">{port.name}</span>
                {port.source.kind === "tokens"
                  ? <Tokens tokens={port.source.tokens as Token[]} className="ml-auto justify-end" />
                  : <span className={"ml-auto shrink-0 truncate" + (weak ? " text-dim" : "")}>{text}</span>}
              </div>
            );
          })}
          {hiddenPorts > 0 ? (
            <div
              style={{ height: PORT_ROW }}
              className="flex min-w-0 items-center truncate text-caption text-dim"
            >
              +{hiddenPorts} more
            </div>
          ) : null}
        </div>
      ) : null}
    </div>

      {/* ⚠ The model seam. Shape and text, not colour alone: this is the marker
          somebody uses to answer "which parts of this send my data outside", and
          it has to survive a monochrome screenshot. */}
      {seam !== null && (
        <span
          title={SEAM_LABEL[seam]}
          className={
            "absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full border px-1 py-px text-micro uppercase tracking-label " +
            (seam === "unknown"
              ? "border-line bg-surface-2 text-muted"
              : "border-orange/50 bg-orange-bg text-orange")
          }
        >
          {seam === "unknown" ? <CircleSlash s={8} /> : <Sparkle s={8} />}
          {seam === "unknown" ? "?" : "model"}
        </span>
      )}

      {/* B-12 flag badge — small numbered dot on node's top-right corner (S-07) plus FlagMark geometry greyscale-audit */}
      {(flagCount != null && flagCount > 0) || step.flag ? (
        <span
          data-testid="flag-badge"
          aria-label={`${flagCount ?? 1} flag${(flagCount ?? 1) === 1 ? "" : "s"}`}
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-danger/50 bg-danger text-micro font-medium text-white shadow-sm"
        >
          {flagCount ?? 1}
        </span>
      ) : null}

      {/* Routing anchors. Hidden by `.canvas-readonly` — see globals.css. */}
      {/* ⚠ **ONE TARGET HANDLE PER BINDABLE INPUT, INVISIBLE AT REST.** Dots
        * with a drawn row sit beside it (see `inputRowTop`); overflow dots
        * crowd below the content (see `inputHandleTop`). A drop onto one names
        * its field in the connection's `targetHandle` and the canvas reports
        * it through `onConnectToField`; absent (no catalogue, no known
        * fields) ⇒ the single unnamed target, exactly as before.
        *
        * ⚠ **Per-port dots exist only where a drop can bind.** A step whose
        * inputs are set by an expression no writer may re-emit (`bindable` is
        * false) draws the inlet only — a drop on a param row would rebuild
        * the expression from a blank map and destroy it. */}
      {step.inputHandles && step.inputHandles.length > 0 ? (
        <>
          {/*
           * ⚠ **THE CARD-LEVEL TARGET, and it is the half that fixes the
           * reported bug.** Every incoming edge lands here — see the
           * `targetHandle` note at the edge builder. Before this the node had
           * only NAMED handles, so React Flow attached the one real edge to
           * whichever it picked first: on a four-parameter email tool the
           * picture said `subject` was fed by the transform while the model
           * bound the whole object, and the other three read as missing wires.
           *
           * It is drawn whenever there are named ports, not only when
           * `wholeFrom` is set — an edge must always have one honest place to
           * land, including on a step whose params are per-field and whose
           * upstream feeds it for some other reason. It centres on the whole
           * row when there is one (see `inletTop`), else on the landing
           * strip below the header, so it never stacks onto a named dot.
           * Per-field bindings read beside it, one row each. */}
          <Handle type="target" id={PARAMS_HANDLE} position={Position.Left} style={{ top: inletTop(step) }} />
          {step.bindable !== false &&
            step.inputHandles.map((port, i) => (
              <Handle
                key={port.name}
                type="target"
                id={port.name}
                position={Position.Left}
                /* ⚠ Beside its row while it has one, crowded below it once past
                   the cap — `shownInputRows`/`inputRowTop` are the same counts
                   the layout uses, so dot and row cannot disagree. Tone
                   carries the source: a wire behind it, a value in it, or
                   nothing known. */
                style={{ top: i < shownInputRows(step) ? inputRowTop(step, i) : inputHandleTop(step, i) }}
                className={
                  port.source.kind === "step" || port.source.kind === "whole" || (port.source.kind === "tokens" && port.source.stepId)
                    ? "!border-accent !bg-accent"
                    : port.source.kind === "literal" ||
                        port.source.kind === "input" ||
                        port.source.kind === "self"
                      ? "!border-line !bg-surface-2"
                      : "!border-dim !bg-bg"
                }
              />
            ))}
        </>
      ) : step.wholeFrom ? (
        <Handle type="target" id={PARAMS_HANDLE} position={Position.Left} style={{ top: inletTop(step) }} />
      ) : (
        <Handle type="target" position={Position.Left} />
      )}
      {/*
        * ⚠ **ONE SOURCE HANDLE PER ARM, ONE PER ROW.** A branch with an
        * if/elif/else chain routes to a different place per arm, so one
        * unnamed handle cannot express it (CX-010). Dots sit on the row grid
        * (see `portTop`) like the inputs opposite them.
        *
        * ⚠ **The card GROWS for them now, and I-66 is why that is safe rather
        * than why it was forbidden.** This paragraph used to read "the card is
        * NOT allowed to grow for them, and that is I-66". I-66's rule is that
        * `stepNodes`' declared size, dagre's spacing and the card's own style
        * must AGREE — a card that outgrows its *declared* size attaches edges
        * to the wrong place with nothing flickering to say so. Crowding kept
        * them agreeing by never moving; `heightFor` keeps them agreeing by
        * moving all three together, and a five-arm chain stops stacking its
        * labels on top of each other. Past `MAX_NODE_H` it crowds again.
        */}
      {step.arms && step.arms.length > 1 ? (
        // ⚠ The arms name their OUTCOME on the wire (`ARM_LABEL` on the edge),
        // never beside the handle — two heads saying the same word is how a
        // relabelled edge stops agreeing with the dot it leaves from.
        step.arms.map((arm, i) => (
          <Handle
            key={arm.id}
            type="source"
            id={arm.id}
            position={Position.Right}
            style={{ top: portTop(step, i) }}
          />
        ))
      ) : step.outputHandles && step.outputHandles.length > 0 ? (
        // ⚠ **ONE SOURCE HANDLE PER CODE OUTPUT FIELD** — on the row grid
        // like arms (see `portTop`). The labels float beside the rows rather
        // than over the header, and rows concede right room while they exist.
        // A drag from one of these still creates a PLAIN edge: the
        // handle names a field, not a step, so `linkSource` falls back to the
        // card and no `sourceHandle` is ever persisted. (Arm handles above DO
        // persist — their ids are arm steps.)
        step.outputHandles.map((h, i) => (
          <Handle
            key={h.id}
            type="source"
            id={h.id}
            position={Position.Right}
            style={{ top: portTop(step, i) }}
          >
            <span
              aria-hidden={!canEditIo}
              className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap text-micro font-medium uppercase tracking-label text-dim"
            >
              {canEditIo && (
                <button
                  type="button"
                  title={`Remove output ${h.label}`}
                  aria-label={`Remove output ${h.label} from ${step.id}`}
                  onMouseDownCapture={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditStepIo?.("output", "remove", h.id);
                  }}
                  className="pointer-events-auto flex h-3.5 w-3.5 items-center justify-center rounded-full border border-line bg-surface text-micro leading-none text-dim opacity-0 transition group-hover:opacity-100 hover:border-danger/50 hover:text-danger focus-visible:opacity-100"
                >
                  −
                </button>
              )}
              {h.label}
            </span>
          </Handle>
        ))
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
      {/* Dify-style add: `code` cards grow their contract from the card. Bottom
          corners, overlaying the fixed card (I-66 — nothing resizes); visible
          on hover or while selected, like the card's delete. */}
      {canEditIo && (
        <button
          type="button"
          title={`Add input to ${step.id}`}
          aria-label={`Add input to ${step.id}`}
          onMouseDownCapture={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onEditStepIo?.("input", "add");
          }}
          className={`absolute bottom-1 left-1 rounded-full border border-line bg-surface px-1.5 py-px text-micro font-medium text-dim transition hover:border-accent/50 hover:text-accent focus-visible:opacity-100 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        >
          ＋ input
        </button>
      )}
      {canEditIo && (
        <button
          type="button"
          title={`Add output to ${step.id}`}
          aria-label={`Add output to ${step.id}`}
          onMouseDownCapture={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onEditStepIo?.("output", "add");
          }}
          className={`absolute bottom-1 right-1 rounded-full border border-line bg-surface px-1.5 py-px text-micro font-medium text-dim transition hover:border-accent/50 hover:text-accent focus-visible:opacity-100 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        >
          ＋ output
        </button>
      )}
    </div>
  );
}

/**
 * A loop's box (phase F, F4): a frame around the loop, the steps inside it and its output — the header names it and its
 * settings (or, on a run, its item counts). It is drawn, not authored: no handle, no selection, no pointer events.
 */
function LoopFrameNode({ data }: NodeProps<Node<{ frame: CanvasFrame }>>) {
  const f = data.frame;
  return (
    <div className="loop-frame h-full w-full overflow-hidden rounded-2xl" data-tone={f.tone ?? undefined} data-testid={`loop-frame-${f.id}`} aria-label={`${f.label}${f.detail ? ` — ${f.detail}` : ""}`}>
      <div className="loop-frame-head flex h-[22px] items-center gap-2 px-3 text-[11px]">
        <RefreshCw s={11} />
        <span className="font-semibold uppercase tracking-wide">{f.label}</span>
        {f.detail && <span className={f.tone === "danger" ? "text-danger" : f.tone === "warn" ? "text-warn" : "text-muted"} data-testid={`loop-frame-detail-${f.id}`}>{f.detail}</span>}
      </div>
    </div>
  );
}

const nodeTypes = { step: StepNode, loopFrame: LoopFrameNode };

// ── The edge ────────────────────────────────────────────────────────────────

/**
 * What the canvas hands an editable edge's component: the delete affordance
 * and whether the pointer is over the edge (so the affordance can appear
 * before the click that selects).
 */
type StepEdgeData = {
  /** Show the label always; false = only on hover or selection (a data link's words, phase Z). */
  labelAlways?: boolean;
  /** Present only on an editable surface — clicking it reports a disconnect. */
  onDelete?: () => void;
  /** Present only when the surface can splice a step in — clicking it opens the kind chooser. */
  onInsert?: (screenX: number, screenY: number) => void;
  /** True while the pointer is over the edge or has just left it (grace). */
  hovered?: boolean;
  /** On the hovered path: a glowing pulse travels the (solid) line, source → target. */
  flowing?: boolean;
};

/**
 * The pulse over a flowing link: a short bright streak on the same path, moving source → target, glowing. `pathLength` makes the
 * dash a share of the line whatever its length, so every link's pulse is the same size and takes the same time.
 */
function FlowPulse({ path, style }: { path: string; style?: React.CSSProperties }) {
  return <path d={path} pathLength={100} className="edge-pulse" style={{ ...style, ...pulseTiming(style) }} fill="none" aria-hidden />;
}

/** One slot of the hovered path's cycle: how long the pulse takes to cross one link. */
export const PULSE_SLOT_MS = 600;
/** The streak's length, as a share of a link (`pathLength` 100). */
const PULSE_LEN = 16;
/**
 * ONE pulse travels the whole hovered path (2026-09-29: "the loop is not synchronised — it should feel continuous"). Every link
 * shares one cycle, `slots × PULSE_SLOT_MS` long, where `slots` is the path's length in links; the link at place `k` carries the
 * pulse during slot `k` (its delay), so it hands on from link to link, start to end, and starts again. The dash pattern's period
 * is longer than the link plus the streak, so between its slots a link shows nothing, and the offset moves exactly one period per
 * cycle, so the loop has no seam.
 */
export function pulseTiming(style?: React.CSSProperties): React.CSSProperties {
  const vars = (style ?? {}) as Record<string, unknown>;
  const order = Number(vars["--flow-order"] ?? 0) || 0;
  const slots = Math.max(1, Number(vars["--flow-slots"] ?? 1) || 1);
  const period = 100 * slots + PULSE_LEN + 4;
  return {
    strokeDasharray: `${PULSE_LEN} ${period - PULSE_LEN}`,
    // The streak starts just BEFORE the link's start ([-len, 0)) and ends one whole period on, past its end.
    strokeDashoffset: PULSE_LEN,
    animationDuration: `${slots * PULSE_SLOT_MS}ms`,
    animationDelay: `${order * PULSE_SLOT_MS}ms`,
    ["--pulse-end" as string]: String(PULSE_LEN - period),
  } as React.CSSProperties;
}

/**
 * A link's geometry — ONE, on every surface. A link's shape says nothing about whether the canvas can be edited; that is what the
 * affordances say. It was chosen by `editable`, and `editable` turns off while an action is in flight or a build is drawing, so the
 * same flow flipped between curves and right-angled elbows as a person used it (reported 2026-09-30). The previews of a pending link
 * draw the same curve (`"default"` is the library's bezier) — they preview the link that will exist.
 */
const linkPath = (p: Parameters<typeof getBezierPath>[0]) => getBezierPath(p);

/** The read-only surfaces' edge: the canvas's one link geometry, plus the pulse when on the hovered path. */
function SmoothEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style, markerEnd }: EdgeProps<Edge<StepEdgeData>>) {
  const [path] = linkPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {data?.flowing && <FlowPulse path={path} style={style} />}
    </>
  );
}

/**
 * The editable surface's edge: a smooth bezier curve (the Langflow read — the
 * frozen mock draws soft S-curves, and the default smoothstep's hard elbows
 * read as corners the model does not have) with delete and insert affordances
 * at its midpoint, shown when the edge is selected or hovered.
 * ⚠ The affordance is portaled by `EdgeLabelRenderer` into the viewport
 * container, so it lives OUTSIDE the edge's SVG wrapper: it is positioned in
 * FLOW coordinates (the labelX/labelY the curve math returns) and scales with
 * the viewport like everything else on the canvas. `nodrag nopan` keep a drag
 * that starts on the button from panning the canvas.
 */
function StepEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  label,
  data,
  style,
  markerEnd,
}: EdgeProps<Edge<StepEdgeData>>) {
  const [path, labelX, labelY] = linkPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const showDelete = Boolean(data?.onDelete && (selected || data.hovered));
  const showInsert = Boolean(data?.onInsert && (selected || data.hovered));
  // The arm's outcome word (`ARM_LABEL`, set on the edge in the memo below).
  // Shown always, never only on hover — a case word that appears on hover is
  // a case word nobody reads. Offset above the midpoint while an affordance
  // shows, so the two never stack.
  // A data link's words (phase Z) show on hover or selection only — every wire labelled at once is noise; a condition's link, and
  // the arm's `case n`, always.
  const armWord = typeof label === "string" && label.length > 0 && (data?.labelAlways !== false || selected || data?.hovered) ? label : null;
  const caseWord = !!armWord && /^(case \d+|else)$/.test(armWord);
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {data?.flowing && <FlowPulse path={path} style={style} />}
      {armWord && (
        <EdgeLabelRenderer>
          <span
            className={
              caseWord
                ? "nodrag nopan pointer-events-none absolute rounded border border-line bg-surface px-1 py-px font-mono text-micro uppercase tracking-label text-dim"
                : "nodrag nopan pointer-events-none absolute max-w-[220px] truncate rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-muted shadow-sm"
            }
            title={armWord}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (showDelete || showInsert ? -18 : 0)}px)`,
            }}
          >
            {armWord}
          </span>
        </EdgeLabelRenderer>
      )}
      {showDelete && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Remove link"
            title="Remove this link (Delete)"
            onClick={(e) => {
              // A click that deletes is not a click that selects an edge.
              e.stopPropagation();
              data?.onDelete?.();
            }}
            className="nodrag nopan edge-delete-btn"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            <Trash s={11} />
          </button>
        </EdgeLabelRenderer>
      )}
      {showInsert && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label={`Insert a step between ${source} and ${target}`}
            title="Insert a step here"
            onClick={(e) => {
              // A click that inserts is not a click that selects an edge.
              e.stopPropagation();
              data?.onInsert?.(e.clientX, e.clientY);
            }}
            className="nodrag nopan edge-delete-btn"
            style={{
              position: "absolute",
              // Beside the delete button when both show, at the midpoint alone
              // otherwise — two buttons at the same point would stack.
              transform: `translate(-50%, -50%) translate(${labelX + (showDelete ? 24 : 0)}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            <Plus s={11} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
/**
 * The data-reference overlay's edge (Phase 4.2): a dashed, labelled, strictly
 * non-interactive wire from a producer to the selected consumer. It carries no
 * affordances, and its Edge object is `selectable: false, focusable: false,
 * deletable: false, reconnectable: false` plus filtering in `onDelete`, so the
 * overlay can never be edited, deleted, or re-pointed — it is a picture of
 * "which value is read", beside the "what runs next" the real edges draw.
 */
function DataRefEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<{ label: string }>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: "var(--dim)", strokeWidth: 1.5, strokeDasharray: "6 4" }}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan pointer-events-none absolute rounded border border-dashed border-line bg-surface-1 px-1 py-px font-mono text-micro text-muted"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * The in-flight connection line (Phase 4.3). The library reports the dragged
 * link's validity through `connectionStatus` — which is exactly what
 * `isValidConnection` below returns — and the only styling the repo gives an
 * illegal target is this line turning danger-red. Same dashed accent line as
 * the repo's CSS when the target is legal; the drop itself still reaches
 * `onConnect`, so the existing refusal banner names the reason unchanged.
 */
function RefusalConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  connectionStatus,
}: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition ?? Position.Right,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition ?? Position.Left,
  });
  return (
    <path
      d={path}
      fill="none"
      className="react-flow__connection-path"
      style={{ stroke: connectionStatus === "invalid" ? "var(--danger)" : "var(--accent)" }}
    />
  );
}

const edgeTypes = { step: StepEdge, smooth: SmoothEdge, dataRef: DataRefEdge };

// ── What a click gets you ────────────────────────────────────────────────────

/**
 * The panel under the graph, for the node that is selected.
 *
 * ── Why the canvas owns this rather than each page ───────────────────────────
 *
 * Clicking a node used to do different things on each of the four surfaces that
 * draw one: `/runs/[id]` selected a step and a detail panel further down the
 * page changed; `/flows/[id]` highlighted a row in the list below; `/flows/new`
 * did nothing at all. So on two of four screens a click appeared to do nothing,
 * and on a third the thing that changed was off-screen.
 *
 * This is the part every surface can answer, because it is a property of the
 * GRAPH rather than of the page: what this step is, what it acts on, what feeds
 * it, what it feeds, and the facts its adapter attached. `/runs/[id]`'s
 * `StepDetail` still shows the run's logs and output below — this does not
 * replace it, and deliberately does not duplicate it.
 *
 * ⚠ It renders the seam claim with the same wording and the same bound as the
 * badge and the legend. A third phrasing of "sends data to a model" is a third
 * thing to keep in step, which is how one of them quietly stops being true.
 */
function NodeDetails({
  node,
  edges,
  onClose,
}: {
  node: CanvasNode;
  edges: CanvasGraph["edges"];
  onClose: () => void;
}) {
  const k = kindOfNode(node);
  const feeds = edges.filter((e) => e.source === node.id).map((e) => e.target);
  const fedBy = edges.filter((e) => e.target === node.id).map((e) => e.source);
  const s = node.status ? STATUS[node.status] : null;

  return (
    <div className="pane px-3.5 py-3 text-xs">
      <div className="flex items-start gap-2">
        <span style={{ color: k.colour }} className="mt-0.5 shrink-0">
          <k.Icon s={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-body text-text">{node.label ?? node.id}</span>
            <span className="text-caption uppercase tracking-label text-dim">{k.label}</span>
            {s && <span className={`text-caption uppercase tracking-label ${s.text}`}>{s.label}</span>}
          </div>
          {node.ref && (
            <div className="mt-0.5 font-mono text-xs text-muted">{node.ref}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded px-1.5 py-0.5 text-caption text-dim hover:bg-surface-2 hover:text-text"
          aria-label="Close step details"
        >
          ✕
        </button>
      </div>

      {node.flag && (
        <p className="mt-2 rounded bg-danger-bg px-2 py-1 text-xs text-danger">{node.flag}</p>
      )}

      {/* ⚠ Said on the node a person clicked, not only in the legend. A six-task
          picture of a two-step flow reads as the product having invented four
          steps, and the answer belongs where they went looking for it. */}
      {node.platform && (
        <p className="mt-2 text-xs text-muted">
          A task the compiler emitted, not a step anyone wrote — the approval gate, the execution
          credential, or a pause. It is drawn rather than hidden because a run that failed here
          failed for an interesting reason.
        </p>
      )}

      {!!node.facts?.length && (
        <dl className="mt-2 space-y-1">
          {node.facts.map((f) => (
            <div key={f.label} className="flex gap-2">
              <dt className="w-[86px] shrink-0 text-caption uppercase tracking-label text-dim">
                {f.label}
              </dt>
              <dd className="min-w-0 flex-1 break-words text-xs text-muted">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* The graph relationship — the one thing only the picture knows, and the
          reason a click on the canvas is worth more than a click on the list. */}
      <div className="mt-2 space-y-1">
        <Relation label="fed by" ids={fedBy} />
        <Relation label="feeds" ids={feeds} />
      </div>

      {/*
        ⚠ 3.3a — the half that was missing. The node has been labelled `only if`
        for some time and NOTHING said what happens when the condition is false,
        so a reader could reasonably assume a second, unshown path. There is
        none. The text is `BRANCH_CAVEAT` rather than a sentence written here,
        for the reason `SEAM_CAVEAT` below it is: a claim shown in more than one
        place must have one wording.
      */}
      {/* ⚠ **SUPPRESSED ON A CHAIN, NOT DELETED.** `BRANCH_CAVEAT` says there
          is no "otherwise" branch and that everything else runs either way —
          true for a lone guard, and FALSE the moment an if/elif/else chain
          exists. Rendering it on a chain would be a claim the canvas itself
          contradicts two lines above, where the arms are drawn. Deleting it
          outright would drop a correct warning from every single-armed
          condition in the product. */}
      {node.kind === "branch" &&
        (node.arms && node.arms.length > 1 ? (
          <p className="mt-2 rounded border border-line bg-surface-2 px-2 py-1 text-xs text-muted">
            {`One decision, ${node.arms.length} outcomes. Each arm routes to its own steps; the first matching arm wins.`}
          </p>
        ) : (
          <p className="mt-2 rounded border border-line bg-surface-2 px-2 py-1 text-xs text-muted">
            {BRANCH_CAVEAT}
          </p>
        ))}

      {node.seam !== null && (
        <p className="mt-2 rounded border border-orange/30 bg-orange-bg px-2 py-1 text-xs text-muted">
          {node.seam === "unknown" ? (
            <>Its target could not be read, so whether it sends data to a model is <b>unknown</b> — treat it as unknown, not as safe.</>
          ) : (
            <>
              This step sends this workspace&rsquo;s data to an <b className="text-orange">external model</b>.{" "}
              {SEAM_CAVEAT}
            </>
          )}
        </p>
      )}
    </div>
  );
}

function Relation({ label, ids }: { label: string; ids: string[] }) {
  return (
    <div className="flex gap-2">
      <span className="w-[86px] shrink-0 text-caption uppercase tracking-label text-dim">{label}</span>
      <span className="min-w-0 flex-1 break-words font-mono text-xs text-muted">
        {/* "nothing" rather than an empty cell: on a DAG, that a step feeds
            nothing downstream is a fact worth reading — it is what makes an
            `llm_complete` step a leaf (D-34) and a gate at the end useless. */}
        {ids.length ? ids.join(", ") : <span className="font-sans text-dim">nothing</span>}
      </span>
    </div>
  );
}

// ── The nodes React Flow is handed ───────────────────────────────────────────

/**
 * The model, positioned, as React Flow nodes.
 *
 * ── ⚠ Why every node DECLARES its size, and why that is not decoration ───────
 *
 * This is the fix for the hover flicker, and the mechanism is worth writing down
 * because the symptom points nowhere near the cause.
 *
 * Hovering a node changes `litSet`, which rebuilds this array — every node a new
 * object. React Flow's `adoptUserNodes` compares by IDENTITY (`userNode ===
 * internals.userNode`), so a rebuilt array is a wholly new set of nodes to it,
 * and for each one it does two things:
 *
 *   * resets `measured` to `{ width: userNode.measured?.width, … }`, and
 *   * calls `parseHandles`, which returns `undefined` — throwing away the handle
 *     bounds it measured on mount — unless `userNode.measured` is set.
 *
 * `isNodeInitialized` then fails on both counts, `getEdgePosition` returns
 * `null`, and `EdgeWrapper` returns `null`: **every edge unmounts.** A
 * ResizeObserver re-measures a frame or two later and they all come back. That
 * cycle ran on every mouse enter AND every mouse leave, over every edge in the
 * graph — the flicker. It also ran once per poll on a live run, where the graph
 * legitimately changes, which is the same defect at a slower rate.
 *
 * Declaring the dimensions is not a workaround for a library bug. These cards
 * really are a fixed size, `layout()` really does space them by exactly this
 * pair, and measuring a box whose size is a compile-time constant was always the
 * long way round. With `measured` present, `parseHandles` keeps the bounds it
 * already has and nothing unmounts.
 *
 * ⚠ So the pair must stay true: if `StepNode` ever sizes itself by its content,
 * this declaration becomes a lie and edges will attach to the wrong place — a
 * quieter failure than the flicker was. `NODE_W`/`NODE_H` are the single source
 * for the card, dagre and this, and `FlowCanvas.test.tsx` pins that.
 */
export function stepNodes(
  steps: CanvasNode[],
  positions: Positioned[],
  opts: {
    selectedStepId?: string | null;
    litSet?: Set<string> | null;
    editable?: boolean;
    onDeleteStep?: (stepId: string) => void;
    /** Inline card rename — double-click commits through this. Absent ⇒ inspector-only rename. */
    onRenameStep?: (stepId: string, nextId: string) => void;
    /**
     * Add/remove a contract field from the card (`code` steps only — the card
     * decides that; every other kind renders no control). The page applies it
     * through the local-edit path, like rename. Absent ⇒ no I/O controls.
     */
    onEditStepIo?: StepIoEdit;
    draggable?: boolean;
    /**
     * Connect mode (the context menu's "Connect"): the node a link is being
     * started FROM. It gets a ring so the gesture has a subject.
     */
    connectingFrom?: string | null;
    /**
     * Connect/reroute mode: the node under the cursor, a valid target. It gets
     * a ring so the pending link's other end is visible before the click.
     */
    connectingTarget?: string | null;
    /** Reroute mode: `from` is the node whose edge is being re-pointed. */
    reroutingFrom?: string | null;
    depth?: "business" | "technical";
    flagCounts?: Map<string, number>;
    /** Ephemeral test pulsating */
    testing?: boolean;
    /**
     * T10 · the step ids the engine says are RUNNING right now. When non-null it
     * REPLACES the flow-wide `testing` flag for the pulse. A canvas where every
     * node pulses says the same thing at second one and second ninety, which is
     * no information — and it is a picture of a system that is not the one
     * executing.
     */
    movingIds?: Set<string> | null;
    /**
     * Phase 3: precomputed `stepState` results keyed by step id, read by the
     * card's ONE badge. Absent ⇒ each card keeps today's run-status word, so
     * the canvas works before parents wire it.
     */
    stepStates?: StepStateBadges;
  } = {},
): Node<StepNodeData>[] {
  const { selectedStepId, litSet, editable, onDeleteStep, onRenameStep, onEditStepIo, draggable, connectingFrom, connectingTarget, reroutingFrom, depth = "business", flagCounts, testing, movingIds, stepStates } = opts;
  const at = new Map(positions.map((p) => [p.id, p]));
  return steps.map((n) => {
  /**
   * ⚠ **THE BOUNDARY IS NOT A STEP, so every step affordance is withheld here
   * rather than declined inside the card.** It has no revision row to rename,
   * nothing to delete and no I/O to edit — a card offering any of those would
   * be a control whose only possible outcome is a refusal.
   *
   * ⚠ It is also not `connectable`: an edge drawn FROM it is already there
   * (`withStart` wires every root) and an edge drawn INTO it would be a step
   * running before the flow starts. React Flow enforces neither on its own.
   */
  const boundary = n.boundary != null;
  return ({
    id: n.id,
    type: "step",
    position: { x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 },
    // A pending link's ends are ringed on the card itself — the mode's subject
    // and the hovered candidate — so the gesture reads before the click lands.
    className:
      n.id === connectingFrom || n.id === reroutingFrom
        ? "node-link-source"
        : n.id === connectingTarget
          ? "node-link-target"
          : undefined,
    // ⚠ Selection carried at BOTH levels, browser-verified 2026-08-12.

    selected: selectedStepId === n.id,
    // `@xyflow/react` v12.s `adoptUserNodes` rebuilds its internal nodes from
    // this array on every render; a node whose top-level `selected` is unset
    // silently resets the library's own selection, so a click never stuck and
    // Backspace-delete found nothing to delete. The top-level flag re-applies
    // the model's selection on every rebuild; `data.selected` stays for the
    // card's own highlight.
    data: {
      step: n,
      selected: selectedStepId === n.id,
      lit: !litSet || litSet.has(n.id),
      // The card's own delete button — only ever wired in edit mode, and only
      // for the step it is drawn on: a card with a delete affordance that
      // deletes a different step is the `faFallback` failure in a new costume.
      onDelete: editable && !boundary && onDeleteStep ? () => onDeleteStep(n.id) : undefined,
      // The card's inline rename — only ever wired in edit mode, like delete.
      onRename:
        editable && !boundary && onRenameStep
          ? (nextId: string) => onRenameStep(n.id, nextId)
          : undefined,
      // The card's I/O controls — only ever wired in edit mode, like delete.
      // The card itself decides the kind gate (`code` only); every other kind
      // renders no control even with this present.
      onEditStepIo:
        editable && !boundary && onEditStepIo
          ? (which, op, name) => onEditStepIo(n.id, which, op, name)
          : undefined,
      depth,
      flagCount: flagCounts?.get(n.id) ?? (n.flag ? 1 : undefined),
      // Per-step once the run has reported anything; the flow-wide flag only
      // covers the second or two before the first status arrives.
      testing: movingIds ? movingIds.has(n.id) : testing,
      // Phase 3: the card's ONE badge. A boundary is not a step and carries no
      // state, so it never gets one even when the record names it.
      stateBadge: !boundary ? stepStates?.[n.id] : undefined,
    },
    // See the docblock. `measured` is what preserves the handle bounds across a
    // rebuild; `width`/`height` are React Flow's documented way to declare a
    // fixed-size node, and give the wrapper its box before first paint.
    measured: { width: widthFor(n), height: heightFor(n) },
    width: widthFor(n),
    height: heightFor(n),
    // Draggable only when the surface owns arrangement (D-151) — the presence
    // of `onMoveStep` on the canvas, which means the page will persist (or
    // session-keep) the result. `editable` does NOT imply draggable: FlowReview
    // before Phase 5 may edit structurally without owning positions, and the
    // run page owns neither. See the component docblock. Start and End move like any card (2026-09-29): where they sit is
    // arrangement too, saved under their own ids — they stay undeletable and unconnectable, which is what makes them boundaries.
    draggable: !!draggable,
    connectable: !!editable && !boundary,
    deletable: !boundary,
    // Focusable, so the graph is reachable without a mouse. Nodes are emitted
    // in topological order (`canvas-model.ts` sorts them), so Tab walks the
    // flow in execution order rather than in whatever order dagre happened to
    // place them.
    focusable: true,
    ariaLabel: boundary
      ? // The declaration, read out. Each boundary's whole purpose is a fact
        // that was invisible, so the non-visual reading must carry it too —
        // and it must name WHICH boundary, or the two read identically.
        `${n.boundary === "end" ? "End" : "Start"}, ${n.meta ?? BOUNDARY_KIND[n.boundary!].label}${
          n.facts?.length ? `: ${n.facts.map((f) => `${f.label} ${f.value}`).join("; ")}` : ""
        }`
      : `${n.id}, ${kindOf(n.kind, n.platform).label}${n.ref ? `, ${n.ref}` : ""}${
          n.status ? `, ${STATUS[n.status].label}` : ""
        }${n.seam && n.seam !== "unknown" ? ", sends data to a model" : ""}`,
  });
  });
}

/**
 * Echo ephemeral drag positions over the memoised nodes — the AFTER half of
 * the layout memo (I-66), called by `displayNodes` inside `Canvas`.
 *
 * Identity-stable when empty (`dragPos.size === 0` returns `nodes` untouched),
 * so status-only polls rebuild nothing. A dragged node keeps everything
 * `stepNodes` gave it and gains the live position plus the `node-dragging`
 * ring the drop indicator styles.
 */
export function applyDragPositions(
  nodes: Node<StepNodeData>[],
  dragPos: Map<string, { x: number; y: number }>,
): Node<StepNodeData>[] {
  if (dragPos.size === 0) return nodes;
  return nodes.map((n) => {
    const d = dragPos.get(n.id);
    if (!d) return n;
    return {
      ...n,
      position: d,
      className: n.className ? `${n.className} node-dragging` : "node-dragging",
    };
  });
}

// ── The canvas ───────────────────────────────────────────────────────────────

export type FlowCanvasProps = {
  graph: CanvasGraph;
  selectedStepId?: string | null;
  onSelect?: (stepId: string) => void;
  /** Drives the crawling edges. Only ever true on a live execution. */
  live?: boolean;
  /** Ephemeral test pulsating data flow */
  testing?: boolean;
  /**
   * How much room this surface can afford to give the graph. **D-102** — the
   * page declares what its layout can afford.
   *
   * ⚠ There is no `height`. It was removed rather than deprecated: left beside
   * this it is the escape hatch every call site reaches for, and the six
   * literals come straight back. An honesty assertion keeps it gone.
   */
  density?: CanvasDensity;
  /**
   * Immersive workbenches only (mock D-27): the canvas fills its pane instead
   * of the density's fixed height. `density` stays the floor — `minHeight` —
   * so the folded/narrow cases still give the graph its named minimum rather
   * than crushing it.
   */
  fill?: boolean;
  /**
   * The NodeDetails panel under the graph. ON by default for the canvases that
   * own local selection (/runs, /flows/[id]); the workbenches pass `false` —
   * there the selected node's inspector pane IS the node info, and a second
   * copy of it at the canvas bottom is the overlap D-28 removed.
   */
  details?: boolean;
  /**
   * What is on the surface — *"Draft v3"*, *"Run"*. Rendered in the canvas's own
   * toolbar, which is **not** the page breadcrumb (D-79, plan 5.2): the page
   * crumb says which URL you are at, this says which graph you are looking at.
   *
   * ⚠ It is one label and is deliberately not dressed up as a trail. A crumb
   * STACK needs a second level to push, and nesting has no subject yet (D-103);
   * a one-item breadcrumb with separators would be a control that never moves.
   */
  title?: string;
  /**
   * Where the canvas's own controls sit (2026-10-10). "bar" (default): a title row above the graph. "float": no row —
   * fit / zoom / re-arrange float in the corner, for a surface whose title already lives in the page's one header.
   */
  chrome?: "bar" | "float";
  /**
   * Stage 5. Turns on connecting and deleting — never saving: the handlers
   * below report an intent and the page applies it through
   * `lib/flow-authoring.ts`, which is where every rule lives.
   */
  editable?: boolean;
  /**
   * Stage 5. Turns on connecting and deleting — never saving: the handlers
   * below report an intent and the page applies it through
   * `lib/flow-authoring.ts`, which is where every rule lives.
   *
   * ⚠ `from` is the MODEL step the link leaves — usually the card, but an arm
   * handle resolves to its arm step (the elif, not the head), so the page's
   * `connect` lands the target inside the drawn arm. A code field handle is
   * NOT resolved (a field is not a step): it falls back to the card.
   */
  onConnectSteps?: (from: string, to: string) => void;
  /**
   * Bindable input names per step id — one target handle per entry, drawn by
   * the card at fractional offsets inside its existing height.
   *
   * ⚠ Merged onto the nodes AFTER the layout memo, never in its key (I-66):
   * handles crowd rather than resize, and `measured`/`width`/`height` are
   * untouched. A step missing from the map — no catalogue, no known fields —
   * keeps its single unnamed target, exactly as before.
   */
  inputHandles?: Map<string, StepPorts>;
  /**
   * A drop onto a NAMED target handle — `(from, to, field)`.
   *
   * ⚠ `from` is already `linkSource`-resolved, so a drop from an arm handle
   * onto a field carries BOTH ends (the arm step, and the named input). The
   * surface binds that input through the same builders the inspector's picker
   * uses (`lib/flow-field-drop.ts`). Absent — or a drop onto the unnamed
   * target — ⇒ the plain `onConnectSteps` path above.
   */
  onConnectToField?: (from: string, to: string, field: string) => void;
  /**
   * A step is to be removed (Backspace on the selection, or the card's own
   * delete button). Delivered from ONE `onDelete` event per gesture (see the
   * ReactFlow wiring) — never paired with per-edge disconnects for the same
   * gesture, so a delete stays a single undo op. The page removes the step
   * through `removeStep`, which drops its attached edges too.
   */
  onDeleteStep?: (stepId: string) => void;
  /**
   * A bare edge is to be removed — Backspace while ONLY an edge is selected.
   * The page applies `disconnect`, which is the same op a node delete would
   * have gone through. Edges attached to a deleted node are NOT reported here
   * (the node's own removal takes them with it).
   */
  onDisconnectSteps?: (from: string, to: string) => void;
  /**
   * Data-reference overlay context (Phase 4.2): the authored steps and the
   * catalogue slice `stepIo` reads, so the canvas can draw which value the
   * selected step reads. Absent ⇒ the toggle is hidden and no overlay edge
   * is drawn — a surface without the model must never picture it.
   */
  dataRefs?: { steps: AuthoredStep[]; catalogue: IoCatalogue };
  /**
   * Re-point an edge (D-154): a reconnect event gives the OLD edge and the NEW
   * connection; the page applies `disconnect(old)` then `connect(new)` through
   * the pure ops, so the four refusals apply to the new end exactly as they do
   * to a fresh drag. Absent ⇒ edges cannot be re-pointed.
   */
  onRerouteStep?: (from: string, to: string, nextFrom: string, nextTo: string) => void;
  /**
   * Add a step at a canvas point — the double-click gesture (D-152) and the
   * right-click "Add step here" menu, both owned by the canvas. `screenX/Y`
   * are viewport pixels (the menu the canvas renders is positioned at them);
   * `x/y` are FLOW coordinates, the point the new step is pinned to; `kind`
   * is the kind picked from the canvas's inline kind chooser. The page owns
   * the `addStep` op; the canvas only reports.
   */
  onAddAt?: (point: { screenX: number; screenY: number; x: number; y: number; kind: StepKind; ref?: string }) => void;
  /**
   * Right-click "Add step after": insert a NEW step of `kind` downstream of
   * `stepId` — it depends on that step. The kind is chosen from the canvas's
   * inline kind chooser (the same eight kinds the palette offers). Absent ⇒
   * the menu item is not offered.
   */
  onAddStepAfter?: (stepId: string, kind: StepKind, ref?: string) => void;
  /**
   * Mid-edge `+`: splice a NEW step of `kind` between `from` and `to` — it
   * depends on `from`, `to` is re-pointed at it, the old link is dropped. The
   * kind is chosen from the edge's inline kind chooser (the same eight kinds
   * the palette offers). The page applies disconnect+connect+add through the
   * pure ops, so the refusals apply exactly as they do to a fresh drag.
   * Absent ⇒ no `+` affordance.
   */
  onInsertStep?: (from: string, to: string, kind: StepKind, ref?: string) => void;
  /**
   * The refs a given kind may name, for the add menus — `null` when this
   * surface has no catalogue to offer.
   *
   * ⚠ **This exists because the menu offered kinds the surface could not add.**
   * A `tool`/`datasource`/`query` step is only valid once it names a ref, so on
   * a surface that writes a revision per gesture (the chat workbench) picking
   * one of them from a flat kind list produced a blank step, a refused save,
   * and an error message — for ten of the seventeen entries. The menu was
   * advertising capability it did not have.
   *
   * Returning `[]` is a real answer and different from `null`: it means this
   * workspace has registered nothing of that kind, which the menu says in
   * words instead of offering a dead end.
   */
  addableRefs?: (kind: StepKind) => Array<{ ref: string; label: string; hint?: string | null }> | null;
  /**
   * Add/remove a contract field from a `code` card: `(stepId, which, op, name)`.
   * Wired into node data in edit mode like `onRenameStep`; the card renders
   * the controls for `code` steps only. Absent ⇒ no I/O controls.
   */
  onEditStepIo?: StepIoEdit;
  /**
   * Inline card rename: double-click commits `(stepId, nextId)`. The page
   * applies the same `replaceStep` the inspector's Step ID field uses, so the
   * allowlist and the position re-key are the same edit. Absent ⇒ the card
   * title is not editable and rename stays inspector-only.
   */
  onRenameStep?: (stepId: string, nextId: string) => void;
  /**
   * Right-click "Duplicate": copy `stepId` under a NEW id, with every field
   * of the original — a copy of the step, never a re-parenting of its
   * successors. The page applies `duplicateStep` and persists. Absent ⇒ the
   * menu item is not offered.
   */
  onDuplicateStep?: (stepId: string) => void;
  /**
   * Palette drag-and-drop (HTML5): a palette row carrying
   * `application/x-foundry-step` is dropped on the canvas. `kind` is the step
   * kind; `ref` is the concrete catalogue ref when the row carried one
   * (tool/datasource/query), else null. `x/y` are FLOW coordinates for the
   * new step. Absent ⇒ the canvas is not a drop target.
   */
  onDropStep?: (kind: StepKind, ref: string | null, x: number, y: number) => void;
  /**
   * The saved arrangement — `flow_step_positions`, OUTSIDE the model and the
   * revision (plan decision ②, D-150). Keyed by step id. A step with a row sits
   * where the row says; one without is placed by the nearest-neighbour rule;
   * a graph with no rows at all is dagre's, unchanged.
   *
   * ⚠ This is a VIEW of the positions table, never a source of truth in itself.
   * The page loads it and hands it here; the canvas reads it and no more.
   */
  positions?: Map<string, SavedPosition> | null;
  /**
   * The arrangement switch (D-151). Present ⇒ the cards are draggable and a
   * drag-end reports `(stepId, x, y)` for the page to persist or session-keep.
   * Absent ⇒ the same saved arrangement renders with the cards pinned (run
   * page, flow page before Phase 5). This is deliberately NOT `editable`:
   * structural editing and arrangement ownership are different powers.
   */
  onMoveStep?: (stepId: string, x: number, y: number, all?: Map<string, SavedPosition>) => void;
  /**
   * "Re-arrange" — D-150(e). The page drops ALL rows (PUT empty set) and the
   * graph returns to dagre. The canvas shows the button whenever this handler
   * is present AND at least one row exists; after a re-arrange there is nothing
   * to reset, so it hides again.
   */
  onRearrange?: () => void;
  /** Clicking empty canvas. Closes the details panel; never changes the model. */
  onDeselect?: () => void;
  /** S-11: Business vs Technical depth — swaps second label line per node. */
  depth?: "business" | "technical";
  /** S-07: the step the initial viewport anchors on — first needing decision, once per mount. */
  anchorStepId?: string | null;
  /** Render `.dot-grid` ground (S-07) when true. */
  dotGrid?: boolean;
  /** B-11/B-12 per-revision phase/flag reads — when flowId+revision supplied canvas fetches phases/flags itself */
  flowId?: string;
  revision?: string | number;
  /** Explicit phases override fetch (background frames, not groups) */
  phases?: Array<{ id: string; label: string; ordinal: number }>;
  /** Explicit flag counts per step id (dot badge) */
  flagCounts?: Map<string, number>;
  /**
   * Phase 3: precomputed `stepState` results keyed by step id. The parent owns
   * the inputs (findings, broken refs, last run, draft revision, flags) and
   * computes this once; every card reads its own entry. Absent ⇒ today's
   * run-status words, so the canvas works before parents wire it.
   */
  stepStates?: StepStateBadges;
  /**
   * The flow is being BUILT (phase 4, D-247): newly seen nodes enter one after
   * another and a new link draws itself once both ends have landed. The steps are
   * real; only their appearance is sequenced. See `lib/canvas-reveal.ts`.
   */
  reveal?: boolean;
  /**
   * An EMPTY canvas is waiting on a build (the "appear within seconds" wording). Defaults to `reveal`; a surface that reveals
   * every time it loads (the engine panes, so a ready flow enters the same way a building one does) says it separately.
   */
  building?: boolean;
  /**
   * Tween node positions when the layout moves instead of jumping — edges follow,
   * because React Flow draws them from node positions. Off wherever a person drags.
   */
  glide?: boolean;
  /** The outline stage: steps are chosen but not wired, drawn as dashed cards. */
  sketch?: boolean;
};

/**
 * One button in the canvas toolbar. Icon plus an `aria-label`, never an icon
 * alone: a control whose only name is a glyph is a control a screen reader
 * announces as "button".
 */
function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded p-1 text-dim transition hover:bg-surface-2 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
    >
      {children}
    </button>
  );
}

function Canvas({
  graph,
  selectedStepId,
  onSelect,
  live,
  testing,
  density = "compact",
  fill = false,
  title,
  chrome = "bar",
  editable,
  onConnectSteps,
  inputHandles,
  onConnectToField,
  onDisconnectSteps,
  onDeleteStep,
  onRerouteStep,
  onAddAt,
  onAddStepAfter,
  onInsertStep,
  addableRefs,
  onRenameStep,
  onEditStepIo,
  onDuplicateStep,
  onDropStep,
  positions,
  onMoveStep,
  onRearrange,
  onDeselect,
  depth = "business",
  anchorStepId,
  dotGrid,
  flowId,
  revision,
  phases: phasesProp,
  flagCounts: flagCountsProp,
  stepStates,
  dataRefs,
  reveal = false,
  glide = false,
  sketch = false,
}: FlowCanvasProps) {
  const { fitView, zoomIn, zoomOut, screenToFlowPosition, setCenter } = useReactFlow();
  /**
   * ⚠ Ephemeral drag positions — VIEW state, not model (D-51's actual reading,
   * 2026-09-03). D-51 forbids a node carrying `x`/`y` in the AUTHORED MODEL;
   * this map never reaches the model, the revision, or `flow_step_positions`
   * — it lives for the gesture and is cleared at drag stop (below) and whenever
   * the committed arrangement arrives through `positions`. Anyone reading D-51
   * as "the canvas may not hold positions in React state" has it backwards:
   * without somewhere to hold the drag, the gesture has nowhere to live and
   * the node appears at its new place only when it ends.
   */
  const [dragPos, setDragPos] = useState<Map<string, { x: number; y: number }>>(new Map());

  const [hovered, setHovered] = useState<string | null>(null);
  /**
   * The data-reference overlay toggle (Phase 4.2). Persisted at
   * `SHOW_DATA_REFS_KEY`, read lazily so the first paint matches the stored
   * choice. View state only: it changes which edges are drawn, never the flow.
   */
  const [showDataRefs, setShowDataRefs] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SHOW_DATA_REFS_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleDataRefs = useCallback(() => {
    setShowDataRefs((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SHOW_DATA_REFS_KEY, next ? "true" : "false");
      } catch {
        // Storage unavailable (private mode, SSR) — the toggle still works
        // for the session; persistence is a convenience, not the feature.
      }
      return next;
    });
  }, []);
  // B-11/B-12 per-revision frames — background divs not groups, 56px lane gap, FlagMark greyscale audit
  const [phases, setPhases] = useState<Array<{ id: string; label: string; ordinal: number }> | null>(phasesProp ?? null);
  const [flagCounts, setFlagCounts] = useState<Map<string, number> | null>(flagCountsProp ?? null);
  useEffect(() => {
    if (phasesProp) { setPhases(phasesProp); return; }
    if (!flowId || revision == null) return;
    let cancelled = false;
    listPhases(flowId, revision).then((p: FlowPhase[]) => { if (!cancelled) setPhases(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [flowId, revision, phasesProp]);
  useEffect(() => {
    if (flagCountsProp) { setFlagCounts(flagCountsProp); return; }
    if (!flowId || revision == null) return;
    let cancelled = false;
    listFlags(flowId, revision).then((res: { flags: Array<{ stepNumber: number | null; status: string }> }) => {
        if (cancelled) return;
        const m = new Map<string, number>();
        const byOrdinal = new Map<number, string>();
        for (const n of graph.nodes) if (n.ordinal != null) byOrdinal.set(n.ordinal, n.id);
        for (const f of res.flags) {
          if (f.status !== "open") continue;
          if (f.stepNumber == null) continue;
          const sid = byOrdinal.get(f.stepNumber);
          if (!sid) continue;
          m.set(sid, (m.get(sid) ?? 0) + 1);
        }
        if (m.size === 0 && res.flags.length === 0) setFlagCounts(new Map());
        else setFlagCounts(m);
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [flowId, revision, flagCountsProp, graph.nodes]);
  /**
   * The selected EDGE, controlled like the selected node: the canvas's own
   * delete affordance and the library's Backspace both read it, and the edges
   * array re-declares it on every rebuild so the selection survives
   * `adoptUserEdges` (the same mechanism as the node selection fix above).
   */
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  /** The edge under the pointer, with a short grace so the delete button stays
      reachable after the pointer leaves the path to travel to it. */
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const edgeHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setEdgeHover = useCallback((id: string | null) => {
    if (edgeHoverTimer.current) clearTimeout(edgeHoverTimer.current);
    edgeHoverTimer.current = setTimeout(() => setHoveredEdge(id), id ? 0 : 300);
  }, []);
  const wrap = useRef<HTMLDivElement>(null);

  /**
   * The canvas-owned context menu (right-click on a node or on empty canvas,
   * the double-click add gesture, and the mid-edge `+`). `kind: "node"` is a
   * node's action menu; `kind: "pane"` is the empty-canvas "add step here"
   * menu; `kind: "edge"` is the edge's "insert a step here" kind chooser,
   * carrying the edge ends the pick is spliced between. `x/y` are FLOW
   * coordinates for the pane menu — the point a new step is pinned to.
   */
  const [menu, setMenu] = useState<
    | { kind: "node"; nodeId: string; screenX: number; screenY: number }
    | { kind: "pane"; screenX: number; screenY: number; x: number; y: number }
    | { kind: "edge"; source: string; target: string; screenX: number; screenY: number }
    | null
  >(null);
  /** The kind chooser open inside the menu — "add step after", "add step here", or the edge insert. */
  const [submenu, setSubmenu] = useState<"node" | "pane" | null>(null);
  /** Connect mode: a link is being started FROM this node — the next node
      clicked becomes the target. Replaces the handle-drag affordance when the
      gesture is started from the menu. */
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  /**
   * Reroute mode: the edge being re-pointed, `from` being the node the user
   * right-clicked. The next node clicked becomes the other end — the old edge
   * is replaced through `onRerouteStep`, which the page applies as
   * disconnect(old) + connect(new) through the pure ops.
   */
  const [reroute, setReroute] = useState<{ from: string; source: string; target: string } | null>(null);
  /** A palette row is dragging over the canvas — the drop-target ring. */
  const [dragOver, setDragOver] = useState(false);
  /** The seam legend chip's own tooltip — see its render site below. */
  const [seamTooltipOpen, setSeamTooltipOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setSubmenu(null);
  }, []);
  const cancelModes = useCallback(() => {
    setConnectFrom(null);
    setReroute(null);
  }, []);

  // fill => 100% of Workbench pane (flex 1), not full viewport.
  const height = fill ? "100%" : DENSITY[density].height;

  // The hover highlight's subject: everything upstream and downstream of the
  // node under the cursor. The single most useful affordance on a DAG — "what
  // does this feed, and what feeds it" is the question a reviewer is holding —
  // and it costs one graph walk.
  const litSet = useMemo(
    () => (hovered ? connectedTo(hovered, graph.edges) : null),
    [hovered, graph.edges],
  );
  /** Where each lit node sits along the path, so the flowing edges fade in from start to finish. */
  const litDepth = useMemo(() => (litSet ? pathDepths(litSet, graph.edges) : null), [litSet, graph.edges]);
  /** The hovered path's length in links — the pulse's cycle is this many slots long. */
  const litSlots = useMemo(() => (litDepth ? Math.max(1, ...litDepth.values()) : 1), [litDepth]);

  /**
   * The field ports merged into the nodes BEFORE the layout. A card draws a row per input (`keyRows` counts them), so the layout
   * must size it with them: merged after, the layout spaced a header-only card while the card drew every row, and cards spawned
   * onto each other (reported 2026-09-30). The row counts are in `portSig`, so the layout re-runs only when a count changes.
   */
  const sized = useMemo(() => {
    return inputHandles
      ? graph.nodes.map((n) => {
          const h = inputHandles.get(n.id);
          if (!h) return n;
          // Bound-first for the drawn rows (Dify read: wires and values before
          // the unconfigured). Stable within a state, so catalogue order is
          // the tiebreak. Rows AND dots both read this order — one place, no
          // drift. Reordering keeps the count, so the arrangement moves only when a count does.
          const rank = (s: FieldPort["source"]) =>
            s.kind === "step" || s.kind === "whole" ? 0 : s.kind === "literal" || s.kind === "input" || s.kind === "self" ? 1 : 2;
          const fields = h.fields
            .map((f, i) => ({ f, i }))
            .sort((a, b) => rank(a.f.source) - rank(b.f.source) || a.i - b.i)
            .map(({ f }) => f);
          return { ...n, inputHandles: fields, wholeFrom: h.wholeFrom, bindable: h.bindable };
        })
      : graph.nodes;
  }, [graph.nodes, inputHandles]);

  /**
   * ⚠ **The topology, and it is the memo key for everything expensive.**
   *
   * `graph` is built by an adapter, and every one of its call sites used to
   * build it inline during render — so on a live run each poll produced a new
   * array, dagre re-laid-out the whole graph, and every card re-rendered
   * although nothing but a status had moved.
   *
   * Keying on the ids and the edges is not an approximation: `layout()` reads
   * node ids, edge endpoints, the two constants (`NODE_W`, `NODE_H`) and — since
   * Phase 2 (D-150) — the saved `positions`. The positions are folded into the
   * key as a sorted signature so a drag that changes one row re-lays-out and a
   * status-only poll does not. If layout ever reads anything else, this key has
   * to grow the same day — the comment is here because the failure would be
   * silent and would look like "sometimes the boxes overlap".
   */
  /**
   * ⚠ **THE LABELS ARE IN THE KEY BECAUSE `layout()` READS THEM NOW.** The
   * comment above says this key "has to grow the same day" if layout ever reads
   * anything else, and names the exact symptom — *"sometimes the boxes
   * overlap"*. `widthFor` sizes a card from its name, so a rename changes the
   * layout; without the label here, renaming a step would leave dagre spacing
   * the old width while the card draws the new one.
   */
  /**
   * ⚠ The PORT COUNTS, for the same reason the labels are here: `heightFor`
   * sizes a card by how many handles it draws, so adding an output to a `code`
   * step changes the layout. Without this, dagre would keep spacing the old
   * height while the card draws the new one.
   */
  const portSig = (n: CanvasNode) =>
    `${n.inputHandles?.length ?? 0},${n.arms?.length ?? 0},${n.outputHandles?.length ?? 0}`;

  const topology =
    sized.map((n) => `${n.id}~${n.label ?? ""}~${portSig(n)}`).join("|") +
    "»" +
    graph.edges.map((e) => `${e.source}:${e.sourceHandle ?? ""}>${e.target}`).join("|") +
    "»" +
    (positions
      ? [...positions.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, p]) => `${id}:${p.x},${p.y}`)
          .join("|")
      : "") +
    "»" +
    (graph.frames ?? []).map((f) => `${f.id}[${f.members.join(",")}]`).join("|");

  /**
   * ⚠ THE DRAG FIX, second half (2026-08-13): the SHAPE of the graph, without
   * the arrangement. `topology` deliberately includes positions, because
   * `layout()` re-runs when a drag changes one row — but REFITTING the view
   * must not. The old fit effect keyed on `topology`, so every drag-end
   * re-fitted the viewport with a 200ms animation: the picture translated and
   * zoomed under the cursor at the exact moment someone was placing a card,
   * which read exactly like "dragging a node pans the viewport". Fit follows
   * structure alone — a step added, removed or rewired — never a drag.
   *
   * ⚠ One count rides along: how many position ROWS exist. The arrangement
   * arrives AFTER the mount fit (the page loads it beside the graph), and a
   * graph that re-lays-out into saved spots without a refit can end up half
   * outside the canvas. A drag changes a row's COORDINATES, never its count,
   * so the count is the boundary that separates "the picture changed shape"
   * from "a card was placed": first load (0→N), add-step (N→N+1) and
   * re-arrange (N→0) all refit; a drag-end does not.
   */
  const structure =
    graph.nodes.map((n) => n.id).join("|") +
    "»" +
    graph.edges.map((e) => `${e.source}:${e.sourceHandle ?? ""}>${e.target}`).join("|");
  const positionCount = positions ? positions.size : 0;
  const fitKey = `${structure}»${positionCount}`;

  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `topology`; see above.
  const laidOut = useMemo(() => layout(sized, graph.edges, positions, graph.frames), [topology, positions]);

  /**
   * T10 · which parts of the picture are moving, derived from the run's own
   * per-step statuses rather than from a flow-wide flag.
   *
   * ⚠ Null until the run reports its FIRST status, and only then does the
   * blanket animation stand down. "Started, nothing reported yet" is a real
   * state that lasts a second or two, and a dead canvas through it reads as a
   * run that never began.
   */
  const moving = useMemo(() => (awaitingFirstStatus(graph) ? null : movingNodes(graph)), [graph]);
  const movingEdgeIds = useMemo(
    () => (awaitingFirstStatus(graph) ? null : movingEdges(graph)),
    [graph],
  );

  const nodes = useMemo(() => {
    return stepNodes(sized, laidOut, {
      selectedStepId,
      litSet,
      editable,
      onDeleteStep,
      onRenameStep,
      onEditStepIo,
      draggable: !!onMoveStep,
      connectingFrom: connectFrom,
      connectingTarget: connectFrom && hovered && hovered !== connectFrom ? hovered : null,
      reroutingFrom: reroute ? reroute.from : null,
      depth,
      flagCounts: flagCounts ?? undefined,
      testing,
      movingIds: moving,
      stepStates,
    });
  }, [
    graph.nodes,
    laidOut,
    selectedStepId,
    litSet,
    editable,
    onDeleteStep,
    onRenameStep,
    onEditStepIo,
    onMoveStep,
    connectFrom,
    reroute,
    hovered,
    depth,
    flagCounts,
    testing,
    moving,
    stepStates,
    inputHandles,
    sized,
  ]);

  /**
   * The drag's live echo. React Flow owns the pointer; with `nodes` controlled
   * and no `onNodesChange`, its internal position was overwritten on every
   * render and the node jumped only at drag stop. Recording `position` changes
   * here — while `dragging` — gives the gesture somewhere to live WITHOUT
   * touching the layout memo above (I-66): `displayNodes` overlays this map
   * after it. The single writer stays `onMoveStep`, called once at drag stop.
   */
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!onMoveStep) return;
      setDragPos((prev) => {
        let next: Map<string, { x: number; y: number }> | null = null;
        for (const c of changes) {
          if (c.type !== "position" || !c.dragging || !c.position) continue;
          if (!next) next = new Map(prev);
          next.set(c.id, { x: c.position.x, y: c.position.y });
        }
        return next ?? prev;
      });
    },
    [onMoveStep],
  );

  // The committed arrangement arrives through `positions` — a drag that changed
  // one row re-lays-out through the topology memo — so any echo still held is
  // stale by definition. (`positions` is a stable reference between commits on
  // every surface, so this never fires mid-gesture.)
  useEffect(() => {
    setDragPos(new Map());
  }, [positions]);

  /**
   * Which MODEL step a dragged link leaves. An arm handle carries its arm
   * step's id (the elif, not the head) — resolving it here keeps every
   * surface's `connect`/`disconnect` unchanged and lands the target inside
   * the drawn arm (`armMembership` is transitive over `dependsOn`, and
   * `collapseArms` draws the edge back from the head with the arm named).
   * Anything else — no handle, or a code field handle, which names a field
   * and not a step — is the card itself.
   */
  const linkSource = (source: string, sourceHandle?: string | null): string =>
    sourceHandle && graph.nodes.find((n) => n.id === source)?.arms?.some((a) => a.id === sourceHandle)
      ? sourceHandle
      : source;
  /**
   * The canvas model as a flow, for drag-time refusal (Phase 4.3). Rebuilt when
   * the drawn shape changes — the same picture the drop lands on, so a drag is
   * judged on what the person sees.
   */
  const modelFlow = useMemo(() => refusalFlowForGraph(graph), [graph]);

  /**
   * Refuse during the drag (Phase 4.3): the same four refusals `connect()`
   * returns — self, unknown end, duplicate, cycle — through the shared pure
   * `connectionRefusal`, so one rule has two entry points. The arm handle
   * resolves through `linkSource` exactly as `onConnect` resolves it, so an
   * arm drag is judged as the arm step. Illegal targets take the danger tint
   * (the refusal connection line); legal ones are untouched.
   */
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!c.source || !c.target) return false;
      return connectionRefusal(modelFlow, linkSource(c.source, c.sourceHandle), c.target) === null;
    },
    [modelFlow, graph.nodes],
  );
  /**
   * A refused drop still reaches the page's banner (Phase 4.3). The library
   * drops an invalid connection silently — `onConnect` never fires — so when
   * a drag ends over a step the link cannot legally land on, this reports the
   * same intent `onConnect` would have, through the same handlers: the page's
   * own `connect()` refuses with the same sentence its banner already shows.
   * Valid drops are untouched (`onConnect` owns them, and the refusal check
   * returning null is what proves it), and drops onto empty canvas report
   * nothing — never a refusal about a link to nowhere.
   */
  const forwardRefusedDrop = useCallback(
    (
      fromNode: string | null | undefined,
      fromHandle: string | null | undefined,
      toNode: string | null | undefined,
      toHandle: string | null | undefined,
    ) => {
      if (!fromNode || !toNode) return;
      const from = linkSource(fromNode, fromHandle);
      if (connectionRefusal(modelFlow, from, toNode) === null) return;
      // A named target handle is a field bind, exactly as in `onConnect` —
      // the refusal the page shows is the one the drop would have earned.
      const field = fieldDropTarget(toHandle);
      if (field && onConnectToField) onConnectToField(from, toNode, field);
      else onConnectSteps?.(from, toNode);
    },
    [modelFlow, graph.nodes, onConnectSteps, onConnectToField],
  );

  /**
   * The data-reference overlay's edges (Phase 4.2): dashed, labelled,
   * non-interactive wires from each producer to the SELECTED consumer, read
   * through `stepIo` — the same reader the panel uses, so the picture speaks
   * the panel's language. Nothing selected, no context, or toggle off ⇒ no
   * edges: never an empty picture that reads as "no references".
   */
  const dataRefEdges: Edge[] = useMemo(() => {
    if (!editable || !showDataRefs || !dataRefs || !selectedStepId) return [];
    const consumer = dataRefs.steps.find((s) => s.id === selectedStepId);
    if (!consumer) return [];
    const titles = new Map(graph.nodes.map((n) => [n.id, n.label ?? n.id] as const));
    const io = stepIo(consumer, dataRefs.catalogue, dataRefs.steps);
    return dataRefLinksFor({
      consumerId: consumer.id,
      inputs: io.inputs,
      overStepId: io.overStepId,
      titleOf: (id) => titles.get(id),
    }).map((l, i) => ({
      id: `dataref:${l.producerId}:${l.consumerId}:${i}`,
      source: l.producerId,
      target: l.consumerId,
      type: "dataRef",
      label: l.label,
      // The overlay is never editable: unselectable, unfocusable,
      // undeletable, un-re-pointable — and filtered out of `onDelete` below.
      selectable: false,
      focusable: false,
      deletable: false,
      reconnectable: false,
      data: { label: l.label },
    }));
  }, [editable, showDataRefs, dataRefs, selectedStepId, graph.nodes]);

  /**
   * The drag overlay, AFTER the layout memo — never by widening its key
   * (I-66: rebuilding layout per drag frame resets `measured` and unmounts
   * every edge). Identity-stable when no drag is in flight, so status polls
   * still rebuild nothing.
   */
  const displayNodes = useMemo(() => applyDragPositions(nodes, dragPos), [nodes, dragPos]);

  /**
   * Build-time choreography (`lib/canvas-reveal.ts`). All three are no-ops unless a
   * surface opts in, and they return `displayNodes` itself when off, so every
   * other canvas keeps its node identity exactly (I-66).
   */
  const glided = useGlide(displayNodes, glide && dragPos.size === 0);
  const nodesSeen = useRef<Seen>(new Map());
  const edgesSeen = useRef<Seen>(new Map());
  const shownNodes = useMemo(() => {
    if (!reveal && !sketch) return glided;
    const now = Date.now();
    if (reveal) noteNodes(nodesSeen.current, displayNodes, now);
    return glided.map((n) => {
      const entry = reveal ? nodesSeen.current.get(n.id) : undefined;
      const enter = entering(entry, now);
      if (!enter && !sketch) return n;
      return {
        ...n,
        className: [n.className, enter ? "fc-node-enter" : "", sketch ? "fc-node-sketch" : ""].filter(Boolean).join(" "),
        style: enter ? { ...n.style, animationDelay: `${entry!.delay}ms` } : n.style,
      };
    });
  }, [glided, displayNodes, reveal, sketch]);

  /**
   * For each (phase F, F4): each loop's box, fitted around its members AS DRAWN — so a dragged card reshapes the box live, and the
   * box has no position of its own to drift (D-51). Behind the cards, and click-through: the loop's own card is its header.
   */
  const framedNodes = useMemo(() => {
    if (!graph.frames?.length) return shownNodes;
    const byId = new Map(shownNodes.map((n) => [n.id, n]));
    // Stacking (2026-10-01): a step OUTSIDE the loop passes BEHIND its box, the loop's own steps sit on it — the box is a section of
    // the canvas, not an outline over it. Below the box 0, the box LOOP_FRAME_Z, above it LOOP_MEMBER_Z.
    const members = new Set(graph.frames.flatMap((f) => f.members));
    const boxes: Node[] = [];
    for (const f of graph.frames) {
      const box = frameBox(f.members.flatMap((id) => { const n = byId.get(id); return n ? [{ x: n.position.x, y: n.position.y, w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? NODE_H }] : []; }));
      if (!box) continue;
      boxes.push({
        id: `${FRAME_PREFIX}${f.id}`, type: "loopFrame", position: { x: box.x, y: box.y }, zIndex: LOOP_FRAME_Z,
        selectable: false, draggable: false, connectable: false, focusable: false, deletable: false,
        style: { width: box.width, height: box.height, pointerEvents: "none" },
        measured: { width: box.width, height: box.height }, width: box.width, height: box.height,
        data: { frame: f },
      });
    }
    return [...boxes, ...stackOnLoops(shownNodes, members)];
  }, [graph.frames, shownNodes]);

  /** The dragged node, for the drop indicator below — at most one at a time. */
  const dragEntry = dragPos.size > 0 ? [...dragPos.entries()][0]! : null;

  const edges: Edge[] = useMemo(
    () => {
      // ⚠ The arm's outcome word, keyed by the arm step it leaves from. Built
      // once so every edge reads the same map — `graph.nodes` joins the deps
      // below for exactly this, and nothing else in this memo reads it.
      const armWords = new Map<string, string>();
      for (const n of graph.nodes) {
        const arms = n.arms;
        if (!arms || arms.length < 2) continue;
        for (const a of arms) {
          const word = ARM_LABEL(arms, a.id);
          if (word) armWords.set(a.id, word);
        }
      }
      const base: Edge[] = graph.edges.map((e) => {
        const onPath = litSet ? litSet.has(e.source) && litSet.has(e.target) : true;
        // ⚠ ONE implementation of the edge id, shared with `lib/run-animation.ts`.
        // The animation looks an edge up by this string; two spellings would
        // drift silently, and the symptom is an edge that simply never lights.
        const id = edgeId(e.source, e.target);
        const isTesting = !!testing;
        /**
         * ⚠ **Boundary edges are drawn, not authored.** `withStart`/`withEnd`
         * hang every root/sink off the entry/exit nodes, so deleting a step's
         * last real link *draws* a start edge — and offering × on it reports a
         * disconnect the ops refuse (`does not run after "__start__"`), which
         * reads as "created a link I cannot remove". No affordance, and the
         * Backspace path skips them too.
         */
        const isBoundary = e.source === START_ID || e.target === END_ID;
        return {
          id,
          source: e.source,
          target: e.target,
          /**
           * ⚠ **Which ARM of a collapsed if/elif/else chain this edge leaves
           * by.** Absent on every ordinary edge, so a node with one unnamed
           * source handle is untouched — React Flow falls back to the single
           * handle when `sourceHandle` is undefined.
           */
          ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
          /**
           * ⚠ **Which OUTCOME of a collapsed if/elif/else chain this wire
           * carries.** `case 1` … `else`, from `ARM_LABEL` via the map above —
           * the same word the handle beside it stopped saying, now on the wire
           * where a reader following one case out of five can read it. Absent
           * on every ordinary edge, so the library's default label path stays
           * untouched everywhere else.
           */
          ...(e.noLabel ? {} : e.label ? { label: e.label } : e.sourceHandle && armWords.has(e.sourceHandle) ? { label: armWords.get(e.sourceHandle)! } : {}),
          /**
           * ⚠ **WHICH ROW THIS EDGE LANDS ON.** One upstream step feeding
           * exactly one named parameter ⇒ the wire lands on that parameter's
           * dot (`edgeTargetHandle`), so the picture says what the binding
           * says. Several params from one step, or a whole-object feed, have
           * no single answer — those land on the card, and each port states
           * its own source in its label instead.
           *
           * Absent when the node has no named ports, so every other node in
           * the product keeps React Flow's single-handle fallback untouched —
           * the same rule `sourceHandle` above follows.
           */
          ...(() => {
            const h = edgeTargetHandle(e.source, e.target, inputHandles);
            return h ? { targetHandle: h } : {};
          })(),
          // Editable surfaces draw the edge that carries the delete/insert
          // affordances; read-only surfaces a bare one. Both the same curve (`linkPath`).
          // A link that carries words draws the canvas's own edge too, so they are placed and styled one way (phase Z).
          type: editable || e.label ? "step" : "smooth",
          // ⚠ Declared at BOTH levels, like the nodes: `adoptUserEdges`
          // rebuilds internal edges from this array and an unset `selected`
          // silently resets the library's selection — which is what
          // deleteKeyCode reads for the Backspace delete.
          selected: selectedEdge === id,
          // T10 · once the run has reported a status, only the edge the run is
          // actually CROSSING animates — a settled source feeding a running
          // target. Lighting every edge out of a finished step would animate the
          // whole tail the moment step one succeeds, which is the flow-wide flag
          // again with more steps.
          animated: movingEdgeIds ? movingEdgeIds.has(id) : isTesting || !!live,
          className:
            (!litSet
              ? movingEdgeIds
                ? movingEdgeIds.has(id)
                  ? "edge-running"
                  : ""
                : live || isTesting
                  ? "edge-running"
                  : ""
              : onPath
                ? "edge-lit edge-flowing"
                : "edge-dim") + (isBoundary ? " edge-boundary" : "") + (e.kind === "path" ? " edge-path" : ""),
          // The flow's order along the hovered path: the edge's fade-in waits on how far along its source sits.
          ...(litSet && onPath ? { style: { ["--flow-order" as string]: litDepth?.get(e.source) ?? 0, ["--flow-slots" as string]: litSlots } as React.CSSProperties } : {}),
          data: editable
            ? {
                // Boundary edges carry no ×: there is no link to remove, only
                // the entry/exit the canvas draws for unfed roots and sinks.
                onDelete: isBoundary
                  ? undefined
                  : () => {
                      // An arm edge displays from the head but lives on the arm —
                      // reporting the head would refuse ("does not run after").
                      onDisconnectSteps?.(e.sourceHandle ?? e.source, e.target);
                      setSelectedEdge(null);
                    },
                // Mid-edge `+`: opens the kind chooser for this edge. The menu
                // carries the edge ends; picking a kind reports onInsertStep.
                onInsert: onInsertStep
                  ? (screenX: number, screenY: number) => {
                      cancelModes();
                      setMenu({ kind: "edge", source: e.source, target: e.target, screenX, screenY });
                    }
                  : undefined,
                hovered: hoveredEdge === id,
                labelAlways: e.labelAlways ?? !e.label,
                flowing: !!litSet && onPath,
              }
            : e.label
              ? { hovered: hoveredEdge === id || selectedEdge === id, labelAlways: !!e.labelAlways, flowing: !!litSet && onPath }
              : { flowing: !!litSet && onPath },
        };
      });
      const pairs = new Set(graph.edges.map((e) => edgeId(e.source, e.target)));
      // A DASHED preview of the pending link while the mode is armed — the
      // edge that will exist if the hovered node is clicked. Drawn from the
      // mode's subject to the hovered candidate; skipped when the pair is
      // already connected (the real edge is already on the canvas).
      if (connectFrom && hovered && hovered !== connectFrom && !pairs.has(edgeId(connectFrom, hovered))) {
        base.push({
          id: "__link-preview",
          source: connectFrom,
          target: hovered,
          type: "default",
          className: "edge-link-preview",
          style: { strokeDasharray: "5 4" },
        });
      }
      if (reroute && hovered && hovered !== reroute.from) {
        const preview =
          reroute.from === reroute.source
            ? { source: reroute.from, target: hovered }
            : { source: hovered, target: reroute.target };
        if (!pairs.has(edgeId(preview.source, preview.target))) {
          base.push({
            id: "__reroute-preview",
            ...preview,
            type: "default",
            className: "edge-link-preview",
            style: { strokeDasharray: "5 4" },
          });
        }
      }
      return base;
    },
    [graph.edges, graph.nodes, inputHandles, litSet, litDepth, litSlots, live, testing, movingEdgeIds, connectFrom, reroute, hovered, hoveredEdge, selectedEdge, editable, onDisconnectSteps, onInsertStep],
  );
  /**
   * Overlay edges FIRST: React Flow paints edges in array order, so the dashed
   * data wires sit below the real ones. Identity-stable while the overlay is
   * empty, so read-only surfaces and a closed toggle rebuild nothing.
   */
  const allEdges: Edge[] = useMemo(
    () => (dataRefEdges.length > 0 ? [...dataRefEdges, ...edges] : edges),
    [dataRefEdges, edges],
  );
  const shownEdges: Edge[] = useMemo(() => {
    if (!reveal) return allEdges;
    const now = Date.now();
    noteEdges(edgesSeen.current, nodesSeen.current, allEdges, now);
    return allEdges.map((e) => {
      const entry = edgesSeen.current.get(e.id);
      if (!entering(entry, now)) return e;
      return {
        ...e,
        className: [e.className, "fc-edge-enter"].filter(Boolean).join(" "),
        // The delay rides the PATH (an edge's `style` is its path's), overriding
        // only the stylesheet animation's delay.
        style: { ...e.style, animationDelay: `${entry!.delay}ms` },
      };
    });
    // `shownNodes` is a dep so the node batch is noted before the edges read it.
  }, [allEdges, reveal, shownNodes]);
  /** A wire between two of a loop's own steps sits on its box with them; every other wire passes behind it, as the steps do. */
  const stackedEdges: Edge[] = useMemo(() => {
    if (!graph.frames?.length) return shownEdges;
    return stackEdgesOnLoops(shownEdges, new Set(graph.frames.flatMap((f) => f.members)));
  }, [graph.frames, shownEdges]);

  /**
   * Refit when the SHAPE changes, not on every render. A live run adds no
   * nodes — it only changes their status — so refitting per poll would jitter
   * the view under someone who has panned to look at a step.
   *
   * ⚠ Keyed on `structure` (nodes + edges), deliberately NOT on the
   * arrangement — the DRAG FIX's second half. A drag-end changes a position
   * row, which must re-lay-out the graph but must NOT move the viewport;
   * fitting the view to the card someone is placing is the "dragging pans the
   * canvas" failure. The old version keyed on `edges.length`, so rewiring a
   * flow without changing the edge COUNT left the view fitted to the previous
   * shape. And the first fit does not animate — animating from React Flow's
   * default viewport is a visible swoop on every mount, which on a page that
   * remounts the canvas reads as a flash.
   */
  const fitted = useRef(false);
  const anchored = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      // S-07: initial viewport anchors on first needing decision, once per mount — not fitted.
      // `anchorStepId` is the id the page computed (first flagged/blocked/question). If present,
      // centre that node; otherwise fit the graph. `anchored` ensures this only runs once per mount,
      // so a later flag resolution does not fight the user's pan (geometry.md §8).
      if (anchorStepId && !anchored.current) {
        const pos = laidOut.find((p) => p.id === anchorStepId);
        const anchorNode = graph.nodes.find((n) => n.id === anchorStepId);
        if (pos) {
          // Centre the anchored node in the viewport. 0.5 zoom matches S-07 mid-graph framing at 1920.
          setCenter(pos.x + widthFor(anchorNode ?? { id: anchorStepId }) / 2, pos.y + heightFor(anchorNode ?? {}) / 2, { zoom: 0.85, duration: fitted.current ? 200 : 0 });
          fitted.current = true;
          anchored.current = true;
          return;
        }
      }
      fitView({ padding: 0.14, duration: fitted.current ? 200 : 0 });
      fitted.current = true;
    }, 0);
    return () => clearTimeout(t);
  }, [fitKey, fitView, anchorStepId, laidOut, setCenter]);
  // `F` to fit, scoped to the canvas. Scoped rather than global because the page
  // has text inputs on it and a bare letter shortcut that steals keystrokes from
  // a textarea is worse than no shortcut.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") {
        const el = e.target as HTMLElement;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
        e.preventDefault();
        fitView({ padding: 0.14, duration: 200 });
      }
    },
    [fitView],
  );

  /**
   * Escape closes. One listener for all three arms of the gesture vocabulary —
   * a menu that opened with the mouse must close with the keyboard, and a
   * connect/reroute mode armed from the menu must be cancellable without
   * clicking. The menu's own handler swallows the event when focus is inside
   * it (so a nested Escape closes the kind chooser before the whole menu).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inMenu = menuRef.current?.contains(document.activeElement);
      if (inMenu) return;
      if (menu) closeMenu();
      cancelModes();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, closeMenu, cancelModes]);

  // Focus lands INSIDE the menu when it opens (and when the kind chooser
  // drills in), so the keyboard can drive it from the first key.
  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [menu, submenu]);

  /**
   * The menu's keyboard vocabulary: ↑/↓ move among items, → opens the kind
   * chooser, ← returns, Escape closes the chooser first and the whole menu
   * second. Enter/Space activate natively (the items are buttons).
   */
  const menuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (submenu) setSubmenu(null);
        else closeMenu();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[i === -1 ? 0 : next]?.focus();
        return;
      }
      if (e.key === "ArrowLeft" && submenu) {
        e.preventDefault();
        setSubmenu(null);
        return;
      }
      if (e.key === "ArrowRight" && !submenu) {
        const el = document.activeElement as HTMLElement | null;
        if (el?.dataset.submenu) {
          e.preventDefault();
          setSubmenu(el.dataset.submenu as "node");
        }
      }
    },
    [submenu, closeMenu],
  );

  // The legend's own inputs, derived from the graph: which kinds are drawn
  // (a platform task is not a declared kind), and how many compiler-emitted
  // tasks the picture hides inside its declared steps.
  /**
   * ⚠ **The boundary is excluded, and it has to be.** Its `kind` is `null`,
   * which `kindOf` renders as "engine task" — *we could not classify this* —
   * so leaving it in would put an unclassifiable-task entry in the legend of
   * every flow in the product, for the one node whose meaning is certain.
   * `platform` is not the flag to reuse either: that counts real taskruns.
   */
  const legendKinds = [
    ...new Set(graph.nodes.filter((n) => !n.platform && n.boundary == null).map((n) => n.kind)),
  ];
  const platformCount = graph.nodes.filter((n) => n.platform).length;

  return (
    <div
      ref={wrap}
      data-testid="flow-canvas"
      data-depth={depth}
      tabIndex={0}
      className={
        (editable ? "" : "canvas-readonly ") +
        "flow-canvas relative flex flex-col overflow-hidden rounded-lg border border-line bg-bg outline-none" +
        (dragOver ? " canvas-drop-target" : "") +
        (dotGrid ? " dot-grid" : "")
      }
      style={{ height, minHeight: fill ? DENSITY[density].height : undefined }}
      onKeyDown={onKeyDown}
      // `F` (below) only fires while THIS element holds focus, and a plain div
      // is never focused by a hover — only by a click or an explicit Tab. So
      // the shortcut the legend advertises needs the canvas to focus itself
      // the moment the mouse is over it, matching how a canvas is expected to
      // behave (Figma, Excalidraw): hover it, and its keyboard shortcuts work.
      onMouseEnter={() => wrap.current?.focus()}
      // Palette drag-and-drop (HTML5). The canvas is a drop target only when
      // the surface handed it `onDropStep`; a row from the palette carries
      // `application/x-foundry-step` with { kind, ref }. `dropEffect: "copy"`
      // is set so the browser draws a copy cursor rather than a move one — a
      // palette row stays where it is.
      onDragOver={(e) => {
        if (!editable || !onDropStep) return;
        if (!isPaletteDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!editable || !onDropStep) return;
        e.preventDefault();
        setDragOver(false);
        // ⚠ The type, the writer and the reader all live in `lib/palette-drag.ts`.
        // This used to match the MIME as a literal, in two places, against two
        // more literals in the senders — so a change to one silently delivered
        // nothing, with no error anywhere. See that file's header.
        const data = readPaletteDrag(e.dataTransfer);
        // Not our payload, or a kind this canvas cannot draw — let the browser's
        // default drop handling stand.
        if (!data || !(data.kind in KIND)) return;
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        onDropStep(data.kind as StepKind, data.ref, Math.round(pos.x), Math.round(pos.y));
      }}
    >
      {/* ── The canvas's own chrome (plan 5.2) ────────────────────────────────
          ⚠ This REPLACES React Flow's floating `<Controls>`, rather than sitting
          beside it. Two sets of zoom buttons on one surface is two places to
          look for the same control, and the floating pair sat over the bottom-
          left node.

          The left slot is the canvas breadcrumb — deliberately one label, not a
          trail: a crumb stack needs a second level to push and nesting has no
          subject yet (D-103). The count beside it is the fact people actually
          ask of a picture, and it is the honest denominator for the "N platform
          tasks" note in the legend below. */}
      {chrome === "float" ? (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10">
          <span className="pointer-events-auto flex items-center gap-0.5 rounded-lg depth-4 px-1">

          {/* Phase 4.2: the data-reference overlay. Visible only where the
              model to picture is handed over (`dataRefs`) on an editable
              surface — a read-only surface has no consumer to picture, and a
              surface without the model must never picture it. */}
          {editable && dataRefs && (
            <button
              type="button"
              aria-pressed={showDataRefs}
              aria-label="Show data references"
              title={
                selectedStepId
                  ? "Show data references — dashed wires from each producer to the selected step"
                  : "Show data references — select a step to see what it reads"
              }
              onClick={toggleDataRefs}
              className={
                "min-h-[44px] shrink-0 rounded px-2 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line " +
                (showDataRefs ? "font-medium text-text underline underline-offset-4" : "text-dim hover:text-text")
              }
            >
              Show data references
            </button>
          )}
          <ToolButton label="Fit the graph to the view" onClick={() => fitView({ padding: 0.14, duration: 200 })}>
            <Frame s={14} />
          </ToolButton>
          <ToolButton label="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
            <Minus s={14} />
          </ToolButton>
          <ToolButton label="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
            <Plus s={14} />
          </ToolButton>
          {/* D-150(e): a reset is only meaningful when there is something
              arranged to reset. Visible ⇔ the surface owns arrangement AND at
              least one row exists; after the reset there is nothing left to
              reset, so the button disappears again. */}
          {onRearrange && positions && positions.size > 0 && (
            <ToolButton
              label="Re-arrange — forget the saved layout and lay the graph out automatically"
              onClick={onRearrange}
            >
              <RefreshCw s={14} />
            </ToolButton>
          )}
          </span>
        </div>
      ) : (
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5 py-1.5">
        <span className="min-w-0 truncate text-xs text-muted">
          {title && <span className="text-text">{title}</span>}
          {title && <span className="px-1.5 text-dim">·</span>}
          {graph.nodes.length} {graph.nodes.length === 1 ? "step" : "steps"}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {/* Phase 4.2: the data-reference overlay. Visible only where the
              model to picture is handed over (`dataRefs`) on an editable
              surface — a read-only surface has no consumer to picture, and a
              surface without the model must never picture it. */}
          {editable && dataRefs && (
            <button
              type="button"
              aria-pressed={showDataRefs}
              aria-label="Show data references"
              title={
                selectedStepId
                  ? "Show data references — dashed wires from each producer to the selected step"
                  : "Show data references — select a step to see what it reads"
              }
              onClick={toggleDataRefs}
              className={
                "min-h-[44px] shrink-0 rounded px-2 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line " +
                (showDataRefs ? "font-medium text-text underline underline-offset-4" : "text-dim hover:text-text")
              }
            >
              Show data references
            </button>
          )}
          <ToolButton label="Fit the graph to the view" onClick={() => fitView({ padding: 0.14, duration: 200 })}>
            <Frame s={14} />
          </ToolButton>
          <ToolButton label="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
            <Minus s={14} />
          </ToolButton>
          <ToolButton label="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
            <Plus s={14} />
          </ToolButton>
          {/* D-150(e): a reset is only meaningful when there is something
              arranged to reset. Visible ⇔ the surface owns arrangement AND at
              least one row exists; after the reset there is nothing left to
              reset, so the button disappears again. */}
          {onRearrange && positions && positions.size > 0 && (
            <ToolButton
              label="Re-arrange — forget the saved layout and lay the graph out automatically"
              onClick={onRearrange}
            >
              <RefreshCw s={14} />
            </ToolButton>
          )}
        </span>
      </div>
      )}

      {/* The armed-link banner: connect/reroute modes say what the next click
          does and how to get out — a mode with no way out is a trap, and a
          mode that does not say what it is waiting for reads as a hang. */}
      {(connectFrom || reroute) && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-accent-line bg-accent-bg px-3 py-1 text-xs text-text">
          <span className="font-mono text-accent">{connectFrom ?? reroute?.from}</span>
          <span>
            {reroute
              ? reroute.from === reroute.source
                ? "— re-point this step's link — click the new target, or press Esc to cancel"
                : "— re-point this step's incoming link — click the new source, or press Esc to cancel"
              : "— click a step to link to it, or press Esc to cancel"}
          </span>
        </div>
      )}
      {/* The graph area is its own positioned box: the hint strip pins to its
          top edge, and React Flow fills it. */}
      <div className="relative min-h-0 flex-1">
      {/* S-07 phase frames — background divs not groups, lane gap 56px, PHASE N eyebrow */}
      {phases && phases.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0 flex gap-14 px-2 pt-2" style={{ gap: `${LANE_GAP}px` }}>
          {[...phases].sort((a, b) => a.ordinal - b.ordinal).map((ph) => (
            <div
              key={ph.id}
              data-testid="phase-frame"
              data-phase={ph.ordinal}
              className="min-w-[180px] flex-1 rounded-lg border border-line/60 bg-surface/40 px-3 py-2"
            >
              <p className="text-micro uppercase tracking-label text-dim">PHASE {ph.ordinal}</p>
              <p className="text-xs font-medium uppercase tracking-wide text-text">{ph.label}</p>
              </div>
            ))}
          </div>
        )}
        <ReactFlow
          className="h-full w-full"
          nodes={framedNodes}
          edges={stackedEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={!!onMoveStep}
          nodesConnectable={!!editable}
          elementsSelectable
          // A selected edge is about to carry its delete affordance — draw it
          // ABOVE the nodes so the button is clickable wherever the edge runs.
          elevateEdgesOnSelect={editable}
          proOptions={{ hideAttribution: true }}
          minZoom={0.25}
          maxZoom={1.75}
          // Interactive pan/zoom — left-drag on empty canvas pans, wheel zooms, nodes still draggable via nodesDraggable
          panOnDrag={true}
          panOnScroll={false}
          zoomOnScroll
          // ⚠ THE DRAG FIX (2026-08-13). `panOnDrag` is a list of MOUSE BUTTONS
          // that pan the viewport: the default `true` means LEFT, so a left-drag
          // on a node could be read as a pane pan and the whole picture moved
          // with the card. `[1]` keeps panning on the MIDDLE button only — a
          // left-drag on a node moves the node (nodesDraggable), a left-drag on
          // empty canvas does nothing, and the wheel still zooms at the cursor
          // (zoomOnScroll, untouched). Right is deliberately NOT in the list:
          // right-drag would swallow the context menu — the Pane component
          // preventDefaults `contextmenu` when panOnDrag includes button 2.
          // D-152, browser-verified 2026-08-12: d3-zoom registers a `dblclick.zoom`
          // listener on the renderer that calls stopImmediatePropagation, which
          // swallows the event before it bubbles to the wrapper — so the
          // onDoubleClick below could never fire on empty canvas. When THIS canvas
          // owns the double-click (the add gesture), the zoom gesture is
          // deliberately off; the toolbar buttons still zoom. Every other surface
          // (run page, flow page) keeps dblclick-zoom.
        zoomOnDoubleClick={!onAddAt}
        // Backspace deletes a *selected* element and nothing else. Null in
        // read-only mode, so a stray keystroke on a run page cannot look like it
        // removed a step that actually ran.
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        onNodeClick={(_, n) => {
          // Clicking a node clears the edge selection — the two selections
          // are mutually exclusive, exactly as with the details panel.
          setSelectedEdge(null);
          // Connect/reroute modes: the clicked node completes the pending
          // link; a plain click selects, as before.
          if (connectFrom) {
            if (n.id !== connectFrom) {
              onConnectSteps?.(connectFrom, n.id);
              setConnectFrom(null);
            }
            return;
          }
          if (reroute) {
            if (n.id !== reroute.from) {
              if (reroute.from === reroute.source) {
                onRerouteStep?.(reroute.from, reroute.target, reroute.from, n.id);
              } else {
                onRerouteStep?.(reroute.source, reroute.target, n.id, reroute.target);
              }
              setReroute(null);
            }
            return;
          }
          onSelect?.(n.id);
        }}
        onPaneClick={() => {
          // A click on empty canvas cancels an armed link mode; otherwise it
          // is the ordinary deselect.
          if (connectFrom || reroute) {
            cancelModes();
            return;
          }
          setSelectedEdge(null);
          onDeselect?.();
        }}
        // ── The edge is an editable thing of its own: clicking selects it
        // (the delete affordance appears, Backspace/Delete removes it) and
        // hovering previews that affordance. Both feed the edge's own
        // component through `data`. ──
        onEdgeClick={(_, e) => {
          // Overlay wires are not selectable — clicking one selects nothing,
          // so a selected real edge keeps its affordance under the pointer.
          if (e.type === "dataRef") return;
          setSelectedEdge(e.id);
        }}
        onEdgeMouseEnter={(_, e) => setEdgeHover(e.id)}
        onEdgeMouseLeave={() => setEdgeHover(null)}
        // ── Right-click: the canvas-owned context menu ─────────────────────
        // Gated on `editable` — a run page's graph is history and gets no
        // menu, exactly like it gets no delete button. `onNodeContextMenu`
        // fires for a right-click on a card; `onPaneContextMenu` for the
        // empty canvas. Both preventDefault so the browser's own menu never
        // appears.
        onNodeContextMenu={(e, n) => {
          if (!editable) return;
          e.preventDefault();
          cancelModes();
          setMenu({ kind: "node", nodeId: n.id, screenX: e.clientX, screenY: e.clientY });
        }}
        onPaneContextMenu={(e) => {
          if (!editable || !onAddAt) return;
          e.preventDefault();
          cancelModes();
          const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          setMenu({
            kind: "pane",
            screenX: e.clientX,
            screenY: e.clientY,
            x: Math.round(pos.x),
            y: Math.round(pos.y),
          });
        }}
        onNodeMouseEnter={(_, n) => setHovered(n.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onNodesChange={handleNodesChange}
        // A drag-end reports the FINAL resting place, rounded to whole pixels
        // so identical layouts produce identical rows (D-150). The canvas
        // reports; the page decides what to do with it — persist, or keep in
        // session. Rounded, because float positions would make the row store
        // different on every drag of the same spot. The ephemeral echo for the
        onNodeDragStop={(_, n) => {
          setDragPos((prev) => {
            if (!prev.has(n.id)) return prev;
            const next = new Map(prev);
            next.delete(n.id);
            return next;
          });
          // The whole current picture with the drop applied: the page pins
          // every visible node first, so committing one drag can never
          // re-place the rest (pass 3 has nothing left to move).
          const all = new Map(laidOut.map((p) => [p.id, { x: p.x, y: p.y }] as const));
          all.set(n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) });
          onMoveStep?.(n.id, Math.round(n.position.x), Math.round(n.position.y), all);
        }}
        // The canvas reports; the page decides. `connect` in
        // `lib/flow-authoring.ts` is what refuses a cycle, a self-link or a
        // duplicate, and it does so with a message naming the link rather than
        // a compile error naming a task.
        onConnect={(c) => {
          if (!c.source || !c.target) return;
          // `linkSource` first: an arm handle reports its arm step even when
          // the drop lands on a field, so the two ends travel together.
          const from = linkSource(c.source, c.sourceHandle);
          // A named target handle is a bindable input; the unnamed target (no
          // `targetHandle`) — or no field handler — takes the plain path.
          // `fieldDropTarget` is what keeps `PARAMS_HANDLE` out of a binding.
          const field = fieldDropTarget(c.targetHandle);
          if (field && onConnectToField) onConnectToField(from, c.target, field);
          else onConnectSteps?.(from, c.target);
        }}
        // Refuse during the drag (Phase 4.3) — see `isValidConnection` above.
        // The in-flight line turns danger-red over an illegal target; the drop
        // itself still reaches `onConnect` for a legal target, and a refused
        // drop is reported below so the banner names the reason unchanged.
        isValidConnection={isValidConnection}
        connectionLineComponent={RefusalConnectionLine}
        // A refused drop still names its reason (Phase 4.3). The library drops
        // an invalid connection silently — `onConnect` never fires — so a drag
        // that ends over a step the link cannot legally land on is reported
        // through the same handlers as `onConnect`, and the page's banner shows
        // the same sentence, unchanged. Valid drops return early inside
        // `forwardRefusedDrop` (`onConnect` owns them); drops onto empty
        // canvas report nothing.
        onConnectEnd={(_, conn) => {
          forwardRefusedDrop(
            conn.fromHandle?.nodeId,
            conn.fromHandle?.id,
            conn.toHandle?.nodeId,
            conn.toHandle?.id,
          );
        }}
        // The click-to-connect twin of the above: clicking a handle and then
        // an illegal target is refused the same way, and reported the same way.
        onClickConnectEnd={(_, conn) => {
          forwardRefusedDrop(
            conn.fromHandle?.nodeId,
            conn.fromHandle?.id,
            conn.toHandle?.nodeId,
            conn.toHandle?.id,
          );
        }}
        // D-154: re-pointing an edge is disconnect(old) + connect(new), in one
        // gesture, through the same pure ops — so a refused new end (cycle,
        // duplicate, self-link) leaves the old edge exactly where it was. The
        // old edge is only removed by a connect that succeeded.
        onReconnect={(oldEdge, c) => {
          if (oldEdge.source && oldEdge.target && c.source && c.target) {
            onRerouteStep?.(
              oldEdge.sourceHandle ?? oldEdge.source,
              oldEdge.target,
              linkSource(c.source, c.sourceHandle),
              c.target,
            );
          }
        }}
        // ⚠ ONE delete event, not two — browser-verified 2026-08-12. v12's
        // `deleteElements` fires `onEdgesDelete` AND `onNodesDelete` for one
        // Backspace, and each would have become its own undo op: a single
        // delete landed on the stack as disconnect+disconnect+removeStep, so
        // one Undo left the flow half-restored. `onDelete` carries BOTH sets in
        // one call. The page's removeStep already drops a deleted step's
        // attached edges, so only edges NOT attached to a deleted node need a
        onDelete={({ nodes, edges }) => {
          const removed = new Set(nodes.map((n) => n.id));
          nodes.forEach((n) => onDeleteStep?.(n.id));
          // An edge that just died by Backspace is no longer selected.
          edges
            // Boundary edges are drawn, not authored — Backspace on one is a
            // no-op by construction, never a refused disconnect.
            .filter(
              (e) =>
                // Overlay wires are drawn, not authored — Backspace on one is
                // a no-op by construction, never a refused disconnect.
                e.type !== "dataRef" &&
                !removed.has(e.source) &&
                !removed.has(e.target) &&
                e.source !== START_ID &&
                e.target !== END_ID,
            )
            .forEach((e) => onDisconnectSteps?.(e.sourceHandle ?? e.source, e.target));
          const deletedEdgeIds = new Set(edges.map((e) => edgeId(e.source, e.target)));
          if (selectedEdge && deletedEdgeIds.has(selectedEdge)) setSelectedEdge(null);
        }}
        onDoubleClick={(e) => {
          // D-152: double-click on EMPTY canvas is the add gesture, gated on
          // `editable` like the other structural edits. A double-click on a
          // node is a select (the node handler wins) — only the pane reaches
          // here. It opens the SAME canvas-owned kind menu as a right-click on
          // the empty canvas; picking a kind reports through onAddAt.
          if (!onAddAt || !editable) return;
          const target = e.target as HTMLElement;
          if (target.closest(".react-flow__node")) return;
          const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          cancelModes();
          setMenu({
            kind: "pane",
            screenX: e.clientX,
            screenY: e.clientY,
            x: Math.round(pos.x),
            y: Math.round(pos.y),
          });
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="var(--line)" />
        {/* Worth its pixels only once the graph outgrows the viewport. Below
            that it is a decoration that says the same thing twice. */}
        {/* Minimap overlay — always for builder (dot-grid) interactive canvas, else when graph outgrows viewport */}
        {(dotGrid || graph.nodes.length > 4) && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeColor={(n) =>
              kindOf(
                (n.data as StepNodeData)?.step?.kind ?? null,
                (n.data as StepNodeData)?.step?.platform,
              ).colour
            }
            maskColor="var(--mask)"
            style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8 }}
          />
        )}
      </ReactFlow>
      {/* The drop indicator (B3.4, 2026-09-03): while a drag is in flight, the
          dragged card wears the `node-dragging` ring (globals.css) and this
          chip names the rounded coordinates the drag-stop will commit — the
          same rounding `onNodeDragStop` applies, so the preview cannot promise
          a spot the commit will not write. Cosmetic only: without the live
          echo above there would be nothing to indicate. */}
      {dragEntry && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-md border border-line bg-surface/90 px-2 py-1 font-mono text-[11px] text-muted">
          {dragEntry[0]} @ {Math.round(dragEntry[1].x)}, {Math.round(dragEntry[1].y)}
        </div>
      )}


      {/* ── The legend + hints strip, pinned to the graph's TOP edge ────────
          It used to be a block UNDER the canvas, in the page flow — a
          38px-tall band of instructions sitting between the graph and whatever
          came next, exactly where the eye lands after reading the picture.
          It now overlays the top edge of the graph area as bare caption text:
          same content, one line, no pill, out of the canvas's centre.
          `pointer-events-none` all the way down — it is read, never clicked,
          and must never steal a drag, a drop or a double-click. */}
      <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-3">
        {/* ⚠ NOT `overflow-hidden`. This row has no background of its own to clip
            to a pill shape (`.flow-canvas-legend` carries no CSS — it's a test
            hook only), so the only thing `overflow-hidden` here ever did was
            clip the "model" chip's own hover tooltip, which opens `top-full` a
            few px below this single-line row. `overflow: hidden` clips ALL
            descendants that visually extend past a box's edge, including
            absolutely-positioned ones — so the tooltip was rendering into the
            DOM and being invisible in every browser, independent of the outer
            `.flow-canvas` clipping the comment below already accounts for. */}
        <div className="flow-canvas-legend flex max-w-full items-center gap-x-3 rounded-full px-3 py-1 text-caption text-dim">
          {legendKinds.map((k) => {
            const kk = kindOf(k);
            return (
              <span key={k ?? "unknown"} className="flex shrink-0 items-center gap-1">
                <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: kk.colour }} />
                {kk.label}
              </span>
            );
          })}
          {platformCount > 0 && (
            <span className="flex shrink-0 items-center gap-1">
              <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: "var(--k-unknown)" }} />
              {platformCount} platform {platformCount === 1 ? "task" : "tasks"}
            </span>
          )}
          {/* ⚠ **MOVED HERE FROM A "why?" chip under the canvas.** Same fact,
              same wording, same bound — read on hover, rather than a
              click-to-expand `<details>` that had to be opened to be read at
              all. `pointer-events-auto` is the one deliberate exception to
              this strip's "read, never clicked" rule: it exists so the chip
              can register the hover, on an area small enough that it cannot
              meaningfully steal a drag, a drop, or a double-click from the
              canvas beneath it. The tooltip is the app's own card chrome
              (`border-line` + `depth-6`, same as the ScopePicker popover) —
              never the browser's native `title` box, which renders in the
              OS's own font and colour and looks like a different product. */}
          {(graph.hasSeam || graph.hasUnknownSeam) && (
            <span
              className="pointer-events-auto relative flex shrink-0 cursor-default items-center gap-1 text-orange"
              onMouseEnter={() => setSeamTooltipOpen(true)}
              onMouseLeave={() => setSeamTooltipOpen(false)}
              onFocus={() => setSeamTooltipOpen(true)}
              onBlur={() => setSeamTooltipOpen(false)}
              tabIndex={0}
            >
              <Sparkle s={10} />
              model
              {seamTooltipOpen && (
                <span
                  role="tooltip"
                  // ⚠ BELOW the chip, not above. The legend sits at the canvas's own
                  // top edge (`top-2`) inside `.flow-canvas`, which is `overflow-hidden`
                  // — a tooltip opening upward (`bottom-full`) lands outside that box
                  // and is clipped to nothing, which is exactly invisible-but-present:
                  // the DOM node exists, `role="tooltip"` is there, and a person hovering
                  // sees no card at all. Reported from use.
                  className="depth-6 pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded-lg border border-line p-2.5 text-left text-caption leading-snug text-muted"
                >
                  <b className="font-mono text-text">model</b> — marks a step that sends this
                  workspace&rsquo;s data to an external model. {SEAM_CAVEAT}
                  {graph.hasUnknownSeam && (
                    <>
                      {" "}
                      <b className="text-text">?</b> marks a step whose target could not be
                      read — treat it as unknown, not as safe.
                    </>
                  )}
                </span>
              )}
            </span>
          )}
          {editable && (
            /* One short read — the full gesture vocabulary lives in the title
               tooltip. The strip used to print the whole manual inline. */
            <span
              className="min-w-0 truncate"
              title={`drag between the dots to link · right-click a step or the canvas to edit, duplicate or add${onAddAt ? " · double-click to add" : ""} · select and press ⌫ to remove`}
            >
              drag dots to link · right-click to edit
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <kbd className="rounded bg-surface-2 px-1 font-mono text-micro">F</kbd>
            fit
          </span>
        </div>
      </div>
      </div>

      {/* ── The canvas-owned context menu ───────────────────────────────────
          Right-click on a node or on empty canvas (and double-click on empty
          canvas, the D-152 gesture) opens THIS menu, positioned at the
          cursor. It is deliberately shared: one menu, one keyboard vocabulary,
          on every editable surface — the builder, the flow page and the chat
          workbench render the same FlowCanvas.

          Keyboard: focus lands on the first item; ↑/↓ move; → opens the kind
          chooser (and ← returns); Escape closes (the kind chooser first, then
          the whole menu); Enter/Space activate. The roles are menu/menuitem.

          A transparent backdrop closes the menu on an outside click or
          right-click — the same pattern the builder's add menu used. */}
      {menu && editable && (
        <>
          <button
            type="button"
            aria-label="Close the menu"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
            className="fixed inset-0 z-40 cursor-default"
          />
          {/* ⚠ The kind list is sixteen rows and growing — the shell caps its
              height and the list scrolls inside (sticky header), so the menu
              fits viewports the full list never will. I-66 untouched: this is
              chrome around the card, never the card. */}
          <div
            ref={menuRef}
            role="menu"
            aria-label={
              menu.kind === "node"
                ? `Actions for ${graph.nodes.find((n) => n.id === menu.nodeId)?.label ?? menu.nodeId}`
                : menu.kind === "edge"
                  ? `Insert a step between ${menu.source} and ${menu.target}`
                  : "Add a step"
            }
            onKeyDown={menuKeyDown}
            className="pane fixed z-50 flex max-h-[min(65vh,540px)] w-60 flex-col p-1 text-sm shadow-raised"
            style={{
              // The shell caps at 540px/65vh and the list scrolls inside — so
              // the anchor clamps against the SAME cap, never the old 368px
              // guess. A small menu near the bottom flips up; a full kind
              // list never runs past the fold.
              left: `min(${menu.screenX}px, calc(100vw - 248px))`,
              top: `min(${menu.screenY}px, calc(100vh - 548px))`,
            }}
          >
            {menu.kind === "edge" ? (
              <AddKindList
                label="Insert a step here"
                addableRefs={addableRefs}
                onPick={(kind, ref) => {
                  onInsertStep?.(menu.source, menu.target, kind, ref);
                  closeMenu();
                }}
              />
            ) : menu.kind === "pane" ? (
              <AddKindList
                label="Add a step here"
                addableRefs={addableRefs}
                onPick={(kind, ref) => {
                  onAddAt?.({ ...menu, kind, ref });
                  closeMenu();
                }}
              />
            ) : submenu === "node" ? (
              <AddKindList
                label="Add a step after"
                onBack={() => setSubmenu(null)}
                addableRefs={addableRefs}
                onPick={(kind, ref) => {
                  onAddStepAfter?.(menu.nodeId, kind, ref);
                  closeMenu();
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect?.(menu.nodeId);
                    closeMenu();
                  }}
                  className="menu-item"
                >
                  Edit parameters
                </button>
                {onAddStepAfter && (
                  <button
                    type="button"
                    role="menuitem"
                    data-submenu="node"
                    onClick={() => setSubmenu("node")}
                    className="menu-item"
                  >
                    <span className="flex-1">Add step after</span>
                    <ChevronRight s={12} className="text-dim" />
                  </button>
                )}
                {onConnectSteps && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setConnectFrom(menu.nodeId);
                      closeMenu();
                    }}
                    className="menu-item"
                  >
                    Connect
                  </button>
                )}
                {onDuplicateStep && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onDuplicateStep?.(menu.nodeId);
                      closeMenu();
                    }}
                    className="menu-item"
                  >
                    Duplicate
                  </button>
                )}
                {onRerouteStep && nodeEdge(menu.nodeId, graph.edges) && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setReroute(nodeEdge(menu.nodeId, graph.edges)!);
                      closeMenu();
                    }}
                    className="menu-item"
                  >
                    Reroute
                  </button>
                )}
                {onDeleteStep && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onDeleteStep?.(menu.nodeId);
                      closeMenu();
                    }}
                    className="menu-item text-danger"
                  >
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The first edge attached to a node, for the Reroute menu item — a re-point
    has to have an edge to re-point. Outgoing first; an incoming edge is the
    fallback (its SOURCE end is the one that moves). */
function nodeEdge(
  nodeId: string,
  edges: CanvasGraph["edges"],
): { from: string; source: string; target: string } | null {
  const outgoing = edges.find((e) => e.source === nodeId);
  if (outgoing) return { from: nodeId, source: nodeId, target: outgoing.target };
  const incoming = edges.find((e) => e.target === nodeId);
  if (incoming) return { from: nodeId, source: incoming.source, target: nodeId };
  return null;
}

/**
 * The kind chooser inside the context menu — every addable palette kind,
 * rendered with the canvas's own kind vocabulary (icon + label). The list
 * scrolls under a sticky header: seven rows no longer need a tall
 * viewport (`trigger`/`end` are structural and live outside the quick menu).
 * This is the "palette kinds inline in the menu" affordance: adding a step
 * from the canvas never needs the palette pane to be open.
 *
 * ⚠ **Two steps, not one, and only where a ref is REQUIRED.** `transform`,
 * `branch`, `approval` and the rest are complete the moment they are created;
 * a `tool`, `datasource` or `query` is not, and offering it as though it were
 * is what produced a refused save and an error toast on every pick. When
 * `addableRefs` is absent this falls back to the flat list it has always been,
 * so the staged surfaces (the manual builder, where a refused save IS the
 * control) are untouched.
 */

/**
 * The search box above an insert-menu list — the same box `StepPalette`
 * renders (same placeholder, same match rule), so filtering the wire menu
 * feels like filtering the palette. Local because it is menu chrome, not a
 * second palette: the rows stay `AddKindList`'s own.
 */
function MenuSearch({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  return (
    <div className="relative mt-1">
      <Search s={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
      <Input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Find a component…"
        aria-label="Search components"
        className="pl-8"
      />
    </div>
  );
}

function AddKindList({
  label,
  onPick,
  onBack,
  addableRefs,
}: {
  label: string;
  onPick: (kind: StepKind, ref?: string) => void;
  onBack?: () => void;
  addableRefs?: (kind: StepKind) => Array<{ ref: string; label: string; hint?: string | null }> | null;
}) {
  const [pickedKind, setPickedKind] = useState<StepKind | null>(null);
  const [query, setQuery] = useState("");
  const refs = pickedKind && addableRefs ? addableRefs(pickedKind) : null;
  // The same `q` the palette filters on — one match rule (`paletteMatches`),
  // two boxes. Kinds match on label plus kind; refs on label plus ref.
  const visibleKinds = STEP_KINDS.filter((kind) => MENU_KINDS.has(kind)).filter((kind) =>
    paletteMatches(`${KIND[kind].label} ${kind}`, query),
  );
  const visibleRefs = refs ? refs.filter((r) => paletteMatches(`${r.label} ${r.ref}`, query)) : null;
  const q = query.trim();

  if (pickedKind && refs) {
    return (
      <>
        <div className="sticky top-0 z-10 bg-surface px-2 pb-1 pt-1.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              role="menuitem"
              aria-label="Back to the step kinds"
              onClick={() => setPickedKind(null)}
              className="rounded p-0.5 text-dim transition hover:bg-surface-2 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            >
              <ChevronLeft s={12} />
            </button>
            <span className="pane-head">{KIND[pickedKind].label} — pick one</span>
          </div>
          <MenuSearch query={query} onQuery={setQuery} />
        </div>
        <div role="group" aria-label="Choose what this step calls" className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {refs.length === 0 ? (
            /* ⚠ An empty catalogue is stated, never an empty list. A menu that
               simply shows nothing reads as a broken screen; this names the
               reason and the place to fix it. */
            <p className="px-2 py-3 text-xs text-muted">
              This workspace has no {KIND[pickedKind].label.toLowerCase()} registered yet. Add one on
              the Tools or Data sources page, and it will appear here.
            </p>
          ) : visibleRefs!.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted">No component matches “{q}”.</p>
          ) : (
            visibleRefs!.map((r) => (
              <button
                key={r.ref}
                type="button"
                role="menuitem"
                onClick={() => onPick(pickedKind, r.ref)}
                className="menu-item"
                title={r.hint ?? undefined}
              >
                <span className="flex-1 truncate text-left">{r.label}</span>
              </button>
            ))
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="sticky top-0 z-10 bg-surface px-2 pb-1 pt-1.5">
        <div className="flex items-center gap-1">
          {onBack && (
            <button
              type="button"
              role="menuitem"
              aria-label="Back to the step actions"
              onClick={onBack}
              className="rounded p-0.5 text-dim transition hover:bg-surface-2 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
            >
              <ChevronLeft s={12} />
            </button>
          )}
          <span className="pane-head">{label}</span>
        </div>
        <MenuSearch query={query} onQuery={setQuery} />
      </div>
      <div role="group" aria-label={label} className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
        {visibleKinds.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted">No component matches “{q}”.</p>
        ) : (
          visibleKinds.map((kind) => {
          // The menu offers ONLY what the server compiles (`stepSchema` in
          // `flow.service.ts`): `datasource` goes with named-query removal, and
          // the retired spellings (`trigger`, `calculate`, `condition`,
          // `action`, `notify`, `report`, `end`) are gone from the registry —
          // real notifications are `tool` steps calling `mail_send`. Old steps
          // of any kind still RENDER; they just stop being offered.
          const k = KIND[kind];
          return (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => {
                // A kind that needs a ref opens the ref list rather than
                // creating a step the server will refuse.
                if (addableRefs && addableRefs(kind)) setPickedKind(kind);
                else onPick(kind);
              }}
              className="menu-item"
            >
              <span style={{ color: k.colour }}>
                <k.Icon s={13} />
              </span>
              <span className="flex-1 truncate">{k.label}</span>
              <span className="font-mono text-micro uppercase tracking-label text-dim">{kind}</span>
            </button>
          );
          }))}
      </div>
    </>
  );
}

export function FlowCanvas(props: FlowCanvasProps & { emptyMessage?: string }) {
  const { graph, emptyMessage, fill = false, details = true } = props;

  /**
   * Selection is CONTROLLED where a page cares and local otherwise.
   *
   * `/runs/[id]` and `/flows/[id]` own the selection because it drives something
   * else on the page. `/flows/new` does not, and used to render a canvas where
   * clicking a node did nothing whatsoever. Falling back to local state means a
   * click is never inert, without making every caller take a `useState`.
   *
   * `dismissed` exists so ✕ can close the panel even under a controlled parent
   * that has no way to represent "nothing selected".
   */
  const [localSel, setLocalSel] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const selectedId = props.selectedStepId ?? localSel;
  const select = useCallback(
    (id: string) => {
      setDismissed(false);
      setLocalSel((prev) => (prev === id ? null : id));
      props.onSelect?.(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onSelect],
  );
  const shown = !details ? null : dismissed ? null : graph.nodes.find((n) => n.id === selectedId);

  // ⚠ Never a fabricated node. An empty graph says so — the alternative, drawing
  // a placeholder box, is the `faFallback` failure in a new costume: a picture
  // that cannot be told apart from a real one-step flow.
  if (!graph.nodes.length) {
    // DAG canvas always rendered full height — empty state is full-height centered, not conditional banner. Container div is always flex-1 min-h-0 h-full.
    if (fill) {
      return (
        <div className="flex flex-1 min-h-0 h-full w-full items-center justify-center p-8">
          <div className="w-full max-w-md rounded-xl border border-dashed border-line bg-surface px-6 py-10 text-center shadow-sm">
            <p className="text-sm font-medium text-text">{emptyMessage ?? "No steps to draw yet."}</p>
            {(props.building ?? props.reveal) ? (
              // ⚠ Building, and still no fabricated node: the wait is shown as a
              // wait. The outline's real steps replace this the moment they exist.
              <>
                <p className="mt-2 text-xs text-muted">The steps appear here as soon as they are chosen, usually within a few seconds.</p>
                <div data-testid="canvas-building" className="fc-building-bar mx-auto mt-4 h-1 w-40 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full w-1/3 rounded-full bg-accent/60" />
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted">Add steps in chat or drag from the palette — the DAG appears here live.</p>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 min-h-0 h-full w-full items-center justify-center rounded-lg border border-line bg-bg px-4 py-10 text-center text-sm text-muted">
        {emptyMessage ?? "No steps to draw yet."}
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 h-full w-full flex-col gap-2 overflow-hidden">
      <ReactFlowProvider>
        <Canvas
          {...props}
          selectedStepId={selectedId}
          onSelect={select}
          onDeselect={() => setDismissed(true)}
        />
      </ReactFlowProvider>

      {/* ⚠ Directly under the graph, because that is where the click happened.
          `/runs/[id]` used to answer a click with a panel further down the page,
          which on a 400px canvas is off-screen — so the click looked inert. */}
      {shown && (
        <NodeDetails node={shown} edges={graph.edges} onClose={() => setDismissed(true)} />
      )}
    </div>
  );
}
