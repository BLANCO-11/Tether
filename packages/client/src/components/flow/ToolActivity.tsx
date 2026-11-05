// src/components/flow/ToolActivity.tsx — what this run actually called.
// platform-coherence Phase 7.2 · I-110
//
// The answer to **"the run went green, but did it do anything?"** — the question this product exists to answer, and
// the failure it was built around is a script that emailed 0 of 11 people and reported `clean`. A green run is a claim;
// this is the record.
//
// ── Foundry's own records since 2026-10-30 ──────────────────────────────────
//
// `GET …/flow-executions/:id/calls`: every tool call and read the run's steps made through the step API, and every web
// address it read, with the answer. It was ops-api's `api_call_log`, which only ever saw ops-api's simulated tools — a
// connector call, a real email and a web read were never in it. Scoped by the run's id, never by a time window: on an
// instance where several runs overlap, a time window attributes another run's calls to this one, plausibly.
//
// ── Email delivery is its own section (email-send-tool T038) ────────────────
//
// `foundry_email_send` records each message in `email_sends`: to whom, and whether it was held, sent, refused or
// failed. The call above says the step asked; the section below says what happened to the email.
"use client";

import { useState } from "react";
import type { FAEmailSend, FARunCall } from "@/lib/foundry-client";
import { useAsync } from "@/lib/hooks";
import { callsForRun, emailsForRun } from "@/lib/api";

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString();
};

export function ToolActivity({ runId }: { runId: string }) {
  const { data, loading, error } = useAsync(() => callsForRun(runId), [runId]);

  return (
    <section className="pane p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-body font-semibold text-text">Tool activity</h2>
        {data && data.calls.length > 0 && (
          <span className="text-xs text-muted">
            {data.calls.length} call{data.calls.length === 1 ? "" : "s"} · newest first
          </span>
        )}
      </div>

      {/* ⚠ An error is shown, never swallowed into an empty list. "This run
          called nothing" and "the tool layer is unreachable" are opposite
          answers and look identical as a blank panel — which is the `faFallback`
          lesson, in the one place where the whole point is evidence. */}
      {error && (
        <p className="rounded-md border border-warn/40 bg-warn-bg px-3 py-2 text-body text-warn">
          Could not read what this run called: {error}. This is not evidence that the run called
          nothing.
        </p>
      )}

      {!error && loading && !data && <p className="text-body text-muted">Loading…</p>}

      {!error && data && data.calls.length === 0 && (
        <p className="rounded-md border border-line px-3 py-2 text-body text-muted">
          No calls recorded for this run. A workflow whose steps only work things out calls nothing, and a run
          from before calls were recorded here lists none either.
        </p>
      )}

      {!error && !!data?.calls.length && (
        <div className="divide-y divide-line">
          {data.calls.map((c) => (
            <CallRow key={c.id} c={c} />
          ))}
        </div>
      )}

      {data?.truncated && (
        <p className="mt-3 text-xs text-dim">This run made more calls than are listed here; the newest are shown.</p>
      )}

      <RealEmailActivity runId={runId} />
    </section>
  );
}

/**
 * REAL email delivery for this run — `email_sends`, not `api_call_log`.
 * email-send-tool T038
 *
 * ⚠ **Rendered even when there is nothing to show, but only as a heading with an
 * explicit empty state** — never silently omitted. A panel that disappears when a
 * read returns nothing cannot be told apart from a panel that was never there, and
 * on this surface the difference is "no email was sent" versus "nobody is looking".
 */
function RealEmailActivity({ runId }: { runId: string }) {
  const { data, loading, error } = useAsync(() => emailsForRun(runId), [runId]);
  const emails = data ?? [];

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-body font-semibold text-text">
          Email delivery{" "}
          {/* ⚠ Says REAL, on the surface a reader checks to find out whether
              anything actually happened. The simulated `mail_send` tool appears in
              the section above and delivers nothing; a reader who conflates the two
              draws the opposite conclusion from the truth. */}
          <span className="ml-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            real
          </span>
        </h3>
        {emails.length > 0 && (
          <span className="text-xs text-muted">
            {emails.length} message{emails.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* Same rule as the panel above: an error is shown, never swallowed into an
          empty list. "Nothing was emailed" and "the record is unreadable" are
          opposite answers that look identical as a blank panel. */}
      {error && (
        <p className="rounded-md border border-warn/40 bg-warn-bg px-3 py-2 text-body text-warn">
          Could not read the email record: {error}. This is not evidence that the run emailed
          nobody.
        </p>
      )}

      {!error && loading && !data && <p className="text-body text-muted">Loading…</p>}

      {!error && data && emails.length === 0 && (
        <p className="rounded-md border border-line px-3 py-2 text-body text-muted">
          No real email was attempted by this run. A flow that uses the simulated{" "}
          <code className="font-mono text-xs">mail_send</code> tool delivers nothing and appears
          above, not here.
        </p>
      )}

      {!error && emails.length > 0 && (
        <div className="divide-y divide-line">
          {emails.map((e) => (
            <EmailRow key={e.id} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmailRow({ e }: { e: FAEmailSend }) {
  const [show, setShow] = useState(false);
  /**
   * ⚠ Three outcomes, three tones, and `refused` is NOT styled as a failure of the
   * same kind as `failed`. Refused means Foundry declined and nothing left the
   * building — the fix is a recipient or a config variable. Failed means Microsoft
   * was reached and did not accept it — the fix is at the provider. Showing them
   * identically sends the reader to the wrong place.
   */
  const tone =
    e.outcome === "sent"
      ? "bg-ok-bg text-ok"
      : e.outcome === "refused"
        ? "bg-warn-bg text-warn"
        : "bg-danger-bg text-danger";

  const recipients = e.recipients ?? [];
  const cc = e.cc ?? [];
  const hasDetail = Boolean(e.failureReason || e.graphMessageId || cc.length > 0);

  return (
    <div className="py-3">
      <button
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left disabled:cursor-default"
        onClick={() => setShow((v) => !v)}
        disabled={!hasDetail}
      >
        {/* ⚠ THE RECIPIENTS, first and in full. This is the field the whole panel
            exists for: "who did this actually email?" A truncated or summarised
            recipient list is the question left unanswered. An empty list on a
            `refused` row is the honest rendering of a message that went nowhere. */}
        <span className="min-w-0 flex-1 font-mono text-xs text-text">
          {recipients.length > 0 ? recipients.join(", ") : <span className="text-dim">nobody</span>}
        </span>
        <span className="shrink-0 text-caption text-dim">
          {e.subject ?? "—"}
          {/* Why it went there, so the destination is explainable without opening
              the flow. `requester` = the person who started the run. */}
          {e.resolvedFrom && ` · ${e.resolvedFrom}`}
          {cc.length > 0 && ` · cc ${cc.length}`}
          {e.createdAt && ` · ${when(e.createdAt)}`}
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${tone}`}>
          {e.outcome}
        </span>
      </button>

      {show && hasDetail && (
        <div className="mt-2 space-y-1 rounded bg-sunken p-2 text-caption">
          {cc.length > 0 && (
            <p>
              <span className="text-dim">cc:</span>{" "}
              <span className="font-mono">{cc.join(", ")}</span>
            </p>
          )}
          {e.failureReason && (
            <p>
              <span className="text-dim">reason:</span> {e.failureReason}
            </p>
          )}
          {e.graphMessageId && (
            <p>
              {/* ⚠ Labelled "correlation id", not "message id". Graph answers 202
                  with an empty body, so no RFC 5322 Message-ID exists — a reader
                  told otherwise will go looking for it in a mail header. */}
              <span className="text-dim">Graph correlation id:</span>{" "}
              <span className="font-mono">{e.graphMessageId}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CallRow({ c }: { c: FARunCall }) {
  const what = c.kind === "web" ? "web read" : c.kind === "read" ? "read" : "tool";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <span className="shrink-0 font-mono text-xs font-medium">{c.name}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted" title={c.detail ?? undefined}>
        {c.detail ?? (c.stepId ? `step ${c.stepId}` : "")}
      </span>
      <span className="shrink-0 text-caption text-dim">
        {what}
        {c.durationMs != null && ` · ${c.durationMs}ms`}
        {` · ${when(c.at)}`}
      </span>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-caption ${c.ok ? "bg-ok-bg text-ok" : "bg-danger-bg text-danger"}`}>
        {c.ok ? "ok" : "failed"}
      </span>
    </div>
  );
}
