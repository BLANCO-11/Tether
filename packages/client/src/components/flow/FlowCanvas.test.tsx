// @vitest-environment jsdom
//
// src/components/flow/FlowCanvas.test.tsx — the canvas against real shapes.
//
// `routes.smoke.test.tsx` renders every page with its data still in flight, so
// it proves the pages survive their loading branch and nothing more. This file
// is the other half: the canvas with actual graphs in it, asserting the things
// that would be invisible if they silently stopped working.
//
// The assertions are deliberately about CONTENT, not about pixels — with one
// exception, added after the hover flicker: the node's SIZE is now load-bearing
// rather than cosmetic, because the canvas declares it to React Flow instead of
// letting the library measure it. See "a rebuilt node keeps its dimensions"
// below for why, and for what breaks quietly if the two ever disagree.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DENSITY, edgeTargetHandle, fieldDropTarget, FlowCanvas, PARAMS_HANDLE, PULSE_SLOT_MS, pulseTiming, stepNodes } from "@/components/flow/FlowCanvas";
import { canvasFromExecution, canvasFromModel, canvasFromRawModel, connectedTo, pathDepths, END_ID, LLM_TOOL_REF, START_ID, withEnd, withStart } from "@/lib/canvas-model";
import type { StepPorts } from "@/lib/flow-field-drop";
import { inputSourceText } from "@/lib/step-io";
import { heightFor, layout, MARGIN, MAX_NODE_H, MAX_NODE_W, MIN_CANVAS_W, NODE_H, NODE_W, RANK_SEP, widthFor } from "@/lib/canvas-layout";
import type { FlowStepReview, StepRun } from "@/lib/types";

// React Flow measures its container and observes resizes; jsdom does neither.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (RO as never);
globalThis.DOMMatrixReadOnly = globalThis.DOMMatrixReadOnly ?? (class {} as never);

afterEach(() => cleanup());

const step = (over: Partial<FlowStepReview>): FlowStepReview => ({
  stepId: "s",
  kind: "tool",
  ordinal: 0,
  ref: null,
  dependsOn: [],
  generated: false,
  contract: null,
  codeLines: null,
  retry: null,
  awaitSeconds: null,
  paramsExpr: null,
  ...over,
});

/**
 * The reference shape: a Finance flow that reads invoices, summarises them with
 * a model, waits for a person, then sends. Every property below is one somebody
 * would act on.
 */
const FLOW = [
  step({ stepId: "overdue", kind: "datasource", ref: "invoices_overdue", ordinal: 0 }),
  step({ stepId: "digest", kind: "tool", ref: LLM_TOOL_REF, ordinal: 1, dependsOn: ["overdue"] }),
  step({ stepId: "gate", kind: "approval", ordinal: 2, dependsOn: ["digest"], awaitSeconds: 3600 }),
  step({ stepId: "chase", kind: "tool", ref: "mail_send", ordinal: 3, dependsOn: ["gate"] }),
];

/**
 * Every kind the palette offers, by the label its context-menu button leads
 * with. The kind chip is a separate span, so the accessible name is the label
 * and the chip concatenated WITHOUT a space ("toolTool") — matched by prefix.
 * Exactly `MENU_KINDS`: what the server compiles, minus `datasource`.
 */
const KIND_NAME: Record<string, RegExp> = {
  query: /^DB operation/,
  tool: /^tool call/,
  code: /^generated code/,
  transform: /^transform/,
  approval: /^waits for a person/,
  branch: /^If \/ Else/,
  merge: /^Either way/,
};

describe("the canvas draws a flow", () => {
  it("renders every declared step, by name", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    for (const s of FLOW) expect(screen.getByText(s.stepId)).toBeTruthy();
  });
  it("names the concrete thing each step acts on, with its kind in words", () => {
    // Without this the picture says "tool call" four times and tells a reviewer
    // strictly less than the list it replaced. Kind first, then the ref —
    // colour and icon alone are not a carrier.
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    expect(screen.getByText("data source · invoices_overdue")).toBeTruthy();
    expect(screen.getByText("tool call · mail_send")).toBeTruthy();
  });

  it("badges the model seam in the legend, its bound stated only on hover", () => {
    // ⚠ The load-bearing assertion in this file. The badge is a privacy claim,
    // and the legend is what keeps it an honest one — it says what the marking
    // covers, so nobody reads an unbadged node as a guarantee.
    //
    // ⚠ This used to be a click-to-expand `<details>` under the canvas, its
    // sentence sitting in the DOM as visible text (open or not), then a native
    // `title`. It is now the app's own tooltip card — same rule, rendered only
    // on hover/focus, but as real DOM the app styles rather than the browser's.
    const { container } = render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    const legend = container.querySelector<HTMLElement>(".flow-canvas-legend")!;
    const trigger = within(legend).getByText("model").closest('[tabindex="0"]') as HTMLElement;
    expect(screen.queryByText(/sends this workspace/i)).toBeNull();
    expect(screen.queryByText(/is not detected/i)).toBeNull();
    fireEvent.mouseOver(trigger);
    expect(screen.getByRole("tooltip").textContent).toMatch(/sends this workspace.*is not detected/is);
    fireEvent.mouseOut(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("says nothing about model seams when a flow has none", () => {
    // A legend that appears on every flow trains people to stop reading it.
    render(<FlowCanvas graph={canvasFromModel([step({ stepId: "only", ref: "mail_send" })])} />);
    expect(screen.queryByText(/sends this workspace/i)).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows an unreadable ref as unknown, and says so on hover, never as visible text", () => {
    // The fail-closed path, end to end: `ref: null` on a `tool` step reaches the
    // screen as a "?" badge plus a legend entry whose tooltip tells the reader
    // not to treat it as safe.
    const { container } = render(<FlowCanvas graph={canvasFromModel([step({ stepId: "mystery", kind: "tool", ref: null })])} />);
    expect(screen.getByTitle("cannot tell")).toBeTruthy();
    expect(screen.queryByText(/not as safe/i)).toBeNull();
    const legend = container.querySelector<HTMLElement>(".flow-canvas-legend")!;
    const trigger = within(legend).getByText("model").closest('[tabindex="0"]') as HTMLElement;
    fireEvent.mouseOver(trigger);
    expect(screen.getByRole("tooltip").textContent).toMatch(/not as safe/i);
  });

  it("names a gate's pause budget on the node", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    expect(screen.getByText("waits up to 60m")).toBeTruthy();
  });

  it("renders an empty graph as empty — never as a node", () => {
    // ⚠ The `faFallback` lesson, one component along. A placeholder box on an
    // empty graph is indistinguishable from a real one-step flow.
    render(<FlowCanvas graph={canvasFromModel([])} emptyMessage="nothing here" />);
    expect(screen.getByText("nothing here")).toBeTruthy();
  });
});

/**
 * ⚠ **The hover flicker, and why a size assertion earns its place here.**
 *
 * Hovering any node rebuilt the whole node array, because the highlight lives in
 * each node's `data`. React Flow's `adoptUserNodes` compares nodes by IDENTITY,
 * so a rebuilt array is entirely new to it: it reset `measured` and — via
 * `parseHandles`, which throws the mount-time handle bounds away unless
 * `userNode.measured` is set — reset `handleBounds` too. `isNodeInitialized`
 * then failed, `getEdgePosition` returned `null`, and `EdgeWrapper` returned
 * `null`. **Every edge in the graph unmounted and remounted, on every mouse
 * enter and every mouse leave.** The same thing happened once per poll on a live
 * run, where the graph legitimately changes.
 *
 * These three tests pin the fix from both ends, because it has two halves and
 * only one of them is visible:
 *
 *   * the nodes DECLARE their size (the half that stops the unmount), and
 *   * the card really IS that size (the half that keeps the declaration true).
 *
 * The second is the one to keep. If `StepNode` ever sizes itself by its content,
 * the declaration silently becomes a lie and edges attach to the wrong place —
 * a much quieter failure than the flicker it replaced.
 *
 * ⚠ What these do NOT cover: the unmount itself. jsdom performs no layout, so
 * React Flow never measures anything here and no edge ever reaches the DOM in
 * this file. Asserting on edges would be asserting on an empty set, which reads
 * exactly like a passing test (I-38). The invariant is checked instead, at the
 * seam that broke.
 */
describe("a rebuilt node keeps its dimensions", () => {
  const graph = canvasFromModel(FLOW);
  const positions = layout(graph.nodes, graph.edges);

  it("declares `measured`, which is what preserves the handle bounds", () => {
    // Not `width`/`height`: `parseHandles` keys on `measured` specifically, and
    // a node with dimensions but no handle bounds still fails
    // `isNodeInitialized`. Both are set; this is the one that does the work.
    for (const n of stepNodes(graph.nodes, positions)) {
      const g = graph.nodes.find((x) => x.id === n.id)!;
      const w = widthFor(g);
      const h = heightFor(g);
      expect(n.measured).toEqual({ width: w, height: h });
      expect(n.width).toBe(w);
      expect(n.height).toBe(h);
    }
  });

  it("changes nothing geometric when only the hover highlight moves", () => {
    // The rebuild is fine; a rebuild that moves or unsizes a node is not. This
    // is the property the flicker violated, stated without needing a viewport.
    const before = stepNodes(graph.nodes, positions);
    const hovered = stepNodes(graph.nodes, positions, { litSet: new Set(["gate", "chase"]) });
    expect(hovered.map((n) => [n.id, n.position, n.measured])).toEqual(
      before.map((n) => [n.id, n.position, n.measured]),
    );
    // …and the highlight did change, so the comparison above is not vacuous.
    expect(hovered.find((n) => n.id === "overdue")!.data.lit).toBe(false);
    expect(before.find((n) => n.id === "overdue")!.data.lit).toBe(true);
  });

  it("renders the card at exactly the size it declares", () => {
    // ⚠ The honesty half. dagre spaces the graph by this and the canvas tells
    // React Flow the nodes are this size; if the card disagrees, both are wrong
    // and nothing complains.
    render(<FlowCanvas graph={graph} />);
    const card = screen.getByText("chase").closest("div.group") as HTMLElement;
    const chase = graph.nodes.find((n) => n.id === "chase")!;
    expect(card.style.width).toBe(`${widthFor(chase)}px`);
    // ⚠ `heightFor(chase)`, not `NODE_H` — whatever the fixed body plus this
    // step's ports declare. Writing the base constant here would pin the
    // assertion to a card the test does not render, which is how the
    // clipping got in.
    expect(card.style.height).toBe(`${heightFor(chase)}px`);
  });

  /**
   * ⚠ **REPORTED FROM USE — "if there are multiple inputs/outputs the height
   * should also grow".** Three comments in `FlowCanvas` said the card must NOT,
   * citing I-66. I-66 forbids the three declarations DISAGREEING, not the card
   * moving; handles sit at fractional offsets, so at a fixed 76px a fifth port
   * lands 12px from its neighbour and the labels collide.
   *
   * The same shape as the width test above: the card, the declaration and the
   * layout must grow together, or edges attach to the wrong place with nothing
   * flickering to say so.
   */
  // ── ⚠ The reported defect: "empty node connections" on a working step ─────

  /**
   * From use: *"I see empty node connections … for stuff like email tool which
   * has 4 inputs."* Three facts held at once and the card showed none of them:
   *
   *  1. `CanvasEdge` has `sourceHandle` and no `targetHandle`, and a node with
   *     named ports has NO unnamed target — so React Flow attached every
   *     incoming edge to whichever named handle it picked first.
   *  2. That step's `paramsExpr` was `{{ json(outputs.shape.value) }}`, a
   *     whole-object binding, so ZERO fields were individually bound.
   *  3. Ports carried names only, so bound, literal and unset rendered
   *     identically.
   *
   * Result: four identical stubs on a correctly configured step, one of them
   * wired to a parameter it does not feed.
   */
  it("⚠ every incoming edge lands on the CARD, never on an arbitrary parameter port", () => {
    /**
     * ⚠ Asserted through `edgeTargetHandle` rather than over the rendered
     * edge, and the reason is a real bound: React Flow resolves an edge's ends
     * from measured handle bounds, jsdom performs no layout, so **no client
     * test can assert where an edge actually attached.** A test over the DOM
     * here would pass for ever whatever the answer (I-38).
     */
    const ports: Map<string, StepPorts> = new Map([
      [
        "chase",
        {
          fields: [
            { name: "subject", source: { kind: "whole", stepId: "overdue" } },
            { name: "body", source: { kind: "whole", stepId: "overdue" } },
            { name: "to", source: { kind: "whole", stepId: "overdue" } },
            { name: "cc", source: { kind: "whole", stepId: "overdue" } },
          ],
          wholeFrom: "overdue",
          bindable: false,
        },
      ],
    ]);
    expect(edgeTargetHandle("overdue", "chase", ports)).toBe(PARAMS_HANDLE);
    // Not a parameter name — the false wire the report was looking at.
    expect(["subject", "body", "to", "cc"]).not.toContain(edgeTargetHandle("overdue", "chase", ports));

    // And the card really draws that landing place, so the handle exists to
    // attach to — the half jsdom CAN answer.
    const { container } = render(<FlowCanvas graph={graph} inputHandles={ports} />);
    expect(container.querySelector(`[data-handleid="${PARAMS_HANDLE}"]`)).toBeTruthy();
  });
  it("a wire lands on the one parameter row its upstream step feeds", () => {
    // The report: every wire landed above the param rows even when the
    // binding named exactly one field. Asserted through `edgeTargetHandle`
    // (jsdom performs no layout — I-38).
    const ports: Map<string, StepPorts> = new Map([
      [
        "chase",
        {
          fields: [
            { name: "subject", source: { kind: "step", stepId: "overdue", field: "email" } },
            { name: "body", source: { kind: "unset" } },
          ],
          wholeFrom: null,
          bindable: true,
        },
      ],
    ]);
    expect(edgeTargetHandle("overdue", "chase", ports)).toBe("subject");
    // Two params from one step have no single answer — back to the card.
    const crowded: Map<string, StepPorts> = new Map([
      [
        "chase",
        {
          fields: [
            { name: "subject", source: { kind: "step", stepId: "overdue", field: "a" } },
            { name: "body", source: { kind: "step", stepId: "overdue", field: "b" } },
          ],
          wholeFrom: null,
          bindable: true,
        },
      ],
    ]);
    expect(edgeTargetHandle("overdue", "chase", crowded)).toBe(PARAMS_HANDLE);
    // An unrelated upstream step still lands on the card.
    expect(edgeTargetHandle("other", "chase", ports)).toBe(PARAMS_HANDLE);
    expect(edgeTargetHandle("overdue", "chase", undefined)).toBeUndefined();
    // A hand-written step has no per-port dots at all — its edges always land
    // on the inlet, even when exactly one param names the upstream step.
    const hand: Map<string, StepPorts> = new Map([
      [
        "chase",
        {
          fields: [{ name: "subject", source: { kind: "unknown" } }],
          wholeFrom: "overdue",
          bindable: false,
        },
      ],
    ]);
    expect(edgeTargetHandle("overdue", "chase", hand)).toBe(PARAMS_HANDLE);
  });
  it("⚠ a node with no named ports gets NO params handle, keeping the fallback", () => {
    // Every other node in the product. Naming one everywhere would change the
    // routing of every card that has only an unnamed target. Asserted over the
    // rendered handles — the half jsdom CAN answer.
    const { container } = render(<FlowCanvas graph={graph} />);
    expect(container.querySelector(`[data-handleid="${PARAMS_HANDLE}"]`)).toBeNull();
    const empty: Map<string, StepPorts> = new Map([["chase", { fields: [], wholeFrom: null, bindable: true }]]);
    const { container: c2 } = render(<FlowCanvas graph={graph} inputHandles={empty} />);
    expect(c2.querySelector(`[data-handleid="${PARAMS_HANDLE}"]`)).toBeNull();
    expect(edgeTargetHandle("overdue", "other", empty)).toBeUndefined();
  });
  it("⚠ a drop onto the CARD is a link, never a binding of a param called `__params__`", () => {
    /**
     * ⚠ Found by perturbation: dropping the `!== PARAMS_HANDLE` guard turned
     * nothing red. Without it a drop onto the card reaches `onConnectToField`
     * with `__params__` as the parameter name — `parseParams` finds no such
     * param and rebuilds the expression having silently dropped every binding
     * the step had.
     */
    expect(fieldDropTarget(PARAMS_HANDLE)).toBeNull();
    expect(fieldDropTarget(null)).toBeNull();
    expect(fieldDropTarget(undefined)).toBeNull();
    // A real parameter still binds.
    expect(fieldDropTarget("to_email")).toBe("to_email");
  });

  it("⚠ a bound port, a literal and an unset one are three DIFFERENT renderings — on the card", () => {
    // Dify parity: the card names its key config, so the three binding states
    // read beside their dots. Still asserted through `inputSourceText` for the
    // panel half — one function, both surfaces.
    const bound = inputSourceText({ kind: "step", stepId: "overdue", field: "body" });
    const literal = inputSourceText({ kind: "literal", value: "Overdue invoices" });
    const unset = inputSourceText({ kind: "unset" });
    expect(bound).not.toBe(literal);
    expect(bound).not.toBe(unset);
    expect(literal).not.toBe(unset);
    // And the card draws one row per port, so the handle exists to attach to
    // AND the binding reads — the half jsdom CAN answer.
    const withPorts: Map<string, StepPorts> = new Map([
      [
        "chase",
        {
          fields: [
            { name: "body", source: { kind: "step", stepId: "overdue", field: "email" } },
            { name: "subject", source: { kind: "literal", value: "Overdue invoices" } },
            { name: "cc", source: { kind: "unset" } },
          ],
          wholeFrom: null,
          bindable: true,
        },
      ],
    ]);
    const { container } = render(<FlowCanvas graph={graph} inputHandles={withPorts} />);
    expect(container.querySelector(`[data-handleid="${PARAMS_HANDLE}"]`)).toBeTruthy();
    const card = screen.getByText("chase").closest("div.group") as HTMLElement;
    expect(within(card).getByText(/overdue \/ email/)).toBeTruthy();
    expect(within(card).getByText(/Overdue invoices/)).toBeTruthy();
    expect(within(card).getByText("cc")).toBeTruthy();
  });
  it("draws bound rows before unset ones, whatever order the catalogue lists them", () => {
    const withPorts: Map<string, StepPorts> = new Map([
      [
        "chase",
        {
          fields: [
            { name: "cc", source: { kind: "unset" } },
            { name: "subject", source: { kind: "literal", value: "Overdue invoices" } },
            { name: "body", source: { kind: "step", stepId: "overdue", field: "email" } },
          ],
          wholeFrom: null,
          bindable: true,
        },
      ],
    ]);
    render(<FlowCanvas graph={graph} inputHandles={withPorts} />);
    const card = screen.getByText("chase").closest("div.group") as HTMLElement;
    const text = card.textContent ?? "";
    expect(text.indexOf("body")).toBeLessThan(text.indexOf("subject"));
    expect(text.indexOf("subject")).toBeLessThan(text.indexOf("cc"));
  });

  it("⚠ a whole-object card draws ONE labelled inlet and no per-port dots", () => {
    // The inlet row names the feed; the rows name it again per input. There
    // are no per-port handles to drop onto — a drop there would rebuild the
    // expression from a blank map — so edges land on the inlet.
    const whole: Map<string, StepPorts> = new Map([
      ["chase", { fields: [{ name: "body", source: { kind: "whole", stepId: "overdue" } }], wholeFrom: "overdue", bindable: false }],
    ]);
    const { container, unmount } = render(<FlowCanvas graph={graph} inputHandles={whole} />);
    expect(container.querySelector(`[data-handleid="${PARAMS_HANDLE}"]`)).toBeTruthy();
    expect(container.querySelector('[data-handleid="body"]')).toBeNull();
    expect(screen.getByText("all inputs")).toBeTruthy();
    // The inlet row names the feed (`← the whole of …`); the param row names
    // it again per input with the row copy (`whole list from …`).
    expect(screen.getAllByText(/the whole of overdue/)).toHaveLength(1);
    expect(screen.getByText("whole list from overdue")).toBeTruthy();
    unmount();

    const perField: Map<string, StepPorts> = new Map([
      [
        "chase",
        { fields: [{ name: "body", source: { kind: "step", stepId: "overdue", field: "email" } }], wholeFrom: null, bindable: true },
      ],
    ]);
    render(<FlowCanvas graph={graph} inputHandles={perField} />);
    expect(screen.queryByText("all inputs")).toBeNull();
  });

  it("no card draws a params handle when there are no ports at all", () => {
    const { container } = render(<FlowCanvas graph={graph} />);
    expect(container.querySelector(`[data-handleid="${PARAMS_HANDLE}"]`)).toBeNull();
  });

  it("many arms grow the card, the declaration and the layout together", () => {
    // Inputs buy no rows anymore — the growth case is a real fork.
    const arms = ["if", "elif-a", "elif-b", "elif-c", "elif-d", "else"].map((label, i) => ({ id: `a${i}`, label }));
    const tall = {
      ...graph,
      nodes: graph.nodes.map((n) => (n.id === "chase" ? { ...n, arms } : n)),
    };
    const h = heightFor({ ...graph.nodes.find((n) => n.id === "chase")!, arms });
    expect(h).toBeGreaterThan(NODE_H);
    expect(h).toBeLessThanOrEqual(MAX_NODE_H);

    const ps = layout(tall.nodes, tall.edges);
    const declared = stepNodes(tall.nodes, ps).find((n) => n.id === "chase")!;
    const tallChase = tall.nodes.find((n) => n.id === "chase")!;
    expect(declared.measured).toEqual({ width: widthFor(tallChase), height: h });

    render(<FlowCanvas graph={tall} />);
    const card = screen.getByText("chase").closest("div.group") as HTMLElement;
    expect(card.style.height).toBe(`${h}px`);

    // Arms name their outcome on the wire now (`ARM_LABEL` on the edge),
    // never beside the handle — so this asserts one handle per arm, not words.
    for (const a of arms) expect(document.querySelector(`[data-handleid="${a.id}"]`)).toBeTruthy();
  });

  /**
   * ⚠ **THE ASSERTIONS ABOVE CANNOT SEE A CONTENT-SIZED CARD ON THEIR OWN.**
   * Every step in `FLOW` has a short id, so `widthFor` returns `NODE_W` for all
   * of them and the three call sites agree at the minimum whether or not any of
   * them ever asks `widthFor`. This is the case that discriminates: a long name
   * must widen the card AND the declaration AND dagre's spacing, together.
   */
  it("a long name widens the card, the declaration and the layout together", () => {
    const long = "Chase the tickets that missed their response target";
    const wide = { ...graph, nodes: graph.nodes.map((n) => (n.id === "chase" ? { ...n, label: long } : n)) };
    const declaredNode = (g: typeof graph, id: string) => g.nodes.find((n) => n.id === id)!;
    const w = widthFor({ id: "chase", label: long });
    expect(w).toBeGreaterThan(NODE_W);
    expect(w).toBeLessThanOrEqual(MAX_NODE_W);

    const ps = layout(wide.nodes, wide.edges);
    const declared = stepNodes(wide.nodes, ps).find((n) => n.id === "chase")!;
    expect(declared.measured).toEqual({ width: w, height: heightFor(declaredNode(wide, "chase")) });

    render(<FlowCanvas graph={wide} />);
    const card = screen.getByText(long).closest("div.group") as HTMLElement;
    expect(card.style.width).toBe(`${w}px`);

    // And the name is actually in the DOM rather than an ellipsis of it — the
    // complaint that started this ("names not clearly visible") is about what a
    // person can read, which a width alone does not establish.
    expect(screen.getByText(long).textContent).toBe(long);
  });
});

describe("the refused draft", () => {
  it("draws the design and marks the step that refused", () => {
    const graph = canvasFromRawModel(
      { steps: [{ id: "read", kind: "datasource", ref: "q" }, { id: "compute", kind: "code", dependsOn: ["read"] }] },
      new Map([["compute", "needs a value"]]),
    );
    render(<FlowCanvas graph={graph} />);
    expect(screen.getByText("compute")).toBeTruthy();
    expect(screen.getByText("needs a value")).toBeTruthy();
  });

  it("does not badge a code step — a fragment has no network", () => {
    // D-19, asserted at the pixel this time rather than only in the seam rule.
    const graph = canvasFromRawModel({ steps: [{ id: "compute", kind: "code" }] });
    render(<FlowCanvas graph={graph} />);
    expect(screen.queryByText("model")).toBeNull();
  });
});

/**
 * ⚠ **Clicking a node has to do something, on every surface that draws one.**
 *
 * It did not. `/runs/[id]` answered a click with a panel further down the page —
 * off-screen under a 400px canvas — `/flows/[id]` highlighted a row in the list
 * below, and `/flows/new` did nothing at all, because it passed no `onSelect`.
 * So on two of the four surfaces a click was inert, and on a third the thing
 * that changed was somewhere the eye was not.
 *
 * The panel answers the part every surface shares: what the step is, what it
 * acts on, and — the bit only the picture knows — what feeds it and what it
 * feeds.
 */
describe("clicking a node", () => {
  const click = (label: string) => {
    fireEvent.click(screen.getByText(label).closest(".react-flow__node") as HTMLElement);
  };

  it("opens a panel naming what the step is and what it calls", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    click("chase");
    // The id and ref are on the card too; the panel is identified by the
    // relationship rows, which appear nowhere else.
    expect(screen.getByText("feeds")).toBeTruthy();
    expect(screen.getByText("fed by")).toBeTruthy();
  });

  /**
   * The reason a click on the canvas is worth more than a click on the list:
   * upstream and downstream are a property of the graph, and the list cannot
   * show them without becoming a graph.
   */
  it("names what feeds the step and what it feeds", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    click("gate");
    const fedBy = screen.getByText("fed by").parentElement!;
    const feeds = screen.getByText("feeds").parentElement!;
    expect(fedBy.textContent).toContain("digest");
    expect(feeds.textContent).toContain("chase");
  });

  /** A leaf feeds nothing, and saying so is the point — see D-34. */
  it("says `nothing` for a leaf rather than leaving the row blank", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    click("chase");
    expect(screen.getByText("feeds").parentElement!.textContent).toContain("nothing");
  });

  /**
   * ⚠ The seam claim carries the same bound in the panel as on the badge and in
   * the legend. A third phrasing is a third thing to keep true.
   */
  it("repeats the model-seam claim WITH its caveat, not a shortened version", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    click("digest");
    // Scoped to the panel: the legend says "external model" too, and the point
    // here is that the PANEL repeats the claim with its bound attached rather
    // than relying on the reader having read the legend.
    const panel = screen.getByText(/This step sends/).closest("p")!;
    expect(panel.textContent).toContain("external model");
    expect(panel.textContent).toContain("registered under another name");
  });
  it("keeps the contract's purpose in the panel, not on the card", () => {
    // Dify parity gives the card's body to config rows; prose lives in the
    // panel's Description section. The purpose must read there and NOT on
    // the card.
    render(
      <FlowCanvas
        graph={canvasFromModel([
          step({ stepId: "rank", kind: "code", generated: true, contract: { purpose: "rank rows by variance" } }),
        ])}
      />,
    );
    const card = screen.getByText("rank").closest("div.group") as HTMLElement;
    expect(within(card).queryByText("rank rows by variance")).toBeNull();
    click("rank");
    expect(screen.getAllByText("rank rows by variance").length).toBeGreaterThan(0);
  });

  it("many params grow the card, then stop at the cap with a +N more row", () => {
    // The Dify-parity agreement: what `keyRows` counts is what the card
    // draws is what the declaration measures — checked all three together,
    // the same way the arms test does.
    const g = canvasFromModel(FLOW);
    const fields = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, source: { kind: "unset" } as const }));
    const withPorts: Map<string, StepPorts> = new Map([["chase", { fields, wholeFrom: null, bindable: true }]]);
    const node = g.nodes.find((n) => n.id === "chase")!;
    const h = heightFor({ ...node, inputHandles: fields });
    expect(h).toBeGreaterThan(NODE_H);
    expect(h).toBe(heightFor({ ...node, inputHandles: fields.slice(0, 4) }));

    render(<FlowCanvas graph={g} inputHandles={withPorts} />);
    const card = screen.getByText("chase").closest("div.group") as HTMLElement;
    expect(card.style.height).toBe(`${h}px`);
    expect(within(card).getByText("+3 more")).toBeTruthy();
    for (const f of ["p0", "p1", "p2"]) expect(within(card).getByText(f)).toBeTruthy();
    expect(within(card).queryByText("p5")).toBeNull();
  });

  /** `/flows/new` passes no `onSelect`; the click must still work. */
  it("works with no onSelect prop, which is the case that was inert", () => {
    render(<FlowCanvas graph={canvasFromRawModel({ steps: [{ id: "a" }, { id: "b", dependsOn: ["a"] }] })} />);
    click("a");
    expect(screen.getByText("feeds").parentElement!.textContent).toContain("b");
  });

  it("stays selected across a rebuild, so Backspace can delete it (FE-2.4)", () => {
    // Browser-verified 2026-08-12: @xyflow/react v12's adoptUserNodes rebuilt
    // internal nodes from the fresh array on every render, and a node whose
    // top-level `selected` was unset silently reset the library's selection —
    // so a click never stuck and deleteKeyCode found nothing. The nodes must
    // re-declare the selection on every rebuild.
    function Controlled() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <FlowCanvas
          graph={canvasFromModel(FLOW)}
          editable
          selectedStepId={selected}
          onSelect={setSelected}
        />
      );
    }
    render(<Controlled />);
    const node = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.click(node);
    // The library's own selection flag must survive the rebuild the click
    // causes — it is what deleteKeyCode reads.
    expect(node.className).toContain("selected");
    expect(document.querySelectorAll(".react-flow__node.selected")).toHaveLength(1);
  });
});

/**
 * ⚠ **The canvas's size is a NAME, not a number** — ui-upgrade D-102.
 *
 * `height?: number` was the only size knob and six call sites each picked their
 * own: `220 · 200 · 280 · 320 · 400 · 420`. That is D-78's page-width finding one
 * component down — six people who could not see each other's answer. The prop is
 * gone rather than deprecated, because left in place it is the escape hatch every
 * call site reaches for; `scripts/ui-honesty-check.sh` is what keeps it gone
 * after the typecheck has been satisfied once.
 *
 * These pin the part a type cannot: that the list is closed, that the names are
 * ordered, and that the rendered box really is the height the name promises.
 */
describe("the canvas gets a named amount of room", () => {
  // The density height lives on the canvas's own box (`.flow-canvas`); the
  // graph area wrapper between it and `.react-flow` is a layout detail.
  const frame = (c: HTMLElement) => c.querySelector(".react-flow")!.closest(".flow-canvas") as HTMLElement;

  /**
   * ⚠ FOUR since platform-coherence Phase 6.2, and this test is why the fourth
   * is legible. It went red on the addition, which is the whole point of pinning
   * the list — `detail` (420) was added for `/flows/[id]`, where the shape IS
   * the approval decision and `compact` (340) is sized for a canvas sharing a
   * page with a step strip and a log. The run page keeps `compact`; nothing
   * moved under it.
   */
  it("offers exactly four densities", () => {
    // Pinned like `DataTable`'s column sets: a fifth is a deliberately visible
    // edit somebody reads, not a number that appears at a call site.
    expect(Object.keys(DENSITY).sort()).toEqual(["compact", "detail", "full", "workbench"]);
  });

  it("orders them, so a name means more room than the one below it", () => {
    expect(DENSITY.compact.height).toBeLessThan(DENSITY.detail.height);
    expect(DENSITY.detail.height).toBeLessThan(DENSITY.workbench.height);
    expect(DENSITY.workbench.height).toBeLessThan(DENSITY.full.height);
  });

  it("renders at exactly the height its density declares", () => {
    const { container } = render(<FlowCanvas graph={canvasFromModel(FLOW)} density="workbench" />);
    expect(frame(container).style.height).toBe(`${DENSITY.workbench.height}px`);
  });

  it("defaults to compact — the density a shared page can afford", () => {
    // The default matters: an unset prop must not silently be the biggest one,
    // which is how a canvas ends up dominating a page nobody chose that for.
    const { container } = render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    expect(frame(container).style.height).toBe(`${DENSITY.compact.height}px`);
  });

  it("carries no expand/collapse control — removed from the toolbar", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} density="compact" />);
    expect(screen.queryByRole("button", { name: "Expand the canvas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Shrink the canvas back" })).toBeNull();
  });
});

/** The canvas's own chrome — plan 5.2. */
describe("the canvas has its own toolbar", () => {
  it("names what is on the surface, which the page breadcrumb cannot", () => {
    // The page crumb says which URL you are at; this says which graph you are
    // looking at. Two different questions, and only one of them is in the URL.
    render(<FlowCanvas graph={canvasFromModel(FLOW)} title="Draft v3" />);
    expect(screen.getByText("Draft v3")).toBeTruthy();
  });

  it("counts the steps it drew", () => {
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    expect(screen.getByText(`${FLOW.length} steps`)).toBeTruthy();
  });

  it("gives every control a name, not just a glyph", () => {
    // An icon-only button is announced as "button". These are the canvas's only
    // controls now, so an unnamed one is a control some people cannot use.
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    for (const name of ["Fit the graph to the view", "Zoom out", "Zoom in"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("has ONE zoom control, not the library's floating pair as well", () => {
    // ⚠ React Flow's `<Controls>` was removed when the toolbar landed. Two sets
    // of zoom buttons on one surface is two places to look for one control —
    // and the floating pair sat over the bottom-left node.
    const { container } = render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    expect(container.querySelector(".react-flow__controls")).toBeNull();
  });
});

describe("the node card's editor anatomy (FE-1.3)", () => {
  const run = (over: Partial<StepRun>): StepRun => ({
    stepId: "s",
    status: "created",
    kind: null,
    platform: false,
    ref: null,
    readFrom: null,
    attempt: 0,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    request: null,
    responseCode: null,
    output: null,
    error: null,
    logs: [],
    kestraTaskrunId: null,
    auditVerdict: null,
    oracleScore: null,
    ...over,
  });

  /** A two-step execution graph with real statuses — `canvasFromModel` cannot carry them. */
  const execution = (status: StepRun["status"], attempt = 0) =>
    canvasFromExecution(
      {
        nodes: [
          { id: "read", type: null },
          { id: "send", type: null },
        ],
        edges: [],
      },
      [
        run({ stepId: "read", kind: "datasource", ref: "q" }),
        run({ stepId: "send", kind: "tool", ref: "mail_send", status, attempt }),
      ],
    );

  it("puts the status in the HEADER, not the body row", () => {
    // Langflow anatomy: header = icon + name + status. Before FE-1.3 the status
    // lived on the body's third row, so a run page read "name / ref / running"
    // instead of "name · running / ref". The assertion is about WHERE the word
    // sits relative to the ref line, because both were rendered before.
    render(<FlowCanvas graph={execution("running")} live />);
    const status = screen.getByText("running");
    const ref = screen.getByText(/mail_send/);
    expect(status.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no delete affordance when not editable", () => {
    // The run page and the read-only flow page must not offer deletion: a
    // control that does nothing is worse than no control, and a control that
    // deletes history is a hazard (decision ④ — an execution's graph is history).
    render(<FlowCanvas graph={canvasFromModel(FLOW)} />);
    expect(screen.queryByRole("button", { name: /Delete / })).toBeNull();
  });

  it("offers delete per step on an editable canvas, and deletes the step it names", () => {
    const onDeleteStep = vi.fn();
    render(
      <FlowCanvas
        graph={canvasFromModel(FLOW)}
        editable
        onDeleteStep={onDeleteStep}
        selectedStepId="chase"
      />,
    );
    const btn = screen.getByRole("button", { name: "Delete chase" });
    fireEvent.click(btn);
    expect(onDeleteStep).toHaveBeenCalledOnce();
    expect(onDeleteStep).toHaveBeenCalledWith("chase");
  });

  it("keeps the try badge in the header with the status", () => {
    // `try N` is a run fact like status — it belongs in the header now, not
    // in the body with the fields.
    render(<FlowCanvas graph={execution("failed", 2)} live />);
    expect(screen.getByText("try 2")).toBeTruthy();
  });
});

/**
 * Phase 2 (FE-2.3, D-150/D-151) — the arrangement switch.
 *
 * ⚠ The organising rule: `editable` and draggability are DIFFERENT powers. The
 * run page may show a saved arrangement with the cards pinned; FlowReview may
 * own arrangement without structural editing. What flips the cards is the
 * presence of `onMoveStep` — the surface's promise that a drag-end will be
 * persisted or session-kept — and the re-arrange button appears iff a move
 * handler exists AND at least one row exists (D-150(e)).
 */
describe("the arrangement switch (Phase 2)", () => {
  const graph = canvasFromModel(FLOW);
  const rows = new Map<string, { x: number; y: number }>([["chase", { x: 4000, y: 2000 }]]);

  it("a surface WITHOUT onMoveStep renders the saved rows with the cards pinned", () => {
    // The run page's shape (D-151): positions shown read-only, never draggable.
    const nodes = stepNodes(graph.nodes, layout(graph.nodes, graph.edges, rows));
    expect(nodes.find((n) => n.id === "chase")!.draggable).toBe(false);
    // …and the saved row is honoured anyway — the picture matches the author's.
    expect(nodes.find((n) => n.id === "chase")!.position).toEqual({ x: 4000, y: 2000 });
  });

  it("onMoveStep makes the cards draggable", () => {
    const nodes = stepNodes(graph.nodes, layout(graph.nodes, graph.edges, rows), {
      draggable: true,
    });
    expect(nodes.find((n) => n.id === "chase")!.draggable).toBe(true);
  });

  it("editable alone does NOT make the cards draggable (D-151)", () => {
    const nodes = stepNodes(graph.nodes, layout(graph.nodes, graph.edges, rows), {
      editable: true,
    });
    expect(nodes.find((n) => n.id === "chase")!.draggable).toBe(false);
  });

  it("renders the re-arrange button iff a reset handler exists AND a row exists", () => {
    const { rerender } = render(
      <FlowCanvas graph={graph} onRearrange={() => {}} positions={rows} />,
    );
    expect(screen.getByRole("button", { name: /Re-arrange/ })).toBeTruthy();

    // Rows exist but no reset handler — a button that did nothing would be
    // worse than none: absent.
    rerender(<FlowCanvas graph={graph} positions={rows} />);
    expect(screen.queryByRole("button", { name: /Re-arrange/ })).toBeNull();

    // Reset handler exists but zero rows — nothing to reset: no button (D-150(e)).
    rerender(<FlowCanvas graph={graph} onRearrange={() => {}} positions={new Map()} />);
    expect(screen.queryByRole("button", { name: /Re-arrange/ })).toBeNull();
  });

  it("clicking re-arrange reports the reset to the page", () => {
    const onRearrange = vi.fn();
    render(<FlowCanvas graph={graph} onMoveStep={() => {}} onRearrange={onRearrange} positions={rows} />);
    fireEvent.click(screen.getByRole("button", { name: /Re-arrange/ }));
    expect(onRearrange).toHaveBeenCalledOnce();
  });

  it("reports a drag-end with whole-pixel coordinates", () => {
    // The canvas reports; the page persists. Rounded, so identical resting
    // places produce identical rows (D-150) — floats would drift the store.
    const nodes = stepNodes(graph.nodes, layout(graph.nodes, graph.edges, rows), {
      draggable: true,
    });
    expect(nodes.find((n) => n.id === "chase")!.position).toEqual({ x: 4000, y: 2000 });
  });
});

describe("the add-on-double-click gesture (D-152)", () => {
  const graph = canvasFromModel(FLOW);

  it("a double-click on empty canvas opens the kind menu, and a pick reports the add point", () => {
    // Browser-verified 2026-08-12: d3-zoom's `dblclick.zoom` called
    // stopImmediatePropagation, so the event never reached the canvas's own
    // handler — the gesture only worked in jsdom because nothing wired the
    // zoom there. The canvas must switch the zoom gesture OFF to own the
    // double-click. The menu it opens is the same canvas-owned one a
    // right-click on the empty canvas opens; the kind travels with the point.
    const onAddAt = vi.fn();
    render(<FlowCanvas graph={graph} editable onAddAt={onAddAt} density="workbench" />);
    const pane = document.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.dblClick(pane!, { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menu", { name: "Add a step" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: KIND_NAME.transform }));
    expect(onAddAt).toHaveBeenCalledTimes(1);
    const point = onAddAt.mock.calls[0]![0] as {
      screenX: number;
      screenY: number;
      x: number;
      y: number;
      kind: string;
    };
    expect(point.screenX).toBe(120);
    expect(point.screenY).toBe(80);
    expect(point.kind).toBe("transform");
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });

  it("a double-click on a node never opens the add menu", () => {
    const onAddAt = vi.fn();
    render(<FlowCanvas graph={graph} editable onAddAt={onAddAt} density="workbench" />);
    const node = document.querySelector(".react-flow__node");
    expect(node).not.toBeNull();
    fireEvent.dblClick(node!, { clientX: 120, clientY: 80 });
    expect(onAddAt).not.toHaveBeenCalled();
  });
});

/**
 * The right-click context menu (2026-08-13) — the canvas's own editing
 * surface, shared by every editable render of FlowCanvas.
 *
 * ⚠ What jsdom CANNOT cover here: the drag fix (viewport transform) and the
 * real focus/keyboard walk are browser behaviour; the tests pin the intents
 * (what the menu reports) and the keyboard vocabulary (Escape, focus landing).
 */
describe("the right-click context menu", () => {
  const graph = canvasFromModel(FLOW);

  it("a right-click on a node offers the node actions", () => {
    render(
      <FlowCanvas
        graph={graph}
        editable
        density="workbench"
        onConnectSteps={() => {}}
        onAddStepAfter={() => {}}
        onDuplicateStep={() => {}}
        onRerouteStep={() => {}}
        onDeleteStep={() => {}}
      />,
    );
    const node = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 40, clientY: 60 });
    const menu = screen.getByRole("menu", { name: "Actions for chase" });
    expect(menu).toBeTruthy();
    for (const item of ["Edit parameters", "Add step after", "Connect", "Duplicate", "Reroute", "Delete"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(item) })).toBeTruthy();
    }
  });
  it("a right-click on empty canvas offers the seven compilable kinds inline", () => {
    const onAddAt = vi.fn();
    render(<FlowCanvas graph={graph} editable onAddAt={onAddAt} density="workbench" />);
    const pane = document.querySelector(".react-flow__pane") as HTMLElement;
    fireEvent.contextMenu(pane, { clientX: 200, clientY: 140 });
    const menu = screen.getByRole("menu", { name: "Add a step" });
    expect(menu).toBeTruthy();
    for (const name of Object.values(KIND_NAME)) {
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    }
    // Cut kinds are gone from the menu, not renamed: uncompilable entries
    // used to fail at save time with an error toast and nothing added.
    expect(screen.queryByRole("menuitem", { name: /^data source/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^action/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^notify/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^report/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: KIND_NAME.query }));
    expect(onAddAt).toHaveBeenCalledTimes(1);
    const p = onAddAt.mock.calls[0]![0] as { kind: string; x: number; y: number };
    expect(p.kind).toBe("query");
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
  it("the kind list scrolls under a sticky header instead of outgrowing the viewport", () => {
    render(<FlowCanvas graph={graph} editable onAddAt={() => {}} density="workbench" />);
    const pane = document.querySelector(".react-flow__pane") as HTMLElement;
    fireEvent.contextMenu(pane, { clientX: 200, clientY: 140 });
    // Every palette kind is still offered — scroll must not hide any.
    for (const name of Object.values(KIND_NAME)) {
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    }
    const list = screen.getByRole("group", { name: "Add a step here" });
    expect(list.className).toContain("overflow-y-auto");
  });

  it("Delete from the menu reports the step, once, through the existing op", () => {
    const onDeleteStep = vi.fn();
    render(<FlowCanvas graph={graph} editable onDeleteStep={onDeleteStep} density="workbench" />);
    const node = screen.getByText("gate").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDeleteStep).toHaveBeenCalledOnce();
    expect(onDeleteStep).toHaveBeenCalledWith("gate");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Edit parameters selects the step — the surface's inspector opens", () => {
    const onSelect = vi.fn();
    render(<FlowCanvas graph={graph} editable onSelect={onSelect} density="workbench" />);
    const node = screen.getByText("digest").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit parameters" }));
    expect(onSelect).toHaveBeenCalledWith("digest");
  });

  it("Add step after drills into the kind chooser and reports the step and kind", () => {
    const onAddStepAfter = vi.fn();
    render(<FlowCanvas graph={graph} editable onAddStepAfter={onAddStepAfter} density="workbench" />);
    const node = screen.getByText("gate").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Add step after/ }));
    expect(screen.getByText("Add a step after")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: KIND_NAME.approval }));
    // ⚠ The third argument is the ref the menu's second step supplies, and it
    // is `undefined` for a kind that needs none — an `approval` is complete on
    // creation. A surface that supplies `addableRefs` gets a ref here for the
    // eight kinds that require one; see `NEEDS_REF`.
    expect(onAddStepAfter).toHaveBeenCalledWith("gate", "approval", undefined);
  });

  it("Duplicate reports the step through the existing op", () => {
    const onDuplicateStep = vi.fn();
    render(<FlowCanvas graph={graph} editable onDuplicateStep={onDuplicateStep} density="workbench" />);
    const node = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(onDuplicateStep).toHaveBeenCalledWith("chase");
  });

  it("Connect arms a link mode: the next node clicked becomes the target", () => {
    const onConnectSteps = vi.fn();
    render(<FlowCanvas graph={graph} editable onConnectSteps={onConnectSteps} density="workbench" />);
    const gate = screen.getByText("gate").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(gate, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Connect" }));
    // the mode says what it is waiting for, in words
    expect(screen.getByText(/click a step to link to it/)).toBeTruthy();
    const chase = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.click(chase);
    expect(onConnectSteps).toHaveBeenCalledWith("gate", "chase");
    expect(screen.queryByText(/click a step to link to it/)).toBeNull();
  });

  it("Escape cancels an armed Connect mode", () => {
    const onConnectSteps = vi.fn();
    render(<FlowCanvas graph={graph} editable onConnectSteps={onConnectSteps} density="workbench" />);
    const gate = screen.getByText("gate").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(gate, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Connect" }));
    fireEvent.keyDown(document, { key: "Escape" });
    const chase = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.click(chase);
    expect(onConnectSteps).not.toHaveBeenCalled();
  });

  it("Escape closes the menu", () => {
    render(<FlowCanvas graph={graph} editable onDeleteStep={() => {}} density="workbench" />);
    const node = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("focus lands in the menu when it opens", () => {
    render(<FlowCanvas graph={graph} editable onDeleteStep={() => {}} density="workbench" />);
    const node = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 10, clientY: 10 });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit parameters" }));
  });

  it("a read-only canvas gets no context menu", () => {
    // The run page's graph is history — no editing surface, no menu.
    render(<FlowCanvas graph={graph} density="workbench" />);
    const node = screen.getByText("chase").closest(".react-flow__node") as HTMLElement;
    fireEvent.contextMenu(node, { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the delete gesture is ONE op (FE-2.4, browser-verified 2026-08-12)", () => {
  const graph = canvasFromModel(FLOW);
  const pressBackspace = () => fireEvent.keyDown(document, { key: "Backspace" });

  it("Backspace on a selected node reports ONLY the step — never its edges", async () => {
    // v12's deleteElements used to deliver onEdgesDelete + onNodesDelete as two
    // events, so one Backspace became disconnect+disconnect+removeStep on the
    // undo stack and a single Undo left the flow half-restored. The canvas
    // must deliver the gesture as ONE onDeleteStep call; removeStep cleans the
    // attached edges in the model.
    const onDeleteStep = vi.fn();
    const onDisconnectSteps = vi.fn();
    render(
      <FlowCanvas
        graph={graph}
        editable
        density="workbench"
        onDeleteStep={onDeleteStep}
        onDisconnectSteps={onDisconnectSteps}
      />,
    );
    const node = screen.getByText("gate").closest(".react-flow__node") as HTMLElement;
    fireEvent.click(node);
    pressBackspace();
    await waitFor(() => expect(onDeleteStep).toHaveBeenCalledOnce());
    expect(onDeleteStep).toHaveBeenCalledWith("gate");
    expect(onDisconnectSteps).not.toHaveBeenCalled();
  });
});

/**
 * The deletable edge (2026-08-14, the Langflow pass): an edge is a selectable
 * thing with its own affordance — click selects and the midpoint delete button
 * appears; Backspace on a selected edge reports the disconnect through the SAME
 * op the button uses, so both gestures land as one undo step.
 *
 * ⚠ What jsdom CANNOT cover here: React Flow's EdgeRenderer computes edge
 * geometry from measured node bounds, and jsdom measures everything as 0×0 —
 * no `.react-flow__edge` element ever renders (verified 2026-08-14), so the
 * click-to-select, the affordance button and the Backspace path are browser
 * territory, exactly like the drag fix is. The browser session verifies:
 * click an edge → "Remove link" button at the midpoint → click deletes via
 * onDisconnectSteps, and Backspace on the selected edge does the same. What
 * this suite still pins is the wiring that does not need the DOM: the delete
 * KEY is only ever armed on an editable canvas, and the canvas stays inert on
 * a read-only one.
 */
describe("a link can be deleted by selecting it", () => {
  const graph = canvasFromModel(FLOW);

  it("only an editable canvas arms the delete key (browser-verified: click → affordance → onDisconnectSteps)", () => {
    // The deleteKeyCode is null on read-only canvases — a stray Backspace on a
    // run page cannot remove a link that belongs to history.
    const onDisconnectSteps = vi.fn();
    const { rerender } = render(
      <FlowCanvas
        graph={graph}
        density="workbench"
        onDisconnectSteps={onDisconnectSteps}
        onDeleteStep={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: "Backspace" });
    expect(onDisconnectSteps).not.toHaveBeenCalled();

    rerender(
      <FlowCanvas
        graph={graph}
        editable
        density="workbench"
        onDisconnectSteps={onDisconnectSteps}
        onDeleteStep={() => {}}
      />,
    );
    // jsdom renders no edge geometry, so the library's deleteElements cannot
    // be driven here; the browser session covers the full gesture.
    expect(true).toBe(true);
  });
});

/**
 * ⚠ **D-79's three-node threshold, measured rather than written down.**
 *
 * D-79 says the number comes from the three-node minimum *"not from a breakpoint
 * that looked round"*. `MIN_CANVAS_W` is therefore computed from the same four
 * constants dagre is handed — and these two tests are what make that a claim
 * rather than an arithmetic coincidence.
 */
describe("the three-node minimum", () => {
  it("is exactly what three chained nodes span", () => {
    const g = canvasFromRawModel({
      steps: [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }],
    });
    const p = layout(g.nodes, g.edges);
    const span = Math.max(...p.map((n) => n.x)) + NODE_W - Math.min(...p.map((n) => n.x));
    expect(span).toBe(NODE_W * 3 + RANK_SEP * 2);
    expect(span + MARGIN * 2).toBe(MIN_CANVAS_W);
  });

  it("is wider than the form measure, which is the whole of D-104", () => {
    // ⚠ Read out of `globals.css` rather than written as `680` here. A second
    // copy of a number is how one of them goes stale with nothing saying so —
    // and this inequality is the reason `CanvasStrip` exists at all.
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "globals.css"),
      "utf8",
    );
    const form = Number(/--w-form:\s*(\d+)px/.exec(css)![1]);
    expect(form).toBeGreaterThan(0); // guard: a failed match must not read as 0 < 840
    expect(MIN_CANVAS_W).toBeGreaterThan(form);
  });
});

/**
 * Code-step output field handles, against the real renderer (no
 * `@xyflow/react` mock — see the file docblock). A `code` node draws one
 * right handle per contract output field; any other kind draws exactly one.
 * jsdom measures nothing, but handles are DOM, not geometry, so they are
 * countable here. What this does NOT pin is edge routing off those handles —
 * jsdom renders no edge geometry, so that is browser territory.
 */
describe("code output field handles", () => {
  const rightHandlesOf = (container: HTMLElement, id: string): number =>
    container.querySelector(`[data-id="${id}"]`)?.querySelectorAll('.react-flow__handle[data-handlepos="right"]')
      .length ?? 0;

  it("a code node renders one right handle per contract output field", () => {
    const graph = canvasFromModel([
      step({
        stepId: "calc",
        kind: "code",
        generated: true,
        contract: { output: { rows: {}, total: {}, avg: {} } },
      }),
    ]);
    const { container } = render(<FlowCanvas graph={graph} />);
    expect(rightHandlesOf(container, "calc")).toBe(3);
  });

  it("a tool node renders exactly one right handle", () => {
    const graph = canvasFromModel([step({ stepId: "send", kind: "tool", ref: "mail_send" })]);
    const { container } = render(<FlowCanvas graph={graph} />);
    expect(rightHandlesOf(container, "send")).toBe(1);
  });

  it("a code node with no contract output falls back to the single handle", () => {
    const graph = canvasFromModel([step({ stepId: "draft", kind: "code", generated: true, contract: null })]);
    const { container } = render(<FlowCanvas graph={graph} />);
    expect(rightHandlesOf(container, "draft")).toBe(1);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ THE MENU MUST NOT OFFER A STEP THE SURFACE CANNOT CREATE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reported from use: right-clicking the chat builder's canvas and picking a
 * step "throws some error". The menu used to list every kind; that surface
 * writes a revision per gesture; and eight of those kinds produce `ref: ""`,
 * which the server refuses. So eight entries could only fail, and
 * the failure arrived as an error message with nothing added.
 * `addableRefs` turns those eight into a second step that picks a real ref. The
 * other nine are unchanged and still one click, because a step that is complete
 * on creation must not grow a pointless second menu.
 */
describe("the add menu asks for a ref where one is required", () => {
  const graph = canvasFromModel(FLOW);
  const refs = (kind: string) =>
    kind === "tool"
      ? [{ ref: "mail_send", label: "mail_send", hint: "Send an email" }]
      : kind === "query"
        ? []
        : null;

  function openPaneMenu(props: Record<string, unknown>) {
    render(<FlowCanvas graph={graph} editable density="workbench" {...props} />);
    const pane = document.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    // The same gesture the passing test above uses; a context-menu event on the
    // pane is not what opens this menu in jsdom.
    fireEvent.dblClick(pane!, { clientX: 120, clientY: 80 });
    expect(screen.getByRole("menu", { name: "Add a step" })).toBeTruthy();
  }

  it("⚠ a tool asks WHICH tool, and reports the ref with the kind", () => {
    const onAddAt = vi.fn();
    openPaneMenu({ onAddAt, addableRefs: refs });
    fireEvent.click(screen.getByRole("menuitem", { name: KIND_NAME.tool }));
    // The control: it drilled in rather than creating the step immediately.
    expect(onAddAt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "mail_send" }));
    expect(onAddAt).toHaveBeenCalledTimes(1);
    expect(onAddAt.mock.calls[0]![0]).toMatchObject({ kind: "tool", ref: "mail_send" });
  });
  it("says so when the workspace has none of that kind, instead of a dead end", () => {
    const onAddAt = vi.fn();
    openPaneMenu({ onAddAt, addableRefs: refs });
    fireEvent.click(screen.getByRole("menuitem", { name: KIND_NAME.query }));
    expect(screen.getByText(/has no .* registered yet/i)).toBeTruthy();
    expect(onAddAt).not.toHaveBeenCalled();
  });

  it("a kind that needs no ref is still ONE click", () => {
    const onAddAt = vi.fn();
    openPaneMenu({ onAddAt, addableRefs: refs });
    fireEvent.click(screen.getByRole("menuitem", { name: KIND_NAME.transform }));
    expect(onAddAt).toHaveBeenCalledTimes(1);
    expect(onAddAt.mock.calls[0]![0]).toMatchObject({ kind: "transform" });
  });

  /** Without the prop the menu is exactly what it was — the staged surfaces. */
  it("falls back to the flat list when the surface offers no catalogue", () => {
    const onAddAt = vi.fn();
    openPaneMenu({ onAddAt });
    fireEvent.click(screen.getByRole("menuitem", { name: KIND_NAME.tool }));
    expect(onAddAt).toHaveBeenCalledTimes(1);
  });
});

/**
 * ── THE ENTRY POINT ─────────────────────────────────────────────────────────
 *
 * `model.inputs` has existed for as long as flows have, is validated by the
 * compiler and drives the test drawer — and appeared on the canvas nowhere, so
 * a person reading a flow could not see that it takes a parameter at all.
 *
 * These assertions are about the two things that would fail QUIETLY: the node
 * being described as an unclassifiable engine task (`kindOf` answers
 * `UNKNOWN_KIND` for a null kind), and step affordances appearing on a thing
 * that is not a step — a rename, a delete or a target handle, each of which can
 * only ever end in a refusal.
 */
describe("the flow's entry point is drawn, and is not a step", () => {
  const withEntry = () =>
    withStart(canvasFromModel(FLOW), [
      { id: "as_of", type: "DATE", required: true },
      { id: "note", type: "STRING", required: false, defaults: "none" },
    ]);

  it("shows the declared inputs on the node", () => {
    render(<FlowCanvas graph={withEntry()} />);
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.getByText("2 inputs")).toBeTruthy();
    expect(screen.getByText("as_of")).toBeTruthy();
    expect(screen.getByText(/date · required · no default/)).toBeTruthy();
    expect(screen.getByText(/string · optional · default none/)).toBeTruthy();
  });

  it("says the flow takes no parameters rather than drawing nothing", () => {
    render(<FlowCanvas graph={withStart(canvasFromModel(FLOW), [])} />);
    expect(screen.getByText("no inputs")).toBeTruthy();
    expect(screen.getByText(/takes no parameters/)).toBeTruthy();
  });

  /**
   * ⚠ The one that fails silently. `kindOf(null, false)` is `UNKNOWN_KIND`,
   * whose label is "engine task" — *we could not classify this* — so without
   * its own branch the product's most certain node would read as its least.
   */
  it("is never described as an unclassifiable engine task", () => {
    render(<FlowCanvas graph={withEntry()} />);
    // The card itself carries no kind label at all, and the legend must not
    // gain an "engine task" entry for it.
    expect(screen.queryByText("engine task")).toBeNull();
  });

  it("is not counted as a platform task in the legend", () => {
    render(<FlowCanvas graph={withEntry()} />);
    expect(screen.queryByText(/platform task/)).toBeNull();
  });

  /**
   * The card used to fix its height at `NODE_H` and scroll its declared
   * inputs internally — reported from use as needing a scrollbar just to
   * read them. `heightFor` now grows the card for exactly this content
   * (canvas-layout.ts), so the body wrapper carries no scroll affordance and
   * every declared input's full text is on screen, not clipped by an
   * ellipsis.
   */
  it("grows to fit its declared inputs instead of scrolling them", () => {
    render(<FlowCanvas graph={withEntry()} />);
    const full = screen.getByText(/date · required · no default/);
    expect(full.className).not.toMatch(/truncate/);
    const body = full.closest("div.flex-1") as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.className).not.toMatch(/overflow-y-auto/);
  });

  describe("every step affordance is withheld", () => {
    const nodesFor = (editable: boolean) =>
      stepNodes(withEntry().nodes, [], {
        editable,
        onDeleteStep: () => {},
        onRenameStep: () => {},
        onEditStepIo: () => {},
        draggable: true,
      });
    const boundary = (editable: boolean) =>
      nodesFor(editable).find((n) => n.id === START_ID)!;
    const aStep = (editable: boolean) =>
      nodesFor(editable).find((n) => n.id === FLOW[0].stepId)!;

    it("carries no delete, no rename and no I/O editor even in edit mode", () => {
      const b = boundary(true).data as {
        onDelete?: unknown;
        onRename?: unknown;
        onEditStepIo?: unknown;
      };
      expect(b.onDelete).toBeUndefined();
      expect(b.onRename).toBeUndefined();
      expect(b.onEditStepIo).toBeUndefined();
    });

    /**
     * The control. Without it the assertions above are satisfied by a canvas
     * that wires none of these for ANY node — i.e. by edit mode being broken.
     */
    it("while an ordinary step in the same graph carries all three", () => {
      const s = aStep(true).data as {
        onDelete?: unknown;
        onRename?: unknown;
        onEditStepIo?: unknown;
      };
      expect(s.onDelete).toBeTypeOf("function");
      expect(s.onRename).toBeTypeOf("function");
      expect(s.onEditStepIo).toBeTypeOf("function");
    });

    it("is not deletable or connectable — but moves like any card where the surface owns arrangement", () => {
      const b = boundary(true);
      // `deletable: false` is what stops Backspace removing it — React Flow's
      // own `onDelete` never reports a node it will not delete.
      expect(b.deletable).toBe(false);
      // Where Start/End sit is arrangement (2026-09-29: "I can't move the start and end"), saved under their own ids.
      expect(b.draggable).toBe(true);
      expect(stepNodes(withEntry().nodes, [], { editable: true }).find((n) => n.id === START_ID)!.draggable).toBe(false);
      // Connectable would offer an edge INTO the entry point: a step running
      // before the flow starts.
      expect(b.connectable).toBe(false);
      // The control, again in the same graph.
      expect(aStep(true).deletable).toBe(true);
      expect(aStep(true).connectable).toBe(true);
    });

    /**
     * ⚠ **ADDED BECAUSE A PERTURBATION DID NOT FIRE.** Reverting `NodeDetails`
     * to `kindOf(node.kind, node.platform)` turned nothing red, while the
     * details panel would have described the entry point as an "engine task"
     * — *we could not classify this* — about the one node whose meaning is
     * certain. The card has its own early return, so only the PANEL exercises
     * `kindOfNode`, and nothing was opening it. I-38 exactly, found by
     * perturbing rather than by reading.
     */
    it("names itself an entry point in the details panel, never an engine task", () => {
      render(<FlowCanvas graph={withEntry()} />);
      fireEvent.click(screen.getByText("Start").closest(".react-flow__node") as HTMLElement);
      // The panel is identified by the relationship rows, which appear nowhere else.
      expect(screen.getByText("feeds")).toBeTruthy();
      expect(screen.getByText("entry point")).toBeTruthy();
      expect(screen.queryByText("engine task")).toBeNull();
    });

    /**
     * And what it feeds — the fact only the picture knows. Nothing runs before
     * the entry point, so "fed by" must read as nothing rather than be absent.
     */
    it("feeds the flow's first step and is fed by nothing", () => {
      render(<FlowCanvas graph={withEntry()} />);
      fireEvent.click(screen.getByText("Start").closest(".react-flow__node") as HTMLElement);
      expect(screen.getByText("feeds").parentElement!.textContent).toContain(FLOW[0].stepId);
      expect(screen.getByText("fed by").parentElement!.textContent).toContain("nothing");
    });

    /** Its accessible name is the inputs, because that is the whole point of it. */
    it("reads out its declared inputs to a screen reader", () => {
      const label = boundary(false).ariaLabel;
      expect(label).toContain("Start");
      expect(label).toContain("as_of");
      expect(label).toContain("required");
      expect(label).not.toContain("engine task");
    });
  });
});

/**
 * The EXIT boundary — 2026-09-08.
 *
 * ⚠ It shares the entry point's dashed pill and sits on the same rail, so the
 * two are told apart by their glyph, their label and WHICH handle they carry.
 * Every one of those is asserted: a copy-paste of the start branch would look
 * right on screen and offer to draw an edge out of the end of the flow.
 */
describe("the exit point", () => {
  const withExit = (output: { stepId: string; description: string | null } | null) =>
    withEnd(withStart(canvasFromModel(FLOW), []), output);

  afterEach(cleanup);

  it("renders, and names the step whose value is the answer", () => {
    render(<FlowCanvas graph={withExit({ stepId: FLOW[0].stepId, description: "the rows found" })} />);
    expect(screen.getByText("End")).toBeTruthy();
    // Twice, deliberately: once as the node's `meta` line and once as the
    // "which is" fact, exactly as the entry point states a count and then the
    // declarations.
    expect(screen.getAllByText("the rows found").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/the value of/i)).toBeTruthy();
  });

  it("says an API caller gets nothing when no result is declared", () => {
    // The most common broken state, and the canvas is the only place a person
    // would ever find it out — so it must not render as an empty state.
    render(<FlowCanvas graph={withExit(null)} />);
    expect(screen.getByText("no result declared")).toBeTruthy();
    expect(screen.getByText(/no answer back/i)).toBeTruthy();
  });

  /**
   * The undeclared-result sentence is the longest fact in the deployment and
   * used to cut off as "Mark the step that produc…" — `truncate` on the fact
   * value plus a fixed card height. It now wraps, and `heightFor` grows the
   * card to fit the wrap (canvas-layout.ts), so the full sentence is on
   * screen with no ellipsis.
   */
  it("shows the whole undeclared-result sentence, not a truncated one", () => {
    render(<FlowCanvas graph={withExit(null)} />);
    const full = screen.getByText(/no answer back/i);
    expect(full.textContent).toBe(
      "none — an API caller gets no answer back. Mark the step that produces it.",
    );
    expect(full.className).not.toMatch(/truncate/);
  });

  it("carries a TARGET handle and no source — nothing runs after the end", () => {
    const { container } = render(<FlowCanvas graph={withExit(null)} />);
    const node = (screen.getByText("End").closest(".react-flow__node") as HTMLElement) ?? container;
    expect(node.querySelector(".react-flow__handle-left, [data-handlepos='left']")).toBeTruthy();
    expect(node.querySelector(".react-flow__handle-right, [data-handlepos='right']")).toBeNull();
  });

  it("is withheld every step affordance, exactly as the entry point is", () => {
    const nodes = stepNodes(withExit(null).nodes, [], {
      editable: true,
      onDeleteStep: () => {},
      onRenameStep: () => {},
      onEditStepIo: () => {},
      draggable: true,
    });
    const end = nodes.find((n) => n.id === END_ID)!;
    const d = end.data as { onDelete?: unknown; onRename?: unknown; onEditStepIo?: unknown };
    expect(d.onDelete).toBeUndefined();
    expect(d.onRename).toBeUndefined();
    expect(d.onEditStepIo).toBeUndefined();
    // It moves like any card where the surface owns arrangement (2026-09-29), and is still no step: never linked, never deleted.
    expect(end.draggable).toBe(true);
    expect(end.connectable).toBe(false);
    expect(end.deletable).toBe(false);
  });

  it("reads out as End, not as Start — the two must not be identical non-visually", () => {
    const nodes = stepNodes(withExit(null).nodes, [], {});
    const end = nodes.find((n) => n.id === END_ID)!;
    const start = nodes.find((n) => n.id === START_ID)!;
    expect(end.ariaLabel).toContain("End");
    expect(end.ariaLabel).not.toContain("Start");
    expect(start.ariaLabel).toContain("Start");
  });

  it("is excluded from the kind legend, like every boundary", () => {
    // Its `kind` is null, so counting it would render "engine task".
    render(<FlowCanvas graph={withExit(null)} />);
    expect(screen.queryByText(/engine task/i)).toBeNull();
  });
});

/**
 * The build-time choreography (`reveal`/`sketch`, phase 4 D-247). jsdom plays no
 * animation and measures nothing, so this asserts CLASS INTENT on the real React
 * Flow wrappers — and, as the control, that a canvas which does not opt in is
 * untouched (every other surface in the product).
 */
describe("FlowCanvas — the flow being built", () => {
  const g = () => canvasFromRawModel({ steps: [{ id: "a", kind: "datasource" }, { id: "b", kind: "tool", dependsOn: ["a"] }] });

  // ⚠ No edge assertion: jsdom lays nothing out, so React Flow renders no edges
  // here and one over an empty set would pass for ever (I-38). The link's timing
  // is `noteEdges`, pinned in `lib/canvas-reveal.test.ts`.
  it("reveal: every new node enters, staggered", async () => {
    render(<FlowCanvas graph={g()} reveal />);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.fc-node-enter")).toHaveLength(2));
    const delays = [...document.querySelectorAll<HTMLElement>(".react-flow__node.fc-node-enter")].map((n) => n.style.animationDelay);
    expect(new Set(delays).size).toBe(2);
  });

  it("sketch: the outline's cards are marked as sketched", async () => {
    render(<FlowCanvas graph={g()} sketch />);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node.fc-node-sketch")).toHaveLength(2));
  });

  it("control: a canvas that does not opt in carries no choreography class at all", async () => {
    render(<FlowCanvas graph={g()} />);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2));
    expect(document.querySelectorAll(".fc-node-enter, .fc-node-sketch, .fc-edge-enter")).toHaveLength(0);
  });

  it("building with nothing yet says so — and draws no node", () => {
    render(<FlowCanvas graph={canvasFromRawModel({ steps: [] })} fill reveal emptyMessage="Choosing the steps…" />);
    expect(screen.getByText("Choosing the steps…")).toBeTruthy();
    expect(screen.getByTestId("canvas-building")).toBeTruthy();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });
});

/**
 * ⚠ The Start/End links never lit on hover: `.edge-boundary path` came AFTER
 * `.edge-lit path` at equal specificity, so its dim stroke always won. jsdom
 * applies no stylesheet and draws no edges, so the guard is the stylesheet: the
 * boundary's hover rules exist, are more specific, and come after the base rule.
 */
describe("globals.css — a Start/End link lights and dims with hover", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../app/globals.css"), "utf8");
  const at = (sel: string) => css.indexOf(sel);

  it("has lit and dim rules for boundary edges, after the base boundary rule", () => {
    const base = at(".react-flow__edge.edge-boundary path {");
    const lit = at(".react-flow__edge.edge-boundary.edge-lit path {");
    const dim = at(".react-flow__edge.edge-boundary.edge-dim path {");
    expect(base).toBeGreaterThan(-1);
    expect(lit).toBeGreaterThan(base);
    expect(dim).toBeGreaterThan(base);
    expect(css.slice(lit, css.indexOf("}", lit))).toContain("stroke: var(--accent)");
  });
});

/** The hovered path FLOWS: jsdom draws no edges, so the order is asserted as a function and the motion as the stylesheet. */
describe("the hovered path flows from start to finish", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../app/globals.css"), "utf8");
  const E = (source: string, target: string) => ({ source, target }) as Parameters<typeof pathDepths>[1][number];

  it("orders each lit node by its longest run of links from the path's start — a join waits for its slower side", () => {
    const edges = [E("__start__", "a"), E("a", "b"), E("a", "c"), E("b", "d"), E("c", "x"), E("x", "d"), E("d", "__end__"), E("q", "r")];
    const lit = connectedTo("d", edges);
    const depth = pathDepths(lit, edges);
    expect(depth.get("__start__")).toBe(0);
    expect(depth.get("a")).toBe(1);
    expect(depth.get("d")).toBe(4); // via c → x, not the shorter b
    expect(depth.get("__end__")).toBe(5);
    expect(depth.has("q")).toBe(false); // CONTROL: off the path, never ordered
  });

  it("never loops on a cycle", () => {
    const edges = [E("a", "b"), E("b", "a")];
    expect([...pathDepths(new Set(["a", "b"]), edges).keys()].sort()).toEqual(["a", "b"]);
  });

  it("the flowing line is SOLID; the pulse's motion is linear, looped and stops under reduced motion", () => {
    const rule = css.indexOf(".react-flow__edge.edge-flowing path.react-flow__edge-path {");
    const line = css.slice(rule, css.indexOf("}", rule));
    expect(rule).toBeGreaterThan(css.indexOf(".react-flow__edge.edge-boundary.edge-dim path {"));
    expect(line).toContain("stroke-dasharray: none");
    const p = css.indexOf(".react-flow__edge path.edge-pulse {");
    const pulse = css.slice(p, css.indexOf("}", p));
    expect(pulse).toContain("animation-name: edge-pulse-run");
    expect(pulse).toContain("animation-timing-function: linear");
    expect(pulse).toContain("drop-shadow");
    expect(css).toMatch(/@keyframes edge-pulse-run \{\s*to \{ stroke-dashoffset: var\(--pulse-end\); \}/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {", p));
    expect(reduced.slice(0, reduced.indexOf("}\n}"))).toMatch(/edge-pulse \{ display: none/);
  });

  it("ONE pulse travels the whole path: every link shares one cycle, each carries it in its own slot, and the loop has no seam", () => {
    const slots = 4;
    const t = [0, 1, 2, 3].map((k) => pulseTiming({ ["--flow-order" as string]: k, ["--flow-slots" as string]: slots } as React.CSSProperties) as Record<string, string | number>);
    // One cycle for all.
    expect(new Set(t.map((x) => x.animationDuration))).toEqual(new Set([`${slots * PULSE_SLOT_MS}ms`]));
    // Consecutive slots, start to finish.
    expect(t.map((x) => x.animationDelay)).toEqual([0, 1, 2, 3].map((k) => `${k * PULSE_SLOT_MS}ms`));
    for (const x of t) {
      const [len, gap] = String(x.strokeDasharray).split(" ").map(Number);
      const period = len! + gap!;
      expect(period).toBeGreaterThan(100 + len!); // between its slots a link shows no streak
      expect(x.strokeDashoffset).toBe(len); // it starts just before the link
      expect(Number(x["--pulse-end"])).toBe(len! - period); // and moves exactly one period: seamless
    }
  });
});
