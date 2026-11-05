/**
 * `heldout:verify` — two independent implementations must agree (compiled-builder phase 1, D-313).
 *
 *   pnpm --filter @foundry/server heldout:verify
 *
 * The oracle (TypeScript over the generated rows) against the reference SQL (run as `fleet_ro` against the seeded
 * database), row for row, on every field. Then the negative control: the overheating query with the unit conversion
 * REMOVED must disagree. A comparison that agreed with a broken query would pass on nothing (I-38).
 * Exits 1 on any disagreement, and fails rather than skipping if the database is unreachable.
 */
import { Client } from "pg";
import { domainRoUrl } from "../generic/domain.js";
import { FLEET_AS_OF, FLEET_DOMAIN, FLEET_TABLES } from "./fleet.js";
import { fleetOracle } from "./fleet-oracle.js";
import { FLEET_REFERENCE_SQL } from "./fleet-reference.js";

const norm = (rows: Array<Record<string, unknown>>) =>
  JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v === null ? null : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]))));

async function main() {
  const oracle = fleetOracle(FLEET_TABLES, FLEET_AS_OF);
  const client = new Client({ connectionString: domainRoUrl(FLEET_DOMAIN) });
  await client.connect();
  let failures = 0;
  try {
    for (const key of ["overheating", "lowBattery", "silent", "byClass"] as const) {
      const { rows } = await client.query(FLEET_REFERENCE_SQL[key], [FLEET_AS_OF]);
      const want = norm(oracle[key] as unknown as Array<Record<string, unknown>>);
      const got = norm(rows);
      const ok = want === got;
      console.log(`${ok ? "AGREE   " : "DISAGREE"} ${key.padEnd(12)} ${rows.length} rows`);
      if (!ok) { failures++; console.log(`   oracle ${want}\n   sql    ${got}`); }
    }
    // Negative control: the units trap reintroduced must be caught.
    const broken = FLEET_REFERENCE_SQL.overheating.replaceAll("CASE l.temp_unit WHEN 'F' THEN (l.temperature - 32) * 5 / 9 ELSE l.temperature END", "l.temperature");
    if (broken === FLEET_REFERENCE_SQL.overheating) throw new Error("negative control did not perturb the query: INCONCLUSIVE");
    const { rows: wrong } = await client.query(broken, [FLEET_AS_OF]);
    const caught = norm(wrong.map(({ temp_c: _t, ...r }) => r)) !== norm(oracle.overheating.map(({ temp_c: _t, ...r }) => r));
    console.log(`${caught ? "CONTROL " : "CONTROL FAILED"} unit conversion removed → ${wrong.length} rows vs oracle ${oracle.overheating.length}: ${caught ? "the comparison notices" : "the comparison did NOT notice"}`);
    if (!caught) failures++;
  } finally {
    await client.end();
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(`heldout:verify could not run: ${(e as Error).message}`); process.exit(2); });
