// src/components/ui/RowMenu.tsx — a kebab (⋮) button that opens a small menu of row
// actions (Edit, Delete…). The menu renders in a portal (so a card's overflow can never
// clip it), positions itself under the button and flips up near the viewport bottom, and
// is fully keyboard-accessible (Arrow keys, Enter, Escape).
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dots, Pencil, RefreshCw, Trash } from "@/components/ui/icons";

export type RowAction = { label: string; onClick: () => void; danger?: boolean; icon?: "edit" | "delete" | "rotate" };

/** Kebab menu. Pass the actions to show; closes on pick, outside click, or Escape. */
export function RowMenu({ actions, label = "More actions" }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const W = 160; // menu width

  // Position the portal under (or above) the button, right-aligned.
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const estH = actions.length * 40 + 8;
    const below = window.innerHeight - r.bottom;
    const top = below < estH + 12 ? r.top - estH - 4 : r.bottom + 4; // flip up if tight
    setPos({ top, left: Math.max(8, r.right - W) });
  }, [open, actions.length]);

  // Focus the first item when opening.
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("button") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); btn.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };

  return (
    <span className="relative inline-flex">
      <button
        ref={btn}
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Dots s={16} />
      </button>
      {open && pos && createPortal(
        <>
          {/* click-catcher to close */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={menu}
            role="menu"
            onKeyDown={onMenuKey}
            style={{ top: pos.top, left: pos.left, width: W }}
            className="depth-6 fixed z-50 overflow-hidden rounded-lg border border-line p-1"
          >
            {actions.map((a) => (
              <button
                key={a.label}
                role="menuitem"
                onClick={() => { setOpen(false); a.onClick(); }}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-body transition-colors duration-150 focus:outline-none ${a.danger ? "text-danger hover:bg-danger-bg focus-visible:bg-danger-bg" : "text-text hover:bg-surface-2 focus-visible:bg-surface-2"}`}
              >
                {a.icon === "delete" ? <Trash s={14} /> : a.icon === "rotate" ? <RefreshCw s={14} /> : <Pencil s={14} />}
                {a.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </span>
  );
}
