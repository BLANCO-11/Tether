// src/components/ui/Choice.tsx — a selectable option card (optionally marked recommended).
// Used by the data-source wizard (connector grid, credential-mode choice); originally
// lifted from the connect-an-app wizard so both share one look.
"use client";

export function Choice({ selected, onClick, title, body, recommended }: {
  selected: boolean; onClick: () => void; title: React.ReactNode; body: string; recommended?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${selected ? "border-accent bg-surface-2" : "border-line hover:bg-surface-2"}`}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {title}
        {recommended && <span className="rounded-full bg-ok-bg px-2 py-0.5 text-micro uppercase tracking-label text-ok">Recommended</span>}
      </div>
      <p className="mt-1.5 text-xs text-muted">{body}</p>
    </button>
  );
}
