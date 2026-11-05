// src/app/(app)/chats/page.tsx — saved chats.
//
// Every conversation with Forge is saved from its first message, whether or not it built a workflow, and kept until
// someone deletes it. The whole workspace sees them (per-person privacy comes later). A chat that built a workflow
// opens on that workflow's builder; one that did not opens where it stopped. Delete and rename are offered only where
// the server said this person may: the one who started the chat, or a workspace admin.
//
// Several chats can be deleted at once. Off by default: "Select" turns on a checkbox on each chat this person
// may delete, and "Select all" picks every such chat the search and filter currently SHOW (never a hidden one). The
// filter row then shows "Delete (N)"; "Clear all" (or Esc) unticks everything and leaves. Each is deleted through the same single-chat
// route, so each keeps its own permission check; a failure keeps that chat selected and the toast names why.
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useResolvedWorkspace } from "@/lib/workspace";
import { useAsync } from "@/lib/hooks";
import { listWorkspaces } from "@/lib/api";
import { useToast } from "@/lib/toast";
import {
  CHAT_FILTERS,
  chatHref,
  chatMatches,
  deletePiChat,
  grantChatShare,
  isUnsavedDraft,
  listChatShares,
  listPiChats,
  renamePiChat,
  revokeChatShare,
  type ChatFilter,
  type PiChatSummary,
} from "@/lib/pi-builder";
import { bulkSentence, runEach } from "@/lib/bulk";
import { formatWhen } from "@/lib/audit";
import { listMembers } from "@/lib/api";
import { Page, Zone } from "@/components/layout/Page";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/ui/Confirm";
import { Skeleton } from "@/components/ui/Skeleton";
import { Field, Input, Select } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { RowMenu, type RowAction } from "@/components/ui/RowMenu";
import { Chat, Search, Send, Trash } from "@/components/ui/icons";
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
  // The workspace's name for the new-chat bar, read the way the Topbar switcher reads it; unknown or failed → plain "New chat".
  const workspaces = useAsync(listWorkspaces);
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
  const [sharing, setSharing] = useState<PiChatSummary | null>(null);
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [multiline, setMultiline] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  // Auto-grow the composer, and switch pill -> box when the text no longer fits one line. jsdom has no layout
  // (scrollHeight 0), so there only a newline switches it. Once wrapped it stays a box until emptied, so the wider
  // box does not flip back and forth around the wrap point.
  useLayoutEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const overflow = el.scrollHeight > 0 && el.scrollHeight > lineHeight + 4;
    setMultiline((was) => draft.includes("\n") || overflow || (was && draft.length > 0));
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
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

  const filterBtn = (on: boolean) => `rounded-full px-2.5 py-0.5 text-[12px] ${on ? "bg-accent-bg text-accent" : "text-muted hover:text-text"}`;
  const newChatName = workspaces.data?.find((w) => w.id === workspaceId)?.name;

  return (
    <Page>
      <header className="flex items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-muted">
            <Chat s={18} />
          </span>
          <h1 className="text-xl font-medium text-text">Chats</h1>
        </div>
      </header>
      <Zone name="content">
        {mayBuild ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) router.push(`/chats/new?q=${encodeURIComponent(draft.trim())}`);
            }}
            data-multiline={multiline ? "true" : "false"}
            className={`mx-auto mb-4 w-full border border-line bg-surface-2/40 transition-[border-radius,padding] duration-200 focus-within:border-accent/50 md:w-[62%] ${
              multiline ? "flex flex-col rounded-3xl p-4" : "flex h-12 items-center rounded-full pl-5 pr-1.5"
            }`}
          >
            <textarea
              ref={draftRef}
              aria-label="New chat"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter makes a line — the same idiom as the home composer.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim()) router.push(`/chats/new?q=${encodeURIComponent(draft.trim())}`);
                }
              }}
              rows={1}
              placeholder={newChatName ? `New chat in ${newChatName}…` : "New chat…"}
              className="block max-h-60 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-body leading-6 text-text placeholder:text-dim focus:outline-none"
            />
            <div className={multiline ? "mt-2 flex items-center justify-end" : "flex shrink-0 items-center"}>
              <button
                type="submit"
                aria-label="Send"
                disabled={!draft.trim()}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white disabled:opacity-40"
              >
                <Send s={16} />
              </button>
            </div>
          </form>
        ) : null}
        {chats.error ? (
          <Notice tone="warn" title="The chats could not be read">{chats.error}</Notice>
        ) : chats.loading && !chats.data ? (
          <Skeleton />
        ) : !chats.data?.length ? (
          <EmptyState icon={<Chat />} title="No chats yet. A conversation with Forge is saved here from its first message." />
        ) : (
          <section aria-label="Saved chats">
            <div className="flex flex-wrap items-center gap-x-1 gap-y-2 px-1 pb-3">
              <div role="radiogroup" aria-label="Show" className="flex flex-wrap items-center gap-1">
                {CHAT_FILTERS.map((f) => (
                  <button key={f.key} type="button" role="radio" aria-checked={only === f.key} onClick={() => setOnly(f.key)} className={filterBtn(only === f.key)}>
                    {f.label}
                  </button>
                ))}
              </div>
              <span className="mx-2 h-5 w-px bg-line" aria-hidden="true" />
              <span role="radiogroup" aria-label="Where it lives" className="flex flex-wrap items-center gap-1">
                {WHERE_FILTERS.map((w) => (
                  <button key={w.key} type="button" role="radio" aria-checked={where === w.key} onClick={() => setWhere(w.key)} className={filterBtn(where === w.key)}>
                    {w.label}
                  </button>
                ))}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                {showSelect ? (
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
                ) : null}
                {othersListed ? (
                  <span role="radiogroup" aria-label="Whose chats" className="flex gap-0.5 rounded-full border border-line p-0.5">
                    {(["everyone", "mine"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={whose === k}
                        onClick={() => setWhose(k)}
                        className={`rounded-full px-3 py-0.5 text-[12px] ${whose === k ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`}
                      >
                        {k === "everyone" ? "Everyone's" : "Mine"}
                      </button>
                    ))}
                  </span>
                ) : null}
                {/* The Input's own control class is full-width, so the width is set on a wrapper. It stays in the DOM and only its width and opacity animate. */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label="Search"
                    onClick={() => {
                      setSearchOpen(true);
                      searchRef.current?.querySelector("input")?.focus();
                    }}
                    className="shrink-0 rounded-full p-1 text-dim hover:text-text"
                  >
                    <Search s={14} />
                  </button>
                  <div ref={searchRef} className={`overflow-hidden transition-[width,opacity] duration-200 ease-out ${searchOpen || query ? "w-48 opacity-100" : "w-0 opacity-0"}`}>
                    <Input
                      aria-label="Search chats"
                      placeholder="Search by title, workflow or person"
                      value={query}
                      tabIndex={searchOpen || query ? 0 : -1}
                      onChange={(e) => setQuery(e.target.value)}
                      onFocus={() => setSearchOpen(true)}
                      onBlur={() => {
                        if (!query) setSearchOpen(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setQuery("");
                          setSearchOpen(false);
                          e.currentTarget.blur();
                        }
                      }}
                      className="h-8 w-full min-w-0 rounded-none border-0 border-b border-line bg-transparent px-0"
                    />
                  </div>
                </div>
                {deletable.size > 0 && !showSelect ? (
                  <button type="button" onClick={() => setSelecting(true)} className="rounded-full px-2.5 py-0.5 text-[12px] text-muted hover:text-text">
                    Select
                  </button>
                ) : null}
              </div>
            </div>
            <ul className="divide-y divide-line/60">
              {shown.map((c) => (
                <li key={c.id} className={`group flex items-center gap-3 rounded-none px-3 py-3 hover:bg-surface-2/50 ${selected.has(c.id) ? "bg-accent-bg/40" : ""}`}>
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
                  <Link
                    href={chatHref(c)}
                    title={c.flowId ? `Built ${c.flowName ?? "a workflow"}` : undefined}
                    className="flex min-w-0 flex-1 items-center gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-body font-medium text-text">{c.title}</span>
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
                      <div className="mt-0.5 truncate text-caption text-muted">
                        {c.goal
                          ? c.goal
                          : `Your conversation from ${formatWhen(c.createdAt)} · ${c.messageCount} message${c.messageCount === 1 ? "" : "s"}${c.flowId ? ` · built ${c.flowName ?? "a workflow"}` : ""}`}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-caption text-muted">{formatWhen(c.updatedAt)}</div>
                      <div className="mt-0.5 flex items-center justify-end gap-1.5 text-caption text-muted">
                        <span className={`h-1.5 w-1.5 rounded-full ${c.mine ? "bg-accent" : "bg-dim"}`} aria-hidden="true" />
                        <span>{c.mine ? "You" : (c.createdBy.name ?? "Someone")}</span>
                      </div>
                    </div>
                  </Link>
                  <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                    <ChatMenu
                      chat={c}
                      onRename={() => setRenaming(c)}
                      onDelete={() => setDeleting(c)}
                      onMove={() => setMoving(c)}
                      onShare={() => setSharing(c)}
                    />
                  </span>
                </li>
              ))}
              {!shown.length ? (
                <li className="px-4 py-6 text-center text-caption text-muted">{q ? `No chat matches “${query}”.` : "No chats of this kind."}</li>
              ) : null}
            </ul>
          </section>
        )}
      </Zone>
      <ShareChatDialog
        chat={sharing}
        workspaceId={workspaceId}
        onClose={() => setSharing(null)}
        onChanged={() => toast.success("Share updated.")}
      />
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
  onShare,
}: {
  chat: PiChatSummary;
  onRename: () => void;
  onDelete: () => void;
  onMove: () => void;
  onShare: () => void;
}) {
  const actions: RowAction[] = [];
  if (chat.canRename) actions.push({ label: "Change name", icon: "edit", onClick: onRename });
  // Where it lives (Move) vs who may read it by name (Share with…) — Phase 5; Move alone never named a person.
  if (chat.canChange) {
    actions.push({ label: "Move…", onClick: onMove });
    actions.push({ label: "Share with…", onClick: onShare });
  }
  if (chat.canDelete) actions.push({ label: "Delete", icon: "delete", danger: true, onClick: onDelete });
  if (!actions.length) return null;
  return <RowMenu actions={actions} label={`Actions for ${chat.title}`} />;
}

/** Grant / revoke per-person read access (Phase 5) — People-listed members only; no public link. */
function ShareChatDialog({
  chat,
  workspaceId,
  onClose,
  onChanged,
}: {
  chat: PiChatSummary | null;
  workspaceId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const members = useAsync(() => (workspaceId ? listMembers(workspaceId) : new Promise<never>(() => undefined)), [workspaceId]);
  const [shares, setShares] = useState<Array<{ subject: string }>>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chat || !workspaceId) return;
    setError(null);
    setPick("");
    void listChatShares(workspaceId, chat.id)
      .then(setShares)
      .catch((e) => setError(said(e)));
  }, [chat, workspaceId]);

  const sharedSubjects = new Set(shares.map((s) => s.subject));
  const candidates = (members.data ?? []).filter(
    (m) => m.subject !== chat?.createdBy.subject && !sharedSubjects.has(m.subject),
  );

  const add = async () => {
    if (!chat || !workspaceId || !pick) return;
    setBusy(true);
    setError(null);
    try {
      await grantChatShare(workspaceId, chat.id, pick);
      setShares(await listChatShares(workspaceId, chat.id));
      setPick("");
      onChanged();
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (subject: string) => {
    if (!chat || !workspaceId) return;
    try {
      await revokeChatShare(workspaceId, chat.id, subject);
      setShares(await listChatShares(workspaceId, chat.id));
      onChanged();
    } catch (e) {
      toast.error(said(e));
    }
  };

  return (
    <Modal open={!!chat} onClose={onClose} title={chat ? `Share “${chat.title}”` : "Share"}>
      <p className="text-caption text-muted">They can read this chat. Only you can continue it. No public link.</p>
      {error ? <Notice tone="danger" title="Could not share" className="mt-3">{error}</Notice> : null}
      <ul className="mt-3 flex flex-col gap-1">
        {shares.length === 0 ? <li className="text-caption text-muted">Nobody yet.</li> : null}
        {shares.map((s) => {
          const name = (members.data ?? []).find((m) => m.subject === s.subject)?.email ?? s.subject;
          return (
            <li key={s.subject} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-body">
              <span className="truncate">{name}</span>
              <button type="button" className="text-caption font-medium text-danger hover:underline" onClick={() => void remove(s.subject)}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex gap-2">
        <Select aria-label="Person to share with" className="min-w-0 flex-1" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || !candidates.length}>
          <option value="">{candidates.length ? "Choose someone…" : "Everyone who can be added already has it"}</option>
          {candidates.map((m) => (
            <option key={m.subject} value={m.subject}>
              {m.email || m.subject}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!pick || busy} onClick={() => void add()}>
          {busy ? "…" : "Share"}
        </Button>
      </div>
    </Modal>
  );
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
