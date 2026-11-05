"use client";

/**
 * How full the conversation is (2026-10-13): a small ring beside the model name — amber past 70%, red past 90% — that
 * opens to the numbers and a "Compact now" button. Forge summarises a nearly full conversation on its own; this lets a
 * person see it coming and make room sooner. The reading is pi's own (`get_session_stats`), taken after each reply.
 */
import { useEffect, useRef, useState } from "react";
import type { PiContext } from "@/lib/pi-builder";

const AMBER = 70;
const RED = 90;

export function meterTone(percent: number | null): "ok" | "warn" | "danger" | "unknown" {
  if (percent == null) return "unknown";
  return percent >= RED ? "danger" : percent >= AMBER ? "warn" : "ok";
}

const TONE_COLOR = { ok: "var(--accent)", warn: "var(--warn)", danger: "var(--danger)", unknown: "var(--dim)" } as const;
const fmt = (n: number) => (n >= 1000 ? `${Number((n / 1000).toFixed(n >= 100_000 ? 0 : 1))}k` : String(n));

export function ContextMeter({
  context,
  compacting,
  canCompact,
  onCompact,
}: {
  context: PiContext | null;
  compacting: boolean;
  /** False while Forge is working or a test is running. */
  canCompact: boolean;
  onCompact: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const percent = context?.percent ?? null;
  const tone = meterTone(percent);
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const filled = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  const label =
    percent == null ? "Conversation size: not known yet" : `Conversation ${Math.round(percent)}% full`;

  return (
    <span ref={box} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        title={label}
        data-tone={tone}
        className="flex h-6 items-center gap-1 rounded px-1 text-dim hover:bg-surface-2 hover:text-text"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className={compacting ? "animate-spin" : undefined}>
          <circle cx="7" cy="7" r={r} fill="none" stroke="var(--line)" strokeWidth="2.2" />
          <circle
            cx="7"
            cy="7"
            r={r}
            fill="none"
            stroke={TONE_COLOR[tone]}
            strokeWidth="2.2"
            strokeDasharray={`${(filled / 100) * c} ${c}`}
            strokeLinecap="round"
            transform="rotate(-90 7 7)"
          />
        </svg>
        {percent != null && tone !== "ok" ? <span style={{ color: TONE_COLOR[tone] }}>{Math.round(percent)}%</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label="Conversation size" className="absolute bottom-full right-0 z-30 mb-2 w-72 max-w-[calc(100vw-32px)] space-y-2 rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed text-muted shadow-lg">
          <div className="font-medium text-text">Conversation size</div>
          {context && context.tokens != null && percent != null ? (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full" style={{ width: `${filled}%`, background: TONE_COLOR[tone] }} />
              </div>
              <div>
                {fmt(context.tokens)} of {fmt(context.window)} tokens · {Math.round(percent)}% full
              </div>
            </>
          ) : (
            <div>Not known yet. It is measured after Forge&apos;s next reply.</div>
          )}
          <p>
            When it is nearly full, Forge summarises the earlier messages on its own. Compacting now does that sooner. Everything
            Forge built stays as it is.
          </p>
          {error ? <p className="text-danger">{error}</p> : null}
          <button
            type="button"
            disabled={!canCompact || compacting}
            onClick={async () => {
              setError(null);
              try {
                await onCompact();
                setOpen(false);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            className="w-full rounded-md border border-line px-3 py-1.5 font-medium text-text hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
            title={!canCompact ? "Wait for Forge to finish" : undefined}
          >
            {compacting ? "Compacting…" : "Compact now"}
          </button>
        </div>
      ) : null}
    </span>
  );
}
