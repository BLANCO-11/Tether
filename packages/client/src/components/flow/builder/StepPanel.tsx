// src/components/flow/builder/StepPanel.tsx — the summoned step panel.
// CD-5 · CD-6 · closes CX-009 (canvas programme, closed; record removed 2026-09-11).
//
// ⚠ **THIS REPLACES A RESIDENT RAIL, AND THE RAIL'S BUGS MUST NOT COME BACK.**
//
// `BuilderShell` held a permanent 320px right rail with three tabs. Two defects
// were reported against it from use and fixed on 2026-09-02; a third was found
// while fixing them:
//
//   1. the head chevron said *"Close inspector"* and called
//      `setSelectedStepId(null)`, which **deselected the step** and dropped the
//      person into the Components palette with no control that came back;
//   2. `panelCollapsed` was dead state — declared, read, never set;
//   3. chat mode rendered a **different, read-only** inspector, and chat is the
//      default mode, so most people only ever saw the weak one.
//
// Two of the three cannot recur here: there is no tab to be stranded in (the
// palette is summoned — § 4) and there is no chevron. The third is prevented by
// this component taking `renderPanel` from its caller, so both doors mount one
// editor **by construction** rather than by agreement.
//
// ⚠ **AND THE NEW FAILURE MODE THIS SHAPE INTRODUCES IS DISMISSAL.** A panel
// that closes is a panel that can take an edit with it. It does not: the panel
// edits an in-memory authored model owned by the page, so closing hides the
// detail and changes nothing. `Esc` is not a revert. Stated because *"the panel
// closed and my edit vanished"* is the obvious way to get this wrong.
"use client";

import { useEffect, useRef, useState } from "react";
import { Close } from "@/components/ui/icons";
import { TestRunPanel, hasTestRun } from "@/components/flow/builder/TestRunPanel";
import type { CanvasGraph } from "@/lib/canvas-model";

/**
 * The panel's two tabs *(Dify: every node panel is `SETTINGS │ LAST RUN`)*.
 *
 * ⚠ **`LAST RUN` IS PER STEP, NOT PER FLOW** (`CD-6`), and that is a change of
 * meaning rather than a move. The rail's "Last run" tab showed the whole run;
 * a run reading belongs on the run page and already lives there. What a person
 * wants while configuring one step is *what did THIS step just do*, and
 * `lastRunOutputs` has been keyed by step id since T9 — so this is a re-home of
 * an existing read, not a new one.
 */
export const PANEL_TABS = ["settings", "last-run"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
export const PANEL_TAB_LABEL: Record<PanelTab, string> = {
  settings: "Settings",
  "last-run": "Last run",
};
/** Drag bounds and default for the resizable pane, in px. Persisted per browser. */
export const PANE_MIN_W = 320;
export const PANE_MAX_W = 640;
export const PANE_DEFAULT_W = 400;
export const PANE_WIDTH_KEY = "foundry.step-pane-w";

export type StepPanelProps = {
  stepId: string;
  /**
   * Rendered in the head.
   *
   * ⚠ **Both doors pass the STEP ID, deliberately.** The obvious choice — the
   * canvas label, or the ref — repeats what the body already shows a line
   * later, and a head that duplicates its own first field says nothing. The id
   * is the address: it is what `dependsOn` and `outputs.<id>` name, it is
   * unique, and it is the one thing about a step the body does not restate.
   * A human-readable NAME belongs here and does not exist yet — `AuthoredStep`
   * carries no such field (§ 5.1, Stage 2.3). Inventing one from the ref would
   * put a second identifier on screen that nothing stores.
   */
  title?: string;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  /** The SETTINGS body — the one `StepInspector` both doors mount. */
  children: React.ReactNode;
  graph: CanvasGraph;
  testOutputs?: Record<string, Record<string, unknown>> | null;
  testing?: boolean;
  testNotice?: string | null;
};

export function StepPanel({
  stepId,
  title,
  tab,
  onTab,
  onClose,
  children,
  graph,
  testOutputs,
  testing,
  testNotice,
}: StepPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  /**
   * ⚠ **Drag-to-resize, persisted per browser.** Reported from use: the fixed
   * 380px pane squeezed wide rows against both borders. The width is INLINE
   * style (jsdom performs no layout, so a class token would be scenery — see
   * `Builder.test.tsx`), bounded to the viewport so a wide drag cannot push
   * the pane off screen.
   */
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem(PANE_WIDTH_KEY));
    return saved >= PANE_MIN_W && saved <= PANE_MAX_W ? saved : PANE_DEFAULT_W;
  });
  const dragFrom = useRef<{ x: number; w: number } | null>(null);
  const clampW = (w: number) => Math.min(PANE_MAX_W, Math.max(PANE_MIN_W, Math.round(w)));
  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = { x: e.clientX, w: width };
    // jsdom (and some touch browsers) have no pointer capture — the move
    // handler lives on the grip, so capture is an optimisation, not a need.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    const next = clampW(from.w + from.x - e.clientX);
    setWidth(next);
    window.localStorage.setItem(PANE_WIDTH_KEY, String(next));
  };
  const endDrag = () => {
    dragFrom.current = null;
  };

  /**
   * ⚠ **`Esc` closes, and it is bound on the DOCUMENT rather than the panel.**
   * A `keydown` on the panel only fires while focus is inside it, and the
   * common case is a person who clicked a node on the canvas and never focused
   * the panel at all — for whom a panel-scoped handler does nothing and reads
   * as `Esc` being broken.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ran = hasTestRun({ testOutputs, testing, testNotice });

  return (
    <div
      ref={ref}
      data-testid="step-panel"
      data-step-id={stepId}
      role="complementary"
      aria-label={`Step ${title ?? stepId}`}
      /**
       * ⚠ **An overlay, and the canvas is NOT resized when it opens.**
       * `FlowCanvas` memoises layout on a topology string (I-59); re-running
       * dagre because a panel opened would move every node under the person's
       * cursor. So this floats over the canvas region and the graph does not
       * move.
       */
      className="step-pane absolute inset-y-0 right-0 z-20 flex flex-col border-l"
      style={{ width, maxWidth: "92vw" }}
    >
      {/* The resize grip: a wide hit area on the pane's left edge with a grip
          that only shows on hover/focus, so it never reads as a border. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize step panel"
        aria-valuemin={PANE_MIN_W}
        aria-valuemax={PANE_MAX_W}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="step-panel-resize"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const next = clampW(width + (e.key === "ArrowLeft" ? 8 : -8));
          setWidth(next);
          window.localStorage.setItem(PANE_WIDTH_KEY, String(next));
        }}
        className="group absolute inset-y-0 -left-1.5 z-10 w-3 cursor-ew-resize touch-none outline-none"
      >
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent/60" />
      </div>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{title ?? stepId}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close step panel"
          className="shrink-0 rounded p-1 text-dim hover:bg-surface-2 hover:text-text"
        >
          <Close s={14} />
        </button>
      </div>

      <div role="tablist" aria-label="Step panel section" className="flex items-center gap-1 border-b border-line px-4 py-1.5">
        {PANEL_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => onTab(t)}
            className={"rounded px-2 py-1 text-xs font-medium " + (tab === t ? "bg-surface-2 text-text" : "text-muted hover:text-text")}
          >
            {PANEL_TAB_LABEL[t]}
          </button>
        ))}
        {/* ⚠ A dot, not a count. It says a run has something to show;
            inventing a number here would be a claim about it. */}
        {ran && (
          <span aria-hidden className={`ml-1 h-1.5 w-1.5 rounded-full ${testing ? "animate-pulse bg-accent" : "bg-muted"}`} />
        )}
      </div>

      {/* ⚠ No padding here. Each section owns its own inset, so the heads sit
          flush against the pane edge and read as one structure. */}
      <div className="flex-1 overflow-auto">
        {tab === "settings" ? (
          children
        ) : ran ? (
          /**
           * ⚠ Scoped to THIS step by `selectedStepId`. The rail passed the
           * selection too, but rendered whether or not one existed — which is
           * how a per-flow view ended up in a per-step pane.
           */
          <TestRunPanel
            graph={graph}
            testOutputs={testOutputs}
            testing={testing}
            testNotice={testNotice}
            selectedStepId={stepId}
          />
        ) : (
          <p className="p-3 text-xs text-muted">
            This step has not run yet. Test the workflow, or try this step on its own from Settings.
          </p>
        )}
      </div>
    </div>
  );
}
