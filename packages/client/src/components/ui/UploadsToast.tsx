// src/components/ui/UploadsToast.tsx — ONE small pill, top centre, for every file still uploading.
//
// Replaces a full-width Notice per file, which stacked N tall cards and pushed the page's own content off screen.
// While uploading it is a neutral, blurred pill: a progress RING and a short label ("Uploading 3 files"). There is no
// cancel control — it is a status, not a place to manage uploads. When everything has finished the SAME pill eases
// smaller and turns green, the ring becoming a tick; if any file failed it turns red instead and stays until dismissed.
// Clicking the pill opens a short list, one line per file.
//
// Colour is by the worst thing in it: any failure → red; still going → neutral; everything finished → green. The state
// is also carried by the icon and the words, so it does not rest on colour alone. The finished files clear themselves
// after TOAST_MS (the page's job), like every other toast.
"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Check, Close, ChevronDown } from "@/components/ui/icons";

export type UploadItem = { key: string; name: string; progress: number; error?: string; done?: boolean; abort?: () => void };

type Tone = "running" | "failed" | "done";

const R = 7.5;
const C = 2 * Math.PI * R;

const LOOK: Record<Tone, { pill: string; text: string }> = {
  running: { pill: "border-line bg-surface-2/80 text-text", text: "text-text" },
  failed: { pill: "border-danger-line bg-danger-bg text-danger", text: "text-danger" },
  done: { pill: "border-[color-mix(in_srgb,var(--ok)_45%,transparent)] bg-ok-bg text-ok", text: "text-ok" },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function UploadsToast({
  uploads,
  onDismissItem,
  onHide,
}: {
  uploads: UploadItem[];
  onDismissItem: (key: string) => void;
  onHide: () => void;
}) {
  const [open, setOpen] = useState(false);
  // The pill's width follows its content, so it GLIDES between the longer "uploading" label and the shorter "done" one
  // instead of jumping. `auto` cannot be transitioned; a measured pixel width can.
  const inner = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  const running = uploads.filter((u) => !u.error && !u.done);
  const failed = uploads.filter((u) => u.error).length;
  const finished = uploads.filter((u) => u.done).length;
  const overall = running.length ? running.reduce((n, u) => n + u.progress, 0) / running.length : 1;
  const tone: Tone = failed ? "failed" : running.length ? "running" : "done";
  // Words follow what is still happening; the colour follows the worst thing that has happened.
  const label = running.length
    ? `Uploading ${plural(running.length, "file", "files")}${failed ? ` · ${failed} failed` : ""}`
    : failed
      ? `${plural(failed, "upload", "uploads")} failed${finished ? `, ${finished} uploaded` : ""}`
      : `${plural(finished, "file", "files")} uploaded`;

  useLayoutEffect(() => {
    if (inner.current) setWidth(inner.current.scrollWidth);
  }, [label, tone]);

  if (!uploads.length) return null;
  const look = LOOK[tone];

  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" data-testid="uploads-toast" data-tone={tone}>
      <div
        role="status"
        aria-live="polite"
        style={width ? { width: width + 24 } : undefined}
        className={`pointer-events-auto flex h-9 max-w-[calc(100vw-2rem)] origin-top items-center overflow-hidden rounded-full border px-3 text-[13px] font-medium shadow-lg backdrop-blur-xl transition-[width,transform,background-color,border-color,color] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${look.pill} ${tone === "done" ? "scale-95" : "scale-100"}`}
      >
        <div ref={inner} className="flex w-max items-center gap-2 whitespace-nowrap">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Hide file list" : "Show file list"}
            aria-expanded={open}
            className="flex items-center gap-2"
          >
            <Ring tone={tone} progress={overall} />
            <span className="transition-colors duration-500">{label}</span>
            <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
          </button>
          {running.length === 0 ? (
            <button type="button" onClick={onHide} aria-label="Dismiss uploads" className="-mr-1 rounded-full p-1 opacity-70 hover:opacity-100">
              <Close className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <ul className="pointer-events-auto max-h-60 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-line bg-surface-2/80 py-1 text-sm text-text shadow-lg backdrop-blur-xl">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center gap-2 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate" title={u.name}>{u.name}</div>
                <div className={u.error ? "text-xs text-danger" : u.done ? "text-xs text-ok" : "text-xs text-muted"}>
                  {u.error ?? (u.done ? "Uploaded" : `${Math.round(u.progress * 100)}%`)}
                </div>
              </div>
              {u.error ? (
                <button type="button" onClick={() => onDismissItem(u.key)} aria-label={`Dismiss ${u.name}`} className="rounded-full p-1 text-muted hover:bg-surface">
                  <Close className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The progress ring; on finishing it hands over to a tick, and on failure to an alert, by cross-fading in place. */
function Ring({ tone, progress }: { tone: Tone; progress: number }) {
  const fade = "absolute inset-0 transition-opacity duration-500 motion-reduce:transition-none";
  return (
    <span className="relative inline-block h-[18px] w-[18px] shrink-0" aria-hidden>
      <svg viewBox="0 0 20 20" className={`${fade} ${tone === "running" ? "opacity-100" : "opacity-0"}`}>
        <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - Math.max(0.04, Math.min(1, progress)))}
          transform="rotate(-90 10 10)"
          className="transition-[stroke-dashoffset] duration-300 ease-out"
        />
      </svg>
      <Check className={`${fade} h-[18px] w-[18px] ${tone === "done" ? "opacity-100" : "opacity-0"}`} />
      <Alert className={`${fade} h-[18px] w-[18px] ${tone === "failed" ? "opacity-100" : "opacity-0"}`} />
    </span>
  );
}
