/**
 * WHAT an automation is being designed against — the part of the workspace's
 * catalogue a person pointed at before asking for a flow.
 * platform-coherence Phase 3 · I-105 · D-113 · **D-114 (2026-08-07)**
 *
 * ── ⚠ A selection PRIORITISES. It stopped narrowing on 2026-08-07 ────────────
 *
 * It used to remove everything unpicked from the catalogue, and the docblock
 * below argued for that at length: taking a tool off the list is the only lever
 * that actually changes what gets drafted. The argument was sound and the
 * behaviour was wrong, for a reason no amount of reasoning about the prompt was
 * going to surface — **it made a slightly-wrong pick produce a REFUSAL instead
 * of a flow.** Reported from use: *"not a single 'build it for me' worked… if it
 * is stuck because of no selection of datasource or tools, it should have
 * freedom to explore it itself regardless."*
 *
 * A refusal is the most useful answer this system produces when the WORKSPACE
 * cannot do something. It is close to the least useful when the workspace can do
 * it perfectly well and a person ticked four boxes instead of five, because the
 * fix is a round trip through the person who is already stuck. Narrowing
 * converted the first kind of answer into the second, silently.
 *
 * So the drafter is now shown **everything**, in two labelled sections — the
 * picked refs under PREFERRED, the rest under ALSO AVAILABLE — and a refusal
 * once again means what it says.
 *
 * ⚠ **What this re-opens, stated rather than discovered later.** `DRAFT_RULES`
 * says *"a tool being callable is not a reason to call it"*, and that rule now
 * carries weight narrowing used to carry structurally. The preferred section is
 * a mitigation, not a proof. `draft:measure`'s SCOPED arm exists to keep the
 * question measurable, and the number it reports is which refs the flow used —
 * never the attempt count, which cannot see this at all.
 *
 * ── ⚠ AND THE FIRST MEASUREMENT SAID THE PREFERENCE STEERS NOTHING (I-114) ───
 *
 * Matched n=3 either side of this change: four successful scoped drafts across
 * both arms named **the same three refs**, using 1 of 3 preferred every time.
 * The cause is that `buildDraftPrompt` puts the ~19 KB workspace MANIFEST
 * directly beneath this catalogue, and the manifest lists every tool — so
 * narrowing hid nothing, and prioritising promotes nothing the drafter was not
 * already reading elsewhere.
 *
 * ⚠ **So do not describe a selection as making a tool more likely to be used.**
 * What it does: it is recorded, it is visible on the flow page, and it can no
 * longer cause a refusal. If ref choice ever has to be steered, the manifest is
 * the block to change — and `refFingerprints()` hashes manifest content (I-40),
 * so that change owes the same fleet-wide check before it ships.
 *
 * ── Why this is a preference and not a boundary ──────────────────────────────
 *
 * ⚠ **`unknownRefs()` against the workspace stays the ONLY thing that refuses a
 * step's ref**, and nothing here may become a second one. Two places that can
 * refuse a ref will eventually disagree, and the one that fires will be whichever
 * the reader is not looking at. A selection changes what the drafter is SHOWN
 * FIRST; it does not change what a flow is allowed to contain.
 *
 * ⚠ **And it must not gain a validation lever now that it no longer narrows.**
 * The tempting fix is to reject a draft that used an unpreferred ref — which is
 * a rejection of the model for a choice that is often correct, re-asked in a
 * loop, which is §6.7's mistake with a new subject. What exists instead is a
 * NOTE on the review screen naming both sides (`selectionUsage`): an
 * observation a person reads, blocking nothing.
 *
 * ── ⚠ The one thing this DOES refuse, and why it is not that second path ─────
 *
 * A selection naming a datasource or tool that **does not exist** is refused
 * before any inference runs. That is validating the REQUEST's own input, not a
 * drafted flow's refs: the picker is populated from the live catalogue, so an
 * unknown entry means the thing was deleted between choosing and submitting, or
 * the request was hand-made.
 *
 * Silently ignoring it is the option to avoid. The whole point of persisting a
 * selection (3.3) is that an automation stays the thing that was designed; a
 * selection that quietly evaporates gives you a flow designed against the whole
 * workspace while the request said otherwise — which is exactly the class of
 * failure this programme keeps finding (a control that appears to work).
 */
import { z } from "zod";

/**
 * ⚠ Datasources by ID, tools by NAME, and the asymmetry is deliberate.
 *
 * A tool's `name` IS its ref — it is the identifier a flow model carries and
 * what `unknownRefs()` compares against, so storing an id here would mean
 * translating on every read and the stored selection would not be greppable
 * against a flow's steps. A datasource has no such ref: a step names
 * `<datasource>.<query>`, and the datasource's own name is renameable while its
 * id is not. Storing the renameable half would silently drop a datasource from
 * an automation's scope the day somebody tidied its name.
 */
export const designSelectionSchema = z
  .object({
    datasourceIds: z.array(z.string().uuid()).max(64).optional(),
    toolRefs: z.array(z.string().min(1).max(255)).max(128).optional(),
  })
  .refine((v) => (v.datasourceIds?.length ?? 0) + (v.toolRefs?.length ?? 0) > 0, {
    // An empty selection and no selection are the same thing said two ways, and
    // they would still behave differently now that nothing is hidden: `{}` would
    // emit an empty PREFERRED section, which reads to the drafter as "the person
    // pointed at nothing on purpose". Omit the field instead.
    message:
      "a selection must name at least one datasource or tool — omit `selection` entirely to design against the whole workspace with nothing preferred",
  });

export type DesignSelection = z.infer<typeof designSelectionSchema>;

/** One named query, flattened out of the repo's `{query, datasource}` pair. */
export interface AvailableQuery {
  datasourceId: string;
  datasourceName: string;
  name: string;
}

export interface AvailableTool {
  name: string;
}

export interface ResolvedSelection<
  Q extends AvailableQuery,
  T extends AvailableTool,
  O extends AvailableQuery = never,
> {
  /**
   * False ⇒ nothing was picked, so nothing is preferred over anything else.
   *
   * ⚠ Renamed from `narrowed` when the behaviour changed, deliberately rather
   * than left alone. The old name would have been a field asserting the one
   * thing this no longer does, on the seam where a reader goes to find out.
   */
  prioritised: boolean;
  /**
   * ⚠ **Everything the workspace holds, always** — a selection no longer
   * subtracts from these. The picked subset is `preferredQueries` /
   * `preferredOperations` / `preferredTools`, and the three together are what
   * `catalogueText` renders as its two sections.
   */
  queries: Q[];
  tools: T[];
  /** DB operations — same flattened shape as queries; a selection picks them by datasource. */
  operations: O[];
  /** The picked subset, in the workspace's own order. Empty when nothing was picked. */
  preferredQueries: Q[];
  preferredOperations: O[];
  preferredTools: T[];
  /**
   * Selected things that do not exist, as a person would name them. Non-empty
   * ⇒ refuse; see the header for why this is not the forbidden second path.
   */
  unknown: string[];
  /**
   * ⚠ Selected datasources that exist and hold NO named query and NO DB
   * operation.
   *
   * Not an error — a datasource with no query yet is a normal state, and
   * refusing would make "I picked my database" fail for a reason the person
   * cannot act on from the generation screen. It is reported so the caller can
   * say it out loud rather than leaving a person to wonder why pointing at their
   * database changed nothing about the draft.
   */
  emptyDatasources: string[];
}

/**
 * Apply a selection to what the workspace actually has.
 *
 * Pure, and takes the available sets rather than a workspace id, so the rules
 * are testable without a database — the same reason `lib/flow-authoring.ts`
 * exists on the client side.
 */
export function resolveSelection<
  Q extends AvailableQuery,
  T extends AvailableTool,
  O extends AvailableQuery = never,
>(
  selection: DesignSelection | null | undefined,
  available: { queries: Q[]; tools: T[]; operations?: O[] },
): ResolvedSelection<Q, T, O> {
  const wantedDs = selection?.datasourceIds ?? [];
  const wantedTools = selection?.toolRefs ?? [];
  const operations = available.operations ?? [];
  if (!wantedDs.length && !wantedTools.length) {
    return {
      prioritised: false,
      queries: available.queries,
      tools: available.tools,
      operations,
      preferredQueries: [],
      preferredOperations: [],
      preferredTools: [],
      unknown: [],
      emptyDatasources: [],
    };
  }

  const dsNameById = new Map<string, string>();
  for (const q of available.queries) dsNameById.set(q.datasourceId, q.datasourceName);
  for (const o of operations) dsNameById.set(o.datasourceId, o.datasourceName);
  const toolNames = new Set(available.tools.map((t) => t.name));

  const preferredQueries = available.queries.filter((q) => wantedDs.includes(q.datasourceId));
  const preferredOperations = operations.filter((o) => wantedDs.includes(o.datasourceId));
  const preferredTools = available.tools.filter((t) => wantedTools.includes(t.name));

  // ⚠ A datasource is only visible here through its QUERIES and OPERATIONS, so
  // "exists" cannot be decided from this set alone — a real datasource with
  // neither looks identical to an id nobody owns. The caller passes
  // `knownDatasourceIds` when it can tell the difference; without it, the honest
  // reading is that anything with no queries or operations is *empty*, not
  // *unknown*, because the harsher verdict is the one that would be wrong about
  // a real datasource.
  const unknown = wantedTools.filter((n) => !toolNames.has(n)).map((n) => `tool "${n}"`);
  const emptyDatasources = wantedDs
    .filter(
      (id) =>
        !preferredQueries.some((q) => q.datasourceId === id) &&
        !preferredOperations.some((o) => o.datasourceId === id),
    )
    .map((id) => dsNameById.get(id) ?? id);

  return {
    prioritised: true,
    // ⚠ The FULL sets, unchanged by the selection. This one line is the whole
    // behaviour change; the two `preferred*` arrays are what the picking buys.
    queries: available.queries,
    tools: available.tools,
    operations,
    preferredQueries,
    preferredOperations,
    preferredTools,
    unknown,
    emptyDatasources,
  };
}

/** One entry of a stored selection, resolved for display. */
export interface SelectionEntry {
  kind: "datasource" | "tool";
  /** The name if it still exists; the stored id/ref if it does not. */
  label: string;
  /**
   * ⚠ False ⇒ the thing this automation was designed against is GONE.
   *
   * Reported rather than filtered out. A scope that silently shrinks as its
   * members are deleted is a record of a decision quietly rewriting itself —
   * the same argument as `flow_step_runs.read_from` being persisted rather than
   * recomputed, and the same argument as this column not being backfilled.
   */
  present: boolean;
  /**
   * ⚠ Did the automation actually USE this? — D-114.
   *
   * `null` when nobody asked (no refs were supplied to compare against), which
   * is not the same as `false`. A caller rendering `null` as "unused" would
   * accuse every flow read through a path that does not have a revision to hand.
   */
  used: boolean | null;
}

/**
 * A stored selection, resolved against what the workspace holds today.
 *
 * Returns null when nothing was chosen — which is NOT the same as an empty
 * array. Null means the automation was designed against the whole workspace (or
 * predates the column); an empty array would mean "designed against nothing",
 * which nothing can produce.
 */
export function describeSelection(
  stored: unknown,
  present: { datasources: Array<{ id: string; name: string }>; tools: Array<{ name: string }> },
  /**
   * The refs the automation's steps actually name, if the caller has them.
   * Omitted ⇒ every entry's `used` is `null` — "not asked", never "no".
   */
  usedRefs?: readonly string[],
): SelectionEntry[] | null {
  const parsed = designSelectionSchema.safeParse(stored);
  if (!parsed.success) return null;
  const dsById = new Map(present.datasources.map((d) => [d.id, d.name]));
  const toolNames = new Set(present.tools.map((t) => t.name));
  return [
    ...(parsed.data.datasourceIds ?? []).map((id) => {
      const label = dsById.get(id) ?? id;
      return {
        kind: "datasource" as const,
        label,
        present: dsById.has(id),
        used: usedRefs ? usedRefs.some((r) => coversRef("datasource", label, r)) : null,
      };
    }),
    ...(parsed.data.toolRefs ?? []).map((name) => ({
      kind: "tool" as const,
      label: name,
      present: toolNames.has(name),
      used: usedRefs ? usedRefs.some((r) => coversRef("tool", name, r)) : null,
    })),
  ];
}

/**
 * The datasource half of the existence check, which `resolveSelection` cannot do
 * from queries alone.
 *
 * Separate because it needs a different input — the workspace's datasource ids,
 * whether or not they hold a query. Folding it into `resolveSelection` would
 * mean that function silently reported every query-less datasource as unknown,
 * which is wrong about the commonest legitimate case: a database registered five
 * minutes ago.
 */
export function unknownDatasources(
  selection: DesignSelection | null | undefined,
  known: Array<{ id: string }>,
): string[] {
  const ids = new Set(known.map((d) => d.id));
  return (selection?.datasourceIds ?? []).filter((id) => !ids.has(id)).map((id) => `datasource ${id}`);
}

/**
 * Does one selected thing account for one of a flow's refs?
 *
 * ⚠ **A datasource matches by PREFIX and a tool by equality**, because that is
 * what a step's ref is: `<datasource>.<query>` for a `datasource` step and the
 * tool's bare name for a `tool` step. Matching a datasource by equality would
 * report every picked database as unused; matching a tool by prefix would count
 * `mail_send_template` as using `mail_send`, which is the exact pair this note
 * exists to tell apart.
 */
export function coversRef(kind: "datasource" | "tool", label: string, ref: string): boolean {
  return kind === "tool" ? ref === label : ref.startsWith(`${label}.`);
}

/**
 * The refs a flow's steps actually name.
 *
 * ⚠ **ONE definition, and it used to be inline in `routes/flows.ts`.** That
 * route already computes *"you pointed at X; this used Y"* for a screen
 * (`unpreferredRefs`), and `selectionIgnored` asks the same question of a draft
 * before it is returned — so the two must agree about what "used" means or the
 * screen and the check describe different flows.
 *
 * ⚠ **Every step, not only the ref-bearing kinds.** `ref` is absent on
 * `transform`, `code`, `approval`, `branch` and `merge`, so the filter is the
 * field rather than a kind list — a kind list is a second thing to update when
 * a tenth kind arrives, and forgetting it drops that kind's refs silently.
 */
export function refsUsedBy(model: { steps?: ReadonlyArray<unknown> } | null | undefined): string[] {
  return (model?.steps ?? [])
    // ⚠ `unknown` rather than `{ ref?: unknown }`: a `TransformStep` has no
    // `ref` field at all, so the narrower type has no property in common with
    // it and TypeScript refuses a real `FlowModel`. The field check below is
    // the whole of the narrowing, and it is the same check either way.
    .map((st) => (st && typeof st === "object" ? (st as { ref?: unknown }).ref : undefined))
    .filter((r): r is string => typeof r === "string" && r.length > 0);
}

/**
 * The refs a selection actually put on offer — the three `preferred*` arrays
 * flattened into the spelling a STEP uses (`<datasource>.<reader>`, or a tool's
 * bare name).
 *
 * ⚠ **ONE definition, two consumers** (D-197). `catalogueText` builds the
 * PREFERRED section of the prompt from this, and `selectionIgnored` decides
 * whether the draft used any of it. Two copies would drift in the direction
 * where the check disagrees with what the model was shown — and then the check
 * blames the model for ignoring something that was never on the page, which is
 * a false accusation rather than a missed one.
 */
export function preferredRefNames(resolved: {
  preferredQueries: ReadonlyArray<{ datasourceName: string; name: string }>;
  preferredOperations: ReadonlyArray<{ datasourceName: string; name: string }>;
  preferredTools: ReadonlyArray<{ name: string }>;
}): string[] {
  return [
    ...resolved.preferredQueries.map((q) => `${q.datasourceName}.${q.name}`),
    ...resolved.preferredOperations.map((o) => `${o.datasourceName}.${o.name}`),
    ...resolved.preferredTools.map((t) => t.name),
  ];
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DID THE DRAFT USE WHAT IT WAS POINTED AT?  (Phase 3, I-180)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **`preferred*` was rendered into the prompt and CHECKED BY NOTHING.** That
 * is the whole of I-180's second half, and the harness named it in its own
 * output: `draft:measure` scored **4/4 drafted at 1.0 attempts** while
 * *"scoped draft used what it was pointed at: none — 0 of 3 refs preferred"*,
 * because a flow that reaches for the wrong reader drafts perfectly cleanly.
 * Every existing control passes it: the refs EXIST, so `unknownRefs` is happy;
 * the parameters match, so `refFindings` is happy; the shape is legal, so
 * `validateModel` is happy. Nothing was wrong with the flow except that it is
 * not the flow that was asked for.
 *
 * ⚠ **This is a CHECK, not advice, and that is deliberate after I-196.** The
 * person's selection is a *stated fact* — they ticked the boxes — not a model's
 * reading of a sentence. I-118's rule is to teach a thing in the prompt *and*
 * catch it with a check wherever a check is possible, and here it is possible.
 * The measured reason it matters: advice naming the right answer was taken once
 * and ignored once on identical input (I-196), so a second advice block would
 * inherit that coin flip. A check does not.
 *
 * ── ⚠ WHEN IT MUST STAY SILENT, AND EACH ONE IS AN I-62 ─────────────────────
 *
 * A guard that cries wolf gets widened until the widening permits the defect,
 * so this fires on ONE unambiguous pattern and returns null everywhere else:
 *
 *  - **nothing was picked** — an unscoped draft has no stated intent to drift
 *    from, and `resolveSelection` reports `prioritised: false` for it. Designing
 *    against the whole workspace is a first-class product state (see this file's
 *    opening note), which is also the escape hatch for anyone this check
 *    inconveniences: pick nothing and it cannot fire.
 *  - **the draft names no refs at all** — a flow of `transform` and `code` steps
 *    reads nothing and calls nothing, so it has not reached past its selection;
 *    it has not reached at all.
 *  - **the selection resolves to nothing usable** — a datasource picked before
 *    anyone wrote it a reader has no ref to be used, and
 *    `resolveSelection`'s `emptyDatasources` already reports that in words a
 *    person can act on. Reporting it twice, once as the person's fault, is how
 *    one finding becomes two and neither gets fixed.
 *
 * So it fires only where the draft **did** reach for refs, the selection **did**
 * offer some, and the two sets do not intersect at all. Not "mostly ignored" —
 * `usedPreferred > 0` is silent, because a flow legitimately needs things
 * nobody ticked, which is precisely why a selection prioritises rather than
 * narrows (D-114).
 */
export function selectionIgnored(
  selection: DesignSelection | null | undefined,
  /** Datasource names by id — a step's ref carries the NAME, a selection carries the id. */
  datasourceNames: ReadonlyMap<string, string>,
  /** The refs the drafted flow's `tool`/`datasource`/`query` steps actually name. */
  usedRefs: readonly string[],
  /**
   * The refs the selection actually offered — `resolveSelection`'s three
   * `preferred*` arrays, flattened. Passed in rather than recomputed: this
   * function must agree with the PROMPT about what was on offer, and the prompt
   * is built from those arrays.
   */
  offeredRefs: readonly string[],
): { preferred: string[]; used: string[] } | null {
  const dsIds = selection?.datasourceIds ?? [];
  const toolRefs = selection?.toolRefs ?? [];
  if (!dsIds.length && !toolRefs.length) return null;
  if (!usedRefs.length) return null;
  if (!offeredRefs.length) return null;

  const labels: Array<{ kind: "datasource" | "tool"; label: string }> = [
    ...dsIds.map((id) => ({ kind: "datasource" as const, label: datasourceNames.get(id) ?? id })),
    ...toolRefs.map((name) => ({ kind: "tool" as const, label: name })),
  ];
  const usedAny = usedRefs.some((r) => labels.some((l) => coversRef(l.kind, l.label, r)));
  if (usedAny) return null;
  return { preferred: [...offeredRefs], used: [...usedRefs] };
}

/**
 * ⚠ What a flow used that nobody pointed at — the other half of the sentence.
 *
 * The note reads *"you pointed at X; this used Y"*, and both names have to be in
 * it. Naming only the ignored half turns an observation into a verdict on a
 * decision nobody checked — and choosing a different tool is often correct,
 * which is the whole reason this blocks nothing and is never fed to a redraft
 * (§6.7: re-asking a correct answer is how it becomes a wrong one).
 *
 * De-duplicated, because a flow that calls one tool in three steps has made one
 * choice, not three.
 */
export function unpreferredRefs(
  entries: readonly SelectionEntry[],
  usedRefs: readonly string[],
): string[] {
  return [...new Set(usedRefs)].filter((r) => !entries.some((e) => coversRef(e.kind, e.label, r)));
}
