// src/lib/hooks.ts — small data hook so pages get { data, loading, error, reload }
// without repeating useEffect. Call reload() after a mutation to refresh a list.
"use client";

import { useCallback, useEffect, useState } from "react";

/** Run an async fetcher on mount; expose its state and a reload().
    Pass `deps` when the fetcher closes over changing values (e.g. a filter) —
    the data refetches whenever they change. */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    fetcher()
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e?.message ?? "Something went wrong"))
      .finally(() => setLoading(false));
    // fetcher identity is otherwise stable per page usage; we intentionally run
    // once + on manual reload + when the caller's declared deps change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { reload(); }, [reload]);

  return { data, loading, error, reload };
}

/** Call reload() on an interval while `active` (e.g. a connection is still discovering).
    Stops on unmount, when `active` becomes false, and after `maxTicks` (so a stuck
    "discovering" never polls forever). */
export function usePoll(reload: () => void, active: boolean, ms = 2500, maxTicks = 40) {
  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
      if (ticks > maxTicks) { clearInterval(id); return; }
      reload();
    }, ms);
    return () => clearInterval(id);
  }, [active, ms, maxTicks, reload]);
}
