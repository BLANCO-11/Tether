/**
 * Legal dataset self-check — `pnpm legal:verify`.
 *
 * Two halves, and the second is the one that matters.
 *
 *   A. INVARIANTS OF THE DEFINITIONS. Every trap is present, every address is on
 *      a reserved domain, the headline counts are what the documentation claims.
 *      No database involved. This is the shape `demo:verify` has.
 *
 *   B. THE NAMED QUERIES AGAINST THE ORACLE. Each query is executed as
 *      `legal_ro` against the seeded database, at all three as-of dates, and its
 *      answer is compared to `legalOracle()` row for row.
 *
 * Half B exists because half A cannot fail for the reason that actually matters.
 * The oracle and the SQL were written from the schema, independently — so when
 * they agree, the two-level COALESCE, the inclusive boundary and the date-bounded
 * suppression are all right in both places. When they disagree, one of them is
 * wrong and the harness says which row. A dataset check that only read TypeScript
 * would have declared the boundary trap "present" while every query got it
 * backwards.
 *
 * ⚠ It FAILS rather than skipping when the database is unreachable. A verifier
 * that quietly drops its strongest half is the false green this repo keeps
 * finding; run `pnpm legal:seed` first.
 *
 * ⚠ Half B also asserts the two deadline queries are DISJOINT and that their
 * union is complete, at every as-of date. That is the guard on the one piece of
 * deliberate duplication in `legal-queries.ts` (the auto-renew split): the date
 * arithmetic is written twice, and this is what stops the two copies drifting.
 */
import { Client } from "pg";
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
  addDays,
  alreadyNoticed,
  effectiveNoticeDays,
  isCompleted,
  isDeadlineEligible,
  legalOracle,
  noticeDeadline,
} from "./legal-dataset.js";
import { LEGAL_GENERATED_QUERIES as LEGAL_QUERIES } from "./legal-generated.js";
import { LEGAL_RO_ROLE, legalRoDbUrl, verifyLegalReadOnlyRole } from "./seed-legal-db.js";

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

/** A `date` column arrives from pg as a Date; the oracle speaks ISO strings. */
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null);

const typeByCode = new Map(CONTRACT_TYPES.map((t) => [t.code, t]));
const contractById = new Map(CONTRACTS.map((x) => [x.id, x]));
const query = (name: string) => {
  const q = LEGAL_QUERIES.find((x) => x.name === name);
  if (!q) throw new Error(`no named query ${name} — the catalogue and this harness disagree`);
  return q;
};

// ═══════════════════════════════════════════════════════════════════════════
// HALF A — invariants of the definitions. No database.
// ═══════════════════════════════════════════════════════════════════════════

function halfA() {
  console.log("dataset invariants " + c.dim("(from the definitions, no database)"));

  // ── Populations ───────────────────────────────────────────────────────────
  check(ORG_SETTINGS.length === 4, `org_settings: ${ORG_SETTINGS.length} rows, expected 4`);
  check(LEGAL_ENTITIES.length === 2, `legal_entities: ${LEGAL_ENTITIES.length}, expected 2`);
  check(COUNTERPARTIES.length === 11, `counterparties: ${COUNTERPARTIES.length}, expected 11`);
  check(CONTRACT_TYPES.length === 6, `contract_types: ${CONTRACT_TYPES.length}, expected 6`);
  check(CONTRACTS.length === 24, `contracts: ${CONTRACTS.length}, expected 24`);
  check(CONTRACT_RELATIONSHIPS.length === 5, `contract_relationships: ${CONTRACT_RELATIONSHIPS.length}, expected 5`);
  check(CONTRACT_CLAUSES.length === 20, `contract_clauses: ${CONTRACT_CLAUSES.length}, expected 20`);
  check(OBLIGATIONS.length === 22, `obligations: ${OBLIGATIONS.length}, expected 22`);
  check(OBLIGATION_COMPLETIONS.length === 7, `obligation_completions: ${OBLIGATION_COMPLETIONS.length}, expected 7`);
  check(NOTICE_LOG.length === 5, `notice_log: ${NOTICE_LOG.length}, expected 5`);

  // ── TRAP 1 — the inclusive boundary, at EVERY as-of date ──────────────────
  for (const asOf of LEGAL_AS_OF_DATES) {
    const onBoundary = CONTRACTS.filter(
      (x) => isDeadlineEligible(x, asOf) && noticeDeadline(x) === asOf,
    );
    check(
      onBoundary.length === 1,
      `TRAP 1: ${onBoundary.length} contract(s) on the notice boundary at ${asOf}, expected exactly 1`,
    );
  }
  const defaultBoundary = CONTRACTS.find(
    (x) => isDeadlineEligible(x, LEGAL_DEFAULT_AS_OF) && noticeDeadline(x) === LEGAL_DEFAULT_AS_OF,
  );
  check(
    defaultBoundary?.autoRenew === true,
    `TRAP 1: the boundary contract at ${LEGAL_DEFAULT_AS_OF} must be auto-renewing, so the trap ` +
      `lands in contracts_renewal_due and not only in the internal-facing query`,
  );

  // ── TRAP 2 — the two-level fallback, and that it DISCRIMINATES ────────────
  const twoHop = CONTRACTS.filter(
    (x) => x.noticePeriodDays === null && typeByCode.get(x.typeCode)!.defaultNoticePeriodDays === null,
  );
  check(twoHop.length === 1, `TRAP 2: ${twoHop.length} contract(s) need both fallback hops, expected 1`);
  const maxValue = Math.max(...CONTRACTS.map((x) => x.valueCents));
  check(
    twoHop[0]?.valueCents === maxValue,
    `TRAP 2: the two-hop contract must be the highest-value one (${maxValue}), not ${twoHop[0]?.valueCents}`,
  );
  const middleHop = CONTRACTS.filter(
    (x) => x.noticePeriodDays === null && typeByCode.get(x.typeCode)!.defaultNoticePeriodDays !== null,
  );
  check(middleHop.length > 0, "TRAP 2: no contract exercises the middle fallback hop alone");
  // ⚠ The org default must differ from every type default, or a query that skips
  // the type level resolves the right number anyway and the trap is undetectable.
  // This is the assertion that caught the first version of this dataset.
  check(
    !CONTRACT_TYPES.some((t) => t.defaultNoticePeriodDays === DEFAULT_NOTICE_PERIOD_DAYS),
    `TRAP 2: a contract type defaults to ${DEFAULT_NOTICE_PERIOD_DAYS}, the same as the org-wide ` +
      `value — a query that skips the contract-type hop then gets the right answer anyway and the ` +
      `two-level fallback cannot be detected`,
  );

  // ── TRAP 3 — evergreen ────────────────────────────────────────────────────
  const evergreen = CONTRACTS.filter((x) => x.endDate === null);
  check(evergreen.length === 1, `TRAP 3: ${evergreen.length} evergreen contract(s), expected 1`);
  check(
    evergreen.every((x) => noticeDeadline(x) === null),
    "TRAP 3: an evergreen contract must have no notice deadline",
  );

  // ── TRAP 4 — supersession, and the title-prefix negative control ──────────
  const superseded = CONTRACTS.filter((x) => x.supersededById !== null);
  check(superseded.length === 1, `TRAP 4: ${superseded.length} supersession chain(s), expected 1`);
  check(
    superseded.every((x) => x.status === "superseded"),
    "TRAP 4: a contract with a successor must have status 'superseded'",
  );
  const byPrefix = new Map<string, typeof CONTRACTS>();
  for (const x of CONTRACTS) {
    const prefix = x.title.split(" — ")[0];
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), x]);
  }
  const decoys = [...byPrefix.values()].filter(
    (g) => g.length > 1 && new Set(g.map((x) => x.counterpartyId)).size === g.length,
  );
  check(
    decoys.length > 0,
    "TRAP 4: no title-prefix negative control — a supersession rule keyed on the title would have " +
      "nothing to get wrong",
  );
  check(
    decoys.every((g) => g.every((x) => x.supersededById === null && !CONTRACTS.some((y) => y.supersededById === x.id))),
    "TRAP 4: a title-prefix decoy is in a real supersession chain, so it is not a negative control",
  );

  // ── TRAP 5 — the auto-renew inversion ─────────────────────────────────────
  const oDefault = legalOracle(LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS);
  check(oDefault.renewalDue.length > 0, "TRAP 5: no auto-renewing contract in the default window");
  check(oDefault.lapseRisk.length > 0, "TRAP 5: no fixed-term contract in the default window");
  check(
    CONTRACTS.every((x) => x.autoRenew || x.renewalTermMonths === null),
    "TRAP 5: a non-auto-renewing contract carries a renewal term, which has no meaning",
  );

  // ── TRAP 6 — the obligation owner fallback ────────────────────────────────
  const orphans = OBLIGATIONS.filter((o) => o.ownerEmail === null);
  check(orphans.length === 1, `TRAP 6: ${orphans.length} obligation(s) with no owner, expected 1`);
  check(
    orphans.every((o) => Boolean(contractById.get(o.contractId)?.ownerEmail)),
    "TRAP 6: the ownerless obligation's contract has no owner either, so the fallback resolves to nothing",
  );

  // ── TRAP 7 — stale status, and settled status ─────────────────────────────
  const completedIds = new Set(OBLIGATION_COMPLETIONS.map((x) => x.obligationId));
  const stale = OBLIGATIONS.filter((o) => o.status === "open" && completedIds.has(o.id));
  check(stale.length === 1, `TRAP 7: ${stale.length} obligation(s) completed but still reading 'open', expected 1`);
  check(
    stale.every((o) => isCompleted(o.id, LEGAL_DEFAULT_AS_OF)),
    `TRAP 7: the stale obligation is not complete as of ${LEGAL_DEFAULT_AS_OF}, so nothing detects the staleness`,
  );
  const waived = OBLIGATIONS.filter((o) => o.status === "waived");
  check(waived.length === 1, `TRAP 7: ${waived.length} waived obligation(s), expected 1`);
  check(
    waived.every((o) => o.dueDate < LEGAL_DEFAULT_AS_OF),
    "TRAP 7: the waived obligation is not past its due date, so 'settled is settled' is untested",
  );
  check(
    OBLIGATIONS.filter((o) => o.status === "complete").every((o) => completedIds.has(o.id)),
    "TRAP 7: an obligation claims 'complete' with no evidence row",
  );

  // ── TRAP 8 — date-bounded suppression ────────────────────────────────────
  const inWindow = (x: (typeof CONTRACTS)[number], asOf: string) =>
    isDeadlineEligible(x, asOf) &&
    x.autoRenew &&
    noticeDeadline(x)! <= addDays(asOf, DEFAULT_LOOKAHEAD_DAYS);
  const noticedNow = CONTRACTS.filter(
    (x) => inWindow(x, LEGAL_DEFAULT_AS_OF) && alreadyNoticed(x.id, LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS),
  );
  check(noticedNow.length === 1, `TRAP 8: ${noticedNow.length} contract(s) already noticed this cycle, expected 1`);
  const priorOnly = CONTRACTS.filter(
    (x) =>
      inWindow(x, LEGAL_DEFAULT_AS_OF) &&
      NOTICE_LOG.some(
        (n) => n.contractId === x.id && (n.noticeType === "renewal_reminder" || n.noticeType === "non_renewal"),
      ) &&
      !alreadyNoticed(x.id, LEGAL_DEFAULT_AS_OF, DEFAULT_LOOKAHEAD_DAYS),
  );
  check(
    priorOnly.length === 1,
    `TRAP 8: ${priorOnly.length} contract(s) with ONLY a prior-cycle notice, expected 1 — this is the ` +
      `row that proves the EXISTS is date-bounded, and without it an unbounded check scores full marks`,
  );

  // ── TRAP 9 — unmailable, bouncing, empty group ───────────────────────────
  check(
    COUNTERPARTIES.filter((x) => x.contactEmail === null).length === 1,
    "TRAP 9: expected exactly one counterparty with no contact address",
  );
  check(BOUNCING_DOMAIN.endsWith("-bounce.example"), `TRAP 9: ${BOUNCING_DOMAIN} is not a reserved bouncing domain`);
  check(
    COUNTERPARTIES.filter((x) => x.contactEmail?.endsWith(`@${BOUNCING_DOMAIN}`)).length === 1,
    "TRAP 9: expected exactly one counterparty on the hard-bouncing domain",
  );
  const dormant = COUNTERPARTIES.filter(
    (cp) => CONTRACTS.filter((x) => x.counterpartyId === cp.id && x.status === "active").length === 0,
  );
  check(dormant.length === 1, `TRAP 9: ${dormant.length} counterparty(ies) with zero live contracts, expected 1`);
  check(
    dormant.every((cp) => CONTRACTS.some((x) => x.counterpartyId === cp.id)),
    "TRAP 9: the zero-live counterparty has no contract rows at all, so a LEFT JOIN is not what surfaces it",
  );

  // ── Synthetic-data guarantee ──────────────────────────────────────────────
  const addresses = [
    ...COUNTERPARTIES.map((x) => x.contactEmail),
    ...CONTRACTS.map((x) => x.ownerEmail),
    ...OBLIGATIONS.map((x) => x.ownerEmail),
    ...OBLIGATION_COMPLETIONS.map((x) => x.completedBy),
    ...NOTICE_LOG.map((x) => x.sentTo),
  ].filter((a): a is string => a !== null);
  const offDomain = addresses.filter((a) => !/@[a-z0-9.-]+\.example$/.test(a));
  check(
    offDomain.length === 0,
    `SYNTHETIC DATA: ${offDomain.length} address(es) not on a reserved .example domain: ${offDomain.slice(0, 3).join(", ")}`,
  );

  // ── The empty case ────────────────────────────────────────────────────────
  const oApril = legalOracle("2026-04-30", DEFAULT_LOOKAHEAD_DAYS);
  check(oApril.renewalDue.length === 0, `EMPTY CASE: 2026-04-30 has ${oApril.renewalDue.length} renewals due, expected 0`);
  check(
    oApril.obligationsOverdue.length === 0,
    `EMPTY CASE: 2026-04-30 has ${oApril.obligationsOverdue.length} overdue obligations, expected 0`,
  );
  // ⚠ And the OTHER deadline query is deliberately NOT empty here. If it were,
  // nothing at this date would exercise the inclusive boundary at all.
  check(
    oApril.lapseRisk.length > 0,
    "EMPTY CASE: 2026-04-30's lapse-risk result is also empty — the boundary contract at this date " +
      "is non-auto-renewing, so this query is what exercises the boundary here",
  );

  // ── All four buckets at the default date ──────────────────────────────────
  for (const bucket of ["missed", "0-14", "15-30", "31-90"] as const) {
    check(
      oDefault.renewalByBucket[bucket] > 0,
      `BUCKETS: '${bucket}' is empty at ${LEGAL_DEFAULT_AS_OF}, so nothing exercises it`,
    );
  }

  console.log(
    `  contracts=${CONTRACTS.length} counterparties=${COUNTERPARTIES.length} ` +
      `obligations=${OBLIGATIONS.length} clauses=${CONTRACT_CLAUSES.length} notices=${NOTICE_LOG.length}`,
  );
  for (const asOf of LEGAL_AS_OF_DATES) {
    const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
    const b = o.renewalByBucket;
    console.log(
      `  ${asOf}  renewal=${String(o.renewalDue.length).padStart(2)} ` +
        `[missed:${b.missed} 0-14:${b["0-14"]} 15-30:${b["15-30"]} 31-90:${b["31-90"]}]  ` +
        `lapse=${o.lapseRisk.length}  obligations=${o.obligationsDue.length} (overdue ${o.obligationsOverdue.length})  ` +
        `noticed=[${o.alreadyNoticed.join(",") || "-"}]`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HALF B — the named queries against the oracle, as `legal_ro`.
// ═══════════════════════════════════════════════════════════════════════════

async function halfB() {
  rule();
  console.log(`named queries vs the oracle ${c.dim(`(as ${LEGAL_RO_ROLE})`)}`);

  const client = new Client({ connectionString: legalRoDbUrl() });
  // ⚠ No try/catch that degrades to a skip. An unreachable database means the
  // half that actually proves something did not run, and a verifier that reports
  // green on that is the false green this repo keeps finding.
  await client.connect();

  try {
    const role = await verifyLegalReadOnlyRole(client);
    for (const p of role.problems) problems.push(`read-only role: ${p}`);
    console.log(
      `  ${role.problems.length ? c.bad("✗") : c.ok("✓")} ${LEGAL_RO_ROLE}: SELECT on ` +
        `${role.selectableTables.length} table(s), no write privileges, ` +
        `no CONNECT to [${role.isolatedFrom.join(", ") || "nothing else present"}]`,
    );

    for (const asOf of LEGAL_AS_OF_DATES) {
      const o = legalOracle(asOf, DEFAULT_LOOKAHEAD_DAYS);
      const before = problems.length;

      // ⚠ `row_limit` is passed WELL ABOVE the contract count on purpose. A cap
      // that silently trimmed the result would make the comparison agree with a
      // truncated oracle and prove nothing.
      const renewal = (
        await client.query(query("contracts_renewal_due").sqlText, [asOf, DEFAULT_LOOKAHEAD_DAYS, 1000])
      ).rows;
      const lapse = (
        await client.query(query("contracts_expiring_no_autorenew").sqlText, [asOf, DEFAULT_LOOKAHEAD_DAYS])
      ).rows;
      const obligations = (
        await client.query(query("obligations_due").sqlText, [asOf, DEFAULT_LOOKAHEAD_DAYS])
      ).rows;
      const clauses = (await client.query(query("nonstandard_clause_register").sqlText, [null])).rows;
      const summary = (await client.query(query("counterparty_contract_summary").sqlText, [asOf])).rows;

      const compareDeadlines = (label: string, rows: any[], want: typeof o.renewalDue) => {
        check(
          rows.length === want.length,
          `${asOf} ${label}: SQL returned ${rows.length} row(s), the oracle says ${want.length}`,
        );
        const gotCodes = rows.map((r) => r.contract_code);
        const wantCodes = want.map((r) => r.contractCode);
        check(
          JSON.stringify(gotCodes) === JSON.stringify(wantCodes),
          `${asOf} ${label}: membership or order differs\n      SQL:    ${gotCodes.join(" ")}\n      oracle: ${wantCodes.join(" ")}`,
        );
        for (let i = 0; i < Math.min(rows.length, want.length); i++) {
          const s = rows[i];
          const w = want[i];
          const at = `${asOf} ${label} ${w.contractCode}`;
          check(iso(s.notice_deadline) === w.noticeDeadline, `${at}: notice_deadline ${iso(s.notice_deadline)} vs oracle ${w.noticeDeadline}`);
          check(Number(s.days_to_deadline) === w.daysToDeadline, `${at}: days_to_deadline ${s.days_to_deadline} vs oracle ${w.daysToDeadline}`);
          check(s.urgency_bucket === w.urgencyBucket, `${at}: urgency_bucket ${s.urgency_bucket} vs oracle ${w.urgencyBucket}`);
          check(s.already_noticed === w.alreadyNoticed, `${at}: already_noticed ${s.already_noticed} vs oracle ${w.alreadyNoticed}`);
          check(
            Number(s.effective_notice_days) === w.effectiveNoticeDays,
            `${at}: effective_notice_days ${s.effective_notice_days} vs oracle ${w.effectiveNoticeDays} — ` +
              `this is the two-level COALESCE disagreeing between the SQL and the oracle`,
          );
          check(Number(s.value_cents) === w.valueCents, `${at}: value_cents ${s.value_cents} vs oracle ${w.valueCents}`);
        }
      };
      compareDeadlines("renewal_due", renewal, o.renewalDue);
      compareDeadlines("lapse_risk", lapse, o.lapseRisk);

      // ── The guard on the deliberate duplication ───────────────────────────
      const renewalCodes = new Set<string>(renewal.map((r) => r.contract_code));
      const lapseCodes = new Set<string>(lapse.map((r) => r.contract_code));
      const both = [...renewalCodes].filter((x) => lapseCodes.has(x));
      check(
        both.length === 0,
        `${asOf} the two deadline queries OVERLAP on ${both.join(", ")} — a contract in both means a ` +
          `flow could send it a renewal notice AND a lapse warning`,
      );
      const unionFromSql = new Set([...renewalCodes, ...lapseCodes]);
      const unionFromOracle = new Set([
        ...o.renewalDue.map((r) => r.contractCode),
        ...o.lapseRisk.map((r) => r.contractCode),
      ]);
      check(
        unionFromSql.size === unionFromOracle.size &&
          [...unionFromOracle].every((x) => unionFromSql.has(x)),
        `${asOf} the union of the two deadline queries is incomplete — a contract in the window is ` +
          `in neither result, which is how the auto-renew split silently drops one`,
      );

      // ── The boundary contract, by name ───────────────────────────────────
      const boundary = [...renewal, ...lapse].filter((r) => iso(r.notice_deadline) === asOf);
      check(
        boundary.length === 1,
        `${asOf} ${boundary.length} row(s) sit exactly on the notice boundary, expected 1 — a '<' ` +
          `where '<=' belongs drops the one contract that could still be saved`,
      );
      check(
        boundary.every((r) => r.urgency_bucket === "0-14"),
        `${asOf} the boundary row is in bucket '${boundary[0]?.urgency_bucket}', expected '0-14' — ` +
          `zero days to go means the deadline is TODAY, not missed`,
      );

      // ── Exclusions, by name ─────────────────────────────────────────────
      const allCodes = [...renewalCodes, ...lapseCodes];
      for (const code of [...o.evergreenExcluded, ...o.supersededExcluded]) {
        check(!allCodes.includes(code), `${asOf} ${code} must never appear in a deadline result`);
      }
      for (const x of CONTRACTS.filter((y) => ["draft", "terminated", "expired"].includes(y.status))) {
        check(!allCodes.includes(x.code), `${asOf} ${x.code} is ${x.status} and must not be reported`);
      }

      // ── Obligations ─────────────────────────────────────────────────────
      const gotObl = obligations.map((r) => r.obligation_code);
      const wantObl = o.obligationsDue.map((r) => r.obligationCode);
      check(
        JSON.stringify(gotObl) === JSON.stringify(wantObl),
        `${asOf} obligations_due: membership or order differs\n      SQL:    ${gotObl.join(" ")}\n      oracle: ${wantObl.join(" ")}`,
      );
      check(
        obligations.filter((r) => r.overdue).length === o.obligationsOverdue.length,
        `${asOf} obligations_due: ${obligations.filter((r) => r.overdue).length} overdue, oracle says ${o.obligationsOverdue.length}`,
      );
      for (const r of obligations) {
        check(
          /@[a-z0-9.-]+\.example$/.test(r.resolved_owner_email ?? ""),
          `${asOf} ${r.obligation_code}: resolved_owner_email is '${r.resolved_owner_email}' — the ` +
            `COALESCE to the contract owner did not resolve`,
        );
      }
      const staleObl = OBLIGATIONS.find(
        (x) => x.status === "open" && OBLIGATION_COMPLETIONS.some((y) => y.obligationId === x.id),
      )!;
      const staleEvidence = OBLIGATION_COMPLETIONS.find((y) => y.obligationId === staleObl.id)!.completedDate;
      if (asOf >= staleEvidence) {
        check(
          !gotObl.includes(staleObl.code),
          `${asOf} ${staleObl.code} has filed evidence and must not be reported, whatever its status says`,
        );
      }
      check(
        !gotObl.includes(OBLIGATIONS.find((x) => x.status === "waived")!.code),
        `${asOf} a waived obligation was reported — settled is settled`,
      );

      // ── Clauses and the counterparty summary ────────────────────────────
      check(
        clauses.length === o.nonStandardClauses.length,
        `${asOf} nonstandard_clause_register: ${clauses.length} row(s), oracle says ${o.nonStandardClauses.length}`,
      );
      for (const r of clauses) {
        const m = r.liability_cap_multiple_x === null ? null : Number(r.liability_cap_multiple_x);
        check(
          m === null || (m > 0 && m < 100),
          `${asOf} ${r.contract_code}: liability_cap_multiple_x is ${m} — this column is a MULTIPLE ` +
            `of annual value, so a value in the thousands means an amount was stored in it`,
        );
      }

      check(
        summary.length === COUNTERPARTIES.length,
        `${asOf} counterparty_contract_summary: ${summary.length} row(s), expected ${COUNTERPARTIES.length} — ` +
          `every counterparty must appear, including the one with zero live contracts`,
      );
      for (let i = 0; i < Math.min(summary.length, o.counterpartySummary.length); i++) {
        const s = summary[i];
        const w = o.counterpartySummary[i];
        const at = `${asOf} summary ${w.counterpartyCode}`;
        check(s.counterparty_code === w.counterpartyCode, `${at}: order differs (SQL has ${s.counterparty_code})`);
        check(Number(s.live_contracts) === w.liveContracts, `${at}: live_contracts ${s.live_contracts} vs oracle ${w.liveContracts}`);
        check(Number(s.total_value_cents) === w.totalValueCents, `${at}: total_value_cents ${s.total_value_cents} vs oracle ${w.totalValueCents}`);
        check(iso(s.next_notice_deadline) === w.nextNoticeDeadline, `${at}: next_notice_deadline ${iso(s.next_notice_deadline)} vs oracle ${w.nextNoticeDeadline}`);
        check(s.contact_status === w.contactStatus, `${at}: contact_status ${s.contact_status} vs oracle ${w.contactStatus}`);
      }

      const clean = problems.length === before;
      console.log(
        `  ${clean ? c.ok("✓") : c.bad("✗")} ${asOf}  ${renewal.length} renewal · ${lapse.length} lapse-risk · ` +
          `${obligations.length} obligation(s) (${obligations.filter((r) => r.overdue).length} overdue) · ` +
          `${clauses.length} non-standard clause(s) · ${summary.length} counterparty(ies)`,
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
      "✓ legal dataset OK — every trap present, and every named query agrees with the oracle at " +
        "all three as-of dates",
    ),
  );
}

main().catch((e) => {
  // ⚠ Non-zero, and NOT a skip. If the database is unreachable, half B did not
  // run, and that is the half that proves the SQL and the oracle agree.
  console.error(c.bad("✗ legal:verify could not complete — run `pnpm legal:seed` first"));
  console.error(e);
  process.exit(1);
});
