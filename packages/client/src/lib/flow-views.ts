// src/lib/flow-views.ts — the workflow list's view tabs (design pack `S-28`).
//
// ⚠ **PURE, AND IN `lib/` FOR TWO REASONS.** Next.js allows only a fixed set of
// exports from a page module, so `VIEWS` living in `app/(app)/flows/page.tsx`
// failed the build with *"does not match the required types of a Next.js Page"* —
// a real error with a misleading message. And a predicate deciding which
// workflows a tab counts is exactly the kind of thing a test should be able to
// hold without rendering a page.
/**
 * `S-28`'s view tabs — label, count, and the predicate the count comes from.
 *
 * ⚠ **THE CAPTURE HAS EIGHT TABS AND FIVE OF THEM HAVE NOTHING BEHIND THEM.**
 * `S-28 § Copy` lists `All · My drafts · Needs my attention · Awaiting approval ·
 * Scheduled · Running · Failed · Archived · Templates`. Of those:
 *
 *   · `My drafts` needs an OWNER on a flow — there is none (`B-06`).
 *   · `Needs my attention` needs the same, plus a definition nothing states.
 *   · `Running` and `Failed` need each flow's LAST RUN; this page reads
 *     `listFlows()` and a run belongs to `/history`. A tab whose count is
 *     always 0 because nobody asked is worse than no tab — P6 fixes that by
 *     joining `FlowSummary` with its last `flowExecutions` row (honest-empty
 *     when none, predicate keeps `0` from being permanent).
 *   · `Archived` has no subject — CLAUDE.md is explicit that there is no
 *     archive; deleting is the only removal.
 *   · `Templates` is not a filter at all: it has its own route (S-05), and
 *     `S-28 § Open` records that *"a tab that navigates elsewhere is different
 *     from a tab that filters, and the two look identical"*. The template shelf
 *     is `FlowLibrary`, in zone 5, where it is a different question rather than
 *     a lookalike tab.
 *
 * So the tabs are the ones whose counts are computed from the rows on screen,
 * named in Foundry's own status vocabulary. Each is a `B-nn` away from the
 * capture's set; none of them is a guess.
 *
 * ⚠ **A `0` COUNT IS RENDERED, NOT HIDDEN** (`S-28 § Layout`: *"A `0` count is
 * rendered, not hidden (`Running 0`)"*). Hiding empty views makes the tab row
 * change shape as data changes, and "no failures" is information.
 */
import type { FlowSummary } from "@/lib/types";

/** Engine states that mean the run is still going — mirrors `lib/flow-stream.ts:LIVE`. */
const LIVE_ENGINE: Record<string, true> = { running: true, created: true, paused: true };

/** `isLive(engineStatus)` — the spec's live check for `Running`. Case-insensitive. */
export function isLive(engineStatus: string | null | undefined): boolean {
  if (!engineStatus) return false;
  return !!LIVE_ENGINE[engineStatus.toLowerCase()];
}

/**
 * Resolve the last-run shape from either `lastExecution` (FlowExecutionSummary)
 * or `lastRun` (Run). Honest-empty returns null — the predicate then counts 0.
 */
function lastRunOf(f: FlowSummary): { status?: string; engineStatus?: string | null; outcome?: string } | null {
  const r = f.lastExecution ?? f.lastRun ?? null;
  if (!r) return null;
  return r;
}

/** P6 `Running`: lastRun.status === "running" || isLive(lastRun.engineStatus). */
export function isRunningFlow(f: FlowSummary): boolean {
  const r = lastRunOf(f);
  if (!r) return false;
  if ((r.status ?? "").toLowerCase() === "running") return true;
  if (r.engineStatus && isLive(r.engineStatus)) return true;
  if ((r.outcome ?? "").toLowerCase() === "running") return true;
  return false;
}

/** P6 `Failed`: lastRun.status === "failed" or outcome === "stopped". */
export function isFailedFlow(f: FlowSummary): boolean {
  const r = lastRunOf(f);
  if (!r) return false;
  if ((r.status ?? "").toLowerCase() === "failed") return true;
  if ((r.engineStatus ?? "").toLowerCase() === "failed") return true;
  if ((r.outcome ?? "").toLowerCase() === "stopped" || (r.outcome ?? "").toLowerCase() === "failed") return true;
  return false;
}

/** P5 B-06 — does any flow carry owner data? Used to disable My drafts until owner exists. */
export function hasOwnerData(flows: FlowSummary[]): boolean {
  return flows.some((f) => !!f.ownerSubject);
}

/** P5 B-06 — is this flow a draft owned by `meSubject`? My drafts filters by ownerSubject === me.subject. */
export function isMyDraft(f: FlowSummary, meSubject: string | null | undefined): boolean {
  if (!meSubject) return false;
  const isDraft = f.status === "draft" || f.status === "draft_pending";
  return isDraft && f.ownerSubject === meSubject;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * IS THIS FLOW RUNNING UNATTENDED? — the one definition, and it is NOT
 * `armedRevision != null`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **`armed_revision` IS NOT A LIVENESS FLAG. It is the record of what WAS
 * armed, and `revoke` deliberately leaves it set.**
 * `flowApprovalService.revoke` removes the Schedule trigger from Kestra, closes
 * every approval row, and writes `status: "suspended"` — and never clears
 * `armed_revision`, because re-approval and the diff both need to know which
 * revision was the live one.
 *
 * Four call sites read `armedRevision != null` as "live" and all four were
 * wrong about a revoked flow: it stayed in the `Live` view, kept a green ON
 * toggle, and offered no explanation — so turning a flow off appeared to do
 * nothing while the trigger had in fact already gone from the engine. Measured
 * on the deployment: three flows at `status = suspended` with `armed_revision`
 * set and ZERO open approvals, every one of them rendering as live and on.
 *
 * ⚠ **`draft_pending` IS RUNNING, and this is the half a narrower predicate gets
 * wrong.** An armed flow whose draft moves ahead becomes `draft_pending` — it is
 * *still firing the approved revision*, with an unapproved one waiting. A
 * predicate of `status === "armed"` would render OFF on a flow that fires at
 * 09:00, which is the one direction of this bug that is dangerous rather than
 * merely annoying: believing an automation is stopped when it is not.
 *
 * ⚠ **EXHAUSTIVE `Record`, not a comparison or a `Set`.** A new `FlowStatus`
 * fails to compile until somebody classifies it, so the question is answered
 * once, deliberately, by whoever adds the status — rather than defaulting in
 * whichever direction the expression happened to fall. Both defaults are bad
 * and they are bad asymmetrically, so neither may be taken silently.
 */
const RUNS_UNATTENDED: Record<FlowSummary["status"], boolean> = {
  /** Never approved: nothing is deployed live at all. */
  draft: false,
  /** ⚠ Armed AND edited since. The APPROVED revision is still firing. */
  draft_pending: true,
  /** Approved with no schedule — live, fired by a trigger or a person, not a cron. */
  approved: true,
  /** Approved and carrying a deployed Schedule trigger. */
  armed: true,
  /** Revoked, or suspended by the staleness sweep. The trigger is gone from Kestra. */
  suspended: false,
};

/**
 * The single source of truth for "this flow can fire without anybody asking".
 *
 * Read by the `Live` and `Scheduled` view predicates, by the list's arm switch,
 * and by the row's suspended treatment. One definition, four readers — the same
 * reasoning that keeps D-22's expression allowlist in one function: a second
 * copy drifts, and here it would drift into telling somebody an automation is
 * off while it is firing.
 */
export function isRunningUnattended(f: Pick<FlowSummary, "status">): boolean {
  return RUNS_UNATTENDED[f.status] ?? false;
}

/**
 * Why this flow is not running, when it is not — and the two causes are NOT the
 * same sentence.
 *
 * `staleReason` is written by the staleness sweep alone (`markStale`): a tool or
 * query a flow depends on changed shape, so the product suspended it. `revoke`
 * writes no reason at all, because a person turned it off on purpose. Rendering
 * both as one string would report a deliberate act as a fault, and a fault as a
 * deliberate act.
 *
 * `null` when the flow is running, or is an ordinary never-approved draft —
 * neither of which is a state that owes an explanation.
 */
export function offReason(
  f: Pick<FlowSummary, "status" | "staleReason">,
): { kind: "stale"; text: string } | { kind: "turned_off"; text: string } | null {
  if (f.status !== "suspended") return null;
  if (f.staleReason) return { kind: "stale", text: f.staleReason };
  return {
    kind: "turned_off",
    // ⚠ No "until a revision is approved again": turning back on resumes the
    // approved revision directly through `POST …/approvals/rearm` — even with
    // a newer draft waiting, which keeps its own review queue. Only never-
    // approved flows need the review round-trip.
    text: "turned off — nothing fires unattended; turn it back on directly whenever you want",
  };
}

export type ViewKey = "all" | "mine" | "live" | "scheduled" | "awaiting" | "drafts" | "mydrafts" | "suspended" | "running" | "failed";

export const VIEWS: { key: ViewKey; label: string; match: (f: FlowSummary) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  // rbac-observability — the workflows this person owns. The server says which (`mine`), because it knows who is asking.
  { key: "mine", label: "Mine", match: (f) => f.mine === true },
  // Live = it can fire without anybody asking. ⚠ NOT `armedRevision != null` —
  // `revoke` leaves that set, so a turned-off flow used to stay listed here.
  { key: "live", label: "Live", match: isRunningUnattended },
  // ⚠ Running unattended AND carrying a cron — a live flow with no schedule fires
  // only when a trigger or a person starts it, so calling it "Scheduled" would be
  // false.
  {
    key: "scheduled",
    label: "Scheduled",
    match: (f) => isRunningUnattended(f) && (f.schedule ?? "").trim() !== "",
  },
  // Its owner asked a reviewer to approve it, and nobody has yet (sharing-boundaries 2026-10-30). Approving any version
  // clears the request on the server, so an approved workflow leaves the tab without a second rule here.
  { key: "awaiting", label: "Awaiting approval", match: (f) => f.reviewRequestedRevision != null },
  { key: "drafts", label: "Drafts", match: (f) => f.status === "draft" || f.status === "draft_pending" },
  // P5 B-06 — My drafts: draft owned by me. Pure predicate without `me` is draft+owner exists (so counts reflect data),
  // page narrows to `ownerSubject === me.subject` via `isMyDraft` when `me` is known; disabled until owner exists.
  { key: "mydrafts", label: "My drafts", match: (f) => (f.status === "draft" || f.status === "draft_pending") && !!f.ownerSubject },
  { key: "suspended", label: "Suspended", match: (f) => f.status === "suspended" },
  // P6 — last-run predicates. Honest-empty when no last run exists → 0, not hidden.
  { key: "running", label: "Running", match: isRunningFlow },
  { key: "failed", label: "Failed", match: isFailedFlow },
];

export function viewCounts(flows: FlowSummary[]): Record<ViewKey, number> {
  return Object.fromEntries(VIEWS.map((v) => [v.key, flows.filter(v.match).length])) as Record<ViewKey, number>;
}


