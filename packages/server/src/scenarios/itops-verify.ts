/**
 * `pnpm --filter @foundry/server itops:scenarios-verify` — did the right ARM fire?
 *
 * ── ⚠ THIS IS THE ONLY THING THAT CAN CATCH A WRONG BRANCH ──────────────────
 *
 * A branching flow that picks the wrong arm is GREEN. The YAML is valid, every
 * expression renders, every task that ran succeeded, and the execution settles
 * SUCCESS — because the tasks in the arm that should have fired were simply
 * never scheduled. Nothing in `itops:scenarios`, nothing in `kestra:check` and
 * nothing in any unit test would report it. The only evidence is which task ids
 * appear in the execution, compared against what `itopsOracle()` says should
 * have happened.
 *
 * So this harness runs each flow at all three as-of instants and, for each run,
 * reads Kestra's `taskRunList` and asserts the arm membership matches the
 * oracle. It also reads the ops-api capture tables, because "the page task ran"
 * and "the right people were paged about the right incidents" are two claims and
 * only the second is worth anything.
 *
 * ── ⚠ THE LOAD-BEARING ASSERTION IS THE MIDDLE INSTANT OF FLOW 2 ────────────
 *
 * At `2026-06-15T14:00:00Z` a change freeze scoped to Payments defers four
 * findings while eleven elsewhere can proceed. `itops-vuln-remediation` uses TWO
 * INDEPENDENT GUARDS, so BOTH arms must fire in that one run. If somebody
 * "tidies" those two branches into an `elseOf` chain, that is the assertion that
 * goes red — and it is the only one that would, because a chain compiles, runs
 * green, announces the deferrals and silently never raises the eleven tickets.
 *
 * ── It runs DRAFT runs, and that matters ────────────────────────────────────
 *
 * A draft run goes to the `.draft` namespace, so `resolveRef` reads the sandbox
 * DSN where one exists. ⚠ No product workspace has a sandbox, deliberately —
 * `itopsOracle()` is computed from the REAL dataset, so turning fixtures on here
 * would make this harness fail for a correct reason. `StepBatchResult.readFrom`
 * says which it read on every batch.
 *
 * ⚠ It FAILS rather than skipping when the workspace or the engine is missing. A
 * verifier that quietly drops its only meaningful half is the false green this
 * repo keeps finding.
 */

import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { kestra, type KestraExecution } from "../services/kestra-client.service.js";
import { opsClient } from "../services/ops-client.service.js";
import { ITOPS_WORKSPACE_NAME } from "../demo/itops/provision-itops.js";
import { ITOPS_AS_OF, itopsOracle } from "../demo/itops/itops-dataset.js";
import { ITOPS_SLA_TRIAGE, ITOPS_VULN_REMEDIATION } from "./itops-flows.js";
// ⚠ NOT from `itops-seed.ts`. A scenario script's `main()` runs at IMPORT, and
// the first version of this line silently re-ran the entire seed — rebuilding
// the manifest, writing two revisions and re-arming both flows — with its output
// interleaved into this harness's own.
import { runDraft } from "./kestra-draft-run.js";

const problems: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) problems.push(msg);
};
const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/** Which task ids actually executed. The whole evidence for arm selection. */
function ran(ex: KestraExecution): Set<string> {
  return new Set((ex.taskRunList ?? []).map((t) => t.taskId));
}

/**
 * ⚠ ASSERTS BOTH DIRECTIONS, and the second is the one that matters.
 *
 * "the page task ran" is satisfied by a flow that runs every arm every time —
 * which is exactly what a broken guard does. So each expected task must have
 * run AND each forbidden one must not.
 */
function assertArms(label: string, ex: KestraExecution, expected: string[], forbidden: string[]) {
  const did = ran(ex);
  for (const id of expected) {
    check(did.has(id), `${label}: "${id}" should have run and did not — arms that ran: [${[...did].join(", ")}]`);
  }
  for (const id of forbidden) {
    check(
      !did.has(id),
      `${label}: "${id}" ran and should NOT have — the wrong arm fired, and the run is still green`,
    );
  }
}

/**
 * ⚠ camelCase, NOT the SQL column names.
 *
 * `GET /records/:name` projects Drizzle rows straight to JSON, so a `page_key`
 * column arrives as `pageKey`. The first version of these interfaces used the
 * SQL spelling; every field read back `undefined`, and the assertions then
 * reported "paged about [, , ]" and "template undefined" — messages that read
 * like the FLOW misbehaving rather than like the harness reading the wrong key.
 * A harness that blames the subject for its own mistake is worse than no
 * harness, so the shapes are pinned here with a control below.
 */
interface PageRow {
  pageKey: string;
  dedupeKey: string;
  target: string;
  status: string;
}
interface TicketRow {
  ticketKey: string;
  title: string;
  assignee: string | null;
}
interface ChatRow {
  channel: string;
  text: string;
}
interface MailRow {
  recipients: unknown;
  subject: string;
  templateKey: string | null;
}

async function main() {
  console.log(`\n${"═".repeat(76)}\nitops:scenarios-verify  ${c.dim("did the right ARM fire?")}\n${"═".repeat(76)}`);

  const ws = (await workspaceRepo.list()).find((w) => w.name === ITOPS_WORKSPACE_NAME);
  if (!ws) {
    console.error(
      c.bad(`\nno "${ITOPS_WORKSPACE_NAME}" workspace — run itops:seed then itops:scenarios first.\n`),
    );
    process.exit(1);
  }
  const triage = await flowRepo.getByKestraFlowId(ws.id, ITOPS_SLA_TRIAGE.id);
  const vuln = await flowRepo.getByKestraFlowId(ws.id, ITOPS_VULN_REMEDIATION.id);
  if (!triage || !vuln) {
    console.error(c.bad("\nthe scenario flows are not in this workspace — run itops:scenarios first.\n"));
    process.exit(1);
  }
  console.log(`\nworkspace ${c.ok(ws.name)} ${c.dim(ws.id)}`);

  // ═══════════════════════════════════════════════════════════════════════
  // Flow 1 — the CHAIN. Exactly one arm, and the oracle says which.
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${"─".repeat(76)}\n${ITOPS_SLA_TRIAGE.id} ${c.dim("— the if/elif/else chain")}\n`);

  const armsSeen = new Set<string>();

  for (const asOf of ITOPS_AS_OF) {
    const o = itopsOracle(asOf);
    const before = problems.length;
    const pagesBefore = (await opsClient.records<PageRow>("pages", 200)).length;

    const ex = await runDraft(ws.id, triage.id, { as_of: asOf });
    const settled = ex.state.current === "SUCCESS" || ex.state.current === "WARNING";
    check(settled, `${asOf} triage: execution settled ${ex.state.current}`);

    // ⚠ WHICH ARM THE ORACLE SAYS. Exactly one, and it is derived rather than
    // listed — a hardcoded expectation per instant would stop tracking the
    // dataset the moment somebody moved an incident.
    const expectPage = o.breached.length > 0;
    const expectTicket = !expectPage && o.atRisk.length > 0;
    const expectDigest = !expectPage && !expectTicket;
    const arm = expectPage ? "page" : expectTicket ? "ticket" : "digest";
    armsSeen.add(arm);

    assertArms(
      `${asOf} triage`,
      ex,
      [arm === "page" ? "page" : arm === "ticket" ? "ticket" : "digest"],
      ["page", "ticket", "digest"].filter((id) => id !== arm),
    );

    // ── and the CONTENT, not only the task ──────────────────────────────
    if (expectPage) {
      const pages = await opsClient.records<PageRow>("pages", 200);
      const fresh = pages.slice(0, pages.length - pagesBefore);
      // ⚠ The control on the camelCase note above: a field name that stopped
      // resolving would give an array of `undefined`, which sorts and joins
      // perfectly and compares as "the flow paged about nothing".
      check(
        fresh.every((p) => typeof p.dedupeKey === "string" && p.dedupeKey.length > 0),
        `${asOf} triage: page rows came back without a dedupeKey — this harness is reading the ` +
          "wrong field name, not the flow misbehaving",
      );
      const gotKeys = fresh.map((p) => p.dedupeKey).sort();
      const wantKeys = o.breached.map((b) => b.incidentCode).sort();
      check(
        gotKeys.join(",") === wantKeys.join(","),
        `${asOf} triage: paged about [${gotKeys.join(", ")}], oracle's breached set is ` +
          `[${wantKeys.join(", ")}]`,
      );
      // ⚠ THE ORG FALLBACK, LIVE IN A FLOW. The DATA team has no escalation
      // address of its own, so its breach must reach the org-wide address — and
      // the query resolves that in SQL, where a fragment cannot get it wrong.
      const wantTargets = new Set(o.breached.map((b) => b.recipientEmail));
      for (const p of fresh) {
        check(
          wantTargets.has(p.target),
          `${asOf} triage: paged ${p.target}, which is not a recipient the oracle expects ` +
            `(${[...wantTargets].join(", ")})`,
        );
      }
      if (o.orgFallbackEscalations.length > 0) {
        const orgAddr = o.breached.find((b) => b.escalatedViaOrgFallback)!.recipientEmail;
        check(
          fresh.some((p) => p.target === orgAddr),
          `${asOf} triage: ${o.orgFallbackEscalations.join(", ")} escalate through the org ` +
            `fallback (${orgAddr}) and no page went there`,
        );
      }
      // ⚠ RE-RUNNING MUST NOT RE-PAGE. This is the capability that makes a
      // 15-minute schedule defensible, and it is only checkable end to end.
      const ex2 = await runDraft(ws.id, triage.id, { as_of: asOf });
      check(
        ex2.state.current === "SUCCESS" || ex2.state.current === "WARNING",
        `${asOf} triage: the second run settled ${ex2.state.current}`,
      );
      const after = await opsClient.records<PageRow>("pages", 200);
      const second = after.slice(0, after.length - pages.length);
      check(
        second.length > 0 && second.every((p) => p.status === "suppressed"),
        `${asOf} triage: running twice produced [${second.map((p) => p.status).join(", ")}] — ` +
          "every repeat must be suppressed, or a 15-minute schedule rings the same phone " +
          "four times an hour",
      );
    }

    if (expectTicket) {
      const tickets = await opsClient.records<TicketRow>("tickets", 200);
      const wantCodes = o.atRisk.map((a) => a.incidentCode);
      for (const code of wantCodes) {
        check(
          tickets.some((t) => t.title.includes(code)),
          `${asOf} triage: no ticket mentions ${code}, which the oracle says is at risk`,
        );
      }
    }

    if (expectDigest) {
      const chat = await opsClient.records<ChatRow>("chat", 50);
      const latest = chat[0];
      check(Boolean(latest), `${asOf} triage: the digest arm ran and posted nothing`);
      if (latest) {
        check(
          latest.channel === "#it-incidents",
          `${asOf} triage: digest went to ${latest.channel}, not #it-incidents`,
        );
        // ⚠ The team with NOBODY on call must be named. `oncall_now` is a LEFT
        // JOIN precisely so that team appears; a digest listing only the covered
        // teams reads as full coverage.
        for (const team of o.teamsWithNoOnCall) {
          check(
            latest.text.includes(team),
            `${asOf} triage: the digest does not mention ${team}, which has nobody on call — a ` +
              "digest naming only the covered teams reads as full coverage",
          );
        }
      }
    }

    const bad = problems.length - before;
    console.log(
      `  ${bad ? c.bad("✗") : c.ok("✓")} ${c.dim(asOf)} arm ${c.ok(arm.padEnd(7))} ` +
        c.dim(`(${o.breached.length} breached · ${o.atRisk.length} at risk)`) +
        (bad ? c.bad(`  — ${bad} problem(s)`) : ""),
    );
  }

  /**
   * ⚠ THE CONTROL ON EVERY ASSERTION ABOVE.
   *
   * If every instant happened to select the same arm, the block above would pass
   * while proving nothing about the chain — a flow hardwired to that one action
   * would score full marks.
   *
   * ⚠ IT FIRED FOR REAL. The dataset originally carried three instants and they
   * selected only `digest` and `page`: the `ticket` arm was never reached, so
   * every assertion above passed over a flow whose middle arm had never run.
   * `ITOPS_AT_RISK_ONLY_AS_OF` was added for this, and it is two hours before
   * the default rather than a new day — INC-1027 is at 87.5% of its budget there
   * instead of past it.
   */
  check(
    armsSeen.size === 3,
    `the ${ITOPS_AS_OF.length} as-of instants selected only [${[...armsSeen].join(", ")}] — a ` +
      "chain checked against fewer than all three arms is a chain nothing has tested. " +
      "ITOPS_AT_RISK_ONLY_AS_OF exists precisely to reach the middle one",
  );

  // ═══════════════════════════════════════════════════════════════════════
  // Flow 2 — TWO INDEPENDENT GUARDS. Both may fire in one run.
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${"─".repeat(76)}\n${ITOPS_VULN_REMEDIATION.id} ${c.dim("— two independent guards")}\n`);

  let bothFiredSomewhere = false;

  for (const asOf of ITOPS_AS_OF) {
    const o = itopsOracle(asOf);
    const before = problems.length;
    // ⚠ Limit 2000, not 200: the freshness window is `mail.length -
    // mailBefore`, and once the capture table holds 200 rows the capped fetch
    // reports zero new mail after every send. A busy seed history tripped this.
    const mailBefore = (await opsClient.records<MailRow>("mail", 2000)).length;

    const ex = await runDraft(ws.id, vuln.id, { as_of: asOf });
    const settled = ex.state.current === "SUCCESS" || ex.state.current === "WARNING";
    check(settled, `${asOf} vuln: execution settled ${ex.state.current}`);

    const expectPatch = o.proceedingVulns.length > 0;
    const expectAnnounce = o.deferredVulns.length > 0;
    if (expectPatch && expectAnnounce) bothFiredSomewhere = true;

    assertArms(
      `${asOf} vuln`,
      ex,
      [...(expectPatch ? ["patch_tickets"] : []), ...(expectAnnounce ? ["announce"] : [])],
      [...(expectPatch ? [] : ["patch_tickets"]), ...(expectAnnounce ? [] : ["announce"])],
    );

    if (expectAnnounce) {
      const mail = await opsClient.records<MailRow>("mail", 2000);
      const fresh = mail.slice(0, mail.length - mailBefore);
      check(
        fresh.length > 0,
        `${asOf} vuln: the announce arm ran and no mail was sent — a deferral nobody is told ` +
          "about is indistinguishable from there having been nothing to do",
      );
      for (const m of fresh) {
        check(
          m.templateKey === "freeze_deferral_notice",
          `${asOf} vuln: announcement used template ${m.templateKey}, not freeze_deferral_notice`,
        );
      }
    }

    const bad = problems.length - before;
    console.log(
      `  ${bad ? c.bad("✗") : c.ok("✓")} ${c.dim(asOf)} ` +
        `${expectPatch ? c.ok("patch") : c.dim("—    ")} ${expectAnnounce ? c.ok("announce") : c.dim("—       ")} ` +
        c.dim(`(${o.proceedingVulns.length} proceed · ${o.deferredVulns.length} deferred` +
          `${o.activeFreezes.length ? ` · freeze ${o.activeFreezes.join(",")}` : ""})`) +
        (bad ? c.bad(`  — ${bad} problem(s)`) : ""),
    );
  }

  /**
   * ⚠ THE ASSERTION THAT REFUSES THE "TIDY" REWRITE, and it is the reason flow 2
   * exists in this shape.
   *
   * At the middle instant a Payments-scoped freeze defers four findings while
   * eleven elsewhere proceed, so BOTH guards fire in one run. Turning those two
   * branches into an `elseOf` chain compiles, runs green, announces the four and
   * silently never raises the eleven tickets. This is the only check anywhere
   * that would notice.
   */
  check(
    bothFiredSomewhere,
    "no as-of instant had BOTH deferred and proceeding work, so nothing here proves the two " +
      "guards are independent — an elseOf chain would pass every other assertion in this file",
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${"═".repeat(76)}`);
  if (problems.length > 0) {
    console.log(c.bad(`✗ ${problems.length} problem(s):`));
    for (const p of problems) console.log(`  ${c.bad("·")} ${p}`);
    process.exit(1);
  }
  console.log(
    c.ok("✓ the right arm fired at every instant, in both flows") +
      c.dim(`\n  the chain selected all three arms across the ${ITOPS_AS_OF.length} instants; the two guards fired `) +
      c.dim("together where both had work; repeat pages were suppressed\n"),
  );
}

main().catch((e) => {
  // ⚠ Non-zero and NOT a skip. This is the only harness that can catch a wrong
  // branch, and a wrong branch is green everywhere else.
  console.error(c.bad(`\nitops:scenarios-verify could not complete: ${(e as Error).message}\n`));
  console.error(e);
  process.exit(1);
});
