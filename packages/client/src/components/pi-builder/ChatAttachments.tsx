// Files attached to the Forge chat — context for building (a sample report, a screenshot, a spec), stored with the
// workflow's chat and read by Forge itself. Not the workspace's Files: a workflow cannot read these when it runs.
//
// `useChatAttachments` owns the queue: each file is checked here first (the server still decides), uploaded with its
// own progress, and sent with the next message by name. `AttachmentTray` sits in the composer; `SentAttachments` shows
// what a sent message carried; `DropOverlay` is the target while a file is dragged over the chat.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ATTACH_MAX_FILES,
  attachRefusal,
  removePiAttachment,
  uploadPiAttachment,
  type PiAttachment,
} from "@/lib/pi-builder";
import { Close, Download, FileDoc, Image as ImageIcon, Upload } from "@/components/ui/icons";

export type PendingAttachment = {
  key: string;
  name: string;
  size: number;
  type: string;
  /** 0–1 while uploading. */
  progress: number;
  state: "uploading" | "ready" | "failed";
  error?: string;
  /** The name the server stored it under — what the message sends. */
  stored?: PiAttachment;
  abort?: () => void;
};

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const isImage = (type: string, name: string) => type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(name);

export function useChatAttachments(workspaceId: string, sessionId: string | null) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(pending);
  live.current = pending;

  const patch = useCallback((key: string, p: Partial<PendingAttachment>) => {
    setPending((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  }, []);

  const add = useCallback(
    (files: FileList | File[]) => {
      if (!sessionId) return;
      const list = Array.from(files);
      if (!list.length) return;
      const refusals: string[] = [];
      const room = ATTACH_MAX_FILES - live.current.filter((x) => x.state !== "failed").length;
      const accepted: File[] = [];
      for (const f of list) {
        const why = attachRefusal(f);
        if (why) refusals.push(why);
        else if (accepted.length >= room) refusals.push(`${f.name}: at most ${ATTACH_MAX_FILES} files with one message.`);
        else accepted.push(f);
      }
      setNotice(refusals.length ? refusals.join(" ") : null);
      for (const file of accepted) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const up = uploadPiAttachment(workspaceId, sessionId, file, (fraction) => patch(key, { progress: fraction }));
        setPending((xs) => [
          ...xs,
          { key, name: file.name, size: file.size, type: file.type, progress: 0, state: "uploading", abort: up.abort },
        ]);
        up.done.then(
          (stored) => patch(key, { state: "ready", progress: 1, stored, abort: undefined }),
          (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === "aborted") return; // removed while uploading — already gone from the list
            patch(key, { state: "failed", error: msg, abort: undefined });
          },
        );
      }
    },
    [workspaceId, sessionId, patch],
  );

  /** Take a file off the message: stop its upload, or delete what was stored. */
  const remove = useCallback(
    (key: string) => {
      const item = live.current.find((x) => x.key === key);
      setPending((xs) => xs.filter((x) => x.key !== key));
      if (!item) return;
      if (item.state === "uploading") item.abort?.();
      else if (item.state === "ready" && item.stored && sessionId) {
        void removePiAttachment(workspaceId, sessionId, item.stored.name).catch(() => {
          /* best effort — an unsent file left behind harms nothing */
        });
      }
    },
    [workspaceId, sessionId],
  );

  /** After a send: the files went with the message, so the tray empties without deleting anything. */
  const clear = useCallback(() => {
    setPending([]);
    setNotice(null);
  }, []);

  // A new conversation starts with an empty tray.
  useEffect(() => {
    setPending([]);
    setNotice(null);
  }, [sessionId]);

  const ready = pending.filter((x) => x.state === "ready" && x.stored).map((x) => x.stored!.name);
  const uploading = pending.some((x) => x.state === "uploading");
  return { pending, notice, setNotice, add, remove, clear, ready, uploading };
}

/** The files on the message being written, each with its progress, and a way to take it off. */
export function AttachmentTray({
  pending,
  notice,
  onRemove,
  onDismissNotice,
}: {
  pending: PendingAttachment[];
  notice: string | null;
  onRemove: (key: string) => void;
  onDismissNotice: () => void;
}) {
  if (!pending.length && !notice) return null;
  return (
    <div className="mb-2 space-y-2">
      {notice ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] text-text">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={onDismissNotice} aria-label="Dismiss" className="text-dim hover:text-text">
            <Close s={12} />
          </button>
        </div>
      ) : null}
      {pending.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attached files">
          {pending.map((p) => (
            <li
              key={p.key}
              className={`relative flex w-[210px] items-center gap-2 overflow-hidden rounded-lg border bg-surface px-2.5 py-2 text-[12px] ${
                p.state === "failed" ? "border-danger/40" : "border-line"
              }`}
            >
              <span className={`shrink-0 ${p.state === "failed" ? "text-danger" : "text-muted"}`} aria-hidden>
                {isImage(p.type, p.name) ? <ImageIcon s={15} /> : <FileDoc s={15} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text" title={p.name}>{p.name}</span>
                <span className={`block truncate text-[11px] ${p.state === "failed" ? "text-danger" : "text-dim"}`} title={p.error}>
                  {p.state === "uploading"
                    ? `Uploading… ${Math.round(p.progress * 100)}%`
                    : p.state === "failed"
                      ? p.error ?? "Upload failed"
                      : sizeLabel(p.size)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onRemove(p.key)}
                aria-label={p.state === "uploading" ? `Cancel uploading ${p.name}` : `Remove ${p.name}`}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dim hover:bg-surface-2 hover:text-text"
              >
                <Close s={11} />
              </button>
              {p.state === "uploading" ? (
                <span
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-accent transition-[width] duration-150"
                  style={{ width: `${Math.round(p.progress * 100)}%` }}
                  role="progressbar"
                  aria-label={`Uploading ${p.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(p.progress * 100)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * What a sent message carried, under the person's words. With `hrefOf` (a saved chat keeps its files), each one
 * downloads.
 */
export function SentAttachments({ files, hrefOf }: { files: PiAttachment[]; hrefOf?: ((name: string) => string) | null }) {
  return (
    <ul className="flex flex-wrap justify-end gap-1.5" aria-label="Files sent with this message">
      {files.map((f) => {
        const body = (
          <>
            <span aria-hidden>{isImage(f.type, f.name) ? <ImageIcon s={13} /> : <FileDoc s={13} />}</span>
            <span className="truncate text-text" title={f.name}>{f.name}</span>
            <span className="shrink-0 text-dim">{sizeLabel(f.size)}</span>
          </>
        );
        const cls = "flex max-w-[240px] items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[11.5px] text-muted";
        if (f.removed) return <Removed key={f.name} name={f.name} small />;
        return (
          <li key={f.name}>
            {hrefOf ? (
              <a href={hrefOf(f.name)} download={f.name} className={`${cls} hover:border-accent/50`} aria-label={`Download ${f.name}`}>
                {body}
              </a>
            ) : (
              <span className={cls}>{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Files Forge made, under its reply: larger cards than a sent chip, because getting the file is the point. With
 * `onOpen` the card opens the file's preview and a separate button downloads it.
 */
export function FileCards({
  files,
  hrefOf,
  onOpen,
}: {
  files: PiAttachment[];
  hrefOf?: ((name: string) => string) | null;
  onOpen?: ((name: string) => void) | null;
}) {
  const card = "flex w-[260px] items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-left text-[12.5px] hover:border-accent/50";
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Files made in this reply">
      {files.map((f) => {
        const body = (verb: string) => (
          <>
            <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
              {isImage(f.type, f.name) ? <ImageIcon s={16} /> : <FileDoc s={16} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-text" title={f.name}>{f.name}</span>
              <span className="block text-[11px] text-dim">{sizeLabel(f.size)} · {verb}</span>
            </span>
          </>
        );
        if (f.removed) return <Removed key={f.name} name={f.name} />;
        return (
          <li key={f.name}>
            {onOpen && hrefOf ? (
              <div className={`${card} pr-1.5`}>
                <button type="button" onClick={() => onOpen(f.name)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-label={`Preview ${f.name}`}>
                  {body("Preview")}
                </button>
                <a
                  href={hrefOf(f.name)}
                  download={f.name}
                  aria-label={`Download ${f.name}`}
                  title={`Download ${f.name}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                >
                  <Download s={14} />
                </a>
              </div>
            ) : (
              <a href={hrefOf ? hrefOf(f.name) : undefined} download={f.name} aria-disabled={!hrefOf} aria-label={`Download ${f.name}`} className={card}>
                {body("Download")}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The drop target while a file is dragged over the chat. */
export function DropOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent/60 bg-accent/5 text-[13px] text-text backdrop-blur-[1px]"
      aria-hidden
    >
      <Upload s={22} />
      <span className="font-medium">Drop files to attach them</span>
      <span className="text-[11.5px] text-muted">Documents, sheets, images or text · up to 50 MB each</span>
    </div>
  );
}

/** A file the person removed from the chat later: its name stays in the conversation, nothing opens or downloads. */
function Removed({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <li>
      <span
        className={`flex max-w-[260px] items-center gap-1.5 rounded-lg border border-dashed border-line px-2 py-1 text-dim ${small ? "text-[11.5px]" : "text-[12.5px]"}`}
        title={`${name} was removed from this chat`}
      >
        <span className="truncate line-through">{name}</span>
        <span className="shrink-0">removed</span>
      </span>
    </li>
  );
}
