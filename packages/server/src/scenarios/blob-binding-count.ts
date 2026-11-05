/**
 * I-204 — how common is a step whose hand-written blob (`paramsExpr` /
 * `inputExpr`) disagrees with its typed `inputs`? COUNTS ONLY.
 *
 * ⚠ Prints no model text, no step id, no flow name and no value: one
 * workspace (Recruitment) reads a real tenant database, and a blob can carry
 * a literal copied from it. Reads `flow_revisions.model_json` only; writes
 * nothing anywhere.
 *
 * Uses the same `blobDisagreement` the checker emits FT0206 from, with the
 * same compiler render the server snapshot injects — so the count is what
 * the gate would refuse, not a second estimate of it.
 */
import { sql } from "drizzle-orm";
import { blobDisagreement, isBlankFeed, type CatalogueSnapshot, type CheckStep } from "@foundry/flow-edit";
import { db, pool } from "../db/index.js";
import { displayCodeInput, displayParams, type FlowStep } from "../services/flow-compiler.service.js";

// CONTROL: every both-forms step gets its null sources filled with a literal
// no blob carries, so every one MUST disagree. Without it a detector that
// never fires scores "0 disagreements" (I-38).
const control = process.argv.includes("--control");

const cat: CatalogueSnapshot = {
  refs: {},
  renderInputs: (step, steps) => {
    const all = steps as unknown as FlowStep[];
    if (step.kind === "code") return displayCodeInput(step as never, all);
    return displayParams(step as never, all);
  },
};

const res = await db.execute(sql`
  select r.flow_id, r.revision, r.model_json,
         r.revision = max(r.revision) over (partition by r.flow_id) as latest
  from flow_revisions r join flows f on f.id = r.flow_id`);
const rows = (res as unknown as { rows: Array<{ flow_id: string; model_json: { steps?: CheckStep[] }; latest: boolean }> }).rows;

type Tally = { steps: number; blobOnly: number; both: number; partial: number; agree: number; disagree: number; unrenderable: number; flows: Set<string> };
const fresh = (): Tally => ({ steps: 0, blobOnly: 0, both: 0, partial: 0, agree: 0, disagree: 0, unrenderable: 0, flows: new Set() });
const all = fresh();
const latest = fresh();

for (const r of rows) {
  const steps = r.model_json?.steps ?? [];
  for (const s of steps) {
    const field = s.kind === "code" ? "inputExpr" : ["tool", "datasource", "query"].includes(s.kind) ? "paramsExpr" : null;
    if (!field) continue;
    const blob = s[field] as string | undefined;
    let bindings = s.inputs ?? [];
    if (control && bindings.length && !isBlankFeed(blob)) {
      bindings = bindings.map((b) => (b.source ? b : { ...b, source: { from: "literal", value: "__control__" } }));
      (s as CheckStep).inputs = bindings;
    }
    for (const t of r.latest ? [all, latest] : [all]) {
      t.steps++;
      if (isBlankFeed(blob)) continue;
      if (!bindings.length) { t.blobOnly++; continue; }
      t.both++;
      if (bindings.some((b) => !b.source)) { t.partial++; continue; }
      let d;
      try { d = blobDisagreement(s, steps, cat); } catch { d = null; }
      if (d) { t.disagree++; t.flows.add(r.flow_id); continue; }
      // Agreement or unrenderable: distinguish with the render alone.
      const stripped = { ...s }; delete stripped[field];
      let rendered: string | null = null;
      try { rendered = cat.renderInputs!(stripped, steps); } catch { rendered = null; }
      if (rendered === null) t.unrenderable++;
      else t.agree++;
    }
  }
}

const line = (name: string, t: Tally) =>
  `${name}: ${t.steps} call/code steps · blob-only ${t.blobOnly} (FT0602) · both forms ${t.both} → ` +
  `agree ${t.agree} · DISAGREE ${t.disagree} (FT0206, in ${t.flows.size} flows) · partial (null source) ${t.partial} · bindings unrenderable ${t.unrenderable}`;
console.log(`revisions scanned: ${rows.length}`);
console.log(line("all revisions   ", all));
console.log(line("latest per flow ", latest));
if (control) {
  const ok = all.both > 0 && all.disagree === all.both;
  console.log(`CONTROL: ${all.disagree} of ${all.both} both-forms steps disagree under perturbation — ${ok ? "the count can fire" : "⚠ INCONCLUSIVE"}`);
  await pool.end();
  process.exit(ok ? 0 : 3);
}
await pool.end();
