#!/usr/bin/env node
/**
 * Thin runner: sequence + foreach, resolve bindings, write run.json + outbox via steps.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");

function resolvePath(p) {
  if (!p) return p;
  return isAbsolute(p) ? p : join(SANDBOX, p);
}

function loadWorkflow() {
  return JSON.parse(readFileSync(join(SANDBOX, "workflow.json"), "utf8"));
}

function callPython(entryRel, params, inputs) {
  const entry = join(SANDBOX, entryRel);
  const payloadPath = join(tmpdir(), `asb-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(
    payloadPath,
    JSON.stringify({ params, inputs }),
    "utf8",
  );
  const wrapper = `
import json, importlib.util, sys
payload = json.load(open(${JSON.stringify(payloadPath)}))
spec = importlib.util.spec_from_file_location("step_mod", ${JSON.stringify(entry)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = mod.run(payload.get("params") or {}, payload.get("inputs") or {})
print(json.dumps(out))
`;
  const py = spawnSync("python3", ["-c", wrapper], {
    encoding: "utf8",
    cwd: SANDBOX,
    env: { ...process.env, PYTHONPATH: join(SANDBOX, "templates") },
  });
  try {
    unlinkSync(payloadPath);
  } catch {
    /* ignore */
  }
  if (py.status !== 0) {
    throw new Error(`step ${entryRel} failed:\n${py.stderr || py.stdout}`);
  }
  const line = (py.stdout || "").trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

function getByPath(outputs, path) {
  const [stepId, field] = path.split(".");
  const stepOut = outputs[stepId];
  if (!stepOut) throw new Error(`no output for step ${stepId}`);
  return stepOut[field];
}

function resolveInputs(step, outputs, item) {
  const resolved = {};
  for (const [k, bind] of Object.entries(step.inputs || {})) {
    if (bind === "$item") resolved[k] = item;
    else resolved[k] = getByPath(outputs, bind);
  }
  return resolved;
}

function normalizeParams(params) {
  const p = { ...(params || {}) };
  const keys = new Set([
    "fixture",
    "outbox",
    "fixture_path",
    "outbox_path",
    "path",
  ]);
  for (const key of Object.keys(p)) {
    if (keys.has(key) || /_(path|file)$/.test(key) || key.endsWith("Path")) {
      if (typeof p[key] === "string") p[key] = resolvePath(p[key]);
    }
  }
  return p;
}

export function runWorkflow() {
  const workflow = loadWorkflow();
  const outboxPath = join(SANDBOX, "outbox.json");
  writeFileSync(outboxPath, "[]\n", "utf8");

  const outputs = {};
  const log = [];

  for (const step of workflow.steps) {
    const params = normalizeParams(step.params);

    if (step.foreach) {
      const items = getByPath(outputs, step.foreach);
      if (!Array.isArray(items)) {
        throw new Error(`foreach ${step.foreach} is not an array`);
      }
      const collected = [];
      for (const item of items) {
        const inputs = resolveInputs(step, outputs, item);
        const out = callPython(step.entry, params, inputs);
        collected.push(out);
        log.push({ step: step.id, item, out });
      }
      // Aggregate: last message list etc. — expose array of results under each output key
      const agg = {};
      for (const name of step.outputs || []) {
        agg[name] = collected.map((c) => c[name]);
      }
      outputs[step.id] = { ...agg, _items: collected };
    } else {
      const inputs = resolveInputs(step, outputs, null);
      const out = callPython(step.entry, params, inputs);
      outputs[step.id] = out;
      log.push({ step: step.id, out });
    }
  }

  const runPath = join(SANDBOX, "run.json");
  const record = { ok: true, outputs, log, outbox: JSON.parse(readFileSync(outboxPath, "utf8")) };
  writeFileSync(runPath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

function main() {
  try {
    const r = runWorkflow();
    console.log(`RUN OK — outbox ${r.outbox.length} messages`);
    process.exit(0);
  } catch (e) {
    console.error("RUN FAIL:", e.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
