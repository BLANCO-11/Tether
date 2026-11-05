// src/app/(app)/live/page.tsx — the approved automations, runnable now.
// User directive 2026-08-13: a page for LIVE runnable approved workflows.
//
// ── What "live" means here, in words ────────────────────────────────────────
//
// A flow appears on this page only when it has an ARMED revision — gate 2 has
// approved it and the live namespace carries it. "Run now" fires that approved
// revision through the trigger path (`POST …/triggers/:tid/fire`), never the
// draft: the whole point of the page is that what runs is what was approved.
//
// Inputs: a fire's inputs travel WITH the fire as per-fire values, never onto
// the trigger and never from an attacker-controlled body (webhook contract,
// trigger.service.ts fireFlow). Run-now sends the form's values in the fire
// request itself — the run's audit row says `firedBy: "manual"` exactly like a
// hand-started trigger would, and the trigger's stored config is untouched.
//
// Honesty rules: run statuses are words, never invented colours; a flow with no
// manual trigger gets one created on first Run-now (recorded on the flow's
// triggers, visible on its page); nothing here fabricates a schedule.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { FlowStatusPill } from "@/components/flow/FlowStatusPill";
import { useToast } from "@/lib/toast";
import { isRunningUnattended } from "@/lib/flow-views";
import { describeCron } from "@/lib/cron";
import {
  createTrigger,
  getFlowReview,
  listFlowExecutions,
  listFlowTriggers,
  listFlows,
} from "@/lib/api";
import { FireTriggerDialog } from "@/components/automation/FireTriggerDialog";
import { foundryApi, resolveWorkspaceId } from "@/lib/foundry-client";
import { Play, Bolt } from "@/components/ui/icons";
import type { FlowExecutionSummary, FlowInputDecl, FlowSummary, Trigger } from "@/lib/types";

/** How a run's outcome reads — words, per the honesty rules. */
function runWord(e: FlowExecutionSummary): string {
  return e.engineStatus ?? e.status;
}

function relative(iso?: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function LiveWorkflowsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [triggers, setTriggers] = useState<Record<string, Trigger[]>>({});
  const [inputsByFlow, setInputsByFlow] = useState<Record<string, FlowInputDecl[]>>({});
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [runsByFlow, setRunsByFlow] = useState<Record<string, FlowExecutionSummary | undefined>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [firing, setFiring] = useState<{ flow: FlowSummary; trigger: Trigger } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await listFlows();
      /**
       * ⚠ **`isRunningUnattended`, NEVER `armedRevision != null`.** `revoke`
       * removes the Kestra trigger and closes every approval row, then leaves
       * `armed_revision` set as the record of what WAS live — so the old filter
       * listed turned-off automations on a page titled "Live workflows", beside
       * a Run control. Same defect as the `/flows` list's arm switch; one
       * predicate, so fixing it there fixes it here. See `lib/flow-views.ts`.
       */
      const live = all.filter(isRunningUnattended);
      setFlows(live);
      const [trigs, execs] = await Promise.all([
        Promise.all(live.map((f) => listFlowTriggers(f.id))),
        listFlowExecutions(200),
      ]);
      const tMap: Record<string, Trigger[]> = {};
      live.forEach((f, i) => (tMap[f.id] = trigs[i] ?? []));
      setTriggers(tMap);
      const rMap: Record<string, FlowExecutionSummary | undefined> = {};
      for (const e of execs) {
        if (e.flowId && !rMap[e.flowId] && e.status !== "running") rMap[e.flowId] = e;
      }
      setRunsByFlow(rMap);
      // Declared inputs come from the flow's own model (draft revision mirrors
      // the approved one's declared inputs).
      const iMap: Record<string, FlowInputDecl[]> = {};
      const vMap: Record<string, Record<string, string>> = {};
      await Promise.all(
        live.map(async (f) => {
          try {
            const review = await getFlowReview(f.id, f.armedRevision ?? f.draftRevision);
            const model = review.model as { inputs?: FlowInputDecl[] } | null;
            const decls = model?.inputs ?? [];
            iMap[f.id] = decls;
            const init: Record<string, string> = {};
            for (const d of decls) init[d.id] = d.defaults ?? "";
            vMap[f.id] = init;
          } catch {
            iMap[f.id] = [];
            vMap[f.id] = {};
          }
        }),
      );
      setInputsByFlow(iMap);
      setValues(vMap);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const manualTriggerFor = (t: Trigger[] | undefined): Trigger | undefined =>
    t?.find((x) => x.kind === "manual");

  /**
   * Run now — the values go WITH the fire, never onto the trigger.
   *
   * The form above is what the person wants this run to use; the fire request
   * carries it as per-fire inputs. A trigger that declares no inputs fires
   * directly. Either way the trigger's stored config is untouched — the old
   * set-then-fire rewrote shared state for a one-off run.
   */
  const runNow = useCallback(
    async (flow: FlowSummary) => {
      setError(null);
      try {
        let manual = manualTriggerFor(triggers[flow.id]);
        if (!manual) {
          const created = await createTrigger({
            name: `${flow.name} — run now`,
            type: "manual",
            config: {},
            flowId: flow.id,
          });
          manual = created;
          setTriggers((t) => ({ ...t, [flow.id]: [...(t[flow.id] ?? []), created] }));
        }
        if ((manual.declaredInputs ?? []).length > 0) {
          // The sheet runs it; the button never goes busy behind the dialog.
          setFiring({ flow, trigger: manual });
          return;
        }
        setBusy((b) => ({ ...b, [flow.id]: true }));
        const ws = await resolveWorkspaceId();
        const fired = await foundryApi.fireTrigger(ws, flow.id, manual.id);
        if (fired.started) {
          toast.success(`${flow.name} — run started.`);
        } else {
          setError(
            fired.error ??
              "the run did not start — check the flow's approval state and trigger on its page.",
          );
        }
        // Refresh the run list; the new run appears when its begin task lands.
        setTimeout(() => void load(), 2500);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy((b) => ({ ...b, [flow.id]: false }));
      }
    },
    [triggers, load, toast],
  );

  return (
    <>
      <Page>
      <PageHeader
        eyebrow="Run"
        title="Live workflows"
        purpose="Approved automations, ready to run. Running one fires the approved revision — the draft is never touched."
      />

      {error && (
        <Zone name="notices">
          <Notice tone="danger" title="That did not go through">
            {error}
          </Notice>
        </Zone>
      )}

      <Zone name="content">
        {loading ? (
          <div className="space-y-3">
            <Skeleton rows={3} />
            <Skeleton rows={3} />
          </div>
        ) : flows.length === 0 ? (
          <EmptyState
            icon={<Play s={16} />}
            title="No live workflows yet — a flow becomes live when its revision is approved after a successful test run."
            action={
              <Link href="/flows" className="text-sm text-accent hover:underline">
                Review your automations
              </Link>
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {flows.map((flow) => {
              const last = runsByFlow[flow.id];
              const trigs = triggers[flow.id] ?? [];
              const schedule = flow.schedule ?? trigs.find((t) => t.kind === "poll")?.name;
              return (
                <section key={flow.id} className="pane flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/flows/${flow.id}`}
                        className="block truncate text-body font-semibold text-text hover:text-accent"
                      >
                        {flow.name}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <FlowStatusPill status={flow.status} />
                        <span className="text-xs text-muted">
                          armed revision v{flow.armedRevision}
                        </span>
                      </div>
                    </div>
                    <Bolt s={16} className="mt-1 shrink-0 text-dim" />
                  </div>

                  <p className="text-xs text-muted">
                    {trigs.length === 0
                      ? "No trigger yet — Run now adds a hand-start trigger."
                      : trigs
                          .map((t) => {
                            if (t.kind === "poll") return schedule ? `polls ${schedule}` : "polls";
                            return t.kind === "manual" ? "started by hand" : t.kind;
                          })
                          .join(" · ")}
                    {schedule && trigs.some((t) => t.kind !== "poll") ? (
                      <>
                        {" · "}
                        {describeCron(schedule) ?? "scheduled"}
                      </>
                    ) : null}
                  </p>

                  <div className="flex items-center justify-between rounded-md border border-line bg-bg px-3 py-2">
                    <span className="text-xs text-muted">
                      last run:{" "}
                      <span className="text-text">
                        {last ? runWord(last) : "never run"}
                      </span>
                      {last ? ` · ${relative(last.startedAt)}` : ""}
                    </span>
                    {last && (
                      <Link
                        href={`/runs/${last.id}`}
                        className="text-xs text-accent hover:underline"
                      >
                        see the run
                      </Link>
                    )}
                  </div>

                  {(inputsByFlow[flow.id] ?? []).length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(inputsByFlow[flow.id] ?? []).map((d) => (
                        <Field key={d.id} label={d.id}>
                          <Input
                            value={values[flow.id]?.[d.id] ?? ""}
                            onChange={(e) =>
                              setValues((v) => ({
                                ...v,
                                [flow.id]: { ...(v[flow.id] ?? {}), [d.id]: e.target.value },
                              }))
                            }
                            placeholder={d.required ? "required" : "optional"}
                          />
                        </Field>
                      ))}
                    </div>
                  )}

                  <div className="mt-auto">
                    <Button
                      size="sm"
                      onClick={() => void runNow(flow)}
                      disabled={!!busy[flow.id]}
                      className="w-full"
                    >
                      {busy[flow.id] ? "Starting…" : "Run now"}
                    </Button>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </Zone>
    </Page>
      {firing && (
        <FireTriggerDialog
          key={firing.trigger.id}
          trigger={firing.trigger}
          initial={values[firing.flow.id]}
          open
          onClose={() => setFiring(null)}
          onFired={() => {
            setFiring(null);
            toast.success(`${firing.flow.name} — run started.`);
            setTimeout(() => void load(), 2500);
          }}
        />
      )}
    </>
  );
}
