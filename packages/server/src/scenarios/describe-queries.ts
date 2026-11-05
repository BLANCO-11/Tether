/**
 * `describe:queries` — backfill for compiled-builder phase 2b (I-271, G13, I-278).
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/describe-queries.ts [--introspect=fleet_demo,…]
 *
 * 1. Every named query in every workspace is DESCRIBED by its own database (parameters and result columns, no row
 *    read) and the answer stored on `datasource_queries.described_json`. Registration does this from now on; this
 *    covers what was registered before it did.
 * 2. `--introspect=` re-introspects the named datasources so a declared `foundry:tag=` column comment lands on
 *    `schemas.semantic_tag`. It calls the introspector directly, NOT `datasourceService.refreshSchema`, which would
 *    also fire the model-generated sandbox hook.
 * No model calls. Prints, per query, what the database said, so a query it could not describe is visible by name.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { datasourceQueries, datasources } from "../db/schema.js";
import { describeOrNull } from "../services/datasource-query.service.js";
import { schemaIntrospectorService } from "../services/schema-introspector.service.js";
import { decrypt } from "../utils/encryptor.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const INTROSPECT = (arg("introspect") ?? "").split(",").filter(Boolean);

async function main() {
  const dss = await db.select().from(datasources);
  const byId = new Map(dss.map((d) => [d.id, d]));
  const queries = await db.select().from(datasourceQueries);
  let described = 0, failed = 0;
  for (const q of queries) {
    const ds = byId.get(q.datasourceId);
    if (!ds) continue;
    const d = await describeOrNull(ds, q.sqlText, (q.paramOrder ?? []) as string[]);
    await db.update(datasourceQueries).set({ describedJson: d }).where(eq(datasourceQueries.id, q.id));
    if (d) {
      described++;
      const dates = d.params.filter((p) => /^(date|timestamp)/.test(p.type)).map((p) => `${p.name}:${p.type}`);
      console.log(`✓ ${ds.name}.${q.name}: ${d.columns.length} columns (${d.columns.filter((c) => !c.nullable).length} non-null) · params ${d.params.map((p) => `${p.name}:${p.type}`).join(",")}${dates.length ? "" : ""}`);
    } else {
      failed++;
      console.log(`✗ ${ds.name}.${q.name}: could not be described`);
    }
  }
  console.log(`described ${described} · not described ${failed} · of ${queries.length}`);
  for (const name of INTROSPECT) {
    for (const ds of dss.filter((d) => d.name === name && d.connectionStringEnc)) {
      const r = await schemaIntrospectorService.refresh(ds.id, ds.type, decrypt(ds.connectionStringEnc!), { schemas: ds.schemaAllowlist ?? ["public"] });
      console.log(`introspected ${name} (${ds.id}): ${r.tables} tables, ${r.columns} columns`);
    }
  }
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
