// src/components/layout/PageHeader.tsx — zone 1, and the only thing allowed in it.
//
// ── WHY THE ACTION SLOT TAKES DATA AND NOT NODES (D-93) ─────────────────────
//
// D-77 says the header's action slot is **verbs only**: a search box, a filter or
// a scope select belongs to zone 3, because a control sitting beside the title
// reads as part of the page's identity rather than as something you operate.
//
// Today `/apps` puts a search box in that slot, `/dashboard` a scope select and
// `/history` **two** filter selects. Every one of them looked reasonable on the
// page doing it — which is the whole problem, and the reason a `ReactNode` slot
// plus a written rule would not survive. So the slot takes a tuple of ACTION
// RECORDS: a label, a verb to run, and nothing that could hold an input.
//
//   A search box is not expressible here. That is the mechanism.
//
// The two-action cap is the tuple's arity, so `tsc` enforces it rather than a
// reviewer counting children. There is no three-action member because there is
// no third action: a page needing more has a menu, and a menu is one action.
//
// ⚠ THIS IS THE NEW HEADER, AND `components/ui/PageHeader.tsx` IS THE OLD ONE.
// Both exist until Phase 4 moves the remaining pages; the legacy file says so at
// its top and names the phase that deletes it. Import by path, deliberately.
"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Zone } from "./Page";
import { Button } from "@/components/ui/Button";
import { Check, Close, Pencil } from "@/components/ui/icons";

/**
 * One verb in the header.
 *
 * Exactly one of `onClick` / `href` is meaningful; giving both is a programming
 * error the renderer resolves by preferring `href`, because a link that also runs
 * a handler is two behaviours behind one label.
 *
 * ⚠ There is no `children` and no `render`. Those are the escape hatches that
 * would put a `<Select>` back in the header within a month.
 */
export type HeaderAction = {
  /** The verb, in sentence case. "New trigger", not "Triggers". */
  label: string;
  onClick?: () => void;
  href?: string;
  /** A leading glyph. Decorative — the label always carries the meaning. */
  icon?: ReactNode;
  /** Defaults to `primary` for the first action and `ghost` for the second. */
  variant?: "primary" | "ghost" | "subtle" | "danger" | "danger-quiet";
  disabled?: boolean;
  /** Hover text. ⚠ If the action is disabled, say WHY here — a dead button with no reason reads as a bug. */
  title?: string;
};

/**
 * Zone 1: an optional eyebrow, the title, one line of purpose, and at most two
 * actions.
 *
 * `purpose` is optional (2026-10-11, docs/design/README.md §1: "a label names; it does not explain"). When given
 * it is one sentence: what this page is FOR, not what it contains. Most index pages need none — the title and the
 * data say it.
 *
 * `eyebrow` is where the page sits — its nav group today, its parent record once
 * Phase 3's breadcrumb exists. It is not a second title.
 *
 * ⚠ It renders its own `<Zone name="header">`, so zone 1 is only ever this
 * component. That is what makes "no controls in the header" true of the ZONE and
 * not merely of the component — there is nowhere else at the top of a page to put
 * one.
 */
export function PageHeader({
  eyebrow,
  title,
  purpose,
  actions,
  badge,
  aside,
  titleClassName,
  onRenameTitle,
}: {
  eyebrow?: string;
  title: string;
  purpose?: string;
  actions?: readonly [HeaderAction] | readonly [HeaderAction, HeaderAction];
  /**
   * A status pill beside the title (the mock's "Live" / "Succeeded" badge).
   * One line, never a control — it is part of what the page IS, which is why
   * it sits beside the title and not in the action slot.
   */
  badge?: ReactNode;
  /**
   * Read-only figures on the header's right (the Email box's counts). Figures only — never an input or a control,
   * which is what `actions` is for and why this is not a second way to put a search box in zone 1.
   */
  aside?: ReactNode;
  /**
   * Extra classes for the `<h1>` — e.g. `font-mono` on the data-source detail
   * page, whose title is an identifier the manifest references. Additive; the
   * default face is unchanged.
   */
  titleClassName?: string;
  /**
   * When set, a pencil icon renders beside the title and clicking it turns
   * the title into an inline text field. Returning (or throwing) a promise
   * keeps the field in its "saving" state until it settles; a thrown error's
   * message renders under the title rather than the field silently reverting.
   *
   * ⚠ Additive and opt-in — every page that does not pass this renders
   * exactly as before. This is the one deliberate exception to "zone 1 takes
   * verbs, not controls" (D-93): renaming is editing the title itself, not a
   * second thing bolted beside it, so it stays out of the `actions` slot.
   */
  onRenameTitle?: (name: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // The title can change under us (a reload after some other edit, or the
  // rename this control itself just caused) — keep the draft in step so
  // reopening the editor never shows a stale value.
  useEffect(() => {
    setDraft(title);
  }, [title]);

  function startEditing() {
    setDraft(title);
    setRenameError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setDraft(title);
    setRenameError(null);
    setEditing(false);
  }

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title.trim()) {
      cancelEditing();
      return;
    }
    setSaving(true);
    setRenameError(null);
    try {
      await onRenameTitle?.(trimmed);
      setEditing(false);
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Zone name="header" as="header" gap="none">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="mb-1 text-xs uppercase tracking-label text-dim">{eyebrow}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {editing ? (
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commit();
                    if (e.key === "Escape") cancelEditing();
                  }}
                  disabled={saving}
                  maxLength={120}
                  aria-label="Workflow name"
                  className={`min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 py-0.5 text-xl font-medium text-text outline-none ${titleClassName ?? ""}`}
                />
                <button
                  type="button"
                  onClick={() => void commit()}
                  disabled={saving}
                  aria-label="Save name"
                  title="Save"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ok hover:bg-surface-2 disabled:opacity-50"
                >
                  <Check s={16} />
                </button>
                <button
                  type="button"
                  onClick={cancelEditing}
                  disabled={saving}
                  aria-label="Cancel rename"
                  title="Cancel"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 disabled:opacity-50"
                >
                  <Close s={16} />
                </button>
              </div>
            ) : (
              <>
                <h1 className={`text-xl font-medium text-text ${titleClassName ?? ""}`}>{title}</h1>
                {onRenameTitle && (
                  <button
                    type="button"
                    onClick={startEditing}
                    aria-label="Rename"
                    title="Rename"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <Pencil s={15} />
                  </button>
                )}
              </>
            )}
            {badge}
          </div>
          {renameError && (
            <p role="alert" className="mt-1 text-xs text-danger">
              Could not rename: {renameError}
            </p>
          )}
          {/* The purpose is measured, not wrapped at whatever the page is wide:
              a line of prose past ~80 characters is harder to return to. */}
          {purpose && <p className="mt-1 max-w-prose text-sm text-muted">{purpose}</p>}
        </div>
        {aside && <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{aside}</div>}
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {actions.map((a, i) => (
              <HeaderButton key={a.label} action={a} index={i} />
            ))}
          </div>
        )}
      </div>
    </Zone>
  );
}

function HeaderButton({ action, index }: { action: HeaderAction; index: number }) {
  // The first action is the one the page is for; the second is an alternative,
  // never a second primary. Two gradient buttons side by side is a choice with no
  // recommendation.
  const variant = action.variant ?? (index === 0 ? "primary" : "ghost");
  const content = (
    <>
      {action.icon}
      {action.label}
    </>
  );
  if (action.href) {
    // `asChild` does not exist here, so the link wears the button's classes by
    // rendering a Button as its child would double the element. A styled Link is
    // the smaller lie, and it keeps the anchor semantics a navigation needs.
    return (
      <Link
        href={action.href}
        title={action.title}
        className={
          "inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition " +
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
          // ⚠ Flat fill, so `text-on-accent` — the token that flips between
          // themes with the fill it sits on.
          (variant === "primary" ? "btn-primary hover:bg-accent/85" : "border border-line text-text hover:bg-surface-2")
        }
      >
        {content}
      </Link>
    );
  }
  return (
    <Button variant={variant} onClick={action.onClick} disabled={action.disabled} title={action.title}>
      {content}
    </Button>
  );
}
