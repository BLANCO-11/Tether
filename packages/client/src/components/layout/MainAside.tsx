// src/components/layout/MainAside.tsx — zone 4's two-column shape: the work on the
// left, a summary of it on the right.
//
// ── WHY THIS IS A COMPONENT AND NOT A `grid-cols-[...]` ON THE PAGE ──────────
//
// `ui-honesty-check.sh` fails any page file containing `grid-cols-[`, and the
// grep is deliberately blunt (see its own note: the bluntness cost three real
// edits during the Phase 4 migration and every one was better off for it). The
// rule exists because nine bespoke column templates once described the same shape
// of row, no two agreeing. A two-column content shape is the same problem one
// level up: `S-01`, `S-21`, `S-24` and `S-62` in the design pack are all main +
// right aside, and four pages each writing their own grid is four numbers free to
// drift.
//
// ── THE 340px ────────────────────────────────────────────────────────────────
//
// ⚠ **`aside` is a MEASUREMENT, not a stated token.** The design handoff pack stated five content
// measures and the rail's 240px; it did not state this column
// (pack record removed 2026-09-11; the geometry quarantine note went with it, and
// the point stands: this must not be mistaken for a specified number). It lives here
// as a default a caller may override, and it becomes a
// token the day `UX-009` decides what this grid does below the page measure.
//
// ── THE STACKING ORDER IS THE DECISION ──────────────────────────────────────
//
// One column below `lg`, and the aside falls BELOW the main column there. The
// aside is a summary OF the main column, so on a narrow viewport the thing being
// summarised comes first. A caller wanting the reverse is describing a different
// shape and should say so rather than passing a flag.
import type { CSSProperties, ReactNode } from "react";

export function MainAside({
  children,
  aside,
  /** Override the aside's width for this instance. ⚠ **No default here**: the
      number lives once, as `--aside-w` in `globals.css`, and a default in this
      signature would be a second copy of it free to disagree. */
  asideWidth,
  /** Label for the aside landmark. Required: an unlabelled `<aside>` is a region a screen reader announces as nothing. */
  asideLabel,
  gap = "gap-5",
}: {
  children: ReactNode;
  aside: ReactNode;
  asideWidth?: string;
  asideLabel: string;
  gap?: string;
}) {
  return (
    // `.main-aside` lives in globals.css beside `.pane` — the repo's idiom for a
    // shape used by more than one screen. It reads `--aside-w`, so the one number
    // a caller may vary is a property and the grid template itself has a single
    // definition.
    <div
      className={`main-aside grid ${gap} lg:items-start`}
      style={asideWidth ? ({ ["--aside-w" as string]: asideWidth } as CSSProperties) : undefined}
    >
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
      <aside aria-label={asideLabel} className="flex flex-col gap-4">
        {aside}
      </aside>
    </div>
  );
}
