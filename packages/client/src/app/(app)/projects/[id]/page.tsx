// src/app/(app)/projects/[id]/page.tsx — one project (sharing-boundaries phase 5; laid out from the 2026-10-30 mock).
//
// What lives in it (chats and workflows), its files, its shared instructions, and its people. The owner (or an Admin)
// changes it: adds and removes members, edits the instructions, hands it on, deletes it. Anybody in it can leave, and
// any member who builds can add a file. Every consequence is said BEFORE it happens: a removed member loses
// everything in it at once, and what they owned passes to the project's owner; deleting it returns each item to its
// owner's My space and deletes its files. The server decides who may; this page shows what it was told.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useResolvedWorkspace } from "@/lib/workspace";
import { addProjectMember, deleteProject, getProject, listMembers, removeProjectMember, setProjectOwner, updateProject } from "@/lib/api";
import { chatHref } from "@/lib/pi-builder";
import { fmtWhen } from "@/lib/stats";
import {
  PROJECT_FILE_ACCEPT,
  addProjectFile,
  fileBadge,
  listProjectFiles,
  projectFileRefusal,
  projectFileUrl,
  removeProjectFile,
  sizeLabel,
  type ProjectFile,
} from "@/lib/project-files";
import type { ProjectDetail } from "@/lib/foundry-client";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader, type HeaderAction } from "@/components/layout/PageHeader";
import { MainAside } from "@/components/layout/MainAside";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/ui/Confirm";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { RowMenu } from "@/components/ui/RowMenu";
import { Chat, Plus, Upload, Workflow } from "@/components/ui/icons";

/** The server's sentence out of a refused request, or the error as it is. */
function said(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const body = text.replace(/^\d{3}\s*/, "");
  try {
    return (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    return body;
  }
}

type Member = ProjectDetail["members"][number];

// The id comes from `useParams()`, not a `params` prop — see `flows/[id]/page.tsx` for why.
export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const project = useAsync(() => getProject(id), [id]);
  const files = useAsync(() => listProjectFiles(id), [id]);
  const p = project.data;
  const [removing, setRemoving] = useState<Member | null>(null);
  const [handing, setHanding] = useState<Member | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const act = async (what: () => Promise<unknown>, done: string) => {
    try {
      await what();
      toast.success(done);
      project.reload();
    } catch (e) {
      toast.error(said(e));
    }
  };

  if (project.error) {
    return (
      <Page>
        <PageHeader eyebrow="Project" title="Project" />
        <Zone name="content">
          <Notice tone="warn" title="This project could not be opened">
            {/^404/.test(project.error) ? "It is not here, or you are not in it." : project.error}
          </Notice>
          <p className="mt-3 text-caption">
            <Link href="/projects" className="text-accent hover:underline">
              Back to projects
            </Link>
          </p>
        </Zone>
      </Page>
    );
  }
  if (!p) {
    return (
      <Page>
        <PageHeader eyebrow="Project" title="Project" />
        <Zone name="content">
          <Skeleton />
        </Zone>
      </Page>
    );
  }

  const newChat: HeaderAction = { label: "New chat", href: `/chats/new?project=${p.id}`, icon: <Plus s={14} /> };
  const remove: HeaderAction = { label: "Delete project", variant: "danger-quiet", onClick: () => setDeleting(true) };
  const actions = p.mine !== false ? (p.manages ? ([newChat, remove] as const) : ([newChat] as const)) : p.manages ? ([remove] as const) : undefined;
  const fileCount = files.data?.length ?? 0;

  return (
    <Page>
      <PageHeader eyebrow="Project" title={p.name} purpose={p.description ?? undefined} actions={actions} />
      <Zone name="content">
        <div className="flex flex-col gap-7">
          <ProjectWork project={p} />
          <ProjectFiles projectId={p.id} files={files} canAdd={p.mine !== false || p.manages} />
          <MainAside
            asideLabel="People"
            gap="gap-4"
            aside={<People project={p} onChanged={() => project.reload()} onRemove={setRemoving} onHand={setHanding} onLeave={() => setLeaving(true)} />}
          >
            <Instructions project={p} onSaved={() => project.reload()} />
          </MainAside>
        </div>
      </Zone>

      <Confirm
        open={removing != null}
        title={`Remove ${removing?.name ?? ""}?`}
        body={`They stop seeing everything in “${p.name}” at once. What they own here passes to ${p.ownerName}, and anything of it they turned on for themselves stops. They are told.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && void act(() => removeProjectMember(p.id, removing.subject), `Removed ${removing.name}`)}
        onClose={() => setRemoving(null)}
      />
      <Confirm
        open={handing != null}
        title={`Make ${handing?.name ?? ""} the owner?`}
        body={`They will manage “${p.name}”: its members, its instructions, and deleting it. You stay a member.`}
        confirmLabel="Make owner"
        onConfirm={() => handing && void act(() => setProjectOwner(p.id, handing.subject), `${handing.name} owns “${p.name}” now`)}
        onClose={() => setHanding(null)}
      />
      <Confirm
        open={leaving}
        title={`Leave “${p.name}”?`}
        body={`You stop seeing everything in it at once. What you own here passes to ${p.ownerName}.`}
        confirmLabel="Leave"
        danger
        onConfirm={async () => {
          try {
            await removeProjectMember(p.id, mySubject(p) ?? "");
            toast.success(`You left “${p.name}”`);
            router.push("/projects");
          } catch (e) {
            toast.error(said(e));
          }
        }}
        onClose={() => setLeaving(false)}
      />
      <Confirm
        open={deleting}
        title={`Delete “${p.name}”?`}
        body={`Everything in it goes back to its owner's My space, seen only by them, and its members are told.${
          fileCount ? ` Its ${fileCount === 1 ? "file is" : `${fileCount} files are`} deleted.` : " Nothing in it is deleted."
        }`}
        confirmLabel="Delete project"
        danger
        onConfirm={async () => {
          try {
            const { returned } = await deleteProject(p.id);
            toast.success(`Deleted “${p.name}”. ${returned} item${returned === 1 ? "" : "s"} went back to their owners' My space.`);
            router.push("/projects");
          } catch (e) {
            toast.error(said(e));
          }
        }}
        onClose={() => setDeleting(false)}
      />
    </Page>
  );
}

/** The member row that is the person asking — the server marks it with `you`. */
function mySubject(p: ProjectDetail): string | null {
  return p.members.find((m) => m.you)?.subject ?? null;
}

function SectionHead({ title, note, children }: { title: React.ReactNode; note: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-body font-semibold">{title}</h2>
        <p className="mt-0.5 text-caption text-muted">{note}</p>
      </div>
      {children}
    </div>
  );
}

const when = (iso: string | null | undefined) => (iso ? fmtWhen(iso, Date.now()) : null);

/** Chats and workflows in the project, most recently changed first, with a search and a type filter. */
function ProjectWork({ project }: { project: ProjectDetail }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "chat" | "workflow">("all");
  const rows = useMemo(
    () =>
      [
        ...project.items.chats.map((c) => ({ kind: "chat" as const, id: c.id, name: c.title ?? "Untitled chat", owner: c.ownerName, at: c.updatedAt ?? null, href: chatHref(c) })),
        ...project.items.flows.map((f) => ({ kind: "workflow" as const, id: f.id, name: f.name, owner: f.ownerName, at: f.updatedAt ?? null, href: `/flows/${f.id}` })),
      ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")),
    [project.items],
  );
  const term = q.trim().toLowerCase();
  const shown = rows.filter((r) => (kind === "all" || r.kind === kind) && (!term || `${r.name} ${r.owner}`.toLowerCase().includes(term)));

  return (
    <section aria-label="Project work">
      <SectionHead title="Project work" note="Chats and workflows in this project. Move one in from its own page.">
        {rows.length > 0 && (
          // ⚠ Widths on WRAPPERS: the controls are `w-full` by design, and a width class beside it loses or wins by
          // stylesheet order, not by which was written last — the first version collapsed the search box to nothing.
          <div className="flex w-full gap-2 sm:w-auto">
            <div className="min-w-0 flex-1 sm:w-52 sm:flex-none">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search project work" aria-label="Search project work" />
            </div>
            <div className="w-32 shrink-0">
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Filter by type">
                <option value="all">All types</option>
                <option value="chat">Chats</option>
                <option value="workflow">Workflows</option>
              </Select>
            </div>
          </div>
        )}
      </SectionHead>
      <div className="pane overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-caption text-muted">Nothing here yet. Start a chat, or move a workflow or chat in.</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-caption text-muted">No project work matches.</p>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((r) => (
              <li key={`${r.kind}-${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/50">
                <span
                  aria-hidden
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${r.kind === "workflow" ? "border-line-2 bg-surface-2 text-text" : "border-accent-line bg-accent-bg text-accent"}`}
                >
                  {r.kind === "workflow" ? <Workflow s={16} /> : <Chat s={16} />}
                </span>
                <div className="min-w-0 flex-1">
                  <Link href={r.href} className="block truncate font-medium text-text hover:text-accent">
                    {r.name}
                  </Link>
                  <span className="block truncate text-caption text-muted">
                    {r.at ? `Updated ${when(r.at)} · ` : ""}
                    {r.owner}
                  </span>
                </div>
                <span className="hidden shrink-0 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted sm:inline">
                  {r.kind === "workflow" ? "Workflow" : "Chat"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The project's shared files: every member sees them, and every chat in the project can open them. */
function ProjectFiles({
  projectId,
  files,
  canAdd,
}: {
  projectId: string;
  files: { data: ProjectFile[] | null | undefined; error: string | null; reload: () => void };
  canAdd: boolean;
}) {
  const toast = useToast();
  const picker = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(0);
  const [removing, setRemoving] = useState<ProjectFile | null>(null);
  const list = files.data ?? [];

  const add = async (picked: File[]) => {
    for (const f of picked) {
      const why = projectFileRefusal(f);
      if (why) {
        toast.error(`${f.name}: ${why}`);
        continue;
      }
      setAdding((n) => n + 1);
      try {
        await addProjectFile(projectId, f);
        toast.success(`Added ${f.name}.`);
      } catch (e) {
        toast.error(`${f.name}: ${said(e)}`);
      } finally {
        setAdding((n) => n - 1);
      }
    }
    files.reload();
  };
  const download = async (f: ProjectFile) => {
    const a = document.createElement("a");
    a.href = await projectFileUrl(projectId, f.id);
    a.download = f.name;
    a.click();
  };

  return (
    <section aria-label="Project files">
      <SectionHead
        title={
          <>
            Project files{files.data ? <span className="font-normal text-muted"> · {list.length} {list.length === 1 ? "file" : "files"}</span> : null}
          </>
        }
        note="Shared with the project's members. Every chat in the project can open them."
      >
        {canAdd && (
          <>
            <Button variant="ghost" size="sm" onClick={() => picker.current?.click()} disabled={adding > 0}>
              <Upload s={14} /> {adding > 0 ? "Adding…" : "Add files"}
            </Button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept={PROJECT_FILE_ACCEPT}
              aria-label="Choose project files"
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = "";
                if (picked.length) void add(picked);
              }}
            />
          </>
        )}
      </SectionHead>
      <div className="pane overflow-hidden">
        {files.error ? (
          <p className="px-4 py-4 text-caption text-warn">The files could not be read. ({files.error})</p>
        ) : !files.data ? (
          <div className="p-4">
            <Skeleton rows={2} />
          </div>
        ) : list.length === 0 ? (
          <p className="px-4 py-6 text-center text-caption text-muted">No project files yet. Add a file to share it with this project.</p>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/50">
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-[10px] font-bold text-accent">
                  {fileBadge(f.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => void download(f)} className="block w-full truncate text-left font-medium text-text hover:text-accent">
                    {f.name}
                  </button>
                  <span className="block truncate text-caption text-muted">
                    {sizeLabel(f.sizeBytes)} · Added by {f.uploadedByEmail ?? "someone"}
                  </span>
                </div>
                <span className="hidden shrink-0 text-caption text-muted sm:inline">{when(f.createdAt)}</span>
                <RowMenu
                  label={`More actions for ${f.name}`}
                  actions={[
                    { label: "Download", onClick: () => void download(f) },
                    ...(f.canRemove ? [{ label: "Remove", danger: true, icon: "delete" as const, onClick: () => setRemoving(f) }] : []),
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Confirm
        open={removing != null}
        title={`Remove ${removing?.name ?? ""}?`}
        body="It is deleted from the project for everyone in it. Chats that already opened it keep their copy."
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeProjectFile(projectId, removing.id);
            toast.success(`Removed ${removing.name}.`);
            files.reload();
          } catch (e) {
            toast.error(said(e));
          }
        }}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}

/** The shared instructions: read by everyone in it, edited by whoever manages it. */
function Instructions({ project, onSaved }: { project: ProjectDetail; onSaved: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(project.instructions);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(project.instructions), [project.instructions]);
  const changed = text !== project.instructions;
  const save = async () => {
    setBusy(true);
    try {
      await updateProject(project.id, { instructions: text });
      toast.success("Saved. Every chat in the project uses them from its next message.");
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pane" aria-label="Project instructions">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">Project instructions</h2>
        {project.manages && !editing ? (
          <button type="button" className="text-caption font-medium text-accent hover:underline" onClick={() => setEditing(true)}>
            Edit
          </button>
        ) : null}
      </div>
      <div className="px-4 py-3">
        {editing ? (
          <>
            <Textarea aria-label="Project instructions" mono={false} rows={6} value={text} maxLength={20000} onChange={(e) => setText(e.target.value)} />
            <div className="mt-2 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setText(project.instructions);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" disabled={!changed || busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        ) : project.instructions.trim() ? (
          <p className="whitespace-pre-wrap text-body text-text">{project.instructions}</p>
        ) : (
          <p className="text-caption text-muted">
            None yet. {project.manages ? "Add context, preferences or guidance every chat here should follow." : "The project's owner writes them."}
          </p>
        )}
        {!editing && <p className="mt-3 text-caption text-muted">Every chat in this project starts with these.</p>}
      </div>
    </section>
  );
}

const initials = (name: string) =>
  name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/** Who is in it. The owner (or an Admin) adds, removes and hands it on; anybody else may leave. */
function People({
  project,
  onChanged,
  onRemove,
  onHand,
  onLeave,
}: {
  project: ProjectDetail;
  onChanged: () => void;
  onRemove: (m: Member) => void;
  onHand: (m: Member) => void;
  onLeave: () => void;
}) {
  return (
    <section className="pane" aria-label="People">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">People</h2>
      </div>
      <ul className="flex flex-col gap-3 px-4 py-3">
        {project.members.map((m) => (
          <li key={m.subject} className="flex items-center gap-2.5">
            <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-bold text-text">
              {initials(m.name)}
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-caption font-medium text-text" title={m.name}>
                {m.name}
              </span>
              <span className="block truncate text-[11px] text-muted">{m.you ? "You" : m.owner ? "Project owner" : "Project member"}</span>
            </div>
            <span className="shrink-0 text-caption text-muted">{m.owner ? "Owner" : "Member"}</span>
            {project.manages && !m.owner ? (
              <RowMenu
                label={`More actions for ${m.name}`}
                actions={[
                  { label: "Make owner", onClick: () => onHand(m) },
                  { label: "Remove", danger: true, icon: "delete", onClick: () => onRemove(m) },
                ]}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {project.manages ? <AddMember project={project} onAdded={onChanged} /> : null}
      {!project.manages && project.mine !== false ? (
        <div className="border-t border-line px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onLeave}>
            Leave this project
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Adding someone: only members of this workspace who are not in the project yet. */
function AddMember({ project, onAdded }: { project: ProjectDetail; onAdded: () => void }) {
  const toast = useToast();
  const workspaceId = useResolvedWorkspace();
  const people = useAsync(() => (workspaceId ? listMembers(workspaceId) : new Promise<never>(() => undefined)), [workspaceId]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const inIt = new Set(project.members.map((m) => m.subject));
  const candidates = (people.data ?? []).filter((m) => !inIt.has(m.subject));
  const add = async () => {
    if (!pick) return;
    setBusy(true);
    try {
      await addProjectMember(project.id, pick);
      const who = candidates.find((m) => m.subject === pick)?.email ?? "them";
      toast.success(`Added ${who}. They see everything in “${project.name}” now.`);
      setPick("");
      onAdded();
    } catch (e) {
      toast.error(said(e));
    } finally {
      setBusy(false);
    }
  };
  if (people.error) return <p className="border-t border-line px-4 py-3 text-caption text-warn">The workspace's members could not be read: {people.error}</p>;
  return (
    <div className="flex gap-2 border-t border-line px-4 py-3">
      <Select aria-label="Add a member" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || !candidates.length} className="min-w-0 flex-1">
        <option value="">{candidates.length ? "Choose a workspace member" : people.loading ? "Loading…" : "Everyone here is already in it"}</option>
        {candidates.map((m) => (
          <option key={m.subject} value={m.subject}>
            {m.email ?? m.subject}
          </option>
        ))}
      </Select>
      <Button size="sm" variant="ghost" disabled={!pick || busy} onClick={() => void add()}>
        {busy ? "Adding…" : "Add"}
      </Button>
    </div>
  );
}
