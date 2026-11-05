"use client";

// src/components/flow/builder/InspectorSection.tsx — one collapsible section of
// a right-hand inspector, in the frozen mock's language (D-18).
//
// ⚠ EXTRACTED FROM `ChatWorkbench.tsx`, WHERE IT WAS A LOCAL `Collapsible`.
//
// Both builder modes have a right-hand inspector and until now only one of them
// had a section language: chat had this, manual stacked bare `<div>`s, and the
// test-run panel was bolted under both with ad-hoc padding and its own borders —
// which is what made the pane read as a pile rather than a structure.
//
// A full-width head button with a rotating chevron, an optional count badge, and
// a body that mounts only while open. `open` is the DEFAULT only; the section
// keeps its own state once mounted, so collapsing one does not fight a parent
// re-render. The chevron spins on the app's fast duration and one easing, and
// the global reduced-motion rule in `globals.css` kills it for anyone who asked.

import { useState, type ReactNode } from "react";
import { ChevronRight } from "@/components/ui/icons";

export function InspectorSection({
  title,
  open = false,
  danger = false,
  count,
  /** A short right-aligned fact in the head — a duration, a count of rows. */
  hint,
  children,
}: {
  title: string;
  open?: boolean;
  danger?: boolean;
  /** Shown only when it is a real, positive count. */
  count?: number;
  hint?: string | null;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(open);
  return (
    <section className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((o) => !o)}
        className={
          "flex w-full items-center gap-2 px-4 py-2.5 text-left text-body font-semibold transition-colors hover:bg-surface-2 " +
          (danger ? "text-danger" : "text-text")
        }
      >
        <span>{title}</span>
        {count !== undefined && count > 0 && (
          <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-caption text-muted">
            {count}
          </span>
        )}
        <span aria-hidden className="ml-auto flex shrink-0 items-center gap-2">
          {hint && <span className="text-caption font-normal text-dim">{hint}</span>}
          <ChevronRight
            s={14}
            className={"text-dim transition-transform duration-fast ease-app " + (isOpen ? "rotate-90" : "")}
          />
        </span>
      </button>
      {isOpen && <div className="flex flex-col gap-3 px-4 pb-4">{children}</div>}
    </section>
  );
}

/**
 * One label/value row. ⚠ Renders NOTHING when the value is absent — the rule the
 * whole test-run surface follows, and the reason a step that produced no output
 * shows no output row rather than an empty one.
 */
export function InspectorRow({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-caption text-dim">{label}</dt>
      <dd className={`min-w-0 truncate text-caption text-text ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
