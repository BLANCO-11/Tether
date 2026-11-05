// src/lib/approval-views.ts — S-37's four tabs and the pack's six request types.
//
// `S-37.md § Copy` and `04-information-architecture.md § nav rail` agree: the inbox
// has four tabs reached via `?tab=`. Each is a filter on the same queue, not a
// different page — so the value lives in the URL, the rail links to it, and the
// table reads it. This file is the one place that defines which four and which is
// the default; the page imports it so the list cannot drift from the rail.

export type ApprovalTabKey = "pending-me" | "requested-by-me" | "delegated" | "history";

export const APPROVAL_TABS: readonly { key: ApprovalTabKey; label: string }[] = [
  { key: "pending-me", label: "Pending me" },
  { key: "requested-by-me", label: "Requested by me" },
  { key: "delegated", label: "Delegated" },
  { key: "history", label: "History" },
] as const;

export function isApprovalTabKey(v: string | null | undefined): v is ApprovalTabKey {
  return v === "pending-me" || v === "requested-by-me" || v === "delegated" || v === "history";
}

export function getActiveApprovalTab(search: string | null | undefined): ApprovalTabKey {
  const raw = search ?? "";
  return isApprovalTabKey(raw) ? raw : "pending-me";
}

// ── The six types that share one queue (S-37 § Copy, 05-data-model.md § Approval) ──

export type ApprovalType =
  | "Exception"
  | "Publication"
  | "Access request"
  | "Recovery"
  | "Policy exception"
  | "Resource change";

export type ApprovalRisk = "Low" | "Medium" | "High";

// Derived waiting label per `flows/07-approvals.md § Step 1` — derived from raisedAt.
export function waitingLabel(raisedAt: string | null | undefined, nowMs = Date.now()): string {
  if (!raisedAt) return "—";
  const d = new Date(raisedAt);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = nowMs - d.getTime();
  if (diff < 0) return "—";
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) {
    const hours = Math.floor(diff / 3_600_000);
    if (hours <= 1) return "today";
    return `${hours} hours`;
  }
  return `${days} days`;
}

// UXI-005 note: the bare coloured word does not survive greyscale; RiskWord adds shape.
export const RISK_ORDER: readonly ApprovalRisk[] = ["Low", "Medium", "High"] as const;
