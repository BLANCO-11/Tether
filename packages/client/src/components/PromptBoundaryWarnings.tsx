// src/components/PromptBoundaryWarnings.tsx — guardrail port V4, on a screen at last.
//
// Registered content that reads like an instruction to the model. Advisory: the
// content is still delivered unaltered, so this panel REPORTS and never implies
// anything was blocked.
//
// ⚠ **Renders nothing when there is nothing to say, and that is deliberate.** A
// permanent green "no issues" panel is exactly the reassurance the detector
// cannot honestly give — the patterns are a known-bad list, not a proof. The
// third state (the check could not run) is NOT silence: it renders, because
// "nobody asked" and "nothing matched" are different claims and collapsing them
// is the `faFallback` defect this codebase deleted.
"use client";

import {
  PROMPT_BOUNDARY_EXPLAINER,
  PROMPT_BOUNDARY_TITLE,
  PROMPT_BOUNDARY_UNREADABLE,
  truncationNotice,
  warningLocation,
  type PromptBoundaryWarnings as Warnings,
} from "@/lib/prompt-boundary-copy";

export function PromptBoundaryWarnings({
  warnings,
  error,
}: {
  warnings: Warnings | null;
  /** Set when the manifest could not be read — rendered, never swallowed. */
  error?: string | null;
}) {
  if (error) {
    return (
      <section className="mb-6 rounded-lg border border-line bg-surface p-4">
        <p className="text-sm text-muted">{PROMPT_BOUNDARY_UNREADABLE}</p>
      </section>
    );
  }

  if (!warnings || warnings.items.length === 0) return null;

  const truncated = truncationNotice(warnings);

  return (
    <section
      aria-labelledby="prompt-boundary-heading"
      className="mb-6 rounded-lg border border-warn/40 bg-surface p-4 sm:p-5"
    >
      <h2 id="prompt-boundary-heading" className="text-sm font-medium">
        {PROMPT_BOUNDARY_TITLE}
      </h2>
      <p className="mt-1 max-w-prose text-body text-muted">{PROMPT_BOUNDARY_EXPLAINER}</p>

      <ul className="mt-4 flex flex-col gap-3">
        {warnings.items.map((w, i) => (
          <li
            key={`${w.itemName}-${w.field}-${w.pattern}-${i}`}
            className="rounded-md border border-line bg-surface-2 p-3"
          >
            {/* ⚠ `min-w-0` on flex children that hold text. A registered tool's
                name is third-party text, so it can be arbitrarily long and
                unbroken; without this it blows the container out and produces
                page-level horizontal overflow. */}
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-body font-medium">{warningLocation(w)}</span>
              <span className="min-w-0 break-words text-body text-warn">{w.describes}</span>
            </div>
            {/* The raw excerpt, so the person can find this text in their own
                registry. Rendered as TEXT, never as markup — it is the one field
                here carrying attacker-authored content. */}
            <p className="mt-2 break-words font-mono text-caption leading-relaxed text-muted">
              {w.excerpt}
            </p>
          </li>
        ))}
      </ul>

      {truncated && <p className="mt-3 text-caption text-dim">{truncated}</p>}
    </section>
  );
}
