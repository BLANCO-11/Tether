// src/components/ui/Notice.tsx — the page-level banner, in four tones.
//
// ── WHAT IT REPLACES (ui-upgrade D-77, Phase 2.3) ─────────────────────
//
// Four pages each wrote their own banner inline, at four different recipes:
// `/keys` (collision and missing-value audits), `/flows`, `/apps` (the
// placeholder declaration) and `/triggers` (the two blocked reasons). No two
// agreed on border colour, tint, padding or whether the title was bold — so the
// same severity read as a different severity depending on which page you were
// on, which is the one thing a severity must not do.
//
// ⚠ A notice belongs in ZONE 2 and is always full width. That is not a style
// preference: a banner that shares a row with content is a banner people scroll
// past, and every one of these exists because something is either wrong or
// deliberately limited.
"use client";

import type { ReactNode } from "react";

/**
 * Four tones, and the boundary between the middle two is the one that matters.
 *
 * - `danger` — it went wrong. Something failed, something is orphaned.
 * - `warn`   — it needs a person. An approval, a first run, a missing value.
 * - `info`   — a stated limit. "This page is a placeholder"; "a draft run reads
 *              fixtures". Nothing is broken and nothing is owed.
 * - `ok`     — a confirmed good state, used sparingly. A page covered in green
 *              banners has taught its reader to skip banners.
 *
 * ⚠ `warn` is NOT a weak `danger`. "It has never run" is fixed by running it;
 * "it failed" is fixed by finding out why. A UI that renders both amber makes
 * the actionable one invisible among the informational ones.
 *
 * ⚠ The alpha-stage disclaimer is NOT a Notice and must not become one. It uses
 * `--alpha` and lives in the shell accordion (D-86) — a permanent product
 * disclaimer sharing a hue with a live incident is how the incident stops being
 * read.
 */
export type NoticeTone = "danger" | "warn" | "info" | "ok";

const TONE: Record<NoticeTone, { box: string; title: string; icon: string }> = {
  danger: { box: "border-danger-line bg-danger-bg", title: "text-danger", icon: "bg-danger" },
  warn: { box: "border-warn-line bg-warn-bg", title: "text-warn", icon: "bg-warn" },
  info: { box: "border-line bg-surface-2", title: "text-text", icon: "bg-muted" },
  ok: { box: "border-[color-mix(in_srgb,var(--ok)_35%,transparent)] bg-ok-bg", title: "text-ok", icon: "bg-ok" },
};

/**
 * A page-level notice.
 *
 * `title` is the claim, in one line. `children` is the detail and the recourse —
 * ⚠ **say what to do about it.** A banner naming a problem with no next step is
 * a banner people learn to close.
 *
 * `action` is at most one control, on the right. Two actions in a banner is a
 * dialog wearing a banner's clothes.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className = "",
}: {
  tone?: NoticeTone;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <div
      // `role="status"` rather than `role="alert"` even for danger: these render
      // with the page rather than interrupting it, and `alert` on a banner that
      // is present at load makes a screen reader announce it over whatever the
      // person was reading.
      role="status"
      data-tone={tone}
      className={`flex w-full flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between ${t.box} ${className}`}
    >
      <div className="flex min-w-0 gap-3">
        {/* A dot, not an icon glyph: colour is already carrying the tone, and a
            warning triangle next to amber text is the same fact drawn twice. */}
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${t.icon}`} aria-hidden />
        <div className="min-w-0">
          <p className={`text-sm font-medium ${t.title}`}>{title}</p>
          {children && <div className="mt-1 text-sm text-muted">{children}</div>}
        </div>
      </div>
      {action && <div className="shrink-0 sm:pl-4">{action}</div>}
    </div>
  );
}
