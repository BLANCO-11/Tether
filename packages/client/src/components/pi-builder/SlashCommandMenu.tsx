"use client";

/** The `/` command list above the composer (2026-11-04). The textarea keeps focus; keys are handled there. */
import type { SlashCommand } from "@/lib/composer-commands";

export function SlashCommandMenu({
  commands,
  index,
  locked,
  onHover,
  onRun,
}: {
  commands: SlashCommand[];
  index: number;
  /** True while Forge is working: nothing can change mid-reply. */
  locked: boolean;
  onHover: (i: number) => void;
  onRun: (i: number) => void;
}) {
  return (
    <div role="listbox" aria-label="Commands" data-testid="slash-menu" className="mb-2 rounded-xl border border-line bg-surface p-1.5 text-[12px] shadow-lg">
      {locked ? <p className="px-2 py-1 text-muted">Wait for Forge to finish to change it.</p> : null}
      {commands.map((c, i) => (
        <div
          key={c.name}
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onRun(i)}
          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${i === index ? "bg-surface-2" : ""}`}
        >
          <span className="text-text">/{c.name}</span>
          <span className="text-dim">{c.hint}</span>
        </div>
      ))}
    </div>
  );
}
