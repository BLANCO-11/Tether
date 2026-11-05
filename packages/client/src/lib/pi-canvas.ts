/**
 * Forge's workflow as the canvas draws it (2026-10-11): cards with NAMED ports, and links that follow the data.
 *
 * The old canvas drew list order — every node depended on the one before it, through one handle. That hid what a
 * step actually reads: "build summary" reads two outputs of "review attendance" and the loop's counts, and the
 * picture showed one line from the step just before it. Here every binding is a link, from the output it reads to
 * the input that reads it. Where nothing flows between two nodes that run one after the other, a dashed "then" link
 * keeps the order visible. A choice has one exit per path; a loop is a frame around its steps.
 *
 * Pure: no DOM. The component measures the cards and places them by `columns`.
 */
import { kindOf, type PiCondition, type PiStep, type PiWorkflow } from "@/lib/pi-builder";
import { END_ID, START_ID } from "@/lib/canvas-model";

/** The same Start/End ids the rest of the builder selects by. */
export const START = START_ID;
export const END = END_ID;

/** An end of a link: a card's port (`in:<name>`, `out:<name>`, `path:<i>`), or a loop frame's edge. */
export type PortRef = { node: string; port: string };

export type CanvasPort = {
  name: string;
  /** An input: the binding as written (`find.rows`, `$input.week`, `$item.email`). */
  from?: string;
  /** An output: what kind of value, when known. */
  type?: string;
};

export type CanvasPath = { label: "If" | "Else if" | "Otherwise"; when: string; to: string | null };

export type PiCanvasNode = {
  id: string;
  kind: "io" | "code" | "branch" | "approval";
  title: string;
  /** The line under the title: the step id, or for Start/End what the run is given / hands back. */
  sub: string;
  ins: CanvasPort[];
  /** Fixed values the step is given (literal params) — shown as settings, never as links. */
  sets: Array<{ name: string; value: string }>;
  outs: CanvasPort[];
  paths: CanvasPath[];
  /** Enclosing loops, outermost first. */
  loops: string[];
};

export type PiCanvasLink = { from: PortRef; to: PortRef; kind: "data" | "path" | "order"; label?: string };

export type PiCanvasFrame = { id: string; label: string; members: string[]; frames: string[]; depth: number };

export type PiCanvasModel = {
  nodes: PiCanvasNode[];
  links: PiCanvasLink[];
  frames: PiCanvasFrame[];
  /** Node ids per column, left to right; within a column, top to bottom. */
  columns: string[][];
  /** Per column: how many loop frames open before it and close after it (each needs room for its edge). */
  opens: number[];
  closes: number[];
};

/** A loop frame's port, for a link: its left edge (the list it walks) or right edge (its counts). */
export const frameIn = (id: string): PortRef => ({ node: id, port: "frame:in" });
export const frameOut = (id: string): PortRef => ({ node: id, port: "frame:out" });

const OP_WORD: Record<string, string> = { eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "is one of", contains: "contains" };

function conditionWords(c: PiCondition | undefined): string {
  if (!c) return "";
  if ("all" in c) return c.all.map(conditionWords).join(" and ");
  if ("any" in c) return c.any.map(conditionWords).join(" or ");
  if ("not" in c) return `not (${conditionWords(c.not)})`;
  const field = c.value.replace(/^\$\w+\./, "");
  const to = "to" in c ? (Array.isArray(c.to) ? c.to.join(", ") : typeof c.to === "string" ? c.to.replace(/^\$\w+\./, "") : JSON.stringify(c.to)) : "";
  if (c.op === "empty") return `${field} is empty`;
  if (c.op === "not_empty") return `${field} is not empty`;
  return `${field} ${OP_WORD[c.op] ?? c.op} ${to}`;
}

/** A binding the canvas can draw a link for: `$input.<name>` or `<node>.<output>` of a node that exists. */
type Source = { kind: "input"; name: string } | { kind: "node"; node: string; output: string };

/** Built-in outputs a node gives without declaring them (verify.mjs's `visible`). */
const BUILT_IN: Record<string, string[]> = {
  loop: ["count", "succeeded", "failed", "items"],
  branch: ["taken", "why"],
  approval: ["decision", "by", "note", "at"],
};

export function piCanvasModel(workflow: PiWorkflow): PiCanvasModel {
  const steps = workflow.steps ?? [];
  const known = new Map<string, PiStep>();
  const walk = (ns: PiStep[]) => {
    for (const n of ns) {
      known.set(n.id, n);
      walk(n.steps ?? []);
      for (const a of n.branch ?? []) walk(a.steps ?? []);
    }
  };
  walk(steps);

  const sourceOf = (v: unknown): Source | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t.startsWith("$input.")) return { kind: "input", name: t.slice(7) };
    const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(t);
    return m && known.has(m[1]!) ? { kind: "node", node: m[1]!, output: m[2]! } : null;
  };
  const isBinding = (v: unknown) => typeof v === "string" && (v.trim().startsWith("$") || sourceOf(v) !== null);

  const nodes: PiCanvasNode[] = [];
  const byId = new Map<string, PiCanvasNode>();
  const links: PiCanvasLink[] = [];
  const frames: PiCanvasFrame[] = [];
  const columns: string[][] = [];
  const opens: number[] = [];
  const closes: number[] = [];
  const at = (col: number) => {
    while (columns.length <= col) {
      columns.push([]);
      opens.push(0);
      closes.push(0);
    }
  };
  const add = (n: PiCanvasNode, col: number) => {
    at(col);
    columns[col]!.push(n.id);
    nodes.push(n);
    byId.set(n.id, n);
  };
  /** Which outputs of a node something reads — so a choice or an approval shows only the built-ins in use. */
  const read = new Map<string, Set<string>>();
  const noteRead = (v: unknown) => {
    const s = sourceOf(v);
    if (s?.kind === "node") (read.get(s.node) ?? read.set(s.node, new Set()).get(s.node)!).add(s.output);
  };
  for (const n of known.values()) {
    for (const v of [...Object.values(n.params ?? {}), ...Object.values(n.inputs ?? {}), n.foreach, n.approval?.review]) noteRead(v);
    for (const a of n.branch ?? []) for (const v of Object.values(a.set ?? {})) noteRead(v);
  }

  /** Where a link that reads `node.output` starts: a card's output port, or a loop frame's right edge. */
  const fromPort = (s: Source): PortRef =>
    s.kind === "input" ? { node: START, port: `out:${s.name}` } : kindOf(known.get(s.node)!) === "loop" ? frameOut(s.node) : { node: s.node, port: `out:${s.output}` };
  const dataLinksInto = (id: string, ins: CanvasPort[]) => {
    for (const p of ins) {
      const s = sourceOf(p.from);
      if (!s) continue;
      const from = fromPort(s);
      links.push({ from, to: { node: id, port: `in:${p.name}` }, kind: "data", ...(from.port === "frame:out" ? { label: (s as { output: string }).output } : {}) });
    }
  };
  /** What a node's first port is, when a link has to arrive at it (a loop is entered at its frame). */
  const entryOf = (n: PiStep): PortRef => (kindOf(n) === "loop" ? frameIn(n.id) : { node: n.id, port: "in" });
  /** "then" links: only into a node nothing else already leads to, so order never doubles a data line. */
  const orderInto = (target: PortRef, prev: PortRef[], label?: string) => {
    if (links.some((l) => l.to.node === target.node && (l.to.port.startsWith("in") || l.to.port === target.port))) return;
    prev.forEach((p, i) => links.push({ from: p, to: target, kind: "order", ...(label && i === 0 ? { label } : {}) }));
  };

  const stepPorts = (n: PiStep) => {
    const ins: CanvasPort[] = [];
    const sets: Array<{ name: string; value: string }> = [];
    for (const [k, v] of Object.entries(n.inputs ?? {})) ins.push({ name: k, from: String(v) });
    for (const [k, v] of Object.entries(n.params ?? {})) {
      if (isBinding(v)) ins.push({ name: k, from: String(v) });
      else sets.push({ name: k, value: typeof v === "string" ? v : JSON.stringify(v) });
    }
    return { ins, sets };
  };

  /** Lay `seq` out from column `col`, after `prev`; returns [the ports the next node follows, the next free column]. */
  const place = (seq: PiStep[], col: number, prev: PortRef[], loops: string[], enterLabel?: string): [PortRef[], number] => {
    let first = true;
    for (const n of seq) {
      const k = kindOf(n);
      const label = first ? enterLabel : undefined;
      first = false;
      if (k === "loop") {
        at(col);
        opens[col]! += 1;
        const before = nodes.length;
        const framesBefore = frames.length;
        const listFrom = sourceOf(n.foreach);
        if (listFrom) links.push({ from: fromPort(listFrom), to: frameIn(n.id), kind: "data", label: n.foreach!.split(".").pop() });
        else orderInto(frameIn(n.id), prev, label);
        // The loop's first step is entered from the frame's own left edge.
        const [, next] = place(n.steps ?? [], col, [frameIn(n.id)], [...loops, n.id], `each ${n.as ?? "item"}`);
        const inner = nodes.slice(before);
        const last = Math.max(col, next - 1);
        closes[last]! += 1;
        frames.push({
          id: n.id,
          label: `For each ${n.as ?? "item"} in ${n.foreach ?? "?"}`,
          members: inner.map((m) => m.id),
          frames: frames.slice(framesBefore).filter((f) => f.depth === loops.length + 1).map((f) => f.id),
          depth: loops.length,
        });
        prev = [frameOut(n.id)];
        col = next;
      } else if (k === "branch") {
        const arms = n.branch ?? [];
        const outs = [...(n.outputs ?? []), ...BUILT_IN.branch!.filter((o) => read.get(n.id)?.has(o))];
        const node: PiCanvasNode = {
          id: n.id,
          kind: "branch",
          title: n.description ?? "Chooses a path",
          sub: n.id,
          ins: [],
          sets: [],
          outs: outs.map((o) => ({ name: o })),
          paths: arms.map((a, i) => ({
            label: a.else ? "Otherwise" : i === 0 ? "If" : "Else if",
            when: a.else ? "" : conditionWords(a.if),
            to: a.steps?.[0]?.id ?? null,
          })),
          loops,
        };
        add(node, col);
        orderInto({ node: n.id, port: "in" }, prev, label);
        let next = col + 1;
        arms.forEach((a, i) => {
          if (!a.steps?.length) return;
          links.push({ from: { node: n.id, port: `path:${i}` }, to: entryOf(a.steps[0]!), kind: "path" });
          next = Math.max(next, place(a.steps, col + 1, [], loops)[1]);
        });
        // Whatever follows a choice is drawn from the choice itself (its outputs, or "then" once) — never from every
        // path's end, which is a fan of lines saying one thing.
        prev = [{ node: n.id, port: "out" }];
        col = next;
      } else if (k === "approval") {
        const outs = BUILT_IN.approval!.filter((o) => read.get(n.id)?.has(o));
        const ins: CanvasPort[] = n.approval?.review ? [{ name: "review", from: n.approval.review }] : [];
        add(
          { id: n.id, kind: "approval", title: n.approval?.title ?? n.description ?? "Waits for approval", sub: n.id, ins, sets: [], outs: outs.map((o) => ({ name: o })), paths: [], loops },
          col,
        );
        dataLinksInto(n.id, ins);
        orderInto({ node: n.id, port: "in" }, prev, label);
        prev = [{ node: n.id, port: "out" }];
        col += 1;
      } else {
        const { ins, sets } = stepPorts(n);
        add(
          {
            id: n.id,
            kind: "code",
            title: n.description ?? n.id,
            sub: n.id,
            ins,
            sets,
            outs: (n.outputs ?? []).map((o) => ({ name: o })),
            paths: [],
            loops,
          },
          col,
        );
        dataLinksInto(n.id, ins);
        orderInto({ node: n.id, port: "in" }, prev, label);
        prev = [{ node: n.id, port: "out" }];
        col += 1;
      }
    }
    return [prev, col];
  };

  const inputs = Object.entries(workflow.inputs ?? {});
  const sched = workflow.schedule ? `Runs ${workflow.schedule.cron}${workflow.schedule.timezone ? ` · ${workflow.schedule.timezone}` : ""}` : "Started by hand";
  add({ id: START, kind: "io", title: "Start", sub: sched, ins: [], sets: [], outs: inputs.map(([n, d]) => ({ name: n, type: d?.type })), paths: [], loops: [] }, 0);
  const [ends, nextCol] = place(steps, 1, [{ node: START, port: "out" }], []);

  // End: what the last node hands back.
  const last = steps[steps.length - 1];
  const endIns: CanvasPort[] = last && kindOf(last) === "step" ? (last.outputs ?? []).map((o) => ({ name: o, from: `${last.id}.${o}` })) : [];
  add({ id: END, kind: "io", title: "End", sub: last ? "What the run hands back" : "Nothing yet", ins: endIns, sets: [], outs: [], paths: [], loops: [] }, nextCol);
  dataLinksInto(END, endIns);
  if (last && !endIns.length) orderInto({ node: END, port: "in" }, ends);

  // Output ports anything reads but the node did not list (a step that declares nothing yet) still get a port, so no link dangles.
  for (const l of links) {
    const n = byId.get(l.from.node);
    if (!n || !l.from.port.startsWith("out:")) continue;
    const name = l.from.port.slice(4);
    if (!n.outs.some((o) => o.name === name)) n.outs.push({ name });
  }
  return { nodes, links, frames, columns, opens, closes };
}

/** An input's source in words, for the hover note: "rows of find", "the run's input week", "email of the current person". */
export function fromWords(binding: string | undefined, model?: PiCanvasModel): string {
  if (!binding) return "";
  const t = binding.trim();
  if (t.startsWith("$input.")) return `the run's input ${t.slice(7)}`;
  if (t === "$index") return "the item's number in the loop";
  const loop = /^\$([A-Za-z_]\w*)(?:\.(.+))?$/.exec(t);
  if (loop) return loop[2] ? `${loop[2]} of the current ${loop[1]}` : `the current ${loop[1]}`;
  const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(t);
  if (m) {
    const title = model?.nodes.find((n) => n.id === m[1])?.id ?? m[1];
    return `${m[2]} of ${title}`;
  }
  return t;
}
