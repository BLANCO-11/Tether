import { randomUUID } from "node:crypto";
/**
 * The one builder (compiled-builder phase 4, D-292): drafter and chat as ONE entry. A goal is understood as a GoalSpec, the
 * person confirms (or corrects once) its readback, and the builder then places steps by constrained choice, asking the
 * person what only they can answer, in at most `MAX_ROUNDS` rounds. The result is a revision carrying its confirmed spec and
 * trace when complete, and the flow's working copy (D-319) when not — never an invalid flow, and never a loop.
 *
 * `understand` / `run` are pure over their inputs (a catalogue and a chooser), so `build:measure` drives exactly this code
 * with the goal set's labels as the answerer; `save` is the one part that writes.
 */
import { emptyFlow, engineReaderKinds, errorsOf, checkState, renderType as renderTy, rowOf, slugify, type CatalogueSnapshot, type EFlow, type Ty } from "@foundry/flow-edit";
import { inference } from "../inference.service.js";
import { flowCatalogueService } from "../flow-catalogue.service.js";
import { buildCatalogueSnapshot, specSig } from "../flow-typecheck.js";
import { isPausedFromModel } from "../datasource-model-visibility.js";
import { flowService } from "../flow.service.js";
import { engineIdOf } from "../flow-engine-id.js";
import { flowRepo } from "../../repositories/flow.repo.js";
import type { FlowModel } from "../flow-compiler.service.js";
import type { RevisionAuthor } from "../revision-author.js";
import { solve, type Draft, type KnownValue } from "./solver.js";
import { narrowCatalogue } from "./narrow.js";
import { answer, describeState, editProblems, emptyTrace, MAX_ROUNDS, noLoopProblems, oneOfValues, questionsFor, type BuildQuestion, type BuildTrace, type Chooser } from "./build.js";
import { existingParts, type WiringExisting } from "./wiring.js";
import { checkSpec, quoted, RECIPIENT_FIELD_NONE, norm, settledMatch, DAYS_TESTS, domainOf, SAME_TESTS, VALUED_TESTS, NONE_FIT, needsValue, ORDERING_TESTS, readback, specOutcome, cannotReasons, type BuilderCatalogue, type CheckedSpec, type GoalSpec, type SpecOutcome } from "./goal-spec.js";
import { S, parseStrict } from "./strict-schema.js";
import { clauses, makePlan, normalisePlan, planPrompt, planSchema, PLAN_SYSTEM, planToSpec, type Plan } from "./plan.js";
import { validatePlan } from "./validate.js";
import { isTableRef, specTables, tableReaders } from "./table-readers.js";
import { CONFIRMS } from "./reply-intents.js";
import { datasourceOfNewRead, flowLocalReaders, isNewRead, localAbout, LOCAL_REF, mergeLocal, newReadAbout, newReadOf, type LocalReader } from "./local-readers.js";
import { proposeOperation } from "../db-operation-proposal.service.js";
import { dialectOf } from "../db-operation.service.js";
import { shapeNeeds } from "./shape.js";
import { DELIVERY_ASK, deliveryFindings, settleDelivery } from "./delivery.js";
import { datasourceRepo } from "../../repositories/datasource.repo.js";
import { schemaRepo } from "../../repositories/schema.repo.js";
import { applyContract, contractFindings, contractText, readContract, type ReadContract } from "./read-contract.js";
import { isSqliteType, sqliteFileService } from "../sqlite-file.service.js";
import { SqliteDialectError, toSqlite } from "../sqlite-dialect.js";
import { syntaxProblem } from "../sql-parse-check.js";
import { intentIrEnabled } from "./intent-ir.js";
import { dryRunRead, type DryRunExecutor } from "./read-dry-run.js";
import { declarationOf } from "../tool-declarations.js";
import {
  bandEmitEnabled,
  bandSpecValid,
  emitBandedSpec,
  type BandMeasureIn,
} from "./band-read.js";
import { bandReturnContract, clausesProvenBy } from "./prove-cover.js";

/** The model as the chooser (D-307: every call strict). Budget covers a reasoning model's thinking as well as the reply.
 * 20k ceiling (flow 77db92ec): a big-catalogue plan spent the whole 4k budget on thinking and returned nothing. */
export const modelChooser: Chooser = (prompt, schema, label, model?, system?) => inference.complete(prompt, { label, schema, maxTokens: 20000, ...(model ? { model } : {}), ...(system ? { system } : {}) });

export interface Understood {
  goal: string;
  /** The person's words: the goal, and a correction when there was one. Quotes are checked against these. */
  texts: string[];
  checked: CheckedSpec;
  readback: string[];
  /** The person's answers by what they settle (`BuildQuestion.about`) — saved with a completed build, carried into its edits. */
  decisions?: Record<string, string>;
  outcome: SpecOutcome;
  /** A correction has been applied; a second disagreement ends understanding as a stated incomplete (D-304/D-294). */
  corrected: boolean;
  /** builder-behaviour P7: the words the automation's previous revision implemented — settled for this edit (`settledWords`). */
  settled?: string[];
  /** how many times this build was re-planned from the person's answers (bounded by `MAX_REPLANS`). */
  replans?: number;
  /** the questions already put in this call of `run` (its recursion) — never fresh again, answered or not. */
  posed?: string[];
  calls: number;
  /** M12: the catalogue was too roomy for the understanding call and one compact call narrowed it — how many components, to how many. */
  narrowed?: { from: number; to: number };
  /** An EDIT of a non-empty flow (D-321): the automation as it was described to the model. Absent for a new goal. */
  current?: string[];
  /** D-324: the per-row message templates drafted from the spec, shown in the readback; the build applies exactly these. */
  drafts?: Draft[];
  /** Z9 (I-325): the verified address of the person building — what "me" means on a port whose receiver does not fill it itself. */
  requester?: string;
  /** Z5 (I-322): the values already in the automation being changed (`knownValues`) — reusable, quoted `from: "earlier"`. */
  known?: KnownValue[];
  /** The holes this conversation's person has already answered — their words beat a drafted wording (Z8). */
  answered?: string[];
  /** what the person said to each answered question, by hole id — a reading is CONFIRMED only by a yes. */
  answerTexts?: Record<string, string>;
  /** Z6 (I-323): the automation's existing parts the wiring may name (its lists, prepared text, condition paths). */
  existing?: WiringExisting;
  /** Reads WRITTEN for this goal (`local-readers.ts`) — kept with the build until they are on its saved steps. */
  local?: LocalReader[];
  /** Saved readers that fit a source equally (the plan's `also`, by code): a one-click choice for the person, asked once. */
  choices?: Array<{ ref: string; also: string[] }>;
}

/**
 * Writes ONE read of a datasource for a goal: the operation proposer fills in the read form, held to `check()` and to one more
 * rule of the builder's — every column must have a type the automation can check (an untyped column is refused by the engine,
 * so it is a finding the proposer fixes, never a reader that silently cannot be added). A refusal is stated, never retried.
 */
/**
 * builder-behaviour P7 (B23): words a read could not give that stand NEXT TO EACH OTHER in the person's text are one missing thing —
 * one entry, so one question ("loyalty", "points", "balance" were three questions about one absent figure). Decided by position in
 * the text alone: entries separated by any other word stay apart, and an entry the text does not contain is kept as it is.
 */
export function oneGapPerPhrase<T extends { words: string; why: string }>(gaps: readonly T[], texts: readonly string[]): T[] {
  const text = texts.join("\n").toLowerCase();
  const at = gaps.map((g) => {
    const w = g.words.toLowerCase().trim();
    const m = w ? new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").exec(text) : null;
    return { g, i: m ? m.index : -1, end: m ? m.index + w.length : -1 };
  });
  const placed = at.filter((x) => x.i >= 0).sort((x, y) => x.i - y.i);
  const out: T[] = [];
  let run: typeof placed = [];
  let end = -1;
  const flush = () => {
    if (run.length === 1) out.push(run[0]!.g);
    else if (run.length) out.push({ ...run[0]!.g, words: texts.join("\n").slice(run[0]!.i, end), why: [...new Set(run.map((x) => x.g.why))].join("; ") });
    run = [];
  };
  // Joined only across spaces: a comma, "and" or any other word between two entries keeps them two things ("their name, address").
  for (const x of placed) {
    if (!(run.length && (x.i <= end || /^[ \t]+$/.test(text.slice(end, x.i))))) { flush(); end = -1; }
    run.push(x); end = Math.max(end, x.end);
  }
  flush();
  return [...out, ...at.filter((x) => x.i < 0).map((x) => x.g)];
}

/** A read written, with what it had to interpret (`assumed`) and what the data could not give (`leftOut`) — each in the need's words. */
/** `data` on an entry: its words name something about the DATA no table, column or value names (`unnamedWords`) — always asked. */
export type WrittenRead = {
  reader: LocalReader;
  item: BuilderCatalogue["items"][number];
  assumed: Array<{ words: string; as: string; data?: boolean }>;
  leftOut: Array<{ words: string; why: string; data?: boolean }>;
  unnamed?: Array<{ words: string; why: string }>;
  /** Strategy B Phase 3: redacted dry-run / column preview — never asked as a hole. */
  preview?: string;
};
/** `data`: a word of the goal about the DATA the read does not give (`unnamedWords`) — asked even inside an action's words. */
type ReadNote = { words: string; read: string; as?: string; why?: string; data?: boolean };
/**
 * `prior`: the read already written for this datasource in this build — REVISED in place, never replaced by a fresh one. It keeps
 * its ref, and the proposer is told to keep every parameter name whose meaning is unchanged: a parameter is an input a person may
 * already have answered (`h_<step>_<param>`), so a read written again from scratch renamed them and lost every answer.
 */
/** `contract`: the read's interface, fixed by code before the proposer is called (`read-contract.ts`) — the proposal is held to it. */
/** `stated`: the person's words for the read's own inputs (a period, a date, a threshold, a count) — never words about the data. A
 *  subject or a message is free text and may repeat the data's words ("list of managers …"), so it is never one of them. */
/** `bands` / `groupBy`: under Intent IR, code emits the CASE WHEN form and skips propose. */
export type ReadWriter = (
  datasource: string,
  need: string,
  taken: string[],
  texts?: string[],
  prior?: LocalReader,
  contract?: ReadContract,
  stated?: string[],
  quotes?: string[],
  bands?: BandMeasureIn[],
  groupBy?: Array<{ field: string; words: string }>,
) => Promise<WrittenRead | { refused: string }>;
/**
 * The goal's words for recipients the DATA must supply: a recipient stated in the goal whose words are not an address (the solver's
 * own reading — words shaped like an address are an address, and "me" is the requester). Code's reading, never the model's prose.
 */
export const peopleInRows = (spec: GoalSpec): string | undefined =>
  // …unless the plan said no data holds THEIR address (`none`: a request for a team, not people the rows are about). Required
  // anyway, the read's contract demanded an address no table has, and the whole read — every branch with it — was refused (2026-10-04).
  spec.values.find((v) => v.role === "recipient" && v.from === "goal" && v.field !== RECIPIENT_FIELD_NONE && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.quote.trim()))?.quote;
const holdsAddress = (t: Ty): boolean => t.t === "Address" || (("of" in t) && !!t.of && holdsAddress(t.of as Ty));
const untypedTy = (t: Ty): boolean => t.t === "Opaque" || t.t === "Json" || ("of" in t && untypedTy(t.of as Ty));
/** Every group over `ref` keeps the read's ADDRESS fields (typed so) — for actions done per group to the people the rows name. */
export function carryAddresses(spec: GoalSpec, ref: string, fields: ReadonlyArray<{ name: string; ty: string }>): GoalSpec {
  const addrs = fields.filter((x) => /\bAddress\b/.test(x.ty)).map((x) => `${ref}.${x.name}`);
  if (!addrs.length || !spec.shapes) return spec;
  return { ...spec, shapes: spec.shapes.map((sh) => (sh.over !== ref ? sh : { ...sh, stages: sh.stages.map((st) => (st.op === "group" && st.by?.length ? { ...st, carry: [...new Set([...(st.carry ?? []), ...addrs])] } : st)) })) };
}

/** Does a read's form summarise its rows — a summary join, or an aggregate on a column? */
const summarises = (spec: unknown): boolean => {
  const s = spec as { aggregateJoins?: unknown[]; columns?: Array<{ aggregate?: unknown }> };
  return (s.aggregateJoins?.length ?? 0) > 0 || (s.columns ?? []).some((col) => !!col.aggregate);
};

/** Row exclusions are the model's `Plan.rows[]` tests (source (a)), applied
 * as `aggregateJoins[].filters` — never a datasource literal read into code. */

export function readWriter(workspaceId: string): ReadWriter {
  return async (datasource, need, taken, texts = [], prior, contract, stated = [], quotes = [], bands, groupBy) => {
    const ds = (await datasourceRepo.listByWorkspace(workspaceId)).find((d) => d.name === datasource);
    if (!ds) return { refused: `there is no data source called ${datasource}` };
    const rows = await schemaRepo.listByDatasource(ds.id);
    // Band emit: fast path only when aliases/CASE prove the goal — else propose (never false-complete).
    if (bandEmitEnabled() && bands?.length) {
      // P8: contract period/date → filter day rows so relative inputs ("last week") bind to period_start/end.
      const wantPeriod = (contract?.params ?? []).some((p) => p.type === "date" || p.type === "month" || !!p.end);
      let dateColumn: string | null = null;
      if (wantPeriod) {
        const workDate = rows.find((r) => r.columnName === "work_date")?.columnName;
        dateColumn = workDate
          ?? rows.find((r) => {
            const c = r.columnName;
            return !!c && /(?:^|_)date(?:$|_)/i.test(c) && !/^et_/i.test(c);
          })?.columnName
          ?? null;
      }
      const why: { reason?: string } = {};
      const emitted = emitBandedSpec(rows, bands, groupBy ?? [], { dateColumn, texts, why });
      const valid = emitted ? bandSpecValid(emitted as never, bands) : null;
      if (emitted && valid === true) {
        let name = prior?.name ?? "banded_read";
        if (!prior) for (let n = 2; taken.includes(`${datasource}${LOCAL_REF}${name}`); n++) name = `banded_read_${n}`;
        const reader: LocalReader = { ref: `${datasource}${LOCAL_REF}${name}`, datasource, name, spec: emitted };
        try {
          const typed = specSig(emitted as never, rows, dialectOf(ds.type));
          if (isSqliteType(ds.type)) toSqlite(typed.sql);
          let preview: string | undefined;
          if (intentIrEnabled()) {
            const cols = typed.outputColumns.map((c) => c.alias).filter(Boolean).slice(0, 12);
            preview = cols.length ? previewLine(`${reader.ref}: projects columns ${cols.join(", ")} (code-emitted bands)`) : undefined;
          }
          return { reader, item: localItem(reader, typed.sig), assumed: [], leftOut: [], ...(preview ? { preview } : {}) };
        } catch (e) {
          console.warn(`[builder] band emit for ${datasource} failed compile: ${(e as Error).message.slice(0, 200)}`);
          return { refused: `a banded read of ${datasource} could not be compiled: ${(e as Error).message.slice(0, 240)}` };
        }
      }
      // Banded emit is the only path for banded measures: propose cannot
      // satisfy band structure (it invents joins and drops the arms).
      // Refuse with the structural reason rather than burning attempts.
      if (!emitted) {
        console.warn(`[builder] band emit for ${datasource} returned null (${why.reason ?? "unknown"}) — not falling back to propose`);
        return { refused: `a banded read of ${datasource} could not be built from the schema${why.reason ? `: ${why.reason}` : ""}` };
      }
      console.warn(`[builder] band emit for ${datasource} did not satisfy the stated band structure — not falling back to propose`);
      return { refused: `a banded read of ${datasource} does not cover every band the goal states: ${valid}` };
    }
    // The interface is the contract's (phase 1): with none, the read takes no parameter at all.
    const c = contract ?? { params: [], words: [] };
    const accept = async (spec: unknown, said?: { values: Array<{ words: string }>; covers?: string[]; coversBy?: Array<{ words: string; by: string[] }>; assumed?: Array<{ words: string }>; leftOut?: Array<{ words: string }>; others?: Array<{ words: string }> }): Promise<string[]> => {
      // every word of what this read is FOR is in one of the proposer's lists — or the answer is refused,
      // naming the words. Code checks only completeness; the lists themselves are asked (assumed, left out) or stated (covers).
      const unaccounted = said ? accountingGaps(quotes.length ? quotes : texts, [...(said.covers ?? []), ...[...said.values, ...(said.assumed ?? []), ...(said.leftOut ?? []), ...(said.others ?? [])].map((x) => x.words), ...c.params.map((x) => x.words), ...stated, ...(c.owned ?? [])]) : [];
      if (unaccounted.length) return [`every word of ${quotes.map((q) => `“${q}”`).join(" and ")} must be in "covers", "assumed", "left_out", "values" or "others" — these are in none: ${unaccounted.map((w) => `“${w}”`).join(", ")}`];
      // ...and what "covers" claims, the read DOES: each entry names the read's own columns that give it.
      if (said?.coversBy) {
        // The COMPILER's answer, never a second reading of the spec: every table, column and result name the compiled read uses is
        // a quoted identifier of its SQL.
        let sql = ""; try { sql = specSig(spec as never, rows, dialectOf(ds.type)).sql; } catch { /* a compile problem is reported below, by the compiler */ }
        const used = new Set([...sql.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase()));
        // A citation holds when the read uses that column, or the table it is on (a count of a table's rows names its key).
        const holds = (b: string) => { const parts = b.toLowerCase().split("."); return used.has(parts.at(-1)!) || (parts.length > 1 && used.has(parts.at(-2)!)); };
        const bad = said.coversBy.filter((x) => !x.by.length || !x.by.some(holds));
        if (sql && bad.length) return bad.map((x) => `"covers" “${x.words}” names ${x.by.length ? x.by.map((b) => `\`${b}\``).join(", ") + ", none of which this read uses" : "no column"} — every covers entry names the columns of THIS read that give it; words no column of it gives are "assumed" or "left_out"`);
      }
      try {
        const typed = specSig(spec as never, rows, dialectOf(ds.type));
        const ps = (typed.paramsSchema ?? {}) as Record<string, { type?: string; format?: string; per?: string }>;
        const row = rowOf(typed.sig.payload);
        const bad = row.t === "Record" ? Object.entries(row.fields as Record<string, Ty>).filter(([, t]) => untypedTy(t)).map(([n]) => n) : [];
        // A goal that sends to the people each row is about needs their address IN the row (2026-10-01: "email their project
        // managers" got a read with no address, stated only when the build could not send). Judged on the TYPES, never a column name.
        const sendsTo = c.address;
        const noAddress = !!sendsTo && row.t === "Record" && !Object.values(row.fields as Record<string, Ty>).some(holdsAddress);
        // A read must run on its OWN engine (2026-10-01: a SQLite read with a Postgres cast compiled, was accepted, and failed at its
        // first run). The SQLite translation is the one execution uses; its refusal names the construct, so the next answer avoids it.
        let dialect: string[] = [];
        if (isSqliteType(ds.type)) { try { toSqlite(typed.sql); } catch (e) { if (e instanceof SqliteDialectError) dialect = [`${e.message} — this datasource is SQLite: write the read without it`]; else throw e; } }
        // ...and it must PARSE there (2026-10-02, FL02: a read compiled, was saved, and its first run died with "syntax error at or
        // near $"). The engine's own words go back to the proposer; a read its runtime cannot parse is never accepted.
        const unparsed = dialect.length ? null : await syntaxProblem(typed.sql, ds.type);
        // Named with WHERE it comes from: "sum of v_some_table.some_column" says which column has no type, so the next answer can avoid it.
        return [
          ...dialect,
          ...(unparsed ? [`the compiled read does not parse on this datasource's engine (${unparsed}) — write it another way`] : []),
          ...(noAddress ? [`the goal sends to “${sendsTo}”, the people each row is about, and no column of this read is an address — join their address (an email column) from wherever the schema keeps it, as a column of every row`] : []),
          ...bad.map((alias) => {
            const src = typed.outputColumns.find((c) => c.alias === alias)?.source;
            return `\`${alias}\`${src ? ` (${src})` : ""} has no declared type in the schema, so nothing in the automation can check it — use a column the SCHEMA gives a type, or count the rows instead`;
          }),
          ...keyParams(typed.paramColumns, rows),
          // With a contract, the contract is the ONE authority over the read's parameters (2026-10-02, H06: "more than 100%" was not
          // captured as a value, so the contract had no parameter, and this rule refused the only read possible — a fixed 100). A
          // stated number the contract DOES name is held by `contractFindings` ("not used"). This rule stands only without one.
          ...(contract ? [] : statedConstantFindings(spec, texts)),
          // A fixed TEXT value is the person's own words, never the read's choice (P2-I4) — whether or not there is a contract.
          ...unstatedTextFindings(spec, texts),
          // Every parameter is the contract's — an invented one (a number nobody stated, a name the read chose) is refused by name.
          ...contractFindings(c, ps, typed.outputColumns.map((o) => o.alias), summarises(spec)),

        ];
      } catch (e) { return [(e as Error).message]; }
    };
    let p: Awaited<ReturnType<typeof proposeOperation>>;
    try { p = await proposeOperation({ workspaceId, dsId: ds.id, need, accept, ...(prior ? { revise: { name: prior.name, spec: prior.spec } } : {}) }); }
    catch (e) {
      const findings = ((e as { findings?: Array<{ message: string }> }).findings ?? []).map((f) => f.message).slice(0, 3);
      return { refused: `a read of ${datasource} could not be written: ${(e as Error).message}${findings.length ? ` (${findings.join("; ")})` : ""}` };
    }
    // A refusal now means NOTHING of the need is in this data: a part it lacks comes back as `leftOut` beside the read.
    if (p.status === "insufficient_schema") return { refused: `${datasource} cannot give this: ${p.reason}${p.missing.length ? ` (not there: ${p.missing.join(", ")})` : ""}` };
    // A revision keeps the read's own name, so its ref — and every step and answer keyed by it — stays.
    let name = prior?.name ?? p.name;
    if (!prior) for (let n = 2; taken.includes(`${datasource}${LOCAL_REF}${name}`); n++) name = `${p.name}_${n}`;
    const reader: LocalReader = { ref: `${datasource}${LOCAL_REF}${name}`, datasource, name, spec: p.spec };
    const typed = specSig(p.spec as never, rows, dialectOf(ds.type));
    // Everything the read interpreted (`assumed`) or could not give (`left_out`) is asked — the accounting rule above holds the
    // read to naming every word of what it is for, so no word list decides which (replaced `borrowedWords` / `unnamedWords` /
    // `chosenDefinitions`, 2026-10-03).
    const mark = <T extends { words: string }>(x: T): T & { data?: boolean } => ({ ...x, data: true });
    // Strategy B Phase 3: schema-grounded column preview; LIMIT dry-run against the live RO credential when possible.
    let preview: string | undefined;
    if (intentIrEnabled()) {
      const cols = typed.outputColumns.map((c) => c.alias).filter(Boolean).slice(0, 12);
      preview = previewLine(
        cols.length
          ? `${reader.ref}: projects columns ${cols.join(", ")}`
          : `${reader.ref}: compiled (no projected columns named)`,
      );
      // Vitest: schema-column preview only (no live DSN). Production/harness: RO LIMIT dry-run.
      const exec = dryRunExecutorFor
        ? dryRunExecutorFor(workspaceId, datasource)
        : process.env.VITEST
          ? null
          : defaultDryRunFactory(workspaceId, datasource);
      if (exec) {
        const r = await dryRunRead(typed.sql, [], exec, { label: reader.ref });
        preview = previewLine(r.preview);
      }
    }
    return { reader, item: localItem(reader, typed.sig), assumed: p.assumed.map(mark), leftOut: p.leftOut.map(mark), ...(preview ? { preview } : {}) };
  };
}

/** Optional dry-run executor hook (harness / sandbox). Null from the hook = skip live preview. */
let dryRunExecutorFor: ((workspaceId: string, datasource: string) => DryRunExecutor | null) | null = null;
export function setDryRunExecutorFactory(fn: typeof dryRunExecutorFor): void {
  dryRunExecutorFor = fn;
}

/** Tag a preview line so chat can fold it separately from the readback. */
function previewLine(text: string): string {
  const t = text.trim();
  return t.startsWith("Preview:") ? t : `Preview: ${t}`;
}

/**
 * Default live dry-run: READ ONLY query against the datasource credential, LIMIT already applied by
 * `dryRunRead`. Opt out in tests via `setDryRunExecutorFactory(() => null)`.
 */
function defaultDryRunFactory(workspaceId: string, datasource: string): DryRunExecutor {
  return async (sql, params) => {
    const { default: pg } = await import("pg");
    const { decrypt } = await import("../../utils/encryptor.js");
    const ds = await datasourceRepo.getByName(workspaceId, datasource);
    if (!ds?.connectionStringEnc) throw new Error("no datasource credential for preview");
    if (isSqliteType(ds.type)) throw new Error("sqlite preview uses schema columns only");
    if (ds.type !== "postgres" && ds.type !== "postgresql") throw new Error(`preview not supported for ${ds.type}`);
    const client = new pg.Client({
      connectionString: decrypt(ds.connectionStringEnc as string),
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      await client.query("SET statement_timeout = 4000");
      await client.query("BEGIN READ ONLY");
      const r = await client.query(sql, params as unknown[]);
      await client.query("ROLLBACK");
      return { rows: r.rows as Record<string, unknown>[] };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await client.end().catch(() => {});
    }
  };
}

/** the goal as it stands once the person's reply is applied — in their words, nothing either does not say. */
export async function restateWithReply(goal: string, about: string, reply: string, chooser: Chooser): Promise<string> {
  // the restate also names the parts of the GOAL the reply takes away, and code refuses a goal that still
  // names one — an instruction about the goal ("ignore X") copied into it names X. One re-ask with the finding.
  const schema = S.obj({
    removed: S.arr(S.str("a part of the GOAL, copied exactly from it"), 6, "the parts of the GOAL the reply takes away or replaces; empty when it only adds or explains"),
    goal: S.str("the whole goal, as it stands with the reply applied: what the automation does (and why, when the goal says why) — never an instruction about the goal or its wording"),
  });
  const base = [
    "A person is building an automation from the GOAL below and was asked about it; their REPLY follows. Write the goal AS IT NOW STANDS,",
    "one or two sentences in the person's own words: keep everything the reply does not touch; put in what it adds or explains; where it",
    "takes something away or replaces it (\"instead of X, Y\", \"change of plan\", \"ignore X\", \"X meant Y\"), list that part of the GOAL in",
    "`removed` and write the goal WITHOUT it — the goal never mentions what was removed, and never says what to ignore or what a word meant.",
    "Add nothing neither of them says. ASKED is the builder's own question, for context only — never copy its wording into the goal.",
    "", `GOAL: ${goal}`, ...(about !== reply ? [`ASKED: ${about}`] : []), `REPLY: ${reply}`,
  ];
  const ask = async (extra: string[]) => parseStrict<{ removed: string[]; goal: string }>(schema, await chooser([...base, ...extra].join("\n"), { name: "goal_restate", schema }, "builder:restate"), "builder:restate");
  let r = await ask([]);
  let left = stillNamed(goal, r.removed, r.goal);
  if (left.length) { r = await ask(["", `Your last goal still named what was removed: ${left.map((w) => `“${w}”`).join(", ")}. Write it without them.`]); left = stillNamed(goal, r.removed, r.goal); }
  if (left.length) throw new Error(`the restated goal still names what the reply removed: ${left.join(", ")}`);
  return r.goal.trim();
}

/**
 * The words of each removed part (as found in the goal) that the restated goal still holds — unless the goal's other words say them
 * too. The reply's words are NOT an excuse: a reply that removes something names it ("ignore subordinate").
 */
export function stillNamed(goal: string, removed: readonly string[], restated: string): string[] {
  // "sub-ordinates" and "subordinates" are one word.
  const tok = (x: string) => (x.toLowerCase().replace(/([a-z])-([a-z])/g, "$1$2").match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 3).map(stemOf);
  let rest = goal.toLowerCase();
  const parts = removed.map((x) => x.trim()).filter((x) => x && rest.includes(x.toLowerCase()));
  for (const x of parts) rest = rest.split(x.toLowerCase()).join(" ");
  const kept = new Set(tok(rest));
  const now = new Set(tok(restated));
  return [...new Set(parts.flatMap(tok))].filter((w) => now.has(w) && !kept.has(w));
}

/** the words (of 4+ letters) of `quotes` no accounted phrase holds — exact words, the text being as meant. */
export function accountingGaps(quotes: readonly string[], accounted: readonly string[]): string[] {
  const tok = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const have = new Set(accounted.flatMap(tok));
  return [...new Set(quotes.flatMap(tok))].filter((w) => w.length > 3 && !have.has(w));
}
const overlapping = (a: string, b: string) => { const x = a.toLowerCase().trim(), y = b.toLowerCase().trim(); return !!x && !!y && (x.includes(y) || y.includes(x)); };
/** One word in two forms — "deducted" and "deductions": the same stem, or one a prefix of the other once both are long enough. */
const stemOf = (w: string) => w.toLowerCase().replace(/(ies|es|s|ed|ing)$/, "");


/**
 * A person is never asked for a code a REFERENCE table assigns (a whole
 * number nobody knows). A parameter compared with a column the schema declares a foreign key into a
 * compact table that has text of its own (a list of kinds) is refused, naming that table, so the
 * read filters on the text a person names instead. A key into a roomy table stays: its number is
 * something a person can know. Declared keys and row counts only — a column's NAME is never read as a key.
 */
export const REFERENCE_ROWS = 200;
export function keyParams(paramColumns: Record<string, { schema: string | null; table: string; column: string }>, rows: Array<{ entityName: string; entitySchema?: string | null; columnName: string | null; columnType?: string | null; isForeignKey?: boolean | null; foreignKeyReference?: string | null; rowCountEstimate?: number | null }>): string[] {
  return Object.entries(paramColumns).flatMap(([param, at]) => {
    const r = rows.find((x) => x.entityName === at.table && x.columnName === at.column);
    if (!r?.isForeignKey || !r.foreignKeyReference) return [];
    const to = r.foreignKeyReference.split(".")[0]!;
    const size = rows.find((x) => x.entityName === to && x.columnName === null)?.rowCountEstimate;
    const text = rows.filter((x) => x.entityName === to && x.columnName && /^(text|character varying|character)$/.test(x.columnType ?? "") && !x.isForeignKey).map((x) => x.columnName!);
    if (size == null || size > REFERENCE_ROWS || !text.length) return [];
    return [`parameter \`${param}\` compares ${at.table}.${at.column}, a code from the reference table ${to} — a person names one of its rows, never its code. Join ${to} and filter on its text (${text.join(", ")}) instead`];
  });
}

/**
 * The numbers a person STATED — what a read must take as a parameter, never fix as a constant (2026-10-01). The form may write a
 * number the RULE needs (`value`, `{number}`: a 0 for "none", a 1 for a flag), and a number the person said is not that: fixed into
 * the read it would be invisible, unchangeable and never accounted for as theirs. Excluded, because they are not a stated number:
 * a year, and a day of a month (a month name with a day). 0 and 1 are never refused — they are what "none" and a flag ARE.
 */
const MONTH_WORD = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
export function statedNumbers(texts: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const t of texts) {
    const bare = t.toLowerCase()
      .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}\\b`, "g"), " ")
      .replace(new RegExp(`\\b${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "g"), " ")
      .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ");
    for (const m of bare.matchAll(/-?\d+(?:\.\d+)?/g)) { const n = Number(m[0]); if (Number.isFinite(n) && n !== 0 && n !== 1) out.add(n); }
  }
  return out;
}
/** Every fixed number a read form carries — a filter's `value` and a computed `{number}`, wherever they sit. */
export function constantsIn(spec: unknown): number[] {
  const out: number[] = [];
  const walk = (x: unknown, key?: string) => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if ((k === "number" || k === "value") && typeof v === "number") out.push(v);
      else walk(v, k);
    }
    void key;
  };
  walk(spec);
  return out;
}
/** Every fixed TEXT value a read form carries — a filter's `value`, wherever it sits. */
export function textConstantsIn(spec: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) { if (k === "value" && typeof v === "string") out.push(v); else walk(v); }
  };
  walk(spec);
  return out;
}
const phraseWords = (t: string) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
/**
 * The finding for a fixed text value the person never said (P2-I4). Text in a read is admitted only as the person's own words —
 * the same provenance a literal on a step follows — matched as whole words, any case: “active employees” admits `'Active'`, and
 * nothing admits a status the read chose. A value they did not say is a question, so it is a parameter or it is left out.
 */
export const unstatedTextFindings = (spec: unknown, texts: readonly string[]): string[] => {
  const said = phraseWords(texts.join(" \n "));
  // A word the person said in another inflection is still their word ("interns" admits `'Intern'`, builder-behaviour E03): compared
  // stem by stem with the file's own stem rule (`stemOf`), whole words, in order.
  const stems = (t: string) => ` ${phraseWords(t).trim().split(" ").map(stemOf).join(" ")} `;
  const saidStems = stems(texts.join(" \n "));
  const all = [...new Set(textConstantsIn(spec))];
  return [
    ...all.filter((v) => phraseWords(v).trim() === "" || !(said.includes(phraseWords(v)) || saidStems.includes(stems(v)))).map((v) => `the text “${v}” is not the person's words — a fixed text value is only what they said; anything else is a parameter, or set the test aside`),
    // An ADDRESS is who receives something — an action's, never a test of the rows (2026-10-02: a person's "customer is <address>"
    // became `contact_email = '<address>'`, keeping only that person's rows and sending to nobody else). Code's own reading of words
    // shaped like an address (`peopleInRows`), not a column name.
    ...all.filter((v) => ADDRESS_WORDS.test(v.trim())).map((v) => `“${v}” is an address — who receives a message is the action's, never a filter on the rows: set it aside from the read`),
  ];
};
const ADDRESS_WORDS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The finding for a stated number written into a read as a constant: it must be a parameter, listed in `values`. */
export const statedConstantFindings = (spec: unknown, texts: readonly string[]): string[] => {
  const said = statedNumbers(texts);
  return [...new Set(constantsIn(spec).filter((n) => said.has(n)))].map((n) => `the number ${n} is one the person STATED — never fix it in the read: make it a parameter (a filter's \`param\`, or {"param": …, "type": "number"}) and list it in "values" with the words that state it`);
};

/** What the read must give, for the proposer: the goal, the words this read is for, and the rule that values are parameters. */
export const readNeed = (
  texts: string[],
  quotes: string[],
  contract?: ReadContract,
  bands?: Array<{ field: string; words: string; arms: Array<{ test: string; value: string; then: number; words: string }> }>,
  groupBy?: Array<{ field: string; words: string }>,
) => {
  const accountQuotes = [...quotes];
  const bandMeasures = (bands ?? []).map((b) => ({ words: b.words, bands: b.arms }));
  return [
  `An automation's goal: “${texts.join(" / ")}”.`,
  `Write ONE read of this datasource that gives the rows for ${quotes.map((q) => `“${q}”`).join(" and ")}.`,
  "Put into this one read everything the goal says about WHICH rows and WHAT each row carries: join the related tables along their keys, summarize related rows with a grouped summary join (with its own filters — only the related rows in the goal's period, for instance), and keep rows by the goal's tests.",
  // P10 (bands, generic): thresholded labelling the read must compute — each band labels rows of a field, first match wins.
  // When a zero-weight edge is named, it MUST be its own arm BEFORE a lower `at_least` edge, or rows matching both score wrongly.
  ...(bands?.length ? [`Label rows by these bands of their field (a {"caseWhen": ...} value inside the summary's aggregate, summed per group): ${bands.map((b) => `“${b.words}” of ${b.field}: ${b.arms.map((a) => `${a.test} ${a.value} → ${a.then} (“${a.words}”)`).join(", ")}`).join("; ")}. First match wins — put zero-weight arms before lower edges.`] : []),
  ...(bands?.length ? [bandReturnContract(texts, bandMeasures, groupBy ?? [], [])] : []),
  // The interface is code's (phase 1): the parameters, their names and types, and the address are the contract's, never chosen here.
  // the words the read must account for, listed by code — the same set `accountingGaps` checks — including band edges outside the source quote.
  ...[`Account for EACH of these words, in "covers", "assumed", "left_out", "values" or "others": ${accountingGaps(accountQuotes, contract?.owned ?? []).map((w) => `“${w}”`).join(", ")}.`],
  ...(contract ? [contractText(contract)] : ["Every value the goal states — a period, a date, a status, a threshold — is a PARAMETER of a filter, named for what it is (`period`, `as_of`, `status`); never write a value into the read. A period the goal names as a month is ONE month parameter, never a start and an end."]),
].join("\n");
};

/** Z6: an automation's existing parts, as the wiring names them — from its steps and the catalogue's `modelText` declarations. */
export const existingOf = (f: EFlow, cat: CatalogueSnapshot): WiringExisting | undefined => (f.steps.length ? existingParts(f as never, (ref) => !!cat.refs[ref]?.modelText) : undefined);

/** Z5: every fixed value on the automation's steps — what was given before, by where it is used. */
export const knownValues = (f: EFlow): KnownValue[] => f.steps.flatMap((s) => (s.kind === "tool" || s.kind === "datasource") && s.ref
  ? s.inputs.flatMap((b) => (b.source?.from === "literal" && b.source.value.trim() ? [{ stepId: s.id, ref: s.ref!, port: b.name, value: b.source.value }] : []))
  : []);
/** Z5: the known values as the model reads them: one line each, the value first (the quote it must copy), then where it is used. */
export const knownLines = (k: KnownValue[]) => k.map((x) => `- ${x.value} — ${x.ref} · ${x.port} (${x.stepId})`);

/**
 * D-324: draft the words of each per-row message nobody stated — a template of the row's own fields, by code — and add them to the
 * readback, so the person confirms them with the rest. Always re-derived from the spec and the catalogue as they are NOW (never a
 * client's copy), and a dry run of the solver, so what is shown is what the build places.
 */
export function withDrafts(u: Understood, cat: CatalogueSnapshot, start: EFlow = emptyFlow("draft")): Understood {
  if (u.outcome === "cannot") return u;
  const dry = solve(start, { spec: u.checked, cat, answers: new Map(), base: start.steps.map((x) => ({ kind: x.kind, id: x.id, ...("ref" in x && x.ref ? { ref: x.ref } : {}) })), drafts: "propose" });
  const { drafts } = dry;
  const refOf = (id: string) => (dry.flow.steps.find((x) => x.id === id) as { ref?: string } | undefined)?.ref ?? id;
  // A row left out of a grouping is not a message withheld: the words follow what the flow does with it (2026-09-28).
  const sends = dry.flow.steps.some((x) => x.kind === "tool");
  const base = u.readback.filter((l) => !l.startsWith("Each message of ") && !l.startsWith("Skipped: ") && !l.startsWith("Without an address: "));
  return { ...u, drafts, readback: [...base, ...drafts.map((d) => `Each message of ${d.ref} will say (${d.port}): “${d.text}”`), ...dry.skips.map((k) => `Skipped: rows of ${refOf(k.reader)} with no ${k.field} ${sends ? "get no message" : "are left out of the result"}${k.alsoFor?.length ? ` — not even ${k.alsoFor.map((q) => `“${q}”`).join(" or ")}, which does not need it` : ""} — the run lists them separately`), ...dry.without.map((w) => `Without an address: ${w}`)] };
}

export async function understand(goal0: string, whole: BuilderCatalogue, chooser: Chooser, correction?: { previous: Understood; text: string; words?: string[]; defs?: string[]; shapeColumns?: string[] }, current?: string[], knownIn?: KnownValue[], existingIn?: WiringExisting, write?: ReadWriter, settledIn?: string[]): Promise<Understood> {
  // builder-behaviour P7 (E04, E06): the words the automation's last revision IMPLEMENTED — understood when it was built, and
  // accepted. An edit re-plans the whole goal; it never asks about them again ("what do you mean by unresolved?" after the first
  // turn had confirmed it). Only the plan's own unclear words are settled by them; a newly written read's readings are still asked.
  const settled = correction?.previous.settled ?? settledIn ?? [];
  // `texts` are the PERSON's words and nothing else: every check that asks "did they say this?" or "did they quote it?" reads them.
  // A correction's `text` is what the model reads — it may be the builder's own framing (“about it” means …), whose quote marks are
  // the builder's, not the person's (2026-10-01: they made "about it" read as a quoted message, and it became an email's body).
  // `words` is what the person typed; the text itself only when the person wrote all of it.
  let goal = goal0;
  // MEM2: meanings (`defs`) join the person's texts beside the goal; the goal itself is not restated with them.
  const defs = correction?.defs?.length ? correction.defs : null;
  let texts = correction ? (defs ? [...new Set([...correction.previous.texts, ...defs])] : [...correction.previous.texts, ...(correction.words ?? [correction.text])]) : [goal];
  // Typed shape only: the caller routes `shape` and passes the requested columns;
  // never mined from the message by regex here.
  const shapeCols = correction?.shapeColumns?.map((c) => c.trim()).filter(Boolean) ?? [];
  /** Column/output reshape on an existing written read — skip restate + makePlan + narrow (latency). */
  const shapeOnly = !!correction && !defs && shapeCols.length > 0 && (correction.previous.local?.length ?? 0) > 0
    && (correction.previous.checked.spec.sources?.length ?? 0) > 0;
  // a reply is APPLIED to the goal, never appended to it — one call restates the whole goal as it now stands
  // (what the reply replaces is left out, what it adds or explains is in), and that goal alone is planned. Appended, every clause of
  // the original stayed to be built: "instead of managers, make it department" left "a list of managers" unbuilt for ever. Here, in
  // the one place every re-plan passes (a clarification, an addition, an answer to an unclear or data question).
  let restated = false;
  if (correction && correction.text.trim() && !defs && !shapeOnly) {
    const reply =correction.words?.length ? correction.words.join("; ") : correction.text;
    const again = await restateWithReply(correction.previous.goal, correction.text, reply, chooser).catch(() => "");
    // Held by code to the person's words: every word of the restatement must appear
    // in the goal or the reply (exact, case-insensitive) — else the reply is taken as before.
    const allowed = new Set(`${correction.previous.goal} ${reply}`.toLowerCase().match(/[a-z]+/g) ?? []);
    const foreign = [...new Set((again.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= 4 && !allowed.has(w)))];
    if (again && !foreign.length) { goal = again; texts = [goal]; restated = true; }
  }
  const cur = correction?.previous.current ?? current;
  const known = correction?.previous.known ?? knownIn;
  const kv = (known ?? []).map((k) => k.value);
  const existing = correction?.previous.existing ?? existingIn;
  let items: BuilderCatalogue;
  let calls: number;
  let narrowed: Understood["narrowed"];
  if (shapeOnly) {
    // Keep the settled structure; only the person's reshape words join the texts for the return contract.
    goal = goal0.includes(correction!.previous.goal) ? goal0 : correction!.previous.goal;
    const personSaid = (correction!.words?.length ? correction!.words.join("; ") : correction!.text)
      .replace(/^The person adds:\s*/i, "")
      .replace(/^About what is not settled yet[^:]*:\s*/i, "")
      .trim();
    texts = [...correction!.previous.texts];
    if (personSaid && !texts.some((t) => t.includes(personSaid.slice(0, Math.min(40, personSaid.length))))) {
      texts = [...texts, personSaid];
    }
    items = whole;
    calls = correction!.previous.calls ?? 0;
    narrowed = undefined;
  } else {
    // M12 (E5.12): a catalogue whose spec schema would not fit the gateway is narrowed first, by one compact call — and only then.
    const n = await narrowCatalogue(correction && !restated ? `${goal}\n${correction.text}` : goal, whole, chooser, cur);
    items = n.items;
    calls = (correction?.previous.calls ?? 0) + n.calls;
    narrowed = n.narrowed;
  }
  // P1-D13 (2026-10-02): a goal's whole structure is ONE plan (`plan.ts`) — sources, rows, loop, schedule, conditions, where each
  // action runs, approvals, recipients — lowered by code onto the spec and wiring the solver builds from. An EDIT is planned the
  // same way (After Phase 4): the plan names the automation's existing lists, prepared text and paths.
  const edit = cur ? { current: cur, existing: existing ?? { lists: [], producers: [], paths: [] } } : undefined;
  let spec: GoalSpec;
  const planNotes: string[] = [];
  const readerChoices: NonNullable<Understood["choices"]> = [];
  if (shapeOnly && correction) {
    spec = JSON.parse(JSON.stringify(correction.previous.checked.spec)) as GoalSpec;
    // Re-prove band coverage after the rewrite — prior covered claims may name the old projection.
    if (spec.covered?.length) {
      spec = { ...spec, covered: spec.covered.filter((c) => !/\bband\b/i.test(c.quote)) };
    }
    planNotes.push(`Reshaped output columns without re-planning: ${shapeCols.join(", ")}.`);
  } else {
    // The plan reads the person's words as one text: the goal, then each thing they said since (each its own clauses).
    let said = correction && !restated && !defs ? [goal, ...(correction.words ?? [correction.text])].join(". ") : goal;
    const meanings = texts.filter((t) => MEANING_TEXT.test(t));
    let made = await makePlan(said, items, chooser, (sc, raw) => parseStrict<Plan>(sc, raw, "builder:plan"), correction ? "builder:plan:corrected" : "builder:plan", edit, meanings);
    calls += made.asked;
    // Step 5 (builder-IR): validate the model's plan against the workspace; on findings re-prompt ONCE
    // with the findings verbatim, then re-validate. Still invalid → the findings are the turn's
    // readback/unmet and the plan is never mutated. (A bad field ref can never reach here via makePlan —
    // the strict schema enum rejects unknown fields at parse; the wiring stands for all other finding classes.)
    let findings = validatePlan(made.plan, items, clauses(said));
    if (findings.length) {
      const cs = clauses(said);
      const schema = planSchema(items, cs, edit);
      const prompt = `${planPrompt(said, items, cs, edit)}\n\nthe plan does not satisfy the workspace: ${findings.map((f) => `${f.where}: ${f.message}`).join(" · ")}`;
      calls += 1;
      const repaired: Plan = normalisePlan(parseStrict<Plan>(schema, await chooser(prompt, { name: "goal_plan", schema }, "builder:plan:repair", undefined, PLAN_SYSTEM), "builder:plan:repair"));
      findings = validatePlan(repaired, items, cs);
      if (!findings.length) made = { plan: repaired, findings: made.findings, asked: made.asked };
    }
    // Still invalid after the single repair: the findings are the turn's answer — stated as
    // readback/unmet, nothing persisted. The plan is returned untouched (never mutated).
    if (findings.length) {
      const lines = findings.map((f) => `${f.where}: ${f.message}`);
      const failed: GoalSpec = { sources: [], sinks: [], values: [], conditions: [], schedule: null, missing: lines.join(" · "), planGaps: lines };
      const checked: CheckedSpec = { spec: failed, dropped: [], texts: [...texts] };
      return { ...(existing ? { existing } : {}), goal, texts, checked, readback: lines, outcome: "cannot", corrected: !!correction, calls, ...(settled.length ? { settled } : {}), ...(narrowed ? { narrowed } : {}), ...(cur ? { current: cur } : {}), ...(known?.length ? { known } : {}) };
    }
    const lowered = planToSpec(made.plan, clauses(said), items, said, edit);
    spec = lowered.spec;
    // A finding the re-ask did not clear and that names no clause is STATED, never dropped: a plan that still contradicts itself is not
    // built as if it did not (a condition that tested each item with no for-each was built as "any row", and the flow was saved as
    // if it did what the goal said).
    const stillWrong = made.findings.filter((f) => !/^C\d+ /.test(f) && !(spec.planGaps ?? []).includes(f));
    if (stillWrong.length) spec = { ...spec, planGaps: [...(spec.planGaps ?? []), ...stillWrong] };
    planNotes.push(...lowered.notes);
    for (const x of made.plan.sources) if (x.also?.length && !readerChoices.some((c) => c.ref === x.ref)) readerChoices.push({ ref: x.ref, also: x.also });
  }
  // A correction (or column reshape) must be able to revise a settled written read. Sources still naming the local
  // ref never enter the new_read write loop — remap so sameProjection can skip a no-op, or rewrite when the contract moved.
  if (correction && (correction.previous.local?.length ?? 0) > 0) {
    for (const l of correction.previous.local!) {
      if (spec.sources.some((s) => s.ref === l.ref)) {
        const nr = newReadOf(l.datasource);
        spec = { ...spec, sources: spec.sources.map((s) => (s.ref === l.ref ? { ...s, ref: nr } : s)) };
      }
    }
  }
  // A TABLE chosen for a goal that sends to people the DATA names becomes a read written for the goal (2026-10-02). A table's
  // types say a field is an address, never WHOSE: `project_allocation` carries the employee's email through its join, and "email
  // their project managers" over it can only reach the wrong people or none (H06). Whose address the words mean is the written
  // read's CONTRACT ("every row carries the address of “their project managers”"), resolved against the schema and confirmed by
  // the person. A saved reader is its owner's declaration and is kept. (Was: swap only a table with NO address field — a guess
  // about whose address, made before anything was built.)
  const to = peopleInRows(spec);
  if (to) {
    spec = { ...spec, sources: spec.sources.map((x) => {
      if (!isTableRef(x.ref)) return x;
      const nr = newReadOf(x.ref.slice(0, x.ref.indexOf(".table.")));
      return items.items.some((i) => i.ref === nr) ? { ...x, ref: nr } : x;
    }) };
  }
  // A read WRITTEN for this goal (2026-10-01): the understanding call chose "a new read of <datasource>" because no single reader gives
  // the rows. The proposer writes it (one call per datasource), and the goal is understood AGAIN with the written read in the
  // catalogue — so the values the goal states map onto its real parameters and its real fields, by the same call and checks as any
  // reader. A read that cannot be written is stated (`missing`), never guessed at.
  const local: LocalReader[] = [...(correction?.previous.local ?? [])];
  /** What each written read interpreted (`as`) or could not give (`why`), in the need's words — asked, or stated (`readNotes`). */
  const notes: ReadNote[] = [];
  /** What each written read could not give — stated in the readback and left uncovered, never asked. */
  const leftOut: Array<{ words: string; why: string; read: string }> = [];
  /** Strategy B Phase 3: dry-run / column previews — stated only. */
  const previews: string[] = [];
  /** What an earlier round settled (a confirmation) stays covered. */
  const covers: NonNullable<GoalSpec["covered"]> = [...(correction?.previous.checked.spec.covered ?? [])];
  const choices = [...new Set(spec.sources.map((x) => x.ref).filter(isNewRead))];
  if (choices.length) {
    const made: BuilderCatalogue["items"] = [];
    const refused: string[] = [];
    for (const choice of choices) {
      const quotes = spec.sources.filter((x) => x.ref === choice).map((x) => x.quote);
      // ONE written read per datasource per build: the choice to write one when this build already wrote one revises THAT read.
      const ds = datasourceOfNewRead(choice);
      const prior = local.find((l) => l.datasource === ds);
      // Phase 1: the read's interface is CODE's — its parameters (named and typed from the person's words), the address its rows
      // must carry, the words it carries out — fixed before the proposer is called, and the proposal is held to it.
      // P7 (R17): an action that declares a row's identity (a required Key port) and runs per row needs the read to return it.
      const identity = spec.sinks.some((x) => Object.values(declarationOf(x.ref, items.items.find((i) => i.ref === x.ref)?.params ?? []).ports ?? {}).some((d) => d.ty?.t === "Key"));
      let contract = readContract(spec, choice, texts, peopleInRows(spec), identity);
      const bandMeasures: BandMeasureIn[] = (spec.summary?.measures ?? []).flatMap((m) =>
        (m.fn as string) === "band_count" && (m as { bands?: BandMeasureIn["bands"] }).bands?.length
          ? [{ words: m.words, field: m.field, bands: (m as { bands: BandMeasureIn["bands"] }).bands, ...((m as { counts?: string | null }).counts != null ? { counts: (m as { counts?: string | null }).counts } : {}) }]
          : [],
      );
      const groupByFields = (spec.summary?.by ?? []).map((field, i) => ({
        field,
        words: spec.summary?.byWords?.[i] ?? field,
      }));
      // LATENCY: skip rewrite only when the contract AND band projection match — a column-shape
      // edit keeps params identical but must revise the local (handout turn 2).
      const prevContract = correction ? readContract(correction.previous.checked.spec, choice, correction.previous.texts, peopleInRows(correction.previous.checked.spec), identity) : null;
      const prevBands = correction
        ? (correction.previous.checked.spec.summary?.measures ?? []).flatMap((m) =>
          (m.fn as string) === "band_count" && (m as { bands?: BandMeasureIn["bands"] }).bands?.length
            ? [{ words: m.words, bands: (m as { bands: BandMeasureIn["bands"] }).bands, ...((m as { counts?: string | null }).counts != null ? { counts: (m as { counts?: string | null }).counts } : {}) }]
            : [])
        : [];
      const prevGroup = correction
        ? (correction.previous.checked.spec.summary?.by ?? []).map((field, i) => ({
          field,
          words: correction.previous.checked.spec.summary?.byWords?.[i] ?? field,
        }))
        : [];
      const shapeEdit = shapeOnly;
      const sigOf = (c: ReadContract | null, bands: Array<{ words: string; bands?: unknown }>, group: Array<{ field: string; words: string }>) => JSON.stringify({ c, p: { m: bands.map((m) => m.words), g: group.map((g) => `${g.field}:${g.words}`) } });
      const sameProjection = sigOf(prevContract, prevBands, prevGroup) === sigOf(contract, bandMeasures, groupByFields);
      if (prevContract && prior && sameProjection && !shapeEdit) {
        const priorItem = items.items.find((i) => i.ref === prior.ref);
        if (priorItem) {
          made.push(priorItem);
          // Re-derive covered from prior aliases + pinned arms (covered is not in Intent IR).
          if (bandMeasures.length) {
            const aliasBlob = (priorItem.fields ?? []).map((f) => f.name).join(" ");
            const bandPayload = bandMeasures.map((m) => ({ words: m.words, arms: m.bands }));
            const bandDone = clausesProvenBy(bandPayload.flatMap((m) => [m.words, ...m.arms.map((a) => a.words)]), { aliases: aliasBlob.split(/\s+/).filter(Boolean) })
              .map((quote) => ({ quote, by: prior.ref }));
            if (bandDone.length) {
              spec = {
                ...spec,
                covered: [...(spec.covered ?? []).filter((c) => !bandDone.some((b) => b.quote === c.quote)), ...bandDone],
                planGaps: (spec.planGaps ?? []).filter((g) => !/bands compute in a written read/i.test(g)),
              };
            }
          }
          continue;
        }
      }
      const writeWith = async (contract: ReadContract): Promise<WrittenRead | { refused: string }> => write
        ? await write(
          ds,
          readNeed(texts, quotes, contract, bandMeasures.map((m) => ({ field: m.field ?? "", words: m.words, arms: m.bands })), groupByFields),
          local.filter((l) => l !== prior).map((l) => l.ref),
          texts,
          prior,
          contract,
          spec.values.filter((v) => ["period", "date", "threshold", "count"].includes(v.role)).map((v) => v.quote),
          quotes,
          bandMeasures,
          groupByFields,
        )
        : { refused: "a new read cannot be written here" };
      let r = await writeWith(contract);
      // An ADDRESS is one action's need, never the data's: rows that cannot carry the address of the people one action is sent to are
      // still the rows every other action and test needs (2026-10-04: a request for a team's address no table has, and the
      // whole read was refused — every branch with it). Written again without it; that action's recipient is then "no data holds
      // their address" — stated by the solver on that action alone.
      if ("refused" in r && contract.address) {
        console.warn(`[builder] a read of ${ds} was refused while it had to carry the address of “${contract.address}”: ${r.refused.slice(0, 300)} — writing it again without the address`);
        const without: ReadContract = { ...contract }; delete without.address;
        const again = await writeWith(without);
        calls++;
        if (!("refused" in again)) {
          const who = contract.address;
          spec = { ...spec, values: spec.values.map((v) => (v.role === "recipient" && v.from === "goal" && v.quote === who ? { ...v, field: RECIPIENT_FIELD_NONE } : v)) };
          contract = without; r = again;
        }
      }
      calls++;
      if ("refused" in r) refused.push(r.refused);
      else {
        if (prior) local.splice(local.indexOf(prior), 1);
        local.push(r.reader); made.push(r.item);
        if (r.preview) previews.push(r.preview);
        // builder-behaviour P3 (R7): what the read says about words ANOTHER part of the plan carries (an action, the schedule, an
        // approval, a per-item test) is not the read's — set aside, never asked or stated as the data's (B17: a request for an action the data cannot give).
        const own = (x: { words: string }) => !(contract.owned ?? []).some((q) => q.toLowerCase().includes(x.words.toLowerCase().trim()));
        const assumed = r.assumed.filter(own), left = oneGapPerPhrase(r.leftOut.filter(own), texts), unnamed = (r.unnamed ?? []).filter(own);
        // What it interpreted is the ONE confirmation question; what it could not give is STATED — never a question to the person.
        notes.push(...assumed.map((a) => ({ ...a, read: r.reader.ref })));
        leftOut.push(...left.map((l) => ({ ...l, read: r.reader.ref })));
        // Defect 4: a data word nothing gives is ASKED (with why), never stated under the action that swallowed its words.
        notes.push(...unnamed.map((u) => ({ ...u, read: r.reader.ref, data: true })), ...left.filter((l) => l.data).map((l) => ({ ...l, read: r.reader.ref })));
        // The spec, by code: the choice is the read, each parameter's value fills it, the read's words are covered.
        spec = applyContract(spec, choice, r.reader.ref, contract, [...r.leftOut, ...(r.unnamed ?? [])].map((l) => l.words), (r.item.params ?? []).map((x) => x.name));
        // P9 + prove-before-cover: band clauses are covered only when written aliases prove the stated bands.
        if (bandMeasures.length) {
          const aliasNames = (r.item.fields ?? []).map((f) => f.name);
          const bandPayload = bandMeasures.map((m) => ({ words: m.words, arms: m.bands }));
          const bandDone = clausesProvenBy(bandPayload.flatMap((m) => [m.words, ...m.arms.map((a) => a.words)]), { aliases: aliasNames })
            .map((quote) => ({ quote, by: r.reader.ref }));
          spec = {
            ...spec,
            covered: [...(spec.covered ?? []).filter((c) => !bandDone.some((b) => b.quote === c.quote)), ...bandDone],
            planGaps: (spec.planGaps ?? []).filter((g) => !/bands compute in a written read/i.test(g)),
          };
        }
        // A per-group action sent to the people the rows name (the contract's `address`): each group KEEPS the read's address — a group
        // stage carries only the fields named for it, and a written read's address column exists only now (2026-10-04: "for each site
        // … email the site's contact" — the read returned the contact, the group dropped it, and every email had no recipient).
        if (contract.address) spec = carryAddresses(spec, r.reader.ref, r.item.fields ?? []);
      }
    }
    // A revised read REPLACES its own entry (same ref): two entries under one ref would offer the model the old form beside the new.
    items = { ...items, items: [...made, ...items.items.filter((i) => !isNewRead(i.ref) && !made.some((m) => m.ref === i.ref))] };
    if (refused.length) spec = { ...spec, sources: spec.sources.map((x) => (isNewRead(x.ref) ? { ...x, ref: NONE_FIT } : x)), missing: refused.join("; ") };
  }
  // Settled local readers (source already the written ref — no new_read choice) still need band clauses
  // re-proven; otherwise a post-complete edit keeps a band clause unmet forever.
  {
    const bandPayload = (spec.summary?.measures ?? []).flatMap((m) =>
      (m.fn as string) === "band_count" && (m as { bands?: BandMeasureIn["bands"] }).bands?.length
        ? [{ words: m.words, arms: (m as { bands: BandMeasureIn["bands"] }).bands }]
        : [],
    );
    if (bandPayload.length) {
      for (const l of local) {
        if (!spec.sources.some((s) => s.ref === l.ref)) continue;
        const item = items.items.find((i) => i.ref === l.ref);
        if (!item) continue;
        const aliasBlob = (item.fields ?? []).map((f) => f.name).join(" ");
        const bandDone = clausesProvenBy(bandPayload.flatMap((m) => [m.words, ...m.arms.map((a) => a.words)]), { aliases: aliasBlob.split(/\s+/).filter(Boolean) })
          .map((quote) => ({ quote, by: l.ref }));
        if (bandDone.length) {
          spec = {
            ...spec,
            covered: [...(spec.covered ?? []).filter((c) => !bandDone.some((b) => b.quote === c.quote)), ...bandDone],
            planGaps: (spec.planGaps ?? []).filter((g) => !/bands compute in a written read/i.test(g)),
          };
        }
      }
    }
  }
  items = { ...items, items: items.items.filter((i) => !isNewRead(i.ref)) };
  // What a written read interpreted or left out is the person's to settle — asked like their own unclear words, before building on
  // them (`run`). Only words that ARE the person's (quoted from their text) are asked; any other is stated in the readback.
  // Words the spec already ties to something precise — a value, an action, the schedule, a condition, a stage — are settled there,
  // not the read's to ask about ("active employees" → the status value; "Email the CSV file to me" is an action, never a read's).
  // One question per set of words: an assumption first (it says what was chosen), then a part left out; either one replaces the
  // spec's own plain unclear entry for the same words.
  const precise = [...spec.values.map((v) => v.quote), ...spec.sinks.map((x) => x.quote), ...(spec.schedule ? [spec.schedule.quote] : []), ...spec.conditions.filter((c) => c.field && c.test).map((c) => c.quote), ...(spec.shapes ?? []).flatMap((sh) => sh.stages.map((x) => x.quote))];
  // Inside a settled quote, never merely containing one: a settled value inside a longer phrase is kept,
  // and the longer phrase is still the read's to ask about.
  const kept = notes.filter((n) => n.data || !precise.some((p) => p.toLowerCase().includes(n.words.toLowerCase().trim()))).sort((a, b) => Number(!a.as) - Number(!b.as));
  const asked: ReadNote[] = [];
  for (const n of kept) if (quoted(n.words, texts) && !asked.some((a) => overlapping(a.words, n.words))) asked.push(n);
  if (asked.length) spec = { ...spec, unclear: [...(spec.unclear ?? []).filter((u) => !asked.some((a) => overlapping(a.words, u.quote))), ...asked.map((n) => ({ quote: n.words, about: "data" as const, read: n.read, ...(n.as ? { assumed: n.as } : n.why ? { missing: n.why } : {}) }))] };
  // Words a read carries out are settled by it — unless they sit INSIDE words still open (asked above): an open question outranks a
  // claim on the same words. An open question about PART of a claim does not cancel the claim — the part is still asked.
  if (settled.length && spec.unclear?.length) {
    const before = (u: NonNullable<GoalSpec["unclear"]>[number]) => !("assumed" in u && u.assumed) && !("missing" in u && u.missing) && settled.some((q) => norm(q).includes(norm(u.quote)));
    for (const u of spec.unclear.filter(before)) planNotes.push(`“${u.quote}” — as the automation already has it`);
    spec = { ...spec, unclear: spec.unclear.filter((u) => !before(u)) };
  }
  const open = (spec.unclear ?? []).map((u) => norm(u.quote));
  const all_ = [...covers.filter((c) => !(spec.covered ?? []).some((x) => x.quote === c.quote)), ...(spec.covered ?? [])];
  const clauseInGoal = (q: string) => {
    const g = norm(texts[0] ?? "");
    const qn = norm(q).replace(/^["'.,;:!?…]+|["'.,;:!?…]+$/g, "");
    return !!qn && !!g && g.includes(qn);
  };
  const doneBy = all_.filter((c) => (quoted(c.quote, texts) || clauseInGoal(c.quote)) && !open.some((q) => q.includes(norm(c.quote))));
  spec = { ...spec, covered: doneBy.length ? doneBy : undefined };
  const checked = checkSpec(spec, texts, items, kv, existing, settled);
  const stated = kept.filter((n) => !asked.some((a) => overlapping(a.words, n.words))).map((n) => (n.as ? `The read ${n.read} takes “${n.words}” as ${n.as}` : `The read ${n.read} does not give “${n.words}”: ${n.why}`));
  return { ...(existing ? { existing } : {}), goal, texts, checked, readback: [...readback(checked, items), ...planNotes, ...stated, ...previews, ...leftOut.filter((l) => !(l as { data?: boolean }).data && !precise.some((q) => q.toLowerCase().includes(l.words.toLowerCase().trim()))).map((l) => `The read ${l.read} does not give “${l.words}”: ${l.why}`)], outcome: specOutcome(checked.spec), corrected: !!correction, calls, ...(settled.length ? { settled } : {}), ...(narrowed ? { narrowed } : {}), ...(cur ? { current: cur } : {}), ...(known?.length ? { known } : {}), ...(local.length ? { local } : {}), ...(readerChoices.length ? { choices: readerChoices } : {}) };
}
/**
 * Step 5 (builder-IR): `recheck` is a plain re-read of the stored spec — the
 * spec is returned as sent, with readback/outcome re-derived by code. No
 * drop/fix rewriting: what the checks do not pass is stated, never repaired.
 */
export function recheck(sent: { goal: string; texts: string[]; spec: GoalSpec; corrected?: boolean; known?: KnownValue[]; existing?: WiringExisting; settled?: string[] }, items: BuilderCatalogue): Understood {
  const texts = [sent.goal, ...sent.texts.slice(1)]; // the goal is always the first of the person's words
  const checked: CheckedSpec = { spec: sent.spec, dropped: [], texts: [...texts] };
  return { ...(sent.existing ? { existing: sent.existing } : {}), goal: sent.goal, texts, checked, readback: readback(checked, items), outcome: specOutcome(sent.spec), corrected: !!sent.corrected, calls: 0, ...(sent.known?.length ? { known: sent.known } : {}), ...(sent.settled?.length ? { settled: sent.settled } : {}) };
}

/** A correction: re-understood ONCE. A second one is refused — the disagreement is stated, never re-asked in a loop. */
export const MAX_REPLANS = 3;
/** the answer to a question the person set aside ("not now") — settled as built: a reading kept, a word unasked. */
export const LEFT_AS_BUILT = "(left as built)";
export async function correct(prev: Understood, text: string, items: BuilderCatalogue, chooser: Chooser, words?: string[], write?: ReadWriter, defs?: string[]): Promise<Understood | { unresolved: string }> {
  if (prev.corrected && (prev.replans ?? 0) < MAX_REPLANS) {
    const again = await understand(prev.goal, items, chooser, { previous: prev, text, ...(words ? { words } : {}), ...(defs?.length ? { defs } : {}) }, undefined, undefined, undefined, write);
    return { ...again, replans: (prev.replans ?? 0) + 1 };
  }
  if (prev.corrected) return { unresolved: `The goal was re-planned from your answers ${MAX_REPLANS} times and still does not match; building stops here rather than asking again. Rephrase the goal to start over.` };
  const first = await understand(prev.goal, items, chooser, { previous: prev, text, ...(words ? { words } : {}), ...(defs?.length ? { defs } : {}) }, undefined, undefined, undefined, write);
  return { ...first, replans: 1 };
}

/** A whole answer that only says yes — the one reply that confirms an assumption as it stands. Anything longer is what they mean. */
const YES = CONFIRMS;

/** Answers the person's questions: one answer per question, or `null` to keep it unanswered (a stated incomplete). */
export type Answerer = (questions: BuildQuestion[]) => Promise<Array<string | null>>;

export interface RunResult {
  flow: EFlow;
  trace: BuildTrace;
  /** `unchanged`: an edit that added nothing — nothing is written (a revision identical to the draft is not a change). */
  status: "complete" | "incomplete" | "cannot" | "unchanged";
  /** D-294's rules over this trace — `[]` on every build; a harness asserts it. */
  loopProblems: string[];
  /** E5.5: the goal as re-understood after the person wrote back — what a caller saves, when set. */
  understood?: Understood;
}

/**
 * The id an unclear question gets — CONTENT-KEYED, never positional (contract C3): the unclear list is re-derived on every
 * re-understanding, so an index would move under a stored answer and hand it to the wrong question. The same unknown in the
 * same build always derives the same id, which is what lets an answer outlive the round that asked it.
 */
export const unclearHoleId = (quote: string, about: string): string => `unclear:${norm(quote)}:${about}`;

/**
 * The ONE question that confirms a written read's interpretations — keyed by the WORDS it asks about, never by position. A positional
 * id let a stored "yes" confirm a later revision's different interpretations unread; keyed by words, a new set is a new question.
 */
export const assumedHoleId = (quotes: readonly string[]): string => `assumed:${[...new Set(quotes.map(norm))].sort().join("|")}:data`;
/** The words a person has already spoken to through an assumptions question (confirmed or corrected) — never asked about again. */
export const assumedWordsAnswered = (answered: Iterable<string>): Set<string> =>
  new Set([...answered].filter((id) => id.startsWith("assumed:")).flatMap((id) => id.slice("assumed:".length, id.lastIndexOf(":")).split("|")));

/**
 * Build from a confirmed spec (D-322): the SOLVER builds it by code; then question rounds — each value hole asked once, at most
 * `MAX_ROUNDS` — and the solver continues with the answers. No model is called here: the model's part was the spec. `_chooser` is
 * kept in the signature for the callers that still pass one (the phase-4 `construct` loop is not used, D-322). A spec whose
 * outcome is `cannot` builds nothing.
 */
export async function run(u: Understood, items: BuilderCatalogue, cat: CatalogueSnapshot, chooser: Chooser, answerer: Answerer, start: EFlow = emptyFlow(slugify(u.goal).slice(0, 40) || "automation"), write?: ReadWriter, opts: { wholeRound?: boolean } = {}): Promise<RunResult> {
  // E5.5: words the model could not tie to anything are the person's to explain — asked FIRST, before anything is built on them;
  // the goal is re-understood ONCE with the answers (`correct`), and whatever is still unclear is stated unmet. Never a loop.
  // Slice 5f: in the SAME round, where the result goes and who gets it, when the spec keeps it open (`deliveryFindings`). That
  // answer fills ITS slot and nothing else (E5.10: re-reading the whole goal with it lost 5 of 6 answers) — as does code's finding
  // about an action that cannot reach who the goal names. The unclear words keep their one re-understanding, without it.
  // A goal this workspace cannot build is refused with its reasons: only words that could name the missing component (what data,
  // what action) are worth asking first — an unclear VALUE cannot change a refusal (D21: "what do you mean by “rejected”?", then no).
  // S6 delta-only choke point (2026-10-08): a settled-anchored unclear emission is rejected IN CODE, whatever the model flagged.
  // A flag overlapping a settled quote by exact-norm match is filtered before the question round — never emitted, never re-asked. A
  // read's own question (`read` set) still passes: it was judged where it was made, not by an earlier revision.
  const unclear = (u.checked.spec.unclear ?? [])
    .filter((x) => u.outcome !== "cannot" || x.about === "data" || x.about === "action")
    .filter((x) => { const read = (x as { read?: string }).read; return !!read || !settledMatch(x.quote, u.settled ?? []); });
  // An edit of a flow that already acts is not asked where results go: what it adds rides on what is there (D-321).
  const del = u.corrected || start.steps.some((x) => x.kind === "tool") ? null : deliveryFindings(u.checked.spec, cat);
  // after a re-plan, what it raises that was never asked is asked — once each (a question already answered
  // is not fresh), and at most MAX_REPLANS re-plans per build. Was: nothing after the first re-plan was ever asked, so its new
  // readings ended the build as "…was read as …, and that was not confirmed".
  // Every unclear item not yet POSED in this call enters the round — an answered one replays its stored answer (so a "yes" given
  // after a re-plan is applied), an unanswered one is asked. `posed` is what bounds it.
  const posedIds = new Set(u.posed ?? []);
  const fresh = u.corrected && (u.replans ?? 0) < MAX_REPLANS && unclear.some((x) => !posedIds.has(x.assumed ? assumedHoleId([x.quote]) : unclearHoleId(x.quote, x.about)) && !(x.assumed && [...posedIds].some((id) => id.startsWith("assumed:") && id.slice(8, id.lastIndexOf(":")).split("|").includes(norm(x.quote)))));
  if ((unclear.length || del?.ask || del?.notes.length) && (!u.corrected || fresh)) {
    // A meaning a written read ASSUMED is asked as itself — confirmed, or replaced by what the person says; never taken silently. Every
    // assumption is ONE question (2026-10-01: four "By … I took …" asked one per turn); "yes" confirms them all. Words a read could not
    // give are asked WITH the reason, so the person learns on the first turn what is missing, not after asking themselves out.
    const plain = unclear.filter((x) => !x.assumed);
    // An interpretation the person already confirmed or corrected (in an earlier round of this build) is not asked about again —
    // the read was revised with their words, and re-confirming the same words is the "yes, yes, yes" the person reported.
    // settled means CONFIRMED — answered with a yes. Any other answer to "By X I took Y, is that what you
    // mean?" is the person's correction; counted as settled, it was taken as a yes and the build kept the reading they rejected.
    const spoken = assumedWordsAnswered(u.answerTexts ? (u.answered ?? []).filter((id) => !id.startsWith("assumed:") || YES.test(u.answerTexts![id]?.trim() ?? "")) : (u.answered ?? []));
    // MEM4: a re-plan's new reading of words the person already gave a meaning for is the read's reading of THEIR meaning — settled,
    // never asked back (the person was asked to confirm their own answer).
    const meant = meantWords(u.texts ?? []);
    const spokenTo = (x: { quote: string }) => meant.some((q) => q.includes(norm(x.quote)) || norm(x.quote).includes(q));
    const assumedAll = unclear.filter((x) => x.assumed && !spoken.has(norm(x.quote)) && !spokenTo(x));
    const askPlain = (x: (typeof unclear)[number]) => (x.missing ? `I cannot give “${x.quote}” from this data — ${x.missing}. What do you mean by it?` : `What do you mean by “${x.quote}”?`);
    // Said to a person: in their words, never the read's identifiers ("some_table.some_column" → "some column"). Several readings
    // are one list — a lead line, one "• " line each, and what to reply — which the chat renders as a list.
    const askAssumed = assumedAll.length === 1
      ? `By “${assumedAll[0]!.quote}” I took ${plainWords(assumedAll[0]!.assumed!)}. Is that what you mean? If not, say what you mean.`
      : ["Please confirm how I read your request:", ...assumedAll.map((x) => `• “${x.quote}” — ${plainWords(x.assumed!)}`), "Reply “yes” if these are right, or tell me which one is wrong and what you meant."].join("\n");
    const qs: BuildQuestion[] = [
      ...plain.map((x) => ({ holeId: unclearHoleId(x.quote, x.about), about: wordsAnchor(x.quote), ask: askPlain(x), round: 1 })),
      ...(assumedAll.length ? [{ holeId: assumedHoleId(assumedAll.map((x) => x.quote)), ask: askAssumed, round: 1 }] : []),
    ];
    // Each unclear entry's reply: its own question's, or the one assumptions question's.
    const replyOf = (x: (typeof unclear)[number], replies: Array<string | null>) => (x.assumed ? replies[plain.length] : replies[plain.indexOf(x)]);
    if (del?.ask) qs.push({ holeId: "delivery:0:delivery", ask: DELIVERY_ASK, round: 1, options: del.options });
    const replies = qs.length ? await answerer(qs) : [];
    qs.forEach((q, k) => { q.answer = replies[k] ?? undefined; q.filled = !!replies[k]?.trim(); });
    // `wholeRound` (a conversation, which asks these one per turn): the round is acted on only when ALL of it is answered. The goal
    // is re-understood ONCE — on part of the answers it would be re-read again with each later answer, differently, and a read
    // written for the first answer would be lost by the next (2026-10-01: "LOP days" wrote a read; the next turn's re-reading
    // went back to the old one). Until then the build stands as understood, its questions open.
    if (opts.wholeRound && qs.some((q) => !q.filled)) {
      const r = await run({ ...u, corrected: true, posed: [...(u.posed ?? []), ...qs.map((q) => q.holeId)] }, items, cat, chooser, answerer, start, write);
      r.trace.questions.unshift(...qs);
      return { ...r, loopProblems: noLoopProblems(r.trace) };
    }
    let cur: Understood = u;
    // A confirmed assumption is settled as it stands: it keeps the open words and re-reads nothing. Any other answer to it is
    // what the words mean, like an answer to an unclear word.
    // Words already spoken to are settled as they stand too: their answer was given in an earlier round and is in the texts.
    const confirmed = new Set(unclear.flatMap((x) => (x.assumed && (spoken.has(norm(x.quote)) || spokenTo(x) || (assumedAll.includes(x) && (YES.test(replyOf(x, replies)?.trim() ?? "") || replyOf(x, replies) === LEFT_AS_BUILT))) ? [x.quote] : [])));
    if (confirmed.size) {
      // A confirmed reading is the READ's: its words are now carried out by it, counted as built and stated as such — never "not built".
      const done = (u.checked.spec.unclear ?? []).filter((x) => confirmed.has(x.quote) && x.read).map((x) => ({ quote: x.quote, by: x.read!, ...(x.assumed ? { as: x.assumed } : {}) }));
      const covered = [...(u.checked.spec.covered ?? []), ...done];
      const checked = checkSpec({ ...u.checked.spec, unclear: (u.checked.spec.unclear ?? []).filter((x) => !confirmed.has(x.quote)), ...(covered.length ? { covered } : {}) }, u.texts, items, [], undefined, u.settled ?? []);
      cur = { ...u, checked, readback: readback(checked, items), outcome: specOutcome(checked.spec) };
    }
    const assumedReply = assumedAll.length && !assumedAll.some((x) => confirmed.has(x.quote)) && replies[plain.length] !== LEFT_AS_BUILT ? replies[plain.length]?.trim() : undefined;
    const said = [
      ...plain.flatMap((x) => (replyOf(x, replies)?.trim() && replyOf(x, replies) !== LEFT_AS_BUILT ? [`“${x.quote}” means ${replyOf(x, replies)!.trim()}`] : [])),
      ...(assumedReply ? [`About these readings (${assumedAll.map((x) => `“${x.quote}” as ${x.assumed}`).join("; ")}): ${assumedReply}`] : []),
    ];
    if (said.length) {
      // MEM2 (2026-10-06): an answer about what words MEAN is kept as a meaning of those words, beside the goal — never restated into
      // the goal as a new sentence (it became a clause nothing implemented, and the person was asked about their own answer as unbuilt
      // work). The plan reads the meanings as meanings; they add no clause.
      const defs = [
        ...plain.flatMap((x) => (replyOf(x, replies)?.trim() && replyOf(x, replies) !== LEFT_AS_BUILT ? [`“${x.quote}” means: ${replyOf(x, replies)!.trim()}`] : [])),
        ...(assumedReply ? [`About how ${assumedAll.map((x) => `“${x.quote}”`).join(", ")} ${assumedAll.length > 1 ? "were" : "was"} read, the person says: ${assumedReply}`] : []),
      ];
      // MEM3: a read WRITTEN for this goal whose readings were answered stays in the catalogue for this re-plan, so the writer revises it
      // (same ref) with the meaning — re-choosing it as it stands kept the reading the person just replaced.
      // T13 / Intent IR: do NOT strip it — Phase 1 pin keeps settled sources; filtering the reader out emptied `sources` and
      // inventing a table (e7412613). Flag off: keep MEM3 so pre-IR revise-in-place still works.
      const answeredReads = intentIrEnabled()
        ? new Set<string>()
        : new Set(unclear.filter((x) => x.read && (x.assumed ? !!assumedReply : !!replyOf(x, replies)?.trim() && replyOf(x, replies) !== LEFT_AS_BUILT)).map((x) => x.read!));
      const replanItems = answeredReads.size ? { ...items, items: items.items.filter((i) => !answeredReads.has(i.ref)) } : items;
      const again = await correct(cur, said.join("; "), replanItems, chooser, defs, write, defs);
      if (!("unresolved" in again)) cur = again;
    }
    const d = qs.findIndex((q) => q.holeId.startsWith("delivery:"));
    const answer = d >= 0 ? replies[d]?.trim() || null : null;
    if (answer || deliveryFindings(cur.checked.spec, cat).notes.length) {
      const settled = await settleDelivery(cur.checked.spec, answer, u.goal, items, cat, chooser);
      if (settled) {
        const texts = answer ? [...cur.texts, answer] : cur.texts;
        const checked = checkSpec(settled.spec, texts, items, [], undefined, u.settled ?? []);
        cur = { ...cur, texts, checked, readback: readback(checked, items), outcome: specOutcome(checked.spec), calls: cur.calls + settled.calls };
      }
    }
    // `understood` is reported only when the goal WAS re-understood (an answer re-read it, or delivery was settled) — never for a
    // round that changed nothing, which a caller would otherwise store as settled while its questions are still open.
    const changed = cur !== u;
    cur = { ...cur, corrected: true, posed: [...(u.posed ?? []), ...qs.map((q) => q.holeId)] };
    const r = await run(u.drafts ? withDrafts(cur, cat, start) : cur, items, cat, chooser, answerer, start, write, opts);
    r.trace.questions.unshift(...qs);
    return { ...r, ...(changed ? { understood: r.understood ?? cur } : {}), loopProblems: noLoopProblems(r.trace) };
  }
  if (u.outcome === "cannot") return { flow: start, trace: { ...emptyTrace(), stop: "none_fit", unmet: cannotReasons(u.checked.spec) }, status: "cannot", loopProblems: [] };
  const trace = emptyTrace();
  if (u.requester) trace.requester = u.requester;
  if (u.known?.length) trace.known = u.known;
  trace.base = start.steps.map((x) => ({ kind: x.kind, id: x.id, ...("ref" in x && x.ref ? { ref: x.ref } : {}) }));
  // Round 1: the values the CONFIRMED spec says will be asked — before building, so the solver has the answers. Each once.
  // E5.5: plus a condition whose value the goal only described — the one question that is not a port: what counts as “too long”.
  const specQs = [...specQuestions(u.checked.spec), ...conditionQuestions(u.checked.spec, items), ...shapeQuestions(u.checked.spec, items)];
  const answers = new Map<number, string>();
  const condAnswers = new Map<number, string>();
  const shapeAnswers = new Map<string, string>();
  if (specQs.length) {
    trace.questions.push(...specQs);
    const replies = await answerer(specQs);
    specQs.forEach((q, k) => {
      const a = replies[k]?.trim(); q.answer = replies[k] ?? undefined; q.filled = !!a;
      if (!a) return;
      const [kind, i, j] = q.holeId.split(":");
      if (kind === "shape") shapeAnswers.set(`${i}:${j}`, a); else (kind === "cond" ? condAnswers : answers).set(Number(i), a);
    });
  }
  const answered = new Set(u.answered ?? []);
  let r = solveInto(start, u.checked, cat, answers, trace, u.drafts ?? [], condAnswers, shapeAnswers, answered);
  for (let round = specQs.length ? 2 : 1; round <= MAX_ROUNDS; round++) {
    // Only a VALUE is asked (a port hole the solver could not fill and no spec question covered). A structural hole stays a stated
    // incomplete: `answer` can only put a value in a port.
    const asked = r.flow.holes.filter((h) => h.site.at === "port" && !r.covered.includes(h.id)).map((h) => h.id);
    const qs = questionsFor(r.flow, asked, trace, round, cat);
    if (!qs.length) break;
    trace.questions.push(...qs);
    const replies = await answerer(qs);
    let f = r.flow;
    for (const [k, q] of qs.entries()) {
      const a = replies[k];
      if (a === null || a === undefined || !a.trim()) { q.filled = false; continue; }
      f = answer(f, q, a, cat, trace.requester);
    }
    r = solveInto(f, u.checked, cat, answers, trace, u.drafts ?? [], condAnswers, shapeAnswers, answered);
  }
  // D-321, checked by code over the result: an edit removed nothing and rebound nothing.
  const broke = editProblems(start, r.flow);
  if (broke.length) throw new Error(`an edit was not additive (a legality bug): ${broke.join(" · ")}`);
  const flow = lowerTableReaders(r.flow, items);
  const complete = !flow.holes.length && !r.unmet.length && !errorsOf(checkState(flow, cat)).length;
  trace.stop = complete ? "complete" : "done";
  const unchanged = start.steps.length > 0 && !trace.moves.length;
  return { flow, trace, status: unchanged ? "unchanged" : complete ? "complete" : "incomplete", loopProblems: noLoopProblems(trace) };
}

const ROLE_ASK: Record<string, string> = { recipient: "Who should receive it?", channel: "Which channel should it go to?", period: "Which period should it cover?", date: "Which date?", threshold: "What threshold should it use?", count: "How many?", subject: "What should the subject be?", text: "What should it say?", other: "What value should it use?" };
/**
 * The anchor of a question about the person's own words (MEM, 2026-10-06): those words, normalised, leading article dropped. A
 * question's id is re-derived on every re-plan (by position, by re-normalised quote); its anchor is what an answer is kept under.
 */
export const wordsAnchor = (quote: string): string => `words:${norm(quote).replace(/^(the|a|an) /, "")}`;

/** A text that is a MEANING the person gave (MEM2), not further words of their goal. */
export const MEANING_TEXT = /^(“.+” means: |About how .+ (was|were) read, the person says: )/;
/** The words of the goal the person has given meanings for (MEM4), normalised. */
export const meantWords = (texts: readonly string[]): string[] =>
  texts.filter((t) => MEANING_TEXT.test(t)).flatMap((t) => [...t.split(/ means: | read, the person says: /)[0]!.matchAll(/“([^”]+)”/g)].map((m) => norm(m[1]!)));

/** The spec's own questions: each value the person confirmed "I will ask you" for. */
export const specQuestions = (spec: GoalSpec): BuildQuestion[] => spec.values.flatMap((v, i) => (v.from === "ask_person" ? [{ holeId: `spec:${i}:${v.role}`, about: `value:${v.role}:${norm(v.quote ?? "")}`, ask: ROLE_ASK[v.role] ?? ROLE_ASK.other!, round: 1 }] : []));

/** "What counts as …?" for each condition the flow applies whose value the goal only described (`needsValue`), once, in round 1. */
export const conditionQuestions = (spec: GoalSpec, cat?: BuilderCatalogue): BuildQuestion[] => spec.conditions.flatMap((c, i) => {
  if (!needsValue(c)) return [];
  const field = c.field!.slice(c.field!.lastIndexOf(".") + 1);
  const role = c.test && ORDERING_TESTS.has(c.test) ? "threshold" : "other";
  const how = DAYS_TESTS.has(c.test!) ? "how many days before the day it runs?" : `${c.test!.replace(/_/g, " ")} what?`;
  // I-301: a field whose values are known is asked with them, as choices.
  const values = cat && SAME_TESTS.has(c.test!) ? domainOf(cat, c.field!) : null;
  return [{ holeId: `cond:${i}:${role}`, about: wordsAnchor(c.quote), ask: values ? `Which \`${field}\` counts as “${c.quote}”? — one of: ${values.join(", ")}` : `What counts as “${c.quote}”? (\`${field}\` ${how})`, round: 1, ...(values ? { options: values } : {}) }];
});

/** Slice 5e: a shape's stage that needs a value or a count the goal did not say — asked once, in round 1. */
export const shapeQuestions = (spec: GoalSpec, cat?: BuilderCatalogue): BuildQuestion[] => (spec.shapes ?? []).flatMap((sh, si) => sh.stages.flatMap((st, k) => {
  const need = shapeNeeds(st, VALUED_TESTS);
  if (!need) return [];
  if (need === "count") return [{ holeId: `shape:${si}:${k}:count`, about: wordsAnchor(st.quote), ask: `How many should it keep — “${st.quote}”?`, round: 1 }];
  const field = (st.field ?? "").slice((st.field ?? "").lastIndexOf(".") + 1);
  const values = cat && st.test && SAME_TESTS.has(st.test) && st.field ? domainOf(cat, st.field) : null;
  if (values) return [{ holeId: `shape:${si}:${k}:other`, about: wordsAnchor(st.quote), ask: `Which \`${field}\` counts as “${st.quote}”? — one of: ${values.join(", ")}`, round: 1, options: values }];
  const how = st.test && DAYS_TESTS.has(st.test) ? "how many days before the day it runs?" : `${st.test!.replace(/_/g, " ")} what?`;
  return [{ holeId: `shape:${si}:${k}:${st.test && ORDERING_TESTS.has(st.test) ? "threshold" : "other"}`, about: wordsAnchor(st.quote), ask: `What counts as “${st.quote}”? (\`${field}\` ${how})`, round: 1 }];
}));

/** One solver pass, recorded on the trace: its moves, and its stated gaps (each once). */
function solveInto(f: EFlow, checked: CheckedSpec, cat: CatalogueSnapshot, answers: Map<number, string>, trace: BuildTrace, drafts?: Draft[], condAnswers?: Map<number, string>, shapeAnswers?: Map<string, string>, answered?: ReadonlySet<string>) {
  const r = solve(f, { spec: checked, cat, answers, base: trace.base ?? [], ...(answered?.size ? { answered } : {}), ...(trace.requester ? { requester: trace.requester } : {}), ...(trace.known ? { known: trace.known } : {}), ...(drafts ? { drafts } : {}), ...(condAnswers ? { condAnswers } : {}), ...(shapeAnswers ? { shapeAnswers } : {}) });
  trace.moves.push(...r.moves);
  trace.gaps = [...new Set([...(trace.gaps ?? []), ...r.gaps])];
  const covered = [...new Set([...(trace.covered ?? []), ...r.covered])];
  trace.covered = covered;
  trace.unmet = r.unmet;
  trace.internal = r.internal;
  trace.blocked = r.blocked;
  return { flow: r.flow, covered, unmet: r.unmet };
}

// ── the workspace's catalogue, as the builder reads it ─────────────────────────
/** A reader field as the model reads it: its type in words and, when known, the only values it holds (I-301). */
const fieldItem = (name: string, t: Ty) => { const values = oneOfValues(t); return { name, ty: renderTy(t), ...(values ? { values } : {}) }; };

/**
 * The values an input's own description DECLARES — "One of: open, pending, resolved." — read like a typed enum (I-301), so a value
 * the goal states can be matched to it and the question, when asked, offers them. Only the "one of" form: a list in other prose
 * ("e.g. a, b") is an example, never the whole set.
 */
export function declaredValues(about: string | null | undefined): string[] | null {
  const m = /\bone of:?\s+([^.;]+)/i.exec(about ?? "");
  if (!m) return null;
  const vs = m[1]!.split(/\s*,\s*|\s+or\s+/).map((v) => v.trim().replace(/^['"`]|['"`]$/g, "")).filter((v) => /^[\w-]+$/.test(v));
  return vs.length >= 2 ? vs : null;
}

/**
 * `opts.flowId`: the flow being built or edited — its written reads (`local-readers.ts`) join the catalogue, so a flow that carries
 * one checks and saves. `opts.local`: written reads not yet on any stored step (a build still asking keeps them in its conversation).
 * `opts.newReads`: offer the understanding call "write a new read" per datasource (a build's first call only — never the canvas).
 */
export async function builderCatalogue(workspaceId: string, opts: { flowId?: string | null; local?: LocalReader[]; newReads?: boolean; rewriteReads?: boolean } = {}): Promise<{ items: BuilderCatalogue; cat: CatalogueSnapshot }> {
  const [c, cat, datasources] = await Promise.all([flowCatalogueService.forWorkspace(workspaceId), buildCatalogueSnapshot(workspaceId), datasourceRepo.listByWorkspace(workspaceId)]);
  // A paused datasource is hidden from the MODEL and from nothing else (datasource-model-visibility.ts): its readers exit
  // `items`, the list a model is handed, and stay in `cat` and `tables`, so a flow already built on it still checks and saves.
  const paused = new Set(datasources.filter(isPausedFromModel).map((d) => d.name));
  const items = c.entries
    .filter((e) => cat.refs[e.ref] && !(e.datasource && paused.has(e.datasource)))
    .map((e) => {
      // D-322: the params a stated value may fill — the engine's typed ports, described in the catalogue's own words.
      const ports = new Set((cat.refs[e.ref]?.params ?? []).map((p) => p.name));
      const sigs = cat.refs[e.ref]?.params ?? [];
      const params = (e.params ?? []).filter((p) => ports.has(p.name)).map((p) => { const sig = sigs.find((x) => x.name === p.name); const d = sig?.default; const values = (sig ? oneOfValues(sig.ty) : null) ?? declaredValues(p.description); return { name: p.name, about: (p.description ?? "").replace(/\s+/g, " ").slice(0, 120), ...(d !== undefined ? { default: d } : {}), ...(sig?.message ? { message: true } : {}), ...(sig?.heading ? { heading: true } : {}), ...(sig?.fromStep ? { fromStep: true } : {}), ...(sig?.needs ? { needs: sig.needs } : {}), ...(values ? { values } : {}) }; });
      // D-326: a reader's row fields and their types — what a condition the flow applies may test.
      const payload = cat.refs[e.ref]?.payload;
      const row = payload && e.kind !== "tool" ? rowOf(payload) : null;
      const fields = row && row.t === "Record" ? Object.entries(row.fields as Record<string, Ty>).map(([name, t]) => fieldItem(name, t)) : [];
      return { ref: e.ref, kind: (e.kind === "tool" ? "tool" : "reader") as "tool" | "reader", about: (e.description ?? e.ref).replace(/\s+/g, " ").slice(0, 240), ...(params.length ? { params } : {}), ...(fields.length ? { fields } : {}), ...(cat.refs[e.ref]?.modelText ? { modelText: true } : {}), ...(e.kind === "tool" && e.method?.toUpperCase() === "GET" ? { lookup: true } : {}) };
    });
  // D-311 (slice 5d): every table of every datasource is a reader too — built from the schema, typed by compileOperation. Saved
  // readers come first; a table ref (`<ds>.table.<t>`) cannot collide with one.
  const tables: NonNullable<BuilderCatalogue["tables"]> = {};
  const newReadItems: BuilderCatalogue["items"] = [];
  for (const ds of datasources) {
    const { readers, skipped } = tableReaders(ds.name, await schemaRepo.listByDatasource(ds.id), dialectOf(ds.type));
    if (skipped.length) console.warn(`[builder] ${ds.name}: ${skipped.length} table(s) not offered as readers — ${skipped.map((x) => `${x.table}: ${x.why}`).join("; ").slice(0, 400)}`);
    for (const r of readers) {
      if (cat.refs[r.ref]) continue;
      cat.refs[r.ref] = r.sig;
      tables[r.ref] = { datasource: r.datasource, spec: r.spec, sql: r.sql, tables: r.tables };
      if (paused.has(ds.name)) continue;
      const row = rowOf(r.sig.payload);
      const fields = row.t === "Record" ? Object.entries(row.fields as Record<string, Ty>).map(([name, t]) => fieldItem(name, t)) : [];
      items.push({ ref: r.ref, kind: "reader", about: r.about, ...(fields.length ? { fields } : {}) });
    }
    if (opts.newReads && readers.length && !paused.has(ds.name)) newReadItems.push({ ref: newReadOf(ds.name), kind: "reader", about: newReadAbout(ds.name, readers.length) });
  }
  // Written reads (2026-10-01): typed by compiling their form, exactly as a table reader — a form that no longer compiles is left
  // out and logged, and the flow carrying it then fails its check by name, never with a guessed type.
  // `rewriteReads`: the reads written for this goal are being written again (a clarification) — the flow's stored ones are not offered.
  const local = mergeLocal(opts.local ?? [], opts.flowId && !opts.rewriteReads ? await flowLocalReaders(workspaceId, opts.flowId) : []);
  for (const r of local) {
    const ds = datasources.find((d) => d.name === r.datasource);
    if (!ds || cat.refs[r.ref]) continue;
    try {
      const typed = specSig(r.spec as never, await schemaRepo.listByDatasource(ds.id), dialectOf(ds.type));
      cat.refs[r.ref] = typed.sig;
      tables[r.ref] = { datasource: r.datasource, spec: r.spec, sql: typed.sql, tables: specTables(r.spec), ...(typed.paramOrder.length ? { paramOrder: typed.paramOrder, paramsSchema: typed.paramsSchema } : {}) };
      if (paused.has(ds.name)) continue;
      items.push(localItem(r, typed.sig));
    } catch (e) {
      console.warn(`[builder] the written read ${r.ref} no longer compiles: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  items.push(...newReadItems);
  return { items: { items, ...(Object.keys(tables).length ? { tables } : {}) }, cat };
}

/** A written read as the model reads it: its readback, its typed fields and its parameters. */
export function localItem(r: LocalReader, sig: CatalogueSnapshot["refs"][string]): BuilderCatalogue["items"][number] {
  const row = rowOf(sig.payload);
  const fields = row.t === "Record" ? Object.entries(row.fields as Record<string, Ty>).map(([name, t]) => fieldItem(name, t)) : [];
  const params = sig.params.map((p) => { const values = oneOfValues(p.ty); return { name: p.name, about: `${renderTy(p.ty)} — a value the read compares with`, ...(values ? { values } : {}) }; });
  return { ref: r.ref, kind: "reader", about: localAbout(r.spec), ...(fields.length ? { fields } : {}), ...(params.length ? { params } : {}) };
}

/**
 * A table-reader step (D-311) carries its own statement: the spec it was built from, and the SQL `compileOperation` wrote for it,
 * with the datasource it runs against. The save funnel types the step from that spec, and the executor runs the SQL as a
 * step-local read — nothing is saved to the workspace.
 */
export function lowerTableReaders(f: EFlow, items: BuilderCatalogue): EFlow {
  const t = items.tables;
  if (!t) return f;
  return { ...f, steps: f.steps.map((s) => {
    const ref = "ref" in s ? (s as { ref?: string }).ref : undefined;
    const r = ref ? t[ref] : undefined;
    return r ? ({ ...s, sql: r.sql, datasourceRef: r.datasource, sqlSpec: r.spec, ...(r.paramOrder?.length ? { sqlParamOrder: r.paramOrder, sqlParamsSchema: r.paramsSchema } : {}) } as unknown as typeof s) : s;
  }) };
}

/**
 * The engine state an EDIT starts from (D-321): the flow's current draft, as the engine reads it. A flow the engine cannot
 * read — one written before the compiled builder, whose steps carry raw expressions rather than typed bindings — is refused
 * by name (409): editing it by construction would first need it re-expressed, which is a rebuild, not an edit. `null` for a
 * flow with no steps yet: that message is a goal.
 */
export async function editStart(workspaceId: string, flowId: string, cat: CatalogueSnapshot, opts: { resuming?: boolean } = {}): Promise<{ flow: NonNullable<Awaited<ReturnType<typeof flowRepo.get>>>; start: EFlow | null }> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) throw Object.assign(new Error("flow not found"), { statusCode: 404 });
  // `resuming`: the conversation that OWNS the unfinished build continues it (conversation.ts), from the flow's last revision.
  // A build asking nothing (no pending question) never blocks an edit: 409 only when questions are actually open.
  if (!opts.resuming) {
    const view = await flowService.getIncomplete(workspaceId, flowId);
    const pending = (view?.build as { goalSpec?: { conversation?: { pending?: unknown } } } | undefined)?.goalSpec?.conversation?.pending;
    if (view && typeof pending === "string" && pending) throw Object.assign(new Error("this flow has an unfinished build; answer its open questions first"), { statusCode: 409 });
  }
  const rev = flow.draftRevision > 0 ? await flowRepo.getRevision(flow.id, flow.draftRevision) : undefined;
  const model = rev?.modelJson as unknown as Partial<EFlow> | undefined;
  if (!model?.steps?.length) return { flow, start: null };
  const start: EFlow = engineReaderKinds({ ...(model as EFlow), inputs: model.inputs ?? [], holes: [] }); // I-297: `query` reads back as the engine's reader
  const errors = errorsOf(checkState(start, cat));
  if (errors.length) throw Object.assign(new Error(`this flow was not built by the compiled builder and cannot be extended by it (${errors[0]!.message}); change it on the canvas, or build it again from a goal`), { statusCode: 409 });
  return { flow, start };
}

/** What an edit tells the model about the flow it changes — the same lines the chooser sees. */
export const currentLines = (start: EFlow, cat: CatalogueSnapshot) => describeState(start, cat);

/**
 * Persist a build: a complete flow is a REVISION carrying its confirmed spec and trace (through the one funnel, D-318);
 * an incomplete one is the flow's working copy (D-319), with the same record. Nothing else is written.
 */
export async function save(workspaceId: string, u: Understood, r: RunResult, author: RevisionAuthor, name?: string, existing?: NonNullable<Awaited<ReturnType<typeof flowRepo.get>>>, held?: string): Promise<{ flowId: string; revision?: number }> {
  if (r.status === "cannot" || r.status === "unchanged") throw new Error(`nothing to save for a build that is ${r.status}`);
  // `held`: a question the conversation holds the build on (a reader choice) — a complete build is then kept as the working copy,
  // and the record says WHY it is undecided (`saveIncomplete`'s one definition).
  if (held && r.status === "complete") r = { ...r, status: "incomplete" };
  const build = { goalSpec: { goal: u.goal, texts: u.texts, spec: u.checked.spec, dropped: u.checked.dropped, readback: u.readback, ...(u.decisions && Object.keys(u.decisions).length ? { decisions: u.decisions } : {}), ...(held ? { conversation: { pending: held } } : {}) }, trace: r.trace };
  // An edit (or a goal on a flow that exists but is empty) lands on THAT flow: a revision when complete, its working copy when not.
  if (existing) {
    if (r.status === "complete") {
      // ⚠ The model's id IS the flow's engine id: `writeRevision` deploys under `model.id`, and a run looks the flow up by
      // `kestraFlowId`. They differed for a flow first saved unfinished (2026-09-27: "Kestra refused the run: Requested Flow is
      // not found"), because the goal's slug is not the id that flow was created with.
      const model = { ...(r.flow as unknown as FlowModel), id: existing.kestraFlowId };
      const { revision } = await flowService.writeRevision(workspaceId, existing, model, author, {}, false, { origin: "builder", build });
      // A flow first saved unfinished carries a working name; once it is built it takes the goal's.
      if (/ \(unfinished\) [a-z0-9]+$/.test(existing.name)) await flowRepo.update(existing.id, { name: u.goal.length > 80 ? `${u.goal.slice(0, 77)}…` : u.goal });
      return { flowId: existing.id, revision: revision.revision };
    }
    await flowService.saveIncomplete(workspaceId, existing.id, r.flow, build);
    return { flowId: existing.id };
  }
  const title = name ?? (u.goal.length > 80 ? `${u.goal.slice(0, 77)}…` : u.goal);
  if (r.status === "complete") {
    const { flow, revision } = await flowService.create(workspaceId, { name: title, model: r.flow as unknown as FlowModel, author }, {}, null, false, { origin: "builder", build, freshEngineId: true });
    return { flowId: flow.id, revision: revision.revision };
  }
  // The engine id is the flow's own uuid from the start (see `flowService.create`'s `freshEngineId`): the revision that completes it
  // later deploys under exactly this id.
  const id = randomUUID();
  const created = await flowRepo.create({ id, workspaceId, name: `${title} (unfinished) ${Date.now().toString(36)}`, description: null, kestraFlowId: engineIdOf(id), draftRevision: 0, status: "draft", designSelection: null });
  if (!created) throw new Error("could not create the flow for an unfinished build");
  await flowService.saveIncomplete(workspaceId, created.id, r.flow, build);
  return { flowId: created.id };
}

/**
 * The person answers an unfinished build's questions (the HTTP part of D-294). Each question is answered at most once: an
 * answer to a question already answered is refused, and an answer that does not fit keeps a STATED incomplete. The chooser
 * then continues once with the answers; the flow becomes a revision when nothing is left undecided.
 */
export async function answerIncomplete(workspaceId: string, flowId: string, answers: Record<string, string>, author: RevisionAuthor, chooser: Chooser = modelChooser): Promise<{ status: "complete" | "incomplete"; revision?: number; open: string[] }> {
  const view = await flowService.getIncomplete(workspaceId, flowId);
  if (!view?.build) throw Object.assign(new Error("this flow has no unfinished build to answer"), { statusCode: 404 });
  // Re-judged on read (getIncomplete): a revision written since, or a catalogue that moved under it, is refused by name —
  // answering would otherwise overwrite a newer draft, or build on a state the catalogue no longer admits.
  if (view.stale) throw Object.assign(new Error("a revision was written after this unfinished build was saved; start the build again from the current draft"), { statusCode: 409 });
  const invalid = errorsOf(view.diagnostics);
  if (invalid.length) throw Object.assign(new Error(`the catalogue changed and this unfinished build no longer checks: ${invalid.map((d) => d.message).join(" · ")}`), { statusCode: 409 });
  const stored = view.build as { goalSpec: { goal: string; texts: string[]; spec: GoalSpec; dropped: CheckedSpec["dropped"]; readback: string[] }; trace: BuildTrace };
  const trace = stored.trace;
  const { items, cat } = await builderCatalogue(workspaceId, { flowId });
  let f = view.model;
  const answered: string[] = [];
  // Z9: "me" on an address port is the person answering — same rule as the build path (`conversation` / `solveInto`).
  const requester = /@/.test(author.createdBy) ? author.createdBy : undefined;
  if (requester) trace.requester = requester;
  for (const [holeId, text] of Object.entries(answers)) {
    const q = trace.questions.find((x) => x.holeId === holeId);
    if (!q) throw Object.assign(new Error(`\`${holeId}\` was never asked`), { statusCode: 400 });
    if (q.answer !== undefined) throw Object.assign(new Error(`\`${holeId}\` was already answered — an answer is given once (D-294)`), { statusCode: 409 });
    f = answer(f, q, text, cat, requester);
    answered.push(text);
  }
  const checked: CheckedSpec = { spec: stored.goalSpec.spec, dropped: stored.goalSpec.dropped };
  // The spec's own questions, answered now or before, are the person's words for the values they map to (D-322).
  const specAnswers = new Map<number, string>();
  for (const q of trace.questions) if (q.holeId.startsWith("spec:") && q.answer?.trim()) specAnswers.set(Number(q.holeId.split(":")[1]), q.answer.trim());
  const condAnswers = new Map<number, string>(), shapeAnswers = new Map<string, string>();
  for (const q of trace.questions) {
    if (!q.answer?.trim()) continue;
    const [kind, i, j] = q.holeId.split(":");
    if (kind === "cond") condAnswers.set(Number(i), q.answer.trim()); else if (kind === "shape") shapeAnswers.set(`${i}:${j}`, q.answer.trim());
  }
  const solved = solveInto(f, checked, cat, specAnswers, trace, undefined, condAnswers, shapeAnswers);
  const r = { flow: lowerTableReaders(solved.flow, items), trace };
  const build = { goalSpec: stored.goalSpec, trace: r.trace };
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!r.flow.holes.length && !solved.unmet.length && !errorsOf(checkState(r.flow, cat)).length && flow) {
    const { revision } = await flowService.writeRevision(workspaceId, flow, r.flow as unknown as FlowModel, author, {}, false, { origin: "builder", build });
    await flowService.clearIncomplete(workspaceId, flowId);
    return { status: "complete", revision: revision.revision, open: [] };
  }
  // VALUE holes the solver left become the person's (once) — asked on the next read, never re-asked; structural ones are not.
  // All at once, so the same input on several steps is ONE question (`questionsFor` groups them); already-asked holes are skipped there.
  const left = r.flow.holes.filter((h) => h.site.at === "port" && !(trace.covered ?? []).includes(h.id)).map((h) => h.id);
  r.trace.questions.push(...questionsFor(r.flow, left, r.trace, Math.max(0, ...r.trace.questions.map((q) => q.round)) + 1, cat));
  await flowService.saveIncomplete(workspaceId, flowId, r.flow, build);
  return { status: "incomplete", open: r.trace.questions.filter((q) => q.answer === undefined).map((q) => q.holeId) };
}

/**
 * builder-behaviour P7 (E04, E06): the person's words a revision's confirmed spec IMPLEMENTED — every quote it placed (a source, an
 * action, a value, a condition, a step of a list, a for-each, a read's own accounting, an input), never one it left unclear. What an
 * edit treats as already understood.
 */
export function settledWords(goalSpec: unknown): string[] {
  const s = (goalSpec as { spec?: GoalSpec } | null | undefined)?.spec;
  if (!s) return [];
  const open = new Set((s.unclear ?? []).map((u) => norm(u.quote)));
  const q = [
    ...s.sources.map((x) => x.quote), ...s.sinks.map((x) => x.quote), ...s.values.map((v) => v.quote), ...s.conditions.map((c) => c.quote),
    ...(s.shapes ?? []).flatMap((sh) => sh.stages.map((x) => x.quote)), ...(s.wiring?.each ? [s.wiring.each.quote] : []), ...(s.wiring?.paths ?? []).map((p) => p.quote),
    ...(s.covered ?? []).map((c) => c.quote), ...(s.inputs ?? []).map((i) => i.words),
  ].filter((x): x is string => !!x?.trim() && !open.has(norm(x)));
  return [...new Set(q)];
}

/**
 * Words for a person from text that may name a read's identifiers: `table.column` is the column ("some_table.some_column" →
 * "some column"), and any other snake_case name is its words. An address, a dotted name with no underscore and quoted text are left.
 */
export function plainWords(text: string): string {
  return text
    .replace(/(?<![@\w.])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*\.([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b(?![@.\w])/g, (_m, col: string) => col.replace(/_/g, " "))
    .replace(/(?<![@\w.])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b(?![@.\w])/g, (_m, w: string) => w.replace(/_/g, " "));
}
