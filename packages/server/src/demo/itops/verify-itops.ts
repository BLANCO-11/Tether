/**
 * IT operations dataset self-check — `pnpm --filter @foundry/server itops:verify`.
 *
 * Two halves, and the second is the one that matters.
 *
 *   A. INVARIANTS OF THE DEFINITIONS. Every trap is present and still bites,
 *      every address is on a reserved domain, the headline counts are what the
 *      documentation claims. No database involved.
 *
 *   B. THE NAMED QUERIES AGAINST THE ORACLE. Each query is executed as
 *      `itops_ro` against the seeded database, at every as-of instant, and
 *      its answer is compared to `itopsOracle()` row for row and MINUTE FOR
 *      MINUTE.
 *
 * ⚠ HALF B IS THE ONLY THING THAT CAN CATCH THIS DOMAIN'S REAL FAILURE MODE.
 * The oracle computes the SLA clock in TypeScript, walking days; the catalogue
 * computes it in SQL, with `generate_series`. They were written from the schema
 * independently. When they agree on the consumed minutes for twenty-nine
 * incidents at three instants, the business-hours window, the paused spans and
 * the two-column policy lookup are right in BOTH — and when they disagree, the
 * harness names the incident and prints both numbers. Half A cannot do that: it
 * would happily declare the business-hours trap "present" while every query in
 * the catalogue subtracted timestamps.
 *
 * ⚠ It compares MINUTES, not just bands. A band comparison passes whenever two
 * wrong figures land in the same third of the range, which for the healthy band
 * is most of the time. INC-1030 is the case that proves it: starting the clock
 * at `opened_at` instead of at 09:00 gives 360 minutes rather than 300, and both
 * are breached against a 240-minute budget.
 *
 * ⚠ It FAILS rather than skipping when the database is unreachable. A verifier
 * that quietly drops its strongest half is the false green this repo keeps
 * finding; run `pnpm --filter @foundry/server itops:seed` first.
 *
 * ⚠ Half B also asserts the two SLA queries are DISJOINT and that their union is
 * exactly the oracle's actionable set, at every instant. That is the guard on
 * the one piece of deliberate duplication in `itops-queries.ts`: the clock
 * arithmetic is written twice, and this is what stops the two copies drifting.
 */
import { Client } from "pg";
import {
  ASSETS,
  ASSET_VULNERABILITIES,
  AT_RISK_FRACTION,
  CHANGE_FREEZES,
  INCIDENTS,
  INCIDENT_PAUSES,
  ITOPS_AS_OF,
  ITOPS_QUIET_AS_OF,
  ON_CALL,
  ORG_SETTINGS,
  SERVICES,
  SLA_POLICIES,
  TEAMS,
  VULNERABILITIES,
  itopsOracle,
  orgSetting,
} from "./itops-dataset.js";
import { ITOPS_GENERATED_QUERIES as ITOPS_QUERIES } from "./itops-generated.js";
import { ITOPS_RO_ROLE, itopsRoDbUrl, verifyItopsReadOnlyRole } from "./seed-itops-db.js";

const problems: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) problems.push(msg);
};
const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
const rule = () => console.log(c.dim("─".repeat(72)));

const query = (name: string) => {
  const q = ITOPS_QUERIES.find((x) => x.name === name);
  if (!q) throw new Error(`no named query ${name} — the catalogue and this harness disagree`);
  return q;
};

// ═══════════════════════════════════════════════════════════════════════════
// HALF A — invariants of the definitions. No database.
// ═══════════════════════════════════════════════════════════════════════════

function halfA() {
  console.log("dataset invariants " + c.dim("(from the definitions, no database)"));

  // ── Populations ───────────────────────────────────────────────────────────
  check(ORG_SETTINGS.length === 5, `org_settings: ${ORG_SETTINGS.length}, expected 5`);
  check(TEAMS.length === 5, `teams: ${TEAMS.length}, expected 5`);
  check(SERVICES.length === 7, `services: ${SERVICES.length}, expected 7`);
  check(SLA_POLICIES.length === 16, `sla_policies: ${SLA_POLICIES.length}, expected 16 (4 tiers x 4 priorities)`);
  check(ON_CALL.length === 7, `on_call: ${ON_CALL.length}, expected 7`);
  check(INCIDENTS.length === 30, `incidents: ${INCIDENTS.length}, expected 30`);
  check(INCIDENT_PAUSES.length === 5, `incident_pauses: ${INCIDENT_PAUSES.length}, expected 5`);
  check(ASSETS.length === 14, `assets: ${ASSETS.length}, expected 14`);
  check(VULNERABILITIES.length === 12, `vulnerabilities: ${VULNERABILITIES.length}, expected 12`);
  check(ASSET_VULNERABILITIES.length === 26, `asset_vulnerabilities: ${ASSET_VULNERABILITIES.length}, expected 26`);
  check(CHANGE_FREEZES.length === 3, `change_freezes: ${CHANGE_FREEZES.length}, expected 3`);

  // ── The SLA policy key is genuinely composite ─────────────────────────────
  const tiers = new Set(SLA_POLICIES.map((p) => p.tier));
  for (const t of tiers) {
    const forTier = SLA_POLICIES.filter((p) => p.tier === t);
    check(forTier.length === 4, `tier ${t} has ${forTier.length} policies, expected 4`);
  }
  const shared = SLA_POLICIES.filter((p) => p.resolveMins === 480);
  check(
    shared.length === 4,
    `TRAP 3: ${shared.length} policies share resolveMins 480, expected 4 — the collision is ` +
      "what makes a priority-only lookup look right often enough to ship",
  );

  // ── Every trap is reachable at some instant ───────────────────────────────
  for (const asOf of ITOPS_AS_OF) {
    const o = itopsOracle(asOf);

    check(
      o.breached.length + o.resolvedBreaches.length > 0,
      `@${asOf}: nothing is breached — "nothing to report" would be the right answer, and then ` +
        "a flow that returns an empty set scores full marks",
    );
    check(
      o.disagreements.length > 0,
      `@${asOf}: the naive and the correct arithmetic agree about everything — the clock traps ` +
        "are unreachable at this instant",
    );
    check(
      o.tierSensitive.length > 0,
      `@${asOf}: no incident's band depends on its tier — TRAP 3 is unreachable at this instant`,
    );
    // Disjointness of the two bands, which the two queries mirror.
    const overlap = o.breached.filter((b) => o.atRisk.some((a) => a.incidentCode === b.incidentCode));
    check(overlap.length === 0, `@${asOf}: ${overlap.length} incident(s) in both bands`);
    check(
      o.teamsWithNoOnCall.length === 1 && o.teamsWithNoOnCall[0] === "WORKPLACE",
      `@${asOf}: teams with nobody on call = [${o.teamsWithNoOnCall.join(", ")}], expected ` +
        "[WORKPLACE] — a second uncovered team makes the deliberate one unreadable",
    );
    check(
      o.deferredVulns.length + o.proceedingVulns.length === o.actionableVulns.length,
      `@${asOf}: a freeze DROPPED work instead of deferring it`,
    );
    if (o.breached.length > 0) {
      check(
        o.orgFallbackEscalations.length > 0,
        `@${asOf}: ${o.breached.length} open breach(es) and none escalates through the org ` +
          "fallback — TRAP 8's second hop is never taken, so it reads as passing without firing",
      );
    }
  }

  // ── The empty case exists, and is not an empty dataset ────────────────────
  const quiet = ITOPS_AS_OF.filter((a) => {
    const o = itopsOracle(a);
    return o.breached.length === 0 && o.atRisk.length === 0;
  });
  check(
    quiet.length === 1 && quiet[0] === ITOPS_QUIET_AS_OF,
    `expected exactly one instant with an empty actionable set (${ITOPS_QUIET_AS_OF}), got ` +
      `[${quiet.join(", ")}] — without one, the else arm of a three-way branch is never taken`,
  );

  // ── The threshold has one definition ─────────────────────────────────────
  check(
    Number(orgSetting("at_risk_fraction")) === AT_RISK_FRACTION,
    `org_settings.at_risk_fraction (${orgSetting("at_risk_fraction")}) disagrees with ` +
      `AT_RISK_FRACTION (${AT_RISK_FRACTION}) — two defaults, and they will diverge`,
  );

  // ── T8: the fallback cannot be reached by luck ───────────────────────────
  const org = orgSetting("escalation_fallback_email");
  check(
    TEAMS.filter((t) => t.escalationEmail === null).length === 1,
    "TRAP 8: expected exactly one team with no escalation address of its own",
  );
  for (const t of TEAMS) {
    check(
      t.escalationEmail !== org,
      `TRAP 8: team ${t.code}'s escalation address equals the org fallback — a query that skips ` +
        "the team hop then resolves the right address by luck and the trap is undetectable",
    );
  }

  // ── Synthetic data ───────────────────────────────────────────────────────
  const addresses = [
    ...TEAMS.flatMap((t) => [t.contactEmail, t.escalationEmail]),
    ...ON_CALL.flatMap((s) => [s.personEmail, s.escalationTo]),
    ...INCIDENTS.map((i) => i.assigneeEmail),
    ...ORG_SETTINGS.map((s) => (s.value.includes("@") ? s.value : null)),
  ].filter((a): a is string => Boolean(a));
  for (const a of addresses) {
    check(a.endsWith(".example"), `address ${a} is not on an RFC 2606 reserved domain`);
  }
  for (const h of ASSETS.map((a) => a.hostname)) {
    check(h.endsWith(".example"), `hostname ${h} is not on an RFC 2606 reserved domain`);
  }
  for (const v of VULNERABILITIES) {
    check(/^CVE-2026-9\d{4}$/.test(v.cve), `${v.cve} is outside the invented identifier block`);
  }

  const o = itopsOracle();
  console.log(
    `  ${c.dim("@" + o.asOf)} ${o.open.length} open · ${o.bandCounts.breached} breached · ` +
      `${o.bandCounts.at_risk} at risk · ${o.bandCounts.healthy} healthy · ` +
      `${o.actionableVulns.length} actionable vuln(s)`,
  );
  console.log(
    `  ${c.dim("traps")} ${o.disagreements.length} clock disagreement(s) · ` +
      `${o.tierSensitive.length} tier-sensitive · ${o.orgFallbackEscalations.length} org-fallback ` +
      `escalation(s) · ${o.nonprodCriticals.length} nonprod critical(s) held back · ` +
      `${o.noFixAvailable.length} with no fix`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HALF B — the named queries, as itops_ro, against the oracle.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable @typescript-eslint/no-explicit-any */
async function halfB() {
  rule();
  console.log(`named queries vs the oracle ${c.dim(`(as ${ITOPS_RO_ROLE})`)}`);

  const client = new Client({ connectionString: itopsRoDbUrl() });
  // ⚠ No try/catch that degrades to a skip. An unreachable database means the
  // half that actually proves something did not run, and a verifier that reports
  // green on that is the false green this repo keeps finding.
  await client.connect();

  try {
    const role = await verifyItopsReadOnlyRole(client);
    for (const p of role.problems) problems.push(`read-only role: ${p}`);
    console.log(
      `  ${role.problems.length ? c.bad("✗") : c.ok("✓")} ${ITOPS_RO_ROLE}: SELECT on ` +
        `${role.selectableTables.length} table(s), no write privileges, ` +
        `no CONNECT to [${role.isolatedFrom.join(", ") || "nothing else present"}]`,
    );

    for (const asOf of ITOPS_AS_OF) {
      const o = itopsOracle(asOf);
      const before = problems.length;

      const run = async (name: string) => (await client.query(query(name).sqlText, [asOf])).rows;
      const breached = await run("incidents_sla_breached");
      const atRisk = await run("incidents_sla_at_risk");
      const unack = await run("incidents_unacknowledged");
      const vulns = await run("vulns_actionable_prod");
      const blocked = await run("changes_blocked_by_freeze");
      const stale = await run("assets_stale");
      const oncall = await run("oncall_now");

      /**
       * ⚠ COMPARES THE MINUTES, NOT ONLY THE MEMBERSHIP. Two independent
       * implementations of the SLA clock agreeing on which incidents are in a
       * band is weak evidence; agreeing on `consumed_mins` to the minute, for
       * every incident, is the claim worth making.
       */
      const compareSla = (label: string, rows: any[], want: typeof o.breached) => {
        check(
          rows.length === want.length,
          `@${asOf} ${label}: query returned ${rows.length} row(s), oracle expects ` +
            `${want.length} — query [${rows.map((r) => r.incident_code).join(", ")}] vs oracle ` +
            `[${want.map((w) => w.incidentCode).join(", ")}]`,
        );
        for (const w of want) {
          const got = rows.find((r) => r.incident_code === w.incidentCode);
          if (!got) {
            problems.push(`@${asOf} ${label}: oracle expects ${w.incidentCode} and the query omits it`);
            continue;
          }
          check(
            Number(got.consumed_mins) === w.consumedMins,
            `@${asOf} ${label} ${w.incidentCode}: SQL says ${got.consumed_mins} consumed minute(s), ` +
              `the oracle says ${w.consumedMins}. The two clocks disagree — read ` +
              "BUSINESS_MINUTES in itops-queries.ts and businessMinutes() in itops-dataset.ts",
          );
          check(
            Number(got.paused_mins) === w.pausedMins,
            `@${asOf} ${label} ${w.incidentCode}: SQL says ${got.paused_mins} paused minute(s), ` +
              `the oracle says ${w.pausedMins}`,
          );
          check(
            Number(got.naive_elapsed_mins) === w.naiveElapsedMins,
            `@${asOf} ${label} ${w.incidentCode}: naive elapsed ${got.naive_elapsed_mins} vs ` +
              `oracle ${w.naiveElapsedMins}`,
          );
          check(
            Number(got.resolve_mins) === w.resolveMins,
            `@${asOf} ${label} ${w.incidentCode}: budget ${got.resolve_mins} vs oracle ` +
              `${w.resolveMins} — the two-column policy lookup disagrees`,
          );
          check(
            got.notify_email === w.recipientEmail,
            `@${asOf} ${label} ${w.incidentCode}: notify ${got.notify_email} vs oracle ` +
              `${w.recipientEmail}`,
          );
        }
      };

      compareSla("breached", breached, o.breached);
      compareSla("at_risk", atRisk, o.atRisk);

      // ⚠ THE GUARD ON THE DELIBERATE DUPLICATION. Two queries, one arithmetic
      // written twice; without this they drift and each stays internally
      // consistent while an incident falls between them or appears in both.
      const both = breached.filter((b) => atRisk.some((a) => a.incident_code === b.incident_code));
      check(
        both.length === 0,
        `@${asOf}: ${both.map((b) => b.incident_code).join(", ")} appear in BOTH SLA queries`,
      );
      const union = [...breached, ...atRisk].map((r) => r.incident_code).sort();
      const wantUnion = [...o.breached, ...o.atRisk].map((r) => r.incidentCode).sort();
      check(
        union.join(",") === wantUnion.join(","),
        `@${asOf}: the two SLA queries together return [${union.join(", ")}], the oracle's ` +
          `actionable set is [${wantUnion.join(", ")}] — an incident has fallen between them`,
      );

      // ⚠ The org fallback must be VISIBLE in the query's own output, not only
      // in the oracle. A breach routed to the right address by an expression the
      // flow cannot see is a trap that passes and teaches nothing.
      const fallbackRows = breached.filter((r) => r.escalated_via_org_fallback);
      check(
        fallbackRows.map((r) => r.incident_code).sort().join(",") ===
          [...o.orgFallbackEscalations].sort().join(","),
        `@${asOf}: org-fallback escalations differ — query ` +
          `[${fallbackRows.map((r) => r.incident_code).join(", ")}] vs oracle ` +
          `[${o.orgFallbackEscalations.join(", ")}]`,
      );

      const gotUnack = unack.map((r) => r.incident_code).sort();
      const wantUnack = o.unacknowledged.map((r) => r.incidentCode).sort();
      check(
        gotUnack.join(",") === wantUnack.join(","),
        `@${asOf} unacknowledged: query [${gotUnack.join(", ")}] vs oracle [${wantUnack.join(", ")}]`,
      );

      const gotVulns = vulns.map((r) => `${r.cve}@${r.hostname}`);
      const wantVulns = o.actionableVulns.map((v) => `${v.cve}@${v.hostname}`);
      check(
        gotVulns.join(",") === wantVulns.join(","),
        `@${asOf} vulns_actionable_prod: ORDER OR MEMBERSHIP differs.\n      query  ` +
          `${gotVulns.join(", ")}\n      oracle ${wantVulns.join(", ")}`,
      );
      for (const v of o.actionableVulns) {
        const got = vulns.find((r) => r.cve === v.cve && r.hostname === v.hostname);
        if (!got) continue;
        // ⚠ COMPARE THE INSTANT, NEVER THE STRING. `2026-07-01T06:00:00.000Z`
        // and `2026-07-01T06:00:00Z` are the same moment and different text, and
        // the first version of this check reported all fifteen deferrals as
        // failures over the milliseconds. A string comparison here would either
        // fail forever or, once "fixed" by slicing characters off, stop noticing
        // a genuine hour's difference.
        const gotDefer = got.deferred_until ? Date.parse(String(got.deferred_until)) : null;
        const wantDefer = v.deferredUntil ? Date.parse(v.deferredUntil) : null;
        check(
          gotDefer === wantDefer,
          `@${asOf} ${v.cve}@${v.hostname}: deferred_until ` +
            `${got.deferred_until ?? "null"} vs oracle ${v.deferredUntil ?? "null"}`,
        );
        check(
          got.asset_stale === v.assetStale,
          `@${asOf} ${v.cve}@${v.hostname}: asset_stale ${got.asset_stale} vs oracle ${v.assetStale}`,
        );
      }

      const gotBlocked = blocked.map((r) => `${r.cve}@${r.hostname}`).sort();
      const wantBlocked = o.deferredVulns.map((v) => `${v.cve}@${v.hostname}`).sort();
      check(
        gotBlocked.join(",") === wantBlocked.join(","),
        `@${asOf} changes_blocked_by_freeze: query [${gotBlocked.join(", ")}] vs oracle ` +
          `[${wantBlocked.join(", ")}]`,
      );

      // ⚠ EVERY team must appear, covered or not. The inner-join version of this
      // query is shorter and silently drops a team with no rota — and the
      // oracle's `teamsWithNoOnCall` is the only thing that would have noticed.
      check(
        oncall.length === TEAMS.length,
        `@${asOf} oncall_now: ${oncall.length} row(s) for ${TEAMS.length} team(s) — a team with ` +
          "nobody on call must appear with a null person, not be missing",
      );
      const gotCovered = oncall.filter((r) => !r.nobody_on_call).map((r) => r.team_code).sort();
      const wantCovered = o.onCall.map((c) => c.teamCode).sort();
      check(
        gotCovered.join(",") === wantCovered.join(","),
        `@${asOf} oncall_now covered: query [${gotCovered.join(", ")}] vs oracle ` +
          `[${wantCovered.join(", ")}]`,
      );
      const gotUncovered = oncall.filter((r) => r.nobody_on_call).map((r) => r.team_code).sort();
      check(
        gotUncovered.join(",") === o.teamsWithNoOnCall.join(","),
        `@${asOf} oncall_now uncovered: query [${gotUncovered.join(", ")}] vs oracle ` +
          `[${o.teamsWithNoOnCall.join(", ")}]`,
      );
      // ⚠ And a team with nobody on call must still have somewhere for its
      // incidents to go, or the LEFT JOIN has only made the gap visible without
      // making it actionable.
      for (const r of oncall) {
        check(
          Boolean(r.escalation_email),
          `@${asOf} oncall_now ${r.team_code}: no escalation address at all`,
        );
      }

      const gotStale = stale.map((r) => r.hostname).sort();
      check(
        gotStale.join(",") === o.staleAssets.join(","),
        `@${asOf} assets_stale: query [${gotStale.join(", ")}] vs oracle [${o.staleAssets.join(", ")}]`,
      );

      const bad = problems.length - before;
      console.log(
        `  ${bad ? c.bad("✗") : c.ok("✓")} ${c.dim(asOf)} ` +
          `${breached.length} breached · ${atRisk.length} at risk · ${unack.length} unack · ` +
          `${vulns.length} vuln(s) (${blocked.length} deferred) · ${stale.length} stale · ` +
          `${oncall.filter((r) => !r.nobody_on_call).length}/${oncall.length} teams covered` +
          (bad ? c.bad(` — ${bad} problem(s)`) : ""),
      );
    }
  } finally {
    await client.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  halfA();
  await halfB();

  rule();
  if (problems.length > 0) {
    console.log(c.bad(`✗ ${problems.length} problem(s):`));
    for (const p of problems) console.log(`  ${c.bad("·")} ${p}`);
    process.exit(1);
  }
  console.log(
    c.ok(
      "✓ itops dataset OK — every trap present, and the SQL clock agrees with the oracle's " +
        `clock to the minute at all ${ITOPS_AS_OF.length} as-of instants`,
    ),
  );
}

main().catch((e) => {
  // ⚠ Non-zero, and NOT a skip. If the database is unreachable, half B did not
  // run, and that is the half that proves the SQL and the oracle agree.
  console.error(
    c.bad("✗ itops:verify could not complete — run `pnpm --filter @foundry/server itops:seed` first"),
  );
  console.error(e);
  process.exit(1);
});
