// src/app/(app)/resources/page.tsx — S-48 Resource list (pack 09, wide).
//
// ── Pack truth, ONE screen ────────────────────────────────────────────────
// `15-resource-list.png` + `S-48.md` + `flows/09-resources-and-change.md § Step 1`.
// Header: title `Resources`, purpose `Datasources, connectors and credentials that
// workflows depend on.`, action `Add resource` → `/resources/new` (onboarding wizard).
// Controls: four category tabs via `?type=` (All · Datasources · Files · Tools)
// — **no counts** (S-48 § Layout, unlike S-28), then search `Search resources` on
// its own row — **no other filters**, **no result count line** (S-48 § Layout).
// Columns: `NAME` · `TYPE` · `STATUS` · `OWNER` · `DEPENDENTS` · `HEALTH` · `⋯`.
// Health is a chip with a mark, variable-length; Safety badge `Not visible to AI`
// under name when no safe data (S-48 § Two rules). Dependents is DERIVED from the
// workflow graph, never stored (S-48 § Two rules, mapping.md §1, 10-build-guide rule 10).
//
// Current data: `listConnections()` (datasources) + `listFlows()` for dependents.
// `ResourceCategory` / `TYPE` is derived from connector_id, not stored — same as
// the pack's ResourceType → ResourceCategory mapping. Owner/health/dependents
// reads are partial → B-13 records the gap; the page renders what is true.
//
"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { listConnections, listFlows, deleteConnection, setDatasourcePaused } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { TOAST_MS } from "@/lib/toast-timing";
import type { Connection, FlowSummary } from "@/lib/types";
import { categoryFor, VALID_RESOURCE_TYPES, type ResourceCategory } from "@/lib/resource-category";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { UploadsToast } from "@/components/ui/UploadsToast";
import { DataTable, type DataRow } from "@/components/ui/DataTable";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { RowMenu } from "@/components/ui/RowMenu";
import { Confirm } from "@/components/ui/Confirm";
import { Plus, Search, Database, Upload, Trash, Eye } from "@/components/ui/icons";
import { Modal } from "@/components/ui/Modal";
import { ChatFilePreview } from "@/components/pi-builder/ChatFilePreview";
import { bulkSentence, runEach } from "@/lib/bulk";
import { resolveWorkspaceId } from "@/lib/foundry-client";
import {
  deleteWorkspaceFile,
  FILE_ACCEPT,
  fileRefusal,
  listWorkspaceFiles,
  uploadWorkspaceFile,
  workspaceFileUrl,
  type WorkspaceFile,
} from "@/lib/workspace-files";
import type { HeaderAction } from "@/components/layout/PageHeader";

// ── ResourceCategory per 05-data-model.md § Resource ──────────────────────────
// datasource: Amazon S3, SFTP, PostgreSQL  |  connector: Email connector, REST connector, Slack  |  tool: (none yet)
// ⚠ MOVED to `@/lib/resource-category`: `/resources/[id]` needs the same answer to
// decide whether a resource gets the Schema and DB operations panes, and two copies
// of this predicate drift in the silent direction. Re-exported here because the
// type is part of this module's existing surface.
const VALID_TYPES = VALID_RESOURCE_TYPES;
export type { ResourceCategory };

/**
 * ── The tabs, and the one that is not a category ──────────────────────────
 *
 * `Files` replaced `Connectors` (2026-10-01), and since 2026-10-12 it is real: a workspace's documents, sheets,
 * images and text that a workflow reads when it RUNS (`lib/workspace-files.ts`). Upload, download and delete live
 * here; a step opens one with `foundry.file(name)`. ⚠ A SQLite database file is NOT a file here — it is uploaded as
 * a data source and lives under Datasources, because it is read by queries.
 *
 * Connector rows (email / REST / Slack) still exist and still show under All;
 * only their tab went.
 */
type Tab = "all" | "datasource" | "files" | "tool";
const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: "all", label: "All" },
  { key: "datasource", label: "Datasources" },
  { key: "files", label: "Files" },
  { key: "tool", label: "Tools" },
];
/** The header's Add action follows the tab you are on: what you are looking at is what you add. */
function addActionFor(tab: Tab, upload: () => void): HeaderAction {
  switch (tab) {
    case "files":
      return { label: "Upload file", icon: <Upload s={15} />, onClick: upload };
    case "tool":
      return { label: "Add tool", icon: <Plus s={15} />, href: "/tools?new=1" };
    case "datasource":
      return { label: "Add data source", icon: <Plus s={15} />, href: "/data-sources/new" };
    default:
      return { label: "Add resource", icon: <Plus s={15} />, href: "/data-sources/new" };
  }
}

function typeLabel(conn: Connection): string {
  const id = (conn.connector_id ?? "").toLowerCase();
  if (id.includes("postgres")) return "PostgreSQL";
  if (id === "mysql" || id.includes("mysql")) return "MySQL";
  if (id === "sqlite") return "SQLite";
  if (id.includes("s3") || id.includes("amazon")) return "Amazon S3";
  if (id.includes("sftp") || id === "ftp" || id.includes("ftp")) return "SFTP";
  if (id.includes("oracle")) return "Oracle";
  if (id.includes("mongo")) return "MongoDB";
  if (id.includes("email")) return "Email connector";
  if (id.includes("rest")) return "REST connector";
  if (id.includes("slack")) return "Slack";
  if (id.includes("tool")) return "Tool";
  return conn.connector_id || "—";
}

/** A file's kind, in words, from its name. */
function fileKind(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const kinds: Record<string, string> = {
    pdf: "PDF", docx: "Word", odt: "Document", xlsx: "Excel", xls: "Excel", ods: "Spreadsheet", csv: "CSV", tsv: "TSV",
    txt: "Text", md: "Text", json: "JSON", xml: "XML", yaml: "YAML", yml: "YAML",
    png: "Image", jpg: "Image", jpeg: "Image", gif: "Image", webp: "Image",
  };
  return `File · ${kinds[ext] ?? ext.toUpperCase()}`;
}

function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type Uploading = { key: string; name: string; progress: number; error?: string; done?: boolean; abort?: () => void };

function statusLabel(conn: Connection): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  switch (conn.status) {
    case "ready":
      return { label: "Published", tone: "ok" };
    case "pending":
    case "discovering":
      return { label: "Pending review", tone: "warn" };
    case "error":
      return { label: "Failed", tone: "danger" };
    case "untested":
      return { label: "Draft", tone: "neutral" };
    default:
      return { label: "Draft", tone: "neutral" };
  }
}

function healthFor(conn: Connection): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  switch (conn.status) {
    case "ready":
      return { label: "Healthy", tone: "ok" };
    case "pending":
    case "discovering":
      return { label: "A change is waiting for review", tone: "warn" };
    case "error":
      return { label: "Not connected", tone: "neutral" };
    case "untested":
      return { label: "Not connected", tone: "neutral" };
    default:
      return { label: "Healthy", tone: "ok" };
  }
}

function flowResources(flow: FlowSummary): string[] {
  if (flow && typeof flow === "object" && "resources" in flow) {
    const v = (flow as Record<string, unknown>).resources;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function ResourcesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawType = searchParams.get("type");
  const active: Tab =
    rawType === "files" ? "files"
    : (VALID_TYPES.includes(rawType as ResourceCategory) && rawType !== "connector") ? (rawType as Tab)
    : "all";

  const [q, setQ] = useState("");
  const toast = useToast();
  const [confirmDel, setConfirmDel] = useState<Connection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data: conns, loading: loadingConns, error: errConns, reload } = useAsync(listConnections);
  const { data: flows } = useAsync(listFlows);
  const { data: files, error: errFiles, reload: reloadFiles } = useAsync(listWorkspaceFiles);
  const [confirmFile, setConfirmFile] = useState<WorkspaceFile | null>(null);
  // The file being viewed (the eye / the name): its columns and first rows, never the whole data.
  const [viewing, setViewing] = useState<{ file: WorkspaceFile; href: string } | null>(null);
  const view = async (f: WorkspaceFile) => setViewing({ file: f, href: await workspaceFileUrl(f.id) });
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [uploadsHidden, setUploadsHidden] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const upload = async (chosen: FileList | null) => {
    const list = Array.from(chosen ?? []);
    if (picker.current) picker.current.value = "";
    if (!list.length) return;
    const ws = await resolveWorkspaceId();
    for (const file of list) {
      const why = fileRefusal(file);
      if (why) {
        toast.error(why);
        continue;
      }
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const up = uploadWorkspaceFile(ws, file, (progress) =>
        setUploads((xs) => xs.map((x) => (x.key === key ? { ...x, progress } : x))),
      );
      setUploads((xs) => [...xs, { key, name: file.name, progress: 0, abort: up.abort }]);
      setUploadsHidden(false);
      up.done.then(
        (f) => {
          setUploads((xs) => xs.map((x) => (x.key === key ? { ...x, progress: 1, done: true, abort: undefined } : x)));
          setTimeout(() => setUploads((xs) => xs.filter((x) => x.key !== key)), TOAST_MS);
          toast.success(`Uploaded "${f.name}"`);
          reloadFiles();
        },
        (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "aborted") return setUploads((xs) => xs.filter((x) => x.key !== key));
          setUploads((xs) => xs.map((x) => (x.key === key ? { ...x, error: msg, abort: undefined } : x)));
        },
      );
    }
  };

  // ── Select several files and delete them at once (Files tab only). Off by default: "Select" shows a checkbox on each
  // file and "Select all files shown"; it becomes "Delete (N)", and "Clear all" (or Esc, or leaving the tab) unticks
  // everything and leaves. Each file is deleted through the same single-file route, so each keeps its own check; a
  // failure keeps that file selected and the toast names why.
  const [selecting, setSelecting] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [confirmBulkFiles, setConfirmBulkFiles] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const showSelect = selecting && active === "files";
  const leaveSelecting = () => {
    setSelectedFiles(new Set());
    setSelecting(false);
  };
  useEffect(() => {
    if (active !== "files") leaveSelecting();
  }, [active]);
  const listedFiles = useMemo(() => new Set((files ?? []).map((f) => f.id)), [files]);
  useEffect(() => {
    setSelectedFiles((cur) => {
      const kept = [...cur].filter((id) => listedFiles.has(id));
      return kept.length === cur.size ? cur : new Set(kept);
    });
  }, [listedFiles]);
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !bulkBusy && !confirmBulkFiles) leaveSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, bulkBusy, confirmBulkFiles]);
  const toggleFile = (id: string) =>
    setSelectedFiles((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pickedFiles = (files ?? []).filter((f) => selectedFiles.has(f.id));
  const pickedInUse = pickedFiles.filter((f) => f.usedBy.length > 0).length;
  const removeSelectedFiles = async () => {
    if (!pickedFiles.length) return;
    setBulkBusy(true);
    try {
      const out = await runEach(pickedFiles, (f) => deleteWorkspaceFile(f.id));
      (out.failed.length ? toast.warn : toast.success)(bulkSentence("Deleted", ["file", "files"], pickedFiles.length, out));
      setSelectedFiles(new Set(out.failed.map((f) => f.item.id)));
      if (!out.failed.length) setSelecting(false);
    } finally {
      setBulkBusy(false);
      reloadFiles();
    }
  };

  const download = async (f: WorkspaceFile) => {
    const a = document.createElement("a");
    a.href = await workspaceFileUrl(f.id);
    a.download = f.name;
    a.click();
  };

  const removeFile = async (f: WorkspaceFile) => {
    try {
      await deleteWorkspaceFile(f.id);
      toast.success(`Deleted "${f.name}"`);
    } catch (e) {
      toast.error(`Couldn't delete it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      reloadFiles();
    }
  };

  const list = conns ?? [];
  const flowList: FlowSummary[] = flows ?? [];

  const dependentsOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of list) {
      const n = flowList.filter((f) => flowResources(f).includes(c.name)).length;
      m.set(c.id, n);
    }
    return m;
  }, [list, flowList]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return list.filter((c) => {
      // Files are their own rows (below); no connection is a file.
      if (active === "files") return false;
      const cat = categoryFor(c);
      const typeOk = active === "all" || cat === active;
      if (!typeOk) return false;
      if (!qq) return true;
      const hay = [c.name, typeLabel(c), statusLabel(c).label, healthFor(c).label].join(" ").toLowerCase();
      return hay.includes(qq);
    });
  }, [list, active, q]);

  /**
   * ── ⚠ THE `⋯` USED TO BE A DEAD BUTTON ────────────────────────────────────
   *
   * It rendered with `aria-label="More actions for <name>"` and **no
   * `onClick`** — an affordance announcing actions that did not exist, on the
   * page the pack calls the home of every resource. Reported as *"I see no
   * buttons for pause and delete"*, and the honest reading is that the control
   * was there and inert, which is worse than absent: `/data-sources` has had
   * both actions all along, so the two screens disagreed about what a person
   * could do to the same row.
   *
   * ⚠ **The same two handlers as `/data-sources`, calling the same `lib/api`
   * functions.** A second implementation of "pause this" is how one screen
   * quietly stops matching the other — which is the state this is fixing.
   */
  const togglePause = async (c: Connection) => {
    const next = !c.paused_from_model;
    setBusy(c.id);
    try {
      await setDatasourcePaused(c.id, next);
      toast.success(
        next
          ? `"${c.name}" is paused — the designer will not be shown it. Running automations are unaffected.`
          : `"${c.name}" is back in the designer's catalogue.`,
      );
    } catch (e) {
      toast.error(`Couldn't change it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      reload();
    }
  };

  const remove = async (c: Connection) => {
    try {
      await deleteConnection(c.id);
      toast.success(`Removed "${c.name}"`);
    } catch (e) {
      toast.error(`Couldn't remove it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      reload();
    }
  };

  const setType = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("type");
    else params.set("type", next);
    const qs = params.toString();
    router.replace(qs ? `/resources?${qs}` : "/resources");
  };

  const clearFilters = () => {
    setQ("");
    router.replace("/resources");
  };

  const rows: DataRow<"resource">[] = filtered.map((c) => {
    const st = statusLabel(c);
    const hl = healthFor(c);
    const dep = dependentsOf.get(c.id) ?? 0;
    const badge = c.status === "untested";
    return {
      key: c.id,
      cells: {
        identity: (
          <span className="flex flex-col items-start gap-1">
            <Link href={`/resources/${c.id}`} className="truncate font-medium text-text hover:text-accent">
              {c.name}
            </Link>
            {badge && (
              <span className="rounded bg-alpha-bg px-1.5 py-0.5 text-caption font-medium text-alpha">Not visible to AI</span>
            )}
            {/* ⚠ SAID, not inferable. A paused resource is identical to a
                running one in every column on this page — same status, same
                health, same dependents, because pausing changes none of them.
                The only difference is what the designer is shown, which is
                invisible from here. */}
            {c.paused_from_model && (
              <span className="rounded bg-warn-bg px-1.5 py-0.5 text-caption font-medium text-warn">
                Paused — hidden from the designer
              </span>
            )}
          </span>
        ),
        kind: <span className="text-xs text-muted">{typeLabel(c)}</span>,
        state: <StatusPill status={st.tone}>{st.label}</StatusPill>,
        owner: <span className="truncate text-xs text-muted">—</span>,
        count: <span className="text-xs text-muted">{dep} workflows</span>,
        health: <StatusPill status={hl.tone}>{hl.label}</StatusPill>,
        actions: (
          <RowMenu
            actions={[
              /* Pause — what the DESIGNER is shown, never what runs. No
                 confirmation, because nothing is destroyed and the same entry
                 undoes it; Delete keeps its dialog, and that asymmetry is what
                 stops people clicking through the one that matters. */
              {
                label: busy === c.id ? "Saving…" : c.paused_from_model ? "Resume" : "Pause",
                icon: "rotate",
                onClick: () => { if (busy !== c.id) void togglePause(c); },
              },
              { label: "Delete", icon: "delete", danger: true, onClick: () => setConfirmDel(c) },
            ]}
          />
        ),
      },
    };
  });

  const shownFiles =
    active === "all" || active === "files"
      ? (files ?? []).filter((f) => {
          const qq = q.trim().toLowerCase();
          return !qq || [f.name, fileKind(f.name), f.uploadedBy ?? ""].join(" ").toLowerCase().includes(qq);
        })
      : [];
  const shownFilesSelected = shownFiles.filter((f) => selectedFiles.has(f.id)).length;
  const allShownFilesSelected = shownFiles.length > 0 && shownFilesSelected === shownFiles.length;
  const selectAllFiles = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllFiles.current) selectAllFiles.current.indeterminate = shownFilesSelected > 0 && !allShownFilesSelected;
  }, [shownFilesSelected, allShownFilesSelected, showSelect]);
  const toggleAllShownFiles = () =>
    setSelectedFiles((cur) => {
      const next = new Set(cur);
      for (const f of shownFiles) {
        if (allShownFilesSelected) next.delete(f.id);
        else next.add(f.id);
      }
      return next;
    });

  const fileRows: DataRow<"resource">[] = shownFiles.map((f) => ({
    key: `file-${f.id}`,
    cells: {
      identity: (
        <span className="flex min-w-0 items-center gap-3">
          {showSelect && (
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 cursor-pointer accent-accent"
              checked={selectedFiles.has(f.id)}
              disabled={bulkBusy}
              onChange={() => toggleFile(f.id)}
              aria-label={`Select ${f.name}`}
            />
          )}
          <button type="button" onClick={() => void view(f)} className="truncate text-left font-medium text-text hover:text-accent" title={`View ${f.name}`}>
            {f.name}
          </button>
        </span>
      ),
      kind: <span className="text-xs text-muted">{fileKind(f.name)}</span>,
      state: <span className="text-xs text-muted">{sizeOf(f.sizeBytes)}</span>,
      owner: <span className="truncate text-xs text-muted">{f.uploadedBy ?? "—"}</span>,
      count: (
        <span className="text-xs text-muted" title={f.usedBy.map((u) => u.name).join(", ")}>
          {f.usedBy.length} workflows
        </span>
      ),
      health: <StatusPill status="ok">Stored</StatusPill>,
      actions: (
        <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => void view(f)}
          aria-label={`View ${f.name}`}
          title="View"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Eye s={16} />
        </button>
        <RowMenu
          actions={[
            { label: "Download", onClick: () => void download(f) },
            { label: "Delete", icon: "delete", danger: true, onClick: () => setConfirmFile(f) },
          ]}
        />
        </span>
      ),
    },
  }));
  const allRows = [...rows, ...fileRows];

  const isFiltered = active !== "all" || q.trim() !== "";

  return (
    <Page measure="wide">
      <PageHeader title="Resources" purpose="Datasources, files and tools that workflows depend on." actions={[addActionFor(active, () => picker.current?.click())]} />
      <input
        ref={picker}
        type="file"
        multiple
        accept={FILE_ACCEPT}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => void upload(e.target.files)}
      />
      {errFiles && (active === "files" || active === "all") ? (
        <Zone name="notices" gap="tight">
          {errFiles && (active === "files" || active === "all") ? (
            <Notice tone="danger" title="Could not load files" action={<Button variant="ghost" size="sm" onClick={reloadFiles}>Try again</Button>}>
              {errFiles}
            </Notice>
          ) : null}
        </Zone>
      ) : null}
      {uploadsHidden ? null : (
        <UploadsToast
          uploads={uploads}
          onHide={() => setUploadsHidden(true)}
          onDismissItem={(k) => setUploads((xs) => xs.filter((x) => x.key !== k))}
        />
      )}
      {errConns && (
        <Zone name="notices" gap="tight">
          <Notice tone="danger" title="Could not load resources" action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}>
            {errConns}
          </Notice>
        </Zone>
      )}

      <Zone name="controls" gap="tight">
        <div role="tablist" aria-label="Resource categories" className="-mb-px flex flex-wrap items-center gap-1 border-b border-line">
          {TABS.map((t) => {
            const isActive = active === t.key;
            return (
              <button key={t.key} role="tab" aria-selected={isActive} onClick={() => setType(t.key)} className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-fast ease-app ${isActive ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}>
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="relative flex w-64 items-center">
            <span className="pointer-events-none absolute left-3 text-dim">
              <Search s={14} />
            </span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search resources" aria-label="Search resources" className="h-9 w-full rounded-md border border-line bg-bg pl-9 pr-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50" />
          </label>
          {active === "files" && (files ?? []).length > 0 &&
            (showSelect ? (
              <div className="flex flex-wrap items-center gap-3" role="group" aria-label="Selected files">
                <label className="flex items-center gap-2 text-caption text-muted">
                  <input
                    ref={selectAllFiles}
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-accent"
                    checked={allShownFilesSelected}
                    disabled={!shownFiles.length || bulkBusy}
                    onChange={toggleAllShownFiles}
                    aria-label="Select all files shown"
                  />
                  Select all
                </label>
                <span className="text-caption tabular-nums text-text">{selectedFiles.size} selected</span>
                <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={leaveSelecting}>
                  Clear all
                </Button>
                <Button variant="danger" size="sm" disabled={bulkBusy || selectedFiles.size === 0} onClick={() => setConfirmBulkFiles(true)}>
                  <Trash s={14} /> {bulkBusy ? "Deleting…" : selectedFiles.size ? `Delete (${selectedFiles.size})` : "Delete"}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setSelecting(true)}>
                Select
              </Button>
            ))}
        </div>
      </Zone>

      <Zone name="content">
        <DataTable
          set="resource"
          caption="Resources"
          heads={{ identity: "NAME", kind: "TYPE", state: "STATUS", owner: "OWNER", count: "DEPENDENTS", health: "HEALTH", actions: "" }}
          rows={allRows}
          empty={
            loadingConns ? (
              <Skeleton rows={3} />
            ) : active === "files" && !q.trim() ? (
              <EmptyState
                icon={<Upload s={16} />}
                title="No files yet. Upload what a workflow should read when it runs — a rate card, a policy, a template. Documents, sheets, images or text, up to 50 MB each."
                action={
                  <Button size="sm" onClick={() => picker.current?.click()}>
                    <Upload s={15} />
                    Upload file
                  </Button>
                }
              />
            ) : isFiltered ? (
              <EmptyState
                icon={<Search s={16} />}
                title="No resources match your filters."
                action={<Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                icon={<Database s={16} />}
                title="There are no resources in this workspace yet. Connect one before building a workflow that reads or writes data."
                action={
                  <Link href="/data-sources/new">
                    <Button size="sm">
                      <Plus s={15} />
                      Add resource
                    </Button>
                  </Link>
                }
              />
            )
          }
        />
      </Zone>

      {/* ⚠ Delete keeps its confirmation and names what is lost, because the
          row menu gives it one click and the act is irreversible. The wording
          is `/data-sources`' own, so the two screens promise the same thing. */}
      <Confirm
        open={!!confirmDel}
        title={confirmDel ? `Remove ${confirmDel.name}?` : "Remove resource?"}
        body={
          confirmDel
            ? `Tether will forget ${confirmDel.name}'s credential and everything it discovered about it. ` +
              `Any operation written against it, and any workflow step that calls one, stops working until ` +
              `it is registered again. The database itself is not touched.`
            : ""
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => confirmDel && remove(confirmDel)}
        onClose={() => setConfirmDel(null)}
      />
      <Confirm
        open={!!confirmFile}
        title={confirmFile ? `Delete ${confirmFile.name}?` : "Delete file?"}
        body={
          confirmFile
            ? confirmFile.usedBy.length
              ? `${confirmFile.usedBy.length} workflow${confirmFile.usedBy.length === 1 ? "" : "s"} read${confirmFile.usedBy.length === 1 ? "s" : ""} this file ` +
                `(${confirmFile.usedBy.map((u) => u.name).join(", ")}). They will stop at that step until a file with the same name is uploaded again.`
              : "No workflow reads this file. It is deleted for good."
            : ""
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => confirmFile && removeFile(confirmFile)}
        onClose={() => setConfirmFile(null)}
      />
      {/* The viewer is a dialog, like the Email box's: a sheet is a table and wants the width. It shows the columns and
          the first 50 rows only — enough to understand the schema; the whole data is the download. */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.file.name ?? "File"} wide fit>
        {viewing ? (
          <div className="flex max-h-[70vh] min-h-[200px] flex-col">
            <ChatFilePreview key={viewing.href} name={viewing.file.name} href={viewing.href} maxRows={50} />
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => void download(viewing.file)}>Download</Button>
            </div>
          </div>
        ) : null}
      </Modal>
      <Confirm
        open={confirmBulkFiles}
        title={`Delete ${pickedFiles.length} ${pickedFiles.length === 1 ? "file" : "files"}?`}
        body={
          (pickedInUse
            ? `${pickedInUse === pickedFiles.length ? (pickedInUse === 1 ? "It is" : "All of them are") : `${pickedInUse} of them ${pickedInUse === 1 ? "is" : "are"}`} read by a workflow, ` +
              `which will stop at that step until a file with the same name is uploaded again. `
            : "No workflow reads these files. ") + "They are deleted for good."
        }
        confirmLabel={`Delete ${pickedFiles.length}`}
        danger
        onConfirm={() => void removeSelectedFiles()}
        onClose={() => setConfirmBulkFiles(false)}
      />
    </Page>
  );
}

// ⚠ `useSearchParams()` makes a statically prerendered page bail out to the client, and Next 15 refuses to BUILD one that does
// so outside a Suspense boundary ("Missing Suspense boundary with useSearchParams"). The boundary is here, around the page, so
// the page's own loading and error states are untouched.
export default function ResourcesPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <ResourcesPageContent />
    </Suspense>
  );
}
