/**
 * `address:tags` — declare the demo databases' address columns on the LIVE databases (compiled-builder I-283). Metadata only (a
 * column comment); refuses to overwrite a comment it did not write. Then run `describe-queries.ts --introspect=…` so the tags reach
 * `schemas.semantic_tag` and every named query's described columns. No model calls.
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/address-tags-apply.ts
 */
import { Client } from "pg";
import { config } from "../config/index.js";
import { ADDRESS_COLUMNS, KEY_COLUMNS, applyColumnTags } from "../demo/address-tags.js";

async function main() {
  for (const db of new Set([...Object.keys(ADDRESS_COLUMNS), ...Object.keys(KEY_COLUMNS)])) {
    const u = new URL(config.databaseUrl);
    u.pathname = `/${db}`;
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try {
      const r = await applyColumnTags(c, db);
      console.log(`${db}: set ${r.set.length} [${r.set.join(", ")}] · already ${r.already.length}`);
    } finally {
      await c.end();
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
