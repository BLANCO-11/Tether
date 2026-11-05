// src/app/(app)/chats/page.tsx — saved chats.
//
// Every conversation with Forge is saved from its first message, whether or not it built a workflow, and kept until
// someone deletes it. The whole workspace sees them (per-person privacy comes later). A chat that built a workflow
// opens on that workflow's builder; one that did not opens where it stopped. Delete and rename are offered only where
// the server said this person may: the one who started the chat, or a workspace admin.
//
// Several chats can be deleted at once. Off by default: "Select" turns on a checkbox on each chat this person may delete,
// and "Select all" picks every such chat the search and filter currently SHOW (never a hidden one). "Select" becomes
// "Delete (N)"; "Clear all" (or Esc) unticks everything and leaves. Each is deleted through the same single-chat
// route, so each keeps its own permission check; a failure keeps that chat selected and the toast names why.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useResolvedWorkspace } from "@/lib/workspace";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { CHAT_FILTERS, chatHref, chatMatches, deletePiChat, isUnsavedDraft, listPiChats, renamePiChat, type ChatFilter, type PiChatSummary } from "@/lib/pi-builder";
import { bulkSentence, runEach } from "@/lib/bulk";
import { formatWhen } from "@/lib/audit";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/ui/Confirm";
import { Skeleton } from "@/components/ui/Skeleton";
import { Field, Input } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { RowMenu, type RowAction } from "@/components/ui/RowMenu";
import { Chat, Plus, Search, Trash } from "@/components/ui/icons";
import { useCan } from "@/components/access/Can";
import { MoveDialog, placeKey } from "@/components/workspace/MoveDialog";
import { WherePill } from "@/components/workspace/WherePill";
import { WHERE_FILTERS, inWhere, type WhereFilter } from "@/lib/places";

/** The server's sentence out of a refused request (`403 {"message": …}`), or the error as it is. */
function said(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const body = text.replace(/^\d{3}\s*/, "");
  try {
    return (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    return body;
  }
}

export default function ChatsPage() {
  // The real id, never the placeholder the context holds before it resolves: null waits (useResolvedWorkspace).
  const workspaceId = useResolvedWorkspace();
  const toast = useToast();
  const chats = useAsync(() => (workspaceId ? listPiChats(workspaceId) : new Promise<never>(() => undefined)), [workspaceId]);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<ChatFilter>("all");
  // Where it lives (sharing-boundaries phase 6): My space, the projects, or the Workspace.
  const [where, setWhere] = useState<WhereFilter>("any");
  // rbac-observability: an Admin is listed everybody's chats and can narrow to their own. Offered only when the list
  // holds a chat that is not theirs — everyone else only ever sees their own.
  const [whose, setWhose] = useState<"everyone" | "mine">("everyone");
  const othersListed = (chats.data ?? []).some((c) => c.mine === false);
  const mayBuild = !useCan("flows.write").denied;
  const [deleting, setDeleting] = useState<PiChatSummary | null>(null);
  const [renaming, setRenaming] = useState<PiChatSummary | null>(null);
  const [moving, setMoving] = useState<PiChatSummary | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const q = query.trim().toLowerCase();
  const shown = (chats.data ?? []).filter(
    (c) =>
      chatMatches(c, only) &&
      inWhere(c, where) &&
      (whose === "everyone" || !othersListed || c.mine !== false) &&
      (!q || c.title.toLowerCase().includes(q) || (c.flowName ?? "").toLowerCase().includes(q) || (c.createdBy.name ?? "").toLowerCase().includes(q)),
  );

  // Selection only ever holds chats that are still listed and deletable (a reload drops the rest).
  const deletable = useMemo(() => new Set((chats.data ?? []).filter((c) => c.canDelete).map((c) => c.id)), [chats.data]);
  useEffect(() => {
    setSelected((cur) => {
      const kept = [...cur].filter((id) => deletable.has(id));
      return kept.length === cur.size ? cur : new Set(kept);
    });
  }, [deletable]);
  const shownDeletable = shown.filter((c) => c.canDelete);
  const shownSelected = shownDeletable.filter((c) => selected.has(c.id)).length;
  const allShownSelected = shownDeletable.length > 0 && shownSelected === shownDeletable.length;
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
      for (const c of shownDeletable) {
        if (allShownSelected) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });

  const picked = (chats.data ?? []).filter((c) => selected.has(c.id));
  const showSelect = selecting && deletable.size > 0;
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

  const removeSelected = async () => {
    if (!workspaceId || !picked.length) return;
    setBulkBusy(true);
    try {
      const out = await runEach(picked, (c) => deletePiChat(workspaceId, c.id), said);
      (out.failed.length ? toast.warn : toast.success)(bulkSentence("Deleted", ["chat", "chats"], picked.length, out));
      setSelected(new Set(out.failed.map((f) => f.item.id)));
      if (!out.failed.length) setSelecting(false);
    } finally {
      setBulkBusy(false);
      chats.reload();
    }
  };

  const remove = async (c: PiChatSummary) => {
    try {
      if (!workspaceId) return;
      await deletePiChat(workspaceId, c.id);
      toast.success(`Deleted "${c.title}"`);
      chats.reload();
    } catch (e) {
      toast.error(`Could not delete the chat: ${said(e)}`);
    }
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Build"
        title="Chats"
        purpose="Every conversation with Forge, saved from its first message. Open one to carry on where it stopped."
        actions={mayBuild ? [{ label: "New chat", href: "/chats/new", icon: <Plus s={14} /> }] : undefined}
      />
      <Zone name="content">
        {chats.error ? (
          <Notice tone="warn" title="The chats could not be read">{chats.error}</Notice>
        ) : chats.loading && !chats.data ? (
          <Skeleton />
        ) : !chats.data?.length ? (
          <section className="pane">
            <EmptyState icon={<Chat />} title="No chats yet. A conversation with Forge is saved here from its first message." />
          </section>
        ) : (
          <section className="pane overflow-hidden" aria-label="Saved chats">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              {/* The Input's own control class is full-width, so the width is set on a wrapper. */}
              <div className="flex w-full items-center gap-2 sm:w-64">
                <span className="shrink-0 text-dim">
                  <Search s={14} />
                </span>
                <Input
                  aria-label="Search chats"
                  placeholder="Search by title, workflow or person"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-8 w-full min-w-0"
                />
              </div>
              {deletable.size ? (
                showSelect ? (
                  <div className="flex shrink-0 items-center gap-3 whitespace-nowrap" role="group" aria-label="Selected chats">
                    <label className="flex items-center gap-2 text-caption text-muted">
                      <input
                        ref={selectAll}
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer accent-accent"
                        checked={allShownSelected}
                        disabled={!shownDeletable.length || bulkBusy}
                        onChange={toggleAllShown}
                        aria-label="Select all chats shown"
                      />
                      Select all
                    </label>
                    <span className="text-caption tabular-nums text-text">{selected.size} selected</span>
                    <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={leaveSelecting}>
                      Clear all
                    </Button>
                    <Button variant="danger" size="sm" disabled={bulkBusy || selected.size === 0} onClick={() => setConfirmBulk(true)}>
                      <Trash s={14} /> {bulkBusy ? "Deleting…" : selected.size ? `Delete (${selected.size})` : "Delete"}
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setSelecting(true)}>
                    Select
                  </Button>
                )
              ) : null}
            </div>
            <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2">
              {CHAT_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="radio"
                  aria-checked={only === f.key}
                  onClick={() => setOnly(f.key)}
                  className={`rounded-full px-2.5 py-0.5 text-[12px] ${only === f.key ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-2 hover:text-text"}`}
                >
                  {f.label}
                </button>
              ))}
              <span role="radiogroup" aria-label="Where it lives" className="flex flex-wrap gap-1.5 border-l border-line pl-2">
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
              </span>
              {othersListed ? (
                <span role="radiogroup" aria-label="Whose chats" className="ml-auto flex gap-1.5">
                  {(["everyone", "mine"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={whose === k}
                      onClick={() => setWhose(k)}
                      className={`rounded-full px-2.5 py-0.5 text-[12px] ${whose === k ? "bg-accent-bg text-accent" : "text-muted hover:bg-surface-2 hover:text-text"}`}
                    >
                      {k === "everyone" ? "Everyone's" : "Mine"}
                    </button>
                  ))}
                </span>
              ) : null}
            </div>
            <ul className="divide-y divide-line">
              {shown.map((c) => (
                <li key={c.id} className={`flex items-center gap-3 px-4 py-3 ${selected.has(c.id) ? "bg-accent-bg/40" : ""}`}>
                  {showSelect ? (
                    <span className="flex w-4 shrink-0 justify-center">
                      {c.canDelete ? (
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-accent"
                          checked={selected.has(c.id)}
                          disabled={bulkBusy}
                          onChange={() => toggle(c.id)}
                          aria-label={`Select ${c.title}`}
                        />
                      ) : null}
                    </span>
                  ) : null}
                  <Link href={chatHref(c)} className="min-w-0 flex-1 hover:text-accent">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-body font-medium">{c.title}</span>
                      {c.mode === "agent" ? (
                        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-muted">Forge Agent</span>
                      ) : null}
                      {/* Where it lives — who reads it — in the same three words everywhere (sharing-boundaries phase 6). */}
                      <WherePill place={placeKey(c)} projectName={c.projectName} />
                      {c.canChange === false ? (
                        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-muted">Read only</span>
                      ) : null}
                      {isUnsavedDraft(c) ? (
                        <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-[10.5px] font-medium text-warn">Draft, not saved</span>
                      ) : null}
                    </div>
                    <div className="truncate text-caption text-muted">
                      {c.mine ? "You" : (c.createdBy.name ?? "Someone")} · {formatWhen(c.updatedAt)} · {c.messageCount} message{c.messageCount === 1 ? "" : "s"}
                      {c.flowId ? <> · built <span className="text-text">{c.flowName ?? "a workflow"}</span></> : null}
                    </div>
                  </Link>
                  <ChatMenu
                    chat={c}
                    onRename={() => setRenaming(c)}
                    onDelete={() => setDeleting(c)}
                    onMove={() => setMoving(c)}
                  />
                </li>
              ))}
              {!shown.length ? (
                <li className="px-4 py-6 text-center text-caption text-muted">{q ? `No chat matches “${query}”.` : "No chats of this kind."}</li>
              ) : null}
            </ul>
          </section>
        )}
      </Zone>
      <MoveDialog
        item={moving ? { kind: "chat", id: moving.id } : null}
        name={moving?.title ?? ""}
        current={moving ? placeKey(moving) : "mine"}
        onClose={() => setMoving(null)}
        onMoved={(_to, _out, label) => {
          toast.success(`Moved "${moving?.title}" to ${label}`);
          setMoving(null);
          chats.reload();
        }}
      />
      <Confirm
        open={deleting != null}
        title="Delete this chat?"
        body={
          deleting
            ? `"${deleting.title}", its files and Forge's memory of it are deleted for everyone.${deleting.flowId ? " The workflow it built stays." : ""}`
            : ""
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => deleting && void remove(deleting)}
        onClose={() => setDeleting(null)}
      />
      <Confirm
        open={confirmBulk}
        title={`Delete ${picked.length} ${picked.length === 1 ? "chat" : "chats"}?`}
        body={
          `Their files and Forge's memory of them are deleted for everyone.` +
          (picked.some((c) => c.flowId) ? " Any workflow they built stays." : "")
        }
        confirmLabel={`Delete ${picked.length}`}
        danger
        onConfirm={() => void removeSelected()}
        onClose={() => setConfirmBulk(false)}
      />
      <RenameChat
        chat={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (title) => {
          if (!workspaceId || !renaming) return;
          await renamePiChat(workspaceId, renaming.id, title);
          toast.success(`Renamed to "${title}"`);
          chats.reload();
        }}
      />
    </Page>
  );
}

/** The ⋮ menu on a chat: what the server said this person may do with it. Nothing to offer → no menu at all. */
function ChatMenu({
  chat,
  onRename,
  onDelete,
  onMove,
}: {
  chat: PiChatSummary;
  onRename: () => void;
  onDelete: () => void;
  onMove: () => void;
}) {
  const actions: RowAction[] = [];
  if (chat.canRename) actions.push({ label: "Change name", icon: "edit", onClick: onRename });
  // Where it lives decides who reads it (sharing-boundaries phase 6): one action, Move, for whoever may change the chat.
  if (chat.canChange) actions.push({ label: "Move…", onClick: onMove });
  if (chat.canDelete) actions.push({ label: "Delete", icon: "delete", danger: true, onClick: onDelete });
  if (!actions.length) return null;
  return <RowMenu actions={actions} label={`Actions for ${chat.title}`} />;
}

/** The rename dialog. Save waits for the server and keeps the dialog open, with the reason, if it refuses. */
function RenameChat({ chat, onClose, onSave }: { chat: PiChatSummary | null; onClose: () => void; onSave: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTitle(chat?.title ?? "");
    setError(null);
  }, [chat]);
  const clean = title.replace(/\s+/g, " ").trim();
  const canSave = !!chat && !busy && clean.length > 0 && clean !== chat.title;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(clean);
      onClose();
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={chat != null} onClose={onClose} title="Change the chat's name">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name">
          <Input
            aria-label="Chat name"
            value={title}
            maxLength={200}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            invalid={!!error}
          />
        </Field>
        {error ? <p className="mt-2 text-caption text-danger">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!canSave}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}
