import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  approvalRequests,
  datasources,
  flowExecutions,
  flowSteps,
  flows,
  platformUsers,
  tools,
  workspaceMembers,
} from "../db/schema.js";
import { contentVisibility, type Viewer as ContentViewer } from "./content-visibility.service.js";

/**
 * B-30 search index 6 kinds workspace-scoped, replacing STATIC_SEARCH_INDEX.
 * Unions flows + flow_steps + flow_executions + datasources/reviewed_templates + approval_requests + platform_users
 * into 6 kinds workflow·step·run·resource·approval·person with title+meta+icon+href (law 7 every href resolves)
 * Route GET /workspaces/:ws/search?q= workspace-scoped
 * keep GET /api/templates separate.
 */

export const SEARCH_KINDS = [
  "workflow",
  "step",
  "run",
  "resource",
  "approval",
  "person",
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  meta: string;
  href: string;
  iconKey: string;
}

const KIND_ORDER: Record<SearchKind, number> = {
  workflow: 0,
  step: 1,
  run: 2,
  resource: 3,
  approval: 4,
  person: 5,
};

function sortByKind(a: SearchResult, b: SearchResult): number {
  return (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99);
}

/**
 * What the viewer may see, as the permission set the resolver returned.
 *
 * ⚠ **REQUIRED, never optional.** A shared function with an optional authorisation
 * argument is how one consumer silently gets less checking than another — that is
 * exactly how `operations` went missing from chat's catalogue for months (I-127), and
 * how `expressionsBlock` shipped a five-line summary to one caller and the full rules to
 * the other. Making it required means a new caller has to decide rather than inherit a
 * default, and the default a permission argument would take is "allow".
 */
/**
 * `content` (rbac-observability, 2026-10-15): who this is, for the private/published line. Absent means "no
 * content rule" — a harness calling the service directly; every route passes one.
 */
export type Viewer = { permissions: ReadonlySet<string>; content?: ContentViewer };

/**
 * Which permission each search kind needs.
 *
 * ⚠ `resource` is the one kind fed by TWO sources — datasources and tools — and they
 * are filtered separately rather than by one "resource" permission, because a person
 * granted `tools.read` and not `datasources.read` should see the tools and not the
 * datasources. Collapsing them would leak whichever half the coarser permission covers.
 */
export const KIND_PERMISSION: Record<SearchKind, string> = {
  workflow: "flows.read",
  step: "flows.read",
  run: "runs.read",
  resource: "datasources.read",
  approval: "approvals.read",
  person: "members.read",
};

export const searchService = {
  /**
   * Search one workspace, returning only what this viewer is entitled to see.
   *
   * ⚠ **THE ROUTE GUARD IS A FLOOR, NOT THE ANSWER.** `search.read` gets you to this
   * function; it does not decide what comes back. Without the per-kind filter, an
   * `author` — who holds `search.read` and not `secrets.read` or `audit.read` — would
   * read the titles and metadata of every approval and every person in the workspace
   * through a search box, which is a read-around of the permissions that exist to stop
   * exactly that. This is the one route the route map cannot secure on its own.
   */
  async index(
    workspaceId: string,
    qRaw: string | undefined,
    viewer: Viewer,
  ): Promise<SearchResult[]> {
    const q = (qRaw ?? "").trim().toLowerCase();
    if (!q) return [];

    const may = (permission: string) => viewer.permissions.has(permission);
    const results: SearchResult[] = [];

    /**
     * ⚠ Fetched OUTSIDE the `flows.read` gate on purpose: the `run` kind renders each
     * execution as "status · <flow name>", and knowing which automation a run you are
     * entitled to read belongs to is part of that run's own identity, not a separate
     * disclosure. What `flows.read` gates is whether FLOWS THEMSELVES are emitted as
     * results, which is the gate below.
     */
    const allFlowRows = await db
      .select()
      .from(flows)
      .where(eq(flows.workspaceId, workspaceId));
    const cv = viewer.content;
    const flowRows = cv ? allFlowRows.filter((f) => contentVisibility.flowVisible(cv, f)) : allFlowRows;
    const visibleFlowIds = new Set(flowRows.map((f) => f.id));

    // workflow — flows in this workspace
    if (may("flows.read")) {
      for (const f of flowRows) {
        const title = f.name;
        const meta = `${f.status ?? "draft"}`;
        const href = `/flows/${f.id}`;
        const iconKey = "Cube";
        const hay = `${title} ${meta} ${f.id}`.toLowerCase();
        if (hay.includes(q))
          results.push({
            kind: "workflow",
            id: f.id,
            title,
            meta,
            href,
            iconKey,
          });
      }
    }

    // step — flow_steps current revision? search all revisions but workspace-scoped via flows
    if (may("flows.read")) {
      // Use flowSteps joined to flows filtered by workspace
      const stepRows = await db
        .select({ step: flowSteps, flow: flows })
        .from(flowSteps)
        .innerJoin(flows, eq(flowSteps.flowId, flows.id))
        .where(eq(flows.workspaceId, workspaceId));
      for (const { step, flow } of stepRows) {
        if (!visibleFlowIds.has(flow.id)) continue;
        const cfg = step.configJson as { name?: string } | null;
        const stepName =
          (cfg && typeof cfg.name === "string" && cfg.name) || step.stepId;
        const title = stepName;
        const meta = `${step.kind} · ${flow.name} · Step ${step.ordinal + 1}`;
        const href = `/flows/${flow.id}`;
        const iconKey = "Box";
        const hay =
          `${title} ${meta} ${step.stepId} ${flow.name}`.toLowerCase();
        if (hay.includes(q))
          results.push({
            kind: "step",
            id: step.id,
            title,
            meta,
            href,
            iconKey,
          });
      }
    }

    // run — flow_executions workspace-scoped
    if (may("runs.read")) {
      const runRows = await db
        .select()
        .from(flowExecutions)
        .where(eq(flowExecutions.workspaceId, workspaceId));
      for (const r of runRows) {
        if (cv) {
          const f = r.flowId ? allFlowRows.find((x) => x.id === r.flowId) ?? null : null;
          if (!contentVisibility.runVisible(cv, r, f)) continue;
        }
        // try to resolve flow name
        const flowName =
          flowRows.find((f) => f.id === r.flowId)?.name ?? r.flowId;
        const title = r.id;
        const meta = `${r.status ?? "unknown"} · ${flowName}`;
        const href = `/runs/${r.id}`;
        const iconKey = "Activity";
        const hay =
          `${title} ${meta} ${r.kestraExecutionId ?? ""}`.toLowerCase();
        if (hay.includes(q))
          results.push({ kind: "run", id: r.id, title, meta, href, iconKey });
      }
    }

    // resource — datasources + tools.
    // ⚠ Filtered SEPARATELY: a person with `tools.read` and no `datasources.read` sees
    // the tools and not the datasources. One "resource" permission would leak whichever
    // half the coarser grant happened to cover.
    if (may("datasources.read")) {
      const dsRows = await db
        .select()
        .from(datasources)
        .where(eq(datasources.workspaceId, workspaceId));
      for (const d of dsRows) {
        const title = d.name;
        const meta =
          `${d.type ?? d.resourceCategory ?? "datasource"} · ${d.resourceStatus ?? d.testStatus ?? ""}`.trim();
        const href = `/resources/${d.id}`;
        const iconKey = "Database";
        const hay = `${title} ${meta} ${d.id}`.toLowerCase();
        if (hay.includes(q))
          results.push({
            kind: "resource",
            id: d.id,
            title,
            meta: meta || "Resource",
            href,
            iconKey,
          });
      }
    }
    if (may("tools.read")) {
      const toolRows = await db
        .select()
        .from(tools)
        .where(eq(tools.workspaceId, workspaceId));
      for (const t of toolRows) {
        const title = t.name;
        const meta = `Tool · ${t.description ?? ""}`.trim();
        const href = `/resources/${t.id}`;
        const iconKey = "Tool";
        const hay = `${title} ${meta} ${t.id}`.toLowerCase();
        if (hay.includes(q))
          results.push({
            kind: "resource",
            id: t.id,
            title,
            meta,
            href,
            iconKey,
          });
      }
    }

    // approval — approval_requests
    if (may("approvals.read")) {
      const apprRows = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.workspaceId, workspaceId));
      for (const a of apprRows) {
        const title = `${a.id} · ${a.subjectLabel ?? a.type}`;
        const meta = `${a.type} · ${a.status} · ${a.risk ?? ""}`.trim();
        const href = `/approvals/${a.id}`;
        const iconKey = "Shield";
        const hay = `${title} ${meta} ${a.subjectLabel ?? ""}`.toLowerCase();
        if (hay.includes(q))
          results.push({
            kind: "approval",
            id: a.id,
            title,
            meta,
            href,
            iconKey,
          });
      }
    }

    // person — workspace_members + platform_users join
    if (may("members.read")) {
      const memberRows = await db
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      const platformRows = await db.select().from(platformUsers);
      const platformBySubject = new Map(
        platformRows.map((p) => [p.subject, p]),
      );
      for (const m of memberRows) {
        const plat = platformBySubject.get(m.subject);
        const display = plat?.email || m.email || m.subject;
        const title = display;
        const meta = `${m.role} · ${plat?.email ?? m.email}`;
        const href = `/admin/people/${encodeURIComponent(m.subject)}`;
        const iconKey = "User";
        const hay = `${title} ${meta} ${m.subject}`.toLowerCase();
        if (hay.includes(q))
          results.push({
            kind: "person",
            id: m.subject,
            title,
            meta,
            href,
            iconKey,
          });
      }
    }

    results.sort(sortByKind);
    return results;
  },
};
