// Text that arrives smoothly, the way a reply streams in.
//
// `useSmoothText` reveals a target string character by character on each animation frame, at a steady pace that
// speeds up when it falls behind, so text that arrives in uneven bursts (a model's chunks) reads as an even flow and
// never lags far behind what has actually arrived. `FadingText` renders it with the newest characters fading in rather
// than popping, which is what makes it feel smooth rather than typed.
//
// `useStreamedText` is the greeting's version: the server writes it whole, so it is revealed once per message id per
// tab (`seen`). A re-render, a reconnect or the stream delivering the session again shows it whole. Reduced motion
// shows everything at once, and a screen reader is given the whole text once.
"use client";

import { useEffect, useRef, useState } from "react";

/** Characters per second when caught up: a calm reading pace. */
const BASE_CPS = 75;
/** Extra speed per character of backlog, so a burst is absorbed within about half a second. */
const CATCH_UP = 2.2;
/** How many trailing characters are still fading in. */
const TAIL = 14;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * How many characters of `target` to show. Grows smoothly toward `target.length`; follows it when it grows; starts
 * again when it is replaced by something that is not a continuation (a new turn). `animate: false` shows it all.
 */
export function useSmoothText(
  target: string,
  animate = true,
  pace: { cps: number; catchUp: number } = { cps: BASE_CPS, catchUp: CATCH_UP },
): number {
  const [count, setCount] = useState(animate ? 0 : target.length);
  const shown = useRef(animate ? 0 : target.length);
  const prev = useRef(target);
  const frame = useRef<number | null>(null);
  const reduced = useRef<boolean | null>(null);

  useEffect(() => {
    if (reduced.current === null) reduced.current = prefersReducedMotion();
    // A new text rather than more of the same: start from nothing.
    if (!target.startsWith(prev.current.slice(0, Math.min(prev.current.length, shown.current)))) shown.current = 0;
    prev.current = target;

    if (!animate || reduced.current) {
      shown.current = target.length;
      setCount(target.length);
      return;
    }
    if (shown.current > target.length) shown.current = target.length;

    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;
      const backlog = target.length - shown.current;
      if (backlog <= 0) {
        frame.current = null;
        return;
      }
      shown.current = Math.min(target.length, shown.current + Math.max(1, (pace.cps + backlog * pace.catchUp) * dt));
      setCount(Math.floor(shown.current));
      frame.current = requestAnimationFrame(tick);
    };
    if (frame.current === null) frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    // `pace` is a constant per caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, animate]);

  return Math.min(count, target.length);
}

const seen = new Set<string>();
const GREETING_PACE = { cps: 48, catchUp: 0.45 };

/** The greeting: revealed once per id per tab, then always whole. */
export function useStreamedText(id: string, text: string): { shown: string; done: boolean } {
  const [animate] = useState(() => !seen.has(id));
  useEffect(() => {
    seen.add(id);
  }, [id]);
  // All of it is "behind" from the first frame, so a gentle catch-up: it eases out over about a second and a half
  // instead of rushing the first words.
  const n = useSmoothText(text, animate, GREETING_PACE);
  return { shown: text.slice(0, n), done: n >= text.length };
}

/** Forget what has been shown — for tests. */
export function resetStreamedText() {
  seen.clear();
}

/**
 * Plain text with paragraphs, the newest characters fading in. `full` is the whole text: it is laid out invisibly
 * underneath so the box has its final size from the first frame and nothing below it jumps as it fills.
 */
export function FadingText({ shown, full, className = "" }: { shown: string; full: string; className?: string }) {
  // Once it is all there, nothing is still fading.
  const settled = shown.length >= full.length ? shown : shown.slice(0, Math.max(0, shown.length - TAIL));
  const tail = shown.slice(settled.length);
  return (
    <div className={`relative whitespace-pre-line ${className}`}>
      <div className="invisible" aria-hidden>
        {full}
      </div>
      <div className="absolute inset-0" aria-hidden>
        {settled}
        {Array.from(tail).map((ch, i) => (
          <span key={settled.length + i} style={{ opacity: (i + 1) / (tail.length + 1), transition: "opacity 120ms linear" }}>
            {ch}
          </span>
        ))}
      </div>
      <span className="sr-only">{full}</span>
    </div>
  );
}
