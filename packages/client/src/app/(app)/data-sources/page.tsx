// src/app/(app)/data-sources/page.tsx — the databases THIS WORKSPACE can read.
//
// ── Corrections this page carries, all of them honesty fixes ─────────────────
//
// It used to describe a system that no longer exists: connections "discovered
// and federated" by an onboarding backend, exposed as a Trino catalog, queried
// "through Virtual Tables". Virtual Tables was deleted in away-from-demo-mode
// Stage 1 and the Catalog column was hardcoded `null`, so it rendered `—` on
// every row for every workspace, permanently. A datasource is a registered
// read-only connection string that named queries run against; that is all, and
// saying more than that is the same class of untruth as a mock backend. The
// dead `Catalog` column is replaced below by `Injected as` — the credential's
// env-var NAME, never its value — which is real for every row.
//
// And a NULL `test_status` was rendered "Queued" — with a poll running,
// waiting for a transition nothing would ever make. See `testStatusToConnStatus`.
//
// D-21: the Tables column is gone too. The list endpoint carries no
// per-connection schema count (D-04.10), and a column of permanent dashes is
// noise — the schema lives on the detail page, where the server's introspection
// actually lands.
"use client";

import { useState } from "react";
import Link from "next/link";
import { listConnections, deleteConnection, testConnection, setDatasourcePaused, listWorkspaces, getDatasourceMock } from "@/lib/api";
import { useAsync, usePoll } from "@/lib/hooks";
import { useWorkspace } from "@/lib/workspace";
import { useToast } from "@/lib/toast";
import type { Connection } from "@/lib/types";
import { CONNECTION_PILL, IN_FLIGHT, needsTesting } from "@/lib/connection-status";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { DataTable, type DataRow } from "@/components/ui/DataTable";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/Badge";
import { Confirm } from "@/components/ui/Confirm";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Plus, Database } from "@/components/ui/icons";

export default function DataSourcesPage() {
  const { data, loading, error, reload } = useAsync(listConnections);
  const toast = useToast();
  const [confirmDel, setConfirmDel] = useState<Connection | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [pausing, setPausing] = useState<string | null>(null);

  const list = data ?? [];
  // Only while a test is genuinely in flight. See IN_FLIGHT.
  usePoll(reload, list.some((c) => IN_FLIGHT.includes(c.status)));

  const remove = async (c: Connection) => { await deleteConnection(c.id); toast.success(`Removed "${c.name}"`); reload(); };

  /**
   * Pause — hide this source from the model — or resume it.
   *
   * ⚠ **No confirmation, deliberately, and Remove keeps its one.** Pausing
   * destroys nothing, stops no running automation and is undone by pressing the
   * same button again; a dialog in front of a reversible act trains people to
   * click through the dialog in front of the irreversible one. The toast says
   * what changed, because the effect is invisible on this screen otherwise.
   */
  const togglePause = async (c: Connection) => {
    const next = !c.paused_from_model;
    setPausing(c.id);
    try {
      await setDatasourcePaused(c.id, next);
      toast.success(
        next
          ? `"${c.name}" is paused — the designer will not be shown it. Running automations are unaffected.`
          : `"${c.name}" is back in the designer's catalogue.`,
      );
    } catch (e) {
      toast.error(`Couldn't change it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPausing(null);
      reload();
    }
  };

  // The action that resolves "Not tested". It exists in the data seam and this
  // page never called it, which is most of why every row sat unresolved.
  const test = async (c: Connection) => {
    setTesting(c.id);
    try {
      await testConnection(c.id);
      toast.success(`${c.name} answered — connected.`);
    } catch (e) {
      // The server's sentence, verbatim: it names the host, the role or the
      // refusal, and "Test failed" would throw away the only actionable part.
      toast.error(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(null);
      reload();
    }
  };

  // The server persists health (testStatus/lastTestedAt) but no error text —
  // the detail arrives in the POST /test response the toast already shows.
  // Gating on error_message would hide every failed source, which is how the
  // "Not tested regardless" report read: the pill is the persisted fact.
  const failing = list.filter((c) => c.status === "error");

  // Engine words for the mock's "Engine" column. The two engines the server can
  // register and introspect are named here; anything else renders its raw id.
  // Version ("PostgreSQL 16") is not in the list payload — see the report.
  const ENGINE_LABELS: Record<string, string> = {
    postgres: "PostgreSQL",
    mysql: "MySQL",
  };

  const rows: DataRow<"datasource">[] = list.map((c) => {
    const pill = CONNECTION_PILL[c.status];
    const busy = testing === c.id;
    return {
      key: c.id,
      cells: {
        identity: (
          <Link
            href={`/data-sources/${c.id}`}
            className="flex min-w-0 items-center gap-3 truncate font-mono text-sm font-semibold text-text hover:text-accent"
          >
            {c.name}
          </Link>
        ),
        kind: <span className="text-xs text-muted">{ENGINE_LABELS[c.connector_id] ?? c.connector_id}</span>,
        state: (
          <span className="flex flex-col items-start gap-1">
            <StatusPill status={pill.status}>{busy ? "Testing…" : pill.text}</StatusPill>
            {/* ⚠ SAID, not left to be inferred from a greyed-out button. A
                paused source looks exactly like a working one on this screen —
                it still connects, it still has a schema, and its existing flows
                still run. The only difference is invisible from here, so it is
                written down. */}
            {c.paused_from_model && (
              <span className="text-caption text-warn">
                Paused — hidden from the designer; running automations unaffected
              </span>
            )}
            {/* Mock readiness follows the fixture row, per source — the safety
                half of this row: what a test run of a flow reading this source
                actually touches. Own read, own states; loading draws nothing
                rather than a claim. */}
            <MockLine datasourceId={c.id} />
            {/* Offered whenever the answer is not current: an untested source,
                or one that last failed and may since be fixed. */}
            {!busy && needsTesting(c.status) && (
              <button
                onClick={() => test(c)}
                className="text-xs text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Test now
              </button>
            )}
          </span>
        ),
        time: (
          <span className="text-caption text-dim">
            {c.last_tested_at ? new Date(c.last_tested_at).toLocaleString() : "never"}
          </span>
        ),
        // The mock's inline pair, on the same handlers the RowMenu carried.
        actions: (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => test(c)} disabled={busy}>
              {busy ? "Testing…" : "Test"}
            </Button>
            {/* Pause / Resume — what the DESIGNER is shown, never what runs.
                Beside Test and Remove because those are the other two things a
                person does to a whole source from this row. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => togglePause(c)}
              disabled={pausing === c.id}
              title={
                c.paused_from_model
                  ? "Show this data source to the designer again"
                  : "Hide this data source from the designer. Running automations keep reading it."
              }
            >
              {pausing === c.id ? "Saving…" : c.paused_from_model ? "Resume" : "Pause"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDel(c)} className="text-danger hover:bg-danger-bg">
              Remove
            </Button>
          </div>
        ),
      },
    };
  });

  return (
    <Page>
      <PageHeader
        title="Data sources"
        purpose="Read-only connections your automations query. Selecting a row shows its schema, mock rows, and guardrails."
        actions={[{ label: "Connect a data source", icon: <Plus s={15} />, href: "/data-sources/new" }]}
      />

      <Zone name="notices" gap="tight">
        {error && (
          <Notice
            tone="danger"
            title="Could not load data sources"
            action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}
          >
            {error}
          </Notice>
        )}

        {/* ⚠ The server's own sentence, in FULL and wrapped — never truncated to
            a tooltip. It names the host, the role or the refusal, which is the
            entire content of a failed test. It used to render as a strip under
            the row; in zone 2 it keeps its full width instead of living inside
            a grid cell that would wrap it into a column. */}
        {failing.map((c) => (
          <Notice key={c.id} tone="danger" title={`${c.name} can't connect`}>
            {c.error_message ?? "The last test could not connect. Press Test to see the database's answer."}
          </Notice>
        ))}

        {/* The frozen mock's info notice (D-02): the scope sentence, as a
            full-width banner. The mock froze ONE sentence; the live page also
            knows WHICH workspace this is, and keeping that fact is keeping a
            data flow — it trails the mock's sentence rather than replacing it. */}
        <WorkspaceScopeNote />
      </Zone>

      <Zone name="content">
        <DataTable
          set="datasource"
          caption="Registered data sources"
          heads={{ identity: "Name", kind: "Engine", state: "Status", time: "Last tested", actions: "" }}
          rows={rows}
          // Loading gets the footprint-stable skeleton (mock D-16) — the bars
          // occupy the same space as the rows coming, so the page does not jump
          // from a spinner line to a full table. Three bars, matching the
          // mock's `skel-row` × 3 (view-data-sources). The empty state is the
          // mock's verbatim (D-21): database glyph + one line + the same
          // Connect action the header carries, so the dead end is one click
          // from a way out.
          empty={
            loading ? <Skeleton rows={3} />
            : error ? <span className="text-danger">Not loaded — see above.</span>
            : (
              <EmptyState
                icon={<Database s={16} />}
                title="No data sources connected in this workspace."
                action={
                  <Link href="/data-sources/new">
                    <Button size="sm">
                      <Plus s={15} />Connect a data source
                    </Button>
                  </Link>
                }
              />
            )
          }
        />
      </Zone>

      <Confirm
        open={!!confirmDel}
        title={confirmDel ? `Remove ${confirmDel.name}?` : "Remove data source?"}
        body={
          confirmDel
            ? `Tether will forget ${confirmDel.name}'s credential and the tables it discovered. ` +
              `Any DB operation written against it, and any flow step that calls one, will stop ` +
              `working until it is registered again. The database itself is not touched.`
            : ""
        }
        confirmLabel="Remove" danger
        onConfirm={() => confirmDel && remove(confirmDel)}
        onClose={() => setConfirmDel(null)}
      />
    </Page>
  );
}

/**
 * Says which workspace this list belongs to, in the frozen mock's info-notice
 * form (D-02): icon + full-width banner with the scope sentence. The mock froze
 * ONE sentence; the live page also knows WHICH workspace this is, so the name
 * and the other-workspaces count trail the mock's sentence rather than
 * replacing it — dropping them would lose a fact the page already had.
 */
function WorkspaceScopeNote() {
  const { workspaceId } = useWorkspace();
  const { data } = useAsync(listWorkspaces, [workspaceId]);
  const current = (data ?? []).find((w) => w.id === workspaceId);
  if (!current) return null;
  const others = (data ?? []).filter((w) => w.id !== workspaceId);
  return (
    <Notice tone="info" title="Connections and credentials are scoped to this workspace">
      HR can&apos;t read Finance&apos;s data sources. Every query runs against a read-only DSN.{" "}
      {others.length > 0 && (
        <span className="text-dim">
          ({others.length === 1 ? "one other workspace has" : `${others.length} other workspaces have`} their own — switch workspace to see them.)
        </span>
      )}
    </Notice>
  );
}
/**
 * Per-row mock readiness — the catalogue safety text. Follows the fixture
 * row (`mock_status`), not the connection status above it: a source can be
 * connected and still refuse test runs (no mock), or fail them loudly.
 */
function MockLine({ datasourceId }: { datasourceId: string }) {
  const { data, loading, error } = useAsync(() => getDatasourceMock(datasourceId), [datasourceId]);
  if (loading || (!data && !error)) return null;
  if (error) return <span className="text-caption text-warn">Mock state unreadable</span>;
  if (!data || data.status === null)
    return <span className="text-caption text-warn">No mock data — test runs refuse</span>;
  if (data.status === "building") return <span className="text-caption text-muted">Mock data building…</span>;
  if (data.status === "failed") return <span className="text-caption text-danger">Mock build failed</span>;
  return <span className="text-caption text-muted">Mock data ready</span>;
}
