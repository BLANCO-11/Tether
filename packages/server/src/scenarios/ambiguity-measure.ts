/**
 * `pnpm --filter @foundry/server ambiguity:measure` — how often does a saved DB
 * operation read a column name that TWO of its joined tables both have?
 *
 * ⚠ **This is a MEASUREMENT, not a gate.** It exits non-zero only if it could
 * not run or if its own control failed. An ambiguity count is a number to read.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * Phase 4a.3 made the compiler report a bare column name that more than one
 * joined table could have meant (`CompiledOperation.ambiguousColumns`), and gave
 * authors `table.column` to override it. Every case proving that works is a
 * **hand-built fixture**. Its own records say so: the fire rate against a real
 * tenant schema was unknown, so *"this is a real problem"* and *"this is a
 * theoretical problem"* were indistinguishable.
 *
 * This recompiles every saved operation on the deployment, against that
 * datasource's real introspected schema, and counts.
 *
 * ── ⚠ THE CONTROL, AND WHY A BARE ZERO WOULD BE WORTHLESS ───────────────────
 *
 * "0 ambiguous columns" has two readings that no positive-only run can separate:
 * the operations are unambiguous, or the detector is not working. So this
 * computes, **from the `schemas` rows alone and never from the detector**, how
 * many column names each operation's tables SHARE. That is a schema fact.
 *
 *   - shared names > 0 and detector fires  → agreement
 *   - shared names > 0 and detector silent → the operation dodged them by not
 *     reading a shared name. Reported, because it bounds what the run proves.
 *   - shared names == 0 everywhere         → ⚠ THE RUN PROVES NOTHING. The
 *     detector was never given a chance to fire, and the harness says so rather
 *     than printing a tick.
 *
 * ⚠ It reads and writes nothing. `compileOperation` is pure, so this touches no
 * tenant database, opens no DSN and saves no row.
 */

import { datasourceRepo } from "../repositories/datasource.repo.js";
import { dbOperationRepo } from "../repositories/db-operation.repo.js";
import { schemaRepo } from "../repositories/schema.repo.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { compileOperation, type DbOperationSpecInput } from "../services/db-operation.service.js";

const c = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/** Every table an operation reads — base plus joins, in chain order. */
function tablesOf(spec: Record<string, unknown>): string[] {
  const base = (spec.base as { table?: string } | undefined)?.table;
  const joins = ((spec.joins ?? []) as Array<{ table?: string }>).map((j) => j.table);
  const agg = ((spec.aggregateJoins ?? []) as Array<{ table?: string }>).map((j) => j.table);
  return [base, ...joins, ...agg].filter((t): t is string => typeof t === "string");
}

async function main() {
  const workspaces = (await workspaceRepo.list()).filter((w) => !w.deletedAt);
  let operations = 0;
  let multiTable = 0;
  let withSharedNames = 0;
  let firing = 0;
  let compileFailed = 0;
  let sharedNamesTotal = 0;
  const rows: string[] = [];
  const findings: string[] = [];

  for (const w of workspaces) {
    for (const ds of await datasourceRepo.listByWorkspace(w.id)) {
      const ops = await dbOperationRepo.listByDatasource(ds.id);
      if (!ops.length) continue;
      const schemaRows = await schemaRepo.listByDatasource(ds.id);

      // The control, computed from the schema and NEVER from the detector.
      const columnsByTable = new Map<string, Set<string>>();
      for (const r of schemaRows) {
        if (!r.columnName) continue;
        const key = r.entityName;
        if (!columnsByTable.has(key)) columnsByTable.set(key, new Set());
        columnsByTable.get(key)!.add(r.columnName);
      }

      for (const op of ops) {
        operations++;
        const spec = op.specJson as Record<string, unknown>;
        const tables = tablesOf(spec);
        if (tables.length > 1) multiTable++;

        // How many column names appear on more than one of this op's tables?
        const seen = new Map<string, number>();
        for (const t of new Set(tables)) {
          for (const col of columnsByTable.get(t) ?? []) seen.set(col, (seen.get(col) ?? 0) + 1);
        }
        const shared = [...seen.entries()].filter(([, n]) => n > 1).map(([col]) => col);
        if (shared.length > 0) {
          withSharedNames++;
          sharedNamesTotal += shared.length;
        }

        let ambiguous: Array<{ column: string; resolvedTo: string; alsoOn: string[] }> = [];
        try {
          ambiguous = compileOperation(spec as unknown as DbOperationSpecInput, schemaRows).ambiguousColumns;
        } catch (e) {
          // ⚠ A saved operation that no longer compiles is itself a finding —
          // the schema moved under it — and is NOT counted as "unambiguous".
          compileFailed++;
          findings.push(
            `${c.warn("!")} ${ds.name}.${op.name} no longer compiles: ${(e as Error).message.slice(0, 110)}`,
          );
          continue;
        }
        if (ambiguous.length > 0) firing++;

        const mark = ambiguous.length > 0 ? c.warn("AMBIGUOUS") : shared.length > 0 ? c.dim("dodged   ") : c.dim("single   ");
        rows.push(
          `  ${mark} ${(ds.name + "." + op.name).padEnd(48)} ${String(tables.length).padStart(2)} table(s)  ` +
            `${String(shared.length).padStart(3)} shared name(s)` +
            (ambiguous.length
              ? `\n      ${ambiguous.map((a) => `${c.warn(a.column)} → ${a.resolvedTo} (also on ${a.alsoOn.join(", ")})`).join("\n      ")}`
              : ""),
        );
      }
    }
  }

  console.log("");
  for (const r of rows) console.log(r);
  if (findings.length) {
    console.log("");
    for (const f of findings) console.log(`  ${f}`);
  }

  console.log("");
  console.log(`  operations                 ${operations}`);
  console.log(`  reading more than 1 table  ${multiTable}`);
  console.log(`  whose tables SHARE a name  ${withSharedNames}   ${c.dim("← the control: a schema fact")}`);
  console.log(`  shared names in total      ${sharedNamesTotal}`);
  console.log(`  detector FIRED on          ${firing}`);
  console.log(`  no longer compiling        ${compileFailed}`);
  console.log("");

  if (operations === 0) {
    console.log(c.bad("no saved operations on this deployment — NOTHING WAS MEASURED."));
    process.exit(2);
  }
  if (withSharedNames === 0) {
    // ⚠ Not a pass. The detector was never given a chance to fire.
    console.log(c.warn("⚠ NO operation's tables share a column name, so the detector could not"));
    console.log(c.warn("  have fired on any of them. THIS RUN PROVES NOTHING about it."));
    return;
  }
  console.log(
    c.ok(`the control held: ${withSharedNames} operation(s) COULD have been ambiguous`) +
      c.dim(`, and ${firing} were.`),
  );
  console.log(
    c.dim("  the rest read past every shared name — real, and a property of these"),
  );
  console.log(
    c.dim("  operations rather than of the detector. A new join can change it."),
  );
}

main().catch((e) => {
  console.error(c.bad(String(e)));
  process.exit(2);
});
