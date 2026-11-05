/**
 * **Did this run read the data the oracle describes?**
 *
 * ── ⚠ Why an oracle-scoring harness has to ask ──────────────────────────────
 *
 * An oracle is the right answer computed from a dataset DEFINITION — never from
 * a query result — and that is the whole of its value. `expectedScreening()`,
 * `financeOracle()`, `legalOracle()` and `itopsOracle()` are separate functions
 * for the same reason: a shared oracle lets a shared bug produce a wrong answer
 * that agrees with itself.
 *
 * Every harness that scores a flow runs it with `flowService.testRun`, which is
 * a DRAFT run — and a draft run reads the datasource's SANDBOX whenever one
 * exists (D-52: the namespace decides, and nothing in a request can change it).
 * While no product workspace had a sandbox those were the same corpus, so no
 * harness ever had to ask. On 2026-09-17 seven datasources got one and the two
 * came apart silently: the run reads generated rows, the oracle still describes
 * the real ones.
 *
 * ⚠ **Scoring across that gap is the EXACT defect these harnesses exist to
 * catch.** The measurement they were built for is a script that hardcoded a
 * period, emailed 0 of 11 people, exited 0 with `tests_passed=true` and an audit
 * verdict of `clean` — every check that existed said yes, and only an oracle
 * said no. An oracle compared against data it does not describe is that same
 * confident verdict over an answer nobody checked. Today it would fail rather
 * than falsely pass, which is luck about which way the numbers fall.
 *
 * ⚠ **It ABORTS, it does not fail a check.** A red check reads as "the product
 * is broken"; this is "the harness cannot answer", and those call for opposite
 * actions. Same rule as `signals`' third exit code and `unevaluable` not
 * satisfying gate 1 — "unhealthy" and "I could not find out" must not wear one
 * face (D-66).
 *
 * ⚠ **`kestra:sandbox` must NEVER call this.** Its entire subject is that a
 * draft run reads fixtures; asserting the opposite there would refuse the
 * behaviour under test.
 *
 * ⚠ `read_from` is PERSISTED per step run rather than derived from the
 * datasource's current state (D-53), so this reads what the run actually did,
 * not what the datasource looks like now — which is why it stays correct when
 * somebody provisions a sandbox afterwards.
 */
import { flowExecutionRepo, flowStepRunRepo } from "../repositories/flow-execution.repo.js";
import type { ReadFrom } from "../services/sandbox.service.js";

/**
 * The only corpus an oracle describes.
 *
 * ⚠ **Typed as `ReadFrom` on purpose.** The first version of this gate filtered
 * for `readFrom === "sandbox"` — a string I assumed rather than read — and the
 * real union is `"sandbox" | "production" | "mock"`. Every step on this
 * deployment stamps **`"mock"`**, so the gate matched nothing and
 * `scenarios:verify` scored a fixture-backed run anyway, reporting "sent 0,
 * oracle mailable 13" as three red checks that looked like product defects.
 * That is the failure it was written to prevent, committed by the thing
 * preventing it.
 *
 * ⚠ **And the unit test agreed with the bug**, because it used the same assumed
 * string — the exact shape this repo keeps warning about, where one definition
 * shared by the code and its test produces a wrong answer that agrees with
 * itself. Only RUNNING it found this.
 */
const SCORABLE_CORPUS: ReadFrom = "production";

export type CorpusVerdict =
  | { scorable: true }
  | { scorable: false; fixtureSteps: string[]; message: string };

/**
 * Whether a settled execution may be scored against an oracle.
 *
 * ⚠ Call it only once the execution has SETTLED. `read_from` is stamped at
 * step-callback time, so an earlier read sees no step runs, finds no fixtures
 * and returns `scorable` over nothing — a check that cannot fail (I-38).
 *
 * An execution with no recorded step runs is reported SCORABLE, deliberately:
 * the run's own assertions are what should speak about a flow that produced no
 * steps, and aborting here would replace a specific failure with a vague one.
 */
export async function corpusOf(
  kestraExecutionId: string,
  datasourceHint: string,
): Promise<CorpusVerdict> {
  const execution = await flowExecutionRepo.getByKestraId(kestraExecutionId);
  if (!execution) return { scorable: true };
  const steps = await flowStepRunRepo.listByExecution(execution.id);
  /**
   * ⚠ **Require production; never enumerate the corpora that are not.** An
   * allowlist of one is fail-closed: a fourth `ReadFrom` member added later is
   * refused until somebody decides about it, where a `!== "sandbox" && !==
   * "mock"` denylist would wave it through silently. That is the direction the
   * mistake above went, and the shape that cannot repeat it.
   *
   * ⚠ `null` is NOT a finding. Every `tool`, `transform` and `approval` step
   * records null because it reads no datasource, so treating null as unknown
   * would abort every run on its own mail step.
   */
  const fixtures = steps.filter((s) => s.readFrom != null && s.readFrom !== SCORABLE_CORPUS);
  if (!fixtures.length) return { scorable: true };

  const fixtureSteps = [...new Set(fixtures.map((f) => f.stepId))];
  return {
    scorable: false,
    fixtureSteps,
    message:
      `this run read GENERATED DATA, not the real dataset.\n` +
      `  ${fixtures.length} step(s) read ${[...new Set(fixtures.map((f) => f.readFrom))].join("/")}: ` +
      `${fixtureSteps.join(", ")}\n\n` +
      `  The oracle is computed from the real dataset, so scoring this run would\n` +
      `  compare an expected answer against rows it does not describe — a\n` +
      `  confident verdict over an answer nobody checked, which is the failure\n` +
      `  this harness exists to catch.\n\n` +
      `  Nothing is broken. A draft run reads a datasource's sandbox whenever one\n` +
      `  exists and nothing in a request can change that. Either remove it:\n\n` +
      // ⚠ RESOLVED, never a `<placeholder>`. The execution row carries the
      // workspace, so there is no excuse for a template somebody copies
      // verbatim — the mistake this repo already recorded twice, once in a
      // prompt that emitted a literal `<reader you need>` ref and once in the
      // abandoned-build reason, five commits ago.
      `    pnpm --filter @foundry/server sandbox:teardown \\\n` +
      `      --workspace=${execution.workspaceId} --datasource=${datasourceHint}\n\n` +
      `  or score these flows against a corpus the oracle describes.`,
  };
}

/**
 * `corpusOf`, and exit 2 when it says no.
 *
 * ⚠ **Exit 2, not 1.** `signals` already gives that code the meaning "I could
 * not find out", as against 1 for "something is wrong" — and a CI job that
 * treats a harness which declined to answer as a product failure is how this
 * check gets deleted the first time it fires.
 */
export async function abortUnlessScorable(
  kestraExecutionId: string,
  datasourceHint: string,
): Promise<void> {
  const verdict = await corpusOf(kestraExecutionId, datasourceHint);
  if (verdict.scorable) return;
  console.error(`\n\x1b[31m  ABORTED — ${verdict.message}\x1b[0m\n`);
  process.exit(2);
}
