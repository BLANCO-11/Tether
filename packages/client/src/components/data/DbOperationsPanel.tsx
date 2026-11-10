"use client";

/**
 * DB operations — the visual-spec read components a `query` step references.
 * Phase 4.
 *
 * A named query is hand-written SQL that is reviewed as text. An operation is
 * the SAME boundary built from a visual spec (`DbOperationSpec`): base table,
 * columns with optional aggregates, joins, parameterised filters, sort, limit —
 * and the server compiles that spec to read-only SELECT. Only schema metadata
 * is ever exposed to this panel; rows are never fetched and never previewed
 * (the frozen mock's "schema-only visibility" note).
 *
 * ── What this panel refuses to smooth over ──────────────────────────────────
 *
 *  1. **No schema, no builder.** Every identifier in an operation must resolve
 *     against the introspected schema — that is the whole safety property, so
 *     the builder refuses to open when there are no tables, and says why.
 *
 *  2. **The compiled SQL is the check.** `POST …/operations/check` compiles
 *     without saving, and a refused spec comes back as a structured finding
 *     (offending identifier + available schema), not a generic 500. The Check
 *     action renders that finding — the message AND its structured half — so a
 *     typo'd column is fixed in one pass.
 *
 *  3. **The name is fixed by creation.** An operation's name IS the second half
 *     of a step's `<datasource>.<operation>` ref, so renaming would break every
 *     flow that references it. This panel creates and lists; editing (PATCH)
 *     and deletion (DELETE) are server routes that later surfaces will call.
 *
 *  4. **The READBACK is the review artefact, not the SQL** (FR-011, D-178).
 *     Added by `proposed-db-operations`. A person who cannot read SQL cannot
 *     refuse a bad spec, so leading with the SQL makes the approval this panel
 *     asks for unfalsifiable. The SQL stays, **collapsed** — removing it loses a
 *     real reviewer. ⚠ Every sentence in the readback is rendered SERVER-SIDE by
 *     `services/db-operation-readback.ts`; nothing in this file composes one.
 *
 *  5. **"Propose one for me" creates NOTHING.** The proposer returns a spec; the
 *     save goes through the same `createOperation` a hand-built spec takes, and
 *     the server compiles the submitted spec again (FR-013). A proposal is not
 *     authorisation, which is why nothing it returns carries an id.
 */

import { useMemo, useState } from "react";
import {
  deleteOperation,
  listOperations,
  createOperation,
  checkOperation,
  proposeOperation,
} from "@/lib/api";
import {
  FoundryApiError,
  type FADatasourceOperation,
  type FADbOperationSpec,
  type FADbOperationAggregate,
  type FADbOperationHavingOp,
  type FADbOperationJoinKind,
  type FADbOperationOp,
  type FADbOperationSortDir,
  type FAOperationProposal,
  type FAOutputColumn,
  type FAReadbackClause,
  type FADbOperationCheck,
} from "@/lib/foundry-client";
import { useAsync } from "@/lib/hooks";
import {
  CollapsedSql,
  IMMUTABLE_NAME_NOTE,
  NAME_RE,
  NAME_RULE,
  OutputColumns,
  Params,
  ProposalRefusal,
  ProposalReview,
  Readback,
  REVIEW_CAVEAT,
} from "./OperationReview";
import { useToast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Alert, ChevronRight } from "@/components/ui/icons";
import type { AssetNode } from "@/lib/types";

const AGGREGATES: Array<{ value: FADbOperationAggregate; label: string }> = [
  { value: "count", label: "count" },
  { value: "sum", label: "sum" },
  { value: "avg", label: "avg" },
  { value: "min", label: "min" },
  { value: "max", label: "max" },
];

const OPS: Array<{ value: FADbOperationOp; label: string }> = [
  { value: "eq", label: "eq" },
  { value: "neq", label: "neq" },
  { value: "gt", label: "gt" },
  { value: "gte", label: "gte" },
  { value: "lt", label: "lt" },
  { value: "lte", label: "lte" },
  { value: "in", label: "in" },
  { value: "like", label: "like" },
  { value: "ilike", label: "ilike" },
  { value: "is_null", label: "is null" },
  { value: "is_not_null", label: "is not null" },
];

const HAVING_OPS: Array<{ value: FADbOperationHavingOp; label: string }> = [
  { value: "eq", label: "eq" },
  { value: "neq", label: "neq" },
  { value: "gt", label: "gt" },
  { value: "gte", label: "gte" },
  { value: "lt", label: "lt" },
  { value: "lte", label: "lte" },
];

const JOIN_KINDS: Array<{ value: FADbOperationJoinKind; label: string }> = [
  { value: "left", label: "left" },
  { value: "inner", label: "inner" },
];

const SORT_DIRS: Array<{ value: FADbOperationSortDir; label: string }> = [
  { value: "asc", label: "asc" },
  { value: "desc", label: "desc" },
];

/** One introspected table, as the builder needs it. */
type TableRef = { schema: string; table: string; columns: string[] };

function tableList(nodes: AssetNode[]): TableRef[] {
  const out: TableRef[] = [];
  for (const schema of nodes) {
    if (schema.asset_type !== "db_schema") continue;
    for (const table of schema.children ?? []) {
      if (table.asset_type !== "table") continue;
      const columns = (table.children ?? [])
        .filter((c) => c.asset_type === "column")
        .map((c) => c.name);
      out.push({ schema: schema.name, table: table.name, columns });
    }
  }
  return out;
}

type ColRow = { column: string; aggregate: FADbOperationAggregate | ""; alias: string };
type JoinRow = { table: string; onLeft: string; onRight: string; kind: FADbOperationJoinKind };
type FilterRow = { column: string; op: FADbOperationOp; param: string; orGroup: string };
type SortRow = { column: string; dir: FADbOperationSortDir };
type HavingRow = { column: string; aggregate: FADbOperationAggregate | ""; op: FADbOperationHavingOp; param: string };

type Draft = {
  name: string;
  description: string;
  schema: string;
  base: string;
  columns: ColRow[];
  joins: JoinRow[];
  filters: FilterRow[];
  having: HavingRow[];
  distinct: boolean;
  sort: SortRow[];
  /** Kept as text while typing; parsed on check/save. */
  limit: string;
};

const EMPTY_COL: ColRow = { column: "", aggregate: "", alias: "" };

/** Rows with an identifier chosen are kept; a blank row is an unfinished sketch. */
function specFor(d: Draft): FADbOperationSpec {
  return {
    base: { ...(d.schema ? { schema: d.schema } : {}), table: d.base },
    columns: d.columns
      .filter((c) => c.column)
      .map((c) => ({
        column: c.column,
        ...(c.aggregate ? { aggregate: c.aggregate } : {}),
        // An alias is required by the spec; the column name is the honest default.
        alias: c.alias.trim() || c.column,
      })),
    joins: d.joins
      .filter((j) => j.table && j.onLeft && j.onRight)
      .map((j) => ({ table: j.table, onLeft: j.onLeft, onRight: j.onRight, kind: j.kind })),
    filters: d.filters
      .filter((f) => f.column && (f.op === "is_null" || f.op === "is_not_null" || f.param.trim()))
      .map((f) => ({
        column: f.column,
        op: f.op,
        // Null-ops bind no value — sending a param would fail the server's
        // shape check, so the key is omitted rather than sent empty.
        ...(f.op === "is_null" || f.op === "is_not_null" ? {} : { param: f.param.trim() }),
        ...(f.orGroup.trim() ? { orGroup: f.orGroup.trim() } : {}),
      })),
    // A having row without an aggregate or a value is an unfinished sketch,
    // kept out the same way blank filter rows are.
    ...(d.having.some((h) => h.column && h.aggregate && h.param.trim())
      ? {
          having: d.having
            .filter((h) => h.column && h.aggregate && h.param.trim())
            .map((h) => ({ column: h.column, aggregate: h.aggregate as FADbOperationAggregate, op: h.op, param: h.param.trim() })),
        }
      : {}),
    ...(d.distinct ? { distinct: true } : {}),
    sort: d.sort.filter((s) => s.column).map((s) => ({ column: s.column, dir: s.dir })),
  };
}

/** The structured half of a refused check — rendered, never summarised. */
function findingOf(e: unknown): { message: string; details: unknown[] | null } {
  if (e instanceof FoundryApiError) {
    return { message: e.message, details: Array.isArray(e.findings) ? e.findings : null };
  }
  return { message: e instanceof Error ? e.message : String(e), details: null };
}

/**
 * The shapes the server's zod parse would 400 on BEFORE the compiler runs.
 *
 * The check endpoint is the compile verdict, so the builder says these itself —
 * otherwise a space in a parameter name would come back as a parse error and
 * the compiled-SQL preview would never appear for the problems it could name.
 */
function specProblem(d: Draft): string | null {
  if (!d.columns.some((c) => c.column)) {
    return "Select at least one column — an operation with no columns would select nothing.";
  }
  for (const c of d.columns) {
    if (c.alias.trim() && !NAME_RE.test(c.alias.trim())) {
      return `Alias "${c.alias}" must be a plain identifier — it becomes the result column name.`;
    }
  }
  for (const f of d.filters) {
    if (f.param.trim() && !NAME_RE.test(f.param.trim())) {
      return `Filter parameter "${f.param}" must be a plain identifier — letters, digits and underscores, starting with a letter. It is the name a step's mapping binds.`;
    }
    if (f.orGroup.trim() && !NAME_RE.test(f.orGroup.trim())) {
      return `OR group "${f.orGroup}" must be a plain identifier — filters sharing one are ORed together.`;
    }
  }
  for (const h of d.having) {
    if (h.param.trim() && !NAME_RE.test(h.param.trim())) {
      return `Having parameter "${h.param}" must be a plain identifier — letters, digits and underscores, starting with a letter.`;
    }
  }
  return null;
}

/** The shared compact control look the mock's builder rows use. */
const CELL =
  "h-[30px] rounded-md border border-line bg-surface px-2 font-mono text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none";

// ── the review surface ──────────────────────────────────────────────────────
//
// ⚠ **MOVED to `OperationReview.tsx`** so `ChatPanel`'s `needs_component` turn
// renders the identical dialog (D-195). Three surfaces now ask a person to
// approve a spec — this panel's hand-built spec, this panel's proposed one, and
// a chat turn's — and a readback only some of them rendered would be several
// review standards for one artefact, chosen by which screen somebody was on.
//
// ⚠ `REVIEW_CAVEAT` is re-exported because this module is where the client's
// tests and `ui-honesty-check.sh` already looked for it, and moving a control's
// address is how a check quietly starts scanning nothing.
export { REVIEW_CAVEAT };

/**
 * Narrow a 4xx's `findings` to the messages it carries.
 *
 * `FoundryApiError.findings` is deliberately typed `unknown` — three throwers
 * attach three shapes — so narrowing happens where it is rendered, which is
 * `lib/generation-findings.ts`'s precedent. The 422 here carries
 * `[{ message }]`; anything else is rendered as-is rather than dropped, because
 * a finding silently discarded is the actionable half of the failure gone.
 */
function messagesOf(findings: unknown): string[] {
  if (!Array.isArray(findings)) return [];
  return findings.map((f) =>
    f && typeof f === "object" && typeof (f as { message?: unknown }).message === "string"
      ? (f as { message: string }).message
      : JSON.stringify(f),
  );
}

/**
 * "Propose one for me" — one sentence in, a reviewable spec out.
 *
 * ── The three shapes this can end in, and none of them is a Retry ───────────
 *
 *  1. **A proposal.** Reviewed in FR-011's order: the readback, then where each
 *     result column comes from, then the parameters, then the **editable name**
 *     with Decision 5's warning, then the SQL collapsed behind a toggle.
 *  2. **A refusal** (`insufficient_schema`, HTTP **200**, and a SUCCESS). The
 *     schema does not carry what the sentence needs, and the proposer said so
 *     rather than reaching for a column that is close. ⚠ **No Retry button** —
 *     re-asking is how *"no column carries a date"* becomes a confident
 *     `created_at` on attempt 2 (FR-008, D-171).
 *  3. **A failure** — 409 (never introspected, fix is a re-scan), 422 (three
 *     compiled attempts all refused, and the compiler's findings travel with
 *     it), 502 (the gateway). ⚠ **No Retry button on the 422 either**, for the
 *     same reason: its findings are what a person acts on.
 *
 * ⚠ **Nothing here creates anything.** Approving calls the same
 * `createOperation` a hand-built spec calls, with whatever spec is on screen —
 * and the server compiles it again (FR-013). The name field is editable, so the
 * spec that arrives is frequently not the spec that was proposed.
 */
function ProposalFlow({
  datasourceId,
  onCreated,
}: {
  datasourceId: string;
  onCreated: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [need, setNeed] = useState("");
  const [busy, setBusy] = useState<"ask" | "save" | null>(null);
  const [proposal, setProposal] = useState<FAOperationProposal | null>(null);
  const [refusal, setRefusal] = useState<{ missing: string[]; reason: string } | null>(null);
  const [failure, setFailure] = useState<{ message: string; findings: string[] } | null>(null);
  /** Editable BEFORE creation, immutable after — it is half of every ref (FR-012). */
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  /**
   * FR-014's bound, and the two halves of it.
   *
   * ⚠ **`cap` is READ FROM THE SERVER, never written here** (D-189). A constant
   * in this file would be a second definition of a server bound: the two drift,
   * and the screen then states a bound the server does not hold. It arrives on
   * BOTH channels, so a refusal advances the count too — a surface counting only
   * proposals would offer N+1.
   *
   * ⚠ **It is null until the first response, and the screen says nothing numeric
   * until then.** That is deliberate rather than a gap: the affordance that can
   * exceed the bound is *"Propose another"*, which by definition only exists
   * once a response has arrived — so the number is on screen at every point a
   * person could reach it, and nothing has been silently truncated before that.
   */
  const [asked, setAsked] = useState(0);
  const [cap, setCap] = useState<number | null>(null);
  const spent = cap !== null && asked >= cap;

  function reset() {
    setProposal(null);
    setRefusal(null);
    setFailure(null);
    setNameError(null);
  }

  async function ask() {
    if (!need.trim() || spent) return;
    setBusy("ask");
    reset();
    try {
      const r = await proposeOperation(datasourceId, need.trim());
      // Both channels are a 200 and both spend one of the N.
      setAsked((n) => n + 1);
      setCap(r.maxPerRequest);
      if (r.status === "ok") {
        setProposal(r);
        setName(r.name);
      } else {
        setRefusal({ missing: r.missing, reason: r.reason });
      }
    } catch (e) {
      // ⚠ A 409/422/502 is an ATTEMPT SPENT for 422 and not for the others — but
      // the server is the only thing that knows, and it says so only on the two
      // success channels. So the count is left alone here rather than guessed
      // at: over-counting would refuse a person a proposal they never received.
      const f = findingOf(e);
      setFailure({ message: f.message, findings: messagesOf(f.details) });
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!proposal) return;
    const n = name.trim();
    if (!NAME_RE.test(n)) {
      setNameError(
        "The name must be a plain identifier — letters, digits and underscores, starting " +
          "with a letter. It is the second half of a step's ref, so a dot here would make " +
          "this operation unresolvable at run time.",
      );
      return;
    }
    setBusy("save");
    setNameError(null);
    try {
      // ⚠ The SUBMITTED spec, compiled again server-side (FR-013). No proposal
      // id travels, and there is no field for one — a proposal is not
      // authorisation, and this dialog is editable by design.
      await createOperation(datasourceId, {
        name: n,
        ...(proposal.description.trim() ? { description: proposal.description.trim() } : {}),
        spec: proposal.spec,
      });
      onCreated(n);
      reset();
      setNeed("");
    } catch (e) {
      setNameError(findingOf(e).message);
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <div className="border-t border-line px-4 py-3">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Propose one for me
        </Button>
        <p className="mt-1 text-caption text-dim">
          Describe the data you need in one sentence. Tether reads this source&apos;s introspected
          schema — never its rows — and proposes a spec for you to review. Nothing is created until
          you approve it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-line p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">What do you need to read?</span>
        {cap !== null && (
          <span className="text-caption text-dim">
            {asked} of {cap} proposals used
          </span>
        )}
      </div>
      <textarea
        aria-label="What do you need to read?"
        rows={2}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
        value={need}
        onChange={(e) => setNeed(e.target.value)}
        placeholder="invoices that are overdue as of a given date, with the customer's name"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={ask} disabled={busy !== null || !need.trim() || spent}>
          {busy === "ask" ? "Reading the schema…" : proposal || refusal ? "Propose another" : "Propose a spec"}
        </Button>
        <Button
          variant="subtle"
          size="sm"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          disabled={busy !== null}
        >
          Close
        </Button>
        {/* ⚠ NEVER a silent stop. A surface that quietly stops offering
            proposals reads as "there is nothing more to propose", which is the
            opposite of true and the reader cannot tell (FR-014). */}
        {spent && (
          <span className="text-caption text-warn">
            That is all {cap} proposals for this visit. Build one by hand with &ldquo;New
            operation&rdquo;, or reload the page to ask again.
          </span>
        )}
      </div>

      {/* ── channel 2: a refusal. A SUCCESS, and never re-asked ──────────── */}
      {refusal && <ProposalRefusal missing={refusal.missing} reason={refusal.reason} />}
      {/* ── a real failure ───────────────────────────────────────────────── */}
      {failure && (
        <div className="rounded-md border border-danger/40 bg-danger/5 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-danger">
            <Alert className="h-4 w-4" />
            Couldn&apos;t propose a spec
          </div>
          <p className="mt-1 text-xs text-muted">{failure.message}</p>
          {failure.findings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {failure.findings.map((m, i) => (
                <li key={i} className="text-xs text-muted">
                  {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── channel 1: the review dialog, in FR-011's order ────────────────
          ⚠ ONE implementation, in `OperationReview.tsx` — the chat turn renders
          the identical component (D-195), so the order, the immutable-name
          sentence and FR-025's caveat cannot differ by surface. */}
      {proposal && (
        <ProposalReview
          proposal={proposal}
          name={name}
          onName={setName}
          nameError={nameError}
          busy={busy}
          onApprove={approve}
          onDiscard={reset}
        />
      )}
    </div>
  );
}

/** `alias ← agg(column)` or `alias ← column` — one entry per projected column. */
function columnLabel(c: FADbOperationSpec["columns"][number]): string {
  const source = c.aggregate ? `${c.aggregate}(${c.column ?? "…"})` : (c.column ?? "…");
  return c.alias === source ? c.alias : `${c.alias} ← ${source}`;
}

function joinLabel(j: FADbOperationSpec["joins"][number]): string {
  return `${j.kind} join ${j.table} on ${j.onLeft ?? "…"} = ${j.onRight ?? "…"}`;
}

function filterLabel(f: FADbOperationSpec["filters"][number]): string {
  const value = f.op === "is_null" || f.op === "is_not_null" ? "" : ` :${f.param}`;
  return `${f.column} ${f.op}${value}${f.orGroup ? ` (or: ${f.orGroup})` : ""}`;
}

function sortLabel(s: FADbOperationSpec["sort"][number]): string {
  return `${s.column} ${s.dir}`;
}

/** A label/value pair in the row's detail — the same visual shape as `Readback`. */
function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[6.5rem_1fr]">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0 space-y-0.5 font-mono text-caption text-text">{children}</dd>
    </div>
  );
}

/**
 * One saved DB operation, expandable in place.
 *
 * ⚠ Detail is rendered entirely from `op.spec` / `op.compiledSql` /
 * `op.paramsSchema` — everything `listOperations` already returned. Expanding
 * a row issues NO additional request; this is a definition of the operation,
 * never a preview of its rows (the panel's "schema-only visibility" rule).
 */
function OperationRow({
  op,
  removing,
  onRemove,
}: {
  op: FADatasourceOperation;
  removing: string | null;
  onRemove: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const target = op.spec.base.schema ? `${op.spec.base.schema}.${op.spec.base.table}` : op.spec.base.table;

  return (
    <div>
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-alpha-bg/40"
        >
          <ChevronRight
            s={14}
            className={"shrink-0 text-dim transition-transform duration-fast ease-app " + (open ? "rotate-90" : "")}
          />
          {/* The kind chip — words, never colour alone (the mock's `k k-query`). */}
          <span
            className="font-mono text-micro uppercase tracking-label"
            style={{ color: "var(--k-datasource)" }}
          >
            query
          </span>
          <span className="min-w-0 truncate font-mono text-body text-text">{op.name}</span>
          <span className="text-caption text-muted">
            {op.spec.filters.length} {op.spec.filters.length === 1 ? "param" : "params"}
            {op.spec.joins.length > 0
              ? ` · ${op.spec.joins.length} ${op.spec.joins.length === 1 ? "join" : "joins"}`
              : ""}
          </span>
          <span className="ml-auto truncate font-mono text-caption text-dim">{op.ref}</span>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="mr-4 shrink-0"
          aria-label={`Remove ${op.name}`}
          disabled={removing === op.name}
          onClick={() => onRemove(op.name)}
        >
          {removing === op.name ? "Removing…" : "Remove"}
        </Button>
      </div>
      {open && (
        <div className="space-y-4 border-t border-line bg-sunken/40 px-4 py-3">
          {op.description && <p className="text-body text-muted">{op.description}</p>}
          <dl className="space-y-2">
            <DetailLine label="Target">{target}</DetailLine>
            <DetailLine label="Columns">
              {op.spec.columns.map((c, i) => (
                <div key={i}>{columnLabel(c)}</div>
              ))}
            </DetailLine>
            {op.spec.joins.length > 0 && (
              <DetailLine label="Joins">
                {op.spec.joins.map((j, i) => (
                  <div key={i}>{joinLabel(j)}</div>
                ))}
              </DetailLine>
            )}
            {op.spec.filters.length > 0 && (
              <DetailLine label="Filters">
                {op.spec.filters.map((f, i) => (
                  <div key={i}>{filterLabel(f)}</div>
                ))}
              </DetailLine>
            )}
            {op.spec.sort.length > 0 && (
              <DetailLine label="Sort">
                {op.spec.sort.map((s, i) => (
                  <div key={i}>{sortLabel(s)}</div>
                ))}
              </DetailLine>
            )}
            {(op.spec.limit || op.spec.distinct) && (
              <DetailLine label="Result">
                {[
                  op.spec.distinct ? "distinct" : null,
                  op.spec.limit ? `limit ${op.spec.limit}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </DetailLine>
            )}
          </dl>

          <div>
            <p className="mb-2 text-xs text-muted">Parameters</p>
            <Params paramsSchema={op.paramsSchema} />
          </div>

          <div>
            <p className="mb-2 text-xs text-muted">Compiled SQL</p>
            <pre className="overflow-x-auto whitespace-pre rounded-lg border border-line bg-sunken p-3 font-mono text-caption leading-relaxed text-text">
              {op.compiledSql}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function DbOperationsPanel({
  datasourceId,
  schema,
}: {
  datasourceId: string;
  schema: AssetNode[];
}) {
  const toast = useToast();
  const [removing, setRemoving] = useState<string | null>(null);
  const { data: operations, loading, error, reload } = useAsync(
    () => listOperations(datasourceId),
    [datasourceId],
  );

  const tables = useMemo(() => tableList(schema), [schema]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [check, setCheck] = useState<FADbOperationCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);

  /**
   * Remove a saved reader — **confirm, then show the refusal, then offer the break.**
   *
   * ⚠ Three steps and not one, because deleting a reader is quiet in exactly
   * the wrong way. It does not fail the edit, the compile or the deploy; it
   * fails the next RUN of every flow that names it, with a reference nothing
   * can resolve — on a flow that may be armed and firing on a schedule, for
   * somebody who did not press this button.
   *
   * ⚠ **The server decides, and the second confirm is not a bypass.** The first
   * `deleteOperation` is the one that asks; a 409 comes back with the flow names
   * in its message, and only then is `force` offered. The panel holds no copy of
   * the reference rule and computes nothing — a browser-side list of referencing
   * flows would be a second answer to a destructive question, and it would be
   * the stale one (D-197).
   *
   * ⚠ **The refusal is rendered with its names, never as "could not delete".**
   * A 409 here is a correct answer to a reasonable request, and reporting it as
   * a failure is how a person concludes the button is broken and reaches for the
   * database instead.
   */
  async function remove(name: string) {
    if (!window.confirm(`Remove "${name}"?\n\nAutomations that read it resolve it by name at run time.`)) return;
    setRemoving(name);
    try {
      await deleteOperation(datasourceId, name);
      toast.success(`Removed ${name}.`);
      reload();
    } catch (e) {
      const status = (e as { status?: number }).status;
      const detail = e instanceof Error ? e.message : String(e);
      if (status !== 409) {
        toast.error(`Could not remove ${name}: ${detail}`);
        return;
      }
      if (!window.confirm(`${detail}\n\nRemove it anyway and leave those automations unable to run?`)) {
        return;
      }
      try {
        await deleteOperation(datasourceId, name, { force: true });
        toast.success(`Removed ${name} — the automations above will now fail at run time.`);
        reload();
      } catch (e2) {
        toast.error(`Could not remove ${name}: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    } finally {
      setRemoving(null);
    }
  }

  function startNew() {
    const t = tables[0];
    setDraft({
      name: "",
      description: "",
      schema: t?.schema ?? "",
      base: t?.table ?? "",
      columns: [EMPTY_COL],
      joins: [],
      filters: [],
      having: [],
      distinct: false,
      sort: [],
      limit: "100",
    });
    setCheck(null);
    setCheckError(null);
    setSaveError(null);
    setOpen(true);
  }

  // ── the identifiers the spec may name ─────────────────────────────────────
  const baseCols = useMemo(
    () =>
      tables.find((t) => t.schema === draft?.schema && t.table === draft?.base)?.columns ?? [],
    [tables, draft?.schema, draft?.base],
  );
  const schemas = useMemo(() => [...new Set(tables.map((t) => t.schema))], [tables]);
  const joinCols = useMemo(
    () =>
      (draft?.joins ?? []).flatMap(
        (j) => tables.find((t) => t.table === j.table)?.columns ?? [],
      ),
    [tables, draft?.joins],
  );
  const availableColumns = useMemo(
    () => [...new Set([...baseCols, ...joinCols])],
    [baseCols, joinCols],
  );
  const setFilter = (i: number, p: Partial<FilterRow>) =>
    setDraft((d) =>
      d ? { ...d, filters: d.filters.map((f, k) => (k === i ? { ...f, ...p } : f)) } : d,
    );
  const setHaving = (i: number, p: Partial<HavingRow>) =>
    setDraft((d) =>
      d ? { ...d, having: d.having.map((h, k) => (k === i ? { ...h, ...p } : h)) } : d,
    );
  const setSort = (i: number, p: Partial<SortRow>) =>
    setDraft((d) =>
      d ? { ...d, sort: d.sort.map((s, k) => (k === i ? { ...s, ...p } : s)) } : d,
    );
  const joinTables = useMemo(
    // Joins resolve server-side without a schema hint, so they must come from
    // the same schema as the base — offering another schema's tables would
    // build a spec the compiler cannot resolve.
    () => tables.filter((t) => t.schema === draft?.schema && t.table !== draft?.base),
    [tables, draft?.schema, draft?.base],
  );

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const setCol = (i: number, p: Partial<ColRow>) =>
    setDraft((d) =>
      d ? { ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...p } : c)) } : d,
    );
  const setJoin = (i: number, p: Partial<JoinRow>) =>
    setDraft((d) =>
      d ? { ...d, joins: d.joins.map((j, k) => (k === i ? { ...j, ...p } : j)) } : d,
    );

  /**
   * Choosing a different base table invalidates every identifier that followed
   * it — columns, joins, filters and sorts all name base-dependent things — so
   * they are cleared together rather than left pointing at the old table.
   */
  const setBase = (schemaName: string, table: string) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            schema: schemaName,
            base: table,
            columns: [EMPTY_COL],
            joins: [],
            filters: [],
            having: [],
            sort: [],
          }
        : d,
    );

  async function runCheck() {
    if (!draft) return;
    const local = specProblem(draft);
    if (local) {
      setCheck(null);
      setCheckError(local);
      return;
    }
    setBusy("check");
    setCheckError(null);
    try {
      const r = await checkOperation(datasourceId, specFor(draft));
      setCheck(r);
    } catch (e) {
      // Transport errors and unknown datasources land here — a refused SPEC
      // never does (the endpoint answers `ok: false`, not an HTTP error).
      setCheck(null);
      setCheckError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!NAME_RE.test(name)) {
      setSaveError(
        "The name must be a plain identifier — letters, digits and underscores, starting " +
          "with a letter. It is the second half of a step's ref, so a dot here would make " +
          "this operation unresolvable at run time.",
      );
      return;
    }
    setBusy("save");
    setSaveError(null);
    const local = specProblem(draft);
    if (local) {
      setSaveError(local);
      setBusy(null);
      return;
    }
    try {
      await createOperation(datasourceId, {
        name,
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        spec: specFor(draft),
      });
      toast.success(`Created ${name}.`);
      setOpen(false);
      setDraft(null);
      reload();
    } catch (e) {
      // A 409 on a duplicate name and a refused compile both land here, with
      // the server's own words — the collision is surfaced, never paraphrased.
      setSaveError(findingOf(e).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-alpha-line bg-surface">
      {/* The frozen mock's pane-head: title + tag-new "New" + the one action. */}
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold text-text">DB operations</h2>
        <span className="inline-flex h-[18px] items-center rounded border border-alpha-line bg-alpha-bg px-1.5 text-micro font-semibold uppercase tracking-label text-alpha">
          New
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={startNew}
          disabled={tables.length === 0}
        >
          New operation
        </Button>
      </header>

      {loading ? (
        <p className="p-4 text-sm text-muted">Loading…</p>
      ) : error ? (
        <p className="p-4 text-sm text-danger">Couldn&apos;t load DB operations: {error}</p>
      ) : (operations ?? []).length === 0 ? (
        <p className="p-4 text-sm text-muted">
          No DB operations yet. A <code>query</code> step references one by name — build one with
          &ldquo;New operation&rdquo;, and it compiles to read-only SELECT server-side.
        </p>
      ) : (
        <div className="divide-y divide-line">
          {(operations ?? []).map((op) => (
            <OperationRow key={op.id} op={op} removing={removing} onRemove={remove} />
          ))}
        </div>
      )}

      {/* ── "Propose one for me" ─────────────────────────────────────────────
          ⚠ Offered only when there IS an introspected schema. Every identifier
          in an operation resolves against it, so with nothing introspected the
          proposer answers 409 and the builder cannot open — and a button that
          leads to a refusal is worse than an absence with a reason beside it,
          because the reason arrives after the click instead of before it. */}
      {tables.length === 0 ? (
        <p className="border-t border-line px-4 py-3 text-caption text-muted">
          Tether hasn&apos;t read this source&apos;s schema, so an operation can&apos;t be built or
          proposed yet — every identifier in one has to resolve against it. Fix the connection and
          re-scan the source.
        </p>
      ) : (
        <ProposalFlow
          datasourceId={datasourceId}
          onCreated={(name) => {
            toast.success(`Created ${name}.`);
            reload();
          }}
        />
      )}

      {/* ── the builder ─────────────────────────────────────────────────── */}
      {open && draft && (
        <div className="space-y-3 border-t border-line p-4">
          {tables.length === 0 ? (
            <p className="text-sm text-muted">
              Tether couldn&apos;t read this source&apos;s schema — every identifier in an
              operation must resolve against it, so nothing can be built until the connection is
              fixed and re-scanned.
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs text-muted">Name</span>
                  <input
                    className={`mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm`}
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="attendance_by_dept"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted">Description</span>
                  <input
                    className={`mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm`}
                    value={draft.description}
                    onChange={(e) => patch({ description: e.target.value })}
                    placeholder="Attendance hours per department for the period"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Base table</span>
                {schemas.length > 1 && (
                  <select
                    className={CELL}
                    value={draft.schema}
                    onChange={(e) => {
                      const t = tables.find((x) => x.schema === e.target.value);
                      if (t) setBase(e.target.value, t.table);
                    }}
                  >
                    {schemas.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  className={CELL + " min-w-[10rem] flex-1"}
                  value={draft.base}
                  onChange={(e) => setBase(draft.schema, e.target.value)}
                >
                  {tables
                    .filter((t) => t.schema === draft.schema)
                    .map((t) => (
                      <option key={t.table} value={t.table}>
                        {t.table}
                      </option>
                    ))}
                </select>
              </div>

              {/* ── columns ─────────────────────────────────────────────── */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted">Columns</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => patch({ columns: [...draft.columns, EMPTY_COL] })}
                  >
                    Add column
                  </Button>
                </div>
                <div className="space-y-2">
                  {draft.columns.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        aria-label={`Column ${i + 1}`}
                        className={CELL + " min-w-0 flex-1"}
                        value={c.column}
                        onChange={(e) => setCol(i, { column: e.target.value })}
                      >
                        <option value="">column…</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Column ${i + 1} aggregate`}
                        className={CELL + " w-[90px] shrink-0"}
                        value={c.aggregate}
                        onChange={(e) =>
                          setCol(i, { aggregate: e.target.value as FADbOperationAggregate | "" })
                        }
                      >
                        <option value="">—</option>
                        {AGGREGATES.map((a) => (
                          <option key={a.value} value={a.value}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`Column ${i + 1} alias`}
                        className={CELL + " w-[110px] shrink-0"}
                        value={c.alias}
                        onChange={(e) => setCol(i, { alias: e.target.value })}
                        placeholder="alias"
                      />
                      <button
                        type="button"
                        aria-label={`Remove column ${i + 1}`}
                        className="shrink-0 text-caption text-muted hover:text-danger disabled:opacity-40 disabled:hover:text-muted"
                        disabled={draft.columns.length === 1}
                        onClick={() =>
                          setDraft((d) =>
                            d ? { ...d, columns: d.columns.filter((_, j) => j !== i) } : d,
                          )
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── joins ───────────────────────────────────────────────── */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted">Join</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      patch({
                        joins: [
                          ...draft.joins,
                          { table: joinTables[0]?.table ?? "", onLeft: "", onRight: "", kind: "left" },
                        ],
                      })
                    }
                    disabled={joinTables.length === 0}
                  >
                    Add join
                  </Button>
                </div>
                <div className="space-y-2">
                  {draft.joins.map((j, i) => {
                    const rightCols =
                      tables.find((t) => t.table === j.table)?.columns ?? [];
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label={`Join ${i + 1} kind`}
                          className={CELL + " w-[70px] shrink-0"}
                          value={j.kind}
                          onChange={(e) =>
                            setJoin(i, { kind: e.target.value as FADbOperationJoinKind })
                          }
                        >
                          {JOIN_KINDS.map((k) => (
                            <option key={k.value} value={k.value}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`Join ${i + 1} table`}
                          className={CELL + " min-w-0 flex-1"}
                          value={j.table}
                          onChange={(e) =>
                            setJoin(i, { table: e.target.value, onRight: "" })
                          }
                        >
                          <option value="">table…</option>
                          {joinTables.map((t) => (
                            <option key={t.table} value={t.table}>
                              {t.table}
                            </option>
                          ))}
                        </select>
                        <span className="text-caption text-dim">on</span>
                        <select
                          aria-label={`Join ${i + 1} left column`}
                          className={CELL + " w-[110px] shrink-0"}
                          value={j.onLeft}
                          onChange={(e) => setJoin(i, { onLeft: e.target.value })}
                        >
                          <option value="">column…</option>
                          {baseCols.map((col) => (
                            <option key={col} value={col}>
                              {col}
                            </option>
                          ))}
                        </select>
                        <span className="text-caption text-dim">=</span>
                        <select
                          aria-label={`Join ${i + 1} right column`}
                          className={CELL + " w-[110px] shrink-0"}
                          value={j.onRight}
                          onChange={(e) => setJoin(i, { onRight: e.target.value })}
                        >
                          <option value="">column…</option>
                          {rightCols.map((col) => (
                            <option key={col} value={col}>
                              {col}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label={`Remove join ${i + 1}`}
                          className="shrink-0 text-caption text-muted hover:text-danger"
                          onClick={() =>
                            setDraft((d) =>
                              d ? { ...d, joins: d.joins.filter((_, k) => k !== i) } : d,
                            )
                          }
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── filters ─────────────────────────────────────────────── */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted">Filter</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      patch({ filters: [...draft.filters, { column: "", op: "eq", param: "", orGroup: "" }] })
                    }
                  >
                    Add filter
                  </Button>
                </div>
                <div className="space-y-2">
                  {draft.filters.map((f, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={`Filter ${i + 1} column`}
                        className={CELL + " min-w-0 flex-1"}
                        value={f.column}
                        onChange={(e) => setFilter(i, { column: e.target.value })}
                      >
                        <option value="">column…</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Filter ${i + 1} operator`}
                        className={CELL + " w-[70px] shrink-0"}
                        value={f.op}
                        onChange={(e) => setFilter(i, { op: e.target.value as FADbOperationOp })}
                      >
                        {OPS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {f.op === "is_null" || f.op === "is_not_null" ? (
                        <span className="w-[110px] shrink-0 truncate text-micro text-dim" title="Null filters bind no value">
                          no value
                        </span>
                      ) : (
                        <input
                          aria-label={`Filter ${i + 1} parameter name`}
                          className={CELL + " w-[110px] shrink-0"}
                          value={f.param}
                          onChange={(e) => setFilter(i, { param: e.target.value })}
                          placeholder="period"
                        />
                      )}
                      <input
                        aria-label={`Filter ${i + 1} OR group`}
                        className={CELL + " w-[90px] shrink-0"}
                        value={f.orGroup}
                        onChange={(e) => setFilter(i, { orGroup: e.target.value })}
                        placeholder="or…"
                        title="Filters sharing a group name are ORed together inside one parenthesis"
                      />
                      <button
                        type="button"
                        aria-label={`Remove filter ${i + 1}`}
                        className="shrink-0 text-caption text-muted hover:text-danger"
                        onClick={() =>
                          setDraft((d) =>
                            d ? { ...d, filters: d.filters.filter((_, k) => k !== i) } : d,
                          )
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              {/* ── having: post-aggregation filters ────────────────────────
                  Only enabled rows are sent: a row without an aggregate or a
                  value is an unfinished sketch, kept out like blank filters. */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted" title="Filters an aggregate after summarising — the HAVING clause">Having</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      patch({ having: [...draft.having, { column: "", aggregate: "", op: "gt", param: "" }] })
                    }
                  >
                    Add having
                  </Button>
                </div>
                <div className="space-y-2">
                  {draft.having.map((h, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <select
                        aria-label={`Having ${i + 1} column`}
                        className={CELL + " min-w-0 flex-1"}
                        value={h.column}
                        onChange={(e) => setHaving(i, { column: e.target.value })}
                      >
                        <option value="">column…</option>
                        {availableColumns.map((col) => (
                          <option key={col} value={col}>
                            {col}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Having ${i + 1} aggregate`}
                        className={CELL + " w-[90px] shrink-0"}
                        value={h.aggregate}
                        onChange={(e) =>
                          setHaving(i, { aggregate: e.target.value as FADbOperationAggregate | "" })
                        }
                      >
                        <option value="">agg…</option>
                        {AGGREGATES.map((a) => (
                          <option key={a.value} value={a.value}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Having ${i + 1} operator`}
                        className={CELL + " w-[70px] shrink-0"}
                        value={h.op}
                        onChange={(e) => setHaving(i, { op: e.target.value as FADbOperationHavingOp })}
                      >
                        {HAVING_OPS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`Having ${i + 1} parameter name`}
                        className={CELL + " w-[110px] shrink-0"}
                        value={h.param}
                        onChange={(e) => setHaving(i, { param: e.target.value })}
                        placeholder="min_n"
                      />
                      <button
                        type="button"
                        aria-label={`Remove having ${i + 1}`}
                        className="shrink-0 text-caption text-muted hover:text-danger"
                        onClick={() =>
                          setDraft((d) =>
                            d ? { ...d, having: d.having.filter((_, k) => k !== i) } : d,
                          )
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted" title="Deduplicate result rows">
                <input
                  type="checkbox"
                  aria-label="Distinct rows"
                  checked={draft.distinct}
                  onChange={(e) => patch({ distinct: e.target.checked })}
                />
                Distinct
              </label>

              {/* ── sort + limit ────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Sort</span>
                {draft.sort.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      aria-label={`Sort ${i + 1} column`}
                      className={CELL + " w-[140px] shrink-0"}
                      value={s.column}
                      onChange={(e) => setSort(i, { column: e.target.value })}
                    >
                      <option value="">column…</option>
                      {availableColumns.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`Sort ${i + 1} direction`}
                      className={CELL + " w-[80px] shrink-0"}
                      value={s.dir}
                      onChange={(e) => setSort(i, { dir: e.target.value as FADbOperationSortDir })}
                    >
                      {SORT_DIRS.map((sd) => (
                        <option key={sd.value} value={sd.value}>
                          {sd.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label={`Remove sort ${i + 1}`}
                      className="shrink-0 text-caption text-muted hover:text-danger"
                      onClick={() =>
                        setDraft((d) =>
                          d ? { ...d, sort: d.sort.filter((_, k) => k !== i) } : d,
                        )
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => patch({ sort: [...draft.sort, { column: "", dir: "asc" }] })}>
                  Add sort
                </Button>
                <span className="text-xs text-muted">Limit</span>
                <input
                  aria-label="Result limit"
                  type="number"
                  min={1}
                  className={CELL + " w-[70px] shrink-0"}
                  value={draft.limit}
                  onChange={(e) => patch({ limit: e.target.value })}
                />
              </div>

              {/* ⚠ The constraint, said out loud (mock D-21 / D-05.2): the sort
                  options are the base and joined tables' introspected COLUMNS
                  (`availableColumns` above) — a column row's aggregate alias
                  (e.g. `total_hours`) is a result-column name, not a table
                  column, and the server's compiler cannot resolve it. */}
              <p className="text-caption text-dim">
                Sort resolves against table columns only — aggregate aliases like{" "}
                <span className="font-mono">total_hours</span> are not sortable.
              </p>

              {/* ── the check verdict ───────────────────────────────────────
                  ⚠ **T14 / FR-026.** This renders the SAME readback and output
                  columns a proposal gets, from the SAME `check()` response this
                  panel already fetched — one implementation, one review
                  standard. A readback that only proposals carried would be two
                  standards for one artefact, picked by who authored it, and the
                  weaker one would apply to every spec nobody proposed.

                  ⚠ The SQL moved BELOW the readback and behind a toggle. It is
                  not gone: a reviewer who reads SQL catches things the readback
                  cannot say, and removing it loses them. */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-muted">What this spec will do</span>
                  <Button size="sm" onClick={runCheck} disabled={busy !== null}>
                    {busy === "check" ? "Checking…" : "Check"}
                  </Button>
                </div>
                {check?.ok && (
                  <div className="space-y-4 rounded-lg border border-line p-3">
                    <Readback clauses={check.readback} />
                    <div>
                      <p className="mb-2 text-xs text-muted">What comes back</p>
                      <OutputColumns columns={check.outputColumns} />
                    </div>
                    {/* The COMPILED result — the server quoted every identifier
                        and bound `$1..$n`. Nothing here composed it. */}
                    <CollapsedSql sql={check.compiledSql} />
                  </div>
                )}
                {check && !check.ok && (
                  <div className="rounded-md border border-danger/40 bg-danger/5 p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-danger">
                      <Alert className="h-4 w-4" />
                      {check.problems.length} problem{check.problems.length === 1 ? "" : "s"} — all
                      of them, so this takes one pass
                    </div>
                    <ul className="mt-2 space-y-2">
                      {check.problems.map((p, i) => (
                        <li key={i} className="text-xs text-muted">
                          <code className="text-dim">{p.code}</code> — {p.message}
                          {p.identifier && (
                            <span className="mt-0.5 block font-mono text-caption text-dim">
                              tried: {p.identifier}
                            </span>
                          )}
                          {p.available && p.available.length > 0 && (
                            <span className="mt-0.5 block text-caption text-dim">
                              available: {p.available.join(", ")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {checkError && (
                  <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
                    Couldn&apos;t check: {checkError}
                  </div>
                )}
                <p className="mt-2 text-caption text-dim">
                  Identifiers resolve against the introspected schema — never interpolated.
                  {draft.filters.some((f) => f.param.trim())
                    ? ` Parameter${draft.filters.filter((f) => f.param.trim()).length > 1 ? "s" : ""} ` +
                      draft.filters
                        .filter((f) => f.param.trim())
                        .map((f) => f.param.trim())
                        .join(", ") +
                      " bind positionally."
                    : ""}
                </p>
              </div>

              {saveError && (
                <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
                  {saveError}
                </div>
              )}

              {/* ⚠ FR-012 / D-173. The name is half of every
                  `<datasource>.<operation>` ref, so this is the last moment it
                  can be changed — stated beside the action, not in the field's
                  own hint at the top of a long form. */}
              <p className="text-caption text-dim">
                This name becomes part of every automation that uses it and cannot be changed later.
              </p>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                {/* ⚠ FR-025 — the same sentence a proposal's approve action
                    carries, for the same reason. Both authors are approving the
                    same kind of artefact. */}
                <p className="max-w-[34rem] text-caption text-muted">{REVIEW_CAVEAT}</p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="subtle"
                    onClick={() => {
                      setOpen(false);
                      setDraft(null);
                      setCheck(null);
                      setCheckError(null);
                      setSaveError(null);
                    }}
                    disabled={busy !== null}
                  >
                    Cancel
                  </Button>
                  <Button onClick={save} disabled={busy !== null || !draft.name.trim()}>
                    {busy === "save" ? "Creating…" : "Create operation"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <p className="border-t border-line px-4 py-3 text-caption text-muted">
        Schema-only visibility — operation results are never previewed. A visual spec compiles to
        SELECT server-side; the database is read with the same read-only credential an automation
        gets.
      </p>
    </section>
  );
}
