"use client";

/**
 * How hard Forge Agent thinks (2026-10-29): four bars beside the context meter, filled to the chat's level. Clicking them
 * opens a slider; letting go of it (or Enter) sets the level and closes it. Escape or a click outside leaves it as it
 * was. The level applies from the next message — Forge restarts with it and resumes the conversation.
 */
import { useEffect, useRef, useState } from "react";
import { THINKING_LEVELS, type ThinkingLevel as Level } from "@/lib/thinking-levels";

export const THINKING_LABEL: Record<Level, string> = { low: "Low", balanced: "Balanced", high: "High", ultra: "Ultra high" };
const THINKING_HINT: Record<Level, string> = {
  low: "Answers quickly, with the least thinking.",
  balanced: "Thinks when it helps. The default.",
  high: "Thinks longer before answering. Slower.",
  ultra: "Thinks the most. The slowest, and it uses the most of the AI service.",
};

export function ThinkingLevel({
  level,
  disabled,
  onChange,
}: {
  level: Level;
  /** True while Forge is working: the level cannot change mid-reply. */
  disabled: boolean;
  onChange: (level: Level) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(level);
  const [saving, setSaving] = useState(false);
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

  const commit = async (next: Level) => {
    if (next === level) return setOpen(false);
    setSaving(true);
    setError(null);
    try {
      await onChange(next);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const index = THINKING_LEVELS.indexOf(level);
  const draftIndex = THINKING_LEVELS.indexOf(draft);
  const label = `Thinking: ${THINKING_LABEL[level]}`;

  return (
    <span ref={box} className="relative inline-flex">
      <button
        type="button"
        onClick={() => {
          setDraft(level);
          setError(null);
          setOpen((v) => !v);
        }}
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        title={disabled ? `${label}. Wait for Forge to finish to change it` : label}
        className="flex h-6 items-center gap-1 rounded px-1 text-dim hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden data-level={level}>
          {THINKING_LEVELS.map((l, i) => (
            <rect
              key={l}
              x={i * 3.6}
              y={9 - i * 3}
              width="2.4"
              height={3 + i * 3}
              rx="0.8"
              fill={i <= index ? "var(--accent)" : "var(--line)"}
            />
          ))}
        </svg>
      </button>
      {open ? (
        <div role="dialog" aria-label="Thinking level" className="absolute bottom-full right-0 z-30 mb-2 w-64 max-w-[calc(100vw-32px)] space-y-2 rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed text-muted shadow-lg">
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-text">Thinking</span>
            <span className="font-medium text-accent">{THINKING_LABEL[draft]}</span>
          </div>
          <input
            type="range"
            min={0}
            max={THINKING_LEVELS.length - 1}
            step={1}
            value={draftIndex}
            disabled={saving}
            aria-label="Thinking level"
            aria-valuetext={THINKING_LABEL[draft]}
            onChange={(e) => setDraft(THINKING_LEVELS[Number(e.target.value)] ?? level)}
            onPointerUp={(e) => void commit(THINKING_LEVELS[Number((e.target as HTMLInputElement).value)] ?? level)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit(draft);
              }
            }}
            className="w-full cursor-grab active:cursor-grabbing"
            style={{ accentColor: "var(--accent)" }}
          />
          <div className="flex justify-between text-[10.5px] text-dim">
            {THINKING_LEVELS.map((l) => (
              <button key={l} type="button" disabled={saving} onClick={() => void commit(l)} className={l === draft ? "text-text" : "hover:text-text"}>
                {l === "ultra" ? "Ultra" : THINKING_LABEL[l]}
              </button>
            ))}
          </div>
          <p>{THINKING_HINT[draft]} Applies from your next message.</p>
          {error ? <p className="text-danger">{error}</p> : null}
        </div>
      ) : null}
    </span>
  );
}
