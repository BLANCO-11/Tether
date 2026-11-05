/**
 * Reads WRITTEN FOR ONE FLOW (2026-10-01, restoring what beta-1.1.5 had and phase 8's cutover lost): when no saved reader and no
 * single table gives the rows a goal needs — several tables combined into one row, related rows counted or totalled over a period,
 * a filter on a related table — the builder has the operation proposer fill in a READ FORM for that goal, and the read travels on
 * the flow's step, approved with the flow. Nothing is saved to the data source.
 *
 * ⚠ THE MODEL FILLS IN A FORM; CODE WRITES THE SQL. The proposer answers a `DbOperationSpec` — base table, joins along keys, grouped
 * summaries of related rows, filters whose values are PARAMETERS — and `compileOperation`, the sole SQL emitter, compiles it. The
 * read is typed by compiling that form against the introspected schema (`specSig`), exactly as a saved operation and a table
 * reader are, so a written read cannot reach the engine untyped. Its description is the form's readback, written by code.
 *
 * ⚠ Where a flow's written reads are found: on its stored steps (`sqlSpec` on a step whose ref is `<ds>.query.<name>`), in its
 * working copy, and — while a build is still asking — in the build's conversation. The catalogue a flow is checked against
 * includes them, and nothing else does: a read written for one flow is never offered to another.
 */
import type { DbOperationSpec } from "../db-operation.service.js";
import { readback as operationReadback, type ReadbackClause } from "../db-operation-readback.js";
import { flowRepo } from "../../repositories/flow.repo.js";
import { flowService } from "../flow.service.js";

/** `<datasource>.query.<name>` — a read written for one flow. Never the spelling of a saved reader (`<ds>.<name>`) or a table (`<ds>.table.<t>`). */
export const LOCAL_REF = ".query.";
export const isLocalRef = (ref: string) => ref.includes(LOCAL_REF);
/** `<datasource>.new_read` — the CHOICE the understanding call is offered: "write a new read of this datasource for this goal". Never built. */
export const NEW_READ = ".new_read";
export const isNewRead = (ref: string) => ref.endsWith(NEW_READ) && !isLocalRef(ref);
export const newReadOf = (datasource: string) => `${datasource}${NEW_READ}`;
export const datasourceOfNewRead = (ref: string) => ref.slice(0, -NEW_READ.length);

export interface LocalReader { ref: string; datasource: string; name: string; spec: DbOperationSpec }

/** What the understanding call reads about the choice to write a new read — the cases a table reader cannot give. */
export const newReadAbout = (datasource: string, tables: number) =>
  `a NEW read of ${datasource} (${tables} table${tables === 1 ? "" : "s"}), written for this goal — choose it when no single reader above gives the rows the goal needs: one row that combines several tables, related rows counted or totalled (in a period), or rows kept by a test on a related table. Choose it once, for all of that data.`;

/** A written read in words, from its form — the readback code writes, never the model's description. */
export function localAbout(spec: DbOperationSpec): string {
  const clauses = operationReadback(spec as never);
  return `a read written for this automation — ${clauses.filter((c) => c.label !== "Ordered by" && c.label !== "At most").map((c) => `${c.label.toLowerCase()} ${c.text}`).join("; ")}`;
}
export const localClauses = (spec: DbOperationSpec): ReadbackClause[] => operationReadback(spec as never);

/** The written reads on a list of STORED steps (a revision's or a working copy's — lowered, so they carry their form). */
export function localReadersIn(steps: unknown): LocalReader[] {
  if (!Array.isArray(steps)) return [];
  const out: LocalReader[] = [];
  for (const s of steps as Array<{ ref?: unknown; sqlSpec?: unknown; datasourceRef?: unknown }>) {
    if (typeof s.ref !== "string" || !isLocalRef(s.ref) || !s.sqlSpec || typeof s.datasourceRef !== "string") continue;
    if (out.some((r) => r.ref === s.ref)) continue;
    out.push({ ref: s.ref, datasource: s.datasourceRef, name: s.ref.slice(s.ref.indexOf(LOCAL_REF) + LOCAL_REF.length), spec: s.sqlSpec as DbOperationSpec });
  }
  return out;
}

/** Every written read a flow carries: its last revision, its working copy, and an unfinished build's conversation. */
export async function flowLocalReaders(workspaceId: string, flowId: string): Promise<LocalReader[]> {
  const flow = await flowRepo.get(workspaceId, flowId);
  if (!flow) return [];
  const rev = flow.draftRevision > 0 ? await flowRepo.getRevision(flow.id, flow.draftRevision) : undefined;
  const inc = await flowService.getIncomplete(workspaceId, flowId);
  const conv = (inc?.build as { goalSpec?: { conversation?: { local?: LocalReader[] } } } | undefined)?.goalSpec?.conversation?.local ?? [];
  return mergeLocal(localReadersIn((rev?.modelJson as { steps?: unknown } | undefined)?.steps), localReadersIn((inc?.model as { steps?: unknown } | undefined)?.steps), conv);
}

/** Written reads from several places, one per ref (the first wins: a revision's is what was approved). */
export const mergeLocal = (...lists: LocalReader[][]): LocalReader[] => {
  const out: LocalReader[] = [];
  for (const r of lists.flat()) if (!out.some((x) => x.ref === r.ref)) out.push(r);
  return out;
};
