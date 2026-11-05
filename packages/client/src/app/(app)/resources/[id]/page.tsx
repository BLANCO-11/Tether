// src/app/(app)/resources/[id]/page.tsx — S-52 Resource detail.
// Pack truth: `29-resource-detail.png` + `S-52.md` + `flows/09-resources-and-change.md § Step 2`.
// Regions: header (eyebrow RESOURCE · POSTGRESQL · title + status chip · purpose · action Review change)
//   · notices (change-waiting warning with its own action button inside) · content (figures strip then
//   Published mapping) · related (Connection definition list, then shut Audit & sync history).
// Layout: notice carries right-aligned button (first captured with action inside, not trailing link);
//   figures strip four in one row, fourth is v2 version string; Published mapping 4-col table inside
//   card; Connection is definition list values right-aligned.
// Copy verbatim where data exists; keep existing resource read (getConnection) if present else honest empty.
// Law 7: every non-worked resource gets generic detail — figures, workflows using it with honest empty
//   "No workflow reads or writes this resource yet", connection facts, either submitted mapping or plain
// AI visibility is per field, not per resource (employee_no Masked while leave_dt Mock).
// Credential shown by reference (svc-leave-ro), never as value.
//
// ── Datasource panes (added by 20260912-184048-resource-detail-schema-and-operations)
// A datasource-category resource ALSO gets, in the content zone: Schema (AssetTree over
// the metadata this page already reads), DB operations (the callable catalogue a `query`
// step names) and Sandbox (what a draft run reads). They are the panes `/data-sources/[id]`
// has always had; the sidebar sends people to /resources, so without them a datasource's
// tables and readers were unreachable from the surface the product offers.
// ⚠ Gated on CATEGORY, never on engine — see `@/lib/resource-category` for why.
// ⚠ Schema metadata only: no rows are fetched or previewed on this page.
// ⚠ Adding any further `@/lib/api` read here means extending the whole-module mock in
//   page.test.tsx — an omitted export comes back undefined and crashes every test in it.
"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getConnection, getConnectionMetadata, listFlows } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import type { AssetNode, Connection, FlowSummary } from "@/lib/types";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { FigureStrip } from "@/components/ui/FigureStrip";
import { DataTable, type DataRow } from "@/components/ui/DataTable";
import { StatusPill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AssetTree } from "@/components/data/AssetTree";
import { DbOperationsPanel } from "@/components/data/DbOperationsPanel";
import { MockPanel } from "@/components/data/MockPanel";
import { isDatasourceResource } from "@/lib/resource-category";

// ── Verbatim capture for the worked example (Leave management DB) ────────

const LEAVE_SLUG = "leave-management-db";

const LEAVE_PURPOSE = "Published schema v2 has a breaking v3 change waiting for review.";

type MappingRow = { source: string; type: string; mapped: string; visibility: string };

const LEAVE_MAPPING: readonly MappingRow[] = [
  { source: "employee_no", type: "text", mapped: "employee_id", visibility: "Masked" },
  { source: "leave_dt", type: "date", mapped: "leave_date", visibility: "Mock" },
  { source: "leave_code", type: "text", mapped: "leave_type", visibility: "Mock" },
  { source: "approved_flag", type: "boolean", mapped: "approval_status", visibility: "Mock" },
] as const;

const LEAVE_CONNECTION: readonly { label: string; value: string }[] = [
  { label: "Owner", value: "Devika Menon" },
  { label: "Host", value: "leave-db.internal:5432" },
  { label: "Credential", value: "svc-leave-ro" },
  { label: "SSL", value: "require" },
  { label: "Access", value: "Read-only" },
] as const;

// ── Helpers for generic resource ──────────────────────────────────────────

function flowResources(flow: FlowSummary): string[] {
  if (flow && typeof flow === "object" && "resources" in flow) {
    const v = (flow as Record<string, unknown>).resources;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function statusFor(conn: Connection): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  switch (conn.status) {
    case "ready":
      return { label: "Published", tone: "ok" };
    case "pending":
    case "discovering":
      return { label: "Pending review", tone: "warn" };
    case "error":
      return { label: "Failed", tone: "danger" };
    case "untested":
      return { label: "Draft", tone: "neutral" };
    default:
      return { label: "Draft", tone: "neutral" };
  }
}

function engineLabel(conn: Connection): string {
  const id = conn.connector_id.toLowerCase();
  if (id.includes("postgres")) return "POSTGRESQL";
  if (id.includes("mysql")) return "MYSQL";
  if (id.includes("s3")) return "AMAZON S3";
  if (id.includes("sftp")) return "SFTP";
  if (id.includes("rest")) return "REST";
  if (id.includes("email")) return "EMAIL";
  if (id.includes("slack")) return "SLACK";
  return conn.connector_id.toUpperCase();
}

/** Tables and column counts off the introspected metadata — the same nodes the
    data-source schema pane reads. Flat, because this surface summarises; the
    per-column grid lives one click away on the data source view. */
function tableSummary(metadata: AssetNode[]): { name: string; cols: number }[] {
  const out: { name: string; cols: number }[] = [];
  for (const schema of metadata) {
    for (const table of schema.children ?? []) {
      if (table.asset_type !== "table") continue;
      out.push({
        name: table.name,
        cols: (table.children ?? []).filter((c) => c.asset_type === "column").length,
      });
    }
  }
  return out;
}

// The id comes from `useParams()` only. This page used to take a `params` prop as well; on Next 15 that prop is a Promise and
// on 16 only a Promise, so reading it is the one thing the upgrade breaks. See `flows/[id]/page.tsx`.
export default function ResourceDetailPage() {
  const routeParams = useParams<{ id: string }>();
  const id = routeParams?.id ?? "";

  const { data: conn, loading, error } = useAsync(() => getConnection(id), [id]);
  const { data: flows } = useAsync(listFlows, []);
  const { data: metadata } = useAsync(() => getConnectionMetadata(id), [id]);

  const isWorked = id === LEAVE_SLUG || conn?.name === "Leave management DB";

  const dependentsCount = useMemo(() => {
    if (!flows || !conn) return 0;
    const list = flows as FlowSummary[];
    // Derive from workflow graph, never stored — match resources/page.tsx logic
    return list.filter((f) => flowResources(f).includes(conn.name) || flowResources(f).includes(conn.id)).length;
  }, [flows, conn]);

  // ── Loading / error / honest empty ───────────────────────────────────────
  if (loading) {
    return (
      <Page>
        <Zone name="content">
          <p className="text-sm text-muted">Loading…</p>
        </Zone>
      </Page>
    );
  }

  if (error) {
    return (
      <Page>
        <Zone name="notices">
          <Notice tone="danger" title="Could not load this resource">{error}</Notice>
        </Zone>
      </Page>
    );
  }

  // Honest empty when the read returns nothing and this is not the worked example
  if (!conn && !isWorked) {
    return (
      <Page>
        <Zone name="content">
          <p className="text-sm text-muted">This resource no longer exists.</p>
        </Zone>
      </Page>
    );
  }

  // ── Worked example: Leave management DB (verbatim capture) ───────────────
  if (isWorked) {
    const mappingRows: DataRow<"mapping">[] = LEAVE_MAPPING.map((r) => ({
      key: r.source,
      cells: {
        identity: <span className="font-mono text-xs">{r.source}</span>,
        kind: <span className="font-mono text-xs text-muted">{r.type}</span>,
        meaning: <span className="font-mono text-xs">{r.mapped}</span>,
        safety: <span className="text-xs text-muted">{r.visibility}</span>,
      },
    }));

    return (
      <Page>
        <PageHeader
          eyebrow="RESOURCE · POSTGRESQL"
          title="Leave management DB"
          badge={<StatusPill status="warn">Pending review</StatusPill>}
          purpose={LEAVE_PURPOSE}
          actions={[{ label: "Review change", href: `/resources/${id}/review` }]}
        />

        <Zone name="notices" gap="tight">
          <Notice
            tone="warn"
            title="A change is waiting for review"
            action={
              <Button size="sm" variant="ghost" onClick={() => {}}>
                View 4 affected workflows
              </Button>
            }
          >
            The <span className="font-mono text-xs">approved_flag</span> field changed from boolean to a three-state approval status.
          </Notice>
        </Zone>

        <Zone name="content">
          <FigureStrip
            items={[
              { value: "4", label: "dependent workflows" },
              { value: "4", label: "mapped fields" },
              { value: "25", label: "mock rows" },
              { value: "v2", label: "schema version" },
            ]}
          />

          <section className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold text-text">Published mapping</h2>
            </div>
            <div className="p-4">
              <DataTable
                set="mapping"
                caption="Published mapping"
                heads={{ identity: "SOURCE", kind: "TYPE", meaning: "MAPPED FIELD", safety: "AI VISIBILITY" }}
                rows={mappingRows}
                empty="No mapped fields."
              />
            </div>
          </section>
        </Zone>

        <Zone name="related">
          <section className="rounded-lg border border-line bg-surface px-4 py-3">
            <h2 className="text-body font-semibold text-text">Connection</h2>
            <dl className="mt-3 space-y-2 text-sm">
              {LEAVE_CONNECTION.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4">
                  <dt className="text-dim">{row.label}</dt>
                  <dd className="font-mono text-xs text-text">{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <details className="rounded-lg border border-line bg-surface px-4 py-3">
            <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-text">
              <span>Audit &amp; sync history</span>
              <span className="text-muted">▾</span>
            </summary>
            <p className="mt-3 text-xs text-muted">Audit and sync events for this resource.</p>
          </details>
        </Zone>
      </Page>
    );
  }

  // ── Generic resource (Law 7) ─────────────────────────────────────────────
  // At this point conn is truthy (honest empty already returned)
  const gConn = conn as Connection;
  const st = statusFor(gConn);
  const genericEyebrow = `RESOURCE · ${engineLabel(gConn)}`;
  const tables = tableSummary(metadata ?? []);
  const hasMetadata = tables.length > 0;
  const columnCount = tables.reduce((n, t) => n + t.cols, 0);

  // Mock data is automatic on onboarding now (mock testing-DB programme) — no manual action.

  // Datasource-only panes (Schema, DB operations, Sandbox). One definition,
  // shared with the resources list — see `@/lib/resource-category`.
  const isDatasource = isDatasourceResource(gConn);

  // ⚠ The metadata tree's TOP level is `db_schema`, not tables — tables are its
  // children. So `metadata.length` is the number of SCHEMAS, usually 1 ("public").
  // Labelling that as a table count states "1 table" for a datasource with nine.
  // (The `mapped fields` figure above already counts top-level nodes; that is
  // pre-existing and left alone, but nothing NEW may repeat it.)
  const tableCount = (metadata ?? []).reduce(
    (n, s) => n + (s.children ?? []).filter((c) => c.asset_type === "table").length,
    0,
  );
  const tableWord = tableCount === 1 ? "table" : "tables";

  const genericFlowList: FlowSummary[] = (flows as FlowSummary[] | null) ?? [];
  const usingFlows = genericFlowList.filter(
    (f) => flowResources(f).includes(gConn.name) || flowResources(f).includes(gConn.id),
  );

  // The header's one-line summary, from facts on this surface — never the
  // "Resource detail — connection and schema." placeholder.
  const engineTitle =
    engineLabel(gConn) === "POSTGRESQL" ? "PostgreSQL"
    : engineLabel(gConn) === "MYSQL" ? "MySQL"
    : engineLabel(gConn);
  const purposeLine = [
    engineTitle,
    hasMetadata ? `${tables.length} ${tables.length === 1 ? "table" : "tables"}` : null,
    hasMetadata ? `${columnCount} ${columnCount === 1 ? "column" : "columns"}` : null,
    dependentsCount === 0 ? "no dependent workflows yet" : `${dependentsCount} dependent ${dependentsCount === 1 ? "workflow" : "workflows"}`,
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");

  // Only credential facts are ever known here: host/SSL/access read from a
  // connector config the list payload never carries, so they rendered "—" on
  // every row. Unknowns are omitted, not dashed.
  const credentialVal = gConn.secret_env_name ?? null;

  return (
    <Page>
      <PageHeader
        eyebrow={genericEyebrow}
        title={gConn.name}
        badge={<StatusPill status={st.tone}>{st.label}</StatusPill>}
        purpose={gConn.description ?? purposeLine}
        actions={hasMetadata ? [{ label: "Open data source view", href: `/data-sources/${id}` }] : undefined}
      />


      <Zone name="content">
        <FigureStrip
          items={[
            { value: String(dependentsCount), label: "dependent workflows" },
            { value: String(tables.length), label: "tables" },
            { value: String(columnCount), label: "columns" },
          ]}
        />

        {/* Workflows using it — honest empty per Law 7 */}
        <section className="rounded-lg border border-line bg-surface px-4 py-3">
          <h2 className="text-body font-semibold text-text">Workflows using it</h2>
          {usingFlows.length > 0 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {usingFlows.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-4">
                  <Link href={`/flows/${f.id}`} className="truncate text-accent hover:underline">
                    {f.name}
                  </Link>
                  <span className="text-xs text-muted">{f.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">No workflow reads or writes this resource yet</p>
          )}
        </section>

        {/* ── Published mapping, and the way out to the data source view ────
            ⚠ **TWO BRANCHES SOLVED THE SAME PROBLEM IN OPPOSITE DIRECTIONS, and
            this keeps both halves.**

            `release/beta` made `/data-sources/[id]` rich — mock rows, a credential
            picker, per-column detail — and turned THIS section into a summary that
            lists the tables and points there. Meanwhile this branch put the full
            datasource panes (Schema, DB operations, Sandbox) on THIS page, because
            the sidebar sends people to `/resources` and those panes were otherwise
            unreachable from the surface the product offers.

            Taken literally, the merge would list every table twice: once in beta's
            summary and again in the Schema pane below it. So the summary's table
            list is dropped — the pane does it properly, with columns — and beta's
            EXIT SENTENCE is kept, because mock rows, guardrails and the live
            connection genuinely do live over there and nothing else on this page
            says so.

            ⚠ This section is about FIELD MAPPING, which neither branch models. It
            used to end "Field mapping is available in the data source schema view",
            which was stale: the schema is on this page now. */}
        {hasMetadata ? (
          <section className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold text-text">Published mapping</h2>
            </div>
            <div className="p-4">
              <p className="text-sm text-muted">
                This resource has {tableCount} discovered {tableWord}, listed under Schema below.
                Field-level mapping is not modelled for this resource.
              </p>
            </div>
            <p className="border-t border-line px-4 py-3 text-xs text-muted">
              Mock rows, guardrails and the live connection live on the{" "}
              <Link href={`/data-sources/${id}`} className="text-accent hover:underline">data source view</Link>.
            </p>
          </section>
        ) : (
          <section className="rounded-lg border border-line bg-surface px-4 py-3">
            <h2 className="text-body font-semibold text-text">Published mapping</h2>
            <p className="mt-2 text-sm text-muted">Its field mapping is not modelled</p>
          </section>
        )}

        {/* ── Datasource-only: what it exposes, and what can read it ─────────
            These are the two panes `/data-sources/[id]` has always had. The
            sidebar sends people here instead, so without them a datasource's
            discovered tables and its callable readers were unreachable from the
            surface the product actually offers.

            ⚠ Gated on CATEGORY, not on engine. An S3 or SFTP datasource is still
            a datasource; it degrades to the honest-empty states below rather than
            silently losing the panes. Deciding "can this be introspected" here
            would be a second copy of the server's own supports() set.

            ⚠ Schema metadata ONLY — rows are never fetched and never previewed.
            That is the property the operations builder is built on. */}
        {isDatasource && (
          <>
            <section className="rounded-lg border border-line bg-surface">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <h2 className="text-body font-semibold text-text">Schema</h2>
                {tableCount > 0 && (
                  <span className="ml-auto rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">
                    {tableCount} {tableWord}
                  </span>
                )}
              </div>
              <div className="p-2">
                {hasMetadata ? (
                  <AssetTree nodes={metadata ?? []} />
                ) : gConn.status === "error" ? (
                  <p className="p-3 text-sm text-muted">
                    Foundry couldn&apos;t read this resource&apos;s schema — fix the connection, then re-scan.
                  </p>
                ) : (
                  <p className="p-3 text-sm text-muted">
                    No tables discovered yet. Re-scan the schema to look again.
                  </p>
                )}
              </div>
              <p className="border-t border-line px-4 py-2 text-caption text-muted">
                Read using the same read-only credential an automation gets — exactly the surface a
                flow can query, nothing more.
              </p>
            </section>

            {/* The callable catalogue. A `query` step names an operation from here;
                it never carries SQL, which is why this panel is what makes such a
                step authorable at all. */}
            <DbOperationsPanel datasourceId={id} schema={metadata ?? []} />

            {/* Ranked last: what a TEST run reads — this datasource's mock data, or a refusal when there is none.
                ⚠ It showed the retired sandbox panel, whose "no sandbox, so a test run reads PRODUCTION" warning
                stopped being true when test runs moved to mock data (step-execution.service.ts): with no mock a
                test run is refused, and production is read only on an admin's per-run opt-in. */}
            <MockPanel datasourceId={id} tableCount={tables.length} />
          </>
        )}
      </Zone>

      <Zone name="related">
        {/* Only facts with values. Host/SSL/access read from a connector config
            the payload never carries — they rendered a column of dashes. */}
        {credentialVal && (
          <section className="rounded-lg border border-line bg-surface px-4 py-3">
            <h2 className="text-body font-semibold text-text">Connection</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-dim">Credential</dt>
                <dd className="font-mono text-xs text-text">{credentialVal}</dd>
              </div>
            </dl>
          </section>
        )}
        <details className="rounded-lg border border-line bg-surface px-4 py-3">
          <summary className="flex cursor-pointer items-center justify-between text-sm font-medium text-text">
            <span>Audit &amp; sync history</span>
            <span className="text-muted">▾</span>
          </summary>
          <p className="mt-3 text-xs text-muted">Audit and sync events for this resource.</p>
        </details>
      </Zone>
    </Page>
  );
}
