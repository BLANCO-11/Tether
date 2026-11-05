#!/usr/bin/env node
/**
 * Structural verifier — code, not the model (pi-runtime P2).
 *
 * Checks `sandbox/workflow.json` and the step files against the WORKSPACE CATALOGUE (`sandbox/catalogue.json`),
 * never against anything specific to a workspace, table or goal:
 *
 *   - shape: ids (unique across the whole workflow), entries exist and define run(), outputs declared, bindings name
 *            outputs VISIBLE where they are used: earlier steps', the item of an enclosing loop, what a branch declares
 *   - control flow: loops ("foreach"/"as"/"steps", ≤3 deep), branches (paths with declared conditions, "else" last,
 *            every path sets every declared output), approvals (a title; never inside a loop)
 *   - allow_empty: each entry names one of the step's outputs and gives a reason (the runner fails any other emptiness)
 *   - inputs: every `$input.<name>` is declared under workflow.inputs; every declared input has a type the run can
 *             coerce to, a description (what the test form asks a person), a default that fits its type, and is
 *             passed to at least one step as "$input.<name>" — a declared input no step receives is a value a person
 *             types and the workflow ignores
 *   - reads: a `ref` names a saved reader in entries; own SQL names a datasource in the catalogue, is one SELECT,
 *            and its $n placeholders match `params`
 *   - uses: every `read:`/`tool:` resolves (a declared read / a tool in entries), and every literal
 *           foundry.read("x") / foundry.call("y") in a step's code is in that step's uses
 *   - data flow: every params["k"] / inputs["k"] the code reads is bound on the step (the runner passes nothing
 *                else), and a step listing reads either calls one or is bound inputs — or it has no data at all
 *   - clarification: no open questions, and no question without a prompt
 *   - cases: every choice the request describes is listed under "cases" and points at a real branch path; a case marked
 *            "missing" is refused until the person is asked — so no choice is hidden in code or silently dropped
 *   - descriptions: every code step says in one sentence what it does (what a person reads when they click it)
 *
 * What it cannot check (the test run does): whether the SQL is valid for the dialect, whether tables/columns in it
 * exist, and what the code actually does. Those are proven by RUNNING it, on the same runner production uses.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The conversation's folder. The server runs THIS file from its own image and names the folder (FORGE_VERIFY_ROOT): a
// verifier run from the folder itself is one Forge can rewrite, and the server would run Forge's code (2026-10-13).
const ROOT = process.env.FORGE_VERIFY_ROOT ? resolve(process.env.FORGE_VERIFY_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = join(ROOT, "sandbox");
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** The parameter types the executor binds by — the same list as the server's READ_PARAM_TYPES. */
const PARAM_TYPES = ["string", "integer", "number", "boolean", "date", "array"];
/** The types a run input may declare — the same list as the server's RUN_INPUT_TYPES. */
const INPUT_TYPES = ["string", "integer", "number", "boolean", "date"];
const INPUT_KEYS = new Set(["type", "description", "default", "relative"]);
/** What a date input may be relative to — the same list as the server's run-inputs RELATIVE_DATES. */
const RELATIVE_DATES = ["today", "yesterday", "this_week_start", "last_week_start", "last_week_end", "this_month_start", "last_month_start", "last_month_end"];
function defaultFits(type, v) {
  if (type === "integer") return Number.isInteger(v);
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  if (type === "boolean") return typeof v === "boolean";
  if (type === "date") return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  return typeof v === "string";
}
/** What a read may say. An unknown key is refused, not ignored: an ignored key reads as one that works. */
const READ_KEYS = new Set(["datasource", "sql", "params", "ref", "kind"]);
const STEP_KEYS = new Set(["id", "description", "entry", "params", "inputs", "outputs", "uses", "allow_empty"]);
const ALLOW_KEYS = new Set(["output", "field", "reason"]);
const TOP_KEYS = new Set(["name", "inputs", "reads", "schedule", "cases", "steps"]);
const CASE_KEYS = new Set(["says", "path", "missing"]);
const SCHEDULE_KEYS = new Set(["cron", "timezone"]);
/** One cron field: *, n, a-b, lists, /steps — the runner's own grammar (server services/cron.ts). */
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;
const LOOP_KEYS = new Set(["id", "description", "foreach", "as", "steps"]);
const BRANCH_KEYS = new Set(["id", "description", "branch", "outputs"]);
const ARM_KEYS = new Set(["if", "else", "steps", "set"]);
const APPROVAL_NODE_KEYS = new Set(["id", "description", "approval"]);
const APPROVAL_KEYS = new Set(["title", "review", "decider"]);
const COND_KEYS = new Set(["value", "op", "to"]);

function readJson(path, fallback) {
  if (!existsSync(path)) return { missing: true, value: fallback };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { error: `${path.slice(SANDBOX.length + 1)} is not valid JSON: ${e.message}`, value: fallback };
  }
}

export function verify() {
  const errors = [];
  /**
   * An unknown key is REFUSED, never ignored (2026-10-09): Pi added `paramsSchema` to a read after the server asked
   * for parameter types, nothing read that key, and two fix rounds failed on the same refusal. A key nothing reads
   * looks exactly like a key that works.
   */
  const unknownKeys = (where, obj, allowed) => {
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) errors.push(`${where}: unknown key "${k}" — allowed: ${[...allowed].join(", ")}`);
    }
  };
  const wfRead = readJson(join(SANDBOX, "workflow.json"), null);
  if (wfRead.missing) return { ok: false, errors: ["workflow.json is missing"] };
  if (wfRead.error) return { ok: false, errors: [wfRead.error] };
  const wf = wfRead.value;
  if (!wf || !Array.isArray(wf.steps)) return { ok: false, errors: ["workflow.steps must be an array"] };
  unknownKeys("workflow.json", wf, TOP_KEYS);
  if (wf.steps.length === 0) errors.push("workflow.steps is empty — an automation needs at least one step");

  const cat = readJson(join(SANDBOX, "catalogue.json"), { entries: [], datasources: [] }).value ?? {};
  const entries = new Map((cat.entries ?? []).map((e) => [e.ref, e]));
  // The person's own actions (plans/personal-actions-2026-10-29), written by the server each turn. TOOLS only: a read
  // or a file never comes from here. Accepting one here grants nothing — the run refuses an action its person lacks.
  const mine = readJson(join(SANDBOX, "catalogue.mine.json"), { entries: [] }).value ?? {};
  for (const e of mine.entries ?? []) if (e && e.kind === "tool" && typeof e.ref === "string" && !entries.has(e.ref)) entries.set(e.ref, e);
  const tools = new Set([...entries.values()].filter((e) => e.kind === "tool").map((e) => e.ref));
  const readers = new Set([...entries.values()].filter((e) => e.kind !== "tool").map((e) => e.ref));
  const files = new Set((cat.files ?? []).map((f) => f.name));
  // A file in THIS chat (attached in files/, or made by Forge in out/) is readable too: test runs read it from the chat,
  // and saving the workflow copies it into the workspace's Files.
  for (const dir of ["files", "out"]) {
    try {
      for (const n of readdirSync(join(SANDBOX, dir))) if (!n.startsWith(".") && statSync(join(SANDBOX, dir, n)).isFile()) files.add(n);
    } catch {
      /* no such folder */
    }
  }
  const datasources = new Map((cat.datasources ?? []).map((d) => [d.name, d]));

  // questions
  const q = readJson(join(SANDBOX, "questions.json"), { status: "clear", questions: [] }).value ?? {};
  if (q.status === "open") errors.push(`questions are still open (${(q.questions ?? []).length}) — answer them before building`);
  for (const item of q.questions ?? []) {
    if (!item?.prompt || !String(item.prompt).trim()) errors.push(`question ${item?.id ?? "?"} has no prompt`);
  }

  // inputs
  const declaredInputs = new Set(Object.keys(wf.inputs ?? {}));
  for (const [name, d] of Object.entries(wf.inputs ?? {})) {
    if (!ID_RE.test(name)) errors.push(`input "${name}": name must be letters, digits and _`);
    if (!d || typeof d !== "object") { errors.push(`input "${name}" must be an object {"type", "description", "default"}`); continue; }
    unknownKeys(`input "${name}"`, d, INPUT_KEYS);
    if (!INPUT_TYPES.includes(d.type)) errors.push(`input "${name}" needs a "type", one of ${INPUT_TYPES.join(", ")}`);
    if (!String(d.description ?? "").trim()) errors.push(`input "${name}" needs a "description" — it is what a person is asked when the automation runs`);
    if ("default" in d && INPUT_TYPES.includes(d.type) && !defaultFits(d.type, d.default)) {
      errors.push(`input "${name}": default ${JSON.stringify(d.default)} is not of type ${d.type}${d.type === "date" ? " (YYYY-MM-DD)" : ""}`);
    }
    if ("relative" in d) {
      if (d.type !== "date") errors.push(`input "${name}": "relative" is for a date input — make it {"type": "date", "relative": ..., "default": "<a date in the test data>"}`);
      if (!RELATIVE_DATES.includes(d.relative)) errors.push(`input "${name}": relative "${d.relative ?? ""}" — one of ${RELATIVE_DATES.join(", ")}`);
      if (!("default" in d)) errors.push(`input "${name}": a relative date still needs a "default" — the date a TEST run uses, inside the test data's range`);
    }
  }
  const received = new Set();

  // schedule — runs on its own once approved, so nobody is there to type an input: each needs a default.
  if (wf.schedule !== undefined) {
    const sc = wf.schedule;
    if (!sc || typeof sc !== "object") errors.push(`schedule must be {"cron": "<minute hour day month weekday>", "timezone"?}`);
    else {
      unknownKeys("schedule", sc, SCHEDULE_KEYS);
      const fields = String(sc.cron ?? "").trim().split(/\s+/);
      if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
        errors.push(`schedule.cron "${sc.cron ?? ""}" must be 5 fields: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1" = Mondays 09:00)`);
      }
      if (sc.timezone !== undefined) {
        try { new Intl.DateTimeFormat("en-US", { timeZone: sc.timezone }); } catch { errors.push(`schedule.timezone "${sc.timezone}" is not a timezone (e.g. "Europe/London", "Asia/Kolkata")`); }
      }
      for (const [name, d] of Object.entries(wf.inputs ?? {})) {
        if (d && typeof d === "object" && !("default" in d)) errors.push(`input "${name}" needs a "default" — the workflow runs on a schedule, with nobody to ask`);
      }
    }
  }

  // reads
  const reads = wf.reads ?? {};
  for (const [name, decl] of Object.entries(reads)) {
    if (!ID_RE.test(name)) errors.push(`read "${name}": name must be letters, digits and _`);
    if (!decl || typeof decl !== "object") { errors.push(`read "${name}" must be an object`); continue; }
    unknownKeys(`read "${name}"`, decl, READ_KEYS);
    if (decl.ref) {
      if (!readers.has(decl.ref)) errors.push(`read "${name}": "${decl.ref}" is not a saved reader in this workspace's catalogue`);
      continue;
    }
    if (!decl.datasource || !datasources.has(decl.datasource)) {
      errors.push(`read "${name}": datasource "${decl.datasource ?? ""}" is not in this workspace's catalogue`);
    }
    const sql = String(decl.sql ?? "").trim();
    if (!/^(select|with)\b/i.test(sql)) errors.push(`read "${name}": sql must be a single read-only SELECT`);
    if (/;\s*\S/.test(sql)) errors.push(`read "${name}": sql must be ONE statement`);
    // ONE declaration of a parameter: an ordered list of {name, type}, $1 first. The server applies the
    // executor's own shape check on top of this before any run or save; this catches the shape early.
    const params = decl.params ?? [];
    if (!Array.isArray(params)) {
      errors.push(`read "${name}": "params" must be a list of {"name", "type"} in $1, $2 … order`);
    } else {
      params.forEach((p, i) => {
        if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name) {
          errors.push(`read "${name}": params[${i}] must be {"name": "...", "type": "..."}`);
        } else if (!PARAM_TYPES.includes(p.type)) {
          errors.push(`read "${name}": parameter "${p.name}" needs a "type", one of ${PARAM_TYPES.join(", ")}`);
        }
      });
      const highest = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      if (highest !== params.length) {
        errors.push(`read "${name}": the SQL uses ${highest ? `$1..$${highest}` : "no placeholders"} but params lists ${params.length}`);
      }
    }
  }

  // nodes — steps, loops, branches, approvals (pi-runtime P5/P7). Walked recursively with what is VISIBLE at each
  // point: a step's outputs after it runs; inside a loop, the loop's item; never a branch arm's or loop body's own
  // steps from outside (only what the branch declares, and the loop's counts).
  const seen = new Set();
  // Every step id at any depth: whose file steps/<id>/main.py is.
  const stepIds = new Set();
  (function ids(v) {
    if (Array.isArray(v)) v.forEach(ids);
    else if (v && typeof v === "object") {
      if (typeof v.id === "string" && typeof v.entry === "string") stepIds.add(v.id);
      Object.values(v).forEach((x) => x && typeof x === "object" && ids(x));
    }
  })(wf.steps);
  /** branch id → its paths, for "cases". */
  const branches = new Map();
  let stepCount = 0;
  const bindingOk = (where, v, ctx, owner, { literalOk }) => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t.startsWith("$input.")) {
      received.add(t.slice(7));
      if (!declaredInputs.has(t.slice(7))) errors.push(`${owner}: ${where} uses ${t}, which is not declared under workflow.inputs`);
      return;
    }
    if (t === "$index") {
      if (!ctx.loops.length) errors.push(`${owner}: ${where} uses $index outside a loop`);
      return;
    }
    if (t.startsWith("$")) {
      const head = t.slice(1).split(".")[0];
      const forms = `the forms are "$input.<name>", "<earlier_step>.<output>", and inside a loop "$item", "$<loop as>.<field>" and "$index"`;
      if (head === "read" || (head in reads)) {
        // Say what to do, not only what is wrong: a check that names no fix gets "fixed" by guessing.
        errors.push(`${owner}: ${where} is "${t}" — a read is not a binding; call foundry.read("${t.split(".")[1] ?? head}") in the step's code and list "read:${t.split(".")[1] ?? head}" in its uses (${forms})`);
      } else if (!ctx.loops.length) {
        errors.push(`${owner}: ${where} is "${t}", which is not a binding here — ${forms}${head === "item" ? `; "$item" exists only inside a loop` : ""}`);
      } else if (head !== "item" && !ctx.loops.includes(head)) {
        errors.push(`${owner}: ${where} uses ${t}, but no loop around it is named "${head}" (loops here: ${ctx.loops.join(", ")})`);
      }
      return;
    }
    const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(t);
    if (!m) {
      if (!literalOk && Object.hasOwn(reads, t)) {
        // A read's bare name is the commonest wrong binding, and the generic sentence below names no fix — measured
        // getting "fixed" twice by guessing ($input.<read>, then no binding at all) on 2026-11-03.
        errors.push(`${owner}: ${where} is "${t}" — that is a read's name, and a read is not a binding; call foundry.read("${t}") in the step's code and list "read:${t}" in its uses`);
        return;
      }
      if (!literalOk) errors.push(`${owner}: ${where} must be "$input.<name>", "$item…", or "<earlier_step>.<output>"`);
      return;
    }
    const outs = ctx.visible.get(m[1]);
    if (!outs) {
      if (literalOk && !seen.has(m[1])) return; // a literal that happens to contain a dot
      if (!seen.has(m[1]) && Object.hasOwn(reads, m[1])) {
        // "<read>.rows" is the read-name binding in step form (chat 934d4254): told only "no step is called attendance",
        // the fix round invented three steps of that name, each running another step's code.
        errors.push(`${owner}: ${where} is "${t}" — ${m[1]} is a read, not a step, and a read is not a binding; call foundry.read("${m[1]}", ...) in this step's code, list "read:${m[1]}" in its uses, and remove this input`);
        return;
      }
      errors.push(seen.has(m[1])
        ? `${owner}: ${where} reads ${t}, but ${m[1]} is inside a loop or a branch path — read the loop's counts, or what the branch declares under "outputs" and sets in every path`
        : `${owner}: ${where} reads ${t}, but no EARLIER step is called ${m[1]}`);
    } else if (!outs.has(m[2])) errors.push(`${owner}: ${where} reads ${t}, but ${m[1]} does not declare output ${m[2]}`);
  };

  const OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "empty", "not_empty", "in", "contains"]);
  const checkCondition = (cond, ctx, owner) => {
    if (!cond || typeof cond !== "object") { errors.push(`${owner}: a condition must be {"value", "op", "to"?} or all/any/not`); return; }
    if (Array.isArray(cond.all) || Array.isArray(cond.any)) { for (const c of cond.all ?? cond.any) checkCondition(c, ctx, owner); return; }
    if (cond.not) { checkCondition(cond.not, ctx, owner); return; }
    unknownKeys(`${owner} condition`, cond, COND_KEYS);
    if (!OPS.has(cond.op)) errors.push(`${owner}: condition op "${cond.op ?? ""}" — one of ${[...OPS].join(", ")}`);
    if (typeof cond.value !== "string") errors.push(`${owner}: condition "value" must name what is compared ("$item.late", "check.total", "$input.limit")`);
    else bindingOk("condition value", cond.value, ctx, owner, { literalOk: false });
    const needsTo = !["empty", "not_empty"].includes(cond.op);
    if (needsTo && !("to" in cond)) errors.push(`${owner}: condition op "${cond.op}" needs "to"`);
    if ("to" in cond) bindingOk("condition to", cond.to, ctx, owner, { literalOk: true });
  };

  const walk = (nodes, ctx) => {
    if (!Array.isArray(nodes)) { errors.push(`${ctx.where}: steps must be an array`); return; }
    for (const node of nodes) {
      if (!node || typeof node !== "object" || !node.id) { errors.push(`${ctx.where}: every step needs an id`); continue; }
      const sid = node.id;
      if (!ID_RE.test(sid)) errors.push(`step "${sid}": id must be letters, digits and _`);
      if (seen.has(sid)) errors.push(`duplicate step id: ${sid} — every step, loop, branch and approval needs its own id`);
      seen.add(sid);
      if ("foreach" in node) {
        unknownKeys(`loop ${sid}`, node, LOOP_KEYS);
        if (ctx.loops.length >= 3) errors.push(`loop ${sid}: loops nest at most 3 deep`);
        const as = node.as ?? "item";
        if (!ID_RE.test(as) || ["input", "index"].includes(as)) errors.push(`loop ${sid}: "as" must be a name (not input or index)`);
        bindingOk("foreach", node.foreach, ctx, `loop ${sid}`, { literalOk: false });
        walk(node.steps, { ...ctx, where: `loop ${sid}`, loops: [...ctx.loops, as], visible: new Map(ctx.visible) });
        ctx.visible.set(sid, new Set(["count", "succeeded", "failed", "items"]));
      } else if ("branch" in node) {
        unknownKeys(`branch ${sid}`, node, BRANCH_KEYS);
        const arms = Array.isArray(node.branch) ? node.branch : [];
        branches.set(sid, arms);
        if (!arms.length) errors.push(`branch ${sid}: "branch" must be a list of paths [{"if", "steps"}, …, {"else": true, "steps"}]`);
        const outs = Array.isArray(node.outputs) ? node.outputs : [];
        if (node.outputs !== undefined && !Array.isArray(node.outputs)) errors.push(`branch ${sid}: outputs must be a list of names`);
        arms.forEach((arm, i) => {
          const at = `branch ${sid} path ${i + 1}`;
          if (!arm || typeof arm !== "object") { errors.push(`${at}: must be {"if", "steps", "set"?} or {"else": true, "steps", "set"?}`); return; }
          unknownKeys(at, arm, ARM_KEYS);
          if (arm.else) {
            if (i !== arms.length - 1) errors.push(`${at}: "else" must be the last path`);
          } else checkCondition(arm.if, ctx, at);
          const inner = { ...ctx, where: at, visible: new Map(ctx.visible) };
          walk(arm.steps ?? [], inner);
          for (const name of outs) {
            if (!arm.set || !(name in arm.set)) errors.push(`${at}: the branch declares output "${name}", so every path must set it under "set"`);
          }
          for (const [name, v] of Object.entries(arm.set ?? {})) {
            if (!outs.includes(name)) errors.push(`${at}: sets "${name}", which the branch does not declare under "outputs"`);
            bindingOk(`set ${name}`, v, inner, at, { literalOk: true });
          }
        });
        if (outs.length && !arms.some((a) => a?.else)) {
          errors.push(`branch ${sid}: declares outputs, so it needs an "else" path — otherwise when no condition holds there is nothing to read`);
        }
        ctx.visible.set(sid, new Set(["taken", "why", ...outs]));
      } else if ("approval" in node) {
        unknownKeys(`approval ${sid}`, node, APPROVAL_NODE_KEYS);
        if (ctx.loops.length) errors.push(`approval ${sid}: an approval cannot be inside a loop — put ONE approval before the loop; it shows what the loop will do`);
        const a = node.approval;
        if (!a || typeof a !== "object") errors.push(`approval ${sid}: "approval" must be {"title", "review"?}`);
        else {
          unknownKeys(`approval ${sid}`, a, APPROVAL_KEYS);
          if (!String(a.title ?? "").trim()) errors.push(`approval ${sid}: needs a "title" — the question the approver answers ("Send these 42 reminders?")`);
          if (a.review !== undefined) bindingOk("review", a.review, ctx, `approval ${sid}`, { literalOk: false });
          if (a.decider !== undefined && !/^[^\s@]+@[^\s@]+$/.test(String(a.decider))) errors.push(`approval ${sid}: "decider" is the email of the workspace member who decides it`);
        }
        ctx.visible.set(sid, new Set(["decision", "by", "note", "at"]));
      } else {
        stepCount++;
        checkStep(node, ctx);
        ctx.visible.set(sid, new Set(Array.isArray(node.outputs) ? node.outputs : []));
      }
    }
  };

  const checkStep = (step, ctx) => {
    const sid = step.id;
    unknownKeys(`step ${sid}`, step, STEP_KEYS);
    if (!String(step.description ?? "").trim()) {
      errors.push(`step ${sid}: needs a "description" — one plain sentence saying what it does, which a person reads when they click it`);
    }
    if (!Array.isArray(step.outputs)) errors.push(`step ${sid}: outputs must be an array`);
    // allow_empty: the ONLY way a step may return empty data and pass (the runner's output checks). Each entry names
    // one of THIS step's outputs and says why — a reason is what a person reads when they look at the step.
    if (step.allow_empty !== undefined) {
      if (!Array.isArray(step.allow_empty)) errors.push(`step ${sid}: allow_empty must be a list of {"output", "field"?, "reason"}`);
      else step.allow_empty.forEach((a, i) => {
        if (!a || typeof a !== "object") { errors.push(`step ${sid}: allow_empty[${i}] must be {"output", "field"?, "reason"}`); return; }
        unknownKeys(`step ${sid}: allow_empty[${i}]`, a, ALLOW_KEYS);
        if (!Array.isArray(step.outputs) || !step.outputs.includes(a.output)) {
          errors.push(`step ${sid}: allow_empty[${i}] names output "${a.output ?? ""}", which this step does not declare`);
        }
        if (a.field !== undefined && (typeof a.field !== "string" || !a.field.trim())) errors.push(`step ${sid}: allow_empty[${i}].field must be a field name`);
        if (!String(a.reason ?? "").trim()) errors.push(`step ${sid}: allow_empty[${i}] needs a "reason" — why can this genuinely be empty?`);
      });
    }

    let src = "";
    const entry = step.entry || `steps/${sid}/main.py`;
    // One code file per step: a step running another step's file runs that step's logic under the wrong bindings.
    const owns = /^steps\/([^/]+)\/main\.py$/.exec(entry)?.[1];
    if (owns && owns !== sid && stepIds.has(owns)) {
      errors.push(`step ${sid}: runs ${entry}, which is step ${owns}'s code — each step runs its own file, steps/${sid}/main.py`);
    }
    if (!existsSync(join(SANDBOX, entry))) errors.push(`step ${sid}: ${entry} does not exist`);
    else {
      src = readFileSync(join(SANDBOX, entry), "utf8");
      if (!/^\s*def\s+run\s*\(/m.test(src)) errors.push(`step ${sid}: ${entry} must define run(params, inputs)`);
    }

    const uses = Array.isArray(step.uses) ? step.uses : [];
    for (const u of uses) {
      const [kind, ...rest] = String(u).split(":");
      const name = rest.join(":");
      if (kind === "read" && !(name in reads)) errors.push(`step ${sid}: uses "${u}" but no read "${name}" is declared`);
      else if (kind === "tool" && !tools.has(name)) errors.push(`step ${sid}: uses "${u}" but "${name}" is not a tool in this workspace's catalogue`);
      else if (kind === "file" && !files.has(name)) errors.push(`step ${sid}: uses "${u}" but there is no file "${name}" in this workspace's Files (catalogue files[]) or in this chat (files/, out/)`);
      else if (kind !== "read" && kind !== "tool" && kind !== "file") errors.push(`step ${sid}: "${u}" — uses entries are read:<name>, tool:<name> or file:<name>`);
    }
    for (const m of src.matchAll(/foundry\.(read|call|file)\(\s*["']([^"']+)["']/g)) {
      const want = `${m[1] === "call" ? "tool" : m[1]}:${m[2]}`;
      if (!uses.includes(want)) errors.push(`step ${sid}: the code calls foundry.${m[1]}("${m[2]}") but uses does not list "${want}"`);
    }

    for (const [k, v] of Object.entries(step.params ?? {})) bindingOk(`param ${k}`, v, ctx, `step ${sid}`, { literalOk: true });
    for (const [k, v] of Object.entries(step.inputs ?? {})) bindingOk(`input ${k}`, v, ctx, `step ${sid}`, { literalOk: false });
    // A value handed to a step must be READ by its code, or what a person typed is ignored while the step runs on a
    // value written into the code. run(params, inputs) reads them by key — the API SYSTEM.md teaches.
    if (src && !/\*\*\s*params\b/.test(src)) {
      for (const k of Object.keys(step.params ?? {})) {
        if (!new RegExp(`params\\s*(\\[\\s*["']${k}["']\\s*\\]|\\.get\\(\\s*["']${k}["'])`).test(src)) {
          errors.push(`step ${sid}: receives param "${k}" but ${entry} never reads params["${k}"] — use it instead of a fixed value`);
        }
      }
    }
    if (src && !/\*\*\s*inputs\b/.test(src)) {
      for (const k of Object.keys(step.inputs ?? {})) {
        if (!new RegExp(`inputs\\s*(\\[\\s*["']${k}["']\\s*\\]|\\.get\\(\\s*["']${k}["'])`).test(src)) {
          errors.push(`step ${sid}: receives input "${k}" but ${entry} never reads inputs["${k}"]`);
        }
      }
    }
    if (src) dataFlow(sid, step, entry, src, uses);
    if (src) reopenedWorkbook(sid, entry, src);
  };

  /**
   * A step that writes a workbook with foundry.write_xlsx must not re-open it with openpyxl.load_workbook in full
   * mode. That loads every cell as an object: a step wrote ~100k rows, re-opened the file to add a second sheet and
   * ran out of the run's 1024 MB (run 12e1a455, 2026-11-04) — the test had passed on a few invented rows. Several
   * sheets go in ONE write_xlsx call. A load_workbook in a step that never writes one (a small workspace template
   * File opened to keep its formatting) is fine, and so is read_only=True.
   *
   * Comments are dropped first: a comment explaining the rule says the same words as the violation (I-62).
   */
  function reopenedWorkbook(sid, entry, src) {
    const code = src.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "$1")).join("\n");
    if (!/\bwrite_xlsx\s*\(/.test(code)) return;
    for (const m of code.matchAll(/\bload_workbook\s*\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      for (; i < code.length && depth > 0; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")") depth--;
      }
      const args = code.slice(start, depth === 0 ? i - 1 : i);
      if (/\bread_only\s*=\s*True\b/.test(args)) continue;
      errors.push(
        `step ${sid}: ${entry} re-opens a workbook with openpyxl.load_workbook after writing it with foundry.write_xlsx — ` +
          `that loads every cell and runs out of memory on a large report. ` +
          `Write every sheet in one call: foundry.write_xlsx(path, {"Sheet A": rows, "Sheet B": other_rows})`,
      );
      return;
    }
  }

  /**
   * The REVERSE of the two checks above, and of "a foundry.read in the code is in uses": data must reach the code.
   *
   * The runner hands a step exactly the params and inputs it binds and nothing else (flow-runner engine.py), so a key
   * the code reads that nothing binds never has a value — None, its default, or a KeyError — on every run. And a step
   * that lists reads, calls none and is bound no input has no data at all. Both passed this verifier and failed only
   * at run time as "returned empty data", which reads as a question about the test rows (chat 5e491c36, 2026-11-03:
   * a fix turn removed the step's only bindings to get past a check, and the verifier said OK).
   *
   * Comments are dropped first: a comment explaining a binding says the same words as the binding (I-62).
   */
  function dataFlow(sid, step, entry, src, uses) {
    const code = src.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "$1")).join("\n");
    for (const [what, field] of [["inputs", "input"], ["params", "param"]]) {
      if (new RegExp(`\\*\\*\\s*${what}\\b`).test(code)) continue;
      const bound = new Set(Object.keys(step[what] ?? {}));
      const pattern = new RegExp(`\\b${what}\\s*(?:\\[\\s*["']([^"']+)["']\\s*\\]|\\.get\\(\\s*["']([^"']+)["'])`, "g");
      const wanted = new Set([...code.matchAll(pattern)].map((m) => m[1] ?? m[2]));
      for (const k of wanted) {
        if (bound.has(k)) continue;
        const how = field === "input" ? `"<earlier_step>.<output>"` : `"$input.<name>" or a fixed value`;
        errors.push(
          `step ${sid}: ${entry} reads ${what}["${k}"] but the step binds no ${field} "${k}", so it never has a value ` +
            `(None, its default, or an error, on every run) — bind ${field} "${k}" to ${how}` +
            (field === "input" ? `, or call foundry.read(...) in the code for a declared read` : ""),
        );
      }
    }
    // A STARVED step: it lists reads, calls none, and is bound no input. A step that gets its rows through inputs and
    // still lists a read is untidy, not wrong — flagging it was a false positive on a working workflow (a5d432f3).
    // A foundry.read with a computed name cannot be matched, so it counts as a call.
    const called = new Set([...code.matchAll(/foundry\.read\(\s*["']([^"']+)["']/g)].map((m) => m[1]));
    const computed = /foundry\.read\(\s*[^"'\s)]/.test(code);
    if (called.size || computed || Object.keys(step.inputs ?? {}).length) return;
    for (const u of uses) {
      const [kind, ...rest] = String(u).split(":");
      const name = rest.join(":");
      if (kind === "read" && Object.hasOwn(reads, name)) {
        errors.push(
          `step ${sid}: uses lists "read:${name}" but ${entry} never calls foundry.read("${name}") and the step is ` +
            `bound no inputs, so it has no data — call foundry.read("${name}") in the code, or bind its inputs to an ` +
            `earlier step's output`,
        );
      }
    }
  }

  walk(wf.steps, { where: "workflow", loops: [], visible: new Map() });

  // cases — the choices the request describes ("if X do A, otherwise B"), each pointing at the branch path that does
  // it. A choice decided in a step's code is invisible to a reviewer and to the run's record; a choice nobody built is
  // a part of the request silently dropped. Both were measured on one request (2026-10-11).
  if (wf.cases !== undefined) {
    if (!Array.isArray(wf.cases)) errors.push(`cases must be a list of {"says", "path"} — one per choice the request describes`);
    else wf.cases.forEach((c, i) => {
      const at = `case ${i + 1}`;
      if (!c || typeof c !== "object") { errors.push(`${at} must be {"says": "<the choice in the person's words>", "path": "<branch>.<n>" or "<branch>.else"}`); return; }
      unknownKeys(at, c, CASE_KEYS);
      const says = String(c.says ?? "").trim();
      const label = says ? `${at} ("${says}")` : at;
      if (!says) errors.push(`${at} needs "says" — the choice, in the person's words`);
      if (c.missing !== undefined) {
        errors.push(`${label} cannot be built: ${c.missing} — ask the person what to do instead of building around it, then build it as a branch path or remove the case as they answer`);
        return;
      }
      const m = /^([A-Za-z_]\w*)\.(\d+|else)$/.exec(String(c.path ?? ""));
      if (!m) { errors.push(`${label} needs "path": "<branch id>.<path number>" or "<branch id>.else" — the branch path that does it`); return; }
      const arms = branches.get(m[1]);
      if (!arms) { errors.push(`${label} points at "${c.path}", but there is no branch "${m[1]}" — build this choice as a branch step, not inside a step's code`); return; }
      if (m[2] === "else") {
        if (!arms.some((a) => a?.else)) errors.push(`${label} points at ${m[1]}.else, but branch ${m[1]} has no "else" path`);
      } else {
        const n = Number(m[2]);
        if (n < 1 || n > arms.length || arms[n - 1]?.else) errors.push(`${label} points at ${c.path}, but branch ${m[1]} has no condition path ${n} (it has ${arms.filter((a) => !a?.else).length})`);
      }
    });
  }

  for (const name of declaredInputs) {
    if (!received.has(name)) {
      errors.push(`input "${name}" is declared but no step receives it — pass it to the step that uses it: "params": {"${name}": "$input.${name}"}`);
    }
  }

  return { ok: errors.length === 0, errors, stepCount };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = verify();
  if (r.ok) {
    console.log(`VERIFY OK — ${r.stepCount} step(s)`);
    process.exit(0);
  }
  console.error("VERIFY FAIL");
  for (const e of r.errors) console.error(`  - ${e}`);
  process.exit(1);
}
