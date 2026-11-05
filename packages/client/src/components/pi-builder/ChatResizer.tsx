"use client";

/**
 * The chat column's width, dragged (2026-10-13): a handle on the chat's right edge. The width is a CSS variable on the
 * workbench (`--chat-w`, globals.css), so every grid rule that held the chat at 400px follows it. Remembered in this
 * browser only; double-click (or Home) puts it back to 400px. Arrow keys move it for a keyboard.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const CHAT_DEFAULT_W = 400;
export const CHAT_MIN_W = 320;
export const CHAT_MAX_W = 960;
/** The canvas keeps at least this much beside the chat, however wide the chat is dragged. */
export const CANVAS_MIN_W = 360;
const KEY = "foundry.forge.chatWidth";

/** The width a drag may set: at least the minimum, at most the maximum, and never crowding the canvas out. */
export function clampChatWidth(w: number, containerWidth: number): number {
  const max = Math.max(CHAT_MIN_W, Math.min(CHAT_MAX_W, containerWidth - CANVAS_MIN_W));
  return Math.round(Math.min(max, Math.max(CHAT_MIN_W, w)));
}

/** The remembered width, or null for the default. */
export function useChatWidth(): [number | null, (w: number | null) => void] {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(KEY));
      if (Number.isFinite(v) && v >= CHAT_MIN_W && v <= CHAT_MAX_W) setWidth(v);
    } catch {}
  }, []);
  const set = useCallback((w: number | null) => {
    setWidth(w);
    try {
      if (w == null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(w));
    } catch {}
  }, []);
  return [width, set];
}

export function ChatResizer({ width, onChange }: { width: number | null; onChange: (w: number | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  /** The chat pane's left edge and the workbench's width, measured at the moment they are needed. */
  const frame = () => {
    const pane = ref.current?.parentElement;
    const grid = pane?.parentElement;
    return { left: pane?.getBoundingClientRect().left ?? 0, total: grid?.getBoundingClientRect().width || window.innerWidth };
  };

  const current = width ?? CHAT_DEFAULT_W;

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the chat"
      aria-valuenow={current}
      aria-valuemin={CHAT_MIN_W}
      aria-valuemax={CHAT_MAX_W}
      tabIndex={0}
      title="Drag to resize the chat · double-click to reset"
      className={`group absolute inset-y-0 -right-[3px] z-20 hidden w-[6px] cursor-col-resize touch-none outline-none min-[708px]:block`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        document.body.classList.add("chat-resizing");
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const { left, total } = frame();
        const w = clampChatWidth(e.clientX - left, total);
        onChange(w);
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        setDragging(false);
        document.body.classList.remove("chat-resizing");
      }}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          onChange(clampChatWidth(current + (e.key === "ArrowRight" ? step : -step), frame().total));
        } else if (e.key === "Home") {
          e.preventDefault();
          onChange(null);
        }
      }}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 transition-colors ${
          dragging ? "bg-accent" : "bg-transparent group-hover:bg-accent/50 group-focus-visible:bg-accent"
        }`}
      />
    </div>
  );
}
