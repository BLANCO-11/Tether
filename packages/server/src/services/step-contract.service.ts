import { z } from "zod";
import { config } from "../config/index.js";
import { inputNamesRead, stepNamesRead } from "./flow-input-refs.js";
import type { FlowModel } from "./flow-compiler.service.js";

/**
 * Step contracts — what a `code` fragment is generated FROM, and judged against.
 * archive/kestra-migration/04-generation-model.md §5.3 · 06 §6.7 · 02 R9
 *
 * ── The measured failure this exists to make inexpressible ───────────────────
 *
 * One of three generated scripts *"hardcoded `period="2023-10"`, emailed 0 of
 * 11, and still exited 0 with `tests_passed=true` and audit `clean`."*
 *
 * It hardcoded a date **because it needed a period, the period was not in its
 * inputs, and it had no way to say so.** One output channel plus an
 * unsatisfiable contract equals an invented value. That is not a model defect
 * to be prompted away; it is the only move the interface left.
 *
 * So this module does two things, and the second is the important one:
 *
 *  1. It builds a prompt from the CONTRACT ALONE — ~50 tokens of shapes, not
 *     the 8.3 KB of boilerplate plus 14 KB of manifest a monolithic generation
 *     sees. The fragment does not learn the automation's goal, its sibling
 *     steps, the tenant's schema or the tool catalogue, so it cannot reference
 *     any of them (assertion 18).
 *  2. It gives the generator a **second output channel**: `insufficient_contract`.
 *     A refusal is a first-class SUCCESSFUL response, not an error. It says
 *     which field is missing, it arrives at generation time before anything
 *     executes, and it routes to a flow-level redraft (triage level 0) rather
 *     than a fragment regeneration — because no amount of regenerating fixes a
 *     step whose inputs are insufficient.
 *
 * **Any fragment prompt that offers only "produce code" is misconfigured.**
 * That is precisely the condition under which a model invents a value, and it
 * is the one rule in this file that must not be relaxed for convenience.
 */

// ── The contract ─────────────────────────────────────────────────────────────

/**
 * Deliberately coarse. The point of a declared shape here is to tell a
 * generator what it may assume and to let the wrapper check what came back —
 * not to be a type system. A richer vocabulary would mostly produce contracts
 * that disagree with the JSON that actually arrives.
 */
export type ContractType = "string" | "number" | "boolean" | "object" | "array" | "any";

/**
 * The machine shape of a string contract field — what the characters MEAN,
 * not just that they are a string. Without it, "this string is a YYYY-MM-DD
 * date" lives in prose (or nowhere), and month-from-DATE derivation is
 * prose-lottery: the same contract sometimes slices, sometimes refuses
 * demanding a `*_format` input. Measured 2026-09-15 (thread 80b119b1):
 * fetch.period → derive_month.month with no derive step, filed applied.
 *
 * Values mirror `FeederFormat` in `flow-input-compat.ts` (same four names,
 * same meanings) so a DATE input → date-shaped contract → month-shaped
 * output maps cleanly onto the feeder conversions the chat rule synthesizes:
 *   date     = YYYY-MM-DD (a flow DATE input arrives in this shape)
 *   month    = YYYY-MM (a month-format feeder parameter wants this shape)
 *   datetime = ISO timestamp (a flow DATETIME input arrives in this shape)
 *   text     = plain prose (the default; absent means this)
 * Only meaningful on `string` fields; carried (and ignored) elsewhere so a
 * drafter that annotates broadly does not fail the turn on shape alone.
 */
export type ContractFormat = "date" | "month" | "datetime" | "text";

export interface ContractField {
  name: string;
  type: ContractType;
  /** One clause. It is read by a model, not rendered in a UI. */
  description?: string;
  /** Element shape, for `array` — the difference between rows and ids. */
  items?: ContractType;
  /** String shape, for `string` — lets the fragment slice without refusing. */
  format?: ContractFormat;
  /**
   * The keys of an `object`, or of each element of an `array<object>` (phase 5,
   * D-254). DERIVED from the upstream step's typed output, never authored — so
   * a fragment is told the row it will get instead of refusing for "not which
   * fields each element contains" (F1) or guessing a column name.
   */
  fields?: ContractField[];
  /** The upstream value may be null. Derived, like `fields`. */
  nullable?: boolean;
}

export interface StepContract {
  stepId: string;
  /** What arrives as `payload`. If a value is not here, the fragment cannot have it. */
  input: ContractField[];
  /** What `run()` must return. The wrapper asserts these keys before the value leaves. */
  output: ContractField[];
  /**
   * What the step is for, in one sentence — *"compute attendance variance"*.
   *
   * NOT the automation's goal. "Email everyone below the threshold and file
   * tickets for repeat offenders" tells the fragment about steps it cannot
   * reach and side effects it cannot perform, which is how a pure function
   * starts trying to send mail.
   */
  purpose: string;
}

/**
 * Type names that mean one of ours, written the way another language spells it.
 *
 * ── Why this is a normalisation and not a leniency ───────────────────────────
 *
 * A drafter writing `"type": "integer"` has not made a design mistake; it has
 * used a synonym. Rejecting it costs an entire redraft — measured at ~30 s of
 * decode, re-emitting the whole flow — and the redraft frequently reintroduces
 * something else. `contract.input.2.type — Invalid enum value … received
 * 'integer'` was one of four findings that failed a real draft on attempt 1.
 *
 * ⚠ The bound matters: this maps a NAME to a name. It never guesses at
 * STRUCTURE. `valueExpr` is not normalised to `expr` and `llm_complete` is not
 * normalised to `{kind:"tool", ref:"llm_complete"}`, because both would be this
 * module deciding what the drafter meant about the flow's shape — and a wrong
 * guess there produces a step that compiles and does the wrong thing. A type
 * synonym has exactly one reading.
 *
 * The prompt states the six canonical names anyway (`STEP SHAPES`), so this is
 * the safety net and not the teaching.
 */
const TYPE_SYNONYMS: Record<string, ContractType> = {
  int: "number",
  integer: "number",
  long: "number",
  float: "number",
  double: "number",
  decimal: "number",
  bool: "boolean",
  str: "string",
  text: "string",
  list: "array",
  dict: "object",
  map: "object",
  json: "object",
  null: "any",
  unknown: "any",
};

const contractTypeSchema = z.preprocess(
  (v) => (typeof v === "string" ? (TYPE_SYNONYMS[v.toLowerCase()] ?? v.toLowerCase()) : v),
  z.enum(["string", "number", "boolean", "object", "array", "any"]),
);

export const contractFieldSchema: z.ZodType<ContractField> = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z][a-z0-9_]*$/),
  type: contractTypeSchema,
  description: z.string().max(300).optional(),
  items: contractTypeSchema.optional(),
  // Optional so every existing contract still parses byte-identically; when
  // present it is machine shape, not prose. `text` is the default and renders
  // like absent — old prompts are unchanged.
  format: z.enum(["date", "month", "datetime", "text"]).optional(),
  fields: z.lazy(() => z.array(contractFieldSchema).max(64)).optional(),
  nullable: z.boolean().optional(),
}) as z.ZodType<ContractField>;

export const stepContractSchema = z.object({
  stepId: z.string().min(1).max(63),
  input: z.array(contractFieldSchema).max(32),
  output: z.array(contractFieldSchema).min(1).max(32),
  purpose: z.string().min(1).max(500),
});

// ── The generator's two response channels ────────────────────────────────────

export interface FragmentOk {
  status: "ok";
  /** A Python function body defining `run(payload)`. */
  code: string;
}

/**
 * The refusal. §6.7's *"single most valuable change in the triage design"*.
 *
 * `missing` is the diagnosis and it names the fix: `["period"]` tells the
 * redraft to have an upstream step supply `period`, or to make it a flow input.
 * Compare "step 3 failed", which tells a human to go and read three steps.
 */
export interface FragmentRefusal {
  status: "insufficient_contract";
  missing: string[];
  reason: string;
}

export type FragmentResponse = FragmentOk | FragmentRefusal;

const fragmentResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), code: z.string().min(1).max(64_000) }),
  z.object({
    status: z.literal("insufficient_contract"),
    missing: z.array(z.string().min(1).max(63)).min(1).max(16),
    reason: z.string().min(1).max(1000),
  }),
]);

export class FragmentContractError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
  ) {
    super(message);
    this.name = "FragmentContractError";
  }
}

// ── What a fragment may import ───────────────────────────────────────────────

/**
 * The importable set, and it is the base image's set — `config.kestra.fragmentImage`.
 * 04 §5.3.2
 *
 * Named in the prompt AND enforced by `validateFragment`, and both halves earn
 * their place. Without the prompt the model reaches for `requests` and you get
 * an `ImportError` that reads like a code bug rather than a misconfiguration.
 * Without the check you find out at execution, one deploy later.
 *
 * `os`, `sys`, `subprocess`, `socket`, `pathlib`, `urllib`, `requests` and
 * friends are absent on purpose. Under R9 a fragment is a pure function: it has
 * no network (V1) and no credentials, so an import of any of them is either
 * dead weight or an attempt at something the contract does not cover. Rejecting
 * at generation time turns that into a regeneration instead of a mystery.
 */
export const ALLOWED_IMPORTS = [
  "json",
  "math",
  "re",
  "datetime",
  "decimal",
  "collections",
  "itertools",
  "functools",
  "statistics",
  "typing",
  "pandas",
  "numpy",
] as const;

const ALLOWED = new Set<string>(ALLOWED_IMPORTS);

/** `import x`, `import x as y`, `from x import …`, `from x.y import …`. */
const IMPORT_RE = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*))/gm;

// ── The prompt ───────────────────────────────────────────────────────────────

function renderField(f: ContractField, indent = "  "): string {
  const t = f.type === "array" && f.items ? `array<${f.items}>` : f.type;
  // Machine shape, not prose: only date/month/datetime render — `text` and
  // absent are the default and stay byte-identical to the old prompt (existing
  // tests pin the prefix). A DATE input's YYYY-MM-DD shape is what lets the
  // fragment slice `[:7]` for a month without refusing for a `*_format` input.
  const shape =
    f.format === "date"
      ? " (date YYYY-MM-DD)"
      : f.format === "month"
        ? " (month YYYY-MM)"
        : f.format === "datetime"
          ? " (datetime ISO)"
          : "";
  const line = `${indent}${f.name}: ${t}${shape}${f.nullable ? " or null" : ""}${f.description ? `   # ${f.description}` : ""}`;
  // `fields` renders as an indented block under the field — absent renders
  // nothing, so a contract without it is byte-identical to before.
  if (!f.fields?.length) return line;
  const head = f.type === "array" ? `${indent}  each element has exactly these keys:` : `${indent}  with exactly these keys:`;
  return [line, head, ...f.fields.map((c) => renderField(c, `${indent}    `))].join("\n");
}

/**
 * The whole prompt for one fragment.
 *
 * ── Block order is load-bearing, and for a different reason than usual ───────
 *
 * The monolithic prompt puts `TASK` LAST so the ~8.3 KB of boilerplate forms a
 * cacheable prefix (measured: shared prefix 292 → 8,322 chars). That ordering
 * is preserved here — rules first, contract last — but the payoff is different:
 * a fragment prompt is a few hundred tokens, so the win is not caching, it is
 * that **every fragment in a flow shares a byte-identical prefix** and differs
 * only in its final block. That is what makes "three code steps produced three
 * independent generations" checkable by diffing prompts (assertion 18).
 *
 * What is NOT in here, and must never be added for "context":
 *   the automation's goal · the manifest · sibling steps · the tenant's schema
 *   · the tool catalogue · any credential or secret NAME.
 * Every one of those is a way for a fragment to reference something it cannot
 * reach, and each is a measured failure mode (04 §5.3).
 */
export function buildFragmentPrompt(contract: StepContract): string {
  const inputs = contract.input.length
    ? contract.input.map((f) => renderField(f)).join("\n")
    : "  (nothing — this step receives an empty object)";

  return [
    `You are writing ONE Python function. Nothing else runs; nothing else is available.`,
    ``,
    `RULES`,
    `  * Define exactly: def run(payload): ...`,
    `  * \`payload\` is a dict with exactly the INPUT fields below. There is no other source of data.`,
    `  * Return a dict with exactly the OUTPUT fields below. Extra keys are allowed; missing ones fail.`,
    `  * Pure function. No I/O of any kind: no network, no files, no database, no environment,`,
    `    no printing. The container has no network interface and no credentials, so an attempt`,
    `    fails at runtime rather than doing something surprising.`,
    `  * Importable, and nothing else: ${ALLOWED_IMPORTS.join(", ")}.`,
    `  * A shape in parens after a field's type is machine truth, not a hint: date YYYY-MM-DD is ten characters, month YYYY-MM seven, datetime ISO an ISO timestamp. Deriving one shape from another in Python is expected work, not invention — e.g. month equals payload date sliced to seven characters from a date-shaped input satisfies a month-shaped output. Do NOT refuse for a period_format-style input when the shape you need is already in INPUT under a convertible shape.`,
    `  * Do not invent a value you were not given. If a date, a period, a threshold or a`,
    `    default is needed and is not in INPUT, you MUST refuse — see RESPONSE below.`,
    ``,
    `RESPONSE — reply with ONE json object, no prose, no markdown fence.`,
    ``,
    `  If you can satisfy the contract:`,
    `    {"status": "ok", "code": "def run(payload):\\n    ..."}`,
    ``,
    `  If you CANNOT — because something you need is not in INPUT:`,
    `    {"status": "insufficient_contract",`,
    `     "missing": ["period"],`,
    `     "reason": "cannot compute a monthly window; no date field in declared input"}`,
    ``,
    `  A refusal is a correct and useful answer, not a failure. It is how the step's`,
    `  boundary gets fixed. Guessing a value instead is the one unrecoverable mistake:`,
    `  it produces code that runs, passes its tests, and is wrong.`,
    ``,
    // TASK last — see the block-order note above.
    `TASK`,
    `  purpose: ${contract.purpose}`,
    ``,
    `  INPUT (payload)`,
    inputs,
    ``,
    `  OUTPUT (return value)`,
    contract.output.map((f) => renderField(f)).join("\n"),
    // ⚠ A nested `fields` block reads as the return value's OWN keys — r12 R10
    // declared `result: object` with keys `count`, and the fragment returned
    // `{"count": …}`, failing the wrapper's key check. Name the top level
    // outright, only when something is nested, so other prompts are unchanged.
    ...(contract.output.some((f) => f.fields?.length)
      ? [`  The returned dict's TOP-LEVEL keys are exactly: ${contract.output.map((f) => f.name).join(", ")} — the nested keys go INSIDE them.`]
      : []),
  ].join("\n");
}

/**
 * The upstream columns a fragment may assume, in the contract's own words (F1).
 *
 * A code step over an operation's rows used to be generated from its contract
 * alone, which names the payload fields but never the COLUMNS the upstream
 * projection carries — so the fragment guessed (`.customer_email` off an
 * operation projecting `customer_id`, a real failed run; `compute_figures`
 * refusing over `missing: ["row schema", "amount units/scale"]`). The catalogue
 * line the drafter sees (`operationLine`) already renders those columns for
 * exactly this; the fragment prompt cannot see that line — `buildFragmentPrompt`
 * carries no catalogue, no goal, no siblings — so the column list is COPIED
 * into the contract's input descriptions here. Stored metadata, never an
 * invented value.
 *
 * ⚠ SAME source, not a second one: `refInterfaces` derives `columns` from the
 * same `specJson.columns[].alias` `operationLine` renders
 * (`manifest-builder.service.ts`), and says nothing when a ref declares none
 * (a tool, a named query, an operation with no projection) — the contract then
 * passes through untouched, same reference back.
 *
 * ⚠ What this does NOT carry, and why. A `specJson` column entry is
 * `{column, alias}` and nothing else — there is no per-column unit or
 * description metadata anywhere in storage to copy. The units signal the
 * aliases themselves carry (`budget_amount_major` is major, `invoice_cents`
 * and `claim_cents` are minor) travels verbatim in the list; anything more
 * explicit would be an interpretation, not a copy.
 *
 * ⚠ PROMPT-TIME ONLY. Both callers — the chat turn's owed loop and the draft's
 * fragment loop — key refusals on the DECLARED contract and store the drafted
 * model untouched, so the declared boundary never moves. Only the copy
 * `generateFragment` sees carries the longer descriptions.
 */
export function enrichContractWithColumns(
  contract: StepContract,
  model: FlowModel,
  interfaces: Record<string, { columns?: string[] }>,
): StepContract {
  const step = model.steps.find((s) => s.id === contract.stepId);
  const inputExpr =
    step && "inputExpr" in step && typeof step.inputExpr === "string" ? step.inputExpr : null;
  if (!inputExpr) return contract;
  const notes: string[] = [];
  for (const upstreamId of stepNamesRead(inputExpr)) {
    const upstream = model.steps.find((s) => s.id === upstreamId);
    const ref =
      upstream && "ref" in upstream && typeof upstream.ref === "string" ? upstream.ref : null;
    const columns = ref ? interfaces[ref]?.columns : undefined;
    if (!ref || !columns?.length) continue;
    notes.push(
      `Upstream step "${upstreamId}" (${ref}) returns rows with exactly these columns: ${columns.join(", ")}.` +
        // ⚠ Measured 2026-09-28 (execution 5UHcsXAPIcyccCJQBOraCX): the query
        // returned `"working_model": null` on all 4,130 rows and the fragment
        // received rows WITHOUT that key — Kestra's Pebble rendering of the
        // payload drops null-valued keys. "Exactly these columns" alone read as
        // "every row has every key", and `row["working_model"]` died KeyError.
        ` A column whose value is null is ABSENT from that row's dict (the engine drops null keys), ` +
        `so read every column with row.get(column) and treat a missing key as null.`,
    );
  }
  if (!notes.length) return contract;
  const suffix = notes.join(" ");
  return {
    ...contract,
    input: contract.input.map((f) => ({
      ...f,
      description: f.description ? `${f.description} ${suffix}` : suffix,
    })),
  };
}

/**
 * Stamp `format` onto contract inputs from the flow's DECLARED input types.
 *
 * The measured failure: a code step reading a DATE flow input refused its own
 * fragment ("specifies only that it is a string, not its date format") unless
 * the model happened to write `format: "date"` in prose — the same contract
 * sometimes sliced, sometimes demanded a `*_format` input (thread 80b119b1,
 * 2026-09-15). The flow KNOWS the shape (DATE inputs arrive YYYY-MM-DD), so
 * the enrichment carries it prompt-time-only, exactly like
 * `enrichContractWithColumns`: explicit `format` is never overwritten, the
 * stored contract is untouched (refusal keys are computed on the declared
 * contract), and only the copy `generateFragment` sees is stamped.
 *
 * Mapping is conservative: `"<key>": {{ inputs.X }}` pairs bind by payload
 * key, a bare `{{ inputs.X }}` binds when it is the step's only shaped read
 * and the contract's only unformatted string field. Anything ambiguous is
 * left for the model — a wrong stamp is worse than none.
 */
export function enrichContractWithInputShapes(
  contract: StepContract,
  model: FlowModel,
  declaredInputs: ReadonlyArray<{ id: string; type: string }>,
): StepContract {
  const step = model.steps.find((s) => s.id === contract.stepId);
  const inputExpr =
    step && "inputExpr" in step && typeof step.inputExpr === "string" ? step.inputExpr : null;
  if (!inputExpr) return contract;
  const shapeOf = new Map<string, ContractFormat>();
  for (const i of declaredInputs) {
    if (i.type === "DATE") shapeOf.set(i.id, "date");
    else if (i.type === "DATETIME") shapeOf.set(i.id, "datetime");
  }
  if (shapeOf.size === 0) return contract;
  const reads = inputNamesRead(inputExpr).filter((id) => shapeOf.has(id));
  if (reads.length === 0) return contract;
  // `"key": {{ inputs.X }}` pairs — the payload key the shaped value arrives under.
  const keyFor = new Map<string, string>();
  for (const m of inputExpr.matchAll(/"([^"]+)"\s*:\s*\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    if (shapeOf.has(m[2])) keyFor.set(m[1], m[2]);
  }
  const bare = inputExpr.trim().match(/^\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
  const unformatted = contract.input.filter((f) => f.type === "string" && !f.format);
  const next = contract.input.map((f) => {
    if (f.type !== "string" || f.format) return f;
    const bound = keyFor.get(f.name);
    if (bound) return { ...f, format: shapeOf.get(bound)! };
    if (bare && shapeOf.has(bare[1]) && reads.length === 1 && unformatted.length === 1) {
      return { ...f, format: shapeOf.get(bare[1])! };
    }
    return f;
  });
  return next.every((f, i) => f === contract.input[i]) ? contract : { ...contract, input: next };
}

// ── Reading the generator back ───────────────────────────────────────────────

/**
 * Parse a generator response into one of the two channels.
 *
 * Tolerant of a markdown fence and of surrounding prose, because models emit
 * both and re-generating over formatting wastes a cycle that says nothing about
 * the code. Not tolerant of a MISSING `status`: a bare code string would be
 * read as "ok" and the refusal channel would quietly stop existing, which is
 * the failure this whole module is about.
 */
export function parseFragmentResponse(raw: string, stepId: string): FragmentResponse {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new FragmentContractError(`generator returned no JSON object`, stepId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new FragmentContractError(`generator returned invalid JSON: ${(e as Error).message}`, stepId);
  }

  const result = fragmentResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new FragmentContractError(
      `generator response does not match either channel: ${JSON.stringify(result.error.flatten().fieldErrors)}`,
      stepId,
    );
  }
  return result.data;
}

// ── Validating the fragment before it is compiled in ─────────────────────────

export interface FragmentFinding {
  /** Fed back to the generator verbatim; the working loop is error-in, fix-out. */
  message: string;
}

/**
 * Static checks on a fragment, before it reaches the compiler.
 *
 * Cheap and mechanical, and each one exists because the failure it prevents is
 * expensive or misleading at execution time:
 *
 *   * no `run(payload)`     → the wrapper's last line raises `NameError`, which
 *                             reads as a wrapper bug rather than a fragment one
 *   * a forbidden import    → `ImportError` inside a container with no network,
 *                             which reads as a broken image
 *   * `input()` / `open()`  → an I/O attempt that would hang or throw far from
 *                             its cause
 *
 * This is NOT a security boundary and must never be described as one. The
 * containment is `networkMode: none`, no credentials and no mounts — properties
 * of the runtime, not of a text scan. A blocklist over generated Python is
 * defeated by `__import__("so"+"cket")`; the container is not.
 */
export function validateFragment(code: string, contract: StepContract): FragmentFinding[] {
  const findings: FragmentFinding[] = [];

  if (!/(^|\n)\s*def\s+run\s*\(/.test(code)) {
    findings.push({ message: `the fragment must define \`def run(payload):\` — nothing else is called` });
  }

  const seen = new Set<string>();
  for (const m of code.matchAll(IMPORT_RE)) {
    const root = (m[1] ?? m[2] ?? "").split(".")[0];
    if (!root || ALLOWED.has(root) || seen.has(root)) continue;
    seen.add(root);
    findings.push({
      message:
        `\`${root}\` is not importable in the fragment image (${config.kestra.fragmentImage}). ` +
        `Available: ${ALLOWED_IMPORTS.join(", ")}.`,
    });
  }

  // Bare-name I/O calls. Word-boundary matched so `payload.open_cases` and a
  // dict key called "input" do not trip it.
  for (const [pattern, why] of [
    [/(^|[^.\w])open\s*\(/, "`open()` — a fragment has no files; everything it gets is in `payload`"],
    [/(^|[^.\w])input\s*\(/, "`input()` — nothing is attached to stdin"],
    [/(^|[^.\w])print\s*\(/, "`print()` — stdout is the wrapper's output channel; return the value instead"],
    [/(^|[^.\w])exec\s*\(|(^|[^.\w])eval\s*\(/, "`exec()`/`eval()` — write the logic out"],
    [/__import__\s*\(/, "`__import__()` — import at the top of the fragment instead"],
  ] as Array<[RegExp, string]>) {
    if (pattern.test(code)) findings.push({ message: why });
  }

  const declared = new Set(contract.output.map((f) => f.name));
  if (declared.size === 0) {
    findings.push({ message: `the contract declares no output fields, so nothing could be checked` });
  }

  return findings;
}

// ── Conformance, after execution ─────────────────────────────────────────────

export interface ConformanceResult {
  ok: boolean;
  /** Declared output fields absent from the returned object. */
  missing: string[];
  /** Declared fields present but of the wrong shape. */
  mistyped: Array<{ field: string; want: ContractType; got: string }>;
}

function shapeOf(v: unknown): ContractType | "null" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t;
  return "any";
}

/**
 * Does a step's returned value match its declared output?
 *
 * The wrapper already checks that the declared KEYS are present, in the
 * container, before the value crosses back — that check has to be there,
 * because it is what turns a violation into a specific failure at the step that
 * caused it rather than a `KeyError` three steps downstream. This is the
 * type half, run on Foundry's side because it needs the contract and the
 * container deliberately does not carry one.
 *
 * A `null` for a declared field counts as MISSING, not as a wrong type. A step
 * that returns `{"rows": null}` has not produced rows, and calling that a type
 * error routes it to "bad code" when the useful diagnosis is the same one the
 * absent-key case gets.
 */
export function assertConformance(value: unknown, contract: StepContract): ConformanceResult {
  const missing: string[] = [];
  const mistyped: ConformanceResult["mistyped"] = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, missing: contract.output.map((f) => f.name), mistyped: [] };
  }
  const obj = value as Record<string, unknown>;

  for (const field of contract.output) {
    if (!(field.name in obj) || obj[field.name] === null) {
      missing.push(field.name);
      continue;
    }
    if (field.type === "any") continue;
    const got = shapeOf(obj[field.name]);
    if (got !== field.type) mistyped.push({ field: field.name, want: field.type, got });
  }

  return { ok: missing.length === 0 && mistyped.length === 0, missing, mistyped };
}

export const stepContractService = {
  buildFragmentPrompt,
  parseFragmentResponse,
  validateFragment,
  assertConformance,
  ALLOWED_IMPORTS,
};
