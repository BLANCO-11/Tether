import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceFixtures, datasources } from "../db/schema.js";

/**
 * The single definition of "usable mock": only `ready` counts.
 * `building`, `failed`, NULL, and anything else are all "no mock".
 */
export const READY_MOCK_STATUS = "ready" as const;

export function isReadyStatus(s: unknown): s is typeof READY_MOCK_STATUS {
  return s === READY_MOCK_STATUS;
}

export type DatasourceFixture = typeof datasourceFixtures.$inferSelect;
export type NewDatasourceFixture = typeof datasourceFixtures.$inferInsert;

/**
 * Readiness readers over `datasource_fixtures` (migration 0062).
 *
 * The ONLY thing that satisfies "has mock data" is a fixture row whose
 * `mock_status` is `ready`. `building`, `failed`, and "no row at all" are all
 * the same answer to a reader — not usable — and must never render as usable.
 * `mock_error` says why when the status is `failed`.
 */
export const datasourceFixtureRepo = {
  /** Newest fixture row for a datasource, whatever its status. */
  async latest(datasourceId: string): Promise<DatasourceFixture | undefined> {
    const rows = await db
      .select()
      .from(datasourceFixtures)
      .where(eq(datasourceFixtures.datasourceId, datasourceId))
      .orderBy(desc(datasourceFixtures.version))
      .limit(1);
    return rows[0];
  },

  /** Newest READY fixture — the only row a mock read may use. */
  async latestReady(datasourceId: string): Promise<DatasourceFixture | undefined> {
    const rows = await db
      .select()
      .from(datasourceFixtures)
      .where(
        and(
          eq(datasourceFixtures.datasourceId, datasourceId),
          eq(datasourceFixtures.mockStatus, "ready"),
        ),
      )
      .orderBy(desc(datasourceFixtures.version))
      .limit(1);
    return rows[0];
  },

  /** Whether a datasource has at least one READY mock fixture. */
  async hasReadyMock(datasourceId: string): Promise<boolean> {
    const rows = await db
      .select({ id: datasourceFixtures.id })
      .from(datasourceFixtures)
      .where(
        and(
          eq(datasourceFixtures.datasourceId, datasourceId),
          eq(datasourceFixtures.mockStatus, "ready"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  },

  /** Ids of datasources in a workspace with at least one READY fixture. */
  async readyIdsForWorkspace(workspaceId: string): Promise<Set<string>> {
    const rows = await db
      .select({ datasourceId: datasourceFixtures.datasourceId })
      .from(datasourceFixtures)
      .innerJoin(datasources, eq(datasourceFixtures.datasourceId, datasources.id))
      .where(
        and(
          eq(datasources.workspaceId, workspaceId),
          eq(datasourceFixtures.mockStatus, "ready"),
        ),
      );
    return new Set(rows.map((r) => r.datasourceId));
  },

  /** Per-datasource count of READY fixtures, scoped to a workspace. */
  async readyCountsForWorkspace(workspaceId: string): Promise<Record<string, number>> {
    const rows = await db
      .select({ datasourceId: datasourceFixtures.datasourceId })
      .from(datasourceFixtures)
      .innerJoin(datasources, eq(datasourceFixtures.datasourceId, datasources.id))
      .where(
        and(
          eq(datasources.workspaceId, workspaceId),
          eq(datasourceFixtures.mockStatus, "ready"),
        ),
      );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.datasourceId] = (out[r.datasourceId] ?? 0) + 1;
    return out;
  },

  /** Mark a version building (insert the row when the builder starts). */
  async markBuilding(data: NewDatasourceFixture): Promise<DatasourceFixture> {
    const rows = await db
      .insert(datasourceFixtures)
      .values({ ...data, mockStatus: "building", mockError: null })
      .returning();
    return rows[0];
  },

  /** Mark a version ready — clears any prior error. */
  async markReady(datasourceId: string, version: number): Promise<DatasourceFixture | undefined> {
    const rows = await db
      .update(datasourceFixtures)
      .set({ mockStatus: "ready", mockError: null })
      .where(
        and(
          eq(datasourceFixtures.datasourceId, datasourceId),
          eq(datasourceFixtures.version, version),
        ),
      )
      .returning();
    return rows[0];
  },

  /** Mark a version failed — records the reason, never a silent state. */
  async markFailed(
    datasourceId: string,
    version: number,
    error: string,
  ): Promise<DatasourceFixture | undefined> {
    const rows = await db
      .update(datasourceFixtures)
      .set({ mockStatus: "failed", mockError: error })
      .where(
        and(
          eq(datasourceFixtures.datasourceId, datasourceId),
          eq(datasourceFixtures.version, version),
        ),
      )
      .returning();
    return rows[0];
  },
};
