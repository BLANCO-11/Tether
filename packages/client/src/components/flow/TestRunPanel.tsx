"use client";

import { useEffect, useRef, useState } from "react";
import type { FlowInputDecl, Status } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { StatusPill } from "@/components/ui/Badge";

type LastRun = {
  engineStatus: string | null;
  revision: number | null;
  startedAt: string | null;
};

function initialValues(inputs: FlowInputDecl[] | null): Record<string, string> {
  return Object.fromEntries((inputs ?? []).map((input) => [input.id, input.defaults ?? ""]));
}

/** Collects values for one draft test run and follows the current revision. */
export function TestRunPanel({
  inputs,
  busy,
  onRun,
  lastRun,
}: {
  inputs: FlowInputDecl[] | null;
  busy: boolean;
  onRun: (values: Record<string, string>) => void;
  lastRun: LastRun | null;
}) {
  // A saved default or canvas edit creates a new declaration while this page
  // stays mounted. Reset only when that declaration changes: normal parent
  // rerenders preserve typing, but stale fields from the old revision do not.
  const inputSignature = JSON.stringify(inputs);
  const previousInputSignature = useRef(inputSignature);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(inputs));
  useEffect(() => {
    if (previousInputSignature.current === inputSignature) return;
    previousInputSignature.current = inputSignature;
    setValues(initialValues(inputs));
  }, [inputSignature, inputs]);

  if (inputs === null) {
    return (
      <div className="rounded-lg border border-warn/40 bg-warn-bg px-4 py-3 text-body text-warn">
        Could not read what this flow expects when it runs, so a test run cannot be started from
        here. Reload the page; if it persists, the draft revision could not be read.
      </div>
    );
  }

  const missing = inputs.filter(
    (input) => input.required !== false && input.defaults === undefined && !values[input.id]?.trim(),
  );

  return (
    <section className="pane space-y-3 p-4">
      <h2 className="text-body font-semibold text-text">Test run</h2>

      <div className="flex flex-wrap items-center gap-2">
        {lastRun ? (
          <>
            <StatusPill status={engineTone(lastRun.engineStatus)}>
              {lastRun.engineStatus ?? "started"}
            </StatusPill>
            <span className="text-xs text-muted">
              last run{lastRun.revision != null ? ` v${lastRun.revision}` : ""}
              {lastRun.startedAt ? ` · ${new Date(lastRun.startedAt).toLocaleString()}` : ""}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted">
            No runs yet — a successful run is gate 1 to approval.
          </span>
        )}
      </div>

      <p className="text-caption text-dim">
        Runs against the draft namespace — no schedule is deployed, and nothing can be armed until
        one has succeeded.
      </p>

      {inputs.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {inputs.map((input) => (
            <Field
              key={input.id}
              label={input.id}
              hint={`${input.type}${input.required === false ? " · optional" : " · required"}`}
            >
              <Input
                className="w-64"
                value={values[input.id] ?? ""}
                placeholder={input.defaults ?? (input.type === "STRING" ? "2026-06" : "")}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [input.id]: event.target.value }))
                }
                aria-label={`Test value for ${input.id}`}
              />
            </Field>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={busy || missing.length > 0}
          onClick={() =>
            onRun(
              Object.fromEntries(
                Object.entries(values).filter(([, value]) => value.trim() !== ""),
              ),
            )
          }
        >
          {busy ? "Starting…" : "Run test"}
        </Button>
        {missing.length > 0 && (
          <span className="text-xs text-muted">
            {missing.map((input) => input.id).join(", ")} {missing.length === 1 ? "is" : "are"}{" "}
            required — the engine refuses the run without {missing.length === 1 ? "it" : "them"}.
          </span>
        )}
      </div>
    </section>
  );
}

export function engineTone(status: string | null): Status {
  if (status === "success") return "ok";
  if (status === "failed") return "danger";
  if (status === "warning") return "warn";
  return "neutral";
}
