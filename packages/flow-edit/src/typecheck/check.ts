/**
 * `checkFlow(model, catalogue)` — the TYPED rules (phase 1 task 4/5).
 *
 * ⚠ **Only rules that did not exist before, because they need types, live here**
 * (D-261). Every rule the server already enforces — ids, cycles, dependsOn,
 * unknown binding steps, undeclared inputs, unused steps, the envelope path, the
 * D-22 allowlist, the caps — is WRAPPED on the server and mapped onto the same
 * FT codes (`services/flow-typecheck.ts`), never re-implemented here: two
 * implementations of one rule drift in the direction nobody sees (D-249/D-197).
 * The composite a caller wants is the server's `typecheckFlow`.
 *
 * Report mode (phase 1) only. Nothing reads this to refuse anything yet.
 */
import { pipelineType } from "./signature.js";
import { diag, didYouMean, sortDiagnostics, type Diagnostic } from "./diagnostic.js";
import { applyOnNull, assignable, convert, render, T, type Refinement, type Ty } from "./types.js";
import {
  isCallStep,
  outputOf,
  transformShapeOf,
  portsOf,
  rowOf,
  tyOfFlowInput,
  type CatalogueSnapshot,
  type CheckModel,
  type CheckSource,
  type CheckStep,
  type PortSig,
} from "./signature.js";
import { buildSingleParams, toLegacyInputSpelling, type Mapping } from "../render.js";

const TEMPLATE = /\{\{/;
const INPUT_READ = /\binputs\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every string anywhere inside a step, for the textual reads a template makes. */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
}

export function checkFlow(model: CheckModel, cat: CatalogueSnapshot): Diagnostic[] {
  const out: Diagnostic[] = [];
  const steps = model.steps ?? [];
  const byId = new Map<string, CheckStep>();
  const inputs = new Map((model.inputs ?? []).map((i) => [i.id, i]));

  for (const s of steps) if (!byId.has(s.id)) byId.set(s.id, s);
  const unknownStep = (at: CheckStep, id: string, where: string) =>
    out.push(diag("FT0102", { stepId: at.id }, `${where} names step \`${id}\`, which is not in this flow`, helpFor(id, [...byId.keys()])));

  // ── FT0105 components ────────────────────────────────────────────────────
  for (const s of steps) {
    if (!isCallStep(s)) continue;
    if (portsOf(s, cat) === null) {
      out.push(diag("FT0105", { stepId: s.id }, `\`${s.ref ?? "(no ref)"}\` is not a component in this workspace`, helpFor(s.ref ?? "", Object.keys(cat.refs))));
    }
  }

  // ── FT0901/FT0902 combinator pipelines (compiled-builder 2d) ──────────────
  for (const s of steps) {
    if (s.kind !== "transform" || !Array.isArray(s.pipeline)) continue;
    const r = pipelineType(s, cat, model);
    if (!r) out.push(diag("FT0902", { stepId: s.id }, `the pipeline reads \`${String(s.from ?? "(no from)")}\`, which is not a step of this flow with readable rows`));
    else if (!r.ok) out.push(diag("FT0901", { stepId: s.id }, `stage ${r.at + 1} (${(s.pipeline as Array<{ op: string }>)[r.at]?.op}): ${r.error}`));
  }

  // ── Bindings: FT0201/0202/0203/0204/0207/0208/0209/0301/0304/0401/0402/0501/0602 ─
  const readInputs = new Set<string>();
  for (const s of steps) {
    for (const str of stringsIn(s)) for (const m of str.matchAll(INPUT_READ)) readInputs.add(m[1]!);
    // A branch's typed `test.left` and an approval's typed `context` are bindings
    // too (phase 3 step 4) — a field the upstream does not have is FT0301/FT0302
    // here, not a guard that is quietly never true. `Option<Json>`: only that the
    // read exists and has a shape is checked; what it is compared to is the test's.
    for (const t of typedReadsOf(s))
      checkBinding(out, model, cat, byId, inputs, s, { name: t.port, ty: T.option(T.json()), required: false }, t.source, readInputs);
    if (!isCallStep(s)) continue;
    const ports = portsOf(s, cat);
    const bindings = s.inputs ?? [];
    if (s.over) {
      if (!byId.has(s.over.stepId)) unknownStep(s, s.over.stepId, "fan-out `over`");
      else {
        const src = outputOf(byId.get(s.over.stepId)!, cat, model);
        const inner = src?.t === "Envelope" ? src.of : src;
        const undecided = transformShapeOf(byId.get(s.over.stepId)! as never) === "unknown";
        if (inner && !undecided && inner.t !== "Rows" && inner.t !== "List" && inner.t !== "Opaque" && inner.t !== "Json")
          out.push(diag("FT0207", { stepId: s.id }, `fans out over \`${s.over.stepId}\`, whose output is ${render(inner)}, not a list`));
      }
    }
    if (!bindings.length && s.paramsExpr && s.paramsExpr.trim() !== "[{}]" && s.paramsExpr.trim() !== "{}") {
      out.push(diag("FT0602", { stepId: s.id }, "this step's inputs are one hand-written template, so no input is type-checked", { note: "the `unsafe` block — phase 3 replaces it with typed bindings" }));
      continue;
    }
    if (!ports) continue; // FT0105 already said why
    const bound = new Map(bindings.map((b) => [b.name, b]));
    for (const b of bindings) {
      const port = ports.find((p) => p.name === b.name);
      if (!port && ports.length) {
        out.push(diag("FT0209", { stepId: s.id, port: b.name }, `\`${s.ref}\` has no input \`${b.name}\``, helpFor(b.name, ports.map((p) => p.name))));
        continue;
      }
      if (port && b.source) checkBinding(out, model, cat, byId, inputs, s, port, b.source, readInputs);
    }
    const blobKeys = new Set([...(s.paramsExpr ?? "").matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]!));
    for (const p of ports) {
      const b = bound.get(p.name);
      if (p.required && (!b || !b.source)) {
        // ⚠ `source: null` beside a `paramsExpr` that carries the key is NOT
        // unbound: the value is in the blob, in a shape no Source can express
        // (measured on 3 real revisions — `llm_complete.input`). It is
        // unchecked, which is FT0602 — and the two-representations case I-204.
        if (blobKeys.has(p.name)) {
          out.push(diag("FT0602", { stepId: s.id, port: p.name }, `\`${p.name}\` is carried only by the hand-written template, so its type is unchecked`, { note: `the input expects ${render(p.ty)}` }));
          continue;
        }
        out.push(diag("FT0201", { stepId: s.id, port: p.name }, `required input \`${p.name}\` of \`${s.ref}\` is not bound`, { note: `it expects ${render(p.ty)}` }));
      }
    }
  }

  // ── FT0206 the blob and the bindings disagree (I-204) ────────────────────
  for (const s of steps) {
    const d = blobDisagreement(s, steps, cat);
    if (d)
      out.push(diag("FT0206", { stepId: s.id }, `\`${d.field}\` is hand-written and differs from what this step's bindings render to — the compiler runs the \`${d.field}\` text, so the bindings that were checked are not what runs`, {
        help: `drop \`${d.field}\` so the bindings render, or rebind so they carry what it passes`,
        note: `bindings render: ${clip(d.rendered)} · ${d.field}: ${clip(d.blob)}`,
      }));
  }

  // ── FT0503 recipients a draft run will refuse ─────────────────────────────
  const domains = cat.mailAllowedDomains;
  if (domains?.length) {
    const allowed = (addr: string) => domains.includes(addr.split("@")[1]?.toLowerCase() ?? "");
    for (const s of steps) {
      for (const b of s.inputs ?? []) {
        if (!b.source) continue;
        const port = portsOf(s, cat)?.find((p) => p.name === b.name);
        if (!port || (port.ty.t === "Option" ? port.ty.of : port.ty).t !== "Address") continue;
        const span = { stepId: s.id, port: b.name };
        const note = `MAIL_ALLOWED_RECIPIENT_DOMAINS admits only ${domains.join(", ")}`;
        if (b.source.from === "literal" && b.source.value && !TEMPLATE.test(b.source.value) && !allowed(b.source.value)) {
          // ⚠ compiled-builder 2e: a LITERAL is known at build time, so a refused one is an ERROR (FT0507) — except an RFC 2606
          // reserved address, which a draft run accepts (D-267) and a live one refuses: a warning, the draft-only case.
          const reserved = /\.(example|test|invalid|localhost)$/i.test(b.source.value.split("@")[1] ?? "");
          out.push(reserved
            ? diag("FT0503", span, `\`${b.source.value}\` is a reserved address: a draft run captures it, a live run refuses it`, { note })
            : diag("FT0507", span, `\`${b.source.value}\` is not on an allowed domain, so every send will be refused`, { note }));
        }
        else if (b.source.from === "step" || b.source.from === "whole")
          out.push(diag("FT0503", span, `recipients come from data, and any outside the allowed domains will be refused`, { note }));
      }
    }
  }

  // ── FT0508 an unattended send with no recipient (compiled-builder 2e, D-310) ──
  // A port its receiver fills with the person who started the run (`fallsBackToRequester`, declared per port — I-287), left
  // unbound. A scheduled run has no such person, so on a flow with a schedule every run fails; that is known at build time.
  if ((model as { schedule?: unknown }).schedule) {
    for (const s of steps) {
      if (!isCallStep(s)) continue;
      for (const p of portsOf(s, cat) ?? []) {
        if (!p.fallsBackToRequester || p.required) continue;
        if ((s.inputs ?? []).some((b) => b.name === p.name && b.source)) continue;
        if (typeof s.paramsExpr === "string" && s.paramsExpr.includes(`"${p.name}"`)) continue;
        out.push(diag("FT0508", { stepId: s.id, port: p.name }, `\`${p.name}\` is unset, so it goes to whoever started the run — and this flow runs on a schedule, where nobody did`, { help: `name the recipient (a column, an input, or the author's own address)` }));
      }
    }
  }

  // ── FT0509 a fan-out with no bound (compiled-builder 2e, D-301) ────────────
  // A batch over more than 1000 items is refused at run time (`stepBatchSchema.params.max(1000)`), on data the schema allows —
  // a P7 failure. So the rows a step fans out over must be PROVEN at most 1000: a pipeline whose last count-changing stage is
  // `limit n` with n ≤ 1000.
  for (const s of steps) {
    const overId = s.over?.stepId;
    if (!overId) continue;
    const src = byId.get(overId);
    const p = src && Array.isArray(src.pipeline) ? (src.pipeline as Array<{ op: string; n?: { value?: unknown } }>) : null;
    const lastLimit = p ? p.map((c) => c.op).lastIndexOf("limit") : -1;
    const bounded = !!p && lastLimit >= 0 && Number(p[lastLimit]!.n?.value) <= 1000 && !p.slice(lastLimit + 1).some((c) => c.op === "take");
    if (!bounded) out.push(diag(p ? "FT0509" : "FT0510", { stepId: s.id }, `fans out over \`${overId}\` with no proven bound — more than 1000 items is refused at run time`, { help: `put \`limit\` (at most 1000) at the end of \`${overId}\`'s pipeline, and decide what happens to the rest` }));
  }

  // ── FT0205 (FT0204 — read but undeclared — is `checkDeclaredInputs`, wrapped) ─
  for (const id of inputs.keys()) if (!readInputs.has(id)) out.push(diag("FT0205", { inputId: id }, `flow input \`${id}\` is declared and read by nothing`));

  // ── FT0502 llm output consumed · FT0702 merge (FT0104 is `unused_step`, wrapped) ─
  const CONSUMING = new Set(["transform", "code", "branch", "merge", "datasource", "query"]);
  for (const s of steps) {
    const consumers = steps.filter((o) => o.id !== s.id && consumes(o, s.id));
    if (s.kind === "tool" && cat.refs[s.ref ?? ""]?.modelText)
      for (const c of consumers.filter((c) => CONSUMING.has(c.kind)))
        out.push(diag("FT0502", { stepId: c.id }, `\`${c.id}\` computes on \`${s.id}\`'s model output, which is meant to be read by a person (D-34)`));
    if (s.kind === "merge") {
      const outs = (s.sources ?? []).map((id) => (byId.has(id) ? outputOf(byId.get(id)!, cat, model) : null));
      for (const id of s.sources ?? []) if (!byId.has(id)) unknownStep(s, id, "merge source");
      const known = outs.filter((o): o is Ty => !!o);
      if (known.length > 1 && known.some((o) => JSON.stringify(o) !== JSON.stringify(known[0])))
        out.push(diag("FT0702", { stepId: s.id }, `the sources of \`${s.id}\` produce different types: ${[...new Set(known.map(render))].join(" vs ")}`));
    }
  }

  checkLoops(out, steps);
  return sortDiagnostics(out);
}

/**
 * FT0703 / FT0704 — for each (phase F, D-361). A loop's body is the transitive `dependsOn` closure from it (with an else-if's
 * continuation where its chain's head is), never entering a `collect`. Written here on its own, NOT imported from the engine:
 * this is the oracle the engine's preconditions are tested against, and one shared definition would agree with itself.
 */
function checkLoops(out: Diagnostic[], steps: CheckStep[]): void {
  const loops = steps.filter((s) => s.kind === "for_each");
  if (!loops.length) return;
  const body = new Map<string, string>();
  for (const l of loops) {
    const inside = new Set([l.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of steps) {
        if (inside.has(s.id) || s.kind === "collect") continue;
        if ((s.dependsOn ?? []).some((d) => inside.has(d)) || (s.kind === "branch" && s.elseOf && inside.has(s.elseOf))) { inside.add(s.id); grew = true; }
      }
    }
    for (const id of inside) if (id !== l.id) {
      if (body.has(id)) out.push(diag("FT0703", { stepId: id }, `\`${id}\` is inside two loops (\`${body.get(id)}\`, \`${l.id}\`)`));
      else body.set(id, l.id);
    }
  }
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const reads = (s: CheckStep): string[] => [
    ...(s.dependsOn ?? []),
    ...(typeof s["from"] === "string" ? [s["from"] as string] : []),
    ...(s.over?.stepId ? [s.over.stepId] : []),
    ...(s.sources ?? []),
    ...(s.inputs ?? []).flatMap((b) => (b.source?.stepId ? [b.source.stepId] : [])),
    ...((s["conditions"] as Array<{ left?: { stepId?: string } }> | undefined) ?? []).flatMap((c) => (c.left?.stepId ? [c.left.stepId] : [])),
  ];
  const loopOf = (id: string) => (steps.find((x) => x.id === id)?.kind === "for_each" ? id : body.get(id));
  for (const s of steps) {
    const mine = body.get(s.id);
    // builder-behaviour P5: an approval inside a loop is refused again — Kestra v1.3.29 resumes an execution's FIRST paused task — its resume takes no taskrun id (measured 2026-10-04, phase-5 probe: item 1's rejection landed on item 0).
    if (mine && (s.kind === "for_each" || s.kind === "approval"))
      out.push(diag("FT0703", { stepId: s.id }, s.kind === "for_each" ? `a loop inside the loop \`${mine}\` is not emitted` : `an approval inside the loop \`${mine}\` cannot be delivered to its own item`));
    if (s.kind === "collect") {
      const r = s["result"] as string | undefined;
      if (r && body.get(r) !== s["loop"]) out.push(diag("FT0704", { stepId: s.id }, `the output of \`${String(s["loop"])}\` names \`${r}\`, which is not inside it`));
      continue;
    }
    for (const r of reads(s)) {
      const theirs = loopOf(r);
      if (s.kind === "collect") continue;
      if (theirs && theirs !== mine && !(s.kind === "for_each" && r === s.id))
        out.push(diag("FT0704", { stepId: s.id }, `\`${s.id}\` reads \`${r}\`, which runs once per item of \`${theirs}\` — read the loop's output`));
      else if (mine && !theirs && (index.get(r) ?? -1) > (index.get(mine) ?? -1))
        out.push(diag("FT0704", { stepId: s.id }, `\`${s.id}\` runs inside \`${mine}\` but reads \`${r}\`, which is placed after the loop begins`));
    }
  }
}

/** The typed reads a non-call step carries: a branch's `test.left`, an approval's `context`. */
function typedReadsOf(s: CheckStep): Array<{ port: string; source: CheckSource }> {
  const reads: Array<{ port: string; source: CheckSource }> = [];
  const test = s["test"] as { left?: CheckSource } | null | undefined;
  if (s.kind === "branch" && test?.left && (test.left.from === "step" || test.left.from === "whole")) reads.push({ port: "test", source: test.left });
  const ctx = s["context"] as CheckSource | null | undefined;
  if (s.kind === "approval" && ctx && (ctx.from === "step" || ctx.from === "whole")) reads.push({ port: "context", source: ctx });
  return reads;
}

/** Does step `o` read step `id`, by any route? */
function consumes(o: CheckStep, id: string): boolean {
  if ((o.dependsOn ?? []).includes(id)) return true;
  if (o.over?.stepId === id) return true;
  if ((o.sources ?? []).includes(id)) return true;
  if ((o.inputs ?? []).some((b) => b.source?.stepId === id)) return true;
  if (typedReadsOf(o).some((t) => t.source.stepId === id)) return true;
  if (o.elseOf === id) return true;
  return stringsIn(o).some((s) => s.includes(`outputs.${id}.`) || s === id);
}

function helpFor(word: string, candidates: string[]): { help?: string } {
  const m = word ? didYouMean(word, candidates) : undefined;
  return m ? { help: `did you mean \`${m}\`?` } : {};
}

function checkBinding(
  out: Diagnostic[],
  model: CheckModel,
  cat: CatalogueSnapshot,
  byId: Map<string, CheckStep>,
  inputs: Map<string, NonNullable<CheckModel["inputs"]>[number]>,
  s: CheckStep,
  port: PortSig,
  src: CheckSource,
  readInputs: Set<string>,
): void {
  const span = { stepId: s.id, port: port.name };
  let have: Ty | null = null;
  let from = "";
  switch (src.from) {
    case "literal": {
      const v = String(src.value ?? "");
      if (TEMPLATE.test(v)) {
        for (const m of v.matchAll(INPUT_READ)) readInputs.add(m[1]!);
        // Text whose ONLY templates are `{{ inputs.<id> }}` placeholders is a
        // supported form (spliced with `~` in jq, rendered whole in JSON), so it
        // is a checked read of those inputs — FT0204 names an undeclared one —
        // and its value is Text. Anything else stays FT0602.
        if (v.replace(/\{\{\s*inputs\.[A-Za-z0-9_]+\s*\}\}/g, "").includes("{{") === false) {
          // A day of a month (phase 7, showcase seed): `{{ inputs.m }}-01` where m
          // is a MONTH is a Date — the construction FT0403 already calls safe for
          // days 01–28, since every month has them. Typing it Text refused, as a
          // type error, the exact form the constructed-date check permits. Only a
          // Month-typed input qualifies: over plain Text the checker cannot know it
          // holds a month, so that stays Text.
          const day = /^\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}-(0[1-9]|1\d|2[0-8])$/.exec(v.trim());
          const dayOf = day ? inputs.get(day[1]!) : undefined;
          if (dayOf && tyOfFlowInput(dayOf).t === "Month") {
            const d = assignable(T.date(), port.ty);
            if (!d.ok) out.push(diag("FT0202", span, `this input is a day of a month, and it expects ${render(port.ty)}`, { note: d.detail }));
            return;
          }
          const a = assignable(T.text(), port.ty);
          if (!a.ok) out.push(diag("FT0202", span, `this input is text with flow inputs in it, and it expects ${render(port.ty)}`, { note: a.detail }));
          return;
        }
        out.push(diag("FT0602", span, "this input is a hand-written template, so its type is unchecked", { note: `the input expects ${render(port.ty)}` }));
        return;
      }
      checkLiteral(out, span, v, port);
      return;
    }
    case "input": {
      const decl = src.inputId ? inputs.get(src.inputId) : undefined;
      if (src.inputId) readInputs.add(src.inputId);
      if (!decl) return; // FT0204 reports it once, flow-wide
      have = tyOfFlowInput(decl);
      from = `flow input \`${src.inputId}\``;
      break;
    }
    case "step":
    case "whole": {
      const up = src.stepId ? byId.get(src.stepId) : undefined;
      if (!up) return; // `unknown_binding_step`, wrapped as FT0102
      const upTy = outputOf(up, cat, model);
      if (!upTy) return; // FT0105 on the upstream
      if (upTy.t === "Never") {
        out.push(diag("FT0202", span, `\`${up.id}\` is a \`${up.kind}\` step and produces nothing to read`));
        return;
      }
      if (src.from === "whole") {
        have = upTy.t === "Envelope" ? upTy.of : upTy;
        from = `all of \`${up.id}\``;
        // Serialised to text (`tostring`) the rows never cross as rows — the
        // form the taught `llm_complete` input has always used in production.
        if ((s.kind === "tool" || s.kind === "approval") && src.transform !== "text" && hasTimestamp(have))
          out.push(diag("FT0501", span, `raw rows of \`${up.id}\` carry timestamps and cannot cross into a call body (I-42)`, { help: "put a transform in between that picks the fields and flattens dates to YYYY-MM-DD" }));
        break;
      }
      const row = rowOf(upTy);
      if (row.t === "Opaque" || row.t === "Json") {
        out.push(diag("FT0304", { ...span, field: src.field }, `\`${up.id}\` declares no output shape, so \`${src.field}\` is not checked`));
        have = row.t === "Json" ? T.option(T.json()) : T.opaque();
      } else if (row.t === "Record") {
        const f = src.field ? row.fields[src.field] : undefined;
        if (!f && up.kind === "transform" && !up.outputColumns?.length && up.fields?.length) {
          // The upstream's shape is a DECLARATION (a drafted reshape's
          // `fields`), not a schema — so the finding says whose claim it is.
          out.push(diag("FT0302", { ...span, field: src.field }, `\`${up.id}\` declares no field \`${src.field}\``, {
            ...helpFor(src.field ?? "", up.fields),
            note: `\`${up.id}\` declares: ${up.fields.join(", ")}`,
          }));
          return;
        }
        if (!f) {
          out.push(diag("FT0301", { ...span, field: src.field }, `\`${up.id}\` has no field \`${src.field}\``, {
            ...helpFor(src.field ?? "", Object.keys(row.fields)),
            note: `\`${up.id}\` returns exactly: ${Object.keys(row.fields).join(", ") || "(nothing)"}`,
          }));
          return;
        }
        have = f;
        // ⚠ One field of MANY rows is a LIST unless this step fans out over them:
        // without `over` the compiler renders `[.[] | .f]` (buildSingleParams),
        // so `max_on_hand: Int` received every row's value at once (O2,
        // build:measure r5 — "invalid input syntax for type integer: [67788, …]").
        const inner = upTy.t === "Envelope" ? upTy.of : upTy;
        if ((inner.t === "Rows" || inner.t === "List") && s.over?.stepId !== up.id) {
          have = T.list(f);
          from = `every row's \`${src.field}\` of \`${up.id}\``;
          break;
        }
      } else {
        have = T.opaque();
      }
      from = `\`${up.id}.${src.field}\``;
      break;
    }
    case "self":
      return;
  }
  if (!have) return;
  if (src.transform) {
    const c = convert(have, src.transform);
    if (!c) {
      out.push(diag("FT0202", span, `${from} is ${render(have)}, which the \`${src.transform}\` conversion does not accept`));
      return;
    }
    have = c;
  }
  // D-273: a declared null rule is what makes an Option acceptable (FT0203).
  if (src.onNull) have = applyOnNull(have, src.onNull);
  // ⚠ An OPTIONAL port may be ABSENT; once bound it still needs a value. A
  // bound null is what the validator refuses (`to: Expected string, received
  // null`, Kestra `3VRhNsJO…`) — so the port's own type, never `Option<…>`.
  let r = assignable(have, port.ty);
  if (r.ok) return;
  // One element where the list is, on a port whose receiver wraps it.
  if (port.liftsScalar && port.ty.t === "List") {
    const one = assignable(have, port.ty.of);
    if (one.ok) return;
    r = one;
  }
  const code = r.why === "nullable" ? "FT0203" : r.why === "json_untyped" ? "FT0208" : "FT0202";
  out.push(
    diag(code, span, `${from} is ${render(have)}, but \`${port.name}\` needs ${render(port.ty)}`, {
      ...(r.conversion ? { help: `convert it (${r.conversion})` } : {}),
      note: r.detail,
      // A narrowing (Text → Address) cannot be proven either way statically; the
      // runtime validator is the boundary. Report it, do not block on it. And a
      // scalar rendered as Text is lossless (D-262) — whether the receiving SQL
      // then compares it with a date is that query's declaration, not this edge.
      ...(r.why === "narrowing" || r.conversion === "to-text" ? { severity: "warning" as const } : {}),
    }),
  );
}

function hasTimestamp(ty: Ty): boolean {
  const r = rowOf(ty);
  if (r.t !== "Record") return false;
  return Object.values(r.fields).some((f) => (f.t === "Option" ? f.of : f).t === "DateTime");
}

// ── Literals (FT0401 / FT0402) ─────────────────────────────────────────────

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function validDate(v: string): boolean {
  const m = DATE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

function checkLiteral(out: Diagnostic[], span: { stepId: string; port: string }, v: string, port: PortSig): void {
  const ty = port.ty.t === "Option" ? port.ty.of : port.ty;
  // A literal is ONE value; on a lifting list port it is checked as the element.
  if (port.liftsScalar && ty.t === "List") return checkLiteral(out, span, v, { ...port, ty: ty.of, liftsScalar: false });
  if (v === "") {
    if (port.required) out.push(diag("FT0401", span, `required input \`${port.name}\` is set to an empty value`));
    return;
  }
  const bad = (what: string) => out.push(diag("FT0401", span, `\`${JSON.stringify(v)}\` is not ${what}`, { note: `\`${port.name}\` expects ${render(port.ty)}` }));
  switch (ty.t) {
    case "Int": if (!/^-?\d+$/.test(v)) bad("a whole number"); return;
    case "Number": if (!Number.isFinite(Number(v))) bad("a number"); return;
    case "Bool": if (v !== "true" && v !== "false") bad("true or false"); return;
    case "Month": if (!MONTH.test(v)) bad("a month (YYYY-MM)"); return;
    case "Date": if (!validDate(v)) bad("a date (YYYY-MM-DD)"); return;
    case "DateTime": if (Number.isNaN(Date.parse(v)) || !v.includes("T")) bad("a date-time (ISO 8601)"); return;
    case "Address": if (!ADDRESS.test(v)) bad("an email address"); return;
    case "Key": bad("a row's identity — a key comes from the row it names, never a typed value"); return;
    case "Text":
      for (const r of ty.refine ?? []) checkRefinement(out, span, v, r);
      return;
    default:
      return;
  }
}

function checkRefinement(out: Diagnostic[], span: { stepId: string; port: string }, v: string, r: Refinement): void {
  const fail = (m: string, help?: string) => out.push(diag("FT0402", span, m, help ? { help } : {}));
  switch (r.r) {
    case "SingleLine": if (/[\r\n]/.test(v)) fail(`\`${span.port}\` must be one line`); return;
    case "NonEmpty": if (!v.trim()) fail(`\`${span.port}\` must not be blank`); return;
    case "MaxLen": if (v.length > r.n) fail(`\`${span.port}\` is ${v.length} characters; at most ${r.n}`); return;
    case "OneOf": if (!r.values.includes(v)) fail(`\`${v}\` is not one of ${r.values.join(", ")}`, didYouMean(v, r.values) ? `did you mean \`${didYouMean(v, r.values)}\`?` : undefined); return;
  }
}

// ── FT0206 (I-204) ─────────────────────────────────────────────────────────

/**
 * A feed text that carries nothing — absent, whitespace, or one of the two
 * canonical blanks (`"[{}]"` a call's, `"{}"` a code step's), however spaced.
 * The compiler treats a blank blob as ABSENT (`displayParams`), so a blank
 * beside bindings is not a second representation at all.
 */
export function isBlankFeed(text: string | null | undefined): boolean {
  if (text == null) return true;
  const t = text.replace(/\s+/g, "");
  return t === "" || t === "[{}]" || t === "{}";
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * Do two feed texts pass the same thing? Both JSON → compared as VALUES (key
 * order and spacing are not a disagreement: a model writes `[{"to":"x"}]` where
 * the renderer writes `[{ "to": "x" }]`). Otherwise — a `{{ … | jq(…) }}`
 * program — compared with whitespace removed. ⚠ That is lenient in one
 * direction only: two programs differing solely by a space inside a jq string
 * literal read as agreeing. It never reports a false disagreement.
 */
export function sameFeed(a: string, b: string): boolean {
  // The escaped input spelling and the legacy one pass the same input (I-288) — not a disagreement about what runs.
  a = toLegacyInputSpelling(a);
  b = toLegacyInputSpelling(b);
  try {
    return canonicalJson(JSON.parse(a)) === canonicalJson(JSON.parse(b));
  } catch {
    return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
  }
}

/**
 * I-204: a step carrying BOTH typed `inputs` and a non-blank hand-written blob
 * (`paramsExpr` on a call, `inputExpr` on a `code` step) whose text differs
 * from what the bindings render to. The compiler emits the blob verbatim, so
 * the bindings this checker typed are not what runs.
 *
 * Not FT0206, deliberately:
 *  - a blob with NO bindings — the legacy `unsafe` block, FT0602;
 *  - a binding with `source: null` — the bindings declare themselves partial
 *    (the value is in the blob in a shape no Source expresses), FT0602 per port;
 *  - bindings that do not render (`null`) — there is no second text to compare,
 *    and guessing one would be a second definition of what runs.
 */
export function blobDisagreement(
  s: CheckStep,
  steps: readonly CheckStep[],
  cat: CatalogueSnapshot,
): { field: "paramsExpr" | "inputExpr"; blob: string; rendered: string } | null {
  const field = s.kind === "code" ? "inputExpr" : isCallStep(s) ? "paramsExpr" : null;
  if (!field) return null;
  const blob = s[field];
  if (typeof blob !== "string" || isBlankFeed(blob)) return null;
  const bindings = s.inputs ?? [];
  if (!bindings.length || bindings.some((b) => !b.source)) return null;
  const stripped: CheckStep = { ...s };
  delete stripped[field];
  let rendered: string | null;
  try {
    rendered = cat.renderInputs ? cat.renderInputs(stripped, steps) : fallbackRender(stripped);
  } catch {
    rendered = null;
  }
  if (rendered === null || sameFeed(blob, rendered)) return null;
  return { field, blob, rendered };
}

/**
 * With no compiler render injected: only the case `buildSingleParams` decides
 * without shapes — a call made once, every binding a literal or a flow input.
 * Byte-identical to what `displayParams` renders for that case.
 */
function fallbackRender(s: CheckStep): string | null {
  if (!isCallStep(s) || s.over || (s["params"] && Object.keys(s["params"] as object).length)) return null;
  const bindings = s.inputs ?? [];
  if (bindings.some((b) => b.source?.from !== "literal" && b.source?.from !== "input")) return null;
  return buildSingleParams(bindings.map((b) => ({ param: b.name, source: b.source } as unknown as Mapping)));
}

function clip(t: string): string {
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}
