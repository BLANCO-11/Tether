// src/components/automation/TriggerFires.tsx — a trigger's fire audit trail.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// `GET /…/triggers/:tid/fires` has existed since Phase 3 and no client method
// reached it, which made it the last remaining GAP in `e2e:ui` (step 36). The
// route is not a nicety: **a fire that started nothing still writes a row**, and
// that row is the only place in the product where "my automation is silent"
// splits into its two completely different diagnoses —
//
//   * **no rows at all** — it never fired. The trigger is not armed, or the
//     schedule lives on the flow model and no revision was ever approved.
//   * **rows with no run** — it fired and was refused. Gate 2, almost always:
//     `assertMayRunLive` re-checks approval and fingerprint on the live
//     namespace, and a revoked or stale flow starts nothing.
//
// The card's "Last started" cannot tell them apart, because it is stamped by the
// fire, not by the run.
"use client";

import Link from "next/link";
import { listTriggerFires } from "@/lib/api";
import { useAsync } from "@/lib/hooks";

/**
 * ⚠ `startedRunId` is FOUNDRY's execution id, so the link is a real link.
 * Executions are addressed by their Foundry id (R5) and there is no Kestra id on
 * this payload — the same reason `test-run` and `fire` stopped returning one
 * (I-22).
 */
export function TriggerFires({ triggerId }: { triggerId: string }) {
  const { data: fires, loading, error, reload } = useAsync(
    () => listTriggerFires(triggerId),
    [triggerId],
  );

  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-label text-dim">Fire history</div>

      {/* ⚠ The error branch is not boilerplate. A `useAsync` consumer that
          ignores `error` renders an empty list when the server is unreachable —
          and here an empty list *means something*: "this trigger has never
          fired". Silently showing the strongest possible finding as the result
          of a failed request is precisely the `faFallback` mistake with fewer
          steps, so a failure has to say it failed. `ui-honesty-check.sh`
          asserts every `useAsync` caller reads `error`. */}
      {error ? (
        <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs">
          <p className="text-danger">Could not load the fire history.</p>
          <p className="mt-0.5 text-muted">{error}</p>
          <button onClick={reload} className="mt-1 text-accent hover:underline">
            Try again
          </button>
        </div>
      ) : loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (fires ?? []).length === 0 ? (
        <p className="text-xs text-muted">
          This trigger has never fired. Nothing has tried to start the automation.
        </p>
      ) : (
        <ul className="space-y-1">
          {(fires ?? []).map((f) => (
            <li key={f.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="text-muted">{f.when || "—"}</span>
              <span>fired {f.how}</span>
              {f.startedRunId ? (
                <Link
                  href={`/runs/${f.startedRunId}`}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  started a run{f.startedRunStatus ? ` · ${f.startedRunStatus}` : ""}
                </Link>
              ) : (
                // The row worth reading. Stated as a fact about this fire and
                // NOT as an explanation — the reason is not on this payload, and
                // guessing "not approved" here would be a claim the page cannot
                // support.
                <span className="text-warn">started nothing</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
