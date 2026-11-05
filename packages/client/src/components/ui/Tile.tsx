// src/components/ui/Tile.tsx — a figure with a label and a one-line note.
//
// ── WHY IT REPLACES StatTile RATHER THAN EXTENDING IT ───────────────────────
//
// `StatTile`'s tone was `"ok" | "warn"`, defaulting to `ok`. `/dashboard` passed
// `tone={rate >= 95 ? "ok" : "warn"}` — so a **40% success rate rendered in
// amber**, because amber was the worst colour the component had. There was no
// way to say "this is bad", only "this is not perfect"
// (`ui-upgrade/issues.md` I-76).
//
// The earthy theme makes that worse rather than better. In dark, `--warn` amber
// at least reads as *not fine*. In light, ochre on clay is a quieter, more
// agreeable colour — so a badly failing figure becomes LESS alarming when a
// person switches theme, which is the opposite of what a theme may do.
//
// So `tone` is now the five-word vocabulary in `lib/status.ts`, shared with the
// pill and the strip, and a failing figure can be red.
"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { STATUS_STYLE, type StatusWord } from "@/lib/status";

/**
 * One figure.
 *
 * `tone` colours the NOTE, never the figure — the number itself stays `--text`.
 * A large coloured number is read as a status by itself, and then the note under
 * it has nothing left to say; worse, a green "1,204" invites the reader to think
 * 1,204 is the good news rather than the measurement.
 *
 * ⚠ `tone` defaults to `draft`, the neutral one, and that is deliberate. The old
 * default was `ok` — so a tile whose author had not thought about tone claimed
 * everything was fine. A tile with nothing to say should say nothing.
 */
export function Tile({
  label,
  value,
  note,
  tone = "draft",
  className = "",
  href,
}: {
  label: string;
  value: string;
  note?: ReactNode;
  tone?: StatusWord;
  className?: string;
  /** Set to make the whole tile a link (the mock's clickable tiles, D-17). */
  href?: string;
}) {
  // One box, two elements. A tile is a link when it has somewhere to go; the
  // classes are identical either way so the link never looks like a different
  // surface. Tailwind's preflight gives `a` inherit-color and no underline, so
  // the box needs no extra reset.
  const body = (
    <>
      <div className="text-xs uppercase tracking-label text-dim">{label}</div>
      <div className="mt-2 text-3xl font-light text-text">{value}</div>
      {note && <div className={`mt-2 text-xs ${STATUS_STYLE[tone].text}`}>{note}</div>}
    </>
  );
  const classes = `rounded-lg border border-line bg-surface p-5 ${className}`;
  return href ? (
    <Link href={href} data-tone={tone} className={classes}>
      {body}
    </Link>
  ) : (
    <div data-tone={tone} className={classes}>
      {body}
    </div>
  );
}
