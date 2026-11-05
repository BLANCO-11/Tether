// src/components/flow/TestWorkbenchPanel.tsx — inline test drawer for the builder.
//
// The "What this run needs" inputs live in a fixed right-anchored drawer on the
// builder page. The builder owns the run (streaming + canvas overlay); this
// panel collects input values and calls `run(values)`. Extracted from the
// deleted `/flows/:id/test` page.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE SOURCE PICKER AND THE REAL-DATA GATE ARE DELETED — 2026-09-04
// ─────────────────────────────────────────────────────────────────────────────
//
// They read as the safety feature of this screen. They were not one. Measured
// before removing, all three parts:
//
//   · `selected` was never sent anywhere. `doRun` called `run(values)`, so
//     "Synthetic data" and "Real data" produced BYTE-IDENTICAL requests. The
//     only thing the picker did was refuse to run until you clicked a card.
//   · `suppressSending` — a checkbox reading "Suppress sending — do not send
//     email during this test", TICKED BY DEFAULT — was local state read by
//     nothing. You could consent to not sending, and it sent.
//   · "Synthetic data" claimed "datasource schemas and tool outputs, never real
//     data". Zero of the seven registered datasources have a sandbox
//     provisioned, so a draft run reads PRODUCTION either way. Picking the safe
//     card read real employee records; picking the dangerous one made you type
//     `RUN ON REAL DATA` to do exactly the same thing.
//
// ⚠ **A gate that gates nothing is worse than no gate**, because it is where
// people stop looking — the same argument that removed Redis (a healthy
// container is the most convincing possible evidence of a working dependency)
// and the same one behind I-38. Deleting it removes a false claim and a
// ceremony; it removes no protection, because there was none to remove.
//
// ⚠ **What replaces it is a sentence that is true**: a test run reads live data
// and really calls this workflow's tools. Each step then reports which database
// it actually read (`RunResult`, from `flow_step_runs.read_from`), which is a
// fact about the run rather than a promise made before it.
//
// ⚠ **This is not a decision that test runs SHOULD hit production.** It is the
// accurate description of what they do today. The honest version of the deleted
// picker needs two things that do not exist yet: a provisioned sandbox per
// datasource (D-52 — the mechanism is built, no product workspace uses it) and
// a namespace-selected simulation for side-effecting TOOLS (`invokeTool` takes
// no environment at all, where `runNamedQuery` takes draft/live). Until both
// exist, a picker here can only lie.
//
// -----------------------------------------------------------------------------
// REPORTED FROM USE, TWICE -- "no way to hide or remove it"
// -----------------------------------------------------------------------------
//
// There has been a close button in this drawer's header the whole time, and a
// unit test asserting it calls `onClose`. **jsdom performs no layout**, so that
// test can find and click a button a browser has scrolled off the top or
// painted something over -- it is I-38's shape at the one place a person is
// stuck.
//
// Three things changed, and none of them replaces the close button:
//
//   * **The header is `sticky top-0`.** This `<aside>` is its own scroll
//     container, and a run's results are long. Scrolling down to read them took
//     the close button with them, which is exactly "it opens and never goes
//     away".
//   * **Escape closes it.** The one dismissal that needs no target at all.
//   * **It is PORTALLED to `document.body`.** `position: fixed` is not fixed to
//     the viewport inside an ancestor carrying a `view-transition-name` --
//     which `.builder-route` and its mode wrapper both do -- and it is not
//     above an ancestor's stacking context either. The canvas has its own
//     `z-40` click-catcher and a `z-50` expanded overlay; a drawer trapped
//     inside the page tree can lose to both. Out at the body there is nothing
//     to lose to.
//
// WARNING: **No client test can prove any of this**, for the reason at the top
// of this block: jsdom lays nothing out and stacks nothing. What the tests
// below pin is that the controls EXIST and are wired -- the `sticky` class, the
// Escape handler, the backdrop -- which is the checkable half.
"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Confirm } from "@/components/ui/Confirm";
import type { FlowInputDecl, StepRun, FlowExecutionDetail } from "@/lib/types";
import { hintFor, humanLabel } from "@/lib/flow-input-form";
import { TypedInput, formatFor } from "@/components/automation/TypedInput";
import { useAsync } from "@/lib/hooks";
import { flowReadSources } from "@/lib/api";
import { STATUS_LABEL } from "@/lib/canvas-model";

export function TestWorkbenchPanel({
  flowId,
  inputs,
  initialValues,
  testing,
  notice,
  run,
  onClose,
  datasourceRefs,
  result,
  productionOption = true,
}: {
  flowId: string;
  inputs: FlowInputDecl[] | null;
  /**
   * The run this panel started, once the engine has one — `null` before that
   * and between runs.
   *
   * ⚠ **This panel used to take no result at all.** It ran, showed a one-line
   * notice, and that was the whole of the feedback: the outcome existed only as
   * coloured rings on canvas nodes that this drawer was sitting on top of.
   * Reported from use, in exactly those words — *"the test workflow section
   * runs but i dont see any data"*. It was an accurate description of the code.
   */
  result?: FlowExecutionDetail | null;
  // One-off values handed in from the "Before you test" strip (or a deep
  // link): they seed the drawer's inputs once, and the source gate still
  // runs before anything starts. Never carried into a later prefill.
  initialValues?: Record<string, string>;
  testing: boolean;
  notice: string | null;
  /**
   * Start the run. The second argument is the per-run production opt-in —
   * present (and true) only when the person checked the box AND confirmed:
   * the server gates it to admins and audits every use. Absent on the
   * default path, so a mock run is one call with one argument.
   */
  run: (values: Record<string, string>, opts?: { useProductionData: boolean }) => void;
  onClose: () => void;
  /**
   * The `<datasource>.<query>` refs this flow reads, from the model already
   * loaded by the page. Empty is a real answer (a flow that reads nothing);
   * omitted means the caller does not know, and the panel says neither.
   */
  datasourceRefs?: string[];
  /**
   * Whether this surface can run on production at all. A Pi draft run is test-data only (the runner's route takes no
   * such flag), so there the checkbox is NOT drawn — a control the run cannot honour is the old picker's lie again.
   */
  productionOption?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [runError, setRunError] = useState<string | null>(null);
  // Production opt-in: unchecked by default, and checking it alone runs
  // nothing — the run goes through a confirm step first (see below).
  const [useProduction, setUseProduction] = useState(false);
  const [confirmProd, setConfirmProd] = useState(false);

  // Seed the input values from the declared defaults, overlaid once with a
  // handed-in prefill. Keyed on declaration content plus the prefill (not
  // array identity) so a parent re-render with a fresh-but-equal array does
  // not wipe what the person typed.
  const declKey = JSON.stringify((inputs ?? []).map((d) => [d.id, d.defaults ?? ""]));
  const prefillKey = JSON.stringify(initialValues ?? {});
  useEffect(() => {
    if (inputs == null) return;
    setValues({ ...Object.fromEntries(inputs.map((d) => [d.id, d.defaults ?? ""])), ...(initialValues ?? {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declKey, prefillKey]);

  // A derivation IS an answer: the engine resolves it at run creation, so a
  // blank box with `computed` is correct and must not block the run. Typing a
  // value still sends it as that run's override.
  const missing = (inputs ?? []).filter(
    (d) => d.required !== false && d.defaults === undefined && d.computed === undefined && !values[d.id]?.trim(),
  );
  const doRun = useCallback((opts?: { useProductionData: boolean }) => {
    if (inputs === null) {
      setRunError(
        "What this flow expects when it runs could not be read, so a test cannot be started from here.",
      );
      return;
    }
    const stillMissing = (inputs ?? []).filter(
      (d) => d.required !== false && d.defaults === undefined && d.computed === undefined && !values[d.id]?.trim(),
    );
    if (stillMissing.length > 0) {
      setRunError(
        `Give a value for ${stillMissing.map((m) => m.id).join(", ")} — the flow declares ${stillMissing.length === 1 ? "it" : "them"} as required.`,
      );
      return;
    }
    setRunError(null);
    // A blank box on a derived input is correct — the engine resolves it at
    // run creation — so it travels as ABSENT, not as an empty literal that
    // would override the derivation with nothing. Anything typed is an
    // override for that run and is sent.
    const effective = Object.fromEntries(
      Object.entries(values).filter(
        ([id, v]) =>
          v?.trim() !== "" || (inputs ?? []).find((d) => d.id === id)?.computed === undefined,
      ),
    );
    // The default path stays one call with one argument — the override flag
    // travels only when it was checked AND confirmed (see `handleRunAll`).
    if (opts?.useProductionData) run(effective, { useProductionData: true });
    else run(effective);
  }, [inputs, values, run]);

  /**
   * Mock runs go at one click. Production use is the per-run opt-in: it takes
   * the checkbox AND a confirm, because it reads real records and every use is
   * audited. This is a REAL gate — unlike the deleted picker, the flag travels
   * in the request and the server refuses non-admins — not a ceremony.
   */
  const handleRunAll = useCallback(() => {
    if (useProduction) setConfirmProd(true);
    else doRun();
  }, [doRun, useProduction]);

  /**
   * ⚠ **WHAT THIS RUN WILL READ, BEFORE IT RUNS — and it is a READOUT, not the
   * picker that was deleted.**
   *
   * Reported from use: *"I don't see the option for test with real data or
   * synthetic data."* There is no option, and there must not be one: selection
   * is bound to the Kestra namespace (D-52), `stepBatchSchema` has no field for
   * it, and nothing in a request can change it. The old picker's two cards sent
   * byte-identical requests — a choice that was not one, sitting exactly where
   * people stop looking.
   *
   * What was missing is the ANSWER. `RunResult` reports `readFrom` per step
   * afterwards, from the run; this says the same thing before the button, from
   * the datasource. Both are facts and neither is a promise: the namespace has
   * already decided, and this reads its decision out.
   *
   * ⚠ **Three states, and the third is why this is its own `useAsync`.** A list
   * (including an empty one — a flow that reads nothing), or unreadable, which
   * renders as unreadable. Merging it into the inputs read would let a
   * datasource failure empty the input form, and an input failure read as "no
   * datasources".
   */
  const refsKey = (datasourceRefs ?? []).join("|");
  const {
    data: reads,
    error: readsError,
  } = useAsync(
    () => (datasourceRefs ? flowReadSources(datasourceRefs) : Promise.resolve(null)),
    [refsKey, datasourceRefs != null],
  );

  /**
   * Escape closes. Bound on the document rather than on the drawer so it works
   * without the drawer holding focus -- a person who has just clicked the
   * canvas behind it is exactly the person trying to get rid of it.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const panel = (
    <>
      {/*
        A click anywhere outside closes. Deliberately NOT dimmed: this drawer
        sits beside a canvas people read while filling it in, and darkening the
        thing they are testing to make the drawer feel modal would trade one
        obstruction for another. It is a click target, not a scrim.
      */}
      <div
        aria-hidden
        onClick={onClose}
        data-testid="test-panel-backdrop"
        className="fixed inset-0 z-[59]"
      />
    <aside
      aria-label="Test workflow"
      data-flow-id={flowId}
      className="fixed inset-y-0 right-0 z-[60] w-[min(92vw,420px)] overflow-y-auto border-l border-line depth-7"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-surface px-4 py-3">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted">Test</p>
          <h2 className="text-sm font-semibold text-text">Test workflow</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close test panel"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line/60 bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          ✕
        </button>
      </div>

      <div className="space-y-4 px-4 py-4">
        <section className="rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h3 className="text-sm font-semibold text-text">What this run needs</h3>
            {inputs != null && inputs.length > 0 && (
              <span className="text-xs text-muted">
                {inputs.length} input{inputs.length === 1 ? "" : "s"} declared
              </span>
            )}
          </div>
          <div className="space-y-3 px-4 py-4">
            {inputs === undefined && <p className="text-sm text-muted">Reading what this workflow expects…</p>}
            {inputs === null && (
              <p className="rounded border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
                What this workflow expects when it runs could not be read, so a test cannot be
                started from here.
              </p>
            )}
            {inputs != null && inputs.length === 0 && (
              <p className="text-sm text-muted">This workflow declares no inputs. It can run as it is.</p>
            )}
            {(inputs ?? []).map((d) => (
              <Field key={d.id} label={humanLabel(d)} hint={d.computed !== undefined && !d.description?.trim() ? "derived when the run starts" : hintFor(d)}>
                <TypedInput
                  id={d.id}
                  input={{ ...d, format: formatFor(d) }}
                  value={values[d.id] ?? ""}
                  onChange={(next) => setValues((v) => ({ ...v, [d.id]: next }))}
                  // ⚠ The ID, not the label, and deliberately: this is the name
                  // the flow's expressions use and the name the engine puts in
                  // an error, so it is what someone reading a failure needs to
                  // match against. The visible label is the human half.
                  ariaLabel={d.id}
                />
              </Field>
            ))}
            {missing.length > 0 && (
              <p className="text-xs text-warn">
                {missing.map((m) => m.id).join(", ")} still needed before this can run.
              </p>
            )}
          </div>
        </section>

        <div className="flex flex-col gap-3 border-t border-line pt-4">
          {/* ⚠ **THE SENTENCE THAT USED TO BE HERE WAS A HARDCODED CLAIM AND IT
              WAS NOT TRUE.** It read *"This will not send email. Step 10 runs
              against a mock mailbox"* — on every flow, whatever its steps, in
              both source modes. It came from the design pack's flagship example
              and named a step number no other flow has. On a real-data run
              against a tool that really delivers, it was a false reassurance
              printed directly above the button that does the thing. What
              replaces it says only what is true of every run: the effects are
              real, and which database was read is reported per step afterwards
              (`RunResult`), from the run rather than from configuration. */}
          {/*
            ⚠ **THE TOOL HALF IS UNCHANGED AND MUST STAY FIRST.** Sandboxing the
            READS changes nothing about the SENDS: `POST /api/steps/tool` never
            calls `envForExecution`, so a draft run really delivers. Leading
            with "synthetic data" and mentioning the tools second would read as
            "this run is safe", which is exactly the false reassurance the
            deleted hardcoded sentence gave.
          */}
          <p className="flex items-start gap-2 text-xs text-muted">
            <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted" aria-hidden />
            <span>
              A test run really calls this workflow&apos;s tools, so whatever they do, happens.
            </span>
          </p>

          {readsError && (
            <p className="flex items-start gap-2 text-xs text-warn">
              <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden />
              <span>
                Which database this run will read could not be checked ({readsError}), so it is not
                known whether it reads a synthetic copy or the real one.
              </span>
            </p>
          )}

          {reads && reads.length > 0 && (
            <ul className="space-y-1.5" data-testid="test-reads">
              {reads.map((r) => (
                <ReadSourceRow key={r.name} source={r} />
              ))}
            </ul>
          )}

          <p className="text-xs text-muted">Each step reports below which data it read.</p>
          {/* The per-run production opt-in. Unchecked by default; checking it
              alone starts nothing — the run goes through a confirm first, and
              the flag travels in the request where the server gates it to
              admins and audits every use. */}
          {productionOption && (
          <label className="flex cursor-pointer items-start gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={useProduction}
              onChange={(e) => setUseProduction(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Use production data for this run. Off means mock data — a refused
              mock refuses the run rather than reading production.
            </span>
          </label>
          )}
          {useProduction && (
            <p className="rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn">
              With this checked the run reads production records instead of
              test data, and every read is audited. Confirm on the next step.
            </p>
          )}
          <Button variant="primary" onClick={handleRunAll} disabled={testing}>
            {testing ? "Running…" : "Run all"}
          </Button>
          <Confirm
            open={confirmProd}
            title="Read production data?"
            body="This test run will read real records from the workspace databases — not the mock copy — and every read is audited. Mock runs refuse rather than fall back; this is the only way a test reads production."
            confirmLabel="Run on production"
            danger
            onConfirm={() => {
              setConfirmProd(false);
              doRun({ useProductionData: true });
            }}
            onClose={() => setConfirmProd(false)}
          />
          {notice && (
            <p data-testid="test-panel-notice" role="status" className="text-xs text-muted">
              {notice}
            </p>
          )}
          {runError && (
            <Notice tone="danger" title="Test run failed">
              {runError}
            </Notice>
          )}
          <RunResult result={result ?? null} />
        </div>
      </div>

    </aside>
    </>
  );

  /**
   * Rendered at the body, not in place. See the block at the top of this file:
   * a `fixed` element inside an ancestor with a `view-transition-name` is fixed
   * to that ancestor, not to the viewport. `typeof document` guards the server
   * render -- this component is only ever mounted in a client tree, but a
   * portal called during SSR throws rather than degrading.
   */
  if (typeof document === "undefined") return panel;
  return createPortal(panel, document.body);
}
/**
 * One row of "what this run will read", from the datasource's mock status.
 *
 * ⚠ A draft run reads MOCK data or refuses (`runMockBatch`); production is read only through the opt-in checkbox below.
 * So no branch here may say "reads real records". The old fallback did, for a datasource with no mock data at all — the
 * one case where the server REFUSES — which warned about the opposite of what was about to happen.
 */
function ReadSourceRow({ source: r }: { source: {
  name: string;
  mockStatus?: "building" | "ready" | "failed" | "none" | null;
  mockError?: string | null;
} }) {
  const row = (dot: string, tone: string, body: ReactNode) => (
    <li className="flex items-start gap-2 text-xs">
      <span aria-hidden className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className={tone}>
        <span className="font-mono">{r.name}</span> — {body}
      </span>
    </li>
  );
  switch (r.mockStatus) {
    case "ready":
      return row("bg-ok", "text-muted", <>reads <strong>mock data</strong>, a synthetic copy of the schema, not the real database.</>);
    case "building":
      return row("bg-warn", "text-warn", <>mock data is still building, so this run <strong>refuses</strong> until it lands.</>);
    case "failed":
      return row("bg-danger", "text-danger", <>mock data failed to build{r.mockError ? `: ${r.mockError}` : ""}, so this run <strong>refuses</strong>.</>);
    case "none":
      return row("bg-danger", "text-danger", <>has <strong>no mock data</strong>, so this run <strong>refuses</strong>. Build it on the data source page first.</>);
    default:
      return row("bg-warn", "text-warn", <>whether mock data exists could not be checked, so this run may refuse. It never falls back to the real database.</>);
  }
}
/**
 * WHAT THE RUN ACTUALLY DID — the half this panel was missing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **Every value here is READ from the run, and there is nowhere to put an
 * invented one.** A step shows the status the engine reported, the failure
 * reason it gave, and — for a step that produced rows — how many. Where a value
 * is absent it is absent: no "0 rows" standing in for "did not run", because
 * those are different answers and this panel exists to tell them apart.
 *
 * ⚠ **A step that never ran is SHOWN, not omitted.** On a branching flow the
 * steps in the arm that did not fire are exactly what a person is trying to
 * see, and a list of only the tasks that executed silently answers a different
 * question. `not started` is the honest word for it (`STATUS_LABEL`, the one
 * place those words live, so this panel and the canvas cannot disagree).
 */
function rowCountOf(s: StepRun): number | null {
  const out = s.output as { results?: unknown[] } | null;
  return Array.isArray(out?.results) ? out.results.length : null;
}

function RunResult({ result }: { result: FlowExecutionDetail | null }) {
  if (!result) return null;
  // ⚠ `engineStatus`, never `status` (D-13). Foundry's own row is written by the
  // flow's `complete` task, so a failed run stays `running` there for ever — a
  // panel reading it would show a failed test as still going.
  const state = result.engineStatus;
  const steps = result.steps ?? [];
  const failed = steps.filter((s) => s.status === "failed");

  return (
    <section data-testid="test-run-result" className="rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold text-text">What happened</h3>
        <span className="text-xs text-muted">{STATUS_LABEL[state] ?? state}</span>
      </div>
      <div className="space-y-2 px-4 py-3">
        {result.engineUnavailable && (
          /* The run is real; the engine's view of it could not be read. Saying
             so beats an empty list, which reads as "it did nothing". */
          <p className="rounded border border-warn-line bg-warn-bg px-3 py-2 text-xs text-warn">
            The engine could not be reached for the step-by-step view, so only the
            summary above is known. {result.engineUnavailable}
          </p>
        )}
        {steps.length === 0 && !result.engineUnavailable && (
          <p className="text-sm text-muted">No steps have been reported for this run yet.</p>
        )}
        {steps.map((s) => {
          const rows = rowCountOf(s);
          const empty = result.noRows?.find((x) => x.stepId === s.stepId);
          return (
            <div key={`${s.stepId}:${s.attempt}`} className="rounded border border-line/60 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-xs text-text">{s.stepId}</span>
                <span className="shrink-0 text-[11px] text-muted">
                  {STATUS_LABEL[s.status] ?? s.status}
                  {s.durationMs != null ? ` · ${s.durationMs}ms` : ""}
                </span>
              </div>
              {(s.ref || rows != null || s.readFrom) && (
                <p className="mt-0.5 text-[11px] text-dim">
                  {[
                    s.ref,
                    rows != null ? `${rows} row${rows === 1 ? "" : "s"}` : null,
                    // ⚠ Stated on the step, never inferred. `production` on a
                    // draft run means this test just read real data (D-52).
                    s.readFrom ? `read ${s.readFrom}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {s.error && (
                <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-danger">{s.error}</p>
              )}
              {empty && (
                /* I-301 C: valid, green, and empty — a filter compared with a value the column never holds looks exactly like
                   this. Stated, never called a failure: only the person knows whether nothing is the right answer. */
                <p data-testid="step-no-rows" className="mt-1 text-[11px] text-warn">
                  This step {empty.note}. If you expected some, check the values it compares with.
                </p>
              )}
            </div>
          );
        })}
        {failed.length > 0 && (
          <p className="text-[11px] text-muted">
            {failed.length} step{failed.length === 1 ? "" : "s"} failed. The reason above is the
            engine&apos;s own.
          </p>
        )}
        <a
          href={`/runs/${result.id}`}
          className="inline-block pt-1 text-xs text-accent underline underline-offset-2"
        >
          Open the full run
        </a>
      </div>
    </section>
  );
}
