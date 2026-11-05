import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  datasources,
  datasourceFixtures,
  tools,
  flows,
  flowSteps,
} from "../db/schema.js";
import type { ResourceCategory, ResourceHealth, ResourceStatus } from "../db/schema.js";
import { RESOURCE_STATUSES, RESOURCE_HEALTHS } from "../db/schema.js";
import { datasourceRepo, type Datasource } from "../repositories/datasource.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";

// Re-export vocabulary so routes/services can import from one place.
export { RESOURCE_STATUSES, RESOURCE_HEALTHS };
export type { ResourceStatus, ResourceHealth, ResourceCategory };

// B-13 derived category — mirrors client page.tsx categoryFor exactly so the
// server is the verbatim source and the client no longer has to derive.
export function deriveResourceCategory(connectorId: string): ResourceCategory {
  const id = (connectorId ?? "").toLowerCase();
  if (
    id.includes("email") ||
    id.includes("rest") ||
    id.includes("slack") ||
    id.includes("connector")
  ) {
    return "connector";
  }
  if (id === "tool" || id.includes("tool") || id.includes("app")) return "tool";
  return "datasource";
}

export function deriveResourceTypeLabel(connectorId: string): string {
  const id = (connectorId ?? "").toLowerCase();
  if (id.includes("postgres")) return "PostgreSQL";
  if (id === "mysql" || id.includes("mysql")) return "MySQL";
  if (id === "sqlite") return "SQLite";
  if (id.includes("s3") || id.includes("amazon")) return "Amazon S3";
  if (id.includes("sftp") || id === "ftp" || id.includes("ftp")) return "SFTP";
  if (id.includes("oracle")) return "Oracle";
  if (id.includes("mongo")) return "MongoDB";
  if (id.includes("email")) return "Email connector";
  if (id.includes("rest")) return "REST connector";
  if (id.includes("slack")) return "Slack";
  if (id.includes("tool")) return "Tool";
  return connectorId || "—";
}

// Health chip sentence: healthNote when present, else enum-derived fallback.
const HEALTH_SENTENCE: Record<string, string> = {
  healthy: "Healthy",
  waiting_review: "A change is waiting for review",
  expires_soon: "Credential expires in 6 days",
  not_connected: "Not connected",
  superseded: "Superseded",
};

export function healthSentence(health: string | null, note: string | null): string {
  if (note && note.trim().length > 0) return note.trim();
  if (!health) return "Healthy";
  return HEALTH_SENTENCE[health] ?? note ?? "Healthy";
}

// Map legacy testStatus → ResourceStatus for rows where resource_status is null
function statusFromLegacy(testStatus: string | null): ResourceStatus {
  switch (testStatus) {
    case "connected":
    case "success":
    case "ok":
    case "ready":
      return "published";
    case "pending":
    case "discovering":
      return "pending-review";
    case "error":
    case "failed":
      return "failed";
    case "untested":
      return "draft";
    default:
      return "draft";
  }
}

function isValidStatus(s: unknown): s is ResourceStatus {
  return typeof s === "string" && (RESOURCE_STATUSES as readonly string[]).includes(s);
}
function isValidHealth(s: unknown): s is ResourceHealth {
  return typeof s === "string" && (RESOURCE_HEALTHS as readonly string[]).includes(s);
}

export interface Resource {
  id: string;
  workspaceId: string;
  name: string;
  // raw connector_id / type
  type: string;
  // human label per S-48 TYPE column
  resourceType: string;
  resourceCategory: ResourceCategory;
  status: ResourceStatus;
  ownerSubject: string | null;
  ownerName: string | null;
  ownerAvatarUrl: string | null;
  health: ResourceHealth | null;
  healthNote: string | null;
  healthSentence: string;
  hasMockData: boolean;
  // Not visible to AI badge: no safe data → cannot be published (S-48 § Two rules)
  notVisibleToAI: boolean;
  dependents: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastTestedAt: Date | null;
  secretEnvName: string | null;
  // Raw connection health for the datasources surface — the Resource `status`
  // vocabulary (published/draft/failed) cannot round-trip it, and the client
  // maps this field when present (falls back to `status` for older payloads).
  testStatus: string | null;
  // Keep raw datasource for compat where needed
  _raw?: unknown;
}

function toResource(
  d: Datasource,
  deps: number,
  fixturesCount: number,
): Resource {
  const rawStatus = (d as unknown as Record<string, unknown>).resourceStatus as string | null;
  const rawHealth = (d as unknown as Record<string, unknown>).health as string | null;
  const rawNote = (d as unknown as Record<string, unknown>).healthNote as string | null;
  const rawCat = (d as unknown as Record<string, unknown>).resourceCategory as string | null;
  // (hasMockData is intentionally NOT read from the stored column here: it is
  // server-derived from fixture readiness — Slice A. The column stays until the
  // retirement gate in the mock-data plan §6 passes.)
  const ownerSubject = (d as unknown as Record<string, unknown>).ownerSubject as string | null;
  const ownerName = (d as unknown as Record<string, unknown>).ownerName as string | null;
  const ownerAvatarUrl = (d as unknown as Record<string, unknown>).ownerAvatarUrl as string | null;

  const status: ResourceStatus = isValidStatus(rawStatus) ? rawStatus : statusFromLegacy(d.testStatus);
  const health: ResourceHealth | null = isValidHealth(rawHealth) ? rawHealth : null;
  // If health is superseded but no note, use generic superseded sentence
  let healthNote: string | null = rawNote;
  if (health === "superseded" && !healthNote) healthNote = HEALTH_SENTENCE.superseded;
  // hasMockData: a READY fixture exists. `building`, `failed`, and "no row"
  // are all "no mock" — never a stored flag, never a sandbox column.
  const hasMock = fixturesCount > 0;
  const category: ResourceCategory =
    rawCat === "datasource" || rawCat === "connector" || rawCat === "tool"
      ? rawCat
      : deriveResourceCategory(d.type);

  // If note is superseded generic, expand with "by …" when note is generic?
  const sentence = healthSentence(health, healthNote);
  // Specialize superseded without detail: keep as is; detail comes from healthNote.
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    name: d.name,
    type: d.type,
    resourceType: deriveResourceTypeLabel(d.type),
    resourceCategory: category,
    status,
    ownerSubject,
    ownerName,
    ownerAvatarUrl,
    health,
    healthNote,
    healthSentence: sentence,
    hasMockData: hasMock,
    notVisibleToAI: !hasMock,
    dependents: deps,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    lastTestedAt: d.lastTestedAt,
    secretEnvName: d.secretEnvName,
    testStatus: d.testStatus,
  };
}

async function assertWorkspace(workspaceId: string): Promise<void> {
  const ws = await workspaceRepo.get(workspaceId);
  if (!ws) {
    const err = new Error("workspace not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
}

export const resourceService = {
  deriveResourceCategory,
  deriveResourceTypeLabel,
  healthSentence,

  async list(workspaceId: string, filterCategory?: ResourceCategory | "all"): Promise<Resource[]> {
    await assertWorkspace(workspaceId);

    const dsList = await datasourceRepo.listByWorkspace(workspaceId);
    const toolsList = await toolRepo.listByWorkspace(workspaceId);

    // Dependents via flow_steps.manifest_refs_json — same shape as toolRepo.usedByIn
    // One query for datasource dependents (prefix match), one for tools (exact).
    const dsDeps = await dependentsForDatasources(workspaceId);
    const fixtureCounts = await fixtureCountsForDatasources(workspaceId);
    const toolDeps = await toolRepo.usedByIn(workspaceId);

    // Build datasource resources
    const dsResources: Resource[] = dsList.map((d) =>
      toResource(d, dsDeps[d.id] ?? 0, fixtureCounts[d.id] ?? 0),
    );

    // Build tool resources — map tool rows into same Resource shape
    const toolResources: Resource[] = toolsList.map((t) => {
      const dep = toolDeps[t.name] ?? 0;
      const status: ResourceStatus = t.isActive ? "published" : "draft";
      const health: ResourceHealth = "healthy";
      return {
        id: t.id,
        workspaceId: t.workspaceId,
        name: t.name,
        type: "tool",
        resourceType: "Tool",
        resourceCategory: "tool" as ResourceCategory,
        status,
        ownerSubject: null,
        ownerName: null,
        ownerAvatarUrl: null,
        health,
        healthNote: null,
        healthSentence: healthSentence(health, null),
        hasMockData: false,
        notVisibleToAI: true,
        dependents: dep,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        lastTestedAt: null,
        secretEnvName: t.secretEnvName ?? null,
        testStatus: null,
      } satisfies Resource;
    });

    const all = [...dsResources, ...toolResources];

    if (filterCategory && filterCategory !== "all") {
      return all.filter((r) => r.resourceCategory === filterCategory);
    }
    return all;
  },

  // Back-compat: enriched datasources only, used by GET /datasources
  async listDatasources(workspaceId: string): Promise<Resource[]> {
    const all = await this.list(workspaceId);
    // Return only datasource-origin rows (not tools)
    // Tools have type === "tool" — exclude them for the datasources route
    return all.filter((r) => r.type !== "tool");
  },
};

async function dependentsForDatasources(workspaceId: string): Promise<Record<string, number>> {
  // One query per workspace, group by datasource id, DISTINCT flow_id
  // WHERE ref.key = ds.name OR ref.key LIKE ds.name || '.%'
  const rows = await db.execute(sql`
    SELECT ds.id AS ds_id, COUNT(DISTINCT f.id)::int AS dependents
    FROM ${datasources} ds
    JOIN ${flows} f ON f.workspace_id = ds.workspace_id
    JOIN ${flowSteps} fs ON fs.flow_id = f.id
    CROSS JOIN LATERAL jsonb_object_keys(fs.manifest_refs_json) AS ref(key)
    WHERE ds.workspace_id = ${workspaceId}
      AND f.workspace_id = ${workspaceId}
      AND (ref.key = ds.name OR ref.key LIKE ds.name || '.%')
    GROUP BY ds.id
  `);
  const out: Record<string, number> = {};
  for (const row of rows.rows as Array<{ ds_id: string; dependents: number }>) {
    out[row.ds_id] = row.dependents;
  }
  return out;
}

async function fixtureCountsForDatasources(workspaceId: string): Promise<Record<string, number>> {
  const rows = await db.execute(sql`
    SELECT ds.id AS ds_id, COUNT(df.id)::int AS cnt
    FROM ${datasources} ds
    LEFT JOIN ${datasourceFixtures} df ON df.datasource_id = ds.id AND df.mock_status = 'ready'
    WHERE ds.workspace_id = ${workspaceId}
    GROUP BY ds.id
  `);
  const out: Record<string, number> = {};
  for (const row of rows.rows as Array<{ ds_id: string; cnt: number }>) {
    out[row.ds_id] = row.cnt;
  }
  return out;
}
