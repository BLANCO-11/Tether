/**
 * The rules behind "design this automation against these things".
 * platform-coherence Phase 3 · I-105
 *
 * ⚠ These are the rules that decide what the DRAFTER SEES. A selection is not a
 * validator — `unknownRefs()` against the workspace stays the only thing that
 * refuses a step's ref — so if any assertion here starts to read like a
 * permission check, the design has drifted.
 */
import { describe, expect, it } from "vitest";
import {
  describeSelection,
  designSelectionSchema,
  unpreferredRefs,
  resolveSelection,
  unknownDatasources,
} from "./flow-selection.js";

const DS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const QUERIES = [
  { datasourceId: DS_A, datasourceName: "finance_demo", name: "invoices_overdue" },
  { datasourceId: DS_A, datasourceName: "finance_demo", name: "budget_vs_actual" },
  { datasourceId: DS_B, datasourceName: "hr_demo", name: "attendance_below" },
];
const TOOLS = [{ name: "mail_send" }, { name: "ticket_create" }, { name: "llm_complete" }];
const AVAILABLE = { queries: QUERIES, tools: TOOLS };

describe("platform-coherence 3 — the shape of a selection", () => {
  it("refuses a selection that names nothing", () => {
    // ⚠ `{}` and "no selection" are the same intent said two ways and would
    // behave differently: an empty selection narrows the catalogue to nothing
    // and every draft refuses for a reason nobody can act on.
    const r = designSelectionSchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]!.message).toMatch(/omit `selection` entirely/);
  });

  it("accepts either half alone", () => {
    expect(designSelectionSchema.safeParse({ toolRefs: ["mail_send"] }).success).toBe(true);
    expect(designSelectionSchema.safeParse({ datasourceIds: [DS_A] }).success).toBe(true);
  });

  it("takes datasources by id and tools by name", () => {
    // The asymmetry is deliberate — a tool's name IS its ref, and a datasource's
    // name is renameable while its id is not. A non-uuid datasource entry is a
    // name that got stored, which would drop out of scope on the next rename.
    expect(designSelectionSchema.safeParse({ datasourceIds: ["finance_demo"] }).success).toBe(false);
    expect(designSelectionSchema.safeParse({ toolRefs: ["mail_send"] }).success).toBe(true);
  });
});

describe("platform-coherence 3 — prioritising the catalogue (D-114)", () => {
  it("with no selection, hands back everything unchanged", () => {
    // ⚠ The control for every assertion below, and the property the whole
    // regression net depends on: every harness, seed and scenario generates
    // without a selection, so "omitted" has to mean today's behaviour exactly.
    const r = resolveSelection(undefined, AVAILABLE);
    expect(r.prioritised).toBe(false);
    expect(r.queries).toEqual(QUERIES);
    expect(r.tools).toEqual(TOOLS);
    // Nothing picked ⇒ nothing preferred. Not "everything preferred", which
    // would make the PREFERRED section a copy of the whole catalogue.
    expect(r.preferredQueries).toEqual([]);
    expect(r.preferredTools).toEqual([]);
  });

  it("⚠ NEVER removes anything — a selection only marks a preference", () => {
    // ⚠ **This assertion is the inverse of the one it replaces**, which read
    // "keeps only the chosen datasource's queries" and was correct until
    // 2026-08-07. Narrowing turned a slightly-wrong pick into a refusal, and
    // measurement showed it did not even buy what it cost: against a narrowed
    // catalogue the drafter still named two refs it had never been shown
    // (`measure-before.txt`), because `unknownRefs` validates against the
    // WORKSPACE and let them through. It was paying the refusal price for a
    // restriction it was not actually applying.
    const r = resolveSelection({ datasourceIds: [DS_A] }, AVAILABLE);
    expect(r.prioritised).toBe(true);
    expect(r.queries).toEqual(QUERIES);
    expect(r.tools).toEqual(TOOLS);
    expect(r.preferredQueries.map((q) => q.name)).toEqual(["invoices_overdue", "budget_vs_actual"]);
    // Nothing chosen on the tool side means nothing PREFERRED on the tool side
    // — and every tool still visible.
    expect(r.preferredTools).toEqual([]);
  });

  it("prefers the chosen tools without hiding the others", () => {
    const r = resolveSelection({ toolRefs: ["mail_send", "llm_complete"] }, AVAILABLE);
    expect(r.preferredTools.map((t) => t.name)).toEqual(["mail_send", "llm_complete"]);
    expect(r.tools).toEqual(TOOLS);
    expect(r.preferredQueries).toEqual([]);
    expect(r.queries).toEqual(QUERIES);
  });

  it("reports a tool that does not exist", () => {
    const r = resolveSelection({ toolRefs: ["mail_send", "slack_post"] }, AVAILABLE);
    expect(r.unknown).toEqual(['tool "slack_post"']);
    // ⚠ And still prefers what it found. The caller refuses on `unknown`; this
    // function does not decide that, because deciding it here would make it the
    // second refusal path.
    expect(r.preferredTools.map((t) => t.name)).toEqual(["mail_send"]);
  });

  it("calls a query-less datasource EMPTY, never unknown", () => {
    // A database registered five minutes ago holds no named query yet. That is
    // the commonest legitimate case, and the harsher verdict would be wrong
    // about it — so the one that would refuse a real datasource is not the one
    // this function reaches for.
    const r = resolveSelection({ datasourceIds: [DS_A, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }, {
      queries: QUERIES,
      tools: TOOLS,
    });
    expect(r.unknown).toEqual([]);
    expect(r.emptyDatasources).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
  });

  it("decides an unknown DATASOURCE from the datasource list, not from queries", () => {
    const known = [{ id: DS_A }, { id: DS_B }];
    expect(unknownDatasources({ datasourceIds: [DS_A] }, known)).toEqual([]);
    expect(unknownDatasources({ datasourceIds: [DS_A, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"] }, known))
      .toEqual(["datasource dddddddd-dddd-4ddd-8ddd-dddddddddddd"]);
    expect(unknownDatasources(null, known)).toEqual([]);
  });
});

describe("D-114 — a preference that went unused", () => {
  const present = {
    datasources: [{ id: DS_A, name: "finance_demo" }],
    tools: [{ name: "mail_send" }],
  };
  const entries = (stored: unknown, used?: string[]) => describeSelection(stored, present, used)!;

  it("says 'not asked' rather than 'no' when no refs were supplied", () => {
    // ⚠ `null` and `false` are different answers and would render identically
    // as a falsy check. A caller with no revision to hand must not accuse a
    // flow of ignoring a choice it never looked at.
    const out = entries({ toolRefs: ["mail_send"] });
    expect(out[0]!.used).toBeNull();
  });

  it("matches a datasource by PREFIX and a tool by equality", () => {
    // ⚠ The pair this has to tell apart: `mail_send_template` does not use
    // `mail_send`. A prefix rule on tools would call the selection honoured.
    const out = entries(
      { datasourceIds: [DS_A], toolRefs: ["mail_send"] },
      ["finance_demo.invoices_overdue", "mail_send_template"],
    );
    expect(out.map((e) => [e.label, e.used])).toEqual([
      ["finance_demo", true],
      ["mail_send", false],
    ]);
  });

  it("names what was used instead, de-duplicated", () => {
    const out = entries({ toolRefs: ["mail_send"] }, ["ticket_create", "ticket_create", "mail_send"]);
    // A flow calling one tool in three steps made one choice, not three.
    expect(unpreferredRefs(out, ["ticket_create", "ticket_create", "mail_send"])).toEqual([
      "ticket_create",
    ]);
  });

  it("reports nothing extra when the flow used only what was picked", () => {
    const out = entries({ datasourceIds: [DS_A] }, ["finance_demo.invoices_overdue"]);
    expect(unpreferredRefs(out, ["finance_demo.invoices_overdue"])).toEqual([]);
    expect(out.every((e) => e.used)).toBe(true);
  });
});

describe("platform-coherence 3 — reading a stored selection back", () => {
  const present = {
    datasources: [{ id: DS_A, name: "finance_demo" }],
    tools: [{ name: "mail_send" }],
  };

  it("distinguishes 'nobody chose' from 'chose nothing'", () => {
    // ⚠ NULL is a real value. It means the automation was designed against the
    // whole workspace, or predates the column — migration 0030 deliberately
    // backfills nothing, so later nothing can tell a deliberate scope from a
    // migration's guess.
    expect(describeSelection(null, present)).toBeNull();
    expect(describeSelection({}, present)).toBeNull();
    expect(describeSelection({ toolRefs: ["mail_send"] }, present)).toHaveLength(1);
  });

  it("marks a selected thing that has since been deleted", () => {
    // Reported, never filtered out. A scope that silently shrinks as its members
    // are deleted is a record of a decision quietly rewriting itself.
    const out = describeSelection({ datasourceIds: [DS_A, DS_B], toolRefs: ["slack_post"] }, present)!;
    expect(out).toEqual([
      // ⚠ `used: null` throughout — this call passed no refs, so nothing was
      // asked. `present` and `used` are independent: a thing can still exist and
      // be unused, or be gone and have been used by the revision that names it.
      { kind: "datasource", label: "finance_demo", present: true, used: null },
      { kind: "datasource", label: DS_B, present: false, used: null },
      { kind: "tool", label: "slack_post", present: false, used: null },
    ]);
  });
});
