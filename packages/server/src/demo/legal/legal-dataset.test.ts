/**
 * Invariants of the Legal dataset DEFINITIONS. No database.
 *
 * ── WHY THIS FILE EXISTS AND WHY IT WAS WRITTEN FIRST ────────────────────────
 *
 * Every trap in `legal-dataset.ts` is a deliberate arrangement of a handful of
 * rows, and every one of them is one careless edit from evaporating. A dataset
 * that has quietly lost its traps still seeds, still introspects, still returns
 * rows, and still makes every flow built on it look correct — which is the exact
 * failure mode the oracle exists to catch, arriving one level down.
 *
 * So each `it()` below is named after the trap it protects, and asserts the
 * ABSOLUTE count the documentation claims rather than "at least one". "At least
 * one" passes after somebody adds a second duplicate, at which point the
 * dataset no longer means what `verify-legal.ts` says it means.
 *
 * ⚠ These counts are the DOCUMENTED INVARIANTS. If one fails, fix the DATA, not
 * the number here — and if the number genuinely has to change, change it in
 * spec.md, plan.md and `verify-legal.ts`'s half A in the same commit.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNCING_DOMAIN,
  CONTRACTS,
  CONTRACT_CLAUSES,
  CONTRACT_RELATIONSHIPS,
  CONTRACT_TYPES,
  COUNTERPARTIES,
  DEFAULT_LOOKAHEAD_DAYS,
  DEFAULT_NOTICE_PERIOD_DAYS,
  LEGAL_AS_OF_DATES,
  LEGAL_DEFAULT_AS_OF,
  LEGAL_ENTITIES,
  NOTICE_LOG,
  OBLIGATIONS,
  OBLIGATION_COMPLETIONS,
  ORG_SETTINGS,
  alreadyNoticed,
  effectiveNoticeDays,
  isCompleted,
  isDeadlineEligible,
  legalOracle,
  noticeDeadline,
  urgencyBucket,
} from "./legal-dataset.js";

const here = dirname(fileURLToPath(import.meta.url));
const contractById = new Map(CONTRACTS.map((c) => [c.id, c]));
const typeByCode = new Map(CONTRACT_TYPES.map((t) => [t.code, t]));

/** Contracts a deadline report can see at `asOf` — the shared eligibility rule. */
function reportable(asOf: string) {
  return CONTRACTS.filter((c) => isDeadlineEligible(c, asOf));
}

describe("the Legal dataset — reference data", () => {
  it("has the ten table populations the schema declares", () => {
    expect(ORG_SETTINGS.length).toBe(4);
    expect(LEGAL_ENTITIES.length).toBe(2);
    expect(COUNTERPARTIES.length).toBe(11);
    expect(CONTRACT_TYPES.length).toBe(6);
    expect(CONTRACTS.length).toBe(24);
    expect(CONTRACT_RELATIONSHIPS.length).toBe(5);
    expect(CONTRACT_CLAUSES.length).toBe(20);
    expect(OBLIGATIONS.length).toBe(22);
    expect(OBLIGATION_COMPLETIONS.length).toBe(7);
    expect(NOTICE_LOG.length).toBe(5);
  });

  it("declares the three as-of dates, with 2026-06-30 as the default", () => {
    expect(LEGAL_AS_OF_DATES).toEqual(["2026-04-30", "2026-05-31", "2026-06-30"]);
    expect(LEGAL_DEFAULT_AS_OF).toBe("2026-06-30");
    // ⚠ 45, not 60, and deliberately not equal to ANY contract_types default —
    // otherwise a query that skips the middle fallback hop resolves the right
    // number anyway and the two-level trap cannot be detected. The first version
    // of this dataset had both at 60; the middle-hop test below is what caught it.
    expect(DEFAULT_NOTICE_PERIOD_DAYS).toBe(45);
    expect(CONTRACT_TYPES.map((t) => t.defaultNoticePeriodDays)).not.toContain(
      DEFAULT_NOTICE_PERIOD_DAYS,
    );
    expect(DEFAULT_LOOKAHEAD_DAYS).toBe(90);
  });

  it("agrees with org_settings about the org-wide notice period and lookahead", () => {
    // Two sources for one number is how they drift. The seeder loads
    // ORG_SETTINGS into the database and the oracle reads the constant, so a
    // disagreement here means the SQL and the oracle would resolve different
    // fallbacks and nothing else would notice.
    const setting = (k: string) => ORG_SETTINGS.find((s) => s.key === k)?.value;
    expect(setting("default_notice_period_days")).toBe(String(DEFAULT_NOTICE_PERIOD_DAYS));
    expect(setting("renewal_lookahead_days")).toBe(String(DEFAULT_LOOKAHEAD_DAYS));
  });

  it("references only rows that exist — every foreign key resolves", () => {
    const cpIds = new Set(COUNTERPARTIES.map((c) => c.id));
    const entityIds = new Set(LEGAL_ENTITIES.map((e) => e.id));
    const typeCodes = new Set(CONTRACT_TYPES.map((t) => t.code));
    const obligationIds = new Set(OBLIGATIONS.map((o) => o.id));

    for (const c of CONTRACTS) {
      expect(cpIds.has(c.counterpartyId), `contract ${c.code} counterparty`).toBe(true);
      expect(entityIds.has(c.legalEntityId), `contract ${c.code} entity`).toBe(true);
      expect(typeCodes.has(c.typeCode), `contract ${c.code} type`).toBe(true);
      if (c.supersededById !== null) {
        expect(contractById.has(c.supersededById), `contract ${c.code} successor`).toBe(true);
      }
    }
    for (const r of CONTRACT_RELATIONSHIPS) {
      expect(contractById.has(r.parentContractId)).toBe(true);
      expect(contractById.has(r.childContractId)).toBe(true);
    }
    for (const cl of CONTRACT_CLAUSES) expect(contractById.has(cl.contractId)).toBe(true);
    for (const o of OBLIGATIONS) expect(contractById.has(o.contractId)).toBe(true);
    for (const oc of OBLIGATION_COMPLETIONS) expect(obligationIds.has(oc.obligationId)).toBe(true);
    for (const n of NOTICE_LOG) expect(contractById.has(n.contractId)).toBe(true);
  });

  it("uses unique codes throughout", () => {
    const codes = (xs: { code: string }[]) => new Set(xs.map((x) => x.code));
    expect(codes(CONTRACTS).size).toBe(CONTRACTS.length);
    expect(codes(COUNTERPARTIES).size).toBe(COUNTERPARTIES.length);
    expect(codes(CONTRACT_TYPES).size).toBe(CONTRACT_TYPES.length);
    expect(codes(LEGAL_ENTITIES).size).toBe(LEGAL_ENTITIES.length);
    expect(codes(OBLIGATIONS).size).toBe(OBLIGATIONS.length);
  });
});

describe("the Legal dataset — the nine traps", () => {
  // ── TRAP 1 ────────────────────────────────────────────────────────────────
  it("TRAP 1 (inclusive boundary): exactly one contract sits ON the notice deadline at EVERY as-of date", () => {
    for (const asOf of LEGAL_AS_OF_DATES) {
      const onBoundary = reportable(asOf).filter((c) => noticeDeadline(c) === asOf);
      expect(onBoundary.length, `contracts on the boundary at ${asOf}`).toBe(1);
    }
  });

  it("TRAP 1 (inclusive boundary): the boundary contract at the DEFAULT as-of date is auto-renewing", () => {
    // This is what puts the trap in `contracts_renewal_due` — the flagship query
    // — rather than only in the internal-facing lapse-risk one. See
    // session-notes.md "Surprises" #1: at the other two dates the boundary
    // contract MUST be non-auto-renewing or the empty April case is lost.
    const [onBoundary] = reportable(LEGAL_DEFAULT_AS_OF).filter(
      (c) => noticeDeadline(c) === LEGAL_DEFAULT_AS_OF,
    );
    expect(onBoundary).toBeDefined();
    expect(onBoundary.autoRenew).toBe(true);
    expect(urgencyBucket(0)).toBe("0-14");
  });

  // ── TRAP 2 ────────────────────────────────────────────────────────────────
  it("TRAP 2 (two-level fallback): exactly one contract needs BOTH hops, and it is the highest-value contract", () => {
    const twoHop = CONTRACTS.filter(
      (c) =>
        c.noticePeriodDays === null &&
        typeByCode.get(c.typeCode)!.defaultNoticePeriodDays === null,
    );
    expect(twoHop.length).toBe(1);

    // The expensive one on purpose: a single-level COALESCE loses precisely the
    // contract it costs most to lose.
    const maxValue = Math.max(...CONTRACTS.map((c) => c.valueCents));
    expect(twoHop[0].valueCents).toBe(maxValue);

    // And the fallback actually resolves to the org-wide default.
    expect(effectiveNoticeDays(twoHop[0])).toBe(DEFAULT_NOTICE_PERIOD_DAYS);
  });

  it("TRAP 2 (two-level fallback): the MIDDLE hop is exercised alone by at least one contract", () => {
    // A dataset where every NULL falls all the way through would let a
    // one-level COALESCE straight to org_settings score full marks.
    const middleHop = CONTRACTS.filter((c) => {
      const t = typeByCode.get(c.typeCode)!;
      return c.noticePeriodDays === null && t.defaultNoticePeriodDays !== null;
    });
    expect(middleHop.length).toBeGreaterThan(0);
    for (const c of middleHop) {
      expect(effectiveNoticeDays(c)).toBe(typeByCode.get(c.typeCode)!.defaultNoticePeriodDays);
      expect(effectiveNoticeDays(c)).not.toBe(DEFAULT_NOTICE_PERIOD_DAYS);
    }
    // Two of the six types carry a NULL default, which is what makes the second
    // hop reachable at all.
    expect(CONTRACT_TYPES.filter((t) => t.defaultNoticePeriodDays === null).length).toBe(2);
  });

  // ── TRAP 3 ────────────────────────────────────────────────────────────────
  it("TRAP 3 (evergreen): exactly one contract has no end date, and it has no notice deadline", () => {
    const evergreen = CONTRACTS.filter((c) => c.endDate === null);
    expect(evergreen.length).toBe(1);
    expect(noticeDeadline(evergreen[0])).toBeNull();
    // Excluded from every deadline report, at every as-of date, by an explicit
    // predicate — never by NULL arithmetic happening to compare false.
    for (const asOf of LEGAL_AS_OF_DATES) {
      expect(isDeadlineEligible(evergreen[0], asOf)).toBe(false);
    }
  });

  // ── TRAP 4 ────────────────────────────────────────────────────────────────
  it("TRAP 4 (supersession): exactly one chain, and the superseded row is never reportable", () => {
    const superseded = CONTRACTS.filter((c) => c.supersededById !== null);
    expect(superseded.length).toBe(1);
    expect(superseded[0].status).toBe("superseded");

    const successor = contractById.get(superseded[0].supersededById!)!;
    expect(successor.status).toBe("active");
    expect(successor.supersededById).toBeNull();
    // Same counterparty — a chain across counterparties would be a data error.
    expect(successor.counterpartyId).toBe(superseded[0].counterpartyId);

    for (const asOf of LEGAL_AS_OF_DATES) {
      expect(isDeadlineEligible(superseded[0], asOf)).toBe(false);
    }
  });

  it("TRAP 4 (supersession): the title-prefix NEGATIVE CONTROL is present and is not a chain", () => {
    // Two contracts sharing a title prefix with DIFFERENT counterparties. A rule
    // keyed on the title finds a supersession chain that does not exist; only
    // `superseded_by_id` establishes one.
    const byPrefix = new Map<string, typeof CONTRACTS>();
    for (const c of CONTRACTS) {
      const prefix = c.title.split(" — ")[0];
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), c]);
    }
    const decoys = [...byPrefix.values()].filter(
      (g) => g.length > 1 && new Set(g.map((c) => c.counterpartyId)).size === g.length,
    );
    expect(decoys.length).toBeGreaterThan(0);
    for (const group of decoys) {
      for (const c of group) {
        expect(c.supersededById, `${c.code} must not be in a chain`).toBeNull();
        expect(
          CONTRACTS.some((o) => o.supersededById === c.id),
          `nothing may supersede ${c.code}`,
        ).toBe(false);
      }
    }
  });

  // ── TRAP 5 ────────────────────────────────────────────────────────────────
  it("TRAP 5 (auto-renew inversion): both populations are non-empty and DISJOINT at the default as-of date", () => {
    const inWindow = reportable(LEGAL_DEFAULT_AS_OF).filter((c) => {
      const d = noticeDeadline(c)!;
      return d <= addDays(LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS);
    });
    const renew = inWindow.filter((c) => c.autoRenew);
    const lapse = inWindow.filter((c) => !c.autoRenew);
    expect(renew.length).toBeGreaterThan(0);
    expect(lapse.length).toBeGreaterThan(0);
    // The whole point of splitting the catalogue in two: no contract can be in
    // both, so no flow can send both notices to one counterparty.
    expect(renew.filter((c) => lapse.includes(c))).toEqual([]);
    expect(renew.length + lapse.length).toBe(inWindow.length);
  });

  it("TRAP 5 (auto-renew inversion): a non-auto-renewing contract never carries a renewal term", () => {
    for (const c of CONTRACTS) {
      if (!c.autoRenew) {
        expect(c.renewalTermMonths, `${c.code} has no next term`).toBeNull();
      }
    }
  });

  // ── TRAP 6 ────────────────────────────────────────────────────────────────
  it("TRAP 6 (owner fallback): exactly one obligation has no owner, and its contract does", () => {
    const orphans = OBLIGATIONS.filter((o) => o.ownerEmail === null);
    expect(orphans.length).toBe(1);
    const parent = contractById.get(orphans[0].contractId)!;
    expect(parent.ownerEmail).toBeTruthy();
    // Never NULL anywhere: the fallback has to be able to resolve for every row.
    for (const c of CONTRACTS) expect(c.ownerEmail).toBeTruthy();
  });

  // ── TRAP 7 ────────────────────────────────────────────────────────────────
  it("TRAP 7 (stale status): exactly one obligation is completed while still reading `open`", () => {
    const completedIds = new Set(OBLIGATION_COMPLETIONS.map((c) => c.obligationId));
    const stale = OBLIGATIONS.filter((o) => o.status === "open" && completedIds.has(o.id));
    expect(stale.length).toBe(1);
    // And it really is complete as of the default date, so a query reading
    // `status` returns it and a query reading the completions table does not.
    expect(isCompleted(stale[0].id, LEGAL_DEFAULT_AS_OF)).toBe(true);
  });

  it("TRAP 7 (settled is settled): exactly one obligation is waived, and it is past its due date", () => {
    const waived = OBLIGATIONS.filter((o) => o.status === "waived");
    expect(waived.length).toBe(1);
    expect(waived[0].dueDate < LEGAL_DEFAULT_AS_OF).toBe(true);
  });

  it("TRAP 7: every `complete` obligation has an evidence row, and there is no stored overdue flag", () => {
    const completedIds = new Set(OBLIGATION_COMPLETIONS.map((c) => c.obligationId));
    for (const o of OBLIGATIONS) {
      if (o.status === "complete") {
        expect(completedIds.has(o.id), `${o.code} claims complete with no evidence`).toBe(true);
      }
      // Overdue is DERIVED. A stored value would be a second answer that can
      // disagree with the dates.
      expect(["open", "complete", "waived"]).toContain(o.status);
    }
  });

  // ── TRAP 8 ────────────────────────────────────────────────────────────────
  it("TRAP 8 (date-bounded suppression): exactly one contract in the renewal window is already noticed", () => {
    const already = reportable(LEGAL_DEFAULT_AS_OF).filter(
      (c) =>
        c.autoRenew &&
        noticeDeadline(c)! <= addDays(LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS) &&
        alreadyNoticed(c.id, LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS),
    );
    expect(already.length).toBe(1);
  });

  it("TRAP 8 (date-bounded suppression): exactly one contract has ONLY a prior-cycle notice and must be noticed again", () => {
    // This is the row that proves the date bound exists. An `EXISTS` over
    // notice_log with no date bound suppresses this contract, and it auto-renews
    // in silence.
    const priorOnly = reportable(LEGAL_DEFAULT_AS_OF).filter((c) => {
      if (!c.autoRenew) return false;
      if (noticeDeadline(c)! > addDays(LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS)) return false;
      const hasAny = NOTICE_LOG.some(
        (n) =>
          n.contractId === c.id &&
          (n.noticeType === "renewal_reminder" || n.noticeType === "non_renewal"),
      );
      return hasAny && !alreadyNoticed(c.id, LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS);
    });
    expect(priorOnly.length).toBe(1);
  });

  // ── TRAP 9 ────────────────────────────────────────────────────────────────
  it("TRAP 9 (unmailable): exactly one counterparty has no contact address", () => {
    expect(COUNTERPARTIES.filter((c) => c.contactEmail === null).length).toBe(1);
  });

  it("TRAP 9 (bouncing): exactly one counterparty is on a domain that always hard-bounces", () => {
    expect(BOUNCING_DOMAIN.endsWith("-bounce.example")).toBe(true);
    const bouncing = COUNTERPARTIES.filter((c) => c.contactEmail?.endsWith(`@${BOUNCING_DOMAIN}`));
    expect(bouncing.length).toBe(1);
  });

  it("TRAP 9 (empty group): exactly one counterparty has ZERO live contracts, and it does have rows", () => {
    const live = (id: number) =>
      CONTRACTS.filter((c) => c.counterpartyId === id && c.status === "active").length;
    const dormant = COUNTERPARTIES.filter((c) => live(c.id) === 0);
    expect(dormant.length).toBe(1);
    // It has a contract row — just no LIVE one. An inner join on live contracts
    // drops it, which is exactly what the summary query exists to surface.
    expect(CONTRACTS.some((c) => c.counterpartyId === dormant[0].id)).toBe(true);
  });

  it("TRAP 9: both the unmailable and the bouncing counterparty have something actionable at the DEFAULT date only", () => {
    const unmailable = COUNTERPARTIES.find((c) => c.contactEmail === null)!;
    const bouncing = COUNTERPARTIES.find((c) => c.contactEmail?.endsWith(`@${BOUNCING_DOMAIN}`))!;
    const actionableAt = (asOf: string, cpId: number) =>
      reportable(asOf).some(
        (c) =>
          c.counterpartyId === cpId &&
          c.autoRenew &&
          noticeDeadline(c)! <= addDays(asOf, DEFAULT_LOOKAHEAD_DAYS),
      );
    expect(actionableAt(LEGAL_DEFAULT_AS_OF, unmailable.id)).toBe(true);
    expect(actionableAt(LEGAL_DEFAULT_AS_OF, bouncing.id)).toBe(true);
    expect(actionableAt("2026-04-30", unmailable.id)).toBe(false);
    expect(actionableAt("2026-04-30", bouncing.id)).toBe(false);
  });
});

describe("the Legal dataset — synthetic-data and determinism guarantees", () => {
  it("puts every email address on an RFC 2606 reserved domain", () => {
    const addresses = [
      ...COUNTERPARTIES.map((c) => c.contactEmail),
      ...CONTRACTS.map((c) => c.ownerEmail),
      ...OBLIGATIONS.map((o) => o.ownerEmail),
      ...OBLIGATION_COMPLETIONS.map((c) => c.completedBy),
      ...NOTICE_LOG.map((n) => n.sentTo),
    ].filter((a): a is string => a !== null);

    expect(addresses.length).toBeGreaterThan(20);
    for (const a of addresses) {
      expect(a, `${a} must be on a reserved .example domain`).toMatch(/@[a-z0-9.-]+\.example$/);
    }
  });

  it("contains no clock reads — the traps must not move with the date", () => {
    // A dataset whose traps drift with the wall clock cannot have an oracle, and
    // the failure is invisible until the day a boundary row stops being on the
    // boundary. Read off disk rather than reasoning about behaviour, because the
    // absence of a call is not observable at runtime.
    const src = readFileSync(join(here, "legal-dataset.ts"), "utf8");
    expect(src).not.toMatch(/Date\.now\(\)/);
    expect(src).not.toMatch(/new Date\(\s*\)/);
    // Control: the assertion can actually find something in this file.
    expect(src.length).toBeGreaterThan(5000);
    expect(src).toContain("legalOracle");
  });

  it("shares no oracle implementation with Finance or HR", () => {
    // A shared oracle lets a shared bug produce a wrong answer that agrees with
    // itself — the swap rehearsal's finding, restated for a third tenant.
    //
    // ⚠ Asserted as the ABSENCE OF ANY IMPORT, not as the absence of the strings
    // "financeOracle"/"expectedScreening". The docblock NAMES both, deliberately,
    // to say this module is not a parameterisation of either — so a
    // substring check makes the honest explanation the thing that fails, and the
    // cheapest way to go green is to delete the explanation. No import is also
    // the stronger property: you cannot call what you have not imported.
    const src = readFileSync(join(here, "legal-dataset.ts"), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import[\s{]/.test(l));
    expect(imports, "legal-dataset.ts must import nothing at all").toEqual([]);
    expect(src).not.toMatch(/from\s+["']\.\.\/finance\//);
    expect(src).not.toMatch(/from\s+["']\.\.\/hr-dataset/);
    expect(src).not.toMatch(/from\s+["']\.\.\/alt\//);
  });
});

describe("legalOracle()", () => {
  it("returns ZERO renewals due and ZERO overdue obligations at 2026-04-30", () => {
    // The empty case, and the only as-of date that exercises it. ⚠ Scoped to the
    // RENEWAL query: `lapseRisk` is deliberately non-empty here — see
    // session-notes.md "Surprises" #1 for why both cannot be empty at once.
    const o = legalOracle("2026-04-30", DEFAULT_LOOKAHEAD_DAYS);
    expect(o.renewalDue).toEqual([]);
    expect(o.obligationsOverdue).toEqual([]);
    expect(o.lapseRisk.length).toBeGreaterThan(0);
  });

  it("populates all four urgency buckets in the renewal query at the default as-of date", () => {
    const o = legalOracle();
    expect(o.asOf).toBe(LEGAL_DEFAULT_AS_OF);
    for (const bucket of ["missed", "0-14", "15-30", "31-90"] as const) {
      expect(o.renewalByBucket[bucket], `bucket ${bucket} at ${o.asOf}`).toBeGreaterThan(0);
    }
  });

  it("keeps the two deadline populations disjoint and complete at every as-of date", () => {
    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      const renew = new Set(o.renewalDue.map((r) => r.contractCode));
      const lapse = new Set(o.lapseRisk.map((r) => r.contractCode));
      for (const code of renew) {
        expect(lapse.has(code), `${code} is in both deadline queries at ${asOf}`).toBe(false);
      }
      expect(renew.size + lapse.size).toBe(
        new Set([...renew, ...lapse]).size,
      );
    }
  });

  it("excludes the evergreen and superseded contracts from both deadline results, everywhere", () => {
    const evergreen = CONTRACTS.find((c) => c.endDate === null)!;
    const superseded = CONTRACTS.find((c) => c.supersededById !== null)!;
    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      const codes = [...o.renewalDue, ...o.lapseRisk].map((r) => r.contractCode);
      expect(codes).not.toContain(evergreen.code);
      expect(codes).not.toContain(superseded.code);
    }
  });

  it("never reports a draft, terminated or expired contract", () => {
    const excluded = CONTRACTS.filter((c) =>
      ["draft", "terminated", "expired"].includes(c.status),
    ).map((c) => c.code);
    expect(excluded.length).toBeGreaterThan(0);
    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      const codes = [...o.renewalDue, ...o.lapseRisk].map((r) => r.contractCode);
      for (const code of excluded) expect(codes).not.toContain(code);
    }
  });

  it("resolves every obligation reminder to a real recipient", () => {
    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      for (const ob of [...o.obligationsDue, ...o.obligationsOverdue]) {
        expect(ob.resolvedOwnerEmail, `${ob.obligationCode} at ${asOf}`).toMatch(
          /@[a-z0-9.-]+\.example$/,
        );
      }
    }
  });

  it("never reports a WAIVED obligation, at any as-of date", () => {
    // Settled is settled, however overdue. Unlike completion, a waiver is not
    // dated in this dataset, so this exclusion is absolute.
    const waived = OBLIGATIONS.find((o) => o.status === "waived")!;
    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      const codes = [...o.obligationsDue, ...o.obligationsOverdue].map((x) => x.obligationCode);
      expect(codes, `waived obligation at ${asOf}`).not.toContain(waived.code);
    }
  });

  it("treats completion as AS-OF-DATED: the stale obligation is reported before its evidence exists and not after", () => {
    // ⚠ This is the sharper version of "never reports a completed obligation",
    // and the blunt version asserted something FALSE. OBL-004's evidence is dated
    // 2026-06-05, so at 2026-04-30 the obligation genuinely is still open and
    // reporting it is correct. What the trap actually says is that once the
    // evidence exists, `status = 'open'` must not resurrect it.
    const completedIds = new Set(OBLIGATION_COMPLETIONS.map((c) => c.obligationId));
    const stale = OBLIGATIONS.find((o) => o.status === "open" && completedIds.has(o.id))!;
    const evidenceDate = OBLIGATION_COMPLETIONS.find((c) => c.obligationId === stale.id)!.completedDate;

    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      const codes = [...o.obligationsDue, ...o.obligationsOverdue].map((x) => x.obligationCode);
      if (asOf >= evidenceDate) {
        expect(codes, `stale-status obligation must be gone at ${asOf}`).not.toContain(stale.code);
      } else {
        expect(codes, `stale-status obligation was still open at ${asOf}`).toContain(stale.code);
      }
    }
    // Both branches must actually be taken, or this test proves nothing (I-38).
    expect(LEGAL_AS_OF_DATES.some((d) => d >= evidenceDate)).toBe(true);
    expect(LEGAL_AS_OF_DATES.some((d) => d < evidenceDate)).toBe(true);
  });

  it("reports the zero-live-contract counterparty in the summary at every as-of date", () => {
    const live = (id: number) =>
      CONTRACTS.filter((c) => c.counterpartyId === id && c.status === "active").length;
    const dormant = COUNTERPARTIES.find((c) => live(c.id) === 0)!;
    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      const row = o.counterpartySummary.find((s) => s.counterpartyCode === dormant.code);
      expect(row, `${dormant.code} missing from the summary at ${asOf}`).toBeDefined();
      expect(row!.liveContracts).toBe(0);
    }
  });

  it("labels the unmailable and bouncing counterparties in the summary", () => {
    const o = legalOracle();
    const statuses = new Map(o.counterpartySummary.map((s) => [s.counterpartyCode, s.contactStatus]));
    const unmailable = COUNTERPARTIES.find((c) => c.contactEmail === null)!;
    const bouncing = COUNTERPARTIES.find((c) => c.contactEmail?.endsWith(`@${BOUNCING_DOMAIN}`))!;
    expect(statuses.get(unmailable.code)).toBe("no_contact_email");
    expect(statuses.get(bouncing.code)).toBe("bouncing");
    expect(o.unmailable).toEqual([unmailable.code]);
    expect(o.bouncing).toEqual([bouncing.code]);
  });

  it("computes liability caps as MULTIPLES, never as currency", () => {
    const o = legalOracle();
    expect(o.nonStandardClauses.length).toBeGreaterThan(0);
    for (const c of o.nonStandardClauses) {
      if (c.liabilityCapMultipleX !== null) {
        // A multiple, so a small number. Anything in the thousands would mean
        // somebody put an amount in this column.
        expect(c.liabilityCapMultipleX).toBeLessThan(100);
        expect(c.liabilityCapMultipleX).toBeGreaterThan(0);
      }
    }
  });
});

/** Local copy — the test must not depend on the module under test for its own arithmetic. */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
