// src/components/ui/Badge.tsx — status pills, plain tags, and the type tag.
// Status is always a colored dot + plain words (never a code).
import type { Status } from "@/lib/types";
import { STATUS_LABEL, STATUS_STYLE, type StatusWord } from "@/lib/status";

// Per-status text color + translucent pill background.
const tone: Record<Status, { text: string; bg: string; dot: string }> = {
  ok: { text: "text-ok", bg: "bg-ok-bg", dot: "bg-ok" },
  warn: { text: "text-warn", bg: "bg-warn-bg", dot: "bg-warn" },
  danger: { text: "text-danger", bg: "bg-danger-bg", dot: "bg-danger" },
  neutral: { text: "text-muted", bg: "bg-surface-2", dot: "bg-muted" },
};

/** A pill: colored dot + plain-words status on a translucent tint. */
export function StatusPill({ status, children }: { status: Status; children: React.ReactNode }) {
  const t = tone[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${t.bg} ${t.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}

/**
 * The same pill, in the FIVE status words rather than the four tones.
 *
 * ⚠ It reads `STATUS_STYLE` and `STATUS_LABEL` rather than declaring classes of
 * its own — `lib/status.ts` says in its own header that a second copy is how the
 * tile and the pill stop agreeing about what amber means. `StatusPill` above
 * keeps the four-tone `Status`, which most of the product still speaks; this is
 * for the surfaces that have a real status WORD to show.
 */
export function StatusWordPill({ word }: { word: StatusWord }) {
  const s = STATUS_STYLE[word];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${s.bg} ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {STATUS_LABEL[word]}
    </span>
  );
}

/** A plain hairline pill for labels like "Work account" or "version 3". */
export function Tag({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span className={`rounded-full border border-line px-2.5 py-0.5 text-xs text-muted ${mono ? "font-mono" : ""}`}>
      {children}
    </span>
  );
}

/** The action type tag. "changes data" is orange; read-only is muted. */
export function TypeTag({ type }: { type: string }) {
  const changes = type === "changes data";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs ${changes ? "bg-orange-bg text-orange" : "border border-line text-muted"}`}>
      {type}
    </span>
  );
}
