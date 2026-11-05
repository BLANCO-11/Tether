// src/lib/canvas-model.ts — the one node model the canvas draws, and the two
// B-11: phase frames (flow_phases per revision, 7 phases S-07/S-10/S-29, background frames not collapsible groups, lane gap 56px) now stored per revision; canvas still derives grouping from step.phaseId until Phase 2 binds GET /workspaces/:ws/flows/:id/phases
// adapters that produce it.
//
// ── Why one model and two adapters ───────────────────────────────────────────
//
// The canvas is rendered from two genuinely different sources:
//
//   /runs/[id]    `StepGraphShape` + `StepRun[]` — the ENGINE's topology and what
//                 each task actually did. Authoritative about execution.
//   /flows/[id]   `FlowStepReview[]` — the MODEL's topology, from `dependsOn`.
//                 Authoritative about what was declared, including steps that
//                 have never run.
//
// Either could have had its own renderer. They must not: the whole argument for
// a canvas is that a person understands the automation from the picture, and two
// pictures of one flow that colour, order or badge nodes differently is exactly
// the disagreement `lib/flow-graph.ts` was extracted to prevent between the strip
// and the old column graph. So both collapse to `CanvasNode[]` here, and
// `FlowCanvas` knows nothing about where its nodes came from.
//
// This file is PURE — no React, no layout, no DOM. That is what makes the seam
// rule below testable, and it is the only part of the canvas a unit test can
// meaningfully assert.
import type { FlowStepReview, StepGraphShape, StepRun, StepStatus } from "@/lib/types";
// ⚠ ONE definition of "does this step fan out", shared with the inspector. Two
// readings of the same expression is how the card and the panel come to
// disagree about whether a step runs once or eleven times.
import { fanOutOver } from "@/lib/step-shape";
import { depths } from "@/lib/flow-graph";
import { describeCron } from "@/lib/cron";
import type { InputSource } from "@/lib/step-io";
import type { StepDiagnostic } from "@/lib/step-diagnostics";
import type { StepKind } from "@foundry/flow-edit";
import { STEP_KINDS as REGISTRY_STEP_KINDS } from "@foundry/flow-edit";

/**
 * The kinds a flow model can declare.
 * `null` = the engine ran a task Foundry has no pointer for.
 *
 * ── ONE DEFINITION, IN `@foundry/flow-edit` ──────────────────────────────────
 * This used to be a local union (the UXI-001 pack list plus implementation
 * kinds), hand-synced with the canvas, the inspector, the review surface and
 * the chat workbench — and the copies had already drifted. The registry's
 * `STEP_KINDS` is now the single list; this module re-exports the type and the
 * list so the canvas's existing import paths keep working.
 */
export type { StepKind } from "@foundry/flow-edit";

export const STEP_KINDS: StepKind[] = [...REGISTRY_STEP_KINDS];

function asKind(k: string | null | undefined): StepKind | null {
  return k && (STEP_KINDS as string[]).includes(k) ? (k as StepKind) : null;
}

/**
 * ⚠ The ref of the one tool that sends data to an external model.
 *
 * Hardcoded on purpose, and it is the weakest joint in the seam rule: it is a
 * NAME match, so a workspace registering a second LLM-backed tool under any other
 * name gets no badge. The alternative — inferring it from the tool's URL or from
 * ops-api's provider config — needs a per-tool round trip the canvas does not
 * make, and would fail open in a different and quieter way.
 *
 * The honest bound is stated on screen rather than papered over: the canvas
 * claims "these nodes send data to a model", never "no other node does". See
 * `SEAM_CAVEAT`.
 */
export const LLM_TOOL_REF = "llm_complete";

/** What the seam badge is allowed to claim, verbatim, wherever it is shown. */
/**
 * ⚠ **RECONSTRUCTED 2026-09-03 after a careless `git checkout` discarded the
 * working-tree copy of this file.** Everything below was rebuilt against
 * `canvas-model.test.ts`, which survived and is a complete behavioural spec —
 * that is the only reason the loss was recoverable. Nothing here is new
 * behaviour; if a comment reads thinner than the rest of this file, that is why.
 */

/**
 * One word per step state, and it is the ONLY place they are written.
 *
 * ⚠ The canvas ring, the builder's progress list and the panel all read this
 * map, so the picture and the list cannot come to disagree about what a step is
 * doing — which they did: the panel printed `running…` for every node for as
 * long as the button was busy, regardless of what any of them was doing.
 *
 * ⚠ `paused` reads **"waiting"**, deliberately not "paused". A person reading a
 * run wants to know it is waiting on THEM; "paused" reads like something the
 * system did to itself.
 */
export const STATUS_LABEL: Record<StepStatus, string> = {
  created: "not started",
  running: "running",
  paused: "waiting",
  success: "done",
  warning: "done, with warnings",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
};

/**
 * The same states as a TONE, for anything that draws a dot or a tint.
 *
 * ⚠ Tone names, never Tailwind classes. A class here would be a second palette
 * living outside `globals.css`, which is how two surfaces stop agreeing about
 * what amber means.
 */
export const STATUS_TONE: Record<StepStatus, "ok" | "warn" | "danger" | "accent" | "neutral"> = {
  created: "neutral",
  running: "accent",
  paused: "warn",
  success: "ok",
  warning: "warn",
  failed: "danger",
  cancelled: "neutral",
  skipped: "neutral",
};

/** What a `branch` step is called on screen. One word, in one place. */
export const BRANCH_LABEL = "only if";

/**
 * What one arm of an if/elif/else chain is called on the wire it leaves by.
 *
 * The arms themselves are named `if` / `else if` / `otherwise` (`branchArms`),
 * which is the panel's vocabulary for the decision; the wire says which OUTCOME
 * it carries — `case 1`, `case 2`, …, and `else` for the terminal catch-all —
 * so a reader following one wire out of a five-arm chain knows which case they
 * are on without counting handles.
 *
 * Returns null when the arm is not in the chain: an ordinary edge carries no
 * outcome word, and inventing one would label every wire in the product.
 */
export function ARM_LABEL(arms: Array<{ id: string; label: string }>, armId: string): string | null {
  const i = arms.findIndex((a) => a.id === armId);
  if (i < 0) return null;
  return arms[i]!.label === "otherwise" ? "else" : `case ${i + 1}`;
}

/**
 * ⚠ **What a lone guard does NOT do**, in one wording, for every surface that
 * shows a branch.
 *
 * The node has been labelled "only if" for some time and nothing said what
 * happens when the condition is false — so a reader could reasonably assume a
 * second, unshown path. There is none.
 *
 * ⚠ **It is FALSE on an if/elif/else chain**, where an "otherwise" arm does
 * exist, so every surface that shows it must suppress it on a chain rather than
 * print a claim the arms two lines above contradict.
 */
export const BRANCH_CAVEAT =
  "There is no \u201cotherwise\u201d branch: when the condition is false the steps after it are " +
  "skipped, and everything not downstream of it runs either way.";

export const SEAM_CAVEAT =
  "Marked from the flow's own declaration: tool steps calling " +
  `${LLM_TOOL_REF}. A tool registered under another name that happens to call a model is not detected.`;

/**
 * Does this node send data outside, to a model?
 *
 * ONE node type and no others, which is the fact the whole data-exposure
 * position rests on (programme 3, "what reaches a model today"):
 *
 *   - `tool` where ref = `llm_complete` — ops-api posts `{system, user}` to the
 *     configured provider.
 *
 * ⚠ There were two. The other was the `agent` kind, whose runtime posted the
 * upstream step's rows verbatim to a model; both are gone. `Seam` stays a UNION
 * rather than collapsing to a boolean, because the badge's whole job is to name
 * WHICH seam, and a second one is a thing this product may have again.
 *
 * `code` is the one that sounds like AI and is not (D-19): a fragment is a
 * function body run with `networkMode: none` and no credentials. Badging it would
 * make the marker mean "a model was involved at some point", which is true of
 * almost every step and therefore says nothing.
 *
 * ⚠ Fails CLOSED on missing information. A `tool` step whose ref is unknown —
 * which is what the run view had before `StepView.ref` existed — returns
 * `unknown`, not `false`. A privacy marker that renders "no" when it means
 * "cannot tell" is worse than no marker at all.
 */
export type Seam = "llm" | null;

export function seamOf(kind: StepKind | null, ref: string | null | undefined): Seam | "unknown" {
  if (kind !== "tool") return null;
  if (ref == null) return "unknown";
  return ref === LLM_TOOL_REF ? "llm" : null;
}

/** A short fact shown when a node is selected. Label/value so the panel stays dumb. */
export type CanvasFact = { label: string; value: string };

/** One node on the canvas. Everything the renderer needs and nothing it does not. */
export type CanvasNode = {
  /**
   * ⚠ **Identity, and NOT the display text.** The two were the same thing until
   * the outline sketch used the typed line as the id — so every keystroke gave
   * every node from that line onwards a new id, React unmounted and remounted
   * the cards, and the `fitView` animation restarted. That is the flashing.
   *
   * An id is stable across an edit; a label is not. Keep them apart.
   */
  id: string;
  /** What the card shows, when it differs from the id. Null ⇒ show the id. */
  label?: string | null;
  /**
   * A branch's arms, in order: `if` · `elif` … · `else`.
   *
   * ⚠ **ONE NODE, ONE HANDLE PER ARM — not one node per arm.** The arms share a
   * subject, a panel and a single `structureHash` entry, and drawing them as
   * separate cards would put three cards on the canvas for one decision.
   *
   * ⚠ **The handles are laid out INSIDE the existing card height**, at
   * fractional offsets — never by growing the card. A card that outgrew its
   * declared `NODE_W`/`NODE_H` would attach every edge to the wrong place with
   * nothing flickering to say so (I-66). A branch with eight arms crowds its
   * handles rather than resizing.
   *
   * Absent on every other kind, and absent on a lone branch with no chain: one
   * arm is not a fork, and drawing a single "if" port on every guard in the
   * product would claim a chain that is not there.
   */
  arms?: Array<{ id: string; label: string }>;
  /**
   * The arm this step runs inside, when it runs inside exactly one.
   *
   * ⚠ **Read as *"only when"*, never as *"grouped with"*.** The value on screen
   * is what the step's execution is CONDITIONAL on — the same fact the engine
   * acts on — so a step showing an arm chip and running anyway would be the
   * picture disagreeing with the run. Absent means the step runs regardless, or
   * is reachable from more than one arm; `armMembership` says why the second
   * case is deliberately not attributed to the first arm that reached it.
   */
  arm?: { branchId: string; armId: string; label: string };
  /**
   * View anchors for a `code` step's contract outputs — one source handle per
   * declared output field (id = label = field name).
   *
   * ⚠ **Anchors, not edges.** A drag from one of these handles creates a PLAIN
   * edge through the existing `onConnectSteps(from, to)` path — the edge
   * carries no `sourceHandle`, and React Flow falls back to the single unnamed
   * handle when it is undefined. Naming one everywhere would reroute every
   * other node in the product (see `CanvasEdge.sourceHandle`).
   *
   * ⚠ **Single opaque handle everywhere else.** Non-`code` kinds carry none,
   * and a `code` step whose contract has no `output` record carries none
   * either: one field is not a fork, and drawing a port per field on every
   * step would claim structure that is not there.
   *
   * Like `arms`, laid out INSIDE the existing card height at fractional
   * offsets — a step with many outputs crowds its handles rather than
   * resizing (I-66). `stepNodes` still declares `NODE_W`/`NODE_H`.
   */
  outputHandles?: Array<{ id: string; label: string }>;
  /**
   * Bindable input names — one target handle per entry (id = label = field name).
   *
   * Absent ⇒ the single unnamed target, exactly as before: a card with no
   * known fields keeps one port. Like `arms`/`outputHandles`, laid out INSIDE
   * the existing card height at fractional offsets — many inputs crowd rather
   * than resize (I-66); `stepNodes` still declares `NODE_W`/`NODE_H`.
   *
   * Filled by surfaces that can reach a catalogue (catalogue params by step
   * ref, plus code contract inputs) and merged by `FlowCanvas` from its
   * `inputHandles` prop — never by the adapters, which have no catalogue.
   */
  inputHandles?: FieldPort[];
  /**
   * The upstream step whose WHOLE output feeds every parameter, when the
   * binding is one expression rather than per field. The card draws row 0 as
   * the labelled inlet for it (`all inputs ← the whole of <step>`).
   *
   * Null ⇒ the params are per-field, or there is nothing to read.
   */
  wholeFrom?: string | null;
  /**
   * False when the step's inputs are set by an expression no writer may
   * re-emit (hand-written, or a filter outside the builder's vocabulary).
   * The card then draws the inlet only — no per-port dots, because a drop on
   * a param row would rebuild the expression from a blank map and destroy it.
   *
   * Merged from a prop like `inputHandles`, never by the adapters.
   */
  bindable?: boolean;
  /**
   * Facts worth reading once a node is CLICKED — the contract's purpose, the
   * retry policy, how long a gate may hold the run, which data a draft run read.
   *
   * They live on the node rather than being looked up by the panel because the
   * adapters are the only things that know their source's shape, and a panel
   * that reached back into `StepRun`/`FlowStepReview` would be a third view of
   * the model — the disagreement this file exists to prevent.
   */
  facts?: CanvasFact[];
  kind: StepKind | null;
  /** The concrete thing this step acts on — a query name, a tool name. Null when there isn't one. */
  ref: string | null;
  /** `null` on the flow view: a declared step has no status until an execution has one. */
  status: StepStatus | null;
  seam: Seam | "unknown";
  /** A short right-aligned fact: a duration, a pause budget, a retry policy. */
  meta: string | null;
  /** `> 1` means a `retry:` block fired. */
  attempt: number | null;
  /** `code` steps only — the body was written by a model and is what a reviewer scrutinises. */
  generated: boolean;
  /**
   * A task the COMPILER emitted, not a step anybody wrote — `begin`, `complete`,
   * and an agent step's `_await` pause and `_await_check`.
   *
   * ⚠ Drawn, never hidden. `begin` re-checks the approval gate and takes the M3
   * slot, so a run that failed there failed for the most interesting reason
   * available. What this flag buys is a picture that can say which four of a
   * six-task run are the platform's — without it, a person who wrote two steps
   * counts six and reasonably concludes the product invented four.
   */
  platform: boolean;
  /**
   * A short warning to draw ON the node — today, "this is the step that refused".
   *
   * Exists because the refusal panel needs to point at a step inside a shape that
   * was never created: `/flows/new` shows the drafter's model and a list of
   * refusals beside it, and matching the two by reading step ids off two lists is
   * the work the picture is supposed to remove.
   */
  flag?: string | null;
  /**
   * The server's TYPE-CHECKER errors on this step — typed-build phase 2.
   *
   * ⚠ Separate from `flag`, not folded into it. `flag` is one short sentence
   * the pill replaces its own text with; these are a list, each naming a code a
   * person can look up, and a step can carry a flag AND type errors at once.
   * Painted on by `withTypeErrors` — an OVERLAY on the one node model, never a
   * second adapter (D-46).
   */
  typeErrors?: readonly StepDiagnostic[] | null;
  /** S-08: this node is the subject of the open clarifying question — accent border + accent label, canvas centres on it. */
  asked?: boolean;
  /** Ordinal for label line — e.g., `7` in `Prepare · 7` (S-07) or `Prepare · 7` vs technical `transform.Filter`. */
  ordinal?: number | null;
  /** Kestra task type for technical view — e.g., `io.kestra.plugin.scripts.python.Commands`. When null, fallback per TASK_TYPE_FALLBACK applies. */
  taskType?: string | null;
  /** Decision question for `branch`/`condition` nodes — third line in both views (S-11). */
  question?: string | null;
  /**
   * A BOUNDARY of the flow rather than a step in it — today only `"start"`.
   *
   * ⚠ **Deliberately NOT a `StepKind`, and that is the whole design.** A kind
   * has to compile to a Kestra task; a boundary emits nothing. Adding `"start"`
   * to `StepKind` would put it in the drafter's vocabulary, in `STEP_SHAPES`
   * (which invalidates all four generation measurements the moment its bytes
   * move) and in the compiler's switch — for a node that exists only to show
   * what the flow already declares.
   *
   * ⚠ **And NOT `platform: true` either.** That flag means *a task the compiler
   * emitted* — `begin`, `complete`, a gate's `_await` — which are real
   * taskruns with real states. This is not a taskrun at all, so it must never
   * be counted in the legend's "N platform tasks" nor carry a status.
   *
   * ⚠ **`"end"` EXISTS AS OF 2026-09-08, and this paragraph used to say it did
   * not. Two of its three reasons became false and the third turned out not to
   * matter — the argument is corrected here rather than deleted, because it was
   * right when it was written and the way it stopped being right is the record
   * of what changed.**
   *
   * It read: *"`AuthoredFlow` has `inputs` and no `outputs`"* — the model now
   * carries `output` (`FlowModel.output`, server side). *"nothing would read
   * it"* — `GET …/flow-executions/:id` now returns a top-level `result`, so a
   * declaration is consumed rather than computed and discarded (I-120's shape,
   * which is exactly what that sentence was guarding against). The third,
   * *"`core.output.OutputValues` is not in `FOUNDRY_EMITS`"*, is still TRUE and
   * is now beside the point: an end node emits nothing at all, precisely as the
   * start node does not emit a Kestra input declaration. Nothing unemittable
   * reaches a screen, so UXI-003 is not in play.
   *
   * ⚠ Everything above about boundaries in general still holds for `"end"`: it
   * is NOT a `StepKind` (a kind must compile to a task, and adding one moves
   * `STEP_SHAPES`' bytes and invalidates all four generation measurements) and
   * NOT `platform: true` (that means a task the compiler emitted, which has a
   * real taskrun state; this has none and must never carry a status).
   */
  boundary?: "start" | "end";
};

/**
 * One bindable input on a card: its name, and where its value comes from.
 *
 * ⚠ **The source IS `InputSource` — the same type the panel reads.** `step-io.ts`
 * is the one reader; this type used to carry its own smaller vocabulary
 * (`bound: "step" | "literal" | null`) and the two disagreed on screen: the
 * panel said "set in the expression" while the card drew a hollow dot. One
 * type, one wording function (`inputSourceText`), both surfaces.
 *
 * ⚠ **A literal is NOT an empty input.** `sender: "a.b@example.com"` is
 * configured; drawing it the same as an unset parameter reports a problem that
 * is not there, and drawing it as *bound to a step* claims a wire that does not
 * exist. Every state gets its own rendering.
 */
export type FieldPort = {
  name: string;
  source: InputSource;
};

export type CanvasEdge = {
  source: string;
  target: string;
  /**
   * Which arm of a collapsed if/elif/else chain this edge leaves by.
   *
   * ⚠ **Absent on an ordinary edge, deliberately.** React Flow falls back to the
   * node's single unnamed source handle when this is undefined, so naming one
   * everywhere would change the routing of every other node in the product.
   */
  sourceHandle?: string;
  /**
   * What travels on this link, in words (phase Z, I-320) — from the engine's `flowWords`: "if read_1 (invoices overdue) has rows",
   * "as text → body". Absent on every surface that does not have the engine's words; the arm's `case n` stays their label.
   */
  label?: string;
  /** Show `label` always (a condition's link — when the step runs), not only on hover (a data link — what it carries). */
  labelAlways?: boolean;
  /** No label at all, not even an arm's `case n` — the card says it (the engine canvas draws IF / ELSE on the condition's rows). */
  noLabel?: boolean;
  /**
   * `path`: a condition's exit — WHEN the step runs, carrying no data (phase C). Drawn apart from a data link (what a step reads),
   * so a picture never suggests data flows through an IF. Absent = a data link, as on every surface before.
   */
  kind?: "path";
};

/**
 * Paint the checker's diagnostics onto the nodes they name — typed-build phase 2.
 *
 * `byStep` is `diagnosticsByStep`'s answer. The flow-wide key (`""`) matches no
 * node on purpose: those render in the surface's findings area, never on an
 * arbitrary card.
 *
 * ⚠ Returns the SAME object when nothing matched — `overlayStatuses`'s rule —
 * so a surface with no diagnostics keeps the node identity React Flow needs to
 * hold its measured handle bounds (I-66).
 */
export function withTypeErrors(graph: CanvasGraph, byStep: ReadonlyMap<string, readonly StepDiagnostic[]>): CanvasGraph {
  if (byStep.size === 0) return graph;
  let hit = false;
  const nodes = graph.nodes.map((n) => {
    const list = n.id ? byStep.get(n.id) : undefined;
    if (!list || list.length === 0) return n;
    hit = true;
    return { ...n, typeErrors: list };
  });
  return hit ? { ...graph, nodes } : graph;
}

/**
 * A loop's BOX (phase F, F4): the loop, the steps inside it and its output, drawn inside one frame. Derived from the graph like
 * everything else — the frame is fitted around its members' positions each render, never stored (D-51): a moved card reshapes
 * the box, and no coordinate of the box itself can drift from the steps it holds.
 */
export interface CanvasFrame {
  /** The loop step's id. */
  id: string;
  /** "For each row of overdue". */
  label: string;
  /** Its settings in words ("5 at a time · keeps going if one fails"), or on a run its per-item counts. */
  detail?: string;
  /** Every node drawn inside the box: the loop itself, the steps inside, and its output when it has one. */
  members: string[];
  /** On a run: some item failed — the box says so. */
  tone?: "warn" | "danger";
}

export type CanvasGraph = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** For each (phase F): each loop's box. Absent ⇒ no loop. */
  frames?: CanvasFrame[];
  /** True when at least one node is a model seam — drives the legend note. */
  hasSeam: boolean;
  /** True when at least one node's seam could not be determined. Shown, never hidden. */
  hasUnknownSeam: boolean;
};

/**
 * The arms of every if/elif/else chain, keyed by the chain's HEAD.
 *
 * A chain is `if` → `elif` → … → `else`, linked by `elseOf`: each later branch
 * names the one it continues. The head is the branch with no `elseOf`.
 *
 * ⚠ **A lone branch gets NO arms.** One arm is not a fork; see `CanvasNode.arms`.
 *
 * ⚠ **A closed `elseOf` loop yields nothing, and the reason is structural rather
 * than defensive.** The walk starts only at a branch with no `elseOf`, and each
 * step has at most one `elseOf` — so a step already in a chain cannot also be a
 * later step's continuation. A cycle therefore has no head and is never entered.
 * The `seen` set below is consequently **unreachable defence**, kept and labelled
 * as such (the same shape as the secret scanner's `grep -a`). The server's
 * compiler is where a cycle is actually REFUSED, with a message naming the step.
 */
export function branchArms(
  steps: Array<{ id: string | null; kind: StepKind | null; elseOf: string | null; conditionExpr: string | null }>,
): Map<string, Array<{ id: string; label: string }>> {
  const rows = steps.filter((s): s is { id: string; kind: StepKind | null; elseOf: string | null; conditionExpr: string | null } => !!s.id);
  const branches = rows.filter((r) => r.kind === "branch");
  const continues = new Map<string, typeof branches[number]>();
  for (const b of branches) if (b.elseOf) continues.set(b.elseOf, b);

  const out = new Map<string, Array<{ id: string; label: string }>>();
  for (const head of branches) {
    if (head.elseOf) continue; // not a head
    const chain: Array<{ id: string; label: string }> = [];
    const seen = new Set<string>(); // ⚠ unreachable — see the docblock.
    let cur: typeof branches[number] | undefined = head;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      // ⚠ A terminal `else` is the one with NO condition, and the test is that
      // the key is ABSENT — never that it is falsy. A freshly added, still
      // unconfigured `elif` carries `""`, and treating that as the catch-all
      // silently makes it swallow every remaining case.
      const terminal = cur !== head && cur.conditionExpr === null;
      chain.push({ id: cur.id, label: chain.length === 0 ? "if" : terminal ? "otherwise" : "else if" });
      cur = continues.get(cur.id);
    }
    if (chain.length > 1) out.set(head.id, chain);
  }
  return out;
}

/**
 * Collapse an if/elif/else chain into ONE node with one handle per arm.
 *
 * ⚠ **THE MODEL HAS THREE STEPS AND THE PICTURE HAS ONE CARD, deliberately.**
 * `if`, `elif` and `else` are three `branch` steps — that is what the compiler
 * emits and what `armOf` reads — but they are one DECISION, and drawing three
 * cards for one decision is the same mistake as drawing none.
 *
 * ⚠ **BOTH ADAPTERS CALL THIS**, and `canvas-model.test.ts` holds them in
 * agreement. A collapse in one of them is two pictures of one flow — one showing
 * a fork, the other three unrelated always-run guards.
 *
 *  · continuation nodes are removed (their arm becomes a handle on the head)
 *  · an edge out of a continuation is re-sourced to the head, naming the arm
 *  · an edge INTO a continuation is dropped — an `elseOf` link is not a
 *    `dependsOn` edge, and drawing it would show the chain twice
 */
export function collapseArms(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  arms: Map<string, Array<{ id: string; label: string }>>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (arms.size === 0) return { nodes, edges };
  const headOf = new Map<string, string>();
  for (const [head, chain] of arms) for (const a of chain) headOf.set(a.id, head);

  const kept = nodes
    .filter((n) => !(headOf.has(n.id) && headOf.get(n.id) !== n.id))
    .map((n) => (arms.has(n.id) ? { ...n, arms: arms.get(n.id) } : n));

  const keptIds = new Set(kept.map((n) => n.id));
  const out: CanvasEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!keptIds.has(e.target)) continue;
    const head = headOf.get(e.source);
    const next: CanvasEdge = head ? { source: head, target: e.target, sourceHandle: e.source } : e;
    if (!keptIds.has(next.source)) continue;
    const key = `${next.source}\u0000${next.sourceHandle ?? ""}\u0000${next.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return { nodes: kept, edges: out };
}

/**
 * The output-field source handles for one step — `code` only.
 *
 * A `code` step's contract declares its outputs as a record, and each key is a
 * field a downstream step can read; one handle per key (id = label = field
 * name) gives the drag a per-field anchor. Every other kind is opaque — its
 * outputs are not named fields — so it carries none, as does a `code` step
 * with no contract output record. Empty, never absent-vs-undefined games: the
 * renderer falls through to the single handle when this is empty or absent.
 */
export function outputHandlesOf(
  kind: StepKind | null,
  contractOutput?: Record<string, unknown> | null,
): Array<{ id: string; label: string }> {
  if (kind !== "code" || !contractOutput) return [];
  return Object.keys(contractOutput).map((name) => ({ id: name, label: name }));
}

/**
 * Every id that should draw an incoming edge to a step — `dependsOn`, plus a
 * `merge`'s `sources`.
 *
 * ⚠ **ONE function, because two adapters draw this picture and they must not
 * disagree.** A merge is the only kind whose topology is not in `dependsOn`:
 * the compiler resolves `sources` itself and emits a coalesce, so nothing in
 * the model links the arms to the join. The projection dropped the field and
 * both adapters therefore drew a merge — and its whole tail — as an island
 * with no way in, which reads as a broken flow rather than a converged one.
 *
 * ⚠ **This is for DRAWING only.** `armMembership` deliberately does not call
 * it: a merge inherits no arm, and neither does anything after it. Feeding
 * sources into that closure would undo the exemption the compiler defines.
 */
export function mergeAwareLinks(
  dependsOn: string[] | null | undefined,
  sources: string[] | null | undefined,
): string[] {
  const out = [...(dependsOn ?? [])];
  for (const s of sources ?? []) if (!out.includes(s)) out.push(s);
  return out;
}

/** Attach each node's arm membership. One place, so both adapters agree. */
function withArm(
  nodes: CanvasNode[],
  members: Map<string, { branchId: string; armId: string; label: string }>,
): CanvasNode[] {
  if (members.size === 0) return nodes;
  return nodes.map((n) => (members.has(n.id) ? { ...n, arm: members.get(n.id) } : n));
}

/**
 * Which arm each step runs inside — Stage 3.4.
 *
 * ⚠ **The SAME rule the compiler uses: transitively downstream of the branch by
 * `dependsOn`, never ordinal position.** `armOf` says why in its own docblock,
 * and the sentence is now literally about this: *on a branching flow an ordinal
 * version both refuses safe replays and permits hanging ones.* A second
 * definition here would draw a grouping the engine does not honour.
 *
 * ⚠ **A step reachable from TWO arms is left UNMARKED, not assigned to the
 * first.** A card claiming one arm would be false half the time; unmarked reads
 * as "runs regardless", which is the honest thing to show when the answer is
 * "it depends".
 */
export function armMembership(
  steps: Array<{ id: string | null; dependsOn: string[]; kind?: StepKind | null }>,
  arms: Map<string, Array<{ id: string; label: string }>>,
): Map<string, { branchId: string; armId: string; label: string }> {
  const out = new Map<string, { branchId: string; armId: string; label: string }>();
  if (arms.size === 0) return out;
  const rows = steps.filter(
    (s): s is { id: string; dependsOn: string[]; kind?: StepKind | null } => !!s.id,
  );
  const claimed = new Set<string>();

  for (const [head, chain] of arms) {
    for (const arm of chain) {
      const inArm = new Set<string>([arm.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const r of rows) {
          if (inArm.has(r.id)) continue;
          // ⚠ THE CLOSURE STOPS AT A MERGE — byte for byte the rule
          // `flow-compiler.service.ts`'s `armOf` applies, and the reason this
          // function's docblock already gives: a second definition here draws a
          // grouping the engine does not honour. A merge is where the arms come
          // back together, so it belongs to none of them, and neither does its
          // tail. Without this line every shared tail is swallowed into
          // whichever arm reached it first and drawn as conditional.
          if (r.kind === "merge") continue;
          if (r.dependsOn.some((d) => inArm.has(d))) {
            inArm.add(r.id);
            grew = true;
          }
        }
      }
      for (const id of inArm) {
        if (id === arm.id) continue;
        if (out.has(id) && out.get(id)!.armId !== arm.id) claimed.add(id);
        out.set(id, { branchId: head, armId: arm.id, label: arm.label });
      }
    }
  }
  for (const id of claimed) out.delete(id);
  for (const chain of arms.values()) for (const a of chain) out.delete(a.id);
  return out;
}

function finish(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasGraph {
  // Order nodes by longest-path depth, then declaration order. dagre would lay
  // them out regardless, but a stable order makes keyboard traversal and the
  // node list under a screen reader read top-to-bottom in execution order.
  const depth = depths(
    nodes.map((n) => n.id),
    edges,
  );
  const ordered = nodes
    .map((n, i) => ({ n, d: depth.get(n.id) ?? 0, i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.n);
  return {
    nodes: ordered,
    edges,
    hasSeam: ordered.some((n) => n.seam === "llm"),
    hasUnknownSeam: ordered.some((n) => n.seam === "unknown"),
  };
}

function ms(n: number | null | undefined): string | null {
  if (n == null) return null;
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
}

/**
 * The EXECUTION view: engine topology, Foundry's pointer rows for kind and ref.
 *
 * Steps present in the run but absent from the graph are appended rather than
 * dropped — a step the UI cannot place is still a step that happened, which is
 * the same rule `orderedStepIds` already applies to the strip.
 */
export function canvasFromExecution(graph: StepGraphShape | null, steps: StepRun[]): CanvasGraph {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const declared = graph?.nodes.map((n) => n.id) ?? steps.map((s) => s.stepId);
  const extra = steps.map((s) => s.stepId).filter((id) => !declared.includes(id));
  const ids = [...declared, ...extra];

  const nodes: CanvasNode[] = ids.map((id) => {
    const s = byId.get(id);
    const kind = asKind(s?.kind);
    const facts: CanvasFact[] = [];
    if (s?.startedAt) facts.push({ label: "started", value: new Date(s.startedAt).toLocaleTimeString() });
    if (s?.durationMs != null) facts.push({ label: "took", value: ms(s.durationMs)! });
    if (s?.attempt != null && s.attempt > 1) {
      facts.push({ label: "attempts", value: `${s.attempt} — a retry: block fired` });
    }
    /**
     * ⚠ Stage 4's claim, on the node the person clicked. `readFrom` is
     * PERSISTED on the row and never recomputed, and a draft run against a
     * datasource with no sandbox reads PRODUCTION — which is stated here rather
     * than implied by its absence.
     */
    if (s?.readFrom) {
      facts.push({
        label: "read from",
        value:
          s.readFrom === "sandbox"
            ? "the development sandbox"
            : "PRODUCTION data",
      });
    }
    if (s?.error) facts.push({ label: "error", value: s.error });
    return {
      id,
      facts,
      kind,
      ref: s?.ref ?? null,
      // No run record = declared but not reached. `created` rather than null:
      // on an execution, "the flow never got here" is information, and a node
      // with no status would render identically to one the engine skipped.
      status: s?.status ?? "created",
      seam: seamOf(kind, s?.ref ?? null),
      meta: ms(s?.durationMs),
      attempt: s?.attempt ?? null,
      generated: kind === "code",
      outputHandles: outputHandlesOf(kind, s?.output),
      platform: s?.platform === true,
    };
  });

  // Edges only where both ends are nodes we drew. Kestra's graph already drops
  // its two synthetic cluster markers server-side; this guards the appended-step
  // case, where an edge could name something we never placed.
  const present = new Set(ids);
  const edges = (graph?.edges ?? []).filter((e) => present.has(e.source) && present.has(e.target));
  const frames = runFrames(steps, present);
  return frames.length ? { ...finish(nodes, edges), frames } : finish(nodes, edges);
}

/**
 * A run's loop boxes (phase F, F4): the step view folds a loop's per-item taskruns into one view per step and names the loop
 * each body step ran in (`loop`, D-367), and the loop's own view counts its items — so the box is those steps, and its badge is
 * the count, never recomputed here.
 */
export function runFrames(steps: StepRun[], present: Set<string>): CanvasFrame[] {
  const out: CanvasFrame[] = [];
  for (const l of steps) {
    if (l.kind !== "for_each" || !present.has(l.stepId)) continue;
    const members = [l.stepId, ...steps.filter((s) => s.loop === l.stepId && present.has(s.stepId)).map((s) => s.stepId)];
    const p = l.perItem, n = l.items?.length ?? p?.ran;
    const detail = n == null ? undefined : n === 0 ? "no items" : `${n} item${n === 1 ? "" : "s"}${p?.failed ? ` · ${p.failed} failed` : ""}`;
    out.push({ id: l.stepId, label: "For each", members, ...(detail ? { detail } : {}), ...(p?.failed ? { tone: p.failed === p.ran ? "danger" as const : "warn" as const } : {}) });
  }
  return out;
}

/**
 * The MODEL view: `dependsOn` is the topology, and there are no statuses.
 *
 * ⚠ `status: null` throughout, deliberately. A declared flow has not run, and
 * tinting every node grey-because-not-started would make a perfectly good draft
 * look like a stalled execution. The renderer draws kind, not state, here.
 */
export function canvasFromModel(steps: FlowStepReview[]): CanvasGraph {
  // Defensive: always render a node per declared step, even if the step is
  // incomplete (ref null, contract missing, kind unknown). A draft step with
  // no ref is still a step the person declared — filtering it would be the
  // "empty canvas with 2 steps" failure (aff37d64: 2 tool steps, ref present
  // but contract null, steps.length 2 yet graph empty when a filter dropped
  // code-without-contract or ref-null rows).
  const ids = new Set(steps.map((s) => s.stepId));
  const nodes: CanvasNode[] = steps
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s) => {
      const kind = asKind(s.kind);
      const over = fanOutOver(s.paramsExpr);
      const facts: CanvasFact[] = [];
      if (s.contract?.purpose) facts.push({ label: "purpose", value: s.contract.purpose });
      if (s.codeLines != null) facts.push({ label: "generated code", value: `${s.codeLines} lines` });
      if (s.retry?.maxAttempts) {
        facts.push({
          label: "retry",
          value:
            `up to ${s.retry.maxAttempts} attempts` +
            (s.retry.intervalSeconds ? `, ${s.retry.intervalSeconds}s apart` : "") +
            (s.retry.backoff ? ` (${s.retry.backoff})` : ""),
        });
      }
      if (s.awaitSeconds != null) {
        facts.push({
          label: "waits",
          value:
            `up to ${Math.round(s.awaitSeconds / 60)} minutes — the execution holds a ` +
            `concurrency slot for the whole of it`,
        });
      }
      return {
        id: s.stepId,
        facts,
        kind,
        // ref may be null for a draft/tool not yet bound — still render the node
        ref: s.ref ?? null,
        status: null,
        seam: seamOf(kind, s.ref ?? null),
        // ⚠ FAN-OUT FIRST, and it outranks the rest on purpose: "runs eleven
        // times" changes what the step DOES, where a retry count or a line
        // count only describes how it does it. Same function as the inspector's
        // (`fanOutOver`), so the card and the panel cannot disagree.
        meta: over
          ? `once per row · ${over}`
          : s.awaitSeconds != null
            ? `waits up to ${Math.round(s.awaitSeconds / 60)}m`
            : s.retry?.maxAttempts
              ? `retries ×${s.retry.maxAttempts}`
              : s.codeLines != null
                ? `${s.codeLines} lines`
                : null,
        attempt: null,
        // Only `code` steps are generated; `tool`/`agent` etc are not filtered
        // by contract presence — a step without a contract is a draft, not absent.
        generated: s.generated,
        outputHandles: outputHandlesOf(kind, s.contract?.output),
        platform: false,
      };
    });

  const edges: CanvasEdge[] = [];
  for (const s of steps) {
    for (const d of mergeAwareLinks(s.dependsOn, s.sources)) {
      if (ids.has(d)) edges.push({ source: d, target: s.stepId });
    }
  }
  // ⚠ Both adapters collapse through ONE function. See `collapseArms`.
  const arms = branchArms(
    steps.map((s) => ({
      id: s.stepId,
      kind: asKind(s.kind),
      elseOf: s.elseOf ?? null,
      conditionExpr: s.conditionExpr ?? null,
    })),
  );
  const members = armMembership(
    // ⚠ `dependsOn` ONLY, never the merge's sources — the edges above draw the
    // sources so the picture is connected, and feeding them to the closure
    // would put the merge back inside the arm the exemption just took it out
    // of. Drawing a link and inheriting an arm from it are different questions.
    steps.map((s) => ({ id: s.stepId, dependsOn: s.dependsOn ?? [], kind: asKind(s.kind) })),
    arms,
  );
  const armed = collapseArms(withArm(nodes, members), edges, arms);
  return finish(armed.nodes, armed.edges);
}

export function canvasFromRawModel(model: unknown, flagged: Map<string, string> = new Map()): CanvasGraph {
  const steps = (model as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return finish([], []);

  const rows = steps
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      id: typeof s.id === "string" ? s.id : null,
      kind: asKind(typeof s.kind === "string" ? s.kind : null),
      ref: typeof s.ref === "string" ? s.ref : null,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === "string") : [],
      // ⚠ Both fields ride the raw model and BOTH are needed here: `elseOf`
      // links the chain and the ABSENCE of `conditionExpr` is what makes an arm
      // the terminal "otherwise". Reading only `elseOf` labels the last arm
      // "else if" and shows no catch-all.
      elseOf: typeof s.elseOf === "string" ? s.elseOf : null,
      conditionExpr: typeof s.conditionExpr === "string" ? s.conditionExpr : null,
      // A merge's links live here and nowhere else — see `mergeAwareLinks`.
      sources: Array.isArray(s.sources) ? s.sources.filter((d): d is string => typeof d === "string") : null,
      over: fanOutOver(typeof s.paramsExpr === "string" ? s.paramsExpr : null),
    }))
    .filter(
      (s): s is {
        id: string;
        kind: StepKind | null;
        ref: string | null;
        dependsOn: string[];
        elseOf: string | null;
        conditionExpr: string | null;
        sources: string[] | null;
        over: string | null;
      } => s.id !== null,
    );

  const ids = new Set(rows.map((r) => r.id));
  const nodes: CanvasNode[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    ref: r.ref,
    status: null,
    seam: seamOf(r.kind, r.ref),
    // ⚠ A fan-out is the difference between one call and eleven, and it was
    // only ever visible once a step was CLICKED. It belongs on the card.
    meta: r.over ? `once per row · ${r.over}` : null,
    attempt: null,
    generated: r.kind === "code",
    outputHandles: outputHandlesOf(r.kind),
    platform: false,
    flag: flagged.get(r.id) ?? null,
  }));
  const edges: CanvasEdge[] = [];
  for (const r of rows)
    for (const d of mergeAwareLinks(r.dependsOn, r.sources)) if (ids.has(d)) edges.push({ source: d, target: r.id });
  const arms = branchArms(rows);
  const armed = collapseArms(
    withArm(
      nodes,
      // `dependsOn` only for arm membership; see `canvasFromModel`.
      armMembership(rows.map((r) => ({ id: r.id, dependsOn: r.dependsOn, kind: r.kind })), arms),
    ),
    edges,
    arms,
  );
  return finish(armed.nodes, armed.edges);
}

/**
 * Every node upstream and downstream of one node, inclusive — the hover
 * highlight's subject.
 *
 * Both directions in one walk because the question a reviewer is asking is "what
 * is this connected to", not "what does it depend on". Cycle-guarded via the
 * visited set: a flow graph is a DAG, but a bad one must not hang a tab.
 */
export function connectedTo(id: string, edges: CanvasEdge[]): Set<string> {
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const e of edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    inn.set(e.target, [...(inn.get(e.target) ?? []), e.source]);
  }
  const seen = new Set<string>([id]);
  for (const map of [out, inn]) {
    const queue = [id];
    while (queue.length) {
      const n = queue.shift()!;
      for (const next of map.get(n) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * How far along the highlighted path each of its nodes sits — the longest run of links from a root of that path. The hover's
 * flowing edges fade in in this order, so the highlight reads from start to finish rather than lighting all at once.
 */
export function pathDepths(lit: Set<string>, edges: CanvasEdge[]): Map<string, number> {
  const inn = new Map<string, string[]>();
  for (const e of edges) if (lit.has(e.source) && lit.has(e.target)) inn.set(e.target, [...(inn.get(e.target) ?? []), e.source]);
  const depth = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 0; // a cycle cannot be ordered; never loop on one
    stack.add(id);
    const d = Math.max(-1, ...(inn.get(id) ?? []).map((s) => visit(s, stack))) + 1;
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of lit) visit(id, new Set());
  return depth;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE START NODE — the flow's entry point, and its declared inputs
// ─────────────────────────────────────────────────────────────────────────────
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// `AuthoredFlow.inputs` has existed for as long as flows have. It is populated
// (every flow the chat builder produced this week declares one — `as_of`,
// `expires_by`), validated by the compiler, and it drives the test drawer.
// And it appeared on the canvas NOWHERE, so a person reading a flow could not
// see that it takes a parameter at all: running one from a harness meant
// guessing `--input.as_of=` from the step's expression.
//
// ⚠ **This node ADDS NO CLAIM.** It renders `model.inputs` and nothing else —
// no kind, no status, no task type, no ref. That is what makes it free: the
// canvas's own rule is that it draws only what the server sent, and every
// character here came from the model.
//
// ⚠ **Derived every render, like position.** `withStart` is pure and takes the
// inputs as an argument, because the adapters have no model-level view —
// `canvasFromModel` is handed `FlowStepReview[]`, which carries steps and not
// inputs. Same arrangement as `inputHandles`, which `FlowCanvas` merges from a
// prop for the same reason. **Never store it on a revision**: a boundary that
// lived in `model.steps` would reach `writeRevision`, the D-22 allowlist and
// the compiler, all of which correctly have no idea what it is.

/**
 * The Start node's id.
 *
 * ⚠ **Double underscores, and it must stay un-authorable.** `isValidStepId`
 * requires a lower-case letter first, so no step a person or a model can write
 * may ever collide with this — which is what stops a real step being hidden by
 * the boundary, or the boundary being deleted as a step. `startNodeCollides`
 * asserts the property rather than trusting the spelling.
 */
export const START_ID = "__start__";

/** Does any step already own the boundary's id? Then the flow is not shaped as expected. */
export function startNodeCollides(nodeIds: Iterable<string>): boolean {
  for (const id of nodeIds) if (id === START_ID) return true;
  return false;
}

/** One declared input, as the boundary shows it. Structural — the panel formats nothing. */
export type StartInput = {
  id: string;
  type: string;
  required: boolean;
  /** The declared default, when there is one. Never a suggestion — see below. */
  defaults?: string | null;
  /** The shape of text it takes (`month`, `date`, `datetime`), when declared — "string" alone says nothing a person can type. */
  format?: string | null;
  /** Worked out by the engine when the run fires (`priorMonth`, `currentDate`…) — nobody supplies it. */
  computed?: string | null;
  /** With `computed: "currentDate"`: that many days from the day it runs (negative = before). */
  offsetDays?: number | null;
};

/** What a person types for a declared format — the example is the shape, never a suggested value. */
const FORMAT_WORDS: Record<string, string> = { month: "a month, e.g. 2026-09", date: "a date, e.g. 2026-09-30", datetime: "a date and time" };

/** A computed input, in the words the builder offers it with ("the month before it runs"). */
function computedWords(computed: string, offsetDays?: number | null): string {
  const n = offsetDays ?? 0;
  switch (computed) {
    case "priorMonth": return "the month before it runs";
    case "currentMonth": return "the month it runs";
    case "priorDate": return "the day before it runs";
    case "currentDate": return n === 0 ? "the day it runs" : `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"} ${n < 0 ? "before" : "after"} the day it runs`;
    case "currentYear": return "the year it runs";
    case "runTimestamp": return "the moment it runs";
    default: return computed;
  }
}

/**
 * How one input reads on the node.
 *
 * ⚠ **"required" and "optional" are the words, and `defaults` is stated
 * separately.** A required input with a default and a required input without
 * one behave completely differently on a SCHEDULE — the second cannot fire
 * unattended — and collapsing them into one chip is how a flow that works
 * when a person clicks Test fails silently at 09:00. Both halves are shown.
 *
 * ⚠ **A test-drawer SUGGESTION is not a default and is not shown here.**
 * `inputSuggestions` is a convenience for the person running a test; putting
 * it on the node would render a value the schedule will never use as though
 * it were the flow's own.
 */
export function describeStartInput(i: StartInput): CanvasFact {
  // Worked out when it runs: nobody supplies it, so required/default say nothing — what it IS is the whole fact.
  if (i.computed) return { label: i.id, value: `${computedWords(i.computed, i.offsetDays)} · worked out when it runs` };
  const what = (i.format && FORMAT_WORDS[i.format]) || i.type.toLowerCase();
  const req = i.required ? "required" : "optional";
  const def =
    i.defaults != null && i.defaults !== ""
      ? `default ${i.defaults}`
      : i.required
        ? "no default — a scheduled run cannot supply it"
        : "no default";
  return { label: i.id, value: `${what} · ${req} · ${def}` };
}

/**
 * Add the flow's entry point to a graph, wired ahead of every step that nothing
 * else feeds.
 *
 * ⚠ **Returns the SAME graph object when there is nothing to add.** React Flow
 * compares nodes by identity, and a rebuilt array resets `measured`, which
 * discards the handle bounds `parseHandles` needs — every edge then unmounts
 * with nothing flickering to say why (I-66). `overlayStatuses` has the same
 * rule for the same reason.
 *
 * ⚠ **It is added even when the flow declares NO inputs**, and that is the
 * point rather than an oversight: "this automation takes no parameters" is a
 * fact somebody needs, and a node that appears only sometimes reads as a flow
 * being special rather than as a flow having inputs.
 *
 * ⚠ **Roots are computed from the EDGES, never from ordinal position.** On a
 * branching flow an ordinal version attaches the entry point to whichever step
 * happens to be written first, which on an if/elif/else chain is one arm.
 */
export function withStart(
  graph: CanvasGraph,
  inputs: StartInput[] | null | undefined,
  /**
   * How the flow is entered — see the `StartEntry` section at the foot of this
   * file.
   *
   * ⚠ **Optional, and absent means "not supplied" rather than "no schedule".**
   * Every existing call site passes nothing and keeps exactly today's card, so
   * this addition cannot change a surface that has not opted in. When it is
   * absent the caption falls back to the input count, which is what the card
   * has always shown.
   */
  entry?: StartEntry | null,
): CanvasGraph {
  if (!graph.nodes.length) return graph;
  // A graph that already carries one — or a flow with a step by that name,
  // which cannot be authored but can arrive in stored data — is left alone.
  // Adding a second would draw two entry points for one flow.
  if (graph.nodes.some((n) => n.boundary === "start" || n.id === START_ID)) return graph;

  const declared = inputs ?? [];
  const fed = new Set(graph.edges.map((e) => e.target));
  const roots = graph.nodes.filter((n) => !fed.has(n.id)).map((n) => n.id);
  // No root at all means every node is fed by another — a cycle, which the
  // compiler refuses but which stored data could still hold. Drawing an entry
  // point into nothing would claim a shape that is not there.
  if (!roots.length) return graph;

  const node: CanvasNode = {
    id: START_ID,
    label: "Start",
    boundary: "start",
    kind: null,
    ref: null,
    status: null,
    seam: null,
    // ⚠ The entry line comes FIRST, because "what starts this" is the question
    // somebody opens the canvas with and the input count is the supporting
    // detail. Both on one row, which `bodyHeight` already counts — see the
    // sizing warning in the `StartEntry` section.
    meta: entry
      ? `${describeStartEntry(entry)} · ${
          declared.length ? `${declared.length} input${declared.length === 1 ? "" : "s"}` : "no inputs"
        }`
      : declared.length
        ? `${declared.length} input${declared.length === 1 ? "" : "s"}`
        : "no inputs",
    attempt: null,
    generated: false,
    platform: false,
    // Entry facts ahead of the declarations, matching the caption's order. The
    // card SCROLLS these and is never grown by them, so the list is free to be
    // as long as the flow's real entry points make it.
    facts: [
      ...(entry ? startEntryFacts(entry) : []),
      ...(declared.length
        ? declared.map(describeStartInput)
        : [
            {
              label: "inputs",
              value: "none — this automation takes no parameters",
            },
          ]),
    ],
  };
  return {
    ...graph,
    nodes: [node, ...graph.nodes],
    edges: [...graph.edges, ...roots.map((target) => ({ source: START_ID, target }))],
  };
}

/** `AuthoredFlow.inputs` / a stored model's `inputs`, narrowed to what the node needs. */
export function startInputsFrom(inputs: unknown): StartInput[] {
  if (!Array.isArray(inputs)) return [];
  const out: StartInput[] = [];
  for (const raw of inputs) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { id?: unknown; type?: unknown; required?: unknown; defaults?: unknown; format?: unknown; computed?: unknown; offsetDays?: unknown };
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      // ⚠ Never defaulted to a plausible type. An input whose declaration is
      // unreadable must not render as a string that a person then assumes is
      // checked; the node says so instead.
      type: typeof r.type === "string" && r.type ? r.type : "unknown type",
      // ⚠ Absent is OPTIONAL, matching `FlowInput.required?: boolean` and the
      // compiler — not required, which would put "a scheduled run cannot
      // supply it" on an input that is fine.
      required: r.required === true,
      defaults: typeof r.defaults === "string" ? r.defaults : null,
      ...(typeof r.format === "string" && r.format ? { format: r.format } : {}),
      ...(typeof r.computed === "string" && r.computed ? { computed: r.computed } : {}),
      ...(typeof r.offsetDays === "number" ? { offsetDays: r.offsetDays } : {}),
    });
  }
  return out;
}

/**
 * The END boundary's node id. Same reasoning as `START_ID`: `isValidStepId`
 * requires a lower-case first letter, so no authored step can ever own it.
 */
export const END_ID = "__end__";

/** Does any step already own the end boundary's id? */
export function endNodeCollides(nodeIds: Iterable<string>): boolean {
  for (const id of nodeIds) if (id === END_ID) return true;
  return false;
}

/** A flow's declared result, narrowed to what the node needs. */
export type EndOutput = { stepId: string; description: string | null };

/** `FlowModel.output`, narrowed. `null` when nothing is declared or it is unreadable. */
export function endOutputFrom(output: unknown): EndOutput | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { stepId?: unknown; description?: unknown };
  if (typeof o.stepId !== "string" || !o.stepId) return null;
  return {
    stepId: o.stepId,
    description: typeof o.description === "string" && o.description ? o.description : null,
  };
}

/**
 * Append the flow's EXIT POINT.
 *
 * ── ⚠ Why it is drawn even when nothing is declared ─────────────────────────
 *
 * `withStart`'s reasoning applies unchanged: *"a node that appears only
 * sometimes reads as a flow being special rather than as a flow having
 * inputs."* Here it does a second job — a flow with no declared result is a
 * flow no API caller can read an answer out of, and the node saying so on the
 * canvas is the only place a person would ever find that out. Hiding it would
 * make the most common broken state the invisible one.
 *
 * ── ⚠ What it attaches to: every execution LEAF, always ─────────────────────
 *
 * End is the inverse of Start: Start wires from the entry point to every
 * root, End wires from every leaf to the exit point. Leaves are computed
 * from the edges, never from ordinal position, for `withStart`'s reason: on
 * an if/elif/else chain an ordinal version picks one arm.
 *
 * The declared result does NOT choose the edge. It names the value an API
 * caller reads back, which is a fact ABOUT the exit, not the exit itself —
 * so it rides on the node's card (meta + facts) while the edges follow
 * execution. A flow whose answer comes from a mid-chain query still ends
 * after its last side effect, and the canvas finally draws that.
 *
 * ⚠ **A declared step that is not in the graph still says so.** The node
 * renders with the missing-declaration warning, and still terminates the
 * leaves — the execution exit is a fact even when the declaration is
 * broken. `checkFlowOutput` refuses that server-side, so it should be
 * unreachable; stored data predates the check.
 */
export function withEnd(graph: CanvasGraph, output: EndOutput | null | undefined): CanvasGraph {
  if (!graph.nodes.length) return graph;
  if (graph.nodes.some((n) => n.boundary === "end" || n.id === END_ID)) return graph;

  const declared = output ?? null;
  const source = declared ? graph.nodes.find((n) => n.id === declared.stepId) : undefined;

  const feeds = new Set(graph.edges.map((e) => e.source));
  // ⚠ `boundary == null` is DEFENSIVE AND CURRENTLY UNREACHABLE, and the file
  // says so rather than implying it is a control. `withStart` wires the entry
  // point to every root, so it always feeds something and is therefore never a
  // leaf; and this function returns early if an end node is already present.
  // Perturbing it turns nothing red. It stays because a future boundary that
  // feeds nothing would otherwise be silently drawn as the flow's result.
  const leaves = graph.nodes
    .filter((n) => n.boundary == null && !feeds.has(n.id))
    .map((n) => n.id);

  let meta: string;
  let facts: CanvasFact[];
  if (declared && source) {
    meta = declared.description ?? `from ${declared.stepId}`;
    facts = [
      { label: "result", value: `the value of "${declared.stepId}"` },
      ...(declared.description ? [{ label: "which is", value: declared.description }] : []),
    ];
  } else if (declared) {
    meta = "declared result is missing";
    facts = [
      {
        label: "result",
        value: `"${declared.stepId}" — no step by that name is in this automation`,
      },
    ];
  } else {
    meta = "no result declared";
    facts = [
      {
        label: "result",
        value:
          "none — an API caller gets no answer back. Mark the step that produces it.",
      },
    ];
  }

  const node: CanvasNode = {
    id: END_ID,
    label: "End",
    boundary: "end",
    kind: null,
    ref: null,
    status: null,
    seam: null,
    meta,
    attempt: null,
    generated: false,
    platform: false,
    facts,
  };

  // ⚠ Leaves always — the inverse-of-Start rule. The declared result names
  // the answer, not the exit; it is already on the card above. Falling back
  // to nothing when the declaration is broken would draw a dangling exit
  // beside a working chain, which reads as the chain being broken.
  const sources = leaves;
  return {
    ...graph,
    nodes: [...graph.nodes, node],
    edges: [...graph.edges, ...sources.map((s) => ({ source: s, target: END_ID }))],
  };
}

// ── How the flow is ENTERED — the Start boundary's other half ────────────────
//
// ⚠ **THE CANVAS COULD NOT SAY WHAT MAKES A FLOW RUN.** Asked from use, and the
// gap was real rather than cosmetic: a flow's cron lives on its MODEL (D-18)
// and `SchedulePanel` was mounted on ONE surface, the settings page. So the
// canvas — the surface whose entire purpose is letting somebody read the shape
// of an automation at a glance — showed what a flow needs to run and never how
// it starts. `withEnd`'s docblock makes the same argument for the result, and
// this is its other end.
//
// ⚠ **IT GOES ON THE EXISTING START NODE AND IS NOT A NODE OF ITS OWN.** Three
// reasons, and the second is the one that would have caused a real defect:
//
//  1. A schedule is not a step. It has no output, nothing depends on it, it
//     consumes nothing.
//  2. A node before Start means an EDGE into Start, and `armOf` is a blind
//     transitive closure over `dependsOn` — the trap that forced the `merge`
//     kind into existence. `depths()`, `orderedStepIds` and the strip would all
//     need to learn to skip it.
//  3. A single upstream node MISREPRESENTS the model: a flow can carry a cron
//     *and* a manual trigger *and* an API trigger at once, and one node drawn
//     as the entry point claims there is one way in.
//
// A node AFTER Start would be worse than any of those — it reads as "the flow
// begins, then waits for the timer", which is a pause rather than a trigger,
// and collides with the `approval` kind, which genuinely is a wait.
//
// ⚠ **IT COSTS NO SIZING CHANGE, WHICH IS WHY IT IS SAFE.** The entry line goes
// in `meta` — a row `bodyHeight` already counts unconditionally — and the detail
// goes in `facts`, which the boundary card SCROLLS and never grows by. So
// `NODE_W`/`NODE_H` stay true and I-66's quieter successor (a card outgrowing
// its declaration attaches edges to the wrong place with nothing flickering to
// say so) cannot be reached from here. **Do not move the entry line onto a new
// row without adding it to `bodyHeight` in the same commit.**

/** How a flow can be started, as the boundary shows it. Structural — no formatting. */
export type StartEntry = {
  /** The flow model's own `schedule`. Null/absent ⇒ no timer. */
  schedule?: { cron?: string | null; timezone?: string | null } | null;
  /**
   * The flow's trigger rows, narrowed.
   *
   * ⚠ `enabled` is carried and shown because a trigger row is NOT a way in
   * until it is enabled, and every trigger defaults to off — *"a trigger is a
   * standing grant to run something repeatedly and unattended, so the safe
   * state is the default one"*. A boundary listing a disabled trigger as an
   * entry point would be claiming an automation can be reached when it cannot.
   */
  triggers?: Array<{ kind: string; enabled: boolean }>;
  /**
   * The trigger list could not be read.
   *
   * ⚠ **A THIRD STATE, because the other two both lie about it.** Degrading an
   * unreadable list to `[]` makes the caption say *"Manual only"* for a flow
   * that may have an enabled API trigger firing it — an absence of findings
   * nobody obtained, which is the `faFallback` shape and the reason
   * `listPromptBoundaryWarnings` throws rather than returning an empty list.
   * Treating it as "has triggers" would be the opposite lie. So it is neither:
   * the caption says the check did not run.
   */
  triggersUnreadable?: boolean;
};

/**
 * The one-line answer to "what starts this?", for the node's caption.
 *
 * ⚠ **`describeCron`'s answer, never a wording assembled here.** A second
 * description of when something fires is the sentence somebody quotes back
 * after the batch went out at the wrong hour; `lib/cron.ts`'s header is the
 * long form of that argument. An expression the describer cannot read says so
 * plainly rather than being paraphrased.
 *
 * ⚠ **"Manual only" is a FACT, not an empty state.** A flow nothing starts on a
 * timer is the common and correct case, and the canvas saying nothing about it
 * is what this whole addition exists to fix.
 */
export function describeStartEntry(entry: StartEntry | null | undefined): string {
  const cron = entry?.schedule?.cron?.trim();
  if (cron) return describeCron(cron) ?? "a custom schedule";
  const armed = (entry?.triggers ?? []).filter((t) => t.enabled);
  if (armed.length) {
    return armed.length === 1 ? `${armed[0].kind} trigger` : `${armed.length} triggers`;
  }
  // ⚠ Checked AFTER a real schedule and after enabled triggers, because those
  // are facts we do hold and an unreadable trigger list does not put them in
  // doubt. It only decides what "nothing else starts it" is allowed to claim.
  if (entry?.triggersUnreadable) return "No timer · triggers unreadable";
  return "Manual only";
}

/**
 * The facts the boundary shows about entry, ahead of the input declarations.
 *
 * ⚠ **A disabled trigger is reported as disabled rather than omitted.** Omitted,
 * a person who created one and cannot see it concludes the creation failed;
 * listed plainly, they read the actual state — which is that gate 1 wants a
 * successful run before it can be enabled.
 */
export function startEntryFacts(entry: StartEntry | null | undefined): CanvasFact[] {
  const out: CanvasFact[] = [];
  const cron = entry?.schedule?.cron?.trim();
  if (cron) {
    const tz = entry?.schedule?.timezone?.trim();
    out.push({
      label: "timer",
      value: `${describeCron(cron) ?? "a custom schedule"}${tz ? ` · ${tz}` : ""}`,
    });
  } else {
    out.push({ label: "timer", value: "none — nothing runs this on a schedule" });
  }
  if (entry?.triggersUnreadable) {
    out.push({ label: "triggers", value: "could not be read — this is not \"none\"" });
    return out;
  }
  // ⚠ `undefined` emits NOTHING about triggers. A surface that did not read the
  // list must not report "none" for it; saying nothing is the only honest
  // option, and it is why this is `=== undefined` rather than `?? []`.
  if (entry?.triggers === undefined) return out;
  if (entry.triggers.length) {
    for (const t of entry.triggers) {
      out.push({ label: t.kind, value: t.enabled ? "enabled" : "created, not enabled" });
    }
  } else {
    out.push({ label: "triggers", value: "none" });
  }
  return out;
}

/**
 * `{ schedule, triggers }` off a stored model and a trigger list, narrowed.
 *
 * ⚠ Unreadable input yields `{}` rather than a fabricated "manual only" —
 * `describeStartEntry` then says "Manual only", which is the honest reading of
 * a flow with no schedule and no triggers and is also what an unreadable model
 * produces. Stated because the two are indistinguishable here on purpose: the
 * caller that knows the read failed is the panel, and it says so there.
 */
export function startEntryFrom(schedule: unknown, triggers: unknown): StartEntry {
  // ⚠ `null` is the caller SAYING the read failed; `undefined` is "not supplied".
  // A bare `!Array.isArray` check would collapse the two and lose the
  // distinction the `triggersUnreadable` docblock exists for.
  if (triggers === null) {
    return { ...startEntryFrom(schedule, undefined), triggersUnreadable: true };
  }
  const entry: StartEntry = {};
  if (schedule && typeof schedule === "object") {
    const s = schedule as { cron?: unknown; timezone?: unknown };
    if (typeof s.cron === "string" && s.cron.trim()) {
      entry.schedule = {
        cron: s.cron,
        timezone: typeof s.timezone === "string" && s.timezone.trim() ? s.timezone : null,
      };
    }
  }
  if (Array.isArray(triggers)) {
    const out: Array<{ kind: string; enabled: boolean }> = [];
    for (const raw of triggers) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as { type?: unknown; kind?: unknown; enabled?: unknown };
      const kind = typeof t.type === "string" && t.type ? t.type : typeof t.kind === "string" ? t.kind : "";
      if (!kind) continue;
      out.push({ kind, enabled: t.enabled === true });
    }
    // ⚠ An EMPTY array is kept as `[]` and not collapsed to `undefined`. The
    // two mean different things to `startEntryFacts`: `[]` is "checked, there
    // are none", `undefined` is "this surface did not look". Reporting the
    // second as the first is a claim about state nobody read — the same reason
    // `triggersUnreadable` exists at the other end.
    entry.triggers = out;
  }
  return entry;
}
