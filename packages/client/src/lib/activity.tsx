// src/lib/activity.tsx — one poller in the shell, feeding two things: the
// notification bell, and every page's decision about when to refetch.
//
// ── ⚠ WHY ONE POLLER AND NOT A HOOK PER PAGE ────────────────────────────────
//
// The reported problem was two-sided. *"I had to refresh to see the update"* —
// `/flows`, `/dashboard`, `/history` and `/triggers` all fetch once on mount and
// never again, so a generation or a test run finishing changes nothing on
// screen. And there was no way at all to find out that background work had
// finished if you were not on the page that started it, which `/flows/new` even
// promises: *"you can leave this page — it keeps running."*
//
// Both are the same missing fact: **what is in flight right now**. So it is
// fetched once, in the shell, and read two ways:
//
//   · `useActivity()`  → the bell: what is running, what just finished.
//   · `useActivityEpoch()` → a number a page puts in its `useAsync` deps, so it
//     refetches exactly when something settles.
//
// ⚠ **The epoch changes on a TRANSITION, never on a tick.** It is derived from
// `inFlightSignature`, so a poll that finds the same three runs still running
// changes nothing and no page refetches. A counter that incremented per poll
// would turn one shell request into every open page refetching every few
// seconds — a load pattern nobody chose and nothing on screen would explain.
//
// ── ⚠ THE FIRST POLL RAISES NOTHING ─────────────────────────────────────────
//
// `diffWork(null, …)` returns zero notifications, because on the first look
// everything is new to this browser and almost nothing is new to the world.
// Without it, opening the app pops a toast for every run of the last hour — and
// the tenth time that happens, nobody reads any of them.
//
// ── ⚠ AND FAILING TO POLL IS NOT "NOTHING IS HAPPENING" ─────────────────────
//
// `error` is on the context and the bell renders it. A notification area that
// goes quiet because it cannot reach the server looks exactly like one with
// nothing to say, and that is the more dangerous of the two — it is the
// `faFallback` shape applied to the surface whose whole job is to tell you when
// something happened.
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listFlowExecutions, listNotifications, markNotificationsRead } from "@/lib/api";
import type { FANotification } from "@/lib/foundry-client";
import { useToast } from "@/lib/toast";
import { useWorkspace } from "@/lib/workspace";
import {
  diffWork,
  inFlightSignature,
  toastLine,
  workFromRuns,
  type WorkItem,
  type WorkNotification,
} from "@/lib/work-items";

/**
 * ⚠ Two cadences, and the slow one is the default. Something in flight is
 * worth 4s; an idle workspace is not worth a request every 4s from every open
 * tab for the rest of the day. The engine join behind `listFlowExecutions` is
 * not free.
 */
const BUSY_MS = 4000;
const IDLE_MS = 20000;

/** How far back to look. A window, and the bell says so rather than implying completeness. */
const WINDOW = 25;

/** What the bell keeps. Enough to answer "what did I miss", not a log. */
const KEEP = 30;

export type ActivityNote = WorkNotification & { at: string; seq: number };

type ActivityValue = {
  /** What is in flight right now, newest first. */
  live: WorkItem[];
  /** What has happened since this browser started looking, newest first. */
  notes: ActivityNote[];
  /**
   * Notices to this person that the server keeps until they have seen them (sharing-boundaries): e.g. an Admin
   * opened their private work. Unlike `notes`, these survive a reload.
   */
  notices: FANotification[];
  /** How many notes and unseen notices have arrived since the bell was last opened. */
  unread: number;
  markRead: () => void;
  /** ⚠ Non-null means the poll FAILED. Silence is not evidence of quiet. */
  error: string | null;
  /** When the last successful poll landed. Null until the first one. */
  checkedAt: string | null;
  /** Changes only when the set of in-flight work changes. Put it in `useAsync` deps. */
  epoch: number;
  refresh: () => void;
};

const Ctx = createContext<ActivityValue>({
  live: [],
  notes: [],
  notices: [],
  unread: 0,
  markRead: () => {},
  error: null,
  checkedAt: null,
  epoch: 0,
  refresh: () => {},
});

export function ActivityProvider({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();

  const [live, setLive] = useState<WorkItem[]>([]);
  const [notes, setNotes] = useState<ActivityNote[]>([]);
  const [unread, setUnread] = useState(0);
  const [notices, setNotices] = useState<FANotification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  /** `null` until the first successful poll — the "never looked" state. */
  const prev = useRef<Map<string, WorkItem> | null>(null);
  const signature = useRef<string>("");
  const seq = useRef(0);
  /** Bumped to force an immediate poll; also what `refresh()` moves. */
  const [nonce, setNonce] = useState(0);

  // ⚠ A workspace switch resets the baseline. Otherwise the first poll in the
  // new workspace diffs its runs against the old one's and announces every one
  // of them as newly started.
  useEffect(() => {
    prev.current = null;
    signature.current = "";
    setLive([]);
    setNotices([]);
    setError(null);
    setCheckedAt(null);
  }, [workspaceId]);

  const poll = useCallback(async () => {
    try {
      // Runs only: the generation job went with the drafter (compiled-builder phase 8, D-333).
      const items = workFromRuns(await listFlowExecutions(WINDOW));

      const fresh = diffWork(prev.current, items);
      prev.current = new Map(items.map((i) => [i.key, i]));

      if (fresh.length) {
        const at = new Date().toISOString();
        setNotes((old) =>
          [...fresh.map((n) => ({ ...n, at, seq: (seq.current += 1) })), ...old].slice(0, KEEP),
        );
        setUnread((n) => n + fresh.length);
        // ⚠ A toast ONLY for work that has FINISHED. "Started" belongs in the
        // bell: you generally started it yourself, and a popup confirming your
        // own click teaches people to dismiss popups. A completion is the one
        // you were not waiting for.
        for (const n of fresh) if (n.event === "settled") {
          // finished → green, came back with a question → amber, anything else → red
          const line = toastLine(n);
          if (n.outcome === "ok") toast.success(line);
          else if (n.outcome === "refused") toast.warn(line);
          else toast.error(line);
        }
      }

      const sig = inFlightSignature(items);
      if (sig !== signature.current) {
        signature.current = sig;
        setEpoch((e) => e + 1);
      }

      setLive(items.filter((i) => i.live));
      // Notices are a second read; one failing must not hide the runs, and the runs failing must not hide these. A
      // failure here keeps the last list rather than emptying it — an empty list would read as "nothing happened".
      try {
        setNotices(await listNotifications());
      } catch {
        /* the next poll tries again */
      }
      setError(null);
      setCheckedAt(new Date().toISOString());
    } catch (e) {
      // ⚠ The baseline is NOT reset on failure. A dropped request must not make
      // the next successful poll re-announce everything still running.
      setError((e as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      // ⚠ A hidden tab does not poll. A person with the app open in a background
      // window for a day is otherwise thousands of engine-joining requests, and
      // the notifications they would raise are ones nobody was there to read.
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        await poll();
      }
      if (cancelled) return;
      timer = setTimeout(tick, prev.current && signature.current ? BUSY_MS : IDLE_MS);
    };

    void tick();
    const onShow = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [poll, nonce, workspaceId]);

  const value = useMemo<ActivityValue>(
    () => ({
      live,
      notes,
      notices,
      unread: unread + notices.filter((n) => !n.read).length,
      markRead: () => {
        setUnread(0);
        const unseen = notices.filter((n) => !n.read).map((n) => n.id);
        if (unseen.length) {
          setNotices((old) => old.map((n) => (unseen.includes(n.id) ? { ...n, read: true } : n)));
          void markNotificationsRead(unseen).catch(() => {});
        }
      },
      error,
      checkedAt,
      epoch,
      refresh: () => setNonce((n) => n + 1),
    }),
    [live, notes, notices, unread, error, checkedAt, epoch],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActivity(): ActivityValue {
  return useContext(Ctx);
}

/**
 * A number that changes when the set of in-flight work changes.
 *
 * Put it in a `useAsync` dependency list and the page refetches when a
 * generation or a run starts or finishes — and at no other time.
 *
 *     const epoch = useActivityEpoch();
 *     const { data } = useAsync(listFlows, [epoch]);
 *
 * ⚠ It is not a timer and must not be used as one. Nothing here refetches a
 * page because time passed; it refetches because something happened.
 */
export function useActivityEpoch(): number {
  return useContext(Ctx).epoch;
}
