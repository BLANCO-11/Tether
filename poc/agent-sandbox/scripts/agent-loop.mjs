#!/usr/bin/env node
/**
 * Auto loop: reset → Pi clarify → answer → build → verify/run/oracle → fix turns.
 *   node scripts/agent-loop.mjs --scenario=complex [--max-fix=3]
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  cpSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const scenario = arg("scenario", "complex");
const maxFix = Number(arg("max-fix", "3"));
const SC = join(ROOT, "scenarios", scenario);
if (!existsSync(join(SC, "GOAL.md"))) {
  console.error(`missing scenario ${scenario}`);
  process.exit(1);
}

function sh(cmd, opts = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  if (opts.pipe !== false) {
    process.stdout.write(r.stdout || "");
    process.stderr.write(r.stderr || "");
  }
  return r;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function resetBlank() {
  writeFileSync(join(SANDBOX, "workflow.json"), '{"steps":[]}\n');
  writeFileSync(join(SANDBOX, "questions.json"), '{"status":"idle","questions":[]}\n');
  writeFileSync(join(SANDBOX, "answers.json"), "{}\n");
  writeFileSync(join(SANDBOX, "outbox.json"), "[]\n");
  rmSync(join(SANDBOX, "steps"), { recursive: true, force: true });
  mkdirSync(join(SANDBOX, "steps"), { recursive: true });
  cpSync(join(SC, "GOAL.md"), join(SANDBOX, "GOAL.md"));
}

function runPi(prompt, logName) {
  const log = join(SANDBOX, logName);
  const r = sh(`bash scripts/run-pi.sh ${JSON.stringify(prompt)} ${JSON.stringify(log)}`, {
    pipe: false,
  });
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  process.stdout.write(text.slice(-2500));
  console.log(`\n[pi] exit=${r.status} log=${logName}`);
  return r.status ?? 1;
}

function harness() {
  const env = { ...process.env, ORACLE_EXPECTED: join(SC, "expected.json") };
  const v = sh(`${process.execPath} verifier/verify.mjs`, { env, pipe: false });
  process.stdout.write(v.stdout || "");
  process.stderr.write(v.stderr || "");
  if (v.status !== 0) return { ok: false, stage: "verify", detail: (v.stderr || v.stdout || "").trim() };
  const run = sh(`${process.execPath} runner/run.mjs`, { env, pipe: false });
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
  if (run.status !== 0) return { ok: false, stage: "run", detail: (run.stderr || run.stdout || "").trim() };
  const o = sh(`${process.execPath} oracle/check.mjs`, { env, pipe: false });
  process.stdout.write(o.stdout || "");
  process.stderr.write(o.stderr || "");
  if (o.status !== 0) return { ok: false, stage: "oracle", detail: (o.stderr || o.stdout || "").trim() };
  return { ok: true };
}

console.log(`=== agent-loop scenario=${scenario} ===`);
sh(`${process.execPath} scripts/build-context.mjs`);
resetBlank();

console.log("\n--- clarify ---");
runPi(
  "Read GOAL.md and context/. If anything is ambiguous, write questions.json (status open) and STOP. Do not edit workflow.json or steps yet.",
  "pi-loop-clarify.log",
);

const q = readJson(join(SANDBOX, "questions.json"), {});
if (q.status === "open") {
  const canned = readJson(join(SC, "answers.json"), {});
  const map = { ...canned };
  // Map by question id; if model invented q2+, fill from leftover canned values in order
  const unused = Object.entries(canned).filter(([k]) => !(q.questions || []).some((qq) => qq.id === k));
  let ui = 0;
  for (const qq of q.questions || []) {
    if (map[qq.id] == null) {
      if (ui < unused.length) map[qq.id] = unused[ui++][1];
      else if (canned.q1 != null && qq.id.startsWith("q")) map[qq.id] = canned.q1;
    }
  }
  const missing = (q.questions || []).filter((qq) => map[qq.id] == null).map((qq) => qq.id);
  if (missing.length) {
    console.error("cannot answer open questions:", missing, "have", map);
    process.exit(1);
  }
  console.log("\n--- answer (scenario) ---", map);
  const parts = Object.entries(map)
    .filter(([k]) => (q.questions || []).some((qq) => qq.id === k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  sh(`${process.execPath} scripts/clarify.mjs answer ${parts}`);
} else {
  console.log("WARN: no open questions — model may have skipped clarify");
}

console.log("\n--- build ---");
runPi(
  "answers.json is populated (or no questions). Clear open questions. Implement GOAL.md fully: non-empty workflow.json + steps/*. Prefer templates/outbox_append for outbox. Put threshold and routing rules in params.",
  "pi-loop-build.log",
);

let result = harness();
let fix = 0;
while (!result.ok && fix < maxFix) {
  fix += 1;
  console.log(`\n--- fix turn ${fix}/${maxFix} (${result.stage}) ---`);
  runPi(
    `Harness failed at ${result.stage}:\n${result.detail}\nFix the sandbox. Keep answers. Prefer templates/outbox_append. Re-read GOAL.md for exact subject, sort order, and threshold routing.`,
    `pi-loop-fix${fix}.log`,
  );
  result = harness();
}

const summary = {
  scenario,
  ok: result.ok,
  fixTurns: fix,
  workflow: readJson(join(SANDBOX, "workflow.json"), {}),
  questions: readJson(join(SANDBOX, "questions.json"), {}),
  answers: readJson(join(SANDBOX, "answers.json"), {}),
  outbox: readJson(join(SANDBOX, "outbox.json"), []),
};
writeFileSync(join(SANDBOX, "loop-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("\n=== LOOP", result.ok ? "PASS" : "FAIL", `fixes=${fix} ===`);
process.exit(result.ok ? 0 : 1);
