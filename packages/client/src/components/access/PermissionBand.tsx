"use client";

// src/components/access/PermissionBand.tsx — one band of the permission catalogue,
// expandable and collapsable.
//
// ⚠ **ONE IMPLEMENTATION, READ BY BOTH CONSUMERS.** `MemberDrawer` and `RoleEditor` band
// the same catalogue through the same `groupByPreset`; two disclosures over one banding
// is how the two screens come to disagree about what a band is called, what its count
// means and whether it starts open. Same reasoning as the banding itself (D-197) and as
// the deleted `lib/capabilities.ts`, whose `ROLE_CAPS` disagreed with the server's.
//
// ── ⚠ A COLLAPSED BAND STILL SAYS SOMETHING TRUE ─────────────────────────────────────
//
// The head carries the count — `12 of 19` — so a closed band reads as *"nineteen here,
// twelve of them held"*, never as an absence. That is the whole reason the count lives in
// the head rather than beside the checkboxes: collapsing must remove detail, never
// evidence. `summary` is therefore REQUIRED, not optional; a band that could render a
// closed head with no count would be a panel claiming nothing while looking complete.
//
// ── ⚠ THE BODY UNMOUNTS, IT IS NOT HIDDEN ────────────────────────────────────────────
//
// `hidden` would have been the smaller diff and would have left every existing test
// green — because `getByLabelText` and `container.textContent` both read hidden nodes.
// That is precisely the objection: the suite would have gone on asserting over
// checkboxes nobody can see, and INV-9's `not.toContain("platform.")` would have passed
// over a closed drawer rather than over a filtered one. A test that cannot tell the
// screen from the DOM is I-38 with extra steps. Unmounting makes the assertions mean
// what they say, and costs nothing — both consumers hold their state outside the DOM
// (`chosen` in the editor, the server in the drawer), so a closed band forgets nothing.
//
// ⚠ **NOT `InspectorSection`**, which is the builder inspector's collapsible and is the
// right shape for that pane: full-bleed rows, `px-4`, and a count badge suppressed when
// the count is zero. Zero is the reading that matters here — a member holding none of the
// admin band is exactly what somebody opens this to find out — so reusing it would mean
// changing its rule for another surface's sake.

import { useState, type ReactNode } from "react";
import { ChevronRight } from "@/components/ui/icons";

export function PermissionBand({
  /** The band's own key from `groupByPreset` — `author`, `approver`, `admin`, `ungrouped`. */
  bandKey,
  label,
  hint,
  /** The head's count, e.g. `12 of 19`. Required: see the note above. */
  summary,
  /** Default only. The band owns its state once mounted. */
  defaultOpen = false,
  children,
}: {
  bandKey: string;
  label: string;
  hint: string;
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `permission-band-body-${bandKey}`;
  return (
    <section data-testid={`permission-band-${bandKey}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline gap-2 rounded px-1 py-1 text-left hover:bg-surface-2"
      >
        <ChevronRight
          s={12}
          aria-hidden
          className={
            "relative top-px shrink-0 text-dim transition-transform duration-fast ease-app " +
            (open ? "rotate-90" : "")
          }
        />
        <h4 className="text-xs font-semibold uppercase tracking-label text-dim">{label}</h4>
        <span className="ml-auto shrink-0 text-xs text-muted">{summary}</span>
      </button>
      {/* ⚠ The hint stays OUTSIDE the body. What holding this band means is the sentence a
          person reads while deciding whether to open it. */}
      <p className="ml-5 mt-0.5 text-xs text-muted">{hint}</p>
      {open && (
        <div id={bodyId} className="ml-5 mt-2">
          {children}
        </div>
      )}
    </section>
  );
}
