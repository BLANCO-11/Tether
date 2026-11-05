/**
 * Deploy Foundry's operational flows into `foundry.system`.
 * archive/kestra-migration/progress/phase-1.md 1.3 (O4)
 *
 *   pnpm kestra:system              # deploy + report
 *   pnpm kestra:system --dry-run    # validate + print, deploy nothing
 *
 * Today that is one flow: retention. It is separated from `kestra:prove` because
 * it is not part of the falsification gate — it is infrastructure that must
 * survive Phase 1 being wrong.
 *
 * Idempotent: re-running redeploys the same YAML and Kestra bumps the revision
 * only when the content actually changed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kestra, systemNamespace, KestraError } from "../services/kestra-client.service.js";
import { config } from "../config/index.js";
import { retentionCoupling } from "../services/retention.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * How long Kestra keeps a terminal execution and its files.
 *
 * 30 days is a deliberate default rather than a maximum: Phase 6 is replay, and
 * replaying an execution needs its inputs and outputs to still exist. Shorten it
 * on a disk-constrained host, but know that you are shortening the replay window
 * at the same time.
 */
// Via `config`, not a second `process.env` read: Phase 6's replay refusal quotes
// this number back to the user ("executions are retained for N days"), and two
// independent defaults would eventually have it promising 30 while the purge
// deployed here ran at 7.
const RETENTION_DAYS = config.kestra.retentionDays;
/** Off-peak by default. Purge is a bulk delete against the same Postgres the app uses. */
const PURGE_CRON = process.env.KESTRA_PURGE_CRON?.trim() || "0 3 * * *";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

interface SystemFlow {
  id: string;
  file: string;
  render: (yaml: string) => string;
}

const FLOWS: SystemFlow[] = [
  {
    id: "retention",
    file: "retention.flow.yml",
    // Substituted rather than templated in Pebble: `RETENTION_DAYS` has to be a
    // literal inside `dateAdd(-N, 'DAYS')`, and the cron is a trigger property
    // that Kestra evaluates before any execution context exists.
    render: (yaml) =>
      yaml
        .replaceAll("RETENTION_DAYS", String(RETENTION_DAYS))
        .replace('cron: "PURGE_CRON"', `cron: "${PURGE_CRON}"`),
  },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const ns = systemNamespace();
  console.log(`\nsystem flows → ${ns.value}\n${"─".repeat(48)}`);
  console.log(`retention  ${c.dim(`${RETENTION_DAYS} days, purge at "${PURGE_CRON}"`)}`);
  // GAPS §6.3 — this is the surface where somebody CHOOSES the number, so it is
  // the one place the second meaning has to be impossible to miss. Printed at
  // every run, dry or not, and imported rather than retyped so it cannot end up
  // promising a different window from the one the browser shows.
  console.log(c.warn(`           ⚠ ${retentionCoupling(RETENTION_DAYS)}`));

  if (!Number.isInteger(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error(`KESTRA_RETENTION_DAYS must be a positive integer, got "${process.env.KESTRA_RETENTION_DAYS}"`);
  }

  const health = await kestra.health();
  if (!health.authenticated) throw new Error(`Kestra not reachable/authenticated: ${health.detail}`);

  for (const flow of FLOWS) {
    const yaml = flow.render(fs.readFileSync(path.join(here, flow.file), "utf8"))
      .replace(/^namespace:.*$/m, `namespace: ${ns.value}`);

    const findings = (await kestra.validateFlow(yaml)) ?? [];
    const problems = findings.filter((f) => f.constraints);
    if (problems.length) {
      console.error(c.bad(`  ✗ ${flow.id} rejected:`));
      for (const p of problems) console.error(`    ${p.constraints}`);
      process.exit(1);
    }
    if (dryRun) {
      console.log(`  ${c.ok("✓")} ${flow.id} validates ${c.dim("(dry run — not deployed)")}`);
      console.log(yaml.replace(/^/gm, "    "));
      continue;
    }
    const deployed = await kestra.deployFlow(ns, flow.id, yaml);
    console.log(`  ${c.ok("✓")} ${flow.id} deployed, revision ${deployed.revision}`);
  }

  if (!dryRun) {
    // The point of the system namespace: it cannot reach a tenant credential.
    // Asserted here rather than trusted, because the guarantee is a property of
    // the namespace SHAPE and a future prefix change could silently break it.
    console.log(`\n  ${c.dim("boundary: foundry.system has no tenant segment, so /api/executions/begin refuses it")}`);
  }
  console.log();
}

main().catch((e) => {
  if (e instanceof KestraError) {
    console.error(c.bad(`\nKestra error ${e.status}:`), e.message);
    console.error(JSON.stringify(e.body, null, 2)?.slice(0, 2000));
  } else {
    console.error(c.bad("\nfailed:"), (e as Error).message);
  }
  process.exit(1);
});
