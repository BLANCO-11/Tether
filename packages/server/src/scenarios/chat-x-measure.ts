/**
 * Phase X, task 8 — `chat:x-measure`: the route and the edit decision, against the labelled sets in `chat-x-labels.ts` (declared
 * before the first run). A MEASUREMENT: it exits non-zero only when it could not run, or when a STRUCTURAL invariant broke (a
 * destructive edit applied unconfirmed, an applied edit landing on an invalid state) — agreement rates are numbers to read.
 *
 *   ./scripts/harness-in-net.sh packages/server/src/scenarios/chat-x-measure.ts --out=rows.json [--set=route|edit] [--rounds=1]
 *
 * ⚠ Model calls cost money: 40 route + 24 edit calls per round. The model is printed from `resolveGenerationProvider()`.
 * Nothing is written to any flow: the edit half decides and applies in memory, on the neutral synthetic catalogue.
 */
import { writeFileSync } from "node:fs";
import { checkState, errorsOf, SYNTHETIC } from "@foundry/flow-edit";
import { resolveGenerationProvider } from "../services/generation-provider.service.js";
import { modelChooser } from "../services/builder/builder.service.js";
import { routeMessage } from "../services/builder/chat-route.js";
import { applyEdit, chooseEdit, decide, isDestructive, placeWords } from "../services/builder/chat-edit.js";
import { STATES } from "./chat-edit-states.js";
import { adjudicateEdit, EDIT_CASES, ROUTE_CASES, type EditOutcome } from "./chat-x-labels.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const OUT = arg("out");
const SET = arg("set") ?? "both";
const ROUNDS = Number(arg("rounds") ?? 1);

async function main() {
  if (!OUT) throw new Error("need --out=…");
  const provider = await resolveGenerationProvider();
  console.log(`chat:x-measure · model ${provider.model} (${provider.source}) · rounds ${ROUNDS} · set ${SET}`);
  const rows: unknown[] = [];
  let broken = 0;

  if (SET !== "edit") {
    const byKind = new Map<string, { n: number; ok: number }>();
    let ok = 0, n = 0;
    for (let round = 1; round <= ROUNDS; round++) for (const c of ROUTE_CASES) {
      const got = await routeMessage(c.message, c.hasSteps, modelChooser).catch((e) => `error: ${(e as Error).message}`);
      const agrees = got === c.kind;
      n++; if (agrees) ok++;
      const k = byKind.get(c.kind) ?? { n: 0, ok: 0 }; k.n++; if (agrees) k.ok++; byKind.set(c.kind, k);
      rows.push({ set: "route", round, message: c.message, hasSteps: c.hasSteps, expect: c.kind, got, agrees });
      if (!agrees) console.log(`  route ✗ “${c.message}” → ${got} (expected ${c.kind})`);
    }
    console.log(`route: ${ok}/${n} agree · ${[...byKind].map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(" · ")}`);
    rows.push({ set: "route", summary: { ok, n, byKind: Object.fromEntries(byKind) } });
  }

  if (SET !== "route") {
    let ok = 0, n = 0, wrongApplied = 0, destructiveUnconfirmed = 0, invalid = 0, calls = 0;
    for (let round = 1; round <= ROUNDS; round++) for (const c of EDIT_CASES) {
      const f = STATES[c.state]();
      const chosen = await chooseEdit(c.message, f, SYNTHETIC, modelChooser);
      calls += chosen.calls;
      const d = chosen.pick ? decide(c.message, chosen.pick, chosen.acts, { stepWords: chosen.stepWords, value: chosen.value }) : { status: "none_fit" as const };
      const o: EditOutcome = d.status === "none_fit" ? { status: "none_fit" }
        : { status: d.status, label: d.action.label, at: d.status === "which_step" ? undefined : placeWords(d.action.where), ...("value" in d && d.value ? { value: d.value } : {}), destructive: isDestructive(d.action) };
      // The structural invariants — each a bug if it ever fires.
      if (d.status === "apply" && isDestructive(d.action)) { destructiveUnconfirmed++; broken++; }
      if (d.status === "apply") {
        const r = applyEdit(f, SYNTHETIC, d.action, d.value);
        if (r.ok && errorsOf(checkState(r.flow, SYNTHETIC)).length) { invalid++; broken++; }
        // A value `apply` refused becomes a value question (chat-edit.service's carryOut) — recorded as that.
        if (!r.ok) { if (d.action.slot) { o.status = "ask_value"; delete o.value; } else o.status = "none_fit"; }
      }
      const a = adjudicateEdit(c, o);
      n++; if (a.agrees) ok++; if (a.wrongApplied) wrongApplied++;
      rows.push({ set: "edit", round, state: c.state, message: c.message, expect: c.expect, got: o, stepWords: chosen.stepWords, modelValue: chosen.value, ...a });
      if (!a.agrees) console.log(`  edit ✗ [${c.state}] “${c.message}” → ${JSON.stringify(o)} (expected ${JSON.stringify(c.expect)})`);
    }
    console.log(`edit: ${ok}/${n} agree · wrong applied ${wrongApplied} · destructive unconfirmed ${destructiveUnconfirmed} · invalid states ${invalid} · ${calls} calls`);
    rows.push({ set: "edit", summary: { ok, n, wrongApplied, destructiveUnconfirmed, invalid, calls } });
  }

  writeFileSync(OUT, JSON.stringify({ model: provider.model, at: new Date().toISOString(), rounds: ROUNDS, rows }, null, 2));
  process.exit(broken ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
