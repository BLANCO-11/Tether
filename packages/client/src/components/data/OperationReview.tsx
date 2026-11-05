"use client";

/**
 * The review surface for a DB operation spec — **one implementation, three
 * callers.** proposed-db-operations · FR-011 / FR-012 / FR-025 / FR-026 · D-195
 *
 * ── Why this is its own file ─────────────────────────────────────────────────
 *
 * Three surfaces ask a person to approve a `DbOperationSpec`:
 *
 *  1. `DbOperationsPanel`'s **hand-built** spec, from `check()` (FR-026)
 *  2. `DbOperationsPanel`'s **proposed** spec, from `/operations/propose`
 *  3. `ChatPanel`'s `needs_component` turn, from the same propose route
 *
 * ⚠ **A readback only some of them rendered would be several review standards
 * for one artefact, chosen by which screen a person happened to be on** — and
 * the weakest one would become the standard applied wherever nobody was looking.
 * That is FR-026's argument, and D-195 is it arriving a third time: T16 declined
 * to embed a second proposer in the flow wizard for the same reason.
 *
 * ⚠ **Nothing in this file composes a sentence about what a spec does.** Every
 * readback clause is rendered SERVER-SIDE by `services/db-operation-readback.ts`
 * (FR-022). A client-side renderer would be a second definition of what a spec
 * means, and the two would drift toward the screen that disagrees with the SQL
 * standing next to it.
 *
 * ⚠ **No rows of data, anywhere** (FR-024). These endpoints serve schema
 * metadata only — `lib/mock-rows.ts` was built during this feature and deleted
 * as *"invented values wearing a real table's column names"*. A sample row here
 * could only be invented, directly beneath a real table's real column names,
 * which is the most convincing possible form of it. `ui-honesty-check.sh` pins
 * the absence.
 */

import { useState } from "react";
import type {
  FAOperationProposal,
  FAOutputColumn,
  FAColumnAmbiguity,
  FAReadbackClause,
} from "@/lib/foundry-client";
import { Button } from "@/components/ui/Button";

/** Matches the server's rule — the name is a step-ref segment. */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The sentence a bad name earns, stated once.
 *
 * ⚠ It says WHY, not just what: a dot would make the operation unresolvable at
 * run time, because the name is the second half of `<datasource>.<operation>`.
 */
export const NAME_RULE =
  "The name must be a plain identifier — letters, digits and underscores, starting " +
  "with a letter. It is the second half of a step's ref, so a dot here would make " +
  "this operation unresolvable at run time.";

/**
 * FR-012 / D-173 — stated while the field is still editable, which is the last
 * moment it is true. Renaming after save breaks every flow referencing the ref,
 * which is why there is no rename in the product at all.
 */
export const IMMUTABLE_NAME_NOTE =
  "This name becomes part of every automation that uses it and cannot be changed later.";

// ── the review surface, shared by BOTH authors ───────────────────────────────
//
// ⚠ Everything in this block renders for a hand-built spec and for a proposed
// one, from the same `check()` response (FR-026). A readback only proposals got
// would be two review standards for one artefact, chosen by who happened to
// author it — and the weaker one would be the standard applied to every spec
// nobody proposed.

/**
 * The readback — the PRIMARY review artefact (FR-011, D-178).
 *
 * ⚠ **Every string below a label is server-rendered** by
 * `services/db-operation-readback.ts`, and this component composes no sentence
 * about what a spec does (FR-022). A client-side renderer would be a second
 * definition of what a spec means, and the two would drift in exactly one
 * direction: a confident screen standing beside SQL that disagrees with it.
 *
 * ⚠ **A label repeats, and the array is never grouped by it.** There is one
 * `From` clause per join, because each join carries its own `note` — and the
 * join is the part most likely to be the defect.
 */
export function Readback({ clauses }: { clauses: FAReadbackClause[] }) {
  return (
    <dl className="space-y-2">
      {clauses.map((c, i) => (
        <div key={i} className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[6.5rem_1fr]">
          <dt className="text-xs font-medium text-muted">{c.label}</dt>
          <dd className="text-body text-text">
            {c.text}
            {/* ⚠ The CONSEQUENCE of a decision, as opposed to the decision.
                `inner` and `left` produce the same `text` and DIFFERENT notes,
                so a rendering that dropped this line would throw away the one
                difference a reviewer most needs — and the screen would look
                complete while doing it. */}
            {c.note && <span className="mt-0.5 block text-caption text-dim">{c.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Where each result column comes from — `customer_name ← customers.name`.
 *
 * ⚠ **The type column is labelled "source column", and that wording is the
 * whole point** (D-185). `type` is the INTROSPECTED COLUMN's type, not the type
 * of the value this operation returns: `count` over a `text` column returns a
 * number and `type` still reads `text`. Rendering it as "type" would be a
 * confident, checkable-looking claim that is wrong for every aggregate.
 */
export function OutputColumns({ columns }: { columns: FAOutputColumn[] }) {
  if (columns.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-caption">
        <thead>
          <tr className="text-muted">
            <th className="pb-1 pr-4 font-medium">Result column</th>
            <th className="pb-1 pr-4 font-medium">Comes from</th>
            <th className="pb-1 font-medium">Source column type</th>
          </tr>
        </thead>
        <tbody className="font-mono text-text">
          {columns.map((c) => (
            <tr key={c.alias}>
              <td className="pr-4 align-top">{c.alias}</td>
              <td className="pr-4 align-top text-dim">{c.source}</td>
              {/* An unknown type is stated as unknown, never as `text`. */}
              <td className="align-top text-dim">{c.type ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * FR-025 — what approving this does NOT establish.
 *
 * ⚠ Exported so a test can assert the exact sentence and so
 * `scripts/ui-honesty-check.sh` can pin its presence. It is the honest half of
 * the gate: the readback is decidable from the spec alone, and units and
 * business meaning are not. `finance_demo`'s `amount_cents`-versus-`amount` trap
 * is a correct readback over a spec that reports Engineering as 62× over budget.
 *
 * ⚠ It must not imply that approving the readback verifies the data, and it must
 * point at the thing that CAN check it — a test run with an expectation (D-68).
 */
export const REVIEW_CAVEAT =
  "This checks what the query asks for, not whether the data is right. Units and business " +
  "meaning are not checked here — test-run the automation and add an expectation.";

/**
 * The compiled SQL — available, **collapsed**, and never the primary artefact
 * (FR-011).
 *
 * ⚠ **Collapsed, not removed.** Leading with it was the original version of this
 * requirement and it was a review surface written for a reviewer this feature's
 * user stories do not have; removing it is the opposite mistake, and it loses a
 * real reviewer who would have caught something the readback cannot say.
 */
/**
 * The compiled SQL behind a disclosure.
 *
 * ⚠ **`defaultOpen` exists because the same component serves two jobs.** On the
 * proposal review the readback LEADS and the SQL is the second opinion, so it
 * starts closed — that arrangement is FR-011 and it is what caught an employee
 * id equated to a department id. In the flow builder's inspector the person has
 * already chosen the reader and is asking the narrower question *"what does this
 * actually read?"*; there, a closed disclosure is the answer being withheld, and
 * it was reported as the SQL not being there at all (2026-09-17).
 *
 * One component, two defaults, no second copy of the markup.
 */
export function CollapsedSql({ sql, defaultOpen = false }: { sql: string; defaultOpen?: boolean }) {
  const [show, setShow] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        className="text-caption text-muted underline decoration-dotted hover:text-text"
        aria-expanded={show}
        onClick={() => setShow((v) => !v)}
      >
        {show ? "Hide the compiled SQL" : "Show the compiled SQL"}
      </button>
      {show && (
        <pre className="mt-2 overflow-x-auto whitespace-pre rounded-lg border border-line bg-sunken p-3 font-mono text-caption leading-relaxed text-text">
          {sql}
        </pre>
      )}
    </div>
  );
}

/** The parameters a step's mapping binds, in the order they bind. */
export function Params({
  paramsSchema,
}: {
  paramsSchema: Record<string, { type?: string; required?: boolean; description?: string }>;
}) {
  const entries = Object.entries(paramsSchema);
  if (entries.length === 0) {
    return (
      <p className="text-body text-muted">
        No parameters — this operation takes no values from the step that calls it.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {entries.map(([name, d]) => (
        <li key={name} className="text-body">
          <span className="font-mono text-text">{name}</span>
          <span className="text-dim">
            {" — "}
            {d.type ?? "string"}
            {d.required === false ? ", optional" : ", required"}
          </span>
          {d.description && (
            <span className="mt-0.5 block text-caption text-dim">{d.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}


/**
 * ⚠ **A column name two joined tables both have, and which one won.**
 *
 * The compiler resolves a bare name against the join chain and the FIRST table
 * holding it wins. That has always been deterministic and was always
 * INVISIBLE — join two tables that both have `id` or `status` and the operation
 * read one of them with nothing anywhere saying a choice had been made. This is
 * the only place a person can disagree with that choice, which is why it is in
 * the review surface rather than a log line.
 *
 * ⚠ **It is not an error and must not read as one.** The SQL is correct; the
 * question is whether it is the one the author meant. So it renders as a note
 * in the readback's own voice, states which table won, and names the remedy —
 * `table.column` — because a warning whose fix is not on screen is a warning
 * people learn to scroll past.
 *
 * ⚠ **Renders NOTHING when there is no ambiguity.** An "all clear" here would be
 * a safety claim this cannot make: it knows only that no two tables share a
 * name, never that the right table was chosen. Same rule as
 * `PromptBoundaryWarnings`' empty case.
 */
export function AmbiguousColumns({ columns }: { columns: FAColumnAmbiguity[] }) {
  if (columns.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-text">Which table these came from</p>
      <ul className="space-y-1.5">
        {columns.map((a) => (
          <li key={a.column} className="text-body">
            <span className="font-mono text-text">{a.column}</span>
            <span className="text-dim">
              {" — read from "}
              <span className="font-mono text-text">{a.resolvedTo}</span>
              {". It is also on "}
              {a.alsoOn.map((t, i) => (
                <span key={t}>
                  {i > 0 && ", "}
                  <span className="font-mono text-text">{t}</span>
                </span>
              ))}
              {"."}
            </span>
            <span className="mt-0.5 block text-caption text-dim">
              If you meant a different one, write it as{" "}
              <span className="font-mono">{`${a.alsoOn[0]}.${a.column}`}</span>.
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A proposal, reviewed in FR-011's order — **the one implementation of that
 * order**, so no caller can quietly lead with the SQL.
 *
 *  1. **the readback** — labelled clauses, each `note` beneath its clause
 *  2. **where each result column comes from**
 *  3. the parameters
 *  4. the **editable name**, with the sentence that makes it a decision
 *  5. the **compiled SQL, collapsed behind a toggle**
 *
 * ⚠ **The SQL is collapsed, not removed.** Leading with it was the original
 * version of FR-011 and it was a review surface written for a reviewer this
 * feature's user stories do not have — a person who cannot read SQL cannot
 * refuse a bad spec, so leading with it makes the approval unfalsifiable.
 * Removing it is the opposite mistake and loses a reviewer who would catch what
 * the readback cannot say.
 *
 * ⚠ **FR-025's caveat sits beside the approve action**, not at the top where it
 * is read before there is anything to judge.
 *
 * ⚠ **This component holds no state and performs no request.** The name lives
 * with the caller, because the caller is what submits it — and `createOperation`
 * re-compiles whatever spec arrives (FR-013), so there is deliberately nothing
 * here that could carry an approval token.
 */
export function ProposalReview({
  proposal,
  name,
  onName,
  nameError,
  busy,
  onApprove,
  onDiscard,
}: {
  proposal: FAOperationProposal;
  name: string;
  onName: (v: string) => void;
  nameError: string | null;
  /** `"save"` while the create is in flight; any truthy value disables both actions. */
  busy: string | null;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-line p-4">
      {/* 1. THE READBACK — first, and the biggest thing on the screen. */}
      <div>
        <p className="mb-2 text-sm font-medium text-text">What this will do</p>
        <Readback clauses={proposal.readback} />
      </div>

      {/* 2. where each result column comes from */}
      <div>
        <p className="mb-2 text-sm font-medium text-text">What comes back</p>
        <OutputColumns columns={proposal.outputColumns} />
      </div>

      {/* 2b. a column name two tables both have — renders nothing when there is none */}
      <AmbiguousColumns columns={proposal.ambiguousColumns} />

      {/* 3. the parameters */}
      <div>
        <p className="mb-2 text-sm font-medium text-text">Values it asks for</p>
        <Params paramsSchema={proposal.paramsSchema} />
      </div>

      {/* 4. the editable name, with the sentence that makes it a decision */}
      <div>
        <label className="block">
          <span className="text-xs text-muted">Name</span>
          <input
            aria-label="Operation name"
            className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
            value={name}
            onChange={(e) => onName(e.target.value)}
          />
        </label>
        <p className="mt-1 text-caption text-dim">{IMMUTABLE_NAME_NOTE}</p>
        {nameError && <p className="mt-1 text-xs text-danger">{nameError}</p>}
      </div>

      {/* 5. the SQL, collapsed */}
      <CollapsedSql sql={proposal.compiledSql} />

      {proposal.attempts > 1 && (
        <p className="text-caption text-dim">
          Took {proposal.attempts} attempts — the first {proposal.attempts - 1} didn&apos;t compile
          and the compiler&apos;s findings were sent back.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        {/* ⚠ FR-025 — beside the approve action, where the decision is. */}
        <p className="max-w-[34rem] text-caption text-muted">{REVIEW_CAVEAT}</p>
        <div className="flex items-center gap-2">
          <Button variant="subtle" onClick={onDiscard} disabled={busy !== null}>
            Discard
          </Button>
          <Button onClick={onApprove} disabled={busy !== null || !name.trim()}>
            {busy === "save" ? "Creating…" : "Create operation"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The refusal channel, rendered. **HTTP 200, and a SUCCESS.**
 *
 * ⚠ **There is deliberately no Retry here, on any surface that renders this.**
 * Asking the same question again is how a correct *"no column in this schema
 * carries a date"* becomes a plausible-looking `created_at` on attempt 2
 * (FR-008, D-171). The action is to change the sentence, or to change the
 * schema and re-scan it.
 */
export function ProposalRefusal({
  missing,
  reason,
}: {
  missing: string[];
  reason: string;
}) {
  return (
    <div className="rounded-lg border border-warn/40 bg-warn-bg/40 p-3">
      <p className="text-sm font-medium text-warn">
        This source&apos;s schema can&apos;t answer that, and nothing was guessed
      </p>
      <p className="mt-1 text-body text-muted">{reason}</p>
      {missing.length > 0 && (
        <p className="mt-2 text-body">
          Missing:{" "}
          {missing.map((m) => (
            <span key={m} className="mr-2 rounded bg-surface-2 px-2 py-1 font-mono text-xs">
              {m}
            </span>
          ))}
        </p>
      )}
      <p className="mt-2 text-caption text-dim">
        Describe something this schema does carry, or add the missing column to the source and
        re-scan it. Asking the same question again would only produce a guess.
      </p>
    </div>
  );
}
