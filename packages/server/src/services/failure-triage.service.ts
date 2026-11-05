/**
 * Failure triage — the §6.9 classification table, as one function.
 * archive/kestra-migration/06-failure-triage.md §6.8 · §6.9 · §6.10
 *
 * ── Why this is a table and not a judgement ──────────────────────────────────
 *
 * §6.9 opens with *"triage must be mechanical, not a judgement call"*, and the
 * reason is the ladder's most expensive mistake: sending a CREDENTIAL failure to
 * the LLM. A 401 has no code fix, so three regenerations produce three variants
 * of correct code, all of which 401, and the user is finally told "step 3 failed
 * after 3 attempts" instead of "update `TICKETING_API_KEY`". Every row that
 * routes to `user` below exists to make that impossible rather than unlikely.
 *
 * ── The escalation that matters ──────────────────────────────────────────────
 *
 * **Repeated failure of one step is the boundary-error signature.** No amount of
 * regenerating a fragment fixes a step whose declared inputs are insufficient,
 * so the third level-1 failure stops being "bad code" and becomes "bad
 * decomposition" — a flow redraft, not a fourth attempt. That transition is the
 * only place in the design where the SAME signal means different things
 * depending on history, which is why `attempt` is a column on `flow_step_runs`
 * and not a variable somewhere.
 */

/** What went wrong, mechanically. Stored on `flow_step_runs.failure_class`. */
export type FailureClass =
  /** The generator refused: its contract cannot be satisfied (§6.7). */
  | "insufficient_contract"
  /** Wrong output shape, or a throw on a declared input. */
  | "contract_violation"
  /** Exceeded its time or memory bound. */
  | "resource_exhausted"
  /** A step returned more than the output cap allows (04 §5.3.2). */
  | "output_too_large"
  /** 401 / 403 from a tool — the key is wrong, absent or unauthorised. */
  | "credential"
  /** 404, or a response missing manifest-declared fields — the tool moved. */
  | "tool_changed"
  /** Datasource unreachable, or `InsufficientPrivilege` on the read-only role. */
  | "infrastructure"
  /** 429. */
  | "rate_limited"
  /** Ran clean; the oracle disagrees with the values. */
  | "oracle_mismatch"
  /** Classification failed. Routed to the user, never to the LLM — see below. */
  | "unknown";

/** Who acts next. Stored on `flow_step_runs.triage_route`. */
export type TriageRoute =
  /** Level 0 — the LLM redrafts the FLOW; the boundary is wrong. */
  | "flow_redraft"
  /** Level 1 — the LLM regenerates THIS fragment only. Max 3. */
  | "fragment_regenerate"
  /** Retry as-is; nothing needs rewriting. */
  | "retry"
  /** The user, with a specific instruction. No code fix exists. */
  | "user"
  /** A human or an oracle judges the values. */
  | "review";

export interface TriageVerdict {
  failureClass: FailureClass;
  route: TriageRoute;
  /** 0–3, matching §6.8's ladder. `null` for routes that are not on it. */
  level: 0 | 1 | 2 | 3 | null;
  /**
   * What the USER is told (§6.10). Never "step 3 failed" — it names the cause
   * and the action, and it is written even for LLM-routed classes so a human
   * reading the run has the same sentence the ladder acted on.
   */
  message: string;
  /** True when the same signal also suspends the flow's approval (§6.5). */
  suspendsApproval: boolean;
}

export interface TriageInput {
  stepId: string;
  kind: string;
  /** How many times THIS step has already been regenerated. 0 on first failure. */
  attempt: number;
  /** HTTP status from a `tool` step, when there was one. */
  httpStatus?: number | null;
  /** The step's error text — a Python traceback, a driver message, a step API body. */
  error?: string | null;
  /** Set by the fragment wrapper via the output marker. */
  wrapperFailureClass?: string | null;
  /** The generator refused at author time. Short-circuits everything else. */
  refused?: boolean;
  /** A tool response was missing fields the manifest declares. */
  missingResponseFields?: string[];
  /** The step ran clean and an oracle disagrees. */
  oracleMismatch?: { expected: unknown; actual: unknown } | null;
}

/** §6.8: three level-1 attempts, then the boundary is the suspect, not the code. */
export const MAX_FRAGMENT_ATTEMPTS = 3;

const RE = {
  privilege: /permission denied|insufficientprivilege|read-only|must be owner/i,
  unreachable: /econnrefused|enotfound|etimedout|connection refused|could not connect|getaddrinfo/i,
  timeout: /timed out|timeout|deadline exceeded|killed|sigkill|out of memory|memoryerror/i,
  keyError: /\bKeyError\b|\bTypeError\b|\bIndexError\b|\bAttributeError\b/,
};

/**
 * Classify one step failure and decide who acts next.
 *
 * Order matters and is not alphabetical. Author-time refusal first, because it
 * is the only signal that arrives before anything ran. Then the signals that
 * route AWAY from the LLM — credential, tool shape, infrastructure — ahead of
 * the ones that route to it, so that a 401 whose body happens to contain the
 * word `TypeError` cannot be read as bad code.
 */
export function triage(input: TriageInput): TriageVerdict {
  const err = input.error ?? "";
  const step = input.stepId;

  // ── Level 0 — the generator refused (§6.7) ─────────────────────────────────
  if (input.refused || input.wrapperFailureClass === "insufficient_contract") {
    return {
      failureClass: "insufficient_contract",
      route: "flow_redraft",
      level: 0,
      // §6.10's phrasing: the fix, not the symptom.
      message:
        `Step \`${step}\` needs something no earlier step provides. ` +
        `Add it as a flow input, or add a step that resolves it.`,
      suspendsApproval: false,
    };
  }

  // ── Straight to the user — no code fix exists ──────────────────────────────
  //
  // These come first so that a message body containing a Python-looking word
  // cannot pull a credential failure onto the regeneration ladder.
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return {
      failureClass: "credential",
      route: "user",
      level: null,
      message:
        `\`${step}\` was rejected by the tool it calls (HTTP ${input.httpStatus}). ` +
        `Check the workspace secret it uses — GET /api/workspaces/:ws/secrets/audit lists what is configured.`,
      suspendsApproval: false,
    };
  }

  if (input.missingResponseFields?.length) {
    // §6.9's third-from-last row: a tool changing shape is ALSO §6.5's staleness
    // condition. One signal, two consequences — the user is told which field
    // disappeared, and the schedule stops until they act (assertion 36).
    return {
      failureClass: "tool_changed",
      route: "user",
      level: null,
      message:
        `\`${step}\` no longer returns ${input.missingResponseFields.map((f) => `\`${f}\``).join(", ")}. ` +
        `Re-introspect the tool; this flow's approval is suspended until you do.`,
      suspendsApproval: true,
    };
  }

  if (input.httpStatus === 404) {
    return {
      failureClass: "tool_changed",
      route: "user",
      level: null,
      message:
        `\`${step}\` called an endpoint that no longer exists (HTTP 404). ` +
        `Re-introspect the tool; this flow's approval is suspended until you do.`,
      suspendsApproval: true,
    };
  }

  if (input.httpStatus === 429) {
    return {
      failureClass: "rate_limited",
      route: "retry",
      level: null,
      message: `\`${step}\` was rate-limited. It will be retried; if it persists, the tool's quota needs raising.`,
      suspendsApproval: false,
    };
  }

  if (RE.privilege.test(err)) {
    // The expected shape of a script trying to write through `foundry_ro`. Say
    // so, or it reads as a broken connection or a missing secret.
    return {
      failureClass: "infrastructure",
      route: "user",
      level: null,
      message:
        `\`${step}\` was refused by the database. The datasource credential is read-only by design, ` +
        `so a write cannot succeed — the step needs to be a tool call, not a query.`,
      suspendsApproval: false,
    };
  }

  if (RE.unreachable.test(err)) {
    return {
      failureClass: "infrastructure",
      route: "user",
      level: null,
      message: `\`${step}\` could not reach the system it depends on. This is connectivity, not the automation.`,
      suspendsApproval: false,
    };
  }

  // ── The oracle disagrees, having passed everything mechanical (§6.11) ──────
  if (input.oracleMismatch) {
    return {
      failureClass: "oracle_mismatch",
      route: "review",
      level: null,
      message:
        `The flow ran successfully but \`${step}\` produced ` +
        `${JSON.stringify(input.oracleMismatch.actual)} where ` +
        `${JSON.stringify(input.oracleMismatch.expected)} was expected. Review that step.`,
      suspendsApproval: false,
    };
  }

  if (input.wrapperFailureClass === "output_too_large") {
    return {
      failureClass: "output_too_large",
      route: "flow_redraft",
      level: 0,
      // Not a fragment bug — the step is carrying too much, which is a
      // decomposition problem. Regenerating it would produce the same volume.
      message:
        `\`${step}\` returned more data than a step may carry. ` +
        `Split it, or aggregate earlier in the flow.`,
      suspendsApproval: false,
    };
  }

  // ── The LLM's ladder ───────────────────────────────────────────────────────
  const isCodeFault =
    input.wrapperFailureClass === "contract_violation" ||
    RE.keyError.test(err) ||
    RE.timeout.test(err);

  if (isCodeFault) {
    const failureClass: FailureClass = RE.timeout.test(err) ? "resource_exhausted" : "contract_violation";
    if (input.attempt + 1 >= MAX_FRAGMENT_ATTEMPTS) {
      // Level 2. THE escalation: three failures of one step is the signature of
      // insufficient inputs, and a fourth regeneration cannot fix that.
      return {
        failureClass,
        route: "flow_redraft",
        level: 2,
        message:
          `\`${step}\` failed ${input.attempt + 1} times. That is a sign its inputs are insufficient ` +
          `rather than its code being wrong, so the flow's step boundaries are being redrafted.`,
        suspendsApproval: false,
      };
    }
    return {
      failureClass,
      route: "fragment_regenerate",
      level: 1,
      message:
        `\`${step}\` did not satisfy its contract (attempt ${input.attempt + 1} of ${MAX_FRAGMENT_ATTEMPTS}). ` +
        `Regenerating that step only; the rest of the flow is unaffected.`,
      suspendsApproval: false,
    };
  }

  // ── Unclassified ───────────────────────────────────────────────────────────
  //
  // Routed to the USER, deliberately. The tempting default is "try the LLM, it
  // might fix it", and it is wrong for the same reason the credential rows
  // exist: an unclassified failure is one nobody has a model of, so spending
  // three regenerations on it produces three variants of the same unknown and a
  // worse message at the end. A route of last resort must be the one that ends
  // with a human reading the error.
  return {
    failureClass: "unknown",
    route: "user",
    level: 3,
    message:
      `\`${step}\` failed in a way Foundry could not classify` +
      (err ? `: ${err.slice(0, 300)}` : ".") +
      ` The run's step detail has the full error.`,
    suspendsApproval: false,
  };
}

export const failureTriageService = { triage, MAX_FRAGMENT_ATTEMPTS };
