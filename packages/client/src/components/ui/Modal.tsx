// src/components/ui/Modal.tsx — a centered dialog with a backdrop.
// Renders nothing when closed. Closes on backdrop click, the X button, or Escape.
// Traps focus while open, returns focus to the opener on close, and locks page scroll.
"use client";

import { useEffect, useId, useRef } from "react";
import { Close } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/IconButton";

export function Modal({ open, onClose, title, children, wide, fit }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode;
  /** A wider panel, for content that is a table or a document rather than a form. */
  wide?: boolean;
  /** With `wide`: size the panel to its content (a table) instead of always filling the maximum width. */
  fit?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  /**
   * ⚠ **Per instance, not the constant `"modal-title"` this used to be.**
   *
   * Two modals are open at once whenever a `Confirm` is raised from inside a form
   * modal — the unarm confirmation on this page, and the live-probe confirmation
   * added by `specs/20260818-123807-tool-probe`. With a fixed id, BOTH dialogs
   * carried `aria-labelledby="modal-title"`, that id existed twice in the
   * document, and every resolver takes the first: a screen reader announced the
   * confirmation *"This sends a real POST"* under the title of the form behind it.
   * Found by a test that could not tell the two dialogs apart — which is exactly
   * what a person using the page by ear could not do either.
   */
  const titleId = useId();
  /**
   * ⚠ The latest `onClose`, read through a ref, so the effect below depends on `open` ALONE. Callers pass an inline
   * arrow (`onClose={() => setCreating(false)}`), a new function on every render, and with `onClose` in the effect's
   * dependencies every keystroke in a field re-ran it: the cleanup returned focus to the opener and the setup focused
   * the panel, so typing one character in a dialog's text box took the focus out of it (2026-10-12).
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement; // remember who opened us
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // scroll-lock
    panel.current?.focus(); // move focus into the dialog

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== "Tab") return;
      // Simple focus trap across the dialog's focusable elements.
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      (opener.current as HTMLElement | null)?.focus?.(); // restore focus
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-scrim" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`overlay-pop depth-7 relative max-h-[90vh] ${wide && fit ? "w-fit min-w-[min(100%,28rem)] max-w-4xl" : `w-full ${wide ? "max-w-4xl" : "max-w-lg"}`} overflow-y-auto rounded-[16px] border border-line px-6 py-5 outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div id={titleId} className="text-sm font-medium text-text">{title}</div>
          <IconButton label="Close" onClick={onClose}>
            <Close s={16} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
