"use client";

/**
 * Workflow references (server pi-builder/reference-state.ts): the saved workflows a Workflow Builder chat learns from.
 *
 * - `@` in the message box opens the picker: this workspace's saved workflows (the server decides which).
 * - Each pick is a chip above the box, pinned to one SAVED version ("saved 3"). Clicking it shows the card exactly as
 *   Forge sees it and every saved version; a newer one is offered on the chip ("saved 4 available"), never taken on its
 *   own. A deleted workflow's chip says so: Forge still reads its copy.
 * - In Forge Agent the chips stay, greyed: references are used in Workflow Builder only.
 *
 * A list that could not be read says so; it is never shown as "nothing to reference".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Close, Link as LinkIcon, RefreshCw } from "@/components/ui/icons";
import {
  MAX_REFERENCES,
  addReference,
  listReferenceable,
  listReferences,
  removeReference,
  setReferenceVersion,
  type ChatMode,
  type Referenceable,
  type WorkflowReference,
} from "@/lib/pi-builder";

function message(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const body = m.replace(/^\d{3}\s*/, "");
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    return parsed.message ?? parsed.error ?? body;
  } catch {
    return body || "Something went wrong.";
  }
}

/** The chat's references, re-read whenever `tick` moves (a `references` event, a save). */
export function useWorkflowReferences(workspaceId: string, sessionId: string | null, tick: number) {
  const [refs, setRefs] = useState<WorkflowReference[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId) return;
    try {
      setRefs(await listReferences(workspaceId, sessionId));
      setError(null);
    } catch (e) {
      setError(`Could not load the referenced workflows: ${message(e)}`);
    }
  }, [workspaceId, sessionId]);

  useEffect(() => {
    void reload();
  }, [reload, tick]);

  const run = useCallback(
    async (work: () => Promise<WorkflowReference[]>) => {
      try {
        setRefs(await work());
        setError(null);
        return true;
      } catch (e) {
        setError(message(e));
        return false;
      }
    },
    [],
  );

  return {
    refs,
    error,
    dismissError: () => setError(null),
    add: (flowId: string) => run(() => addReference(workspaceId, sessionId!, flowId)),
    setVersion: (refId: string, revision: number) => run(() => setReferenceVersion(workspaceId, sessionId!, refId, revision)),
    remove: (refId: string) => run(() => removeReference(workspaceId, sessionId!, refId)),
  };
}

function savedOn(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The chips above the message box, with each one's card and version list. */
export function ReferenceChips({
  refs,
  error,
  mode,
  busy,
  onDismissError,
  onSetVersion,
  onRemove,
}: {
  refs: WorkflowReference[] | null;
  error: string | null;
  mode: ChatMode;
  busy: boolean;
  onDismissError: () => void;
  onSetVersion: (refId: string, revision: number) => Promise<boolean>;
  onRemove: (refId: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const list = refs ?? [];
  if (!list.length && !error) return null;
  const agent = mode === "agent";
  const shown = list.find((r) => r.id === open) ?? null;

  return (
    <div className="mb-2 space-y-2">
      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-text">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={onDismissError} aria-label="Dismiss" className="text-dim hover:text-text">
            <Close s={12} />
          </button>
        </div>
      ) : null}
      {list.length ? (
        <ul className="flex flex-wrap items-center gap-2" aria-label="Referenced workflows">
          {list.map((r) => (
            <li
              key={r.id}
              className={`flex max-w-full items-center gap-1.5 rounded-full border bg-surface py-1 pl-2.5 pr-1 text-[12px] ${
                r.deleted ? "border-warn/40" : "border-line"
              } ${agent ? "opacity-60" : ""}`}
            >
              <button
                type="button"
                onClick={() => setOpen(open === r.id ? null : r.id)}
                aria-expanded={open === r.id}
                title={agent ? "Used in Workflow Builder only" : "Show what Forge sees, and its saved versions"}
                className="flex min-w-0 items-center gap-1.5 text-left"
              >
                <LinkIcon s={12} />
                <span className="truncate font-medium text-text" title={r.name}>{r.name}</span>
                <span className="shrink-0 text-dim">· {r.deleted ? "deleted" : r.label}</span>
              </button>
              {r.newer && !r.deleted ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onSetVersion(r.id, r.newer!)}
                  title={`Use saved ${r.newer} instead of saved ${r.revision}`}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20 disabled:opacity-50"
                >
                  <RefreshCw s={11} /> saved {r.newer} available
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (open === r.id) setOpen(null);
                  void onRemove(r.id);
                }}
                aria-label={`Stop referencing ${r.name}`}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-dim hover:bg-surface-2 hover:text-text disabled:opacity-50"
              >
                <Close s={11} />
              </button>
            </li>
          ))}
          {agent ? <li className="text-[11.5px] text-dim">Used in Workflow Builder only</li> : null}
        </ul>
      ) : null}
      {shown ? (
        <ReferenceCard
          reference={shown}
          busy={busy}
          onClose={() => setOpen(null)}
          onSetVersion={(rev) => onSetVersion(shown.id, rev)}
        />
      ) : null}
    </div>
  );
}

function ReferenceCard({
  reference: r,
  busy,
  onClose,
  onSetVersion,
}: {
  reference: WorkflowReference;
  busy: boolean;
  onClose: () => void;
  onSetVersion: (revision: number) => Promise<boolean>;
}) {
  const latest = r.versions[r.versions.length - 1]?.revision ?? null;
  return (
    <section aria-label={`Reference: ${r.name}`} className="rounded-xl border border-line bg-surface p-3 text-[12px]">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1 font-medium text-text">{r.name}</div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-dim hover:text-text">
          <Close s={12} />
        </button>
      </div>
      {r.deleted ? (
        <p className="mb-2 text-warn">This workflow has been deleted. Forge still reads the copy of saved {r.revision}.</p>
      ) : (
        <fieldset className="mb-3">
          <legend className="mb-1 text-[11px] uppercase tracking-wide text-dim">Saved versions</legend>
          <ul className="space-y-1">
            {[...r.versions].reverse().map((v) => (
              <li key={v.revision}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name={`ref-${r.id}`}
                    checked={v.revision === r.revision}
                    disabled={busy}
                    onChange={() => void onSetVersion(v.revision)}
                  />
                  <span className="text-text">{v.label}</span>
                  <span className="text-dim">
                    {savedOn(v.savedAt)}
                    {v.revision === latest ? " · latest" : ""}
                    {v.revision === r.revision ? " · in use" : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <div className="mb-1 text-[11px] uppercase tracking-wide text-dim">What Forge sees</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono text-[11.5px] leading-relaxed text-text">
        {r.cardMd}
      </pre>
    </section>
  );
}

/**
 * The `@` picker over the message box. Lists the workspace's saved workflows this chat may still reference, filtered
 * by what follows the `@`. The parent forwards key presses through `keys` so ↑ ↓ Enter Esc work from the text box.
 */
export function ReferencePicker({
  workspaceId,
  sessionId,
  query,
  mode,
  count,
  keys,
  onPick,
  onClose,
}: {
  workspaceId: string;
  sessionId: string;
  query: string;
  mode: ChatMode;
  count: number;
  keys: { current: ((e: KeyboardEvent<HTMLTextAreaElement>) => boolean) | null };
  onPick: (flowId: string) => void;
  onClose: () => void;
}) {
  const [all, setAll] = useState<Referenceable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const blocked = mode === "agent" ? "agent" : count >= MAX_REFERENCES ? "full" : null;

  useEffect(() => {
    if (blocked) return;
    let live = true;
    listReferenceable(workspaceId, sessionId)
      .then((w) => live && setAll(w))
      .catch((e) => live && setError(`Could not load the saved workflows: ${message(e)}`));
    return () => {
      live = false;
    };
  }, [workspaceId, sessionId, blocked, count]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? []).filter((w) => !q || w.name.toLowerCase().includes(q)).slice(0, 8);
  }, [all, query]);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setActive(0), [query]);

  keys.current = (e) => {
    if (e.key === "Escape") {
      onClose();
      return true;
    }
    if (blocked || !shown.length) return false;
    if (e.key === "ArrowDown") {
      setActive((a) => (a + 1) % shown.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      setActive((a) => (a - 1 + shown.length) % shown.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      onPick(shown[Math.min(active, shown.length - 1)]!.flowId);
      return true;
    }
    return false;
  };

  return (
    <div role="dialog" aria-label="Reference a saved workflow" className="mb-2 rounded-xl border border-line bg-surface p-2 text-[12px] shadow-lg">
      <div className="px-1.5 pb-1.5 text-[11px] text-dim">Learn from a saved workflow of this workspace</div>
      {blocked === "agent" ? (
        <p className="px-1.5 py-1 text-muted">Referenced workflows are used in Workflow Builder only. Turn off Forge Agent to add one.</p>
      ) : blocked === "full" ? (
        <p className="px-1.5 py-1 text-muted">This chat already references {MAX_REFERENCES} workflows. Remove one to add another.</p>
      ) : error ? (
        <p role="alert" className="px-1.5 py-1 text-warn">{error}</p>
      ) : all === null ? (
        <p className="px-1.5 py-1 text-muted">Loading…</p>
      ) : !shown.length ? (
        <p className="px-1.5 py-1 text-muted">
          {all.length ? `No saved workflow matches "${query}".` : "There are no other saved workflows in this workspace yet."}
        </p>
      ) : (
        <ul ref={listRef} role="listbox" aria-label="Saved workflows">
          {shown.map((w, i) => (
            <li key={w.flowId} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(w.flowId)}
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left ${i === active ? "bg-surface-2" : ""}`}
              >
                <LinkIcon s={12} />
                <span className="min-w-0 flex-1 truncate text-text">{w.name}</span>
                <span className="shrink-0 text-dim">
                  {w.latestLabel}
                  {w.savedAt ? ` · ${savedOn(w.savedAt)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
