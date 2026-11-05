/**
 * `StepError` — an error carrying the HTTP status the route must surface verbatim.
 *
 * ── Why this is its own module ────────────────────────────────────────────────
 *
 * It lived in `step-execution.service.ts`, which is the module `tool-invoke.ts`
 * was extracted OUT of (tool-probe plan Decision 1). The dial has to throw this
 * class, and importing it from the service would give the service and the dial a
 * cycle: the service imports the dial to make its calls, and the dial imports the
 * service for one error class. ESM tolerates that until a field initialiser runs
 * during the cycle, and then it fails at boot with a message naming neither
 * module. Splitting the class out costs one file and removes the possibility.
 *
 * ⚠ **`step-execution.service.ts` re-exports it**, so every existing importer
 * (`routes/steps.ts`, `agent-run.service.ts`, and two test files) is untouched —
 * this is a move, not an API change. New code should import it from here.
 *
 * The `status` is the whole point of the class: a step failure that has a right
 * answer for the caller (409 for a shadowed secret, 424 for a credential that was
 * declared and never stored, 502 when every item failed) must not be flattened
 * into a 500 by the last-resort handler, and the alternative — returning status
 * codes in a result object through five call sites — is how one of them ends up
 * ignoring it.
 */
export class StepError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "StepError";
  }
}
