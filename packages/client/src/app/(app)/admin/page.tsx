// src/app/(app)/admin/page.tsx — Admin overview: is this workspace healthy?
//
// The collection root is a real page, not a redirect: four workspace figures
// (open incidents · active break-glass · pending approvals), an index of the
// Admin areas, and the deployment-wide
// operational signals. Every figure reads independently — a failed read renders
// "could not be read", never 0. Super-admin gated through `AdminGate`.
//
// ── 2026-10-12 restyle (docs/design/README.md) ──────────────────────────────
//
// The figures are whole clickable cards. A workspace's budget moved to its own page
// (Limits) in admin simplify phase 4 — one place for each fact. 2026-10-30, from the
// mock: figures, then the signals full width, then the Admin areas as a grid of cards
// so the overview leads somewhere.
"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Tag } from "@/components/ui/Badge";
import { SignalsPanel } from "@/components/ops/SignalsPanel";
import { AdminGate, ADMIN_EYEBROW } from "@/components/admin/AdminGate";
import { Activity, Alert, Building, CheckCheck, ChevronRight, Key, Shield, Sparkle, User } from "@/components/ui/icons";
import { useAsync } from "@/lib/hooks";
import { activeBreakGlass, getApprovalFigures, listIncidents } from "@/lib/api";

const TITLE = "Overview";

/** Every Admin area, with one line on what it is for. The sidebar's Admin group, as an index. */
const AREAS: { href: string; label: string; what: string; Icon: (p: { s?: number }) => JSX.Element }[] = [
  { href: "/admin/people", label: "People", what: "Manage members, roles and invitations.", Icon: User },
  { href: "/organization", label: "Workspaces", what: "Members, settings and usage limits.", Icon: Building },
  { href: "/admin/roles", label: "Roles", what: "See what each role can do.", Icon: Shield },
  { href: "/ai-provider", label: "AI models", what: "Choose the models workflows can use.", Icon: Sparkle },
  { href: "/admin/gates", label: "Release gates", what: "Set what must be true before publishing.", Icon: CheckCheck },
  { href: "/admin/audit", label: "Audit", what: "See who did what and when.", Icon: Activity },
  { href: "/admin/incidents", label: "Incidents", what: "Open, track and close incidents.", Icon: Alert },
  { href: "/incidents/break-glass", label: "Break-glass", what: "Review temporary access to real data.", Icon: Key },
];

/** One workspace figure: "…" while reading, "—" with a reason when it could not be read — never 0. */
function Stat({ r, label, href, icon }: { r: { data: number | null | undefined; error: string | null }; label: string; href: string; icon: ReactNode }) {
  const value = r.error ? "—" : r.data === undefined || r.data === null ? "…" : String(r.data);
  const loud = !r.error && typeof r.data === "number" && r.data > 0;
  return (
    <Link
      href={href}
      className="rounded-xl border border-line bg-surface px-5 py-4 transition-colors duration-150 hover:border-line-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="flex items-center justify-between gap-3">
        <span className={`text-[30px] font-medium leading-none tabular-nums ${loud ? "text-warn" : "text-text"}`}>{value}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">{icon}</span>
      </span>
      <span className="mt-3 block text-caption text-muted">{label}</span>
      {r.error && <span className="mt-1 block text-caption text-danger">could not be read</span>}
    </Link>
  );
}

export default function AdminOverviewPage() {
  return <AdminGate title={TITLE}>{({ workspaceId, workspaces }) => <Overview workspaceId={workspaceId} workspaces={workspaces} />}</AdminGate>;
}

function Overview({
  workspaceId,
  workspaces,
}: {
  workspaceId: string | null;
  workspaces: { data: { id: string; name: string }[] | null; error: string | null };
}) {
  const activeName = (workspaces.data ?? []).find((x) => x.id === workspaceId)?.name ?? null;

  const incidents = useAsync(
    () => (workspaceId ? listIncidents(workspaceId).then((rows) => rows.filter((r) => r.status !== "closed").length) : Promise.resolve(null as number | null)),
    [workspaceId],
  );
  const sessions = useAsync(
    () => (workspaceId ? activeBreakGlass(workspaceId).then((rows) => rows.length) : Promise.resolve(null as number | null)),
    [workspaceId],
  );
  const approvals = useAsync(
    () => (workspaceId ? getApprovalFigures(workspaceId).then((f) => f.inFlight) : Promise.resolve(null as number | null)),
    [workspaceId],
  );
  return (
    <Page measure="wide">
      <PageHeader
        eyebrow={ADMIN_EYEBROW}
        title={TITLE}
        purpose="A quick view of workspace activity and settings."
        badge={activeName ? <Tag>{activeName}</Tag> : undefined}
      />
      <Zone name="notices">
        {!workspaceId && (
          <Notice tone="warn" title="No workspace selected">
            No workspace is selected, so the workspace figures below cannot be read. Pick one in the workspace switcher.
          </Notice>
        )}
        {workspaces.error && <Notice tone="danger" title="Could not load workspaces">{workspaces.error}</Notice>}
      </Zone>
      <Zone name="content">
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3" aria-label="Workspace status">
          <Stat r={incidents} label="Open incidents" href="/admin/incidents" icon={<Alert s={15} />} />
          <Stat r={sessions} label="Active break-glass" href="/incidents/break-glass" icon={<Shield s={15} />} />
          <Stat r={approvals} label="Pending approvals" href="/approvals" icon={<CheckCheck s={15} />} />
        </div>

        <section aria-labelledby="signals-head">
          <h2 id="signals-head" className="text-body font-semibold">Deployment signals</h2>
          <p className="mb-3 mt-0.5 text-caption text-muted">Deployment-wide checks, not limited to the selected workspace.</p>
          <SignalsPanel compact />
        </section>

        <section aria-labelledby="areas-head">
          <h2 id="areas-head" className="text-body font-semibold">Admin areas</h2>
          <p className="mb-3 mt-0.5 text-caption text-muted">Manage people, workspace settings, access and activity.</p>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {AREAS.map((a) => (
              <li key={a.href}>
                <Link
                  href={a.href}
                  className="group flex h-full min-h-[7rem] items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-[background-color,border-color,transform] duration-150 hover:-translate-y-px hover:border-line-2 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:hover:translate-y-0"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted group-hover:text-text">
                    <a.Icon s={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-body font-medium text-text">{a.label}</span>
                      <span className="text-dim"><ChevronRight s={14} /></span>
                    </span>
                    <span className="mt-1 block text-caption text-muted">{a.what}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </Zone>
      <Zone name="related">
        <p className="border-t border-line pt-4 text-caption text-dim">
          Deployment health is shared across the service.{activeName ? ` Workspace counts reflect ${activeName}.` : ""}
        </p>
      </Zone>
    </Page>
  );
}
