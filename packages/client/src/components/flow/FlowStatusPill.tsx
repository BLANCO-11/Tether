// src/components/flow/FlowStatusPill.tsx — the flow status pill, one definition.
//
// Phase 6 of the old-UI restoration found this rendered three times — the flows
// list, the approval gate, and (now) the flow detail header — as three near-
// identical local `CHIP` maps that had already drifted (one said "Approved",
// another "Approved — no schedule"; one used the shared `StatusPill` primitive's
// four tones, another its own accent-tinted pill for `draft_pending`, which has
// no equivalent among those four). A flow whose list row and detail page
// describe the same status two different ways is a smaller version of the
// disagreement guardrail 12 exists to prevent elsewhere. One definition, reused.
import type { FlowSummary } from "@/lib/types";

const CHIP: Record<FlowSummary["status"], { text: string; cls: string }> = {
  draft: { text: "Draft", cls: "border-alpha-line bg-alpha-bg text-alpha" },
  draft_pending: { text: "Draft waiting for approval", cls: "bg-accent/10 text-accent" },
  approved: { text: "Approved", cls: "bg-ok-bg text-ok" },
  armed: { text: "Running on a schedule", cls: "bg-ok-bg text-ok" },
  suspended: { text: "Suspended", cls: "bg-warn-bg text-warn" },
};

export function FlowStatusPill({ status }: { status: FlowSummary["status"] }) {
  const c = CHIP[status] ?? CHIP.draft;
  return <span className={`rounded-full px-2.5 py-1 text-caption ${c.cls}`}>{c.text}</span>;
}
