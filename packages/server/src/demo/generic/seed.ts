/**
 * `pnpm --filter @foundry/server generic:seed [--only=support|orders|hiring]`
 *
 * Provisions the three generic domains — Customer Support, Orders & Fulfilment
 * and Recruitment. Each gets its own database, its own read-only role, its own
 * named queries and the generic tool catalogue.
 *
 * ⚠ **It creates NO FLOWS.** Authoring is done through the product, and a
 * hand-written flow proves nothing about a generator. `generic:flows` seeds the
 * demo flows separately, after this.
 */
import { GENERIC_DOMAINS } from "./index.js";
import { provisionDomain } from "./provision.js";
import { checkRoleIsolation } from "./domain.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

async function main() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const domains = only ? GENERIC_DOMAINS.filter((d) => d.key === only) : GENERIC_DOMAINS;
  if (domains.length === 0) {
    console.error(c.bad(`\nno such domain "${only}" — one of: ${GENERIC_DOMAINS.map((d) => d.key).join(", ")}\n`));
    process.exit(1);
  }

  console.log(`\n${"═".repeat(76)}\ngeneric:seed  ${c.dim(domains.map((d) => d.key).join(", "))}\n${"═".repeat(76)}`);
  let failures = 0;

  for (const spec of domains) {
    console.log(`\n${c.ok(spec.workspaceName)} ${c.dim(spec.dbName)}`);
    try {
      const r = await provisionDomain(spec);
      const rows = r.seed.tables.reduce((n, t) => n + t.rows, 0);
      console.log(
        `  data       ${r.seed.tables.length} tables, ${rows} rows` +
          c.dim(r.seed.created ? "  (database created)" : "  (database reused)"),
      );
      // ⚠ Reported every run, not asserted once. The grants are re-derived from
      // `pg_catalog` by the seeder, so this line is the truth about the role
      // rather than a restatement of the GRANT statements.
      // ⚠ Only the privileges that are stable during seeding are reported here.
      // Cross-database reachability is asked at the END — see the final pass.
      const role = r.seed.role;
      const gradeOk = role.canSelect && role.writeGrants.length === 0;
      console.log(
        `  role       ${role.name} ${gradeOk ? c.ok("read-only") : c.bad("PROBLEM")}` +
          (role.writeGrants.length ? c.bad(`  writes: ${role.writeGrants.join(", ")}`) : "") +
          (role.canSelect ? "" : c.bad("  cannot SELECT — was the grant issued before the DDL?")),
      );
      if (!gradeOk) failures++;
      console.log(`  workspace  ${r.workspaceId}${c.dim(r.workspaceCreated ? "  (created)" : "  (reused)")}`);
      console.log(`  tools      ${r.tools.total} ${c.dim(`(${r.tools.created} new, ${r.tools.updated} updated)`)}`);
      console.log(`  datasource ${r.datasource.tables} tables, ${r.datasource.columns} columns introspected`);
      console.log(`  queries    ${r.queries.length} ${c.dim(r.queries.map((q) => q.name).join(", "))}`);
      /**
       * ⚠ Printed in FULL, including the refusals. A build that did not start
       * because the schema is too large leaves this datasource reading
       * PRODUCTION on every draft run — the one outcome a person must not have
       * to go looking for.
       */
      console.log(
        r.sandbox.started
          ? `  sandbox    ${c.dim("building — fixtures in ~100s; until then a draft run reads production")}`
          : r.sandbox.why === "already_has_fixture"
            ? `  sandbox    ${c.dim("already built — re-provisioning is destructive and stays a command")}`
            : `  ${c.warn("sandbox not built")} ${r.sandbox.why}${r.sandbox.detail ? ` — ${r.sandbox.detail}` : ""}`,
      );
      console.log(`  manifest   v${r.manifest.version} ${c.dim(`${r.manifest.bytes} bytes`)}`);
      if (r.secrets.missing.length) {
        console.log(`  ${c.warn("secrets missing")} ${r.secrets.missing.join(", ")}`);
      }
    } catch (e) {
      failures++;
      console.log(`  ${c.bad("FAILED")} ${(e as Error).message}`);
    }
  }

  /**
   * ⚠ **The isolation pass, run LAST and separately.** Each domain seals its own
   * database against PUBLIC, so asking mid-sequence gets an answer that is true
   * at that instant and false a moment later — which is what the first run of
   * this file reported, alarmingly and correctly.
   */
  console.log(`\n${"─".repeat(76)}\nisolation ${c.dim("— can each role reach another tenant's database?")}\n`);
  for (const spec of domains) {
    const iso = await checkRoleIsolation(spec);
    const ok = iso.reachable.length === 0;
    console.log(
      `  ${spec.roRole.padEnd(12)} ${ok ? c.ok("isolated") : c.bad(`REACHES ${iso.reachable.join(", ")}`)}` +
        (iso.notChecked.length ? c.dim(`  (not present: ${iso.notChecked.join(", ")})`) : ""),
    );
    if (!ok) failures++;
  }

  console.log(`\n${"═".repeat(76)}`);
  console.log(
    failures === 0
      ? `  ${c.ok("every domain provisioned")}${c.dim("  ·  next: generic:flows")}\n`
      : `  ${c.bad(`${failures} domain(s) had a problem`)}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(c.bad(`\ngeneric:seed failed: ${(e as Error).message}\n`));
  process.exit(1);
});
