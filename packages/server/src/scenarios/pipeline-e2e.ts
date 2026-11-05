/**
 * `pipeline-e2e` — a combinator pipeline through the REAL write funnel, compiler and engine (compiled-builder 2d).
 *
 *   scripts/harness-in-net.sh packages/server/src/scenarios/pipeline-e2e.ts
 *
 * In HR (a tuned workspace; the held-out one is sealed): read `hr_demo.attendance_below_threshold` (now DESCRIBED, so its
 * rows are typed), then a transform whose PIPELINE filters, templates and joins. `writeRevision` lowers the pipeline; the
 * compiler emits it; a draft run executes it. The proof: the transform's ACTUAL output equals the evaluator applied to the
 * read step's ACTUAL output — real rows, not fixtures. Two periods, one of them empty. The flow is deleted afterwards.
 * No model calls.
 */
import { evaluatePipeline, engineEqual, withContext, type Pipeline } from "@foundry/flow-edit";
import { flowService } from "../services/flow.service.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { systemAuthor } from "../services/revision-author.js";
import { runDraft } from "./kestra-draft-run.js";
import type { FlowModel } from "../services/flow-compiler.service.js";

const PIPELINE: Pipeline = [
  // ⚠ Every column of this described query is Option: its SQL has an outer join, so 2b types all columns nullable (sound,
  // conservative). The pipeline must say what null means for each field it sorts or prints — here, "skip the row".
  { op: "filter", where: { and: [{ notNull: "work_email" }, { notNull: "attendance_rate" }, { notNull: "full_name" }, { notNull: "department_code" }] } },
  { op: "sort", by: "attendance_rate", dir: "asc" },
  { op: "join_text", as: "text", parts: [{ text: "- " }, { field: "full_name" }, { text: " (" }, { field: "department_code" }, { text: ")" }], sep: "\n", empty: "Nothing to report." },
];

/** A NON-empty case: every threshold row, sorted, classified with a case, and joined. */
const PIPELINE_2: Pipeline = [
  { op: "filter", where: { and: [{ notNull: "department_code" }, { notNull: "min_attendance_rate" }] } },
  { op: "sort", by: "min_attendance_rate", dir: "desc" },
  { op: "derive", as: "band", expr: { case: [{ when: { cmp: "ge", left: { field: "min_attendance_rate" }, right: { lit: { value: 80, from: "test" } } }, then: { lit: { value: "strict", from: "test" } } }], else: { lit: { value: "lenient", from: "test" } } } },
  { op: "join_text", as: "text", parts: [{ field: "department_code" }, { text: ": " }, { field: "band" }], sep: " | ", empty: "none" },
];

const model: FlowModel = {
  id: "pipeline-e2e",
  inputs: [{ id: "period", type: "STRING", required: true }],
  steps: [
    { id: "read", kind: "datasource", ref: "hr_demo.attendance_below_threshold", inputs: [{ name: "period", source: { from: "input", inputId: "period" } }] },
    { id: "digest", kind: "transform", from: "read", pipeline: PIPELINE, expr: "", dependsOn: ["read"] },
    { id: "read_policy", kind: "datasource", ref: "hr_demo.policy_thresholds", paramsExpr: "[{}]" },
    { id: "bands", kind: "transform", from: "read_policy", pipeline: PIPELINE_2, expr: "", dependsOn: ["read_policy"] },
  ],
  output: { stepId: "digest" },
} as unknown as FlowModel;

const hr = (await workspaceRepo.list()).find((w: { name: string; deletedAt: unknown }) => w.name === "HR" && !w.deletedAt);
if (!hr) throw new Error("no HR workspace");
const created = await flowService.create(hr.id, { name: `pipeline-e2e ${Date.now()}`, model, author: systemAuthor("pipeline-e2e") } as never);
const flowId = (created as { flow: { id: string } }).flow.id;
let failures = 0;
try {
  const stored = (created as { revision: { modelJson: { steps: Array<{ id: string; expr?: string; pipeline?: unknown }> } } }).revision.modelJson;
  const digest = stored.steps.find((s) => s.id === "digest")!;
  console.log(`stored: pipeline kept ${Array.isArray(digest.pipeline)} · lowered expr ${digest.expr?.slice(0, 90)}…`);
  if (!Array.isArray(digest.pipeline) || !digest.expr) failures++;
  for (const period of ["2026-06", "2026-04"]) {
    const ex = await runDraft(hr.id, flowId, { period }, 180_000);
    const tr = (id: string) => ex.taskRunList?.find((t: { taskId: string }) => t.taskId === id) as { outputs?: { body?: string; value?: string } } | undefined;
    const readBody = tr("read")?.outputs?.body;
    const rows = readBody ? (JSON.parse(readBody) as { results: Array<{ data: unknown[] }> }).results[0]!.data : null;
    for (const [readId, stepId, p] of [["read", "digest", PIPELINE], ["read_policy", "bands", PIPELINE_2]] as const) {
      const body = tr(readId)?.outputs?.body;
      const inRows = body ? (JSON.parse(body) as { results: Array<{ data: unknown[] }> }).results[0]!.data : null;
      const raw = tr(stepId)?.outputs?.value;
      const actual = raw === undefined ? undefined : raw === "" ? null : JSON.parse(raw);
      const expected = inRows ? withContext({}, () => evaluatePipeline(inRows, p as Pipeline)) : undefined;
      const ok = ex.state.current === "SUCCESS" && engineEqual(actual, expected);
      console.log(`period ${period} · ${stepId}: run ${ex.state.current} · ${inRows?.length ?? "?"} rows read · ${ok ? "AGREE" : "DISAGREE"}\n   engine    ${JSON.stringify(actual)?.slice(0, 220)}\n   evaluator ${JSON.stringify(expected)?.slice(0, 220)}`);
      if (!ok) failures++;
    }
    void rows;
  }
} finally {
  await flowService.remove(hr.id, flowId).catch((e: Error) => console.log(`cleanup: ${e.message}`));
  const left = (await flowRepo.listByWorkspace(hr.id)).filter((f: { name: string }) => f.name.startsWith("pipeline-e2e")).length;
  console.log(`flows left: ${left}`);
}
process.exit(failures ? 1 : 0);
