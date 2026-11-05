// src/app/(app)/flows/page.tsx — Workflows (URL stays /flows). One table of every workflow in the workspace, with
// saved views as tabs. The switch follows the approval gate rather than pausing/resuming directly; the ⋮ menu
// duplicates or deletes (deleting is distinct from turning off).
//
// ── The 2026-10-11 pass (docs/design/README.md) ────────────────────────────────────────────────────────────────
//
// - ⚠ **Owner, Resources and "My drafts" are GONE because the server sends neither for a workflow.** Both columns
//   were "—" on every row and the tab was permanently disabled, and the page made two extra requests (`getMe`,
//   `listResources`) to fill nothing. Bring them back with the data, not before.
//   - **Owner came back on 2026-10-15 (rbac-observability), with its data**: the server sends `ownerName` and
//     `mine` on every row, so the column and the "Mine" tab need no extra request. Resources and "My drafts" stay
//     gone. "New workflow" is hidden when `flows.write` is known to be DENIED (an Observer).
// - **"Awaiting approval" is back (2026-10-30, sharing-boundaries)**: it lists workflows whose owner asked a reviewer to
//   approve them. The note below is the record of why it was hidden until then.
// - ⚠ (was) **"Awaiting approval" is hidden, not deleted.** Its predicate (`approved && armedRevision == null`) cannot
//   match — `approve` writes both together (the DEFECT test in `lib/flow-views.test.ts`). A tab that always says 0
//   reads as "nothing waiting"; it comes back when somebody decides what it should mean. `?view=awaiting` falls
//   back to All.
// - **Last run** replaces them: the page already joined each workflow's last run for the Running/Failed tabs and
//   printed none of it.
// - ⚠ **The suspended tint was invisible**: `bg-warn-bg/30` is an alpha on a token Tailwind cannot alpha, so it is
//   dropped silently. A suspended row is marked with a warn bar on its leading edge instead.
// - Requests stay client-filtered on purpose: the tab counts need every workflow, a workspace holds tens, and the
//   last-run join reads the engine's live status (`listFlowExecutions`), which the server list does not.
//
// ── Delete selected (2026-10-13) ─────────────────────────────────────────────────────────────────────────────────
//
// Off by default: "Select" turns on a checkbox per workflow and "Select all" in the header, which picks every workflow
// the tab and search SHOW; "Select" becomes "Delete (N)", and "Clear all" (or Esc) unticks everything and leaves. Each is
// deleted through the same single-workflow route, so each keeps its own permission check and audit entry; a failure
// keeps that row selected. ⚠ Live workflows CAN be deleted together (as one can from the ⋮ menu), and the confirmation
// says how many are live and will stop running. Unsaved builds are chats, not workflows — no checkbox; delete them on
// Chats. The column is hidden only when `flows.write` is known to be DENIED; unreadable shows it (the server decides).
"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { listFlowsWithLastExecution, revokeFlowApproval, rearmFlowApproval, deleteFlow, duplicateFlow } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { describeCron } from "@/lib/cron";
import { fmtWhen } from "@/lib/stats";
import { WHERE_FILTERS, inWhere, type WhereFilter } from "@/lib/places";
import { WherePill } from "@/components/workspace/WherePill";
import { placeKey } from "@/components/workspace/MoveDialog";
import { VIEWS, viewCounts, type ViewKey, isRunningUnattended, isRunningFlow, isFailedFlow, offReason } from "@/lib/flow-views";
import { useActivityEpoch } from "@/lib/activity";
import { useToast } from "@/lib/toast";
import { FoundryApiError, resolveWorkspaceId } from "@/lib/foundry-client";
import { chatHref, listPiChats, unsavedBuilds, type PiChatSummary } from "@/lib/pi-builder";
import type { FlowSummary } from "@/lib/types";
import { bulkSentence, runEach } from "@/lib/bulk";
import { useCan } from "@/components/access/Can";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Badge";
import { RowMenu } from "@/components/ui/RowMenu";
import { Confirm } from "@/components/ui/Confirm";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Plus, ChevronRight, ChevronDown, Search, Cube, Workflow, Trash } from "@/components/ui/icons";
import { FlowStatusPill } from "@/components/flow/FlowStatusPill";

/** The tabs shown, in order. `mydrafts` stays defined in `lib/flow-views.ts` — see the header. */
const TABS: ViewKey[] = ["all", "mine", "awaiting", "live", "scheduled", "drafts", "suspended", "running", "failed"];

/** Status in words, for search. */
const STATUS_WORD: Record<FlowSummary["status"], string> = {
  draft: "Draft",
  draft_pending: "Draft waiting for approval",
  approved: "Approved",
  armed: "Running on a schedule",
  suspended: "Suspended",
};

/**
 * A workflow's last run as a dot plus a word — never colour alone. `null` when it has never run.
 * ⚠ Running and Failed use the SAME predicates as the tabs (`isRunningFlow`, `isFailedFlow`), so a row can never
 * read "Failed" while the Failed tab leaves it out.
 */
function lastRunOf(f: FlowSummary): { label: string; dot: string; when: string | null; id: string | null } | null {
  const r = f.lastExecution;
  if (!r) return null;
  const out = isRunningFlow(f)
    ? { label: "Running", dot: "bg-accent live-dot" }
    : isFailedFlow(f)
      ? { label: "Failed", dot: "bg-danger" }
      : (r.engineStatus ?? "").toUpperCase() === "PAUSED"
        ? { label: "Waiting", dot: "bg-warn" }
        : { label: "Succeeded", dot: "bg-ok" };
  return { ...out, when: r.startedAt ?? null, id: r.id ?? null };
}

function FlowsPageContent() {
  const epoch = useActivityEpoch();
  const { data: flows, error, reload } = useAsync(listFlowsWithLastExecution, [epoch]);
  // Builds in a chat nobody has saved yet: listed under All and Drafts so "where is what I was building" has an answer
  // here. Read separately — a failure here must not empty the workflows, and leaves just these rows out.
  const chats = useAsync(async () => listPiChats(await resolveWorkspaceId()), [epoch]);
  const [query, setQuery] = useState("");
  // Where it lives (sharing-boundaries phase 6): narrows any tab to My space, the projects, or the Workspace.
  const [where, setWhere] = useState<WhereFilter>("any");
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawView = searchParams.get("view") as ViewKey | null;
  const view: ViewKey = rawView && TABS.includes(rawView) ? rawView : "all";

  const q = query.trim().toLowerCase();
  const all = flows ?? [];
  // The tab counts count within the Where filter, so "Live 4" never sits over one row (P6-I1).
  const unsaved = unsavedBuilds(chats.data ?? []).filter((c) => inWhere(c, where));
  const counts = { ...viewCounts(all.filter((f) => inWhere(f, where))) };
  // An unsaved build is the chat's: it is "mine" when the chat is (the server's `mine`, as for a workflow).
  const unsavedMine = unsaved.filter((c) => c.mine === true);
  counts.all += unsaved.length;
  counts.drafts += unsaved.length;
  counts.mine += unsavedMine.length;
  const unsavedVisible = (view === "all" || view === "drafts" ? unsaved : view === "mine" ? unsavedMine : []).filter(
    (c) => (!q || [c.draftName ?? "", c.title, "unsaved draft"].join(" ").toLowerCase().includes(q)),
  );
  const matcher = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  const inView = all.filter((f) => matcher.match(f) && inWhere(f, where));
  const visible = inView.filter(
    (f) =>
      !q ||
      [f.name, f.kestraFlowId, f.description ?? "", STATUS_WORD[f.status], f.staleReason ?? "", f.ownerName ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
  );
  const toast = useToast();
  const [confirmOff, setConfirmOff] = useState<FlowSummary | null>(null);
  const [confirmDel, setConfirmDel] = useState<FlowSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();

  // ── Selection for "Delete selected". Only ids still listed survive a reload.
  const canDelete = !useCan("flows.write").denied;
  // Deleting is MANAGING (sharing-boundaries phase 2): your own workflows, or any for an Admin — not one you can only
  // edit because it is shared. The server refuses the rest; this keeps the button off rows it would refuse.
  const isAdmin = useCan("content.read.others").allowed === true;
  const mayDelete = (f: FlowSummary) => f.mine === true || isAdmin;
  const [selecting, setSelecting] = useState(false);
  const showSelect = canDelete && selecting;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const listed = useMemo(() => new Set(all.map((f) => f.id)), [all]);
  useEffect(() => {
    setSelected((cur) => {
      const kept = [...cur].filter((id) => listed.has(id));
      return kept.length === cur.size ? cur : new Set(kept);
    });
  }, [listed]);
  const shownSelected = visible.filter((f) => selected.has(f.id)).length;
  const allShownSelected = visible.length > 0 && shownSelected === visible.length;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = shownSelected > 0 && !allShownSelected;
  }, [shownSelected, allShownSelected]);
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllShown = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      for (const f of visible) {
        if (allShownSelected) next.delete(f.id);
        else next.add(f.id);
      }
      return next;
    });
  const picked = all.filter((f) => selected.has(f.id));
  const leaveSelecting = () => {
    setSelected(new Set());
    setSelecting(false);
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !bulkBusy && !confirmBulk) leaveSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, bulkBusy, confirmBulk]);
  const pickedLive = picked.filter(isRunningUnattended).length;

  const removeSelected = async () => {
    if (!picked.length) return;
    setBulkBusy(true);
    try {
      const out = await runEach(picked, (f) => deleteFlow(f.id));
      (out.failed.length ? toast.warn : toast.success)(bulkSentence("Deleted", ["workflow", "workflows"], picked.length, out));
      setSelected(new Set(out.failed.map((f) => f.item.id)));
      if (!out.failed.length) setSelecting(false);
    } finally {
      setBulkBusy(false);
      reload();
    }
  };

  const turnOff = async (flow: FlowSummary) => {
    setBusy(flow.id);
    try {
      await revokeFlowApproval(flow.id, "Turned off from the flows list");
      toast.success(`${flow.name} turned off — nothing fires unattended. Turn it back on directly whenever you want; newer drafts still need their own review.`);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not turn off "${flow.name}".`);
    } finally {
      setBusy(null);
    }
  };

  // Rearm the closed approval in one click. A 409 means there is nothing to rearm (never approved, or the approved
  // revision's refs went stale) — route to review rather than report a failure.
  const turnOn = async (flow: FlowSummary) => {
    setBusy(flow.id);
    try {
      await rearmFlowApproval(flow.id);
      toast.success(`${flow.name} is running again — same approved revision, no new review needed.`);
      reload();
    } catch (e) {
      if (e instanceof FoundryApiError && e.status === 409) router.push(`/flows/${flow.id}`);
      else toast.error(e instanceof Error ? e.message : `Could not turn on "${flow.name}".`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (flow: FlowSummary) => {
    try {
      await deleteFlow(flow.id);
      toast.success(`Deleted "${flow.name}"`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not delete "${flow.name}".`);
    }
    reload();
  };

  const duplicate = async (flow: FlowSummary) => {
    setBusy(flow.id);
    try {
      const { flow: copy } = await duplicateFlow(flow.id);
      toast.success(`Duplicated as "${copy.name}"`);
      router.push(`/flows/${copy.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not duplicate "${flow.name}".`);
      reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      {/* The plain title (index pages lead with it). The explanation that used to sit under it lives where it is
          acted on: the Turn off confirmation says nothing is deleted. */}
      <PageHeader
        title="Workflows"
        actions={canDelete ? [{ label: "New workflow", icon: <Plus s={15} />, href: "/chats/new?mode=workflow" }] : undefined}
      />

      <Zone name="notices">
        {/* An unreachable server must not read as "you have no flows". */}
        {error && (
          <Notice
            tone="danger"
            title="Could not load this workspace's flows"
            action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}
          >
            {error}
          </Notice>
        )}
      </Zone>

      <Zone name="controls" gap="tight">
        {/* Tabs: count after the label, dimmer; accent underline and count on the active one; a 0 is rendered. */}
        <div role="tablist" aria-label="Workflow views" className="-mb-px flex flex-wrap items-center gap-1 border-b border-line">
          {TABS.map((key) => {
            const v = VIEWS.find((x) => x.key === key)!;
            const active = key === view;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                onClick={() => router.replace(`/flows?view=${key}`)}
                className={`-mb-px border-b-2 px-3 py-2 text-body transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                  active ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text"
                }`}
              >
                {v.label} <span className={`tabular-nums ${active ? "text-accent" : "text-dim"}`}>{counts[key]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-line-interactive bg-bg px-2.5 text-body text-muted transition-colors duration-150 focus-within:border-accent-line sm:w-[280px]">
            <Search s={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search workflows"
              className="w-full min-w-0 bg-transparent text-text outline-none placeholder:text-dim"
              placeholder="Search workflows"
            />
          </div>
          <div role="radiogroup" aria-label="Where it lives" className="flex flex-wrap gap-1.5">
            {WHERE_FILTERS.map((w) => (
              <button
                key={w.key}
                type="button"
                role="radio"
                aria-checked={where === w.key}
                onClick={() => setWhere(w.key)}
                className={`rounded-full px-2.5 py-0.5 text-[12px] ${where === w.key ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-2 hover:text-text"}`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* ⚠ "newest first" is by LAST UPDATED — the list carries no last-run time to sort on. */}
            <p className="text-caption tabular-nums text-dim">
              {visible.length + unsavedVisible.length} of {all.length + unsaved.length} {all.length + unsaved.length === 1 ? "workflow" : "workflows"} · last updated first
            </p>
            {canDelete &&
              (selecting ? (
                <div className="flex items-center gap-2" role="group" aria-label="Selected workflows">
                  <span className="text-caption tabular-nums text-text">{selected.size} selected</span>
                  <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={leaveSelecting}>
                    Clear all
                  </Button>
                  <Button variant="danger" size="sm" disabled={bulkBusy || selected.size === 0} onClick={() => setConfirmBulk(true)}>
                    <Trash s={14} /> {bulkBusy ? "Deleting…" : selected.size ? `Delete (${selected.size})` : "Delete"}
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" disabled={!all.length} onClick={() => setSelecting(true)}>
                  Select
                </Button>
              ))}
          </div>
        </div>
      </Zone>

      {/* Absent when the fetch failed: zone 2 has already said what happened. */}
      {!error && (
        <Zone name="content" gap="none">
          {!flows ? (
            <div className="pane overflow-hidden" aria-hidden>
              <div className="h-9 border-b border-line" />
              <Skeleton rows={6} className="p-4" />
            </div>
          ) : all.length === 0 && unsaved.length === 0 ? (
            <div className="pane">
              <EmptyState
                icon={<Workflow s={16} />}
                title={
                  canDelete ? (
                    <>
                      No workflows in this workspace yet.{" "}
                      <Link href="/chats/new?mode=workflow" className="text-accent hover:underline">Describe one</Link> and Foundry will
                      design the steps.
                    </>
                  ) : (
                    <>Nothing shared with you yet: no workflows in the Workspace or your projects.</>
                  )
                }
              />
            </div>
          ) : visible.length === 0 && unsavedVisible.length === 0 ? (
            <div className="pane">
              <EmptyState
                icon={<Cube s={16} />}
                title={
                  <>
                    No workflows match your search. Clear a filter to return to all {all.length}{" "}
                    {all.length === 1 ? "workflow" : "workflows"}.
                  </>
                }
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      router.replace("/flows?view=all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="pane overflow-hidden">
              {/* ⚠ `table-fixed` + `<colgroup>` is what stops the horizontal scroll: under `table-layout: auto` a
                  `truncate`d cell's min-content width is the WHOLE string, so a long purpose widened the column
                  and pushed the switch off-screen. Do not restore `overflow-x-auto` — it would hide that. */}
              <table className="w-full table-fixed text-body">
                <colgroup>
                  {showSelect && <col className="w-[44px]" />}
                  <col />
                  <col className="w-[176px]" />
                  <col className="w-[160px]" />
                  <col className="w-[168px]" />
                  <col className="w-[176px]" />
                  <col className="w-[104px]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-line text-caption uppercase tracking-label text-dim">
                    {showSelect && (
                      <th className="py-2.5 pl-4 text-left font-normal">
                        <input
                          ref={selectAll}
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-accent align-middle"
                          checked={allShownSelected}
                          disabled={!visible.length || bulkBusy}
                          onChange={toggleAllShown}
                          aria-label="Select all workflows shown"
                        />
                      </th>
                    )}
                    <th className="px-4 py-2.5 text-left font-normal">Name &amp; purpose</th>
                    <th className="px-4 py-2.5 text-left font-normal">Status</th>
                    <th className="px-4 py-2.5 text-left font-normal">Owner</th>
                    <th className="px-4 py-2.5 text-left font-normal">Last run</th>
                    <th className="px-4 py-2.5 text-left font-normal">Schedule</th>
                    <th className="px-4 py-2.5 text-right font-normal">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {unsavedVisible.map((c) => (
                    <UnsavedRow key={`chat-${c.id}`} chat={c} now={now} selectable={showSelect} />
                  ))}
                  {visible.map((flow) => (
                    <FlowRow
                      key={flow.id}
                      flow={flow}
                      now={now}
                      busy={busy === flow.id}
                      select={
                        showSelect && mayDelete(flow)
                          ? { checked: selected.has(flow.id), disabled: bulkBusy, onToggle: () => toggle(flow.id) }
                          : null
                      }
                      onTurnOff={() => setConfirmOff(flow)}
                      onTurnOn={() => turnOn(flow)}
                      onDuplicate={() => duplicate(flow)}
                      onDelete={mayDelete(flow) ? () => setConfirmDel(flow) : undefined}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Zone>
      )}

      <Confirm
        open={!!confirmOff}
        title={confirmOff ? `Turn off ${confirmOff.name}?` : "Turn off?"}
        body={
          confirmOff
            ? `This closes the current approval and removes its schedule from the engine — ` +
              `nothing fires unattended and nothing is deleted. Turn it back on directly if nothing changed; a run ` +
              `already in progress finishes.`
            : ""
        }
        confirmLabel="Turn off"
        danger
        onConfirm={() => confirmOff && turnOff(confirmOff)}
        onClose={() => setConfirmOff(null)}
      />
      <Confirm
        open={!!confirmDel}
        title={confirmDel ? `Delete ${confirmDel.name}?` : "Delete flow?"}
        body={
          confirmDel
            ? `Foundry will remove ${confirmDel.name} and its deployments from the engine. Its run ` +
              `history goes with it. This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => confirmDel && remove(confirmDel)}
        onClose={() => setConfirmDel(null)}
      />
      <Confirm
        open={confirmBulk}
        title={`Delete ${picked.length} ${picked.length === 1 ? "workflow" : "workflows"}?`}
        body={
          `Foundry will remove ${picked.length === 1 ? "it and its deployments" : "them and their deployments"} from the engine, ` +
          `with their run history. This can't be undone.` +
          (pickedLive
            ? ` ${pickedLive === picked.length ? (pickedLive === 1 ? "It is" : "All of them are") : `${pickedLive} of them ${pickedLive === 1 ? "is" : "are"}`} live and will stop running.`
            : "")
        }
        confirmLabel={`Delete ${picked.length}`}
        danger
        onConfirm={() => void removeSelected()}
        onClose={() => setConfirmBulk(false)}
      />
    </Page>
  );
}

/**
 * A build in a chat that nobody has saved: not a workflow yet (nothing runs, nothing is approved), so it has no switch
 * and no runs. Opening it reopens the chat where it stopped; deleting it is the chat's to do, on the Chats page.
 */
function UnsavedRow({ chat, now, selectable }: { chat: PiChatSummary; now: number; selectable: boolean }) {
  const name = chat.draftName?.trim() || chat.title;
  return (
    <tr className="group border-b border-line transition-colors duration-150 last:border-0 hover:bg-surface-2">
      {/* No checkbox: this is a chat, deleted on the Chats page. */}
      {selectable && <td className="py-3 pl-4 align-top" />}
      <td className="px-4 py-3 align-top">
        <Link href={chatHref(chat)} className="block min-w-0">
          <span className="block truncate font-medium text-text hover:text-accent" title={name}>
            {name}
          </span>
        </Link>
        <span className="mt-1 block truncate text-xs text-muted" title={chat.title}>
          Unsaved build in a chat · {chat.draftSteps} step{chat.draftSteps === 1 ? "" : "s"}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top">
        <Tag>Unsaved</Tag>
      </td>
      <td className="px-4 py-3 align-top text-xs">
        <span className="block truncate text-muted" title={chat.createdBy.name ?? undefined}>{chat.mine ? "You" : (chat.createdBy.name ?? "—")}</span>
      </td>
      <td className="px-4 py-3 align-top text-xs">
        <span className="text-dim">Not saved yet</span>
      </td>
      <td className="px-4 py-3 align-top text-xs">
        <span className="text-dim">Edited {fmtWhen(chat.updatedAt, now)}</span>
      </td>
      <td className="px-4 py-3 align-top">
        <span className="flex items-center justify-end">
          <Link href={chatHref(chat)}>
            <Button variant="subtle" size="sm">Open</Button>
          </Link>
        </span>
      </td>
    </tr>
  );
}

function FlowRow({
  flow,
  now,
  busy,
  select,
  onTurnOff,
  onTurnOn,
  onDuplicate,
  onDelete,
}: {
  flow: FlowSummary;
  now: number;
  busy: boolean;
  /** The row's checkbox for "Delete selected"; null when the column is hidden. */
  select: { checked: boolean; disabled: boolean; onToggle: () => void } | null;
  onTurnOff: () => void;
  onTurnOn: () => void;
  onDuplicate: () => void;
  /** Absent: this person may not delete it (it is somebody else's) — no Delete in the menu. */
  onDelete?: () => void;
}) {
  const suspended = flow.status === "suspended";
  const off = offReason(flow);
  const [showPurpose, setShowPurpose] = useState(false);
  const purpose = flow.description?.trim() || null;
  const purposeId = `flow-purpose-${flow.id}`;
  const last = lastRunOf(flow);
  const cron = (flow.schedule ?? "").trim();
  const firing = isRunningUnattended(flow);

  return (
    <tr className={`group border-b border-line transition-colors duration-150 last:border-0 hover:bg-surface-2 ${select?.checked ? "bg-accent-bg/40" : ""}`}>
      {select && (
        <td className="py-3 pl-4 align-top">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 cursor-pointer accent-accent"
            checked={select.checked}
            disabled={select.disabled}
            onChange={select.onToggle}
            aria-label={`Select ${flow.name}`}
          />
        </td>
      )}
      {/* NAME & PURPOSE — two lines, the second dim. A suspended row carries a warn bar on its leading edge. */}
      <td className={`relative px-4 py-3 align-top ${suspended ? "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-warn" : ""}`}>
        <Link href={`/flows/${flow.id}`} className="block min-w-0">
          <span className="block truncate font-medium text-text hover:text-accent" title={flow.name}>
            {flow.name}
          </span>
        </Link>
        {/* ⚠ Falls back to the Kestra slug rather than an empty second line. ⚠ The disclosure is OUTSIDE the link:
            a button inside an anchor has a click target the browser picks. */}
        <div className="mt-1 flex items-start gap-1">
          <span id={purposeId} className={`min-w-0 flex-1 text-xs text-muted ${showPurpose ? "" : "truncate"}`}>
            {purpose ?? flow.kestraFlowId}
          </span>
          {purpose && (
            <button
              type="button"
              onClick={() => setShowPurpose((v) => !v)}
              aria-expanded={showPurpose}
              aria-controls={purposeId}
              aria-label={showPurpose ? `Collapse the purpose of ${flow.name}` : `Read the full purpose of ${flow.name}`}
              title={showPurpose ? "Show less" : "Read the full sentence"}
              className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded text-dim transition-colors hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {showPurpose ? <ChevronDown s={12} /> : <ChevronRight s={12} />}
            </button>
          )}
        </div>
        {/* The two facts that change what this row MEANS, only when true. `off` carries WHICH reason — the sweep's
            `staleReason`, or the deliberate turn-off; one string for both would report an act as a fault. */}
        {(off || (firing && flow.draftAhead)) && (
          <span className="mt-1 block text-caption">
            {off ? (
              <span className={off.kind === "stale" ? "text-warn" : "text-muted"}>
                {off.kind === "stale" ? `suspended — ${off.text}` : off.text}
              </span>
            ) : (
              <span className="text-accent">a newer draft is not approved</span>
            )}
          </span>
        )}
      </td>

      {/* STATUS — the pill and the version (the APPROVAL count, never a revision number), one statement. */}
      <td className="whitespace-nowrap px-4 py-3 align-top">
        <span className="flex items-center gap-2">
          <FlowStatusPill status={flow.status} />
          {flow.version != null && <Tag mono>v{flow.version}</Tag>}
        </span>
      </td>

      {/* OWNER — whose it is, "You" for the person asking. "Admins": nobody owns it (its owner left, or it was made by the system), so Admins look after it. */}
      <td className="px-4 py-3 align-top text-xs">
        <span className="block truncate text-muted" title={flow.ownerName ?? undefined}>
          {flow.mine ? "You" : (flow.ownerName ?? (flow.ownerSubject ? "A former member" : "Admins"))}
        </span>
        <WherePill place={placeKey(flow)} projectName={flow.projectName} className="mt-1" />
      </td>

      {/* LAST RUN — outcome and when, linking to the run. Said rather than blank when it has never run. */}
      <td className="px-4 py-3 align-top text-xs">
        {last ? (
          <Link
            href={last.id ? `/runs/${last.id}` : `/flows/${flow.id}`}
            className="flex min-w-0 items-center gap-2 rounded text-muted hover:text-text"
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${last.dot}`} aria-hidden />
            <span className="shrink-0">{last.label}</span>
            {last.when && <span className="truncate tabular-nums text-dim">· {fmtWhen(last.when, now)}</span>}
          </Link>
        ) : (
          <span className="text-dim">Never run</span>
        )}
      </td>

      {/* SCHEDULE — in words, never a next-fire time (nothing computes one). A draft's cron does not fire until it is
          approved, and the row says so rather than presenting it as a live schedule. */}
      <td className="px-4 py-3 align-top text-xs">
        {cron ? (
          <span className={`block truncate ${firing ? "text-muted" : "text-dim"}`} title={cron}>
            {describeCron(cron) ?? cron}
            {!firing && " · once live"}
          </span>
        ) : (
          <span className="text-dim">Not scheduled</span>
        )}
      </td>

      <td className="px-4 py-3 align-top">
        <span className="flex items-center justify-end gap-3">
          {suspended && (
            <Link href={`/flows/${flow.id}`}>
              <Button variant="subtle" size="sm">Review</Button>
            </Link>
          )}
          <ArmSwitch flow={flow} busy={busy} onTurnOff={onTurnOff} onTurnOn={onTurnOn} />
          <RowMenu
            actions={[
              { label: "Duplicate", icon: "edit", onClick: onDuplicate },
              ...(onDelete ? [{ label: "Delete", icon: "delete" as const, danger: true, onClick: onDelete }] : []),
            ]}
          />
        </span>
      </td>
    </tr>
  );
}

function ArmSwitch({ flow, busy, onTurnOff, onTurnOn }: { flow: FlowSummary; busy: boolean; onTurnOff: () => void; onTurnOn: () => void }) {
  const armed = isRunningUnattended(flow);

  if (armed) {
    return (
      <button
        onClick={onTurnOff}
        disabled={busy}
        aria-pressed="true"
        aria-label={`Turn off ${flow.name}`}
        title="Running unattended — turn off"
        className="h-5 w-9 rounded-full bg-ok p-0.5 transition-colors duration-fast ease-app focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        <span className="block h-4 w-4 translate-x-4 rounded-full bg-white transition-transform duration-base ease-app" />
      </button>
    );
  }

  /**
   * ⚠ A never-approved workflow's switch opens the WORKFLOW's page, where its "Approve this version" lives
   * (`PiFlowOverview`). It pointed at `/flows/[id]/publish` until 2026-10-11, the compiled builder's approval page —
   * deleted with Kestra's builder. A turned-off flow gets the one-click button above instead, even with a newer draft
   * waiting, which keeps its own review queue.
   */
  // Suspended with an approval on record: the server resumes the APPROVED
  // revision with no review — a newer draft stays untouched — so this is a
  // button, not a door to one. Only never-approved flows get the link to approve.
  if (flow.status === "suspended" && flow.armedRevision != null) {
    return (
      <button
        onClick={onTurnOn}
        disabled={busy}
        aria-pressed="false"
        aria-label={`Turn on ${flow.name} again — resumes the approved version`}
        title="Turned off — turn back on (resumes the approved version; newer drafts still need review)"
        className="flex h-5 w-9 items-center rounded-full bg-sunken p-0.5 shadow-inner transition-colors duration-fast ease-app hover:bg-[color-mix(in_srgb,var(--text)_14%,var(--sunken))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        <span className="block h-4 w-4 rounded-full bg-dim transition-transform duration-base ease-app" />
      </button>
    );
  }
  return (
    <Link
      href={`/flows/${flow.id}`}
      aria-label={`${flow.name} is not running — review and approve it`}
      title="Not running — review and approve"
      className="flex h-5 w-9 items-center rounded-full bg-sunken p-0.5 shadow-inner transition-colors duration-fast ease-app hover:bg-[color-mix(in_srgb,var(--text)_14%,var(--sunken))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="block h-4 w-4 rounded-full bg-dim transition-transform duration-base ease-app" />
    </Link>
  );
}

// ⚠ `useSearchParams()` makes a statically prerendered page bail out to the client, and Next 15 refuses to BUILD one that does
// so outside a Suspense boundary ("Missing Suspense boundary with useSearchParams"). The boundary is here, around the page, so
// the page's own loading and error states are untouched.
export default function FlowsPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <FlowsPageContent />
    </Suspense>
  );
}
