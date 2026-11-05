"use client";

/**
 * Forge thinking, two ways (2026-10-29):
 *
 * - `WorkingLine` — while a reply is on its way and there is nothing readable to show: Forge's mark at work and a phrase
 *   about the work that changes every few seconds ("Piecing it together…" → "Weighing the options…"), each change a
 *   lift-and-dissolve out and a rise-and-reveal in. What Forge is on, or a retry, takes the phrase's place.
 * - `ThinkingBlock` — the model's own thinking, shown ONLY when its provider returns it readable (the luna models return
 *   theirs encrypted, so their turns have none). It streams open while Forge thinks, then folds to "Thought for 12s".
 */
import { useEffect, useRef, useState } from "react";
import workingMark from "./assets/forge-working.webp";
import stillMark from "./assets/forge-working-still.png";

export const PHRASES = [
  "Working it out",
  "Piecing it together",
  "Weighing the options",
  "Sketching a plan",
  "Connecting the dots",
  "Lining things up",
  "Checking the details",
  "Untangling it",
  "Shaping it",
  "Mapping it out",
  "Tinkering",
  "Refining",
  "Assembling",
  "Polishing",
];
/** How long each phrase stays before the next one comes in. */
export const PHRASE_MS = 2800;

/** A different phrase from `not`, picked at random. */
function nextPhrase(not?: string): string {
  const pool = PHRASES.filter((p) => p !== not);
  return pool[Math.floor(Math.random() * pool.length)]!;
}

const src = (m: string | { src: string }) => (typeof m === "string" ? m : m.src);

/**
 * Forge's mark: particles flowing between a ring, a figure-eight and a spiral (`assets/forge-working.webp`, rendered by
 * `scripts/make-forge-working.py` — re-render it there rather than editing the image). While `working` it plays; at
 * rest, or under reduced motion, it is the ring, still. Decorative: the words beside it say what is happening.
 */
export function ForgeMark({ working }: { working: boolean }) {
  const still = <img src={src(stillMark)} alt="" width={18} height={18} className="forge-mark h-[18px] w-[18px] shrink-0" />;
  if (!working) return still;
  return (
    <picture className="forge-mark is-working inline-flex shrink-0">
      <source media="(prefers-reduced-motion: reduce)" srcSet={src(stillMark)} />
      <img src={src(workingMark)} alt="" width={18} height={18} className="h-[18px] w-[18px]" />
    </picture>
  );
}

/**
 * Forge at work. With no `label`, a phrase about the work that changes every PHRASE_MS; a `label` (what Forge is on, or
 * a retry) holds still. Every change of text — phrase to phrase, phrase to label — is a transition: the old text lifts
 * and dissolves (`.wl-out`) while the new one rises and is revealed left to right (`.wl-in`), shimmer running on both.
 * The phrases are decoration, so they are hidden from screen readers: the status says "Forge is working", or the label.
 */
export function WorkingLine({ label, elapsed, warn = false }: { label: string | null; elapsed: number; warn?: boolean }) {
  const [phrase, setPhrase] = useState(() => nextPhrase());
  useEffect(() => {
    if (label) return;
    const t = setInterval(() => setPhrase((p) => nextPhrase(p)), PHRASE_MS);
    return () => clearInterval(t);
  }, [label]);

  const text = label ?? `${phrase}…`;
  const [shown, setShown] = useState<{ cur: string; prev: string | null; n: number }>({ cur: text, prev: null, n: 0 });
  if (shown.cur !== text) setShown((s) => ({ cur: text, prev: s.cur, n: s.n + 1 }));

  const tone = warn ? "text-warn" : "think-shimmer";
  return (
    <div className="flex items-center gap-2.5 pl-[3px] animate-[chatIn_180ms_ease]" role="status" aria-live="polite">
      <ForgeMark working />
      <span className="sr-only">{label ?? "Forge is working"}</span>
      <span aria-hidden className="wl-stage min-w-0 flex-1 text-[13px] leading-5">
        {shown.prev != null ? (
          <span key={`out-${shown.n}`} className="wl-out" onAnimationEnd={() => setShown((s) => ({ ...s, prev: null }))}>
            <span className={tone}>{shown.prev}</span>
          </span>
        ) : null}
        <span key={`in-${shown.n}`} className={shown.n > 0 ? "wl-in" : undefined}>
          <span className={tone}>{shown.cur}</span>
        </span>
      </span>
      {elapsed >= 15 ? (
        <span className="shrink-0 text-[11px] tabular-nums text-dim">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </span>
      ) : null}
    </div>
  );
}

export function thoughtFor(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "Thought for a moment";
  if (s < 60) return `Thought for ${s}s`;
  return `Thought for ${Math.floor(s / 60)}m ${s % 60}s`;
}

/** The model's thinking. `live`: still arriving — open, following the newest line. Done: folded until clicked. */
export function ThinkingBlock({ text, ms, live = false }: { text: string; ms?: number; live?: boolean }) {
  const [open, setOpen] = useState(live);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);
  useEffect(() => {
    if (live && open && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [text, live, open]);
  if (!text.trim()) return null;
  return (
    <div className="pl-[34px] animate-[chatIn_180ms_ease]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex items-center gap-2 rounded text-[12.5px] leading-5 text-dim hover:text-text"
      >
        <ForgeMark working={live} />
        <span className={live ? "think-shimmer" : undefined}>{live ? "Thinking…" : thoughtFor(ms ?? 0)}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
          <path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          ref={body}
          className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3 text-[12.5px] italic leading-relaxed text-muted"
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}
