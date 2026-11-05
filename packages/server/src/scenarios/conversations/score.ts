/**
 * The corpus harness's PURE half (`builder-converse.ts` drives the builder; this decides, with no database, model or engine): how
 * a scripted person answers a question, and whether a finished conversation met what its entry expects. Kept apart so a test can
 * import it — a scenario script runs its `main()` on import.
 *
 * ⚠ The person never answers for themselves beyond what the conversation and the shared defaults say (P5-I1). A question nothing
 * here answers is "leave it", and the conversation FAILS on it: a person was asked something the goal already said, or something
 * nobody can answer.
 */

export interface Reply { when: string; say: string }
export interface Conversation {
  id: string;
  workspace: string;
  kinds: string[];
  goal: string;
  replies: Reply[];
  then?: string[];
  /** Values for the run's declared inputs, when a draft run needs one the build left open. */
  runInputs?: Record<string, string>;
  expect: {
    outcome: "complete" | "gap"; maxQuestions: number; has?: string[]; truth?: string;
    /**
     * Words the flow's TESTS must carry — one per condition the person stated ("budget", "high", "active"). Met wherever the flow
     * applies it: a branch, a filter step, a written read's filters, or the saved reader it chose. Where the condition lives is
     * the builder's choice; THAT it is applied, on the right thing, is the expectation (2026-10-02: a shape word like `branch`
     * failed a correct flow whose read kept only the matching rows, and would pass a wrong one).
     */
    tests?: string[];
  };
}

export interface Asked { holeId: string; ask: string; options?: string[] }
/** How a question was answered — `by` says which rule did it, so a result can be read for the person's real words vs defaults. */
export interface Answer { say: string; by: "reply" | "default:assumptions" | "default:recipient" | "default:month" | "unanswered" }

/** The person every conversation is: their address is the corpus's test mailbox (README). */
export const DEFAULT_PERSON = "foundry-test-ops@microland.com";
const ASSUMPTIONS = /^(By “|I read these|Please confirm how I read)/;
const RECIPIENT = /\b(who should (get|receive)|recipient|which address|e-?mail address|send it to|who gets)\b/i;
const MONTH_NAMES = "january|february|march|april|may|june|july|august|september|october|november|december";
/** The month a goal names, as it says it ("august 2026"), or null. */
export function goalMonth(goal: string): string | null {
  return new RegExp(`\\b(${MONTH_NAMES})\\s+\\d{4}\\b`, "i").exec(goal)?.[0] ?? null;
}

/**
 * The scripted person's answer. Order: the conversation's own `replies` (first whose `when` matches, unused ones first), then the
 * shared defaults (`README.md`), else unanswered.
 */
export function answerFor(q: Asked, c: Conversation, used: Set<number>): Answer {
  // Whole words (2026-10-02): "who" matched "whose" in a confirmation question, and the harness answered it with an address.
  const matches = c.replies.map((r, i) => ({ r, i })).filter(({ r }) => new RegExp(`\\b(?:${r.when})\\b`, "i").test(q.ask));
  const pick = matches.find(({ i }) => !used.has(i)) ?? matches[0];
  if (pick) { used.add(pick.i); return { say: pick.r.say, by: "reply" }; }
  if (ASSUMPTIONS.test(q.ask)) return { say: "yes", by: "default:assumptions" };
  if (RECIPIENT.test(q.ask)) return { say: DEFAULT_PERSON, by: "default:recipient" };
  const runMonth = (q.options ?? []).find((o) => /^the month it runs/i.test(o));
  if (runMonth || /\b(which|what) month\b/i.test(q.ask)) {
    const named = goalMonth([c.goal, ...(c.then ?? [])].join(" "));
    if (named) return { say: named, by: "default:month" };
    if (runMonth) return { say: runMonth, by: "default:month" };
  }
  return { say: "leave it", by: "unanswered" };
}

/**
 * Values for a draft run's declared inputs the build left open: the value a REAL run would have today (a date → today, a month →
 * this month) — never a value from the goal, which would make a run-time question look answered. Unknown types are left out
 * and the run says which.
 */
export interface DeclaredInput { id: string; type?: string; defaults?: string; computed?: unknown; required?: boolean; format?: string }
export function runInputsFor(declared: DeclaredInput[], given: Record<string, string>, today: Date): { inputs: Record<string, string>; filled: string[]; missing: string[] } {
  const inputs = { ...given }, filled: string[] = [], missing: string[] = [];
  const day = today.toISOString().slice(0, 10);
  for (const d of declared) {
    if (inputs[d.id] !== undefined || d.defaults !== undefined || d.computed !== undefined || d.required === false) continue;
    const t = (d.type ?? "").toUpperCase();
    if (t === "DATE") { inputs[d.id] = day; filled.push(`${d.id}=${day}`); }
    else if (t === "STRING" && d.format === "month") { inputs[d.id] = day.slice(0, 7); filled.push(`${d.id}=${day.slice(0, 7)}`); }
    else missing.push(d.id);
  }
  return { inputs, filled, missing };
}

/** A comparison as lowered jq writes it: `(.field OP literal-or-field)`. */
const COMPARISON = /\(\.([A-Za-z_][A-Za-z0-9_]*) (==|!=|<=|>=|<|>) ("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|\.[A-Za-z_][A-Za-z0-9_]*)\)/g;

/**
 * What a flow TESTS, as lower-case text, for scoring only: every comparison a transform applies, every branch condition, a
 * written read's tests (`readTests`), the literal values a READ is called with, and the definitions of the saved readers it
 * uses (`readerDefs`, ref → their filters or WHERE). Projection is left out — a field shown is not a field tested.
 */
/**
 * What a read's form TESTS, for scoring only: its filters and having, the filters of its summary joins (they choose which related
 * rows are counted), and its INNER joins (a row with no match is dropped). A left join keeps every row, so it tests nothing.
 */
export function readTests(spec: unknown): string {
  const sp = (spec ?? {}) as {
    filters?: unknown;
    having?: unknown;
    joins?: Array<{ kind?: string }>;
    aggregateJoins?: Array<{
      table?: string;
      filters?: unknown;
      aggregates?: Array<{
        compute?: {
          caseWhen?: {
            arms?: Array<{ right?: { number?: number }; then?: { number?: number } }>;
            else?: { number?: number };
          };
        };
      }>;
    }>;
  };
  // Band CASE edges/weights are tests of the data (same role as filters) — they live in
  // aggregateJoins[].aggregates[].compute.caseWhen, not in filters.
  const bandEdges: number[] = [];
  for (const j of sp.aggregateJoins ?? []) {
    for (const a of j.aggregates ?? []) {
      for (const arm of a.compute?.caseWhen?.arms ?? []) {
        if (typeof arm.right?.number === "number") bandEdges.push(arm.right.number);
        if (typeof arm.then?.number === "number") bandEdges.push(arm.then.number);
      }
      if (typeof a.compute?.caseWhen?.else?.number === "number") bandEdges.push(a.compute.caseWhen.else.number);
    }
  }
  return JSON.stringify({
    f: sp.filters,
    h: sp.having,
    j: (sp.joins ?? []).filter((j) => j.kind === "inner"),
    a: (sp.aggregateJoins ?? []).map((a) => ({ t: a.table, f: a.filters })),
    ...(bandEdges.length ? { bands: bandEdges } : {}),
  });
}

export function testedText(model: unknown, readerDefs: Record<string, string> = {}): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (typeof o.kind === "string" && typeof o.id === "string") {
      if (typeof o.expr === "string") for (const m of o.expr.matchAll(COMPARISON)) out.push(`${m[1]} ${m[2]} ${m[3]}`);
      if (o.kind === "branch") out.push(JSON.stringify({ c: o.conditionExpr, t: o.test, cs: o.conditions }));
      if (o.sqlSpec) out.push(readTests(o.sqlSpec));
      // A literal given to a READ chooses its rows; one given to an action (a subject line, a format) tests nothing.
      if (Array.isArray(o.inputs) && (o.kind === "query" || o.kind === "datasource")) for (const b of o.inputs as Array<{ name?: string; source?: { from?: string; value?: unknown } }>) if (b.source?.from === "literal") out.push(`${b.name}=${String(b.source.value)}`);
      if (typeof o.ref === "string" && readerDefs[o.ref]) out.push(readerDefs[o.ref]!);
    }
    Object.values(o).forEach(walk);
  };
  walk(model);
  return out.join("\n").toLowerCase();
}

/** The step kinds and tool refs anywhere in a saved model — arms, loop bodies and all. */
export function modelParts(model: unknown): { kinds: string[]; refs: string[]; scheduled: boolean } {
  const kinds: string[] = [], refs: string[] = [];
  let scheduled = false;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (typeof o.kind === "string" && typeof o.id === "string") {
      kinds.push(o.kind);
      if (typeof o.ref === "string") refs.push(o.ref);
    }
    if ((o.schedule && typeof o.schedule === "object") || typeof o.cron === "string") scheduled = true;
    Object.values(o).forEach(walk);
  };
  walk(model);
  return { kinds, refs, scheduled };
}

/**
 * What a `has` word means, for scoring only. Actions are recognised by WHAT THE TOOL DOES as its ref says it — this is the
 * scorer reading a result, never builder logic (the builder may not key on a tool's name; a test reading the outcome may).
 */
const HAS: Record<string, (p: ReturnType<typeof modelParts>) => boolean> = {
  branch: (p) => p.kinds.includes("branch"),
  loop: (p) => p.kinds.includes("for_each"),
  approval: (p) => p.kinds.includes("approval"),
  schedule: (p) => p.scheduled,
  email: (p) => p.refs.some((r) => /mail/i.test(r)),
  ticket: (p) => p.refs.some((r) => /ticket/i.test(r)),
  chat: (p) => p.refs.some((r) => /chat/i.test(r)),
  page: (p) => p.refs.some((r) => /page/i.test(r)),
};

export interface Outcome {
  id: string;
  workspace: string;
  status: string;
  questions: number;
  calls: number;
  seconds: number;
  asked: Array<Asked & { answer: Answer }>;
  unmet: string[];
  readback: string[];
  parts?: ReturnType<typeof modelParts>;
  /** What the flow tests (`testedText`) — read against `expect.tests`. */
  tested?: string;
  run?: { state: string; rows?: number; note?: string };
  /** For a build that did not complete: what the spec held and what the solver could not do — read from the working copy. */
  diag?: { values?: unknown; conditions?: unknown; sources?: unknown; gaps?: unknown; holes?: unknown; inputs?: unknown; steps?: unknown };
  error?: string;
}

/** Did the conversation meet its expectation? Each failure is a sentence — the result is read, not just counted. */
export function verdict(c: Conversation, o: Outcome): string[] {
  const why: string[] = [];
  if (o.error) why.push(`threw: ${o.error}`);
  const unanswered = o.asked.filter((a) => a.answer.by === "unanswered");
  if (unanswered.length) why.push(`asked what nobody answers: ${unanswered.map((a) => `“${a.ask.split("\n")[0]!.slice(0, 120)}”`).join("; ")}`);
  if (c.expect.outcome === "complete" && o.status !== "complete") why.push(`ended ${o.status}, expected complete`);
  if (c.expect.outcome === "gap") {
    if (o.status === "complete") why.push("built it — the data cannot give it, so it must be a stated gap");
    else if (!o.unmet.length && !o.readback.some((l) => /not available|nothing here|cannot give|not in the data/i.test(l))) why.push(`ended ${o.status} without stating the gap`);
  }
  if (o.questions > c.expect.maxQuestions) why.push(`${o.questions} questions, at most ${c.expect.maxQuestions} expected`);
  if (o.status === "complete" && o.parts) for (const h of c.expect.has ?? []) if (HAS[h] && !HAS[h]!(o.parts)) why.push(`no ${h} in the flow`);
  // `a|b`: the data holds the thing under either name (two columns that both mean it) — either one tested meets it.
  if (o.status === "complete" && o.tested !== undefined) for (const w of c.expect.tests ?? []) if (!w.toLowerCase().split("|").some((x) => o.tested!.includes(x))) why.push(`no step tests “${w}”`);
  if (o.run && !/^(SUCCESS|PAUSED|skipped)/.test(o.run.state)) why.push(`draft run ${o.run.state}${o.run.note ? `: ${o.run.note}` : ""}`);
  return why;
}
