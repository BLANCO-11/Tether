"use client";

// src/components/approval/RiskWord.tsx — S-37 § Layout + UXI-005 fix.
//
// Capture renders Risk as a bare coloured word (Low dim, Medium amber, High red)
// with no other mark, so greyscale reads three identical words. Law 6 requires a
// second channel. This component keeps the coloured word and adds a distinct drawn
// shape per level (circle / triangle / diamond) with an explicit `aria-label`, so
// colour is never the only carrier.
//
// Uses Foundry's own ink tokens (no new colours) and currentColor SVG so the shape
// inherits the same tone as the word but remains distinguishable by geometry alone.
import type { ApprovalRisk } from "@/lib/approval-views";

const SIZE = 12;

function LowIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function MediumIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.5L10.5 10.5H1.5L6 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
function HighIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1L11 6L6 11L1 6L6 1Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function RiskWord({ risk, className = "" }: { risk: ApprovalRisk; className?: string }) {
  const tone =
    risk === "Low" ? "text-muted" : risk === "Medium" ? "text-warn" : "text-danger";
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${tone} ${className}`.trim()}
      aria-label={`${risk} risk`}
      title={`${risk} risk`}
    >
      <span aria-hidden="true" className="inline-flex">
        {risk === "Low" ? <LowIcon /> : risk === "Medium" ? <MediumIcon /> : <HighIcon />}
      </span>
      <span>{risk}</span>
    </span>
  );
}
