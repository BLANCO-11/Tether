"use client";

import type { StepCheck, StepRun } from "@/lib/types";
import { RunOutput } from "@/components/flow/RunOutput";

/**
 * What one step was given, what it returned and what it printed — the three things a person needs to see WHY a
 * step's output is what it is (a test default outside the data, a filter that matched nothing), not only THAT it ran.
 *
 * Each part renders only when the run recorded it. An absent part draws nothing, never a placeholder value: an
 * engine run retains no task inputs, and "given nothing" and "nobody recorded what it was given" are different claims.
 */
export function StepEvidence({ step }: { step: StepRun }) {
  const given = [
    ...Object.entries(step.input?.params ?? {}).map(([k, v]) => ({ k, v, from: "param" })),
    ...Object.entries(step.input?.inputs ?? {}).map(([k, v]) => ({ k, v, from: "input" })),
  ];
  const said = step.outcome ? OUTCOME_SAYS[step.outcome] : undefined;
  return (
    <div className="space-y-3">
      {said && (
        <p className="text-xs text-muted">
          <span className="font-medium text-text">{said}</span>
          {step.reason ? ` — ${step.reason}` : ""}
        </p>
      )}
      {given.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-label text-muted">Given</h4>
          <dl className="divide-y divide-line rounded-md border border-line text-xs">
            {given.map(({ k, v, from }) => (
              <div key={`${from}:${k}`} className="flex items-start justify-between gap-4 px-3 py-1.5">
                <dt className="shrink-0 text-dim">
                  {k} <span className="text-caption text-dim">· {from}</span>
                </dt>
                <dd className="min-w-0 truncate font-mono text-text" title={preview(v, 2000)}>
                  {preview(v, 160)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {step.error && <p className="whitespace-pre-wrap font-mono text-xs text-danger">{step.error}</p>}
      {step.checks && step.checks.length > 0 && <Checks checks={step.checks} />}
      {step.output && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-label text-muted">Output</h4>
          <RunOutput output={step.output} />
        </div>
      )}
      {step.logs.length > 0 && (
        <details className="rounded-md border border-line bg-surface-2">
          <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-muted">
            Printed · {step.logs.length} line{step.logs.length === 1 ? "" : "s"}
          </summary>
          <pre className="max-h-64 overflow-auto px-3 pb-2 font-mono text-xs text-text">
            {step.logs.map((l) => l.message).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * The runner's own outcomes that the shared status cannot say (P5/P7): "skipped" covers both "the other side of a
 * choice" and "never reached because something failed", and "cancelled" both a rejection and an expiry.
 */
const OUTCOME_SAYS: Record<string, string> = {
  not_taken: "Not taken",
  skipped: "Not run",
  waiting: "Waiting for approval",
  partial: "Some items failed",
  rejected: "Rejected",
  expired: "Expired — nobody decided in time",
};

/** A value as one line. An array says how many items it holds — its contents are the previous step's output. */
function preview(v: unknown, max: number): string {
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}${v.length ? ` · ${JSON.stringify(v[0]).slice(0, 80)}…` : ""}`;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const CHECK_TONE: Record<StepCheck["verdict"], string> = {
  failed: "text-danger",
  partial: "text-warn",
  allowed: "text-muted",
  ok: "text-ok",
};

/**
 * What the run checked in this step's output (flow-runner checks.py): every output, and every field that came back
 * empty in some or all rows — failed, allowed by the step (with the step's reason), or partly empty.
 */
function Checks({ checks }: { checks: StepCheck[] }) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-label text-muted">Checked</h4>
      <ul className="divide-y divide-line rounded-md border border-line text-xs">
        {checks.map((c, i) => (
          <li key={i} className={`px-3 py-1.5 ${CHECK_TONE[c.verdict] ?? "text-danger"}`}>
            {checkLine(c)}
            {c.verdict === "allowed" && c.reason ? <span className="text-dim"> — {c.reason}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function checkLine(c: StepCheck): string {
  const what = c.field ? `${c.output}.${c.field}` : c.output;
  if (c.verdict === "ok") return `${what}: has data${typeof c.rows === "number" ? ` · ${c.rows} row${c.rows === 1 ? "" : "s"}` : ""}`;
  const amount = c.field ? `empty in ${c.empty} of ${c.rows} rows` : "empty";
  if (c.verdict === "failed") return `${what}: ${amount} — not allowed by the step`;
  if (c.verdict === "allowed") return `${what}: ${amount} — allowed by the step`;
  return `${what}: ${amount}`;
}
