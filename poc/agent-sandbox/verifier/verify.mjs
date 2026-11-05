#!/usr/bin/env node
/**
 * Structural verifier — code, not the model.
 * Checks workflow.json: non-empty steps, schema, entries, bindings, template use.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");

function fail(msg) {
  return { ok: false, errors: [msg] };
}

function loadWorkflow(path = join(SANDBOX, "workflow.json")) {
  if (!existsSync(path)) return fail(`missing workflow: ${path}`);
  try {
    return { ok: true, workflow: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return fail(`invalid JSON in workflow.json: ${e.message}`);
  }
}

function checkQuestionsOpen() {
  const qPath = join(SANDBOX, "questions.json");
  if (!existsSync(qPath)) return null;
  try {
    const q = JSON.parse(readFileSync(qPath, "utf8"));
    if (q.status === "open") {
      return `questions still open (${(q.questions || []).length} pending) — answer before claiming done`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function touchesOutbox(step, src) {
  const blob = `${JSON.stringify(step.params || {})}\n${src}`;
  return /outbox/i.test(blob);
}

function usesOutboxTemplate(src) {
  return (
    /from\s+outbox_append\s+import\s+append_message/.test(src) ||
    /import\s+outbox_append/.test(src) ||
    /templates[/\\]outbox_append/.test(src)
  );
}

export function verify(opts = {}) {
  const errors = [];
  const loaded = loadWorkflow(opts.workflowPath);
  if (!loaded.ok) return loaded;

  const { workflow } = loaded;
  if (!workflow || !Array.isArray(workflow.steps)) {
    return fail("workflow.steps must be an array");
  }

  if (workflow.steps.length === 0 && !opts.allowEmpty) {
    errors.push("workflow.steps is empty — a goal needs at least one step");
  }

  const openQ = checkQuestionsOpen();
  if (openQ && !opts.allowOpenQuestions) errors.push(openQ);

  const byId = new Map();
  for (const step of workflow.steps) {
    if (!step || typeof step !== "object") {
      errors.push("each step must be an object");
      continue;
    }
    if (!step.id || typeof step.id !== "string") {
      errors.push("step missing id");
      continue;
    }
    if (byId.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    byId.set(step.id, step);

    let src = "";
    if (!step.entry || typeof step.entry !== "string") {
      errors.push(`step ${step.id}: missing entry`);
    } else {
      const entryPath = join(SANDBOX, step.entry);
      if (!existsSync(entryPath)) {
        errors.push(`step ${step.id}: entry not found: ${step.entry}`);
      } else {
        src = readFileSync(entryPath, "utf8");
        if (!/\bdef\s+run\s*\(/.test(src)) {
          errors.push(`step ${step.id}: ${step.entry} must define def run(...)`);
        }
        if (touchesOutbox(step, src) && !usesOutboxTemplate(src) && !opts.allowInlineOutbox) {
          errors.push(
            `step ${step.id}: outbox writes must use templates/outbox_append.py (import append_message)`,
          );
        }
      }
    }

    if (!Array.isArray(step.outputs)) {
      errors.push(`step ${step.id}: outputs must be an array`);
    }
    if (step.params != null && typeof step.params !== "object") {
      errors.push(`step ${step.id}: params must be an object`);
    }
    if (step.inputs != null && typeof step.inputs !== "object") {
      errors.push(`step ${step.id}: inputs must be an object`);
    }
  }

  const produced = new Map();
  for (const step of workflow.steps) {
    if (!step?.id) continue;

    if (step.foreach) {
      const m = String(step.foreach).match(/^([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)$/);
      if (!m) {
        errors.push(`step ${step.id}: foreach must be "stepId.output" got ${step.foreach}`);
      } else {
        const [, srcId, out] = m;
        const outs = produced.get(srcId);
        if (!outs) errors.push(`step ${step.id}: foreach source step unknown: ${srcId}`);
        else if (!outs.has(out)) {
          errors.push(`step ${step.id}: foreach output ${out} not declared on ${srcId}`);
        }
      }
    }

    const inputs = step.inputs || {};
    for (const [key, bind] of Object.entries(inputs)) {
      if (bind === "$item") {
        if (!step.foreach) {
          errors.push(`step ${step.id}: input ${key}=$item requires foreach`);
        }
        continue;
      }
      if (typeof bind !== "string") {
        errors.push(`step ${step.id}: input ${key} binding must be a string`);
        continue;
      }
      const m = bind.match(/^([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)$/);
      if (!m) {
        errors.push(`step ${step.id}: input ${key} must be "$item" or "stepId.output"`);
        continue;
      }
      const [, srcId, out] = m;
      const outs = produced.get(srcId);
      if (!outs) errors.push(`step ${step.id}: input ${key} references unknown step ${srcId}`);
      else if (!outs.has(out)) {
        errors.push(`step ${step.id}: input ${key} references undeclared output ${srcId}.${out}`);
      }
    }

    produced.set(step.id, new Set(step.outputs || []));
  }

  return { ok: errors.length === 0, errors, stepCount: workflow.steps.length };
}

function main() {
  const result = verify();
  if (result.ok) {
    console.log(`VERIFY OK — ${result.stepCount} steps`);
    process.exit(0);
  }
  console.error("VERIFY FAIL");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
