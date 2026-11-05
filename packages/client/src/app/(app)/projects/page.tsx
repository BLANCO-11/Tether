// src/app/(app)/projects/page.tsx — projects (sharing-boundaries phase 5).
//
// A project is a smaller circle inside the workspace. What lives in it is seen by its members (and Admins), and every
// Forge chat in it starts with its shared instructions. The server lists only the projects this person is in (every
// one for an Admin), so this page shows exactly what it was sent.
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { createProject, listProjects } from "@/lib/api";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { Folder, Plus } from "@/components/ui/icons";
import { useCan } from "@/components/access/Can";

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

export default function ProjectsPage() {
  const projects = useAsync(listProjects, []);
  // An Observer builds nothing, so makes no project. Unknown still shows the button: the server decides.
  const mayCreate = !useCan("flows.write").denied;
  const [creating, setCreating] = useState(false);

  return (
    <Page>
      <PageHeader
        eyebrow="Build"
        title="Projects"
        purpose="A smaller circle inside this workspace. What lives in a project is seen by its members, and its chats start with its shared instructions."
        actions={mayCreate ? [{ label: "New project", onClick: () => setCreating(true), icon: <Plus s={14} /> }] : undefined}
      />
      <Zone name="content">
        {projects.error ? (
          <Notice tone="warn" title="The projects could not be read">{projects.error}</Notice>
        ) : projects.loading && !projects.data ? (
          <Skeleton />
        ) : !projects.data?.length ? (
          <section className="pane">
            <EmptyState icon={<Folder />} title="You are not in any project yet. Make one, or ask a project's owner to add you." />
          </section>
        ) : (
          <section className="pane overflow-hidden" aria-label="Projects">
            <ul className="divide-y divide-line">
              {projects.data.map((p) => (
                <li key={p.id}>
                  <Link href={`/projects/${p.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                    <span className="shrink-0 text-dim">
                      <Folder s={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium">{p.name}</span>
                      {p.description ? <span className="block truncate text-caption text-muted">{p.description}</span> : null}
                    </span>
                    <span className="shrink-0 text-caption text-muted">
                      {p.members ?? 0} member{p.members === 1 ? "" : "s"}
                      {p.owned ? " · yours" : p.mine === false ? " · you are not in it (Admin)" : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Zone>
      <NewProject open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

/** Making a project: a name, a line about it, and the instructions its chats start with. You are its first member. */
function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = name.trim();
  const save = async () => {
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await createProject({ name: clean, description: description.trim() || null, instructions });
      toast.success(`Made “${p.name}”. Add the people who work on it.`);
      router.push(`/projects/${p.id}`);
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New project">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Name">
          <Input aria-label="Project name" value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} invalid={!!error} />
        </Field>
        <Field label="What it is for" hint="Optional. One line people see in the list.">
          <Input aria-label="What it is for" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Shared instructions" hint="Optional. Every Forge chat in the project starts with these: conventions, names, who is who.">
          <Textarea aria-label="Shared instructions" mono={false} rows={4} value={instructions} maxLength={20000} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <p className="text-caption text-muted">You are its owner and first member. Only the people you add see what is in it.</p>
        {error ? <p className="text-caption text-danger">{error}</p> : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!clean || busy}>
            {busy ? "Making…" : "Make project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
