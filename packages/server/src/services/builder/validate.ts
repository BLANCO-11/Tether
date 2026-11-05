import { bandArmsConsistent, type BandArm, type Clause, type Plan } from "./plan.js";
import {
  COND_TESTS,
  NONE_FIT,
  UNSAID,
  type BuilderCatalogue,
} from "./goal-spec.js";

/** One way the plan does not satisfy the workspace — stated, never repaired. */
export interface Finding {
  where: string;
  message: string;
}

/**
 * Step 5 (builder-IR): catalogue type-checks ONLY. Every check reads the
 * model's typed output against the catalogue — no English, no heuristics,
 * no repair. A non-empty result means the turn refuses or asks; the plan
 * itself is never mutated.
 */
const SUMMARY_FNS = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "distinct_count",
  "band_count",
] as const;
const COND_TEST_KNOWN: Record<string, true> = Object.fromEntries(COND_TESTS.map((t) => [t, true as const]));

const isNewReadRef = (ref: string): boolean => ref.endsWith(".new_read");

const refKnown = (
  cat: BuilderCatalogue,
  ref: string,
  kind: "reader" | "tool",
): boolean =>
  ref === NONE_FIT ||
  (kind === "tool" && ref === UNSAID) ||
  isNewReadRef(ref) ||
  cat.items.some((i) => i.ref === ref && i.kind === kind);

/** Plain catalogue lookup — the field is `ref.field` of a listed reader, `new_read`, or `summary:N`. */
const fieldKnown = (
  cat: BuilderCatalogue,
  field: string,
  plan: Plan,
): boolean => {
  if (field === "new_read") return true;
  const sm = /^summary:(\d)$/.exec(field);
  if (sm) return !!plan.summary?.measures[Number(sm[1])];
  const at = field.lastIndexOf(".");
  if (at < 0) return false;
  const item = cat.items.find(
    (i) => i.ref === field.slice(0, at) && i.kind === "reader",
  );
  return !!item?.fields?.some((f) => f.name === field.slice(at + 1));
};

const bandFindings = (m: {
  words: string;
  bands?: BandArm[];
  counts?: string | null;
}): Finding[] => {
  const where = `summary measure “${m.words || "?"}”`;
  const bands = m.bands ?? [];
  if (bands.length < 2)
    return [{ where, message: "counts by bands with fewer than two bands" }];
  for (const [j, b] of bands.entries()) {
    if (!b.value?.trim() || !Number.isFinite(Number(b.value)))
      return [
        {
          where,
          message: `band ${j} has an edge that is not a number: “${b.value}”`,
        },
      ];
  }
  if (!bandArmsConsistent(bands))
    return [
      {
        where,
        message: "leaves a band unreachable (a later band covered by an earlier one)",
      },
    ];
  if (
    m.counts != null &&
    m.counts !== "" &&
    !bands.some((b) => b.words === m.counts)
  )
    return [
      {
        where,
        message: `counts “${m.counts}”, which is not one of its bands`,
      },
    ];
  return [];
};

export function validatePlan(
  p: Plan,
  cat: BuilderCatalogue,
  _cs: Clause[],
): Finding[] {
  const out: Finding[] = [];
  p.sources.forEach((s, i) => {
    if (!refKnown(cat, s.ref, "reader"))
      out.push({
        where: `source ${i}`,
        message: `names ${s.ref}, which is not in this workspace`,
      });
  });
  p.actions.forEach((a, i) => {
    if (!refKnown(cat, a.ref, "tool"))
      out.push({
        where: `action ${i}`,
        message: `names ${a.ref}, which is not in this workspace`,
      });
  });
  const tests = [
    ...p.rows.map((t, i) => ({ t, where: `rows ${i}` })),
    ...p.conditions.flatMap((c, i) =>
      c.where.map((t, j) => ({ t, where: `condition ${i} test ${j}` })),
    ),
  ];
  for (const { t, where } of tests) {
    if (!fieldKnown(cat, t.field, p))
      out.push({
        where,
        message: `names a field ${t.field} that no listed reader provides`,
      });
    else if (t.test && !COND_TEST_KNOWN[t.test])
      out.push({ where, message: `tests ${t.field} with ${t.test}, which is not a test` });
    if (t.against && !fieldKnown(cat, t.against, p))
      out.push({
        where,
        message: `compares with ${t.against}, which is not a field of a chosen source`,
      });
  }
  for (const b of p.summary?.by ?? []) {
    if (!fieldKnown(cat, b.field, p))
      out.push({
        where: "summary grouping",
        message: `groups by ${b.field}, which is not a field of a chosen source`,
      });
  }
  for (const m of p.summary?.measures ?? []) {
    if (!(SUMMARY_FNS as readonly string[]).includes(m.fn))
      out.push({
        where: `summary measure “${m.words || "?"}”`,
        message: `computes ${m.fn}, which is not a computation`,
      });
    if (!fieldKnown(cat, m.field, p))
      out.push({
        where: `summary measure “${m.words || "?"}”`,
        message: `names a field ${m.field} that no listed reader provides`,
      });
    if ((m.fn as string) === "band_count") out.push(...bandFindings(m));
  }
  const ids = new Set((p.inputs ?? []).map((i) => i.id));
  for (const { t, where } of tests) {
    if (t.input && t.input !== "none" && !ids.has(t.input))
      out.push({
        where,
        message: `compares with input ${t.input}, which is not in \`inputs\``,
      });
  }
  const used = new Set(tests.map(({ t }) => t.input).filter(Boolean));
  for (const i of p.inputs ?? []) {
    if (!used.has(i.id) && (!i.fills || i.fills === "none"))
      out.push({
        where: `input ${i.id}`,
        message: `“${i.words}” is used by nothing: a test compares with it (\`input\`), or a reader takes it (\`fills\`)`,
      });
  }
  return out;
}
