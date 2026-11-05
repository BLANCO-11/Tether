// src/components/ui/Skeleton.tsx — footprint-stable loading placeholder (mock D-16).
//
// Renders N shimmer bars that occupy the same footprint as the content that is
// coming. The bars are `aria-hidden` — the loading state is announced by the
// page's own aria-busy/live region, and a screen reader listing "loading"
// bars is noise. Widths cycle wide/mid/narrow via `.skel-bar:nth-child` in
// globals.css so a table reads as rows, not a solid slab.

export function Skeleton({
  rows = 3,
  className = "",
}: {
  /** number of bars to render (default 3) */
  rows?: number;
  /** layout classes for the container (gap, padding, width, …) */
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2.5 ${className}`} aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel-bar" />
      ))}
    </div>
  );
}
