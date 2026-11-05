/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PAUSING A DATA SOURCE — "stop showing this to the model", and nothing else
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Asked for beside a delete button: *"a pause button … invisible for pause so
 * the llm doesn't see it"*. Two actions, two meanings, and the whole value is
 * that they are different — delete forgets the credential and the discovered
 * schema and breaks every step written against it; pause changes what the model
 * is TOLD and changes nothing that runs.
 *
 * ── ⚠ WHAT PAUSE DOES NOT DO, AND EVERY LINE OF IT IS LOAD-BEARING ──────────
 *
 * It must not touch any of these, and each one would be a different bug:
 *
 *   * **`refFingerprints()`.** A fingerprint change means STALE: it routes
 *     through `checkStaleness` → `markStale` → `status: "suspended"`, which
 *     unarms the flow and REMOVES ITS KESTRA SCHEDULE. Dropping a paused
 *     datasource's readers from that map would make a "pause" button silently
 *     turn off every armed automation in the workspace that reads it, and
 *     report the reason as *"referenced refs no longer exist"* — which is not
 *     what happened. Pause is an authoring control; a kill switch is a
 *     different feature and would have to say so.
 *   * **`refInterfaces()` / `checkFlowRefs`'s available refs.** Those decide
 *     whether a saved flow is VALID. Filtering there would mean an existing
 *     flow that reads the paused source stops saving — a person who paused a
 *     source to stop the drafter reaching for it would find their unrelated
 *     edits refused, naming a ref they can see in the step.
 *   * **Execution** (`resolveRef`, `runNamedQuery`, `runOperation`). A paused
 *     source keeps serving the flows already built on it. Stopping mid-flight
 *     is what revoking an approval or deleting the source is for.
 *
 * What it DOES change is every place a model is handed a list: the manifest's
 * `<datasources>` block (which is most of a generation prompt), the CALLABLE
 * STEPS catalogue the drafter and every chat turn are given, and the
 * "DATASOURCES WITH NO READER YET" block that offers to build one.
 *
 * ⚠ **The manifest's own hash moves, and that is correct and safe.** What the
 * agent is told genuinely changed, so a new manifest version is the honest
 * record — and the manifest hash is not a ref fingerprint, so no armed flow
 * moves. That is exactly the check I-40 had to make before rendering parameter
 * descriptions, and `manifest-fingerprint.test.ts` is where it is pinned.
 *
 * ── Why `resource_status`, and why ONE value of it ──────────────────────────
 *
 * `RESOURCE_STATUSES` has carried `"paused"` since the resource work, it is
 * already PATCHable through `updateDatasourceSchema`, already indexed, and
 * already renders as a badge — and **nothing anywhere read it**. So this gives
 * an existing decorative state its meaning rather than adding a second one
 * beside it; a `paused_at` column would have left two answers to "is this
 * paused" that can disagree.
 *
 * ⚠ **`"paused"` alone, deliberately — not `archived` or `deprecated`.**
 * Those are lifecycle words a person may already be using for their own
 * bookkeeping on rows nobody meant to hide, and silently hiding a datasource
 * from every prompt because somebody labelled it is the failure mode this
 * module is trying to avoid in the other direction. `statusFromLegacy` in
 * `resource.service.ts` can never produce `"paused"`, so there is no derived
 * path into this state either: it is set by a person, through one PATCH.
 */

/** The one `resource_status` value that hides a datasource from the model. */
export const DATASOURCE_PAUSED_STATUS = "paused";

/**
 * Is this datasource hidden from everything the model is shown?
 *
 * Structural on purpose — the callers hold rows from four different repos and
 * three different shapes, and every one of them carries `resourceStatus`.
 */
export function isPausedFromModel(ds: { resourceStatus?: string | null } | null | undefined): boolean {
  return ds?.resourceStatus === DATASOURCE_PAUSED_STATUS;
}

/**
 * Keep the rows whose datasource the model may still be told about.
 *
 * ⚠ Takes a row and a way to reach its datasource rather than the datasource
 * itself, because the three call sites hold a datasource, a `{query,
 * datasource}` pair and an `{operation, datasource}` pair. One filter, three
 * shapes — a second copy per shape is how one of them silently stops matching.
 */
export function modelVisible<T>(rows: T[], datasourceOf: (row: T) => { resourceStatus?: string | null }): T[] {
  return rows.filter((row) => !isPausedFromModel(datasourceOf(row)));
}
