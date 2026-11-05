/**
 * What this file protects is not "the numbers are these numbers" — it is that
 * EVERY TRAP STILL BITES.
 *
 * `itops-dataset.ts` places several instants to the minute so that a specific
 * arithmetic mistake produces a specific wrong ANSWER. Those placements are
 * fragile by design and easy to disturb by accident: move INC-1020 nine minutes
 * and it stops sitting on the 0.80 boundary; give SVC-RPT a 24x7 clock and
 * INC-1007 stops inverting. Neither change breaks anything that would fail on
 * its own.
 *
 * So the assertions below are on CONSEQUENCES — "the naive arithmetic and the
 * correct one disagree about this incident", "this one is exactly on the
 * boundary", "no single correction rescues INC-1012" — rather than on the
 * literals. If you do move a row, this file tells you what you took away.
 *
 * ⚠ The last two tests are the structural ones and they are the reason this file
 * is worth more than the sum of the rest: the dataset imports NOTHING, and it
 * reads no clock. Both are absences, and an absence is not observable at
 * runtime — so both are checked by reading the source off disk, each with a
 * control proving the read found something.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ASSETS,
  AT_RISK_FRACTION,
  CHANGE_FREEZES,
  INCIDENTS,
  INCIDENT_PAUSES,
  ITOPS_AS_OF,
  ITOPS_QUIET_AS_OF,
  ITOPS_SCOPED_FREEZE_AS_OF,
  ITOPS_DEFAULT_AS_OF,
  ON_CALL,
  SLA_POLICIES,
  TEAMS,
  bandFor,
  businessMinutes,
  elapsedMinutes,
  incidentSla,
  itopsOracle,
  orgSetting,
  slaPolicy,
} from "./itops-dataset.js";

const SRC = readFileSync(fileURLToPath(new URL("./itops-dataset.ts", import.meta.url)), "utf8");
const at = (code: string, asOf: string = ITOPS_DEFAULT_AS_OF) =>
  incidentSla(INCIDENTS.find((i) => i.code === code)!, asOf);

describe("business-hours arithmetic", () => {
  it("counts only 09:00-17:00 Mon-Fri", () => {
    // A whole ordinary Tuesday.
    expect(businessMinutes("2026-06-02T00:00:00Z", "2026-06-03T00:00:00Z")).toBe(480);
    // A whole Saturday, and a whole Sunday.
    expect(businessMinutes("2026-06-06T00:00:00Z", "2026-06-08T00:00:00Z")).toBe(0);
    // Friday 16:40 to Monday 09:20 — twenty minutes at each end.
    expect(businessMinutes("2026-06-05T16:40:00Z", "2026-06-08T09:20:00Z")).toBe(40);
    // Before the day opens and after it closes both clamp.
    expect(businessMinutes("2026-06-02T03:00:00Z", "2026-06-02T09:30:00Z")).toBe(30);
    expect(businessMinutes("2026-06-02T16:30:00Z", "2026-06-02T23:00:00Z")).toBe(30);
    // Backwards and zero-length spans are zero, not negative.
    expect(businessMinutes("2026-06-03T00:00:00Z", "2026-06-02T00:00:00Z")).toBe(0);
  });

  /** The control: without it, a `businessMinutes` that returned 0 for everything would pass above. */
  it("is not the same function as the naive subtraction", () => {
    const from = "2026-06-05T16:40:00Z";
    const to = "2026-06-08T09:20:00Z";
    expect(elapsedMinutes(from, to)).toBe(3880);
    expect(businessMinutes(from, to)).toBe(40);
  });
});

describe("T1 — the business-hours clock inverts answers", () => {
  it("INC-1007 is breached naively and healthy correctly", () => {
    const r = at("INC-1007");
    expect(r.businessHoursOnly).toBe(true);
    expect(r.consumedMins).toBe(40);
    expect(r.naiveElapsedMins).toBe(3880);
    expect(r.band).toBe("healthy");
    expect(r.naiveBand).toBe("breached");
  });

  it("bites at the earliest instant too, so the quiet case is not an easy case", () => {
    const r = at("INC-1005", ITOPS_QUIET_AS_OF);
    expect(r.disagrees).toBe(true);
    expect(itopsOracle(ITOPS_QUIET_AS_OF).disagreements).toContain("INC-1005");
  });

  it("bites WITHOUT a weekend — overnight alone is enough (INC-1018)", () => {
    const r = at("INC-1018");
    expect(r.disagrees).toBe(true);
    // Tuesday into Wednesday. If this ever spans a weekend the row has moved and
    // the "it is really just the weekend trap" reading becomes true.
    expect(r.openedAt.slice(0, 10)).toBe("2026-06-23");
    expect(r.resolvedAt!.slice(0, 10)).toBe("2026-06-24");
  });

  it("bites on an OPEN incident, not only a resolved one (INC-1028)", () => {
    const r = at("INC-1028");
    expect(r.resolvedByAsOf).toBe(false);
    expect(r.band).toBe("healthy");
    expect(r.naiveBand).toBe("breached");
  });

  /**
   * ⚠ THE NEGATIVE CONTROL, and it is the most important test in this block.
   * Without a business-hours service that genuinely IS breached, "apply the
   * business-hours clock and everything comes out healthy" scores full marks.
   */
  it("does NOT mean a business-hours service can never breach (INC-1015)", () => {
    const r = at("INC-1015");
    expect(r.businessHoursOnly).toBe(true);
    expect(r.consumedMins).toBeGreaterThan(r.resolveMins);
    expect(r.band).toBe("breached");
  });
});

describe("T2 — paused time comes off the clock", () => {
  it("INC-1009 inverts on the pause alone, on a 24x7 service", () => {
    const r = at("INC-1009");
    expect(r.businessHoursOnly).toBe(false);
    expect(r.pausedMins).toBe(1200);
    expect(r.consumedMins).toBe(120);
    expect(r.band).toBe("healthy");
    expect(r.naiveBand).toBe("breached");
  });

  it("honours a pause that has NOT ended (INC-1025)", () => {
    const open = INCIDENT_PAUSES.find((p) => p.incidentId === 25)!;
    expect(open.endedAt).toBeNull();
    const r = at("INC-1025");
    expect(r.pausedMins).toBeGreaterThan(0);
    expect(r.band).toBe("healthy");
    expect(r.naiveBand).toBe("breached");
  });

  it("has no overlapping pauses on one incident, so span-merging is not entangled with T2", () => {
    const byIncident = new Map<number, typeof INCIDENT_PAUSES>();
    for (const p of INCIDENT_PAUSES) {
      byIncident.set(p.incidentId, [...(byIncident.get(p.incidentId) ?? []), p]);
    }
    for (const [id, list] of byIncident) {
      const sorted = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      for (let i = 1; i < sorted.length; i++) {
        const prevEnd = sorted[i - 1].endedAt;
        expect(prevEnd, `incident ${id} has an open pause followed by another`).not.toBeNull();
        expect(sorted[i].startedAt >= prevEnd!, `pauses overlap on incident ${id}`).toBe(true);
      }
    }
  });
});

describe("T1 + T2 — INC-1012 needs both, and each correction alone still fails", () => {
  it("is wrong under every partial fix and right under the whole one", () => {
    const i = INCIDENTS.find((x) => x.code === "INC-1012")!;
    const r = at("INC-1012");
    const pause = INCIDENT_PAUSES.find((p) => p.incidentId === i.id)!;

    // 1. Subtract the timestamps: breached.
    expect(bandFor(r.naiveElapsedMins, r.resolveMins)).toBe("breached");
    // 2. Business hours, pause ignored: STILL breached.
    const businessOnly = businessMinutes(i.openedAt, i.resolvedAt!);
    expect(bandFor(businessOnly, r.resolveMins)).toBe("breached");
    // 3. Raw elapsed minus raw pause: STILL breached.
    const rawMinusRaw =
      elapsedMinutes(i.openedAt, i.resolvedAt!) - elapsedMinutes(pause.startedAt, pause.endedAt!);
    expect(bandFor(rawMinusRaw, r.resolveMins)).toBe("breached");
    // 4. Both, on the service's own clock: healthy.
    expect(r.band).toBe("healthy");
  });
});

describe("T3 — the SLA policy key is two columns", () => {
  it("INC-1006 turns on the tier ALONE, with no clock or pause involvement", () => {
    const r = at("INC-1006");
    expect(r.businessHoursOnly).toBe(false);
    expect(r.pausedMins).toBe(0);
    // The clock arithmetics agree; only the policy lookup differs.
    expect(r.disagrees).toBe(false);
    expect(r.tierSensitive).toBe(true);
    expect(r.band).toBe("healthy");
    expect(bandFor(r.consumedMins, slaPolicy("platinum", "P1").resolveMins)).toBe("breached");
  });

  it("keeps four rows sharing resolveMins 480, so a wrong lookup often looks right", () => {
    const shared = SLA_POLICIES.filter((p) => p.resolveMins === 480).map((p) => `${p.tier}/${p.priority}`);
    expect(shared.sort()).toEqual(["bronze/P1", "gold/P2", "platinum/P3", "silver/P2"]);
  });

  /**
   * ⚠ MATCHES A DECLARATION, NOT THE NAME. The first version grepped for the
   * bare identifier and went red against the dataset's OWN comment saying the
   * convenience is deliberately absent — I-62's shape: a guard that flags the
   * sentence forbidding a thing rather than the thing. A guard that cries wolf
   * gets widened, and the widening people reach for permits the defect.
   */
  it("declares no single-column lookup for anyone to reach for", () => {
    expect(SRC).not.toMatch(/(?:function|const)\s+policy(?:For|By)Priority/);
    // The control: the same pattern DOES find the two-column one.
    expect(SRC).toMatch(/function\s+slaPolicy/);
  });
});

describe("the band rule — a fraction, and inclusive at both bounds", () => {
  it("INC-1020 sits EXACTLY on the at-risk boundary", () => {
    const r = at("INC-1020");
    expect(r.fraction).toBe(AT_RISK_FRACTION);
    expect(r.band).toBe("at_risk");
    // The perturbation this pins: an exclusive bound leaves it unwarned.
    const exclusive = r.fraction > AT_RISK_FRACTION ? "at_risk" : "healthy";
    expect(exclusive).toBe("healthy");
  });

  it("is a fraction of each policy's own budget, never a fixed number of minutes", () => {
    // 200 minutes is at risk on a platinum P1 (60) and healthy on a bronze P4 (7200).
    expect(bandFor(200, slaPolicy("platinum", "P1").resolveMins)).toBe("breached");
    expect(bandFor(200, slaPolicy("bronze", "P4").resolveMins)).toBe("healthy");
    // And the threshold is read back, never written twice.
    expect(Number(orgSetting("at_risk_fraction"))).toBe(AT_RISK_FRACTION);
  });

  it("puts every open incident in exactly one band", () => {
    for (const asOf of ITOPS_AS_OF) {
      const o = itopsOracle(asOf);
      const total = o.bandCounts.breached + o.bandCounts.at_risk + o.bandCounts.healthy;
      expect(total, asOf).toBe(o.open.length);
      const codes = [...o.breached, ...o.atRisk, ...o.healthy].map((i) => i.incidentCode);
      expect(new Set(codes).size, `bands overlap at ${asOf}`).toBe(codes.length);
    }
  });
});

describe("T8 — the escalation address is a two-level fallback", () => {
  it("has exactly one team with no escalation address of its own", () => {
    expect(TEAMS.filter((t) => t.escalationEmail === null).map((t) => t.code)).toEqual(["DATA"]);
  });

  it("keeps the org default UNEQUAL to every team's own, so the hop cannot be skipped by luck", () => {
    const org = orgSetting("escalation_fallback_email");
    for (const t of TEAMS) expect(t.escalationEmail, t.code).not.toBe(org);
  });

  /** ⚠ The trap was DEAD when first written — no DATA incident was ever breached,
   *  so the second hop was never taken and the oracle reported an empty list at
   *  every instant. A trap nothing reaches reads exactly like one that passed. */
  it("actually FIRES wherever there is an open breach", () => {
    const withBreaches = ITOPS_AS_OF.filter((a) => itopsOracle(a).breached.length > 0);
    expect(withBreaches.length).toBeGreaterThan(1);
    for (const asOf of withBreaches) {
      expect(itopsOracle(asOf).orgFallbackEscalations.length, asOf).toBeGreaterThan(0);
    }
  });

  it("gives the three bands three different recipients", () => {
    const o = itopsOracle();
    expect(o.breached.every((i) => i.recipientEmail !== null)).toBe(true);
    expect(o.atRisk.every((i) => i.recipientEmail !== null)).toBe(true);
    // The digest arm has no per-incident recipient at all.
    expect(o.healthy.every((i) => i.recipientEmail === null)).toBe(true);
    const breachedTo = new Set(o.breached.map((i) => i.recipientEmail));
    const atRiskTo = new Set(o.atRisk.map((i) => i.recipientEmail));
    for (const e of atRiskTo) expect(breachedTo.has(e), `${e} is both arms`).toBe(false);
  });
});

describe("T4/T5/T7 — the vulnerability half", () => {
  it("keeps criticals OUT of the actionable set when they are not production", () => {
    const o = itopsOracle();
    expect(o.nonprodCriticals.length).toBeGreaterThanOrEqual(2);
    const actionable = new Set(o.actionableVulns.map((v) => `${v.cve}@${v.hostname}`));
    for (const c of o.nonprodCriticals) expect(actionable.has(c), c).toBe(false);
    expect(o.actionableVulns.every((v) => v.environment === "prod")).toBe(true);
  });

  it("orders a KEV above every non-KEV, including two criticals", () => {
    const ordered = itopsOracle().actionableVulns;
    const lastKev = ordered.map((v) => v.kev).lastIndexOf(true);
    const firstNonKev = ordered.findIndex((v) => !v.kev);
    expect(lastKev).toBeGreaterThan(-1);
    expect(firstNonKev).toBeGreaterThan(lastKev);
    // The surprising half: a `low` outranks a 9.8 critical.
    const low = ordered[lastKev];
    expect(low.severity).toBe("low");
    expect(low.kev).toBe(true);
    expect(ordered[firstNonKev].severity).toBe("critical");
    expect(ordered[firstNonKev].cvss).toBeGreaterThan(low.cvss);
  });

  it("excludes a finding with no fix rather than reporting unclosable work", () => {
    const o = itopsOracle();
    expect(o.noFixAvailable.length).toBeGreaterThan(0);
    const actionable = new Set(o.actionableVulns.map((v) => `${v.cve}@${v.hostname}`));
    for (const c of o.noFixAvailable) expect(actionable.has(c), c).toBe(false);
  });
});

describe("T6 — a freeze defers, and the date bound is the trap", () => {
  it("keeps a freeze that has ENDED, so an unbounded EXISTS is wrong", () => {
    const past = CHANGE_FREEZES.filter((f) => f.endsAt < ITOPS_QUIET_AS_OF);
    expect(past.length).toBeGreaterThan(0);
    // ...and it is inactive at every instant this dataset is tuned for.
    for (const asOf of ITOPS_AS_OF) {
      for (const f of past) expect(itopsOracle(asOf).activeFreezes, asOf).not.toContain(f.code);
    }
  });

  it("defers rather than dropping: nothing leaves the actionable set", () => {
    for (const asOf of ITOPS_AS_OF) {
      const o = itopsOracle(asOf);
      expect(o.deferredVulns.length + o.proceedingVulns.length, asOf).toBe(o.actionableVulns.length);
      for (const v of o.deferredVulns) {
        expect(v.deferredUntil, `${v.cve}@${v.hostname}`).not.toBeNull();
        expect(v.deferredUntil! > asOf).toBe(true);
      }
    }
  });

  it("scopes a per-service freeze to that service alone", () => {
    const o = itopsOracle(ITOPS_SCOPED_FREEZE_AS_OF);
    expect(o.activeFreezes).toEqual(["FRZ-2"]);
    expect(o.deferredVulns.length).toBeGreaterThan(0);
    expect(o.proceedingVulns.length).toBeGreaterThan(0);
    const scoped = CHANGE_FREEZES.find((f) => f.code === "FRZ-2")!;
    expect(scoped.serviceId).not.toBeNull();
    for (const v of o.deferredVulns) expect(v.serviceCode).toBe("SVC-PAY");
  });

  it("applies an org-wide freeze to everything, including an asset with no service", () => {
    const o = itopsOracle(ITOPS_DEFAULT_AS_OF);
    expect(o.activeFreezes).toEqual(["FRZ-1"]);
    expect(o.proceedingVulns).toHaveLength(0);
    expect(o.deferredVulns.some((v) => v.serviceCode === null)).toBe(true);
  });
});

describe("the invariants that hold at EVERY as-of instant", () => {
  it("always has at least one genuine breach, so 'nothing to report' is never right", () => {
    for (const asOf of ITOPS_AS_OF) {
      const o = itopsOracle(asOf);
      expect(o.breached.length + o.resolvedBreaches.length, asOf).toBeGreaterThan(0);
    }
  });

  it("always has the two arithmetics disagreeing about something", () => {
    for (const asOf of ITOPS_AS_OF) {
      expect(itopsOracle(asOf).disagreements.length, asOf).toBeGreaterThan(0);
    }
  });

  it("has exactly one instant with an EMPTY actionable incident set", () => {
    const empty = ITOPS_AS_OF.filter((a) => {
      const o = itopsOracle(a);
      return o.breached.length === 0 && o.atRisk.length === 0;
    });
    expect(empty).toEqual([ITOPS_QUIET_AS_OF]);
    // ...and it is not an empty dataset. Something is still wrong there.
    expect(itopsOracle(ITOPS_QUIET_AS_OF).resolvedBreaches.length).toBeGreaterThan(0);
  });

  it("puts at most one person on call per team (the half-open window)", () => {
    for (const asOf of ITOPS_AS_OF) {
      const codes = itopsOracle(asOf).onCall.map((o) => o.teamCode);
      expect(new Set(codes).size, asOf).toBe(codes.length);
    }
    // The handover instant itself, which a BETWEEN would double-cover.
    const handover = ON_CALL.find((s) => s.teamId === 1 && s.startsAt === "2026-06-29T08:00:00Z")!;
    const overlapping = ON_CALL.filter(
      (s) => s.teamId === 1 && s.startsAt <= handover.startsAt && handover.startsAt < s.endsAt,
    );
    expect(overlapping).toHaveLength(1);
  });

  it("leaves exactly one team with nobody on call, and it is the deliberate one", () => {
    for (const asOf of ITOPS_AS_OF) {
      expect(itopsOracle(asOf).teamsWithNoOnCall, asOf).toEqual(["WORKPLACE"]);
    }
  });

  it("computes staleness against the instant rather than naming hosts", () => {
    const counts = ITOPS_AS_OF.map((a) => itopsOracle(a).staleAssets.length);
    // It must VARY, or a hardcoded list of hostnames would pass every check.
    expect(new Set(counts).size).toBeGreaterThan(1);
    expect(ASSETS.some((a) => a.lastSeenAt === null || a.lastSeenAt < "2026-05-01")).toBe(true);
  });
});

/**
 * ⚠ WRITTEN BECAUSE THIS BUG HAPPENED, and it was caught by reading rather than
 * by anything failing.
 *
 * `change_freezes` carried a `code` in the dataset and had no column for it in
 * the DDL. Nothing typechecked its way to the problem: the seeder's column list
 * is an array of strings and the schema is a `.sql` file, so the two can
 * disagree indefinitely. The failure would have arrived at `itops:seed` time as
 * a Postgres error naming one column — recoverable, but only for whoever runs
 * the seeder, and this repo's harnesses are exactly the things people do not run
 * before committing.
 *
 * So the check is mechanical and needs no database: every column the seeder
 * INSERTs must exist in the DDL for that table.
 */
describe("the seeder and the schema agree about every column", () => {
  const SCHEMA = readFileSync(fileURLToPath(new URL("./itops-schema.sql", import.meta.url)), "utf8");
  const SEED = readFileSync(fileURLToPath(new URL("./seed-itops-db.ts", import.meta.url)), "utf8");

  /** Column names declared for one `CREATE TABLE`, read out of the DDL. */
  function columnsOf(table: string): string[] {
    const m = SCHEMA.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (!m) throw new Error(`no CREATE TABLE ${table} in itops-schema.sql`);
    return m[1]
      .split("\n")
      .map((l) => l.replace(/--.*$/, "").trim())
      .filter((l) => l && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/.test(l))
      .map((l) => l.split(/\s+/)[0])
      .filter(Boolean);
  }

  it("inserts only columns the DDL declares", () => {
    const calls = [...SEED.matchAll(/"(\w+)",\n\s*\[([^\]]*)\],/g)];
    // The control: the scan found the seeder's INSERT column lists at all. A
    // regex that matched nothing would pass the loop below for ever.
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const [, table, list] of calls) {
      const declared = new Set(columnsOf(table));
      for (const col of [...list.matchAll(/"(\w+)"/g)].map((m) => m[1])) {
        expect(declared.has(col), `${table}.${col} is inserted but not declared`).toBe(true);
      }
    }
  });

  it("covers every table the schema creates", () => {
    const created = [...SCHEMA.matchAll(/CREATE TABLE (\w+) \(/g)].map((m) => m[1]).sort();
    const inserted = [...SEED.matchAll(/"(\w+)",\n\s*\[[^\]]*\],/g)].map((m) => m[1]).sort();
    expect(inserted).toEqual(created);
  });
});

describe("the structural rules", () => {
  /**
   * ⚠ You cannot call what you have not imported. Four domains with four
   * independently written oracles is the only arrangement in which "the flow
   * agreed with the oracle" is evidence — a shared oracle lets a shared bug
   * produce a wrong answer that agrees with itself.
   */
  it("imports NOTHING, so it cannot share another domain's mistake", () => {
    // The control: the read found a real file with real content.
    expect(SRC.length).toBeGreaterThan(5000);
    expect(SRC).toContain("export function itopsOracle");
    expect(SRC).not.toMatch(/^import /m);
    expect(SRC).not.toMatch(/from ["']/m);
  });

  /**
   * ⚠ A dataset whose traps move with the wall clock cannot have an oracle, and
   * the failure is invisible until the day a boundary row stops sitting on the
   * boundary. The absence of a call is not observable at runtime, so it is read
   * off disk — with the control above proving the read found something.
   */
  it("reads no clock", () => {
    expect(SRC).not.toMatch(/Date\.now|new Date\(\)|Date\.UTC\(\)/);
    // `new Date(x)` for parsing is fine; `new Date()` for the present is not.
    expect(SRC).not.toMatch(/new Date\(\s*\)/);
  });

  it("keeps every address on an RFC 2606 reserved domain", () => {
    for (const m of SRC.matchAll(/[\w.-]+@([\w.-]+)/g)) {
      expect(m[1], m[0]).toMatch(/\.example$/);
    }
  });

  it("names no real CVE range", () => {
    // Invented block, stated as such in the file and pinned here.
    const ids = [...SRC.matchAll(/CVE-\d{4}-\d{4,}/g)].map((m) => m[0]);
    // The control: there are real identifiers here to check.
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(id).toMatch(/^CVE-2026-9\d{4}$/);
  });
});
