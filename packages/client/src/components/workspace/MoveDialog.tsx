// src/components/workspace/MoveDialog.tsx — where a workflow or a chat lives (sharing-boundaries phase 5).
//
// An item lives in ONE place, and the place decides who sees it: My space (only you), a project (its members), or
// the Workspace (everyone). Choosing a place asks the server what the move would change BEFORE it happens — who would
// stop seeing it, who turned it on for themselves and would lose it, what uses it — and says so in plain sentences.
// Nothing here decides who may move what: the server refuses, and the refusal is shown as it was said.
"use client";

import { useEffect, useState } from "react";
import { listProjects, moveItem, movePreview } from "@/lib/api";
import type { MovableItem, MovePreview, ProjectSummary } from "@/lib/foundry-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";

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

/** "mine" | "workspace" | "project:<id>", from an item's own fields. */
export function placeKey(item: { visibility?: string | null; projectId?: string | null }): string {
  if (item.projectId) return `project:${item.projectId}`;
  return item.visibility === "public" ? "workspace" : "mine";
}

/** Where it lives, in words, for a pill or a line. */
export function placeLabel(key: string, projects: Array<Pick<ProjectSummary, "id" | "name">> | null | undefined): string {
  if (key === "mine") return "My space";
  if (key === "workspace") return "Workspace";
  const id = key.slice("project:".length);
  const p = projects?.find((x) => x.id === id);
  return p ? p.name : "A project";
}

/** Plain sentences for what the move would change. Exported so the words are tested, not just the rendering. */
export function previewSentences(p: MovePreview, kind: MovableItem["kind"]): string[] {
  const it = kind === "flow" ? "this workflow" : "this chat";
  const out: string[] = [];
  if (p.loses.length) out.push(`${p.loses.length === 1 ? "This person" : "These people"} would stop seeing ${it}: ${p.loses.join(", ")}.`);
  if (p.gains > 0) out.push(`${p.gains} more ${p.gains === 1 ? "person" : "people"} would see ${it}.`);
  if (!p.loses.length && !p.gains) out.push(`The same people see ${it} there.`);
  if (p.turnedOnBy.length) out.push(`${p.turnedOnBy.join(", ")} turned it on for themselves. It would stop running for them, and they are told.`);
  if (p.live && p.narrows) out.push("It runs on its own. Its runs from now on are seen only where it lives.");
  if (p.referencedBy.length) out.push(`Chats that use it: ${p.referencedBy.join(", ")}.`);
  // Whose account it uses depends on where it lives (My space: its owner's own).
  for (const line of p.runsAs ?? []) out.push(`${line[0]!.toUpperCase()}${line.slice(1)}.`);
  if (p.switchesOff) out.push(p.switchesOff);
  // A chat others see is theirs to READ, its files included; only the person who started it continues it.
  if (kind === "chat" && p.to.kind !== "mine") out.push("They can read it and its files. Only the person who started it continues, renames or deletes it.");
  return out;
}

export function MoveDialog({
  item,
  name,
  current,
  onClose,
  onMoved,
}: {
  /** The item to move, or null when closed. */
  item: MovableItem | null;
  name: string;
  /** Where it lives now (`placeKey`). */
  current: string;
  onClose: () => void;
  /** `label`: where it went, in words. */
  onMoved: (to: string, out: { turnedOff?: boolean }, label: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setTo(null);
    setPreview(null);
    setPreviewError(null);
    setError(null);
    listProjects()
      .then((ps) => setProjects(ps))
      .catch((e) => setProjectsError(said(e)));
  }, [item]);

  useEffect(() => {
    if (!item || !to) return;
    let live = true;
    setPreview(null);
    setPreviewError(null);
    movePreview(item, to)
      .then((p) => live && setPreview(p))
      .catch((e) => live && setPreviewError(said(e)));
    return () => {
      live = false;
    };
  }, [item, to]);

  // The server lists the projects this person is in (every one for an Admin, who may move into any).
  const places: Array<{ key: string; label: string; hint: string }> = [
    { key: "mine", label: "My space", hint: "Only its owner (and Admins)." },
    ...(projects ?? []).map((p) => ({ key: `project:${p.id}`, label: p.name, hint: `Its ${p.members ?? 0} member${p.members === 1 ? "" : "s"}.` })),
    { key: "workspace", label: "Workspace", hint: "Everyone in this workspace." },
  ];

  const move = async () => {
    if (!item || !to) return;
    setBusy(true);
    setError(null);
    try {
      const out = await moveItem(item, to);
      onMoved(to, out, placeLabel(to, projects));
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={item != null} onClose={onClose} title={`Move “${name}”`}>
      <p className="text-caption text-muted">Where it lives decides who sees it. It lives in {placeLabel(current, projects)} now.</p>
      {projectsError ? (
        <Notice tone="warn" title="Your projects could not be read">{projectsError}</Notice>
      ) : null}
      <div role="radiogroup" aria-label="Move to" className="mt-3 flex flex-col gap-1.5">
        {places.map((p) => (
          <label key={p.key} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 ${to === p.key ? "border-accent bg-accent-bg/40" : "border-line"} ${p.key === current ? "opacity-60" : ""}`}>
            <input
              type="radio"
              name="move-to"
              className="mt-1 accent-accent"
              checked={to === p.key}
              disabled={p.key === current || busy}
              onChange={() => setTo(p.key)}
              aria-label={p.label}
            />
            <span>
              <span className="text-body font-medium">{p.label}</span>
              {p.key === current ? <span className="text-caption text-muted"> · where it is now</span> : null}
              <span className="block text-caption text-muted">{p.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {to ? (
        <div className="mt-4" aria-live="polite">
          {previewError ? (
            <Notice tone="warn" title="Could not check what this changes">{previewError}</Notice>
          ) : !preview ? (
            <p className="text-caption text-muted">Checking who would see it…</p>
          ) : (
            <ul className="flex flex-col gap-1 text-caption">
              {previewSentences(preview, item!.kind).map((s) => (
                <li key={s} className={preview.narrows && s.includes("stop") ? "text-warn" : "text-text"}>
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-caption text-danger">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={!to || !preview || busy} onClick={() => void move()}>
          {busy ? "Moving…" : "Move"}
        </Button>
      </div>
    </Modal>
  );
}
