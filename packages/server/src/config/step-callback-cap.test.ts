/**
 * The cap LADDER — step-payload-bounds, plan Decision 1 and
 * `contracts/step-callback-limit.md` §1.
 *
 * ── What this file is actually defending, and why it is a test ───────────────
 *
 * Decision 1's requirement is not the number 5,242,880. It is an ORDERING: the
 * step-callback cap must sit above every per-parameter cap in the product, so
 * that a payload too large for the TOOL it is addressed to is refused by that
 * tool, with its own specific sentence, rather than by the transport with four
 * words. Execution `05aca859-…` is the record of the ordering being wrong: a
 * 2 MB transport cap fired where ops-api's *"input is 7,539,026 characters; the
 * limit is 32,000"* was waiting two hops downstream.
 *
 * An ordering that lives only in a docblock is one somebody lowers during an
 * incident to "make the errors stop", and the cost of getting it wrong is
 * SILENT: every specific refusal in the product simply becomes unreachable, and
 * every oversize payload — whatever its real cause — collapses into the same
 * generic message again. Nothing else in the suite would notice, because every
 * individual refusal still works when tested on its own.
 *
 * ⚠ The margin asserted is `>= 8×` the mail cap, which is what the contract
 * requires — NOT the ~20× this default happens to have. Asserting the actual
 * ratio would turn every deliberate retune into a red test, which is how a test
 * gets deleted rather than read.
 */
import { describe, it, expect } from "vitest";
import { config } from "./index.js";

/**
 * ops-api's `OPS_LLM_MAX_INPUT_CHARS`, the tightest cap in the ladder.
 *
 * ⚠ Duplicated as a literal rather than imported: it lives in
 * `packages/ops-api/src/config.ts` and `@foundry/server` has no dependency on
 * that package — deliberately, since ops-api is a service across a port and not
 * a library (D-33). One character is one byte at worst for this comparison's
 * purpose, and the assertion is an inequality with three orders of magnitude of
 * headroom, so the duplication cannot drift into a false pass.
 */
const OPS_LLM_MAX_INPUT_CHARS = 32_000;

describe("the step-callback cap sits ABOVE every per-parameter cap", () => {
  it("clears the mail body cap by the margin the contract requires", () => {
    expect(config.steps.callbackMaxBytes).toBeGreaterThanOrEqual(8 * config.mail.maxBodyBytes);
  });

  it("clears the llm_complete input cap, so ops-api's 422 is always reachable", () => {
    // The 422 is the sentence this whole feature exists to stop swallowing.
    expect(config.steps.callbackMaxBytes).toBeGreaterThan(OPS_LLM_MAX_INPUT_CHARS * 4);
  });

  /**
   * ⚠ THE RUNG THIS FEATURE ALMOST MISSED. Raising Foundry's cap only moves the
   * refusal downstream — it does not make the specific one reachable unless
   * ops-api will *read* what Foundry now forwards. It would not: its parser was
   * 1 MB and its last-resort handler answered body-parser's 413 as
   * `500 internal`, so every input between 1 MB and 5 MB got a message saying
   * the fault was ours. Fixed in `packages/ops-api` (route-scoped parser at
   * `OPS_LLM_MAX_BODY_BYTES`, and a real 413), and pinned from both sides —
   * `packages/ops-api/src/llm-body-cap.test.ts` holds the other half.
   *
   * ⚠ Raising `STEP_CALLBACK_MAX_BYTES` past `OPS_LLM_MAX_BODY_BYTES` reopens the
   * hole SILENTLY: the only symptom is a 413 where a 422 belonged.
   */
  it("does not exceed what ops-api will read, or the 422 is unreachable again", () => {
    // Literal for the same reason ops-api mirrors ours: no dependency between
    // the two packages, deliberately (D-33).
    const OPS_LLM_MAX_BODY_BYTES = 5_242_880;
    expect(config.steps.callbackMaxBytes).toBeLessThanOrEqual(OPS_LLM_MAX_BODY_BYTES);
  });

  it("is above the process-wide 2 MB limit, or it would bind nothing", () => {
    // A callback cap at or below the app-wide parser is a no-op with a docblock.
    expect(config.steps.callbackMaxBytes).toBeGreaterThan(2 * 1024 * 1024);
  });

  /**
   * ⚠ The reported incident stays refused, deliberately (plan Decision 1). This
   * is pinned as an assertion because the tempting "fix" during the next
   * incident is to raise the cap until a replay gets through, and that inverts
   * the design: the run is made to succeed by reducing the payload upstream, not
   * by widening the transport.
   */
  it("does NOT admit the 8,401,233-byte body from execution 05aca859-…", () => {
    expect(config.steps.callbackMaxBytes).toBeLessThan(8_401_233);
  });
});

describe("the tool-response warn threshold", () => {
  it("is well below the callback cap — it is a remark, not a bound", () => {
    expect(config.tools.responseWarnBytes).toBeLessThan(config.steps.callbackMaxBytes);
  });

  /**
   * The measured payload has to actually trip it, or the warning that exists to
   * describe this incident would not have fired on this incident.
   */
  it("would have fired on the 7.19 MiB response that caused this feature", () => {
    expect(7_539_026).toBeGreaterThan(config.tools.responseWarnBytes);
  });
});
