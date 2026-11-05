"use client";

import { useMemo, useState, type ReactNode } from "react";
import { PiFlowCanvas } from "./PiFlowCanvas";
import { StepPanel, type PanelTab } from "@/components/flow/builder/StepPanel";
import { InspectorSection } from "@/components/flow/builder/InspectorSection";
import { canvasFromRawModel, withEnd, withStart, startInputsFrom, START_ID, END_ID, type CanvasFrame, type CanvasGraph } from "@/lib/canvas-model";
import { allNodes, allSteps, kindOf, type PiCondition, type PiStep, type PiWorkflow } from "@/lib/pi-builder";
import type { FlowInputDecl } from "@/lib/types";

/** The run-time types a Pi input declares → the form/Start-node vocabulary the rest of the client uses. */
const INPUT_TYPE: Record<string, string> = { string: "STRING", integer: "INT", number: "FLOAT", boolean: "BOOLEAN", date: "DATE" };

/**
 * A Pi workflow's declared inputs as the test form and the Start node read them. An input with no default is
 * required; a default travels as text, the way the form edits it (the server coerces back to the declared type).
 * An undeclared type is passed through as written, never defaulted to STRING — the form then says it cannot tell.
 */
export function piInputDecls(workflow: PiWorkflow): FlowInputDecl[] {
  return Object.entries(workflow.inputs ?? {}).map(([id, d]) => ({
    id,
    type: INPUT_TYPE[String(d?.type)] ?? String(d?.type ?? "unknown type"),
    ...(d && "default" in d && d.default !== undefined ? { defaults: String(d.default) } : {}),
    required: !(d && "default" in d),
    ...(d?.description ? { description: d.description } : {}),
  }));
}

const OP_WORD: Record<string, string> = { eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "is one of", contains: "contains" };

/** A declared condition in words — the label on its path. */
export function conditionText(c: PiCondition | undefined): string {
  if (!c) return "";
  if ("all" in c) return c.all.map(conditionText).join(" and ");
  if ("any" in c) return c.any.map(conditionText).join(" or ");
  if ("not" in c) return `not (${conditionText(c.not)})`;
  const to = "to" in c ? (typeof c.to === "string" ? c.to : JSON.stringify(c.to)) : "";
  if (c.op === "empty") return `${c.value} is empty`;
  if (c.op === "not_empty") return `${c.value} is not empty`;
  return `${c.value} ${OP_WORD[c.op] ?? c.op} ${to}`;
}

type RawRow = {
  id: string;
  kind: "code" | "branch" | "approval" | "for_each";
  code?: string;
  inputExpr?: string;
  outputKeys?: string[];
  dependsOn?: string[];
  elseOf?: string;
  conditionExpr?: string;
};

/**
 * Forge's workflow → the raw model the real FlowCanvas draws (pi-runtime P7). Steps are `code` nodes; a loop is its
 * own node with its steps drawn inside a box (a frame); a choice is a branch chain (one node, a handle per path,
 * labelled with the path's condition); an approval is an approval node. Order is the workflow's: each node depends
 * on what ran just before it, a path's first step on its path, and what follows a choice on every path's end.
 */
export function piWorkflowToRawModel(workflow: PiWorkflow): { id: string; steps: RawRow[]; frames: CanvasFrame[] } {
  const rows: RawRow[] = [];
  const frames: CanvasFrame[] = [];
  /** Lay out `nodes` after `after`; returns the ids the next node hangs off. */
  const place = (nodes: PiStep[], after: string[]): string[] => {
    let prev = after;
    for (const n of nodes) {
      const dependsOn = prev.length ? { dependsOn: [...prev] } : {};
      const k = kindOf(n);
      if (k === "loop") {
        rows.push({ id: n.id, kind: "for_each", ...dependsOn });
        const before = rows.length;
        const ends = place(n.steps ?? [], [n.id]);
        frames.push({
          id: n.id,
          label: `For each ${n.as ?? "item"} in ${n.foreach}`,
          members: [n.id, ...rows.slice(before).map((r) => r.id)],
        });
        prev = ends;
      } else if (k === "branch") {
        const arms = n.branch ?? [];
        const armIds = arms.map((a, i) => (i === 0 ? n.id : `${n.id}·${a.else ? "else" : i + 1}`));
        arms.forEach((a, i) =>
          rows.push({
            id: armIds[i]!,
            kind: "branch",
            ...(i === 0 ? dependsOn : { elseOf: armIds[i - 1]! }),
            ...(a.else ? {} : { conditionExpr: conditionText(a.if) }),
          }),
        );
        prev = arms.flatMap((a, i) => place(a.steps ?? [], [armIds[i]!]));
        if (!arms.some((a) => a.else)) prev = [...prev, n.id]; // no path may run: what follows also hangs off the choice
      } else if (k === "approval") {
        rows.push({ id: n.id, kind: "approval", ...dependsOn });
        prev = [n.id];
      } else {
        rows.push({
          id: n.id,
          kind: "code",
          code: `# ${n.entry ?? `steps/${n.id}/main.py`}\n# (body lives in the Pi sandbox)`,
          inputExpr: JSON.stringify({ params: n.params ?? {}, inputs: n.inputs ?? {} }),
          outputKeys: n.outputs?.length ? [...n.outputs] : ["result"],
          ...dependsOn,
        });
        prev = [n.id];
      }
    }
    return prev;
  };
  place(workflow.steps, []);
  return { id: "pi_draft", steps: rows, frames };
}

export function piWorkflowToGraph(workflow: PiWorkflow): CanvasGraph {
  const raw = piWorkflowToRawModel(workflow);
  const drawn = canvasFromRawModel(raw);
  const graph: CanvasGraph = raw.frames.length ? { ...drawn, frames: raw.frames } : drawn;
  // Same Start/End boundaries ChatWorkbench draws (withStart → withEnd).
  const last = workflow.steps[workflow.steps.length - 1];
  // The Start node carries the inputs a person supplies before the run — what every `$input.<name>` reads.
  return withEnd(withStart(graph, startInputsFrom(piInputDecls(workflow))), last ? { stepId: last.id, description: null } : null);
}

export function PiDagCanvas({
  workflow,
  selectedId,
  onSelect,
  flowId,
  files,
}: {
  workflow: PiWorkflow;
  /** The step files, when the caller has them — the inspector shows a step's code read-only. */
  files?: Record<string, string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The saved flow — unused since the canvas lays itself out (kept so callers need not change). */
  flowId?: string | null;
}) {
  const graph = useMemo(() => piWorkflowToGraph(workflow), [workflow]);
  const [panelTab, setPanelTab] = useState<PanelTab>("settings");
  const selected = useMemo(
    () => allNodes(workflow.steps).find((s) => s.id === selectedId) ?? null,
    [workflow, selectedId],
  );
  const boundary = selectedId === START_ID ? "start" : selectedId === END_ID ? "end" : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PiFlowCanvas
        workflow={workflow}
        selectedId={selectedId}
        onSelect={(id, tab) => {
          if (tab === "io") setPanelTab("settings");
          onSelect(id);
        }}
      />
      {boundary ? (
        <StepPanel
          stepId={selectedId!}
          title={boundary === "start" ? "Start" : "End"}
          tab={panelTab}
          onTab={setPanelTab}
          onClose={() => onSelect(null)}
          graph={graph}
        >
          {boundary === "start" ? <PiStartInspector workflow={workflow} /> : <PiEndInspector workflow={workflow} />}
        </StepPanel>
      ) : null}
      {selected ? (
        <StepPanel
          stepId={selected.id}
          title={selected.id}
          tab={panelTab}
          onTab={setPanelTab}
          onClose={() => onSelect(null)}
          graph={graph}
        >
          <PiStepInspector step={selected} workflow={workflow} files={files} />
        </StepPanel>
      ) : null}
    </div>
  );
}

const KIND_WORD: Record<ReturnType<typeof kindOf>, string> = {
  step: "code",
  loop: "for each item",
  branch: "choice (if / else)",
  approval: "approval",
};

/**
 * A binding in plain words (2026-10-11): what a person reads when they click a step, instead of the raw
 * `"$input.week"` / `"find.rows"` / `"$p.level"` spelling. The spelling stays visible beside it.
 */
export function bindingWords(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v);
  const t = v.trim();
  if (t.startsWith("$input.")) return `the run's input "${t.slice(7)}"`;
  if (t === "$index") return "the item's number in the loop";
  const loopRef = /^\$([A-Za-z_]\w*)(?:\.(.+))?$/.exec(t);
  if (loopRef) return loopRef[2] ? `"${loopRef[2]}" of the current ${loopRef[1] === "item" ? "item" : loopRef[1]}` : `the current ${loopRef[1] === "item" ? "item" : loopRef[1]}`;
  const out = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(t);
  if (out) return `"${out[2]}" from ${out[1]}`;
  return JSON.stringify(v);
}

/** The step's own sentence, or a quiet note that it has none (older workflows were built before descriptions). */
function Says({ step }: { step: PiStep }) {
  return step.description ? (
    <p className="px-4 pb-3 text-sm text-text">{step.description}</p>
  ) : (
    <p className="px-4 pb-3 text-xs text-muted">No description — ask Forge to describe this step.</p>
  );
}

function Given({ label, entries }: { label: string; entries: Array<[string, unknown]> }) {
  if (!entries.length) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <ul className="space-y-1 text-xs">
        {entries.map(([k, v]) => (
          <li key={k}>
            <span className="font-mono text-text">{k}</span>
            <span className="text-muted"> ← {bindingWords(v)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Expand({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-xs text-muted hover:text-text">{label}</summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

/** Which part of a step a pane tab shows; absent = all of it. */
export type InspectorSectionKey = "overview" | "io" | "code";

export function PiStepInspector({
  step,
  workflow,
  files,
  section,
}: {
  step: PiStep | null;
  workflow?: PiWorkflow;
  /** The step files (`steps/<id>/main.py` → source), when the caller has them — shown read-only. */
  files?: Record<string, string>;
  section?: InspectorSectionKey;
}) {
  const show = (k: InspectorSectionKey) => !section || section === k;
  if (!step) {
    return <p className="p-4 text-sm text-muted">Select a step on the canvas to see what it does.</p>;
  }
  // What runs before and after it, read off the same model the canvas draws (a path's id → its choice's id).
  const rows = workflow ? piWorkflowToRawModel(workflow).steps : [];
  const base = (id: string) => id.split("·")[0]!;
  const deps = [...new Set((rows.find((r) => r.id === step.id)?.dependsOn ?? []).map(base))];
  const feeds = [...new Set(rows.filter((r) => r.dependsOn?.some((d) => base(d) === step.id)).map((r) => base(r.id)))];
  const kind = kindOf(step);
  const named = (n: PiStep) => n.description ?? n.id;

  if (kind !== "step") {
    const cases = workflow?.cases ?? [];
    const handles = (path: string) => cases.filter((c) => c.path === path).map((c) => c.says);
    return (
      <div className="flex min-h-0 flex-col overflow-y-auto text-sm">
        <InspectorSection title={KIND_WORD[kind][0]!.toUpperCase() + KIND_WORD[kind].slice(1)} open>
          <Says step={step} />
          <div className="space-y-3 px-4 pb-3">
            {kind === "loop" ? (
              <>
                <Row label="Goes over">{bindingWords(step.foreach)}</Row>
                <Row label="Each item is called">
                  <span className="font-mono text-xs">{step.as ?? "item"}</span>
                </Row>
                <Row label="For each item, runs">
                  {(step.steps ?? []).length ? (
                    <ul className="list-disc space-y-0.5 pl-4 text-xs">
                      {(step.steps ?? []).map((n) => (
                        <li key={n.id}>{named(n)}</li>
                      ))}
                    </ul>
                  ) : (
                    "nothing yet"
                  )}
                </Row>
                <p className="text-xs text-muted">
                  Items run one at a time, in order. One item failing does not stop the others. Later steps read its
                  counts: count, succeeded, failed.
                </p>
              </>
            ) : null}
            {kind === "approval" ? (
              <>
                <Row label="Asks">{step.approval?.title ?? ""}</Row>
                {step.approval?.review ? <Row label="Shows the approver">{bindingWords(step.approval.review)}</Row> : null}
                <p className="text-xs text-muted">
                  The run waits here until an approver decides. Approve: everything after it runs. Reject: nothing
                  after it does. A run nobody decides within 7 days stops as expired.
                </p>
              </>
            ) : null}
          </div>
        </InspectorSection>
        {kind === "branch" ? (
          <InspectorSection title="Paths" open count={step.branch?.length ?? 0}>
            <ol className="space-y-3 px-4 pb-3 text-xs">
              {(step.branch ?? []).map((arm, i) => {
                const path = `${step.id}.${arm.else ? "else" : i + 1}`;
                return (
                  <li key={i} className="space-y-1 rounded-md border border-line p-2.5">
                    <div className="text-text">
                      <span className="font-medium text-muted">{arm.else ? "Otherwise" : i === 0 ? "If" : "Else if"}</span>{" "}
                      {arm.else ? null : <span>{conditionText(arm.if)}</span>}
                    </div>
                    {handles(path).map((says) => (
                      <div key={says} className="text-muted">
                        For: <span className="text-text">{says}</span>
                      </div>
                    ))}
                    <div className="text-muted">
                      {(arm.steps ?? []).length ? (
                        <>
                          Runs:{" "}
                          {(arm.steps ?? []).map((n, j) => (
                            <span key={n.id} className="text-text">
                              {j ? ", " : ""}
                              {named(n)}
                            </span>
                          ))}
                        </>
                      ) : (
                        "Runs nothing"
                      )}
                      {arm.set && Object.keys(arm.set).length
                        ? ` · sets ${Object.entries(arm.set).map(([k, v]) => `${k} = ${bindingWords(v)}`).join(", ")}`
                        : ""}
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="px-4 pb-3 text-xs text-muted">Exactly one path runs: the first whose condition holds, otherwise the last.</p>
          </InspectorSection>
        ) : null}
        <PiConnections deps={deps} feeds={feeds} />
      </div>
    );
  }

  const uses = step.uses ?? [];
  const readNames = uses.filter((u) => u.startsWith("read:")).map((u) => u.slice(5));
  const toolNames = uses.filter((u) => u.startsWith("tool:")).map((u) => u.slice(5));
  const entry = step.entry ?? `steps/${step.id}/main.py`;
  const code = files?.[entry];
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto text-sm">
      {show("overview") ? (
        <>
      <InspectorSection title="What it does" open>
        <Says step={step} />
      </InspectorSection>

      <InspectorSection title="Reads" open={readNames.length > 0} count={readNames.length}>
        <div className="space-y-3 px-4 pb-3 text-xs">
          {readNames.length ? (
            readNames.map((name) => {
              const r = workflow?.reads?.[name];
              return (
                <div key={name} className="space-y-1">
                  <div className="font-mono text-text">{name}</div>
                  <div className="text-muted">
                    {r?.ref ? `the saved reader ${r.ref}` : r?.datasource ? `from ${r.datasource}` : "not declared"}
                    {r?.params?.length ? ` · takes ${r.params.map((p) => p.name).join(", ")}` : ""}
                  </div>
                  {r?.sql ? (
                    <Expand label="Show the query">
                      <pre className="max-h-56 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-text whitespace-pre-wrap break-words">{r.sql}</pre>
                    </Expand>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="text-muted">Reads no data.</p>
          )}
        </div>
      </InspectorSection>

      <InspectorSection title="Actions" open={toolNames.length > 0} count={toolNames.length}>
        <div className="px-4 pb-3 text-xs">
          {toolNames.length ? (
            <ul className="space-y-1">
              {toolNames.map((t) => (
                <li key={t} className="font-mono text-text">
                  {t}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">Calls no tools — it only works on what it is given.</p>
          )}
        </div>
      </InspectorSection>
        </>
      ) : null}

      {show("io") ? (
      <InspectorSection title="Given and returns" open>
        <div className="space-y-3 px-4 pb-3 text-xs">
          <Given label="Settings" entries={Object.entries(step.params ?? {})} />
          <Given label="Receives" entries={Object.entries(step.inputs ?? {})} />
          {!Object.keys(step.params ?? {}).length && !Object.keys(step.inputs ?? {}).length ? <p className="text-muted">Given nothing.</p> : null}
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-muted">Returns</div>
            {step.outputs?.length ? (
              <ul className="space-y-0.5 font-mono text-text">
                {step.outputs.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">result</p>
            )}
          </div>
        </div>
      </InspectorSection>
      ) : null}

      {show("overview") ? (
      <InspectorSection title="May be empty" open count={step.allow_empty?.length ?? 0}>
        <div className="px-4 pb-3">
          {step.allow_empty?.length ? (
            <ul className="space-y-1.5 text-xs">
              {step.allow_empty.map((a, i) => (
                <li key={i}>
                  <span className="font-mono text-text">{a.field ? `${a.output}.${a.field}` : a.output}</span>
                  <span className="text-muted"> — {a.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">Nothing. Every run fails this step if an output, or a field in every row, comes back empty.</p>
          )}
        </div>
      </InspectorSection>
      ) : null}

      {show("code") ? (
      <InspectorSection title="Code" open={section === "code"}>
        <div className="px-4 pb-3">
          {code ? (
            <pre className="max-h-96 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-text whitespace-pre">{code}</pre>
          ) : (
            <p className="text-xs text-muted">
              <span className="font-mono">{entry}</span> — the code is not loaded here.
            </p>
          )}
        </div>
      </InspectorSection>
      ) : null}

      {show("overview") ? <PiConnections deps={deps} feeds={feeds} /> : null}
    </div>
  );
}

function PiConnections({ deps, feeds }: { deps: string[]; feeds: string[] }) {
  return (
    <InspectorSection title="Connections" open>
      <div className="space-y-2 px-4 pb-3 text-xs">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Depends on</div>
          {deps.length ? <p className="font-mono text-text">{deps.join(", ")}</p> : <p className="text-muted">nothing upstream</p>}
        </div>
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Feeds</div>
          {feeds.length ? <p className="font-mono text-text">{feeds.join(", ")}</p> : <p className="text-muted">nothing</p>}
        </div>
      </div>
    </InspectorSection>
  );
}

/** Start: what a person is asked before the run, and which step receives each value. */
export function PiStartInspector({ workflow }: { workflow: PiWorkflow }) {
  const inputs = Object.entries(workflow.inputs ?? {});
  const receivers = (name: string) =>
    allSteps(workflow.steps).filter((s) => Object.values({ ...(s.params ?? {}), ...(s.inputs ?? {}) }).some((v) => v === `$input.${name}`)).map((s) => s.id);
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto text-sm">
      <InspectorSection title="Asked before the run" open count={inputs.length}>
        <div className="space-y-3 px-4 pb-3">
          {inputs.length ? (
            inputs.map(([name, d]) => (
              <div key={name} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs text-text">{name}</span>
                  <span className="text-[11px] text-muted">{String(d?.type ?? "unknown type")}</span>
                </div>
                {d?.description ? <p className="text-xs text-muted">{d.description}</p> : null}
                <p className="text-[11px] text-dim">
                  {d && "default" in d ? `Test default: ${JSON.stringify(d.default)}` : "No default — required"}
                  {" · "}
                  {receivers(name).length ? `used by ${receivers(name).join(", ")}` : "no step receives it"}
                </p>
              </div>
            ))
          ) : (
            <p className="text-xs text-muted">Nothing — this workflow asks for no values when it runs.</p>
          )}
        </div>
      </InspectorSection>
    </div>
  );
}

/** End: the last step, and what it hands back — what the workflow returns. */
export function PiEndInspector({ workflow }: { workflow: PiWorkflow }) {
  const last = workflow.steps[workflow.steps.length - 1];
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto text-sm">
      <InspectorSection title="What the run returns" open count={last?.outputs?.length ?? 0}>
        <div className="space-y-2 px-4 pb-3 text-xs">
          {last ? (
            <>
              <Row label="From step" mono>
                {last.id}
              </Row>
              <Row label="Outputs" mono>
                {last.outputs?.length ? last.outputs.join(", ") : "none declared"}
              </Row>
              {last.allow_empty?.length ? (
                <Row label="May be empty">
                  {last.allow_empty.map((a) => `${a.field ? `${a.output}.${a.field}` : a.output} — ${a.reason}`).join("; ")}
                </Row>
              ) : null}
            </>
          ) : (
            <p className="text-muted">No steps yet.</p>
          )}
        </div>
      </InspectorSection>
    </div>
  );
}

function Row({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={mono ? "font-mono text-xs text-text break-all" : "text-text"}>{children}</div>
    </div>
  );
}
