/**
 * **Which cron does this automation actually fire on?** — 2026-09-17
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * A flow's cron lives on its MODEL, never in a `triggers` row (D-18) and never
 * as a column on `flows` — so the flows list route, which spreads the `flows`
 * row onto the wire, had no way to send one and never did. Six surfaces in
 * `packages/client` read `FlowSummary.schedule`: the list's Schedule column,
 * `/flows/[id]`'s Details row, `/live`, the dashboard's scheduled section,
 * `ApprovalPanel`'s Schedule stat, and `VIEWS.scheduled`'s predicate. All six
 * read `undefined`, so **every workflow on every screen said "Not scheduled"
 * whatever its cron was, and the Scheduled tab could never match a flow.**
 *
 * The flows page's own comment calls the value *"real, from the armed
 * revision's model (D-18)"* — a consumer written against a producer nobody
 * built. That is I-120's shape from the other end, and it is why the two rules
 * below are a module with tests rather than an expression inside the query:
 * the SQL is where a rule stops being readable, and *which* revision answers
 * this is the part somebody will get wrong.
 */

/**
 * The revision whose schedule is the live answer.
 *
 * ⚠ **The ARMED one when a flow is armed, never the draft.** What fires is the
 * approved revision; a draft edited on top of it changes nothing that runs
 * until somebody publishes (§6.5). Reading the draft would print a cron on a
 * flow that fires on a different one — the same class of lie as showing a
 * revoked flow as live.
 *
 * ⚠ **The draft's when nothing is armed**, because then there is no live
 * answer and the draft's cron is what publishing would deploy. Every surface
 * that shows it also shows `status`/`armedRevision`, and `isRunningUnattended`
 * is what decides whether it is firing — so "carries a cron" and "fires on it"
 * stay separable. Returning `null` here instead would make a flow somebody just
 * scheduled read as unscheduled right up to the moment they published it.
 *
 * `null` when there is no revision at all — a flow created and never written.
 */
export function firingRevisionOf(flow: {
  armedRevision: number | null;
  draftRevision: number;
}): number | null {
  const revision = flow.armedRevision ?? flow.draftRevision;
  return revision >= 1 ? revision : null;
}

/**
 * A model's cron, or `null`.
 *
 * ⚠ **A blank string is `null`, not `""`.** Every reader asks `(schedule ??
 * "").trim() !== ""`, so an empty string is already "no schedule" to them — but
 * it reaches `describeCron`, which has nothing to say about it, and it would
 * make `schedule: ""` and `schedule: null` two spellings of one answer on the
 * wire. One answer, one spelling.
 */
export function cronOfModel(modelJson: unknown): string | null {
  const schedule = (modelJson as { schedule?: { cron?: unknown } } | null | undefined)?.schedule;
  const cron = schedule && typeof schedule.cron === "string" ? schedule.cron.trim() : "";
  return cron || null;
}
