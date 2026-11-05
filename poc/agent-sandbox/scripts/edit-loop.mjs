#!/usr/bin/env node
/**
 * Edit harness: snapshot → Pi apply → verify/run/oracle → accept | revert (+ fix turns).
 *
 *   node scripts/edit-loop.mjs --request="Change threshold to 150000" \
 *     --expected=scenarios/edit-threshold/expected.json
 *
 *   node scripts/edit-loop.mjs --qa --request="How does routing work?"
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { takeSnapshot, restoreSnapshot } from "./snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const request = arg("request", "");
const expected = arg("expected", "");
const maxFix = Number(arg("max-fix", "2"));
const qaOnly = hasFlag("qa");
const label = arg("label", qaOnly ? "qa" : "edit");

if (!request) {
  console.error("missing --request=...");
  process.exit(2);
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

function fingerprintState() {
  const h = createHash("sha256");
  const addFile = (rel) => {
    const p = join(SANDBOX, rel);
    h.update(rel + "\0");
    if (existsSync(p)) h.update(readFileSync(p));
  };
  addFile("workflow.json");
  addFile("questions.json");
  addFile("answers.json");
  const walk = (rel) => {
    const p = join(SANDBOX, rel);
    if (!existsSync(p)) return;
    for (const name of readdirSync(p).sort()) {
      if (name === ".snapshots") continue;
      const child = `${rel}/${name}`;
      const full = join(SANDBOX, child);
      if (statSync(full).isDirectory()) walk(child);
      else addFile(child);
    }
  };
  walk("steps");
  return h.digest("hex");
}

function runPi(prompt, logName) {
  const log = join(SANDBOX, logName);
  const r = sh(`bash scripts/run-pi.sh ${JSON.stringify(prompt)} ${JSON.stringify(log)}`, {
    pipe: false,
  });
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  process.stdout.write(text.slice(-2500));
  console.log(`\n[pi] exit=${r.status} log=${logName}`);
  return { status: r.status ?? 1, log: text };
}

function harness() {
  const env = { ...process.env };
  if (expected) env.ORACLE_EXPECTED = resolve(ROOT, expected);
  const v = sh(`${process.execPath} verifier/verify.mjs`, { env, pipe: false });
  process.stdout.write(v.stdout || "");
  process.stderr.write(v.stderr || "");
  if (v.status !== 0) {
    return { ok: false, stage: "verify", detail: (v.stderr || v.stdout || "").trim() };
  }
  const run = sh(`${process.execPath} runner/run.mjs`, { env, pipe: false });
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
  if (run.status !== 0) {
    return { ok: false, stage: "run", detail: (run.stderr || run.stdout || "").trim() };
  }
  if (expected) {
    const o = sh(`${process.execPath} oracle/check.mjs`, { env, pipe: false });
    process.stdout.write(o.stdout || "");
    process.stderr.write(o.stderr || "");
    if (o.status !== 0) {
      return { ok: false, stage: "oracle", detail: (o.stderr || o.stdout || "").trim() };
    }
  }
  return { ok: true };
}

function editPrompt(userRequest) {
  return [
    "EDIT MODE — a workflow already exists in this sandbox.",
    "",
    "Rules:",
    "1. Prefer params-only changes when possible.",
    "2. If you rename a step id or output, rewire ALL inputs/foreach that referenced it.",
    "3. Keep outbox writes on templates/outbox_append.append_message.",
    "4. Do not invent columns. If ambiguous, write questions.json (status open) and STOP.",
    "5. Touch only what the request needs — no drive-by refactors.",
    "6. After edits, workflow must still verify (non-empty, bindings resolve).",
    "",
    "User request:",
    userRequest,
  ].join("\n");
}

function qaPrompt(userRequest) {
  return [
    "Q&A MODE — answer the user about the existing workflow.",
    "DO NOT create, modify, or delete any files.",
    "Read workflow.json and step sources as needed; answer in text only.",
    "",
    "User question:",
    userRequest,
  ].join("\n");
}

function writeSummary(obj) {
  writeFileSync(join(SANDBOX, "edit-summary.json"), JSON.stringify(obj, null, 2) + "\n");
}

console.log(`=== edit-loop ${qaOnly ? "QA" : "EDIT"} ===`);
console.log("request:", request);

const beforeFp = fingerprintState();
const snap = takeSnapshot(label);
console.log("snapshot:", snap.id);

if (qaOnly) {
  runPi(qaPrompt(request), "pi-edit-qa.log");
  const dirty = beforeFp !== fingerprintState();
  if (dirty) {
    console.error("QA FAIL — files changed; reverting");
    restoreSnapshot(snap.id);
    writeSummary({ ok: false, mode: "qa", dirty: true, snapshot: snap.id, reverted: true });
    process.exit(1);
  }
  console.log("QA PASS — no file changes");
  writeSummary({ ok: true, mode: "qa", dirty: false, snapshot: snap.id, accepted: true });
  process.exit(0);
}

runPi(editPrompt(request), "pi-edit-apply.log");

let q = existsSync(join(SANDBOX, "questions.json"))
  ? JSON.parse(readFileSync(join(SANDBOX, "questions.json"), "utf8"))
  : {};
if (q.status === "open") {
  console.log("edit paused — open questions; reverting until answered");
  restoreSnapshot(snap.id);
  writeSummary({
    ok: false,
    mode: "edit",
    paused: true,
    questions: q,
    snapshot: snap.id,
    reverted: true,
  });
  process.exit(2);
}

let result = harness();
let fix = 0;
while (!result.ok && fix < maxFix) {
  fix += 1;
  console.log(`\n--- edit fix ${fix}/${maxFix} (${result.stage}) ---`);
  runPi(
    `EDIT FIX: harness failed at ${result.stage}:\n${result.detail}\n` +
      `Repair with minimal changes. Keep the user intent: ${request}\n` +
      `If you cannot repair without clarifying, open questions.json and stop.`,
    `pi-edit-fix${fix}.log`,
  );
  q = JSON.parse(readFileSync(join(SANDBOX, "questions.json"), "utf8"));
  if (q.status === "open") {
    console.log("fix paused on questions — reverting");
    restoreSnapshot(snap.id);
    writeSummary({
      ok: false,
      mode: "edit",
      paused: true,
      fixTurns: fix,
      snapshot: snap.id,
      reverted: true,
    });
    process.exit(2);
  }
  result = harness();
}

if (!result.ok) {
  console.error("EDIT FAIL — reverting to snapshot", snap.id);
  restoreSnapshot(snap.id);
  writeSummary({
    ok: false,
    mode: "edit",
    fixTurns: fix,
    stage: result.stage,
    detail: result.detail,
    snapshot: snap.id,
    reverted: true,
    accepted: false,
  });
  process.exit(1);
}

console.log("EDIT ACCEPT — harness green; pre-edit snapshot:", snap.id);
writeSummary({
  ok: true,
  mode: "edit",
  fixTurns: fix,
  snapshot: snap.id,
  reverted: false,
  accepted: true,
  fingerprintBefore: beforeFp,
  fingerprintAfter: fingerprintState(),
  request,
  expected: expected || null,
});
process.exit(0);
