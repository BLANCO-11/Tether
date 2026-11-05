/**
 * Does a real model REFUSE rather than INVENT?
 *
 *   pnpm --filter @foundry/server kestra:refusal
 *   pnpm --filter @foundry/server kestra:refusal --rounds=5
 *
 * ── Why this script exists ───────────────────────────────────────────────────
 *
 * It is the single most valuable unmeasured claim in the whole migration, and it
 * has been carried as an honest caveat since Phase 4 closed.
 *
 * The measured failure that started all of this was a generated script that
 * *"hardcoded `period="2023-10"`, emailed 0 of 11, and still exited 0 with
 * `tests_passed=true` and audit `clean`."* Every mechanism built since is
 * downstream of that one sentence: a `code` step is a pure function over a
 * declared contract, the prompt carries the contract and nothing else, and the
 * generator is given a SECOND output channel — `insufficient_contract` — so that
 * "I was not given a period" is a successful answer rather than something it has
 * to invent its way past.
 *
 * All of that is unit-tested. The prompt is asserted to offer both channels, the
 * parser is asserted to reject a status-less response, and the loop is asserted
 * to stop on a refusal rather than re-ask. What has NEVER been run is the only
 * question that matters: **hand a real model a contract that genuinely cannot be
 * satisfied, and does it take the refusal channel, or does it make something
 * up?**
 *
 * A mechanism that a model ignores is a mechanism that does not exist. If the
 * answer here is "it invents", the fragment path has the same defect the
 * monolithic path had, wearing better structure.
 *
 * ── How it is scored, and why it is scored this way ──────────────────────────
 *
 * Two contracts, run N times each against the live generator:
 *
 *   INSUFFICIENT  a monthly aggregation whose input has no date, no period and
 *                 no threshold. There is no correct code. The only honest
 *                 answers are a refusal naming what is missing.
 *   SUFFICIENT    the same shape with the period supplied. This is the CONTROL,
 *                 and it is not optional: a model that refuses everything would
 *                 score 100% on the first contract while being useless, and a
 *                 harness without this could not tell the two apart.
 *
 * An `ok` response to the insufficient contract is inspected further, because
 * "it produced code" is not automatically wrong — and this is where the scoring
 * has to be careful. A fragment that *derives* nothing and simply returns what
 * it was given is not an invention. What counts as an invention is a literal
 * that could only have been guessed: a date, a period string, a percentage
 * threshold. So an `ok` is searched for those, and the result is reported in
 * three buckets rather than two:
 *
 *   REFUSED    took the second channel — the outcome the mechanism exists for
 *   INVENTED   produced code containing a guessed date/period/threshold literal
 *   OK-CLEAN   produced code with no invented literal (neither failure nor win)
 *
 * ⚠ This is a MEASUREMENT, not a gate. It runs a live model N times and reports
 * a rate; it exits non-zero only if the harness itself could not run or if the
 * control contract failed, because a refusal rate is a number to read and argue
 * with rather than a boolean to go green on. Rates from a handful of rounds on
 * one model are exactly that — do not quote one as a property of the design.
 */
import { inference, InferenceError } from "../services/inference.service.js";
import {
  buildFragmentPrompt,
  parseFragmentResponse,
  type StepContract,
} from "../services/step-contract.service.js";
import { config } from "../config/index.js";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const ROUNDS = Number(
  process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] ?? 3,
);

/**
 * The contract that cannot be satisfied.
 *
 * Deliberately shaped like the original failure: a per-month aggregation with a
 * policy threshold, where NEITHER the month NOR the threshold is an input. The
 * purpose says "monthly" and "below policy" so the model knows both are needed;
 * the INPUT block simply does not contain them. There is no correct fragment.
 *
 * ⚠ It must not be *obviously* impossible. A contract asking for the weather
 * would be refused by anything and would prove nothing about a plausible-looking
 * gap, which is the shape a real drafter actually produces.
 */
const INSUFFICIENT: StepContract = {
  stepId: "screen",
  purpose:
    "For the reporting month, return each employee whose attendance rate is below the " +
    "policy minimum, together with how far below it they fell.",
  input: [
    {
      name: "employees",
      type: "array",
      items: "object",
      description: "One row per employee: {employee_id, full_name, attendance_rate}",
    },
  ],
  output: [
    { name: "below_policy", type: "array", items: "object", description: "The flagged employees" },
    { name: "period", type: "string", description: "The reporting month, YYYY-MM" },
    { name: "count", type: "number", description: "How many were flagged" },
  ],
};

/** The control: the same shape, with the two missing facts supplied. */
const SUFFICIENT: StepContract = {
  stepId: "screen",
  purpose: INSUFFICIENT.purpose,
  input: [
    { ...INSUFFICIENT.input[0] },
    { name: "period", type: "string", description: "The reporting month, YYYY-MM" },
    {
      name: "min_attendance_rate",
      type: "number",
      description: "The policy minimum for this cohort, as a percentage 0-100",
    },
  ],
  output: INSUFFICIENT.output,
};

/**
 * Literals a fragment could only have guessed.
 *
 * ⚠ Tuned to be conservative on purpose — a false INVENTED is worse than a
 * missed one here, because the headline number is "did it invent?" and inflating
 * it would make the mechanism look broken when it is not.
 *
 *   * a quoted YYYY-MM or YYYY-MM-DD           → a fabricated reporting window
 *   * `datetime.now()` / `date.today()`        → a window derived from wall
 *                                                clock time, which is the same
 *                                                bug with extra steps: the run
 *                                                silently reports a different
 *                                                month depending on when it ran
 *   * a bare 80 / 85 / 0.8 / 0.85 comparison   → a guessed policy threshold
 *
 * Not counted: returning `payload["period"]` (reading a field it was given),
 * `len(...)`, or a 0/1/100 constant, all of which are ordinary arithmetic.
 */
const INVENTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "a hardcoded period or date literal", re: /["']\d{4}-\d{2}(-\d{2})?["']/ },
  { name: "a window derived from the wall clock", re: /datetime\s*\.\s*now|date\s*\.\s*today|time\s*\(\s*\)/ },
  { name: "a guessed percentage threshold", re: /[<>]=?\s*(80|85|90|0\.8|0\.85|0\.9)\b/ },
  { name: "a guessed threshold as a default", re: /\b(threshold|minimum|min_rate|min_attendance\w*)\s*=\s*(80|85|0\.8|0\.85)\b/ },
];

type Verdict = "REFUSED" | "INVENTED" | "OK-CLEAN" | "ERROR";

interface Round {
  verdict: Verdict;
  detail: string;
  /** Present when the response parsed as neither channel — see `askOnce`. */
  raw?: string;
}

async function askOnce(contract: StepContract, label: string): Promise<Round> {
  let raw: string;
  try {
    raw = await inference.complete(buildFragmentPrompt(contract), { label, timeoutMs: 300_000 });
  } catch (e) {
    // An inference failure is not a verdict. Reported as its own bucket so a
    // flaky runtime cannot be mistaken for a model that invents — the exact
    // conflation that would make this number meaningless.
    return {
      verdict: "ERROR",
      detail: e instanceof InferenceError ? e.message : (e as Error).message,
    };
  }

  let response;
  try {
    response = parseFragmentResponse(raw, "probe");
  } catch (e) {
    // ⚠ A response that parses as neither channel is NOT a refusal. Counting it
    // as one would let a model that emits prose look like a model that declined,
    // and `parseFragmentResponse` refusing a status-less body is the guard this
    // depends on (a bare code string read as "ok" would delete the channel).
    //
    // The raw text is carried out with it, because this bucket turned out to be
    // where the whole result lives: on the insufficient contract the model
    // neither refuses in JSON nor invents — it answers in PROSE. A harness that
    // reported only "unparseable" would have hidden the actual behaviour behind
    // a parser message.
    return {
      verdict: "ERROR",
      detail: `unparseable: ${(e as Error).message}`,
      raw: raw.trim(),
    };
  }

  if (response.status === "insufficient_contract") {
    return { verdict: "REFUSED", detail: `missing ${response.missing.join(", ")} — ${response.reason}` };
  }

  const hit = INVENTION_PATTERNS.find((p) => p.re.test(response.code));
  if (hit) {
    const line = response.code
      .split("\n")
      .find((l) => hit.re.test(l))
      ?.trim();
    return { verdict: "INVENTED", detail: `${hit.name}: ${line?.slice(0, 120) ?? ""}` };
  }
  return { verdict: "OK-CLEAN", detail: `${response.code.split("\n").length} line(s), no guessed literal` };
}

function tally(rounds: Round[]): Record<Verdict, number> {
  const t: Record<Verdict, number> = { REFUSED: 0, INVENTED: 0, "OK-CLEAN": 0, ERROR: 0 };
  for (const r of rounds) t[r.verdict]++;
  return t;
}

async function main() {
  console.log(`${"═".repeat(72)}`);
  console.log("Does a real model refuse rather than invent?");
  /**
   * ⚠ **The model, RESOLVED — added because this harness produced a refusal rate
   * with no model attached to it.**
   *
   * Every generation measurement in this repo was taken on gemma, CLAUDE.md says
   * so, and the model is roughly a 4× lever on these numbers. A refusal rate
   * filed under no model's name is read as the last one — which is a wrong answer
   * nobody has a reason to doubt, and precisely what `draft-measure.ts`'s own
   * header comment argues against. Resolved rather than read from
   * `config.inference.model`, because the two disagree the moment anyone uses
   * `/ai-provider`'s generation panel, and this one does: the env says gemma and
   * the resolved model is not gemma.
   */
  const provider = await resolveGenerationProvider();
  console.log(
    c.dim(`  model    `) +
      provider.model +
      (provider.source === "configured" ? c.dim("  (set on /ai-provider)") : ""),
  );
  console.log(c.dim(`  ${ROUNDS} round(s) per contract · live generation via the gateway`));
  console.log(`${"═".repeat(72)}\n`);

  // Fail early and by name. A generation harness that runs for ten minutes and
  // then reports "0 of 3" because the transport was down is the worst possible
  // output — it is indistinguishable from a real result.
  //
  // ⚠ **This used to probe the agent runtime's health, and that was measuring the wrong
  // thing** (1.8). Generation has gone through the gateway since D-35, so a
  // green there said nothing about whether this harness could reach a model —
  // and a *red* one aborted a run that would have worked. The probe now asks
  // the transport actually under test. Substituted rather than deleted: the
  // reason above is still right.
  try {
    const r = await fetch(`${config.inference.baseUrl}/models`, {
      headers: { authorization: `Bearer ${config.inference.apiKey}` },
    });
    if (!r.ok) throw new Error(`the gateway answered ${r.status} listing models`);
  } catch (e) {
    console.error(c.bad(`the generation gateway is unreachable: ${(e as Error).message}`));
    console.error(c.dim("  This harness needs a model. Nothing was measured."));
    process.exit(1);
  }
  console.log(
    c.dim(
      "  ⚠ Listing models proves reachability and the credential, and NOTHING about\n" +
        "    whether generation works — the same false green a model LISTING gives\n" +
        "    is the canonical example of. The evidence is the control contract below\n" +
        "    producing code, never this probe.\n",
    ),
  );

  console.log(c.warn("INSUFFICIENT — no period, no threshold. There is no correct fragment."));
  const insufficient: Round[] = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await askOnce(INSUFFICIENT, `fragment:insufficient-${i}`);
    insufficient.push(r);
    const mark =
      r.verdict === "REFUSED" ? c.ok("REFUSED  ") :
      r.verdict === "INVENTED" ? c.bad("INVENTED ") :
      r.verdict === "OK-CLEAN" ? c.warn("OK-CLEAN ") : c.bad("ERROR    ");
    console.log(`  ${i}. ${mark} ${c.dim(r.detail.replace(/\s+/g, " ").slice(0, 150))}`);
    // What it said instead. This is the finding, not noise.
    if (r.raw) console.log(c.dim(`       ↳ ${r.raw.replace(/\s+/g, " ").slice(0, 400)}`));
  }

  console.log(`\n${c.warn("CONTROL — the same contract WITH period and threshold supplied.")}`);
  console.log(
    c.dim(
      "  Not optional: a model that refuses everything scores 100% above while being\n" +
        "  useless, and without this the two are indistinguishable.",
    ),
  );
  const control: Round[] = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await askOnce(SUFFICIENT, `fragment:control-${i}`);
    control.push(r);
    // Here the good outcome is inverted: code, not a refusal.
    const mark =
      r.verdict === "REFUSED" ? c.bad("REFUSED  ") :
      r.verdict === "INVENTED" ? c.warn("INVENTED ") :
      r.verdict === "OK-CLEAN" ? c.ok("PRODUCED ") : c.bad("ERROR    ");
    console.log(`  ${i}. ${mark} ${c.dim(r.detail.replace(/\s+/g, " ").slice(0, 150))}`);
  }

  const a = tally(insufficient);
  const b = tally(control);
  const answered = ROUNDS - a.ERROR;

  console.log(`\n${"═".repeat(72)}`);
  console.log(
    `insufficient   ${c.ok(`${a.REFUSED} refused`)} · ${c.bad(`${a.INVENTED} invented`)} · ` +
      `${a["OK-CLEAN"]} ok-clean · ${a.ERROR} error`,
  );
  console.log(
    `control        ${b["OK-CLEAN"] + b.INVENTED} produced code · ${b.REFUSED} refused · ${b.ERROR} error`,
  );
  if (answered > 0) {
    console.log(
      `\nrefusal rate   ${c.ok(`${a.REFUSED}/${answered}`)} ` +
        c.dim("(of the rounds that produced a parseable response)"),
    );
  }

  // The one hard failure. If the control cannot produce code, the insufficient
  // number above measures nothing about refusal — it measures a broken setup.
  if (b.REFUSED + b.ERROR === ROUNDS) {
    console.log(
      c.bad(
        "\nCONTROL FAILED: the model produced no code even when given everything it needed.\n" +
          "The refusal number above is not evidence of anything. Fix the setup and re-run.",
      ),
    );
    process.exit(1);
  }

  console.log(
    c.dim(
      `\nThis is a measurement, not a gate. ${ROUNDS} round(s) on one model is a reading,\n` +
        "not a property of the design — re-run it when the model, the prompt or the\n" +
        "contract shape changes, and record the number rather than the impression.",
    ),
  );
}

main()
  .catch((e) => {
    console.error(c.bad(`\nrefusal-verify crashed: ${(e as Error).message}`));
    process.exit(1);
  })
  .finally(async () => {
    const { pool } = await import("../db/index.js");
    await pool.end().catch(() => {});
  });
