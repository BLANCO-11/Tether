"use client";

/**
 * Prompt jump rail — one tick per user prompt (Cursor-style).
 * Default: every tick the same size; the active prompt is brighter.
 * Hover: ticks flare like a music visualizer under the cursor, and an
 * elegant truncated peek card shows that prompt.
 * Hidden when the chat is narrower than `PROMPT_RAIL_MIN_W`, or with fewer
 * than two prompts.
 */
import { useCallback, useEffect, useState, type MouseEvent } from "react";

export type PromptMark = { id: string; label: string };

/** Below this scroller width the marks crowd the text — hide the rail. */
export const PROMPT_RAIL_MIN_W = 380;

/** Vertical step between packed marks (px). */
export const PROMPT_MARK_GAP = 6;

/** Resting tick width (px) — identical for every tick until hover. */
export const PROMPT_MARK_BASE_W = 8;

/** Peak extra width at the hover center (px). */
export const PROMPT_MARK_PEAK_W = 20;

type Mark = { id: string; label: string; y: number };

function promptOffset(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function marksFromScroller(scroller: HTMLElement): Mark[] {
  const out: Mark[] = [];
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-prompt-id]")) {
    const id = el.dataset.promptId;
    if (!id) continue;
    const label = (el.dataset.promptLabel ?? "").trim() || "Prompt";
    out.push({ id, label, y: promptOffset(scroller, el) });
  }
  return out;
}

/**
 * Which prompt owns the viewport. Snaps to a mark — never between.
 * At the bottom of the chat → latest prompt.
 */
export function activePromptId(scroller: HTMLElement, marks: { id: string; y: number }[]): string | null {
  if (!marks.length) return null;
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (maxScroll <= 0 || scroller.scrollTop >= maxScroll - 16) {
    return marks[marks.length - 1]!.id;
  }
  const readY = scroller.scrollTop + Math.min(72, scroller.clientHeight * 0.2);
  let id = marks[0]!.id;
  for (const m of marks) {
    if (m.y <= readY) id = m.id;
    else break;
  }
  return id;
}

/**
 * Music-visualizer width: Gaussian peak at `hoverAt` (fractional index),
 * identical base width when not hovering.
 */
export function visualizerWidth(index: number, hoverAt: number | null): number {
  if (hoverAt == null) return PROMPT_MARK_BASE_W;
  const d = index - hoverAt;
  const sigma = 1.05;
  const amp = Math.exp(-(d * d) / (2 * sigma * sigma));
  return Math.round(PROMPT_MARK_BASE_W + amp * PROMPT_MARK_PEAK_W);
}

function truncate(label: string, n = 120): string {
  const t = label.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

/** Jump marks for each user prompt along the chat scroller's left edge. */
export function PromptJumpRail({ scroller }: { scroller: HTMLElement | null }) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [wideEnough, setWideEnough] = useState(false);
  /** Fractional index under the pointer — drives the visualizer curve. */
  const [hoverAt, setHoverAt] = useState<number | null>(null);

  const refresh = useCallback(() => {
    if (!scroller) {
      setMarks([]);
      setActive(null);
      setWideEnough(false);
      return;
    }
    setWideEnough(scroller.clientWidth >= PROMPT_RAIL_MIN_W);
    const next = marksFromScroller(scroller);
    setMarks(next);
    setActive(activePromptId(scroller, next));
  }, [scroller]);

  useEffect(() => {
    if (!scroller) return;
    refresh();
    const onScroll = () => {
      const next = marksFromScroller(scroller);
      setActive(activePromptId(scroller, next));
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => refresh()) : null;
    ro?.observe(scroller);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(() => refresh()) : null;
    mo?.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [scroller, refresh]);

  if (!wideEnough || marks.length < 2) return null;

  const trackH = (marks.length - 1) * PROMPT_MARK_GAP + 4;
  const hotIdx =
    hoverAt == null ? -1 : Math.max(0, Math.min(marks.length - 1, Math.round(hoverAt)));
  const hoverMark = hotIdx >= 0 ? marks[hotIdx] : null;

  const onMove = (e: MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top - 2;
    const t = y / Math.max(1, PROMPT_MARK_GAP);
    setHoverAt(Math.max(0, Math.min(marks.length - 1, t)));
  };

  return (
    <nav
      className={`pi-prompt-rail${hoverAt != null ? " is-hot" : ""}`}
      aria-label="Jump to prompts"
      style={{ height: trackH }}
      onMouseMove={onMove}
      onMouseEnter={onMove}
      onMouseLeave={() => setHoverAt(null)}
    >
      {marks.map((m, i) => {
        const isActive = active === m.id;
        const isHot = hotIdx === i;
        const w = visualizerWidth(i, hoverAt);
        return (
          <button
            key={m.id}
            type="button"
            className={`pi-prompt-mark${isActive ? " is-active" : ""}${isHot ? " is-hot" : ""}`}
            style={{ top: i * PROMPT_MARK_GAP + 2, width: w }}
            title={m.label}
            aria-label={`Jump to: ${m.label}`}
            aria-current={isActive ? "true" : undefined}
            onClick={() => {
              const el = scroller?.querySelector<HTMLElement>(`[data-prompt-id="${CSS.escape(m.id)}"]`);
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
        );
      })}
      {hoverMark && hotIdx >= 0 ? (
        <div
          className="pi-prompt-peek"
          style={{ top: Math.max(0, hotIdx * PROMPT_MARK_GAP - 10) }}
          role="tooltip"
        >
          <div className="pi-prompt-peek-title">Prompt {hotIdx + 1}</div>
          <div className="pi-prompt-peek-body">{truncate(hoverMark.label)}</div>
        </div>
      ) : null}
    </nav>
  );
}
