/**
 * M12 — the builder at scale (compiled-builder phase 5 task 8). NO model calls: everything here is code the builder runs, on
 * catalogues 1×, 10× and 100× the size of the largest real workspace. Recorded per scale:
 *  - the understanding call's STRICT SCHEMA: its total enum values (the gateway refuses more than 1000 — measured in
 *    shape-tuned-r1, where 18 of 42 builds were refused before the model saw them) and its size;
 *  - the prompt's size (the catalogue is listed in it);
 *  - the solver's time over the saved tuned specs (p50 / p90), and the legal-move enumeration's (`optionsOf`) time.
 * A scaled catalogue is the real one copied k times under suffixed refs (`<ref>__k`), so its shape is a real workspace's.
 *
 *   pnpm --filter @foundry/server exec tsx src/scenarios/builder-scale.ts <tuned-rows.json> [--live]
 *
 * `--live` (MODEL CALLS — about 4 per goal): for the largest workspaces' saved tuned goals, the current builder understands each at
 * 1× (the control), and the narrowing call picks from the catalogue at 10×; recorded is whether it KEPT every component the 1×
 * spec used (narrowing recall), and its time.
 * Tuned goals only — never a held-out set.
 *
 * ⚠ A MEASUREMENT: it exits non-zero only if it could not run. `main()` runs at import — never import this from a test.
 */
import { readFileSync } from "node:fs";
import { emptyFlow, optionsOf, type CatalogueSnapshot } from "@foundry/flow-edit";
import { builderCatalogue, modelChooser, understand } from "../services/builder/builder.service.js";
import { KEEP_MAX, narrowCatalogue } from "../services/builder/narrow.js";
import { goalSpecPrompt, goalSpecSchema, type BuilderCatalogue, type CheckedSpec } from "../services/builder/goal-spec.js";
import { solve } from "../services/builder/solver.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";

const GATEWAY_ENUM_LIMIT = 1000;
const rowsPath = process.argv[2];
if (!rowsPath) { console.error("usage: builder-scale.ts <tuned-rows.json>"); process.exit(2); }
const live = process.argv.includes("--live");
const rows = (JSON.parse(readFileSync(rowsPath, "utf8")) as { rows: Array<{ id: string; workspace: string; goal: string; spec: CheckedSpec["spec"]; dropped?: CheckedSpec["dropped"] }> }).rows;

/** Every enum value in a JSON schema, summed. */
const enumCount = (s: unknown): number => {
  if (!s || typeof s !== "object") return 0;
  let n = Array.isArray((s as { enum?: unknown[] }).enum) ? (s as { enum: unknown[] }).enum.length : 0;
  for (const v of Object.values(s as Record<string, unknown>)) if (v && typeof v === "object") n += enumCount(v);
  return n;
};
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };
const ms = (f: () => void) => { const t = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t) / 1e6; };

/** The catalogue copied k times: the original refs, plus `<ref>__i` for i in 2..k (so the saved specs still resolve). */
function scaled(items: BuilderCatalogue, cat: CatalogueSnapshot, k: number): { items: BuilderCatalogue; cat: CatalogueSnapshot } {
  if (k === 1) return { items, cat };
  const outItems = [...items.items], refs = { ...cat.refs };
  for (let i = 2; i <= k; i++) {
    for (const it of items.items) outItems.push({ ...it, ref: `${it.ref}__${i}` });
    for (const [r, sig] of Object.entries(cat.refs)) refs[`${r}__${i}`] = sig;
  }
  return { items: { ...items, items: outItems }, cat: { ...cat, refs } };
}

const workspaces = new Map((await workspaceRepo.list()).map((w) => [w.name, w.id]));
const real: Array<{ name: string; items: BuilderCatalogue; cat: CatalogueSnapshot }> = [];
for (const name of [...new Set(rows.map((r) => r.workspace))]) {
  const id = workspaces.get(name);
  if (!id) { console.log(`(skipped ${name}: not on this deployment)`); continue; }
  const { items, cat } = await builderCatalogue(id);
  real.push({ name, items, cat });
}
console.log("real workspaces (1×):");
for (const w of real) console.log(`  ${w.name.padEnd(22)} ${String(w.items.items.length).padStart(4)} components · schema enums ${String(enumCount(goalSpecSchema(w.items))).padStart(5)} · prompt ${goalSpecPrompt("x", w.items).length} chars`);
const largest = real.reduce((a, b) => (b.items.items.length > a.items.items.length ? b : a));
console.log(`\nscaling the largest (${largest.name}, ${largest.items.items.length} components); solver over its ${rows.filter((r) => r.workspace === largest.name).length} saved tuned specs:`);

for (const k of [1, 10, 100]) {
  const { items, cat } = scaled(largest.items, largest.cat, k);
  const schema = goalSpecSchema(items);
  const enums = enumCount(schema);
  const solveMs: number[] = [];
  for (const r of rows.filter((x) => x.workspace === largest.name)) {
    try { solveMs.push(ms(() => solve(emptyFlow("t"), { spec: { spec: r.spec, dropped: r.dropped ?? [] } as CheckedSpec, cat, answers: new Map(), base: [] }))); }
    catch (e) { console.log(`    ${r.id}: solver threw at ${k}× — ${(e as Error).message.slice(0, 120)}`); }
  }
  const optMs = ms(() => optionsOf(emptyFlow("t"), cat));
  // What the model is SENT once narrowed: the component call (refs and a line each) and the spec call over at most KEEP_MAX of each.
  const kept = { items: [...items.items.filter((i) => i.kind === "reader").slice(0, KEEP_MAX), ...items.items.filter((i) => i.kind === "tool").slice(0, KEEP_MAX)] };
  const pickEnums = Math.min(items.items.length, 1000);
  console.log(`  ${String(k).padStart(3)}×  narrowed: component call ≤ ${pickEnums} enums${items.items.length > 900 ? " (parts first)" : ""} · spec call over ${kept.items.length} components ${enumCount(goalSpecSchema(kept))} enums, prompt ${goalSpecPrompt("x", kept).length} chars`);
  console.log(`  ${String(k).padStart(3)}×  ${String(items.items.length).padStart(5)} components · schema enums ${String(enums).padStart(6)}${enums > GATEWAY_ENUM_LIMIT ? " (OVER the gateway's 1000)" : ""} · schema ${JSON.stringify(schema).length} chars · prompt ${goalSpecPrompt("x", items).length} chars · solve p50 ${pct(solveMs, 0.5).toFixed(1)} ms p90 ${pct(solveMs, 0.9).toFixed(1)} ms · optionsOf(empty) ${optMs.toFixed(1)} ms`);
}
if (live) {
  // NARROWING RECALL: at 10×, did the component call KEEP every reader and action the current builder uses at 1× (run in the same
  // pass — the control; a saved spec may predate a prompt change)? What the spec call then does with them varies run to run at 1×
  // too, so it is not what is measured here.
  const big = real.filter((w) => w.items.items.length >= largest.items.items.length - 1);
  const secs: number[] = [];
  let kept = 0, n = 0;
  for (const w of big) {
    const { items } = scaled(w.items, w.cat, 10);
    console.log(`\nlive at 10× — ${w.name} (${items.items.length} components):`);
    for (const r of rows.filter((x) => x.workspace === w.name)) {
      try {
        const base = await understand(r.goal, w.items, modelChooser);
        const used = [...base.checked.spec.sources, ...base.checked.spec.sinks].map((x) => x.ref).filter((x) => x !== "none_fit" && x !== "unsaid");
        const t = Date.now();
        const nar = await narrowCatalogue(r.goal, items, modelChooser);
        secs.push((Date.now() - t) / 1000);
        const have = new Set(nar.items.items.map((i) => i.ref.replace(/__\d+$/, ""))); // a copy IS the component
        const missed = [...new Set(used)].filter((x) => !have.has(x));
        n++; if (!missed.length) kept++;
        console.log(`  ${r.id}: ${missed.length ? `MISSED ${missed.join(", ")}` : `kept all ${new Set(used).size}`} · kept ${nar.items.items.length} · ${secs.at(-1)!.toFixed(1)} s`);
      } catch (e) { console.log(`  ${r.id}: FAILED — ${(e as Error).message.slice(0, 200)}`); }
    }
  }
  console.log(`\nnarrowing kept every component the 1× spec used: ${kept} of ${n} · narrowing call p50 ${pct(secs, 0.5).toFixed(1)} s p90 ${pct(secs, 0.9).toFixed(1)} s`);
}
process.exit(0);
