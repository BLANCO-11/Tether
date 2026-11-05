/**
 * Rebuild draft-run mocks — every postgres datasource, or the ones named.
 *
 *   pnpm --filter @foundry/server mock:rebuild [--datasource=<name>[,<name>]]
 *
 * A new fixture version per datasource, built by the same `rebuildMockDataset`
 * the datasource page's Rebuild button calls. Exists for D-268 (a mock built
 * before value hints landed keeps its `mock_<col>_<n>` text until rebuilt) and
 * as the proof of I-229: this runs on the HOST and writes data/mocks, and the
 * server — a bind mount away — must read what it wrote. Prints, per datasource,
 * the new version and which columns took hints from which source.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceFixtures, datasources } from "../db/schema.js";
import { rebuildMockDataset } from "../services/mock-dataset.service.js";
import { supportsMockType } from "../services/mock-engine/registry.js";

const only = process.argv.find((a) => a.startsWith("--datasource="))?.slice("--datasource=".length).split(",");

async function main() {
  // Every engine the mock builder supports — the service's own rule, never a second list here (2026-10-02: SQLite was left out).
  const all = (await db.select().from(datasources)).filter((d) => supportsMockType(d.type));
  const targets = only ? all.filter((d) => only.includes(d.name)) : all;
  if (only && targets.length !== only.length) {
    console.error(`unknown datasource(s): ${only.filter((n) => !all.some((d) => d.name === n)).join(", ")}`);
    process.exit(2);
  }
  let failed = 0;
  for (const ds of targets) {
    const out = await rebuildMockDataset(ds.workspaceId, ds.id);
    if (!out.started) {
      failed++;
      console.log(`✗ ${ds.name}: ${out.why}${"detail" in out && out.detail ? ` — ${out.detail}` : ""}`);
      continue;
    }
    const [row] = await db
      .select({ version: datasourceFixtures.version, taxonomy: datasourceFixtures.taxonomyJson })
      .from(datasourceFixtures)
      .where(and(eq(datasourceFixtures.datasourceId, ds.id)))
      .orderBy(desc(datasourceFixtures.version))
      .limit(1);
    const vh = (row?.taxonomy as { valueHints?: { provenance?: Record<string, Record<string, number>>; notes?: string[] } })?.valueHints;
    const cols = Object.entries(vh?.provenance ?? {}).map(([k, p]) => `${k}(${Object.entries(p).map(([s, n]) => `${s}:${n}`).join(",")})`);
    console.log(`✓ ${ds.name}: v${row?.version} · ${cols.length} hinted column(s)${cols.length ? `: ${cols.join(" ")}` : ""}`);
    for (const n of vh?.notes ?? []) console.log(`    note: ${n}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
