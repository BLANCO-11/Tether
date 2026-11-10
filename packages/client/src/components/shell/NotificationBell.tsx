// src/components/shell/NotificationBell.tsx — what is running, and what
// finished while you were doing something else.
//
// ── ⚠ WHAT IT IS FOR ────────────────────────────────────────────────────────
//
// Two things in this product take minutes and then finish without anybody
// looking: a generation (which `/flows/new` explicitly invites you to walk away
// from) and a run — including one nobody in this browser started, which is every
// scheduled automation. Before this, a generation that finished after you
// navigated away simply never told you, and a 03:00 scheduled run had no surface
// at all short of opening History and comparing.
//
// ── ⚠ THREE STATES, AND THE THIRD IS THE ONE THAT MATTERS ───────────────────
//
// *"Nothing is running"*, *"these things are running"*, and **"I could not find
// out"**. The third has to look different from the first: a bell that goes quiet
// because the server is unreachable is indistinguishable from a quiet system,
// and that is the `faFallback` failure applied to the one surface whose job is
// to tell you when something happened.
//
// ── ⚠ IT IS POLLED, AND SAYS SO ─────────────────────────────────────────────
//
// The footer carries the last check time. This is not a push channel and must
// not be dressed as one — the honest version of "up to 20 seconds behind" is
// printing when it last looked, not a live-looking dot that is sometimes stale.
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useActivity } from "@/lib/activity";
import { Bell } from "@/components/ui/icons";

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString();
};

export function NotificationBell() {
  const { live, notes, notices, unread, markRead, error, checkedAt, refresh } = useActivity();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      if (!v) markRead();
      return !v;
    });
  };

  return (
    <div className="relative" ref={box}>
      <button
        onClick={toggle}
        aria-label={
          error
            ? "Activity — could not be checked"
            : live.length
              ? `Activity — ${live.length} running`
              : "Activity"
        }
        aria-expanded={open}
        title={error ? "Could not check what is running" : "What is running, and what just finished"}
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Bell s={16} />
        {/* ⚠ A FAILURE badge outranks a count. If the poll is failing, the count
            is stale and showing it as a confident number is the wrong half to
            keep. */}
        {error ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-micro font-medium text-on-accent"
          >
            !
          </span>
        ) : unread > 0 ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-micro font-medium text-on-accent"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : live.length > 0 ? (
          // Running, nothing new to read: a quiet dot, not a number. A count of
          // in-flight work in the same badge as a count of unread news would be
          // two different meanings sharing one shape.
          <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />
        ) : null}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[360px] overflow-hidden rounded-lg border border-line bg-surface shadow-raised">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-caption uppercase tracking-label text-dim">Activity</span>
            <button
              onClick={refresh}
              className="text-caption text-muted hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Check now
            </button>
          </div>

          {/* ⚠ FIRST, above everything. An error under a list of stale items
              reads as a footnote to information that looks current. */}
          {error && (
            <p className="border-b border-warn-line bg-warn-bg px-4 py-3 text-xs text-warn">
              Could not check what is running: {error}. Anything below is from an earlier check, and
              this is not evidence that nothing is happening.
            </p>
          )}

          <div className="max-h-[60vh] overflow-y-auto">
            {/* Kept by the server until seen (sharing-boundaries): what happened to YOUR things, e.g. an Admin
                opened your private work. Above the run activity because it is about you, not about the system. */}
            {notices.length > 0 && (
              <div className="border-b border-line px-4 py-3">
                <p className="mb-2 text-caption uppercase tracking-label text-dim">For you</p>
                <ul className="space-y-2">
                  {notices.slice(0, 5).map((n) => (
                    <li key={n.id} className="text-body">
                      <span className="block font-medium">
                        {n.href ? (
                          <Link href={n.href} onClick={() => setOpen(false)} className="hover:underline">
                            {n.title}
                          </Link>
                        ) : (
                          n.title
                        )}
                      </span>
                      <span className="block text-xs text-muted">{n.body}</span>
                      <span className="block text-caption text-dim">{new Date(n.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {live.length > 0 && (
              <div className="border-b border-line px-4 py-3">
                <p className="mb-2 text-caption uppercase tracking-label text-dim">Running now</p>
                <ul className="space-y-2">
                  {live.map((i) => (
                    <li key={i.key} className="flex items-center gap-2 text-body">
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                      <span className="min-w-0 flex-1 truncate">
                        {i.href ? (
                          <Link href={i.href} onClick={() => setOpen(false)} className="hover:underline">
                            {i.title}
                          </Link>
                        ) : (
                          i.title
                        )}
                      </span>
                      <span className="shrink-0 text-caption text-dim">run</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {notes.length === 0 ? (
              <p className="px-4 py-4 text-xs text-muted">
                {live.length > 0
                  ? "Nothing has finished yet. You will be told here when it does."
                  : // ⚠ Says WHAT it covers and SINCE WHEN. "No notifications" over
                    // a list that only starts when the page loads is a claim about
                    // the whole day.
                    "Nothing has started or finished since you opened Tether. Designs and runs show up here as they happen — including ones started by a schedule."}
              </p>
            ) : (
              <ul>
                {notes.map((n) => (
                  <li key={`${n.id}:${n.seq}`} className="border-b border-line px-4 py-3 last:border-0">
                    <span className="flex items-baseline gap-2">
                      <span
                        aria-hidden
                        className={
                          "mt-1 h-1.5 w-1.5 shrink-0 rounded-full " +
                          (n.outcome === "failed"
                            ? "bg-danger"
                            : n.outcome === "refused"
                              ? "bg-warn"
                              : n.outcome === "ok"
                                ? "bg-ok"
                                : "bg-dim")
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium">
                          {n.href ? (
                            <Link href={n.href} onClick={() => setOpen(false)} className="hover:underline">
                              {n.title}
                            </Link>
                          ) : (
                            n.title
                          )}
                        </span>
                        <span className="block text-xs text-muted">{n.body}</span>
                      </span>
                      <span className="shrink-0 text-caption text-dim">{when(n.at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ⚠ Polled, and it says so. A "live" dot that is sometimes 20 seconds
              stale is a smaller lie told more often. */}
          <p className="border-t border-line px-4 py-2 text-caption text-dim">
            {checkedAt ? `Checked at ${when(checkedAt)}` : "Not checked yet"} · Tether looks every
            few seconds while something is running, and less often when nothing is.
          </p>
        </div>
      )}
    </div>
  );
}
