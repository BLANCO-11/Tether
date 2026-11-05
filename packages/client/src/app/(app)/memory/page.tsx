"use client";

/**
 * Workspace memory ledger — manage and visualize project memories (Phase 4 UI).
 * Not RAG: curated facts that inject into project chats. Pick a project, see kinds / timeline, add or close items.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAsync } from "@/lib/hooks";
import { listProjects, updateProject } from "@/lib/api";
import {
  addProjectMemory,
  listProjectMemories,
  setProjectMemoryStatus,
  type MemoryKind,
  type ProjectMemory,
} from "@/lib/project-memories";
import { PERSONAL_PRODUCT } from "@/lib/personal";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Select, Textarea } from "@/components/ui/Field";
import { useToast } from "@/lib/toast";
import { useCan } from "@/components/access/Can";

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: "Decision",
  preference: "Preference",
  open_loop: "Open loop",
  note: "Note",
};

const KIND_TONE: Record<MemoryKind, string> = {
  decision: "bg-accent",
  preference: "bg-ok",
  open_loop: "bg-warn",
  note: "bg-muted",
};

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function MemoryPage() {
  const toast = useToast();
  const search = useSearchParams();
  const projects = useAsync(listProjects, []);
  const mayAdd = !useCan("flows.write").denied;
  const [projectId, setProjectId] = useState<string | null>(search.get("project") || null);
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<ProjectMemory[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && projects.data?.length === 1) setProjectId(projects.data[0]!.id);
  }, [projects.data, projectId]);

  useEffect(() => {
    if (!projectId) {
      setRows(null);
      return;
    }
    setLoadErr(null);
    setRows(null);
    void listProjectMemories(projectId, statusFilter)
      .then(setRows)
      .catch((e) => setLoadErr(said(e)));
  }, [projectId, statusFilter]);

  const byKind = useMemo(() => {
    const counts: Record<MemoryKind, number> = { decision: 0, preference: 0, open_loop: 0, note: 0 };
    for (const m of rows ?? []) {
      if (m.status !== "active") continue;
      counts[m.kind] = (counts[m.kind] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const selected = (projects.data ?? []).find((p) => p.id === projectId);
  const memoryOn = selected?.memoryEnabled !== false;
  const activeTotal = Object.values(byKind).reduce((a, b) => a + b, 0);
  const maxKind = Math.max(1, ...Object.values(byKind));

  const reload = () => {
    if (!projectId) return;
    void listProjectMemories(projectId, statusFilter)
      .then(setRows)
      .catch((e) => setLoadErr(said(e)));
  };

  const toggleMemory = async (on: boolean) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await updateProject(projectId, { memoryEnabled: on });
      projects.reload();
      toast.success(on ? "Memory on — chats in this project can use the ledger." : "Memory off — chats will not inject or Remember.");
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!projectId || !body.trim() || !memoryOn) return;
    setBusy(true);
    try {
      await addProjectMemory(projectId, { kind, body: body.trim(), source: "manual" });
      setBody("");
      toast.success("Remembered. New chats in this project will see it.");
      reload();
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };

  const close = async (m: ProjectMemory, status: "superseded" | "discarded") => {
    if (!projectId) return;
    try {
      await setProjectMemoryStatus(projectId, m.id, status);
      toast.success(status === "superseded" ? "Superseded." : "Discarded.");
      reload();
    } catch (e) {
      toast.error(said(e));
    }
  };

  if (!PERSONAL_PRODUCT) {
    return (
      <Page>
        <PageHeader eyebrow="Build" title="Memory" purpose="Project memory is part of the personal product." />
        <Zone name="content">
          <Notice tone="info" title="Not available">
            This surface is for personal Foundry.
          </Notice>
        </Zone>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Build"
        title="Memory"
        purpose="Curated facts each project’s chats start with — decisions, preferences, open loops. Not a search index over every message."
      />
      <Zone name="content" className="flex flex-col gap-4">
        <section className="pane" aria-label="Choose project">
          <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
              <span className="text-caption text-muted">Project</span>
              <Select
                aria-label="Project"
                value={projectId ?? ""}
                onChange={(e) => setProjectId(e.target.value || null)}
                disabled={projects.loading}
              >
                <option value="">{projects.data?.length ? "Choose a project…" : "No projects yet"}</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption text-muted">Show</span>
              <Select aria-label="Status filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "active" | "all")}>
                <option value="active">Active only</option>
                <option value="all">Active + closed</option>
              </Select>
            </label>
            {projectId ? (
              <label className="flex items-center gap-2 pb-1 text-caption text-text">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={memoryOn}
                  disabled={busy || !mayAdd}
                  onChange={(e) => void toggleMemory(e.target.checked)}
                  aria-label="Use project memory"
                />
                Use memory for this project
              </label>
            ) : null}
            {projectId ? (
              <Link href={`/projects/${projectId}`} className="text-caption font-medium text-accent hover:underline">
                Open project →
              </Link>
            ) : null}
          </div>
          {projects.error ? (
            <div className="px-4 py-3">
              <Notice tone="danger" title="Could not load projects">
                {projects.error}
              </Notice>
            </div>
          ) : null}
          {!projectId && !projects.loading ? (
            <div className="px-4 py-6">
              <EmptyState title="Pick a project — memory is scoped to one. Create a project first if you have none." />
            </div>
          ) : null}
        </section>

        {projectId && !memoryOn ? (
          <Notice tone="info" title="Memory is off">
            Chats in this project will not inject remembered facts, and Remember is disabled. Turn it on above to use the ledger again — existing rows stay until you discard them.
          </Notice>
        ) : null}

        {projectId ? (
          <>
            <section className="pane" aria-label="Memory by kind">
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold">Active by kind</h2>
                <p className="text-caption text-muted">{activeTotal} active · inject cap is shared across kinds</p>
              </div>
              <div className="grid gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
                {(Object.keys(KIND_LABEL) as MemoryKind[]).map((k) => (
                  <div key={k} className="rounded-md border border-line bg-surface-2/40 px-3 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{KIND_LABEL[k]}</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums text-text">{byKind[k]}</p>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                      <div className={`h-full ${KIND_TONE[k]}`} style={{ width: `${(byKind[k] / maxKind) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="pane" aria-label="Memory list">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold">Ledger</h2>
                <span className="text-caption text-muted">{rows?.length ?? "…"} shown</span>
              </div>
              <div className="px-4 py-3">
                {loadErr ? (
                  <Notice tone="danger" title="Could not load memory">
                    {loadErr}
                  </Notice>
                ) : rows == null ? (
                  <Skeleton />
                ) : rows.length === 0 ? (
                  <p className="text-caption text-muted">Nothing here yet. Add a preference or decision below, or use Remember on a chat in this project.</p>
                ) : (
                  <ol className="relative flex flex-col gap-0 border-l border-line pl-4">
                    {rows.map((m) => (
                      <li key={m.id} className="relative py-3">
                        <span
                          className={`absolute -left-[1.15rem] top-4 h-2.5 w-2.5 rounded-full border border-surface ${m.status === "active" ? KIND_TONE[m.kind] : "bg-surface-2"}`}
                          aria-hidden
                        />
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                              {KIND_LABEL[m.kind]} · {m.status}
                              {m.source !== "manual" ? ` · ${m.source}` : ""}
                            </p>
                            <p className="mt-0.5 text-body text-text">{m.body}</p>
                            <p className="mt-1 text-caption text-dim">{new Date(m.createdAt).toLocaleString()}</p>
                          </div>
                          {m.status === "active" && mayAdd ? (
                            <div className="flex shrink-0 gap-2">
                              <Button size="sm" variant="ghost" onClick={() => void close(m, "superseded")}>
                                Supersede
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => void close(m, "discarded")}>
                                Discard
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {mayAdd && memoryOn ? (
                  <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
                    <Select aria-label="Memory kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} className="w-auto max-w-xs">
                      {(Object.keys(KIND_LABEL) as MemoryKind[]).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                    <Textarea
                      aria-label="New memory"
                      mono={false}
                      rows={2}
                      maxLength={500}
                      value={body}
                      placeholder="e.g. Always use UTC for due dates"
                      onChange={(e) => setBody(e.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" disabled={!body.trim() || busy} onClick={() => void add()}>
                        {busy ? "Saving…" : "Remember"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          </>
        ) : null}
      </Zone>
    </Page>
  );
}
