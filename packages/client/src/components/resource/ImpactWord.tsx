"use client";

// src/components/resource/ImpactWord.tsx — S-54 § Layout + UXI-005 fix.
//
// Capture renders IMPACT as a bare coloured word (Blocked red, Review amber)
// with no other mark, so greyscale reads two identical words. Same violation
// as S-37's RISK. This keeps the coloured word and adds a distinct drawn shape
// per level (diamond for Blocked, triangle for Review) with an accessible
// aria-label, so colour is never the only carrier.
//
// Uses Foundry ink tokens (no new colours) and currentColor SVG so the shape
// inherits the same tone as the word but remains distinguishable by geometry.

export type ImpactLevel = "Blocked" | "Review" | "Low";

const SIZE = 12;

function BlockedIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1L11 6L6 11L1 6L6 1Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ReviewIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.5L10.5 10.5H1.5L6 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function LowIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
export function ImpactWord({ impact, className = "" }: { impact: ImpactLevel; className?: string }) {
  const tone = impact === "Blocked" ? "text-danger" : impact === "Review" ? "text-warn" : "text-muted";
  const Icon = impact === "Blocked" ? BlockedIcon : impact === "Review" ? ReviewIcon : LowIcon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${tone} ${className}`.trim()}
      aria-label={`${impact} impact`}
      title={`${impact} impact`}
      data-testid="impact-word"
    >
      <span aria-hidden="true" className="inline-flex">
        <Icon />
      </span>
      <span>{impact}</span>
    </span>
  );
}
