"use client";

import { useMemo, useState } from "react";
import { useAsync } from "@/lib/hooks";
import { foundryApi } from "@/lib/foundry-client";

interface AccessEvent {
  time: string;
  tier: "platform" | "workspace";
  workspaceId: string | null;
  actor: string;
  action: string;
  subject: string | null;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  repeatCount: number;
}

/**
 * Grants, revocations and refusals, filterable by person and permission (FR-038).
 *
 * ⚠ **ONE TIME ORDER, TWO STORES — and which store is invisible here, deliberately**
 * (INV-17). Workspace access events live in `audit_events` and deployment-level ones in
 * `platform_audit_events`; the server unions them before this component sees them. A
 * reader of an audit trail should never have to know which table a decision landed in in
 * order to see what happened in sequence.
 *
 * ⚠ **A refusal shows its COUNT.** Identical repeats inside a window are one row with a
 * number, not one row per attempt — otherwise a refused caller in a retry loop could push
 * everything else off the end of the list. Showing "×499" is what keeps that bound
 * legible rather than looking like a single refusal.
 *
 * ⚠ **Three states.** An unreadable history says the check did not run; it never renders
 * as "nothing has happened".
 */
export function AccessHistory() {
  const [actor, setActor] = useState("");
  const [permission, setPermission] = useState("");
  /** How many are on screen. Ten at a time — the record is up to 200, and this is the page's second subject. */
  const [shown, setShown] = useState(10);

  const history = useAsync(
    async () => (await foundryApi.platformAudit({ limit: 200 })).events as unknown as AccessEvent[],
    [],
  );

  const rows = useMemo(() => {
    const all = history.data ?? [];
    return all.filter((e) => {
      if (actor && !`${e.actor} ${e.subject ?? ""}`.toLowerCase().includes(actor.toLowerCase())) {
        return false;
      }
      if (permission) {
        const hay = `${e.action} ${e.entityId ?? ""} ${JSON.stringify(e.after ?? "")}`.toLowerCase();
        if (!hay.includes(permission.toLowerCase())) return false;
      }
      return true;
    });
  }, [history.data, actor, permission]);

  if (!history.data && !history.error) return <p className="text-caption text-muted">Reading the access record…</p>;

  // ⚠ The third state. Not "nothing has happened".
  if (history.error) {
    return (
      <p className="text-sm text-warn" data-testid="access-history-unreadable">
        The access record could not be read, so none is shown — the check did not run.
        This is not a statement that nothing has happened.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="access-history">
      <div className="flex flex-wrap gap-2">
        <input
          className="h-8 w-56 rounded-md border border-line bg-bg px-2.5 text-body text-text placeholder:text-muted focus:border-accent focus:outline-none"
          placeholder="Filter by person"
          aria-label="Filter by person"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <input
          className="h-8 w-56 rounded-md border border-line bg-bg px-2.5 text-body text-text placeholder:text-muted focus:border-accent focus:outline-none"
          placeholder="Filter by permission"
          aria-label="Filter by permission"
          value={permission}
          onChange={(e) => setPermission(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          {history.data?.length ? "No access events match those filters." : "No access changes recorded yet."}
        </p>
      ) : (
        <>
        <ul className="divide-y divide-line rounded-md border border-line text-caption">
          {rows.slice(0, shown).map((e, i) => (
            <li key={`${e.time}-${i}`} className="flex flex-wrap gap-x-2 gap-y-0.5 px-3 py-2">
              <span className="text-dim">{new Date(e.time).toLocaleString()}</span>
              <span className="text-text">{e.actor}</span>
              <span className="text-muted">{e.action}</span>
              {e.subject && e.subject !== e.actor ? (
                <span className="text-muted">→ {e.subject}</span>
              ) : null}
              {e.entityId ? <span className="text-dim">{e.entityId}</span> : null}
              {/* ⚠ The bound, made legible. */}
              {e.repeatCount > 1 ? (
                <span className="text-dim" title="identical refusals inside one window">
                  ×{e.repeatCount}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {rows.length > shown && (
          <button type="button" onClick={() => setShown((n) => n + 10)} className="text-caption text-accent hover:underline">
            Show {Math.min(10, rows.length - shown)} more · {rows.length - shown} not shown
          </button>
        )}
        </>
      )}
    </div>
  );
}
