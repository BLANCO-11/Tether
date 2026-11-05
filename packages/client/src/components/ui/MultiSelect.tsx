// src/components/ui/MultiSelect.tsx — pick several of a list, from one control.
//
// A button reading "N of M selected", a popover of checkboxes, and Select all with a
// real indeterminate state. Closes on Escape and on a click outside.
//
// ⚠ **IT REPORTS SELECTION AND OWNS NONE.** The selected ids are the caller's state and
// every change is an `onChange` — the `FlowCanvas` posture, which reports intents and
// never writes. A control that held its own copy would be a second answer to "what is
// selected", and the two would disagree the first time the caller filtered the list.
//
// ⚠ **ZERO SELECTED IS REPRESENTABLE, and what it MEANS is the caller's to decide.**
// This component does not refuse it and does not quietly turn it into "all". The one
// caller here disables its submit button on it, because "assign in 0 workspaces" is a
// success message over an empty list — but a filter control would reasonably read zero
// as "no filter", and baking either reading in here would make one of them wrong.
//
// ⚠ **THE POPOVER IS `absolute`, SO A CALLER WITH `overflow-hidden` WILL CLIP IT.** This
// is not hypothetical and it is not obvious: `BulkAssignPanel` (since deleted) carried
// `overflow-hidden` purely to clip its rounded corners, and the list came out cut off at
// the panel's edge — rendered, correct, and with six of eight workspaces simply not
// there. Nothing errors, no test that does not perform layout can see it, and it reads
// as the control being broken rather than the container. **Check the ancestors before
// mounting this inside a panel.**
//
// A portal would make it immune and is deliberately not done: it costs positioning and
// scroll-tracking code for one caller, and the constraint is cheap to state.
//
// ⚠ **NOT a native `<select multiple>`.** That control needs ctrl-click to select a
// second item, shows no count, and silently clears the whole selection on a plain click
// — it is the single most misused form control on the web, and the failure is silent
// data loss in a form somebody already filled in.

"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface MultiSelectOption {
  id: string;
  label: string;
}

export function MultiSelect({
  options,
  selected,
  onChange,
  label,
  /** Rendered in place of the popover list when there is nothing to choose from. */
  emptyLabel = "Nothing to choose from.",
  disabled = false,
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** The accessible name of the button. Also the popover's heading. */
  label: string;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const total = options.length;
  const chosen = options.filter((o) => selected.includes(o.id)).length;
  const allChosen = total > 0 && chosen === total;
  const someChosen = chosen > 0 && chosen < total;

  /**
   * ⚠ `indeterminate` is a DOM PROPERTY, not an attribute — React will not set it from
   * JSX, and `indeterminate={true}` compiles, renders, and does nothing. A partial
   * selection would then draw an empty box, which says "none of these" over a list where
   * some are picked.
   */
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChosen;
  }, [someChosen, open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line bg-bg px-2 text-left text-sm disabled:opacity-60"
      >
        <span className="truncate">
          {/* ⚠ "N of M", never a list of names truncated with an ellipsis. The count is
              the fact somebody is checking; a truncated list hides exactly the entry
              they are looking for. */}
          {chosen} of {total} selected
        </span>
        <span aria-hidden className="shrink-0 text-muted">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="depth-6 absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line"
        >
          {total === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">{emptyLabel}</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-sm font-medium">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="h-4 w-4 rounded border-line"
                  checked={allChosen}
                  aria-label="Select all"
                  onChange={() => onChange(allChosen ? [] : options.map((o) => o.id))}
                />
                <span>Select all</span>
              </label>
              <ul>
                {options.map((o) => (
                  <li key={o.id} role="option" aria-selected={selected.includes(o.id)}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-line"
                        checked={selected.includes(o.id)}
                        aria-label={o.label}
                        onChange={() => toggle(o.id)}
                      />
                      <span className="truncate">{o.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
