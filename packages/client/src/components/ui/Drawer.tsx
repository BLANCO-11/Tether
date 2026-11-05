// src/components/ui/Drawer.tsx — a right-side panel with a backdrop.
//
// Renders nothing when closed. Closes on backdrop click, the X button, or Escape.
// Traps focus while open, returns focus to the opener on close, and locks page scroll.
//
// ⚠ **THIS IS `Modal.tsx` ON ITS SIDE, AND IT IS A SEPARATE COMPONENT DELIBERATELY.**
// A modal is a question — it interrupts, it is centred, and the page behind it is
// suspended until it is answered. A drawer is a *detail view* of something on the page:
// the list stays visible beside it, and closing it is a navigation rather than a
// cancellation. Adding a `side` prop to `Modal` would put two behaviours behind one
// name, and the one that reads as the default would be whichever the next caller
// happened to write.
//
// ⚠ **THE `useId()` LESSON TRAVELS WITH IT.** `Modal`'s title id was the constant
// `"modal-title"`, and two dialogs open at once — a `Confirm` raised from inside a form
// — both carried `aria-labelledby="modal-title"`. That id existed twice in the document,
// every resolver takes the first, and a screen reader announced the confirmation under
// the title of the form behind it. **A drawer and a `Confirm` are open together on
// `/admin/roles`, Advanced** (removing a member from inside the drawer), so this is not a
// hypothetical here. Per instance, never a constant.

"use client";

import { useEffect, useId, useRef } from "react";
import { Close } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/IconButton";

export function Drawer({
  open,
  onClose,
  title,
  children,
  /** Shown under the title. One line — the subject, not an explanation. */
  subtitle,
  /** Pinned to the bottom of the panel, outside the scrolling region. */
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  /** ⚠ Per instance. See the docblock — this is the whole of the `Modal` lesson. */
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement; // remember who opened us
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // scroll-lock
    panel.current?.focus(); // move focus into the drawer

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Simple focus trap across the drawer's focusable elements.
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      (opener.current as HTMLElement | null)?.focus?.(); // restore focus
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-scrim" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // ⚠ `w-full` first, then the desktop width. The panel is a full-width sheet at
        // phone width — a fixed 420px drawer on a 400px screen leaves the page scrolling
        // sideways with the backdrop poking out of one edge.
        //
        // ── ⚠ NO EDGE BORDER, AND THAT IS THE FIX RATHER THAN A TASTE CALL ──────────
        //
        // It carried `border-l border-line/60`. `--line` (#20242d) is LIGHTER than
        // `--surface` (#14161d) and the scrim darkens everything to its left, so that one
        // rule read as a highlighted seam down the full height of the viewport — the only
        // edge of the panel treated differently from the other three, which sit flush
        // against the window and have no border at all. Reported as one side of the panel
        // being highlighted.
        //
        // ⚠ 2026-10-11: from `sm` up the drawer FLOATS (design doc §3) — 12px from every edge, a 14px radius,
        // and so a hairline on ALL FOUR sides: a closed shape, the same answer `Modal` gives. The single-sided
        // seam described above cannot come back, because there is no longer one edge treated differently. At
        // phone width it is still a flush full sheet with no border.
        className="overlay-slide depth-3 relative flex h-full w-full flex-col outline-none sm:m-3 sm:h-[calc(100%-24px)] sm:max-w-[460px] sm:rounded-[14px] sm:border sm:border-line"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div id={titleId} className="truncate text-[13px] font-medium text-text">
              {title}
            </div>
            {subtitle && <div className="mt-0.5 truncate text-xs text-muted">{subtitle}</div>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <Close s={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-line px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}
