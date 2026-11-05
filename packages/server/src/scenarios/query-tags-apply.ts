/**
 * `query:tags` — write the demo queries' declared computed-column tags (demo/query-column-tags.ts) onto the LIVE query rows, after
 * checking each against the query's described columns; refuses (exit 1) and writes nothing for a declaration that does not fit.
 * Metadata only: no SQL, no row, no reader changes. No model calls.
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/query-tags-apply.ts
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceQueries, datasources } from "../db/schema.js";
import { QUERY_COLUMN_TAGS } from "../demo/query-column-tags.js";
import { withDeclaredTags } from "../services/query-column-tags.js";
import type { DescribedQuery } from "../services/introspect/types.js";

async function main() {
  const plan: Array<{ id: string; ref: string; tags: Record<string, string> }> = [];
  const refused: string[] = [];
  for (const [ref, tags] of Object.entries(QUERY_COLUMN_TAGS)) {
    const [dsName, qName] = ref.split(".") as [string, string];
    const rows = await db.select({ q: datasourceQueries }).from(datasourceQueries).innerJoin(datasources, eq(datasources.id, datasourceQueries.datasourceId))
      .where(and(eq(datasources.name, dsName), eq(datasourceQueries.name, qName)));
    if (!rows.length) { console.log(`- ${ref}: not registered here, skipped`); continue; }
    for (const { q } of rows) {
      const described = q.describedJson as DescribedQuery | null;
      if (!described) { refused.push(`${ref}: not described — run describe-queries first`); continue; }
      const { problems } = withDeclaredTags(described.columns, tags);
      if (problems.length) { refused.push(`${ref}: ${problems.join("; ")}`); continue; }
      plan.push({ id: q.id, ref, tags: { ...tags } });
    }
  }
  if (refused.length) { console.error(`refused, nothing written:\n  ${refused.join("\n  ")}`); process.exit(1); }
  for (const p of plan) {
    await db.update(datasourceQueries).set({ columnTags: p.tags }).where(eq(datasourceQueries.id, p.id));
    console.log(`✓ ${p.ref}: ${Object.entries(p.tags).map(([c, t]) => `${c}=${t}`).join(", ")}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
