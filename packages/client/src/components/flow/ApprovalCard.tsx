"use client";

/**
 * One pending decision — the whole of gate 3's UI, used by the inbox and by the
 * run page so the two cannot drift.
 *
 * ── What this component is careful about ─────────────────────────────────────
 *
 *  1. **It shows the evidence, not a count.** "Approve sending 10 emails" is
 *     unanswerable — to whom? The server sends the rows the run is about to act
 *     on (redacted server-side, D-07) and they are rendered here. A gate that
 *     cannot be answered is a gate that gets clicked through.
 *
 *  2. **Reject says what rejecting DOES.** It does not merely decline; it kills
 *     the run, because Kestra's Pause has no "resume down another branch" and
 *     un-pausing would execute the send. The confirmation says so rather than
 *     asking "are you sure?", which tells nobody anything.
 *
 *  3. **It does not ask who you are, and no longer can.** The decider used to be
 *     a text box with a warning that nothing checked it (I-13). Since Stage 9.1
 *     the server takes it from the signed identity the proxy forwards and
 *     REFUSES a body that names one, so there is nothing for this form to
 *     collect. The card shows the signed-in user instead — a statement of what
 *     will be recorded, not an input.
 *
 *     ⚠ Still not separation of duties. Verifying a name makes it true; it does
 *     not make it a control. Unlike gate 2 there is nobody to compare the
 *     decider against, because an execution has no author.
 *
 *  4. **One thing waits for a person, and there used to be two.** The second
 *     was an agent runtime's own question, which had to render as input fields
 *     rather than Approve/Reject — showing it as Approve/Reject would be
 *     answered by clicking Approve, which sent the agent no answer at all and
 *     left it parked. Both that kind and its runtime are gone; `defaultNote`
 *     keeps its two-argument shape because the second kind's notes had to differ
 *     in WORDS ("Answered", not "Approved"), and that is a property of the kind,
 *     not of this card.
 */

import { useState } from "react";
import { decideApproval } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { FAAgentQuestion, FAStepApproval } from "@/lib/foundry-client";
import { useToast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Badge";
import { Confirm } from "@/components/ui/Confirm";

/**
 * The note recorded when the person types none, chosen by the BUTTON they
 * pressed. Four cases, because a gate and a question are different acts in both
 * directions and one generic word ("ok") describes none of them.
 *
 * ── Why a default at all, and not `undefined` ────────────────────────────────
 *
 * ⚠ **A blank note is how a real approval was recorded and never delivered.**
 * Run `71be8add` on 2026-08-21: the note box was left empty, `decideApproval`
 * sent no note, the service sent `note: ""`, and the engine answered **422
 * `Missing required input: note`** — because `flow-compiler.service.ts` emits the
 * `approval` step's `onResume` inputs as bare `type: STRING`, which Kestra
 * defaults to `required: true`. So the row was stamped `decided`, the resume
 * failed, the run stayed paused holding its budget slot, and the inbox stopped
 * showing it (`listPending` filters on `decided_at IS NULL`). Reproduced in
 * isolation on a throwaway flow: `note=` → 422, `note=x` → 204.
 *
 * ⚠ **This is a MITIGATION, not the fix, and it must not be mistaken for one.**
 * The fix is server-side and has two halves — emit `required: false` for `note`,
 * and give a decision that recorded but never delivered a way to be re-delivered
 * (`decided_at NOT NULL AND applied_at IS NULL`, which the card already renders
 * as "recorded, but the engine never received it"). A client that always sends a
 * non-empty string stops this browser producing the state; it does nothing for a
 * flow already compiled, an older client, or any other caller of the route.
 *
 * ── And it is never a claim about what was checked ───────────────────────────
 *
 * The text says only which button was pressed and that nothing was typed, and it
 * names no surface — this card renders on the run page as well as the inbox. It
 * must NOT read as a reason ("looks fine", "verified") — the note is the
 * approver's own words in the audit record, and a default that sounds like a
 * judgement puts words in their mouth on the one row that exists to say what a
 * person decided.
 */
export function defaultNote(decision: "approved" | "rejected", isQuestion: boolean): string {
  if (isQuestion) {
    return decision === "approved"
      ? "Answered — no note given."
      : "Declined — no note given.";
  }
  return decision === "approved"
    ? "Approved — no note given."
    : "Rejected — no note given.";
}

/** Rows the run is about to act on, if the flow passed any. */
function evidenceRows(context: unknown): Array<Record<string, unknown>> | null {
  if (!context || typeof context !== "object") return null;
  const first = Object.values(context as Record<string, unknown>).find((v) => Array.isArray(v));
  return Array.isArray(first) ? (first as Array<Record<string, unknown>>) : null;
}

/**
 * "2h before this run" when the run's start is known, "2h ago" otherwise —
 * the mock's Approval-pane timing line, computed from the two timestamps.
 */
function decidedWhen(decidedAt: string, runStartedAt?: string | null): string {
  const decided = new Date(decidedAt).getTime();
  if (Number.isNaN(decided)) return "";
  const ref = runStartedAt ? new Date(runStartedAt).getTime() : Date.now();
  if (Number.isNaN(ref)) return "";
  const min = Math.round((ref - decided) / 60000);
  if (min < 1) return runStartedAt ? "just before this run" : "just now";
  if (min < 60) return runStartedAt ? `${min}m before this run` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return runStartedAt ? `${hr}h before this run` : `${hr}h ago`;
  const d = Math.round(hr / 24);
  return runStartedAt ? `${d}d before this run` : `${d}d ago`;
}

/** An option's stored value — bare strings or `{label, value}` are both allowed. */
function optionValue(o: string | { label?: string; value?: string }): string {
  return typeof o === "string" ? o : (o.value ?? o.label ?? "");
}
function optionLabel(o: string | { label?: string; value?: string }): string {
  return typeof o === "string" ? o : (o.label ?? o.value ?? "");
}

export function ApprovalCard({
  approval,
  onDecided,
  compact = false,
  runStartedAt,
}: {
  approval: FAStepApproval;
  onDecided?: () => void;
  /**
   * The run page's related-zone pane: a decided approval is a one-line summary
   * ("Granted by … · gate 3"), not the full card. An UNDECIDED approval still
   * renders the full decision surface — a run stopped for a person must stay
   * decidable from the run page.
   */
  compact?: boolean;
  /** The run's start, for the mock's "2h before this run" timing line. */
  runStartedAt?: string | null;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  const rows = evidenceRows(approval.context);
  const decided = !!approval.decidedAt;
  // ⚠ Always false today — the second kind went with its runtime. Kept as a
  // named fact rather than inlined, because the branches below say what a
  // second thing-that-waits would have to do differently.
  const isQuestion = approval.kind === "question";
  const questions: FAAgentQuestion[] = approval.questions ?? [];
  // The server refuses a partial answer set (400). Mirroring the rule here means
  // the button is disabled rather than than the request being rejected — but
  // the server check is the one that holds; this is only the earlier telling.
  const unanswered = questions.filter((q) => {
    const a = answers[q.id];
    return Array.isArray(a) ? a.length === 0 : !a?.trim();
  });

  if (compact && decided) {
    return (
      <section className="pane p-4">
        <h2 className="text-body font-semibold text-text">Approval</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-caption font-medium ${
              approval.decision === "approved"
                ? "bg-ok-bg text-ok"
                : "bg-danger-bg text-danger"
            }`}
          >
            {approval.decision === "approved" ? "Granted" : "Rejected"}
          </span>
          <span className="text-sm">
            by <strong>{approval.decidedBy ?? "—"}</strong>
          </span>
        </div>
        <p className="mt-1 text-caption text-dim">
          {approval.decidedAt && `${decidedWhen(approval.decidedAt, runStartedAt)} · `}gate 3
          {approval.note ? ` — “${approval.note}”` : ""}
        </p>
      </section>
    );
  }

  function setAnswer(id: string, value: string | string[]) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }
  function toggleMulti(id: string, value: string) {
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      return {
        ...prev,
        [id]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
      };
    });
  }

  async function decide(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      // No decider argument. The server reads it from the verified identity and
      // refuses one sent in the body — see the note above.
      await decideApproval(
        approval.id,
        decision,
        // ⚠ Never blank — see `defaultNote`. The engine's `onResume` declares
        // `note` as a REQUIRED string, so an empty one is a 422 that leaves the
        // decision recorded and the run still paused.
        note.trim() || defaultNote(decision, isQuestion),
        // Only on a question, and only when answering. `answers` on a gate is a
        // 400 by design, so sending an empty object "just in case" would break
        // every gate.
        isQuestion && decision === "approved" ? answers : undefined,
      );
      if (decision === "approved") {
        toast.success(isQuestion ? "Answer sent — the agent has picked up where it stopped." : "Approved — the run has been resumed.");
      } else {
        toast.warn(
          isQuestion
            ? "Declined — the agent was stopped and this step failed."
            : "Rejected — the run was stopped and nothing was sent.",
        );
      }
      setConfirmReject(false);
      onDecided?.();
    } catch (e) {
      // Surfaced, never swallowed. A 409 here means the run stopped waiting —
      // it timed out or was cancelled — and the person needs to know their
      // decision did not land rather than assume it did.
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{approval.summary}</p>
          <p className="mt-1 text-xs text-muted">
            step <code>{approval.stepId}</code>
            {approval.createdAt && ` · waiting since ${new Date(approval.createdAt).toLocaleString()}`}
          </p>
        </div>
        {decided ? (
          <Tag>{approval.decision}</Tag>
        ) : (
          <Tag>{isQuestion ? "the agent asked a question" : "waiting for a person"}</Tag>
        )}
      </div>

      {rows && rows.length > 0 && (
        <details className="mt-3 rounded-md border border-line bg-surface-2 p-3" open>
          <summary className="cursor-pointer text-xs text-muted">
            What this will act on — {rows.length} row{rows.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-2 max-h-56 overflow-auto">
            <table className="w-full text-left text-caption">
              <thead className="text-dim">
                <tr>
                  {Object.keys(rows[0]).map((k) => (
                    <th key={k} className="pb-1 pr-3 font-normal uppercase tracking-label">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-muted">
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {Object.keys(rows[0]).map((k) => (
                      <td key={k} className="py-1 pr-3">
                        {r[k] === null || r[k] === undefined ? (
                          <span className="text-dim">—</span>
                        ) : (
                          String(r[k])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {decided && isQuestion && approval.answers ? (
        // What was actually told to the agent. Recorded and shown because it
        // changed what the agent did next — the decision alone does not say what
        // the run was steered towards.
        <div className="mt-3 rounded-md border border-line bg-surface-2 p-3 text-xs">
          <p className="text-dim">What the agent was told</p>
          <ul className="mt-1 space-y-1 text-muted">
            {Object.entries(approval.answers as Record<string, unknown>).map(([k, v]) => (
              <li key={k}>
                <code>{k}</code>: {Array.isArray(v) ? v.join(", ") : String(v)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {decided ? (
        <p className="mt-3 text-xs text-muted">
          {approval.decision} by <strong>{approval.decidedBy}</strong>
          {approval.decidedAt && ` on ${new Date(approval.decidedAt).toLocaleString()}`}
          {approval.note && ` — “${approval.note}”`}
          {!approval.appliedAt && (
            // Recorded but never delivered. Worth surfacing rather than hiding:
            // the decision exists and the run did not act on it.
            <span className="text-danger">
              {" "}
              · recorded, but the engine never received it
            </span>
          )}
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {/* The agent's questions, in its own words. Rendered by kind, because a
              multiple-choice question offered as free text invites an answer the
              agent cannot use. */}
          {isQuestion &&
            questions.map((q) => (
              <div key={q.id} className="rounded-md border border-line bg-surface-2 p-3">
                {q.header && (
                  <p className="text-caption uppercase tracking-label text-dim">{q.header}</p>
                )}
                <p className="text-sm">{q.question}</p>
                {q.kind === "single" && q.options?.length ? (
                  <div className="mt-2 space-y-1">
                    {q.options.map((o) => (
                      <label key={optionValue(o)} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name={`${approval.id}-${q.id}`}
                          checked={answers[q.id] === optionValue(o)}
                          onChange={() => setAnswer(q.id, optionValue(o))}
                        />
                        {optionLabel(o)}
                      </label>
                    ))}
                  </div>
                ) : q.kind === "multi" && q.options?.length ? (
                  <div className="mt-2 space-y-1">
                    {q.options.map((o) => (
                      <label key={optionValue(o)} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={
                            Array.isArray(answers[q.id]) &&
                            (answers[q.id] as string[]).includes(optionValue(o))
                          }
                          onChange={() => toggleMulti(q.id, optionValue(o))}
                        />
                        {optionLabel(o)}
                      </label>
                    ))}
                  </div>
                ) : (
                  <input
                    className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
                    placeholder="Your answer"
                    value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : ""}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                  />
                )}
              </div>
            ))}

          <input
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {/* ⚠ What gets recorded when the box is empty, in the words that will
              actually be stored, and named per button — a default the person
              cannot see is a sentence written into the audit record on their
              behalf. Both are shown because either button may be the next click. */}
          <p className="text-xs text-muted">
            Recorded against <strong>{user?.email ?? "your signed-in account"}</strong>, taken from
            your session — not from this page. There is no undo.
          </p>
          {!note.trim() && (
            <p className="text-xs text-dim">
              Left empty, the note is recorded as “{defaultNote("approved", isQuestion)}” or “
              {defaultNote("rejected", isQuestion)}”, whichever you press.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="danger" onClick={() => setConfirmReject(true)} disabled={busy}>
              {isQuestion ? "Decline" : "Reject"}
            </Button>
            <Button
              onClick={() => decide("approved")}
              disabled={busy || (isQuestion && unanswered.length > 0)}
            >
              {isQuestion ? "Send the answer" : "Approve and continue"}
            </Button>
          </div>
          {isQuestion && unanswered.length > 0 && (
            <p className="text-right text-xs text-muted">
              {unanswered.length} question{unanswered.length === 1 ? "" : "s"} still to answer — a
              partial answer would resume the agent with nothing for the rest.
            </p>
          )}
        </div>
      )}

      <Confirm
        open={confirmReject}
        title={isQuestion ? "Decline to answer?" : "Reject and stop this run?"}
        // Says what happens, not "are you sure". Neither branch is a soft no, and
        // they are not the same act: rejecting a gate kills the whole execution,
        // declining a question stops the agent and fails that one step, which the
        // flow then handles the way it handles any failed step.
        body={
          isQuestion
            ? "Declining stops the agent run and fails this step. The rest of the flow reacts to " +
              "that the way it reacts to any failed step — it does not carry on with an " +
              "unanswered question. The decision is recorded against your signed-in account and " +
              "cannot be changed."
            : "Rejecting stops the run outright — the remaining steps will not execute and nothing " +
              "will be sent. The run cannot be resumed afterwards; it would have to be started again " +
              "from the beginning. The decision is recorded against your signed-in account and cannot " +
              "be changed."
        }
        danger
        confirmLabel={isQuestion ? "Decline and stop the agent" : "Reject and stop"}
        onConfirm={() => decide("rejected")}
        onClose={() => setConfirmReject(false)}
      />
    </div>
  );
}
