import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { datasourceRepo } from "../repositories/datasource.repo.js";
import { datasourceQueryRepo } from "../repositories/datasource-query.repo.js";
import { workspaceSecretService } from "./workspace-secret.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import {
  exportFlow,
  planImport,
  flowBundleSchema,
  BUNDLE_FORMAT,
  type FlowBundle,
} from "./flow-portability.service.js";
import type { StepContract } from "./step-contract.service.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * Flow export and import — **a shared flow is a recipe, not a binary.**
 * 04 §5.2 · 08 §10 "Phase 6" · phase-6.md 6.2/6.3
 *
 * Two workspaces are provisioned against the real parent database, and the
 * second is deliberately shaped like `hr_demo_alt`: the same tool catalogue, a
 * DIFFERENTLY NAMED datasource, and named queries whose parameter signatures
 * agree in some cases and disagree in others. That is the whole subject — an
 * import is a check against the *importing* tenant, and a fixture where both
 * ends match would pass every assertion here while checking nothing.
 *
 * Runs against the real DB and never touches Kestra. `exportFlow` and
 * `planImport` are pure reads plus validation, and both are deliberately
 * separable from `importFlow` for exactly that reason: the expensive half
 * (generation, deploy) can be skipped while the half that decides whether a flow
 * may travel is tested properly.
 *
 * ── What these tests can and cannot establish ────────────────────────────────
 *
 * They establish that the STRUCTURAL check is right: code does not travel, the
 * contract does, refs are revalidated by name and signature, and a bundle is
 * still client input so the D-22 expression allowlist applies to it.
 *
 * They cannot establish that an imported flow computes the right answer. A query
 * with a matching signature returning rates as a 0–1 fraction where the origin
 * returned 0–100 passes every assertion in this file. `kestra:phase6` measures
 * that, with a negative control, against the alt oracle. Nothing here should be
 * read as covering it.
 */

const reachable = await (async () => {
  try {
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    return true;
  } catch (e) {
    console.warn(`\n[phase6] SKIPPING portability tests — parent DB unreachable: ${(e as Error).message}\n`);
    return false;
  }
})();

const stamp = Date.now();
/** The origin: where the flow is written. */
let originId: string;
/** The destination: same tools, different datasource name, different signatures. */
let destId: string;
let flowId: string;

const FRAGMENT = "def run(payload):\n    return {'ranked': sorted(payload['rows'], key=lambda r: r['x'])}\n";
const RANK_CONTRACT: StepContract = {
  stepId: "rank",
  purpose: "rank rows by shortfall, worst first",
  input: [
    { name: "rows", type: "array", items: "object" },
    { name: "minimum_rate", type: "number", description: "policy minimum, as a percentage 0-100" },
  ],
  output: [
    { name: "ranked", type: "array", items: "object" },
    { name: "worst_shortfall", type: "number" },
  ],
};

const MODEL: FlowModel = {
  id: `port-screening-${stamp}`,
  inputs: [{ id: "period", type: "STRING", required: true }],
  steps: [
    {
      id: "screen",
      kind: "datasource",
      ref: "origin_db.below_threshold",
      paramsExpr: '[{ "period": "{{ inputs.period }}" }]',
    },
    {
      id: "rank",
      kind: "code",
      code: FRAGMENT,
      inputExpr: '{"rows": {{ json(outputs.screen.body).results[0].data }}, "minimum_rate": 85}',
      outputKeys: ["ranked", "worst_shortfall"],
      dependsOn: ["screen"],
    },
    {
      id: "notify",
      kind: "tool",
      ref: "mail_send",
      paramsExpr: "{{ json(outputs.rank.vars.value).ranked }}",
      dependsOn: ["rank"],
    },
  ],
  schedule: { cron: "0 6 * * 1", timezone: "Europe/London" },
};

async function makeWorkspace(name: string) {
  const [ws] = await db
    .insert(workspaces)
    .values({ name, description: "phase-6 portability test; safe to delete" })
    .returning();
  return ws.id;
}

async function makeTool(
  workspaceId: string,
  name: string,
  params: Record<string, { type: string; required: boolean }>,
  secretEnvName: string | null,
) {
  return toolRepo.create({
    workspaceId,
    name,
    url: `http://stub/${name}`,
    method: "POST",
    paramsSchema: params,
    secretEnvName,
  });
}

async function makeQuery(
  workspaceId: string,
  dsName: string,
  queryName: string,
  paramOrder: string[],
  sqlText: string,
) {
  const existing = (await datasourceRepo.listByWorkspace(workspaceId)).find((d) => d.name === dsName);
  const ds =
    existing ??
    (await datasourceRepo.create({
      workspaceId,
      name: dsName,
      type: "postgres",
      connectionStringEnc: "not-a-real-dsn",
      schemaAllowlist: ["public"],
    }));
  return datasourceQueryRepo.upsertByName({
    datasourceId: ds.id,
    name: queryName,
    sqlText,
    paramOrder,
    paramsSchema: Object.fromEntries(
      paramOrder.map((p) => [p, { type: "string", required: true, description: p }]),
    ),
  });
}

beforeAll(async () => {
  if (!reachable) return;

  originId = await makeWorkspace(`port-origin-${stamp}`);
  destId = await makeWorkspace(`port-dest-${stamp}`);

  // ── Origin ────────────────────────────────────────────────────────────────
  await makeTool(originId, "mail_send", { sender: { type: "string", required: true }, recipients: { type: "array", required: true } }, "MAIL_API_KEY");
  // A second tool with a secret the flow does NOT use — the export must not
  // demand its credential.
  await makeTool(originId, "ticket_create", { title: { type: "string", required: true } }, "TICKETING_API_KEY");
  await makeQuery(originId, "origin_db", "below_threshold", ["period"], "SELECT 1 -- origin percentages");
  await workspaceSecretService.create(originId, { name: "MAIL_API_KEY", value: "s3cret-origin-value" });
  await workspaceSecretService.create(originId, { name: "TICKETING_API_KEY", value: "s3cret-ticket-value" });

  // ── Destination: same tools, a differently NAMED datasource, and three
  // queries chosen to exercise each signature outcome.
  await makeTool(destId, "mail_send", { sender: { type: "string", required: true }, recipients: { type: "array", required: true } }, "MAIL_API_KEY");
  // Same signature, different SQL — the correct cross-tenant case. The SQL is
  // exactly what is SUPPOSED to differ, which is why the check is on the
  // signature and not on `refFingerprints`.
  await makeQuery(destId, "dest_db", "below_policy", ["period"], "SELECT 2 -- destination fractions");
  // Requires a parameter the origin flow never sends.
  await makeQuery(destId, "dest_db", "needs_more", ["period", "unit_id"], "SELECT 3");
  // Accepts nothing, so the flow's `period` has nowhere to go.
  await makeQuery(destId, "dest_db", "takes_nothing", [], "SELECT 4");

  // The flow, written into the origin. Rows are inserted directly rather than
  // through `flowService.create`, which deploys to Kestra — export and import
  // planning do not need an engine, and requiring one would make this suite
  // untestable on a laptop.
  const flow = await flowRepo.create({
    workspaceId: originId,
    name: "Attendance screening",
    description: "the flow under test",
    kestraFlowId: MODEL.id,
    draftRevision: 1,
    status: "draft",
  });
  if (!flow) throw new Error("setup: flow insert unexpectedly conflicted");
  flowId = flow.id;
  await flowRepo.insertRevision({
    flowId,
    revision: 1,
    modelJson: MODEL,
    compiledYamlHash: "sha256:test",
    structureHash: "sha256:test",
    createdBy: "author@acme-hr.example",
    // A fixture row inserted directly, so it says what it is: nothing verified
    // this name. archive/GAPS.md §1.2.
    createdByKind: "system",
  });
  await flowRepo.insertSteps(
    MODEL.steps.map((s, i) => ({
      flowId,
      revision: 1,
      stepId: s.id,
      ordinal: i,
      kind: s.kind,
      configJson: s,
      manifestRefsJson: s.kind === "tool" || s.kind === "datasource" ? { [s.ref]: "sha256:x" } : {},
      contractJson: s.id === "rank" ? RANK_CONTRACT : null,
    })),
  );
});

afterAll(async () => {
  if (reachable) {
    for (const id of [originId, destId]) {
      if (id) await db.delete(workspaces).where(eq(workspaces.id, id));
    }
  }
  await pool.end().catch(() => {});
});

// ── Export ───────────────────────────────────────────────────────────────────

describe.skipIf(!reachable)("6.2 export — what travels", () => {
  it("does not carry the generated fragment, anywhere in the bundle", async () => {
    const bundle = await exportFlow(originId, flowId);
    const serialised = JSON.stringify(bundle);
    // Not `toEqual(undefined)` on one field: the claim is that the code is
    // absent from the WHOLE document, which is the only form of the claim that a
    // future field cannot quietly break.
    expect(serialised).not.toContain("def run(");
    expect(serialised).not.toContain("worst_shortfall'");
    expect(serialised).not.toContain("sorted(payload");
  });

  it("carries the CONTRACT instead, which is what makes it regenerable", async () => {
    const bundle = await exportFlow(originId, flowId);
    const step = bundle.model.steps.find((s) => s.id === "rank")!;
    expect(step.kind).toBe("code");
    if (step.kind !== "code") throw new Error("unreachable");
    expect(step.contract.purpose).toBe(RANK_CONTRACT.purpose);
    expect(step.contract.input.map((f) => f.name)).toEqual(["rows", "minimum_rate"]);
    // The unit lives in the contract's description — the fragment obeys it, and
    // it is the only place a travelling recipe can state one.
    expect(step.contract.input[1].description).toMatch(/0-100/);
  });

  it("does not carry outputKeys — they are derived from the contract on arrival", async () => {
    const bundle = await exportFlow(originId, flowId);
    expect(JSON.stringify(bundle)).not.toContain("outputKeys");
  });

  it("contains no Kestra YAML and no engine task type (R8)", async () => {
    const serialised = JSON.stringify(await exportFlow(originId, flowId));
    expect(serialised).not.toContain("io.kestra");
    expect(serialised).not.toContain("tasks:");
    expect(serialised).not.toMatch(/\bnamespace\b/);
  });

  it("carries secret NAMES for the tools it uses, and no values", async () => {
    const bundle = await exportFlow(originId, flowId);
    expect(bundle.secretNames).toEqual(["MAIL_API_KEY"]);
    // The flow never calls `ticket_create`, so demanding its credential would be
    // asking the importing tenant for something it has no business supplying.
    expect(bundle.secretNames).not.toContain("TICKETING_API_KEY");
    expect(JSON.stringify(bundle)).not.toContain("s3cret-origin-value");
  });

  it("records the call signature of every ref it uses, and only those", async () => {
    const bundle = await exportFlow(originId, flowId);
    expect(bundle.refs.map((r) => r.ref).sort()).toEqual(["mail_send", "origin_db.below_threshold"]);
    const query = bundle.refs.find((r) => r.ref === "origin_db.below_threshold")!;
    expect(query.kind).toBe("query");
    expect(query.params.map((p) => p.name)).toEqual(["period"]);
    // The SQL is NOT recorded. It is the thing that is supposed to differ per
    // tenant, and recording it would make the import check fire on every
    // correctly-configured pair.
    expect(JSON.stringify(bundle)).not.toContain("origin percentages");
  });

  it("carries the schedule, which is inert until approved in the importing tenant", async () => {
    const bundle = await exportFlow(originId, flowId);
    expect(bundle.model.schedule?.cron).toBe("0 6 * * 1");
  });

  it("carries no approval, no armed revision and no execution history", async () => {
    const serialised = JSON.stringify(await exportFlow(originId, flowId));
    for (const forbidden of ["armedRevision", "approval", "executions", "flowExecution", "approvedAt"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("refuses to export a hand-written code step, and says why", async () => {
    const [orphan] = await db
      .insert(workspaces)
      .values({ name: `port-orphan-${stamp}`, description: "phase-6; safe to delete" })
      .returning();
    const model: FlowModel = {
      id: `orphan-${stamp}`,
      steps: [
        { id: "compute", kind: "code", code: "def run(payload):\n    return {'x': 1}", inputExpr: "{}", outputKeys: ["x"] },
      ],
    };
    const flow = await flowRepo.create({
      workspaceId: orphan.id,
      name: "hand-written",
      kestraFlowId: model.id,
      draftRevision: 1,
      status: "draft",
    });
    if (!flow) throw new Error("setup: flow insert unexpectedly conflicted");
    await flowRepo.insertRevision({
      flowId: flow.id,
      revision: 1,
      modelJson: model,
      compiledYamlHash: "sha256:t",
      structureHash: "sha256:t",
      createdByKind: "system",
    });
    await flowRepo.insertSteps([
      {
        flowId: flow.id,
        revision: 1,
        stepId: "compute",
        ordinal: 0,
        kind: "code",
        configJson: model.steps[0],
        manifestRefsJson: {},
        contractJson: null, // hand-written: nothing declares what it must do
      },
    ]);

    await expect(exportFlow(orphan.id, flow.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(exportFlow(orphan.id, flow.id)).rejects.toThrow(/no stored contract/i);
    await db.delete(workspaces).where(eq(workspaces.id, orphan.id));
  });

  it("its own output satisfies the schema an importer will apply", async () => {
    const bundle = await exportFlow(originId, flowId);
    expect(flowBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.formatVersion).toBe(BUNDLE_FORMAT);
  });
});

// ── Import planning ──────────────────────────────────────────────────────────

async function bundle(): Promise<FlowBundle> {
  return exportFlow(originId, flowId);
}

const blockingCodes = (findings: Array<{ code: string; blocking: boolean }>) =>
  findings.filter((f) => f.blocking).map((f) => f.code);

describe.skipIf(!reachable)("6.3 import — revalidated against the IMPORTING tenant", () => {
  it("refuses an unknown ref and names what is available instead", async () => {
    const plan = await planImport(destId, await bundle());
    expect(blockingCodes(plan.findings)).toContain("unknown_ref");
    const finding = plan.findings.find((f) => f.code === "unknown_ref")!;
    expect(finding.ref).toBe("origin_db.below_threshold");
    // LLM-consumable per §5.2: the offending thing, the rule, and the facts
    // needed to fix it. A bare "invalid ref" wastes a redraft cycle.
    expect(finding.message).toContain("dest_db.below_policy");
    expect(finding.message).toContain("refMap");
  });

  it("accepts an EXPLICIT remap, and echoes it", async () => {
    const plan = await planImport(destId, await bundle(), {
      "origin_db.below_threshold": "dest_db.below_policy",
    });
    expect(blockingCodes(plan.findings)).toEqual([]);
    expect(plan.remapped).toEqual([
      { from: "origin_db.below_threshold", to: "dest_db.below_policy" },
    ]);
  });

  it("never guesses a remap from a similar name", async () => {
    // `below_threshold` → `below_policy` is a plausible guess, the two queries
    // return different units, and a silently-accepted guess is precisely the
    // failure class this migration exists to remove. Without a refMap it must
    // refuse.
    const plan = await planImport(destId, await bundle());
    expect(plan.remapped).toEqual([]);
    expect(blockingCodes(plan.findings)).toContain("unknown_ref");
  });

  it("refuses a ref that requires a parameter the flow never sends", async () => {
    const plan = await planImport(destId, await bundle(), {
      "origin_db.below_threshold": "dest_db.needs_more",
    });
    expect(blockingCodes(plan.findings)).toContain("param_added");
    expect(plan.findings.find((f) => f.code === "param_added")!.message).toContain("unit_id");
  });

  it("refuses a ref that does not accept a parameter the flow does send", async () => {
    const plan = await planImport(destId, await bundle(), {
      "origin_db.below_threshold": "dest_db.takes_nothing",
    });
    expect(blockingCodes(plan.findings)).toContain("param_removed");
    expect(plan.findings.find((f) => f.code === "param_removed")!.message).toContain("period");
  });

  it("does NOT fire on a matching signature backed by different SQL", async () => {
    // The point of `refInterfaces` existing separately from `refFingerprints`.
    // The destination's query is a different statement against a different
    // schema, and that is the correct cross-tenant configuration.
    const plan = await planImport(destId, await bundle(), {
      "origin_db.below_threshold": "dest_db.below_policy",
    });
    expect(plan.findings).toEqual([]);
    expect(plan.warnings.filter((w) => w.code !== "missing_secret")).toEqual([]);
  });

  it("reports a missing secret as a WARNING, never as a blocker", async () => {
    const plan = await planImport(destId, await bundle(), {
      "origin_db.below_threshold": "dest_db.below_policy",
    });
    const secret = plan.warnings.find((w) => w.code === "missing_secret");
    expect(secret).toBeDefined();
    expect(secret!.message).toContain("MAIL_API_KEY");
    expect(secret!.blocking).toBe(false);
    expect(blockingCodes(plan.findings)).toEqual([]);
  });

  it("refuses re-importing into the origin, because the flow id is taken", async () => {
    const plan = await planImport(originId, await bundle());
    expect(blockingCodes(plan.findings)).toContain("flow_id_taken");
    // And it says what to do rather than renaming silently: two automations
    // differing only by a suffix is how the wrong one gets approved.
    expect(plan.findings.find((f) => f.code === "flow_id_taken")!.message).toContain("modelId");
  });

  it("derives outputKeys from the travelled contract", async () => {
    const plan = await planImport(destId, await bundle(), {
      "origin_db.below_threshold": "dest_db.below_policy",
    });
    const rank = plan.model.steps.find((s) => s.id === "rank")!;
    if (rank.kind !== "code") throw new Error("unreachable");
    expect(rank.outputKeys).toEqual(["ranked", "worst_shortfall"]);
    expect(rank.code).toBe("needs_regeneration");
    expect(plan.contracts.rank.purpose).toBe(RANK_CONTRACT.purpose);
  });

  it("applies the D-22 expression allowlist to a bundle, because a bundle IS client input", async () => {
    const b = await bundle();
    const tainted: FlowBundle = {
      ...b,
      model: {
        ...b.model,
        steps: b.model.steps.map((s) =>
          s.id === "notify" && s.kind === "tool"
            ? { ...s, paramsExpr: `[{ "key": "{{ secret('FOUNDRY_CALLBACK') }}" }]` }
            : s,
        ),
      },
    };
    const plan = await planImport(destId, tainted, {
      "origin_db.below_threshold": "dest_db.below_policy",
    });
    expect(blockingCodes(plan.findings)).toContain("expression_rejected");
    expect(plan.findings.find((f) => f.code === "expression_rejected")!.message).toContain("secret");
  });

  it("drops a `code` body smuggled into a bundle rather than honouring it", async () => {
    // A bundle is a document, and a document can say anything. The bundled step
    // schema has no `code` field, so zod strips it — the fragment is regenerated
    // from the contract here, and the origin tenant's build never runs.
    const b = await bundle();
    const smuggled = JSON.parse(JSON.stringify(b));
    smuggled.model.steps.find((s: { id: string }) => s.id === "rank").code = "def run(payload):\n    return {'ranked': [], 'worst_shortfall': 0}";
    const reparsed = flowBundleSchema.parse(smuggled);
    expect(JSON.stringify(reparsed)).not.toContain("def run(");

    const plan = await planImport(destId, smuggled, {
      "origin_db.below_threshold": "dest_db.below_policy",
    });
    const rank = plan.model.steps.find((s) => s.id === "rank")!;
    if (rank.kind !== "code") throw new Error("unreachable");
    expect(rank.code).toBe("needs_regeneration");
  });

  it("rejects a bundle from a future format version rather than guessing", async () => {
    const b = await bundle();
    expect(flowBundleSchema.safeParse({ ...b, formatVersion: 2 }).success).toBe(false);
  });
});
