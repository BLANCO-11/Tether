/**
 * **A MEASUREMENT, not a gate** — `pnpm --filter @foundry/server fingerprint:measure`.
 *
 * *Does creating a DB operation move any existing ref fingerprint, in any
 * workspace on this deployment?*  (proposed-db-operations FR-015 / SC-003, T17a)
 *
 * ── Why this is taken rather than reasoned about ─────────────────────────────
 *
 * ⚠ **THIS IS I-40'S CHECK, REPEATED FOR THE REASON IT WAS INVENTED.** When the
 * manifest gained per-parameter descriptions, the question that made the change
 * safe was not *"does it work"* — it was *"does any existing ref fingerprint
 * move"*, measured at **0 across all workspaces**. Because if one moves, the
 * staleness sweep **unarms every armed flow in every workspace** on the next poll
 * tick, and the reason it shows is *"a referenced tool or datasource query
 * changed shape"* — which is not true, and which nobody can act on.
 *
 * The measurement is cheap. The failure mode is a deployment where nothing is
 * armed any more and the audit trail says the components changed shape.
 *
 * ── What it does, and the one thing it deliberately does NOT do ──────────────
 *
 * **It writes nothing.** Not a row, not a manifest version, not an approval.
 *
 * The property splits cleanly in two, and each half is established where it can
 * be established honestly:
 *
 *  1. *"Creating an operation adds exactly one key and moves no other."*  This
 *     is a property of `refFingerprints`' loop — each ref is hashed
 *     independently — and it does not vary with a workspace's data. It is pinned
 *     by `manifest-fingerprint.test.ts`'s `FR-015` block, **with two controls
 *     proving those fingerprints can move at all**, and it is proven to fail:
 *     folding a workspace-global count into the tool payload turns it red.
 *  2. *"Adding a key moves no armed flow's aggregate fingerprint."*  This is the
 *     half that CAN vary — it depends on each flow's real ref list and each
 *     workspace's real rows — so it is measured here, over every workspace and
 *     every armed flow, against the real `aggregateFingerprint`.
 *
 * ⚠ **The probe is a synthetic KEY, not a created row**, and that is what makes
 * this non-destructive without weakening it. `aggregateFingerprint(refs, map)` is
 * a pure function of the fingerprint map, so appending
 * `<datasource>.__fingerprint_probe__` to the map is byte-for-byte the state the
 * database would be in after a create — given (1), which is pinned with controls.
 * Creating a real operation in a workspace holding armed flows to measure whether
 * creating one unarms them is a test that damages the thing it is testing when it
 * fails, which is the one shape a measurement must not have.
 *
 * It also reports, per armed flow, whether it is **already stale** — the
 * recomputed aggregate against the one its approval stored. That is the number
 * the sweep acts on, so a non-zero count here is a finding regardless of this
 * feature.
 *
 * ⚠ **Exits non-zero only if it could not run, or if a probe moved something.**
 * A count is a number to read; `signals`' ranking is the precedent —
 * *"unhealthy"* and *"I could not find out"* need different answers.
 */
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { manifestBuilderService } from "../services/manifest-builder.service.js";
import { flowCompiler, type FlowModel } from "../services/flow-compiler.service.js";

/**
 * The probe's operation name.
 *
 * ⚠ **This is a legal operation name** — `dbOperationBodySchema` allows a leading
 * underscore — so non-collision is CHECKED below rather than asserted here. A
 * probe key that overwrote a real ref would replace a real fingerprint with
 * `sha256:probe`, and the aggregate would move for a reason that has nothing to
 * do with what is being measured.
 */
const PROBE = "__fingerprint_probe__";

type WorkspaceReport = {
  workspace: string;
  id: string;
  refs: number;
  operations: number;
  armed: number;
  /** Armed flows whose aggregate moved when a new operation key was added. */
  moved: string[];
  /** Armed flows the sweep would suspend RIGHT NOW, before any probe. */
  alreadyStale: string[];
  /** A fingerprint that differed between two reads of the same rows. */
  unstable: string[];
};

async function main() {
  const workspaces = await workspaceRepo.list();
  if (workspaces.length === 0) {
    console.error("no workspaces on this deployment — nothing to measure");
    process.exit(2);
  }

  const reports: WorkspaceReport[] = [];
  let totalArmed = 0;
  let totalProbes = 0;

  for (const ws of workspaces) {
    const r: WorkspaceReport = {
      workspace: ws.name,
      id: ws.id,
      refs: 0,
      operations: 0,
      armed: 0,
      moved: [],
      alreadyStale: [],
      unstable: [],
    };

    const current = await manifestBuilderService.refFingerprints(ws.id);
    r.refs = Object.keys(current).length;

    // ── the I-40 hazard itself, on real rows ────────────────────────────────
    //
    // `params_schema` and `spec_json` are jsonb and Postgres does not preserve
    // insertion order. A fingerprint built with a plain JSON.stringify moves on
    // a RE-READ and suspends every schedule referencing the row, reporting a
    // change that never happened. `canonical()` is what prevents it; this is the
    // check that it is actually preventing it against this deployment's data
    // rather than against a fixture.
    const again = await manifestBuilderService.refFingerprints(ws.id);
    for (const [k, v] of Object.entries(current)) {
      if (again[k] !== v) r.unstable.push(k);
    }

    const datasources = await datasourceRepo.listByWorkspace(ws.id);
    // ⚠ Counted from the REPO, not by prefixing keys with a datasource name. A
    // named query is keyed `<datasource>.<query>` too, so the prefix version
    // counts queries as operations — a column labelled `ops` reading 5 for a
    // workspace with 5 queries and 0 operations, which is the kind of number
    // somebody quotes.
    r.operations = (await dbOperationRepo.listByWorkspace(ws.id)).length;

    // The probe key sits on a real datasource where there is one, so the shape
    // is exactly a new `<datasource>.<operation>` ref rather than a bare name.
    const probeKey = `${datasources[0]?.name ?? "probe_ds"}.${PROBE}`;
    if (probeKey in current) {
      // Refuse rather than measure. Overwriting a real ref's fingerprint with
      // `sha256:probe` would move the aggregate for a reason that is an artefact
      // of this script, and it would look exactly like a real finding.
      console.error(`could not measure: "${probeKey}" already exists in ${ws.name}`);
      process.exit(2);
    }
    const withNewOperation = { ...current, [probeKey]: "sha256:probe" };

    const flows = await flowRepo.listByWorkspace(ws.id);
    for (const flow of flows) {
      if (flow.armedRevision == null) continue;
      r.armed++;
      totalArmed++;
      const revision = await flowRepo.getRevision(flow.id, flow.armedRevision);
      if (!revision) continue;
      const refs = flowCompiler.refsOf(revision.modelJson as FlowModel);

      const before = manifestBuilderService.aggregateFingerprint(refs, current);
      const after = manifestBuilderService.aggregateFingerprint(refs, withNewOperation);
      totalProbes++;
      if (after !== before) r.moved.push(flow.name);

      const approval = await flowRepo.currentApproval(flow.id, flow.armedRevision);
      if (approval && approval.manifestFingerprint !== before) r.alreadyStale.push(flow.name);
    }

    reports.push(r);
  }

  // ── the report ──────────────────────────────────────────────────────────────
  console.log("\nFR-015 / SC-003 — does creating a DB operation move an existing ref fingerprint?");
  console.log("(read-only: no row, no manifest version, no approval was written)\n");
  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(
    `${w("workspace", 34)} ${w("refs", 6)} ${w("ops", 5)} ${w("armed", 6)} ${w("moved", 6)} ${w("stale now", 10)} unstable`,
  );
  for (const r of reports) {
    console.log(
      `${w(r.workspace, 34)} ${w(String(r.refs), 6)} ${w(String(r.operations), 5)} ` +
        `${w(String(r.armed), 6)} ${w(String(r.moved.length), 6)} ` +
        `${w(String(r.alreadyStale.length), 10)} ${r.unstable.length}`,
    );
  }

  const moved = reports.flatMap((r) => r.moved.map((f) => `${r.workspace}/${f}`));
  const stale = reports.flatMap((r) => r.alreadyStale.map((f) => `${r.workspace}/${f}`));
  const unstable = reports.flatMap((r) => r.unstable.map((k) => `${r.workspace}/${k}`));

  console.log(
    `\n${reports.length} workspace(s) · ${reports.reduce((n, r) => n + r.refs, 0)} ref(s) · ` +
      `${totalArmed} armed flow(s) · ${totalProbes} probe(s)`,
  );
  console.log(`ref fingerprints that moved when an operation key was added: ${moved.length}`);
  console.log(`fingerprints that differed between two reads:               ${unstable.length}`);
  console.log(`armed flows the sweep would suspend right now:              ${stale.length}`);

  // ⚠ **A measurement over zero armed flows proves nothing** and must not read
  // as a pass. T17a says so in as many words: run it where there is something to
  // lose. This is I-38 — a control that cannot fail is worse than none — and
  // `backup-verify.sh`'s INCONCLUSIVE verdict is the precedent for saying so
  // out loud rather than exiting 0 over an empty set.
  if (totalArmed === 0) {
    console.error(
      "\nINCONCLUSIVE — no armed flow anywhere on this deployment, so there was nothing to " +
        "unarm and '0 moved' is a statement about an empty set. Arm a flow and re-run.",
    );
    process.exit(2);
  }

  if (moved.length > 0) {
    console.error(`\nFAIL — adding an operation moved these flows' aggregates:\n  ${moved.join("\n  ")}`);
    console.error("Do NOT create an operation in these workspaces: the sweep will unarm them.");
    process.exit(1);
  }
  if (unstable.length > 0) {
    console.error(`\nFAIL — these fingerprints are not stable across two reads:\n  ${unstable.join("\n  ")}`);
    process.exit(1);
  }

  console.log("\nPASS — 0 moved, across every workspace and every armed flow.");
  if (stale.length > 0) {
    // Reported, not failed: a flow already stale is a finding about the
    // deployment, not about this feature, and rolling it into this exit code
    // would make the number unreadable.
    console.log(`⚠ ${stale.length} armed flow(s) are ALREADY stale, unrelated to this measurement:`);
    for (const f of stale) console.log(`   ${f}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`could not measure: ${(e as Error).message}`);
  process.exit(2);
});
