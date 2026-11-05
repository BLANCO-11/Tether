/**
 * HR demo CLI — `pnpm demo:seed | demo:reset | demo:status | demo:verify`.
 *
 * Wraps the same functions provisioning has always used, so seeding from a terminal
 * and seeding over HTTP cannot drift apart.
 */
import { demoStatus, provisionDemo, resetDemo } from "./provision.js";
import { provisionAltDemo } from "./alt/provision-alt.js";
import { provisionFinance } from "./finance/provision-finance.js";
import { provisionLegal } from "./legal/provision-legal.js";
import { provisionItops } from "./itops/provision-itops.js";
import { ITOPS_DEFAULT_AS_OF } from "./itops/itops-dataset.js";
import { pool } from "../db/index.js";

const cmd = process.argv[2] ?? "status";

async function main() {
  switch (cmd) {
    case "provision":
    case "seed": {
      const r = await provisionDemo();
      console.log(JSON.stringify(r, null, 2));
      console.log(
        `\n✓ workspace ${r.workspaceId} — ${r.tools.total} tools, ` +
          `${r.datasource.tablesIntrospected} tables / ${r.datasource.columnsIntrospected} columns introspected, manifest v${r.manifest.version} ` +
          `(${r.manifest.bytes} bytes)`,
      );
      console.log(
        `✓ oracle: ${r.oracle.flagged.length} below threshold, ${r.oracle.excluded.length} excluded, ` +
          `${r.oracle.unmailable.length} unmailable, ${r.oracle.bouncing.length} bouncing`,
      );
      const ro = r.seed.readOnlyRole;
      console.log(
        `${ro.problems.length ? "✗" : "✓"} read-only role ${ro.role}: SELECT on ` +
          `${ro.selectableTables.length} table(s), no write privileges` +
          (ro.problems.length ? ` — PROBLEMS: ${ro.problems.join("; ")}` : "") +
          ` (schema introspected as ${r.datasource.introspectedAs})`,
      );
      if (ro.problems.length) process.exitCode = 1;
      break;
    }
    case "reset": {
      const r = await resetDemo();
      console.log(JSON.stringify(r, null, 2));
      console.log(`\n✓ reseeded ${r.seed.database}; truncated ${r.truncated.join(", ")}`);
      console.log(`  preserved: ${r.preserved.join(", ")}`);
      break;
    }
    // WS-E.1/E.2 — the swap-rehearsal dataset.
    case "provision-alt":
    case "seed-alt": {
      const r = await provisionAltDemo();
      console.log(JSON.stringify({ ...r, oracle: { flagged: r.oracle.flagged.length } }, null, 2));
      console.log(
        `\n✓ alt workspace ${r.workspaceId} — ${r.tools.total} tools, ` +
          `${r.datasource.entitiesIntrospected} entities ` +
          `(${r.datasource.viewsIntrospected} views) / ${r.datasource.columnsIntrospected} columns ` +
          `from schema ${r.datasource.schemaAllowlist.join(",")}, manifest v${r.manifest.version} ` +
          `(${r.manifest.bytes} bytes)`,
      );
      console.log(
        `✓ alt oracle: ${r.oracle.flagged.length} below threshold ` +
          `(${r.oracle.overrideOnly.length} only via a unit override), ` +
          `${r.oracle.excluded.length} excluded, ${r.oracle.unmailable.length} unmailable, ` +
          `${r.oracle.bouncing.length} bouncing`,
      );
      const ro = r.seed.readOnlyRole;
      console.log(
        `${ro.problems.length ? "✗" : "✓"} read-only role ${ro.role} on schema hr` +
          (ro.problems.length ? ` — PROBLEMS: ${ro.problems.join("; ")}` : ""),
      );
      if (ro.problems.length) process.exitCode = 1;
      break;
    }
    // Programme 3, Stage 1 — the second real domain.
    case "provision-finance":
    case "seed-finance": {
      const r = await provisionFinance();
      const o = r.oracle;
      console.log(JSON.stringify({ ...r, oracle: undefined }, null, 2));
      console.log(
        `\n✓ Finance workspace ${r.workspaceId} — ${r.tools.total} tools, ` +
          `${r.queries.length} named queries, ${r.datasource.tablesIntrospected} tables / ` +
          `${r.datasource.columnsIntrospected} columns, manifest v${r.manifest.version} ` +
          `(${r.manifest.bytes} bytes)`,
      );
      console.log(
        `✓ oracle @${o.period}: ${o.overdue.length} overdue ` +
          `(${Object.entries(o.overdueByBucket).filter(([, n]) => n).map(([b, n]) => `${b}:${n}`).join(" ")}), ` +
          `${o.duplicates.length} duplicate pair(s), ${o.claimsOverPolicy.length} claim(s) over policy, ` +
          `${o.spendByCostCentre.filter((s) => s.overBudget).length} cost centre(s) over budget`,
      );
      const ro = r.seed.readOnlyRole;
      console.log(
        `${ro.problems.length ? "✗" : "✓"} read-only role ${ro.role}: SELECT on ` +
          `${ro.selectableTables.length} table(s), no write privileges, no CONNECT to ` +
          `[${ro.isolatedFrom.join(", ") || "no other tenant database present"}]` +
          (ro.problems.length ? ` — PROBLEMS: ${ro.problems.join("; ")}` : ""),
      );
      // ⚠ Printed, not swallowed. A roster entry that was absent was not proven
      // unreachable — it was not asked about, and the two must not look alike.
      if (ro.notChecked.length) {
        console.log(`  NOT CHECKED (database absent): ${ro.notChecked.join(", ")}`);
      }
      if (r.secrets.collisions.length) {
        console.log(`✗ secret name collisions: ${r.secrets.collisions.join(", ")}`);
      }
      if (r.secrets.missing.length) {
        console.log(
          `✗ declared but unstored: ${r.secrets.missing.map((m) => `${m.envName} (${m.neededBy})`).join(", ")}`,
        );
      }
      if (ro.problems.length || r.secrets.collisions.length || r.secrets.missing.length) {
        process.exitCode = 1;
      }
      break;
    }
    // The third real domain — contract lifecycle and obligations.
    case "provision-legal":
    case "seed-legal": {
      const r = await provisionLegal();
      const o = r.oracle;
      console.log(JSON.stringify({ ...r, oracle: undefined }, null, 2));
      console.log(
        `\n✓ Legal workspace ${r.workspaceId} — ${r.tools.total} tools, ` +
          `${r.queries.length} named queries, ${r.datasource.tablesIntrospected} tables / ` +
          `${r.datasource.columnsIntrospected} columns, manifest v${r.manifest.version} ` +
          `(${r.manifest.bytes} bytes)`,
      );
      console.log(
        `✓ oracle @${o.asOf}: ${o.renewalDue.length} renewal(s) due ` +
          `(${Object.entries(o.renewalByBucket).filter(([, n]) => n).map(([b, n]) => `${b}:${n}`).join(" ")}), ` +
          `${o.lapseRisk.length} lapse-risk, ${o.missedDeadlines.length} missed deadline(s), ` +
          `${o.obligationsDue.length} obligation(s) due (${o.obligationsOverdue.length} overdue), ` +
          `${o.alreadyNoticed.length} already noticed`,
      );
      const pt = r.platformTools;
      console.log(
        `✓ platform tools: ${pt.created.length} created, ${pt.updated.length} updated` +
          (pt.created.length ? ` — RESTORED ${pt.created.join(", ")}` : ""),
      );
      const ro = r.seed.readOnlyRole;
      console.log(
        `${ro.problems.length ? "✗" : "✓"} read-only role ${ro.role}: SELECT on ` +
          `${ro.selectableTables.length} table(s), no write privileges, no CONNECT to ` +
          `[${ro.isolatedFrom.join(", ") || "no other tenant database present"}]` +
          (ro.problems.length ? ` — PROBLEMS: ${ro.problems.join("; ")}` : ""),
      );
      if (r.secrets.collisions.length) {
        console.log(`✗ secret name collisions: ${r.secrets.collisions.join(", ")}`);
      }
      if (r.secrets.missing.length) {
        console.log(
          `✗ declared but unstored: ${r.secrets.missing.map((m) => `${m.envName} (${m.neededBy})`).join(", ")}`,
        );
      }
      if (ro.problems.length || r.secrets.collisions.length || r.secrets.missing.length) {
        process.exitCode = 1;
      }
      break;
    }
    case "provision-itops":
    case "seed-itops": {
      const r = await provisionItops();
      const o = r.oracle;
      console.log(JSON.stringify({ ...r, oracle: undefined }, null, 2));
      console.log(
        `\n✓ IT Operations workspace ${r.workspaceId} — ${r.tools.total} tools, ` +
          `${r.queries.length} named queries, ${r.datasource.tablesIntrospected} tables / ` +
          `${r.datasource.columnsIntrospected} columns, manifest v${r.manifest.version} ` +
          `(${r.manifest.bytes} bytes)`,
      );
      console.log(
        `✓ oracle @${ITOPS_DEFAULT_AS_OF}: ${o.bandCounts.breached} breached, ` +
          `${o.bandCounts.at_risk} at risk, ${o.bandCounts.healthy} healthy ` +
          `(${o.open.length} open), ${o.unacknowledged.length} unacknowledged, ` +
          `${o.actionableVulns.length} actionable vuln(s) — ${o.deferredVulns.length} deferred ` +
          `by [${o.activeFreezes.join(", ") || "no active freeze"}], ` +
          `${o.staleAssets.length} stale asset(s)`,
      );
      console.log(
        `✓ traps live: ${o.disagreements.length} incident(s) where the naive clock disagrees, ` +
          `${o.tierSensitive.length} where the tier changes the answer, ` +
          `${o.orgFallbackEscalations.length} escalation(s) via the org fallback`,
      );
      // ⚠ Named, not counted. This workspace is the only one that can wake a
      // person, and a count would not say which capability it was.
      console.log(
        `✓ paging: this workspace holds ${r.secrets.stored.includes("PAGING_API_TOKEN") ? "PAGING_API_TOKEN" : "NO paging credential — page_oncall will 401"}` +
          " (Finance and Legal hold none, deliberately)",
      );
      const pt = r.platformTools;
      console.log(
        `✓ platform tools: ${pt.created.length} created, ${pt.updated.length} updated` +
          (pt.created.length ? ` — RESTORED ${pt.created.join(", ")}` : ""),
      );
      const ro = r.seed.readOnlyRole;
      console.log(
        `${ro.problems.length ? "✗" : "✓"} read-only role ${ro.role}: SELECT on ` +
          `${ro.selectableTables.length} table(s), no write privileges, no CONNECT to ` +
          `[${ro.isolatedFrom.join(", ") || "no other tenant database present"}]` +
          (ro.problems.length ? ` — PROBLEMS: ${ro.problems.join("; ")}` : ""),
      );
      if (r.secrets.collisions.length) {
        console.log(`✗ secret name collisions: ${r.secrets.collisions.join(", ")}`);
      }
      if (r.secrets.missing.length) {
        console.log(
          `✗ declared but unstored: ${r.secrets.missing.map((m) => `${m.envName} (${m.neededBy})`).join(", ")}`,
        );
      }
      if (ro.problems.length || r.secrets.collisions.length || r.secrets.missing.length) {
        process.exitCode = 1;
      }
      break;
    }
    case "status": {
      console.log(JSON.stringify(await demoStatus(), null, 2));
      break;
    }
    default:
      console.error(
        `unknown command "${cmd}"; use provision | provision-alt | provision-finance | ` +
          `provision-legal | provision-itops | reset | status`,
      );
      process.exit(2);
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
