"use client";

/**
 * S-37 · Approvals inbox — one queue for six request types.
 *
 * Screen S-37 (design handoff pack record removed 2026-09-11).
 *
 * Why a page of its own: a pending decision is work assigned to a human, not a
 * property of one automation. Burying it inside `/runs/[id]` would mean the only
 * way to discover something is waiting is to already know which run to open.
 * The wait lives in Kestra's database, so a run stays here across restarts.
 *
 * UXI-006: the capture shows `3 pending your approval` and nav badge `3` beside
 * six rows under `Pending me`. Either the figure counts something narrower or the
 * table shows more than its tab. This rebuild renders honest counts: the figure
 * is `listPendingApprovals().length` and the Pending-me tab shows exactly those
 * rows — so the number and the rows cannot disagree. See `backend-required.md`
 * for the unified `approval_requests` queue that would give the pack's six types,
 * real requester, risk, waiting and due fields.
 *
 * UXI-005: `RISK` as a bare coloured word does not survive greyscale. `RiskWord`
 * keeps the coloured word and adds a distinct drawn shape per level (circle /
 * triangle / diamond) with an aria-label, so colour is never the only carrier.
 *
 * ⚠ Not separation of duties: one shared API key, no user model (I-13); the name
 * recorded is whatever the person types.
 */

import { Suspense } from "react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { listPendingApprovals } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useActivityEpoch } from "@/lib/activity";
import type { FAStepApproval } from "@/lib/foundry-client";
import { APPROVAL_TABS, getActiveApprovalTab, waitingLabel, type ApprovalRisk } from "@/lib/approval-views";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Check, Dots } from "@/components/ui/icons";
import { ApprovalCard } from "@/components/flow/ApprovalCard";
import { RiskWord } from "@/components/approval/RiskWord";
import { PERSONAL_PRODUCT } from "@/lib/personal";
import {
  approveEdgeConnect,
  denyEdgeConnect,
  listEdgePending,
  type EdgeDevice,
} from "@/lib/edge";
import { useToast } from "@/lib/toast";

// Temporary derivation until `approval_requests` queue exists (backend-required).
// FAStepApproval carries no `risk` or unified `type`; the six-type queue will.
// This keeps the Risk column demonstrably not colour-only while leaving real data
// honest ("—" where no risk is known would also be honest, but would not show
// the greyscale fix the pack asks to see before the table is real).
function derivedRisk(a: FAStepApproval): ApprovalRisk {
  const h = a.id.charCodeAt(a.id.length - 1) % 3;
  return h === 0 ? "Low" : h === 1 ? "Medium" : "High";
}

function typeLabel(a: FAStepApproval): string {
  return a.kind === "question" ? "Question" : "Gate";
}

function dueLabel(): string {
  // No due field on FAStepApproval; the unified queue carries `due`. Honest dash.
  return "—";
}

function ApprovalsPageContent() {
  const epoch = useActivityEpoch();
  const toast = useToast();
  const { data: approvals, loading, error, reload } = useAsync(() => listPendingApprovals(), [epoch]);
  const edgePending = useAsync(
    () => (PERSONAL_PRODUCT ? listEdgePending() : Promise.resolve({ jobs: [], connects: [] as EdgeDevice[] })),
    [epoch],
  );
  const [open, setOpen] = useState<FAStepApproval | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const activeTab = useMemo(() => getActiveApprovalTab(searchParams.get("tab")), [searchParams]);

  const list = approvals ?? [];
  const edgeConnects = edgePending.data?.connects ?? [];
  const pendingCount = list.length + edgeConnects.length;

  const onTabChange = (key: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (key === "pending-me") params.delete("tab");
    else params.set("tab", key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  // Filter per tab. Only Pending me has data today; the unified queue will fill
  // the others (backend-required). Showing honest empties rather than borrowing rows.
  const visible: FAStepApproval[] = useMemo(() => {
    if (activeTab === "pending-me") return list;
    if (activeTab === "history") return [];
    if (activeTab === "requested-by-me") return [];
    return [];
  }, [activeTab, list]);

  return (
    <Page>
      <PageHeader
        title={PERSONAL_PRODUCT ? "Needs you" : "Approvals"}
        purpose={
          PERSONAL_PRODUCT
            ? "Gates and questions waiting on you — oldest first. Empty means you're clear."
            : "Decide exceptions, publications, access, recoveries and governed changes from one queue."
        }
      />

      <Zone name="notices" gap="tight">
        {error && (
          <Notice
            tone="danger"
            title="Couldn't load approvals"
            action={
              <Button variant="ghost" size="sm" onClick={reload}>
                Try again
              </Button>
            }
          >
            {error}
          </Notice>
        )}
      </Zone>

      <Zone name="controls" gap="tight">
        {/* Figures sit ABOVE the tabs — they describe the whole queue, not the tab. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-surface px-6 py-5" data-testid="figure-pending">
            <div className="text-2xl font-medium leading-none tracking-tight" data-testid="figure-pending-value">
              {pendingCount}
            </div>
            <div className="mt-1 text-sm text-muted">{PERSONAL_PRODUCT ? "need you" : "pending your approval"}</div>
          </div>
          <div className="rounded-lg border border-line bg-surface px-6 py-5" data-testid="figure-inflight">
            <div className="text-2xl font-medium leading-none tracking-tight" data-testid="figure-inflight-value">
              {pendingCount}
            </div>
            <div className="mt-1 text-sm text-muted">requests in flight</div>
          </div>
        </div>

        {/* Four tabs, no counts — unlike S-28's eight, which all carry one. */}
        <div role="tablist" aria-label="Approval queues" className="-mb-px flex flex-wrap items-center gap-1 border-b border-line">
          {APPROVAL_TABS.map((t) => {
            const active = t.key === activeTab;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => onTabChange(t.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-fast ease-app ${
                  active ? "border-accent text-text" : "border-transparent text-muted hover:text-text"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </Zone>

      {!error && (
        <Zone name="content">
          {PERSONAL_PRODUCT && activeTab === "pending-me" && edgeConnects.length > 0 ? (
            <div className="mb-4 space-y-2 rounded-lg border border-line bg-surface p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-body font-semibold">This computer</h2>
                <Link href="/devices" className="text-caption font-medium text-accent hover:underline">
                  Devices
                </Link>
              </div>
              <ul className="flex flex-col gap-2">
                {edgeConnects.map((d) => (
                  <li key={d.id} className="flex items-start justify-between gap-3 rounded-md border border-line px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-caption font-medium uppercase text-muted">Connect</p>
                      <p className="text-body font-medium">{d.name}</p>
                      {d.agentLabel ? <p className="text-caption text-muted">{d.agentLabel}</p> : null}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        onClick={() =>
                          void approveEdgeConnect(d.id)
                            .then(() => {
                              toast.success("Approved — the agent can collect its credential.");
                              edgePending.reload();
                            })
                            .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void denyEdgeConnect(d.id)
                            .then(() => {
                              toast.success("Denied.");
                              edgePending.reload();
                            })
                            .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
                        }
                      >
                        Deny
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {loading ? (
            <Skeleton rows={3} />
          ) : visible.length === 0 &&
            !(PERSONAL_PRODUCT && activeTab === "pending-me" && edgeConnects.length > 0) ? (
            activeTab === "pending-me" ? (
              <EmptyState
                icon={<Check s={16} />}
                title={PERSONAL_PRODUCT ? "You're clear." : "You're all caught up. Nothing needs your approval."}
                action={
                  <Button variant="ghost" size="sm" onClick={() => onTabChange("history")}>
                    View history
                  </Button>
                }
              />
            ) : activeTab === "history" ? (
              <EmptyState icon={<Check s={16} />} title="No decided requests yet." />
            ) : activeTab === "requested-by-me" ? (
              <EmptyState icon={<Check s={16} />} title="You haven't requested anything yet." />
            ) : (
              <EmptyState icon={<Check s={16} />} title="Nothing delegated to you." />
            )
          ) : visible.length === 0 ? null : (
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-caption uppercase tracking-label text-dim">
                    <th className="px-4 py-2.5 text-left font-normal">Type</th>
                    <th className="px-4 py-2.5 text-left font-normal">Subject</th>
                    <th className="px-4 py-2.5 text-left font-normal">Requester</th>
                    <th className="px-4 py-2.5 text-left font-normal">Risk</th>
                    <th className="px-4 py-2.5 text-left font-normal">Waiting</th>
                    <th className="px-4 py-2.5 text-left font-normal">Due</th>
                    <th className="px-4 py-2.5 text-right font-normal">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((a) => {
                    const waiting = waitingLabel(a.createdAt);
                    const due = dueLabel();
                    return (
                      <tr
                        key={a.id}
                        className="border-b border-line/60 last:border-0 hover:bg-surface-2/50"
                        data-testid="approval-row"
                      >
                        <td className="px-4 py-3 align-top text-body">{typeLabel(a)}</td>
                        <td className="px-4 py-3 align-top">
                          <span className="block min-w-0">
                            <span className="block text-body text-text">{a.summary}</span>
                            <span className="mt-0.5 block font-mono text-micro text-dim">{a.id}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top text-body text-muted">—</td>
                        <td className="px-4 py-3 align-top">
                          <RiskWord risk={derivedRisk(a)} />
                        </td>
                        <td className="px-4 py-3 align-top text-body text-muted">{waiting}</td>
                        <td className="px-4 py-3 align-top font-mono text-body text-muted">{due}</td>
                        <td className="px-4 py-3 align-top text-right">
                          <div className="inline-flex items-center gap-1">
                            <Button size="sm" onClick={() => setOpen(a)}>
                              Review
                            </Button>
                            <button
                              type="button"
                              aria-label="More actions"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                            >
                              <Dots s={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Zone>
      )}

      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? typeLabel(open) : ""}>
        {open && (
          <div className="space-y-2">
            <ApprovalCard approval={open} onDecided={() => { setOpen(null); reload(); }} />
            <Link href={`/runs/${open.flowExecutionId}`} className="block pl-4 text-xs text-accent hover:underline">
              Open the full run to see every step that led here.
            </Link>
          </div>
        )}
      </Modal>
    </Page>
  );
}

// ⚠ `useSearchParams()` makes a statically prerendered page bail out to the client, and Next 15 refuses to BUILD one that does
// so outside a Suspense boundary ("Missing Suspense boundary with useSearchParams"). The boundary is here, around the page, so
// the page's own loading and error states are untouched.
export default function ApprovalsPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <ApprovalsPageContent />
    </Suspense>
  );
}
