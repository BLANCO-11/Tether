/**
 * The corpus gate every oracle-scoring harness runs before it scores.
 *
 * ⚠ This module is imported by four harness scripts, and a harness script runs
 * its `main()` AT IMPORT — so the logic lives here, in a module with no
 * `process` and no side effects, and the tests import this rather than any
 * `scenarios/*.ts` or `kestra/*.ts`. Same reason `propose-adjudicate.ts` and
 * `db-operation-readback.ts` are separate files.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const execution = vi.hoisted(() => ({
  row: undefined as { id: string; workspaceId: string } | undefined,
}));
const steps = vi.hoisted(() => ({ rows: [] as Array<{ stepId: string; readFrom: string | null }> }));

vi.mock("../repositories/flow-execution.repo.js", () => ({
  flowExecutionRepo: { getByKestraId: async () => execution.row },
  flowStepRunRepo: { listByExecution: async () => steps.rows },
}));

const { corpusOf } = await import("./oracle-corpus.js");

beforeEach(() => {
  execution.row = { id: "ex1", workspaceId: "ws-abc" };
  steps.rows = [];
});

describe("corpusOf", () => {
  it("scorable when every step read production", async () => {
    steps.rows = [
      { stepId: "fetch", readFrom: "production" },
      // ⚠ null is a tool/transform/approval step, which reads no datasource.
      // Treating it as unknown would abort every run on its own mail step.
      { stepId: "mail", readFrom: null },
    ];
    expect(await corpusOf("k1", "hr_demo")).toEqual({ scorable: true });
  });

  /**
   * ⚠ **`"mock"` — THE VALUE THE FIRST VERSION MISSED, and the reason this test
   * exists as its own case.** The gate filtered for `readFrom === "sandbox"`, a
   * string assumed rather than read; the real union is
   * `"sandbox" | "production" | "mock"` and every step on this deployment
   * stamps `"mock"`. So the gate matched nothing, `scenarios:verify` scored a
   * fixture-backed run, and reported "sent 0, oracle mailable 13" as red checks
   * that read as product defects — the exact failure the gate was written to
   * prevent.
   *
   * ⚠ And the first version of THIS FILE used the same assumed string, so the
   * test agreed with the bug. It was found by running the harness, not here.
   */
  it("refuses a `mock` corpus, not only `sandbox`", async () => {
    steps.rows = [{ stepId: "overdue", readFrom: "mock" }];
    const v = await corpusOf("k1", "finance_demo");
    expect(v.scorable).toBe(false);
    if (!v.scorable) expect(v.message).toContain("mock");
  });

  /**
   * ⚠ The property that makes the above unrepeatable: the gate requires
   * `production` rather than listing what is not. A corpus nobody has heard of
   * is refused until somebody decides about it.
   */
  it("refuses an UNKNOWN corpus — an allowlist of one, not a denylist", async () => {
    steps.rows = [{ stepId: "fetch", readFrom: "some_future_corpus" }];
    expect((await corpusOf("k1", "hr_demo")).scorable).toBe(false);
  });

  /**
   * ⚠ THE case. A draft run reads a datasource's sandbox whenever one exists,
   * and the oracle describes the real dataset — so the two disagree silently.
   */
  it("refuses when any step read fixtures, and names the steps", async () => {
    steps.rows = [
      { stepId: "fetch_invoices", readFrom: "sandbox" },
      { stepId: "project", readFrom: null },
      { stepId: "fetch_terms", readFrom: "sandbox" },
    ];
    const v = await corpusOf("k1", "finance_demo");
    expect(v.scorable).toBe(false);
    if (v.scorable) return;
    // ⚠ The step IDS, deduped. "some step read fixtures" is not actionable;
    // the names are what someone opens.
    expect(v.fixtureSteps).toEqual(["fetch_invoices", "fetch_terms"]);
    // ⚠ And it says nothing is broken. A harness that cannot answer must not
    // read as a product failure — that is the distinction the whole gate rests
    // on, and the sentence is the only place it is made.
    expect(v.message).toContain("Nothing is broken");
    expect(v.message).toContain("finance_demo");
    // ⚠ The workspace id RESOLVED, never `<the workspace>`. A template in a
    // message somebody acts on is the mistake this repo has now recorded three
    // times — a prompt that emitted a literal `<reader you need>` ref, the
    // abandoned-build reason, and the first draft of this very string.
    expect(v.message).toContain("--workspace=ws-abc");
    expect(v.message).not.toMatch(/<[a-z][a-z ]*>/i);
  });

  it("ONE fixture step among many is enough — it is not a majority vote", async () => {
    steps.rows = [
      { stepId: "a", readFrom: "production" },
      { stepId: "b", readFrom: "production" },
      { stepId: "c", readFrom: "mock" },
    ];
    expect((await corpusOf("k1", "hr_demo")).scorable).toBe(false);
  });

  /**
   * ⚠ Stated in the docblock and asserted here: no recorded steps is SCORABLE.
   * The run's own assertions should speak about a flow that produced nothing;
   * aborting would replace a specific failure with a vague one.
   */
  it("no execution row, and no step runs, are both scorable", async () => {
    execution.row = undefined;
    expect(await corpusOf("k1", "hr_demo")).toEqual({ scorable: true });
    execution.row = { id: "ex1", workspaceId: "ws-abc" };
    steps.rows = [];
    expect(await corpusOf("k1", "hr_demo")).toEqual({ scorable: true });
  });
});

/**
 * ⚠ **The wiring, which the module's own tests cannot close.** A correct check
 * nothing calls is I-120, and this file would pass in full against four
 * harnesses that never import it.
 */
describe("every oracle-scoring harness calls it", () => {
  const url = (p: string) => new URL(p, import.meta.url);

  it.each([
    ["../scenarios/verify.ts", "finance_demo"],
    ["../showcase/verify.ts", "hr_demo"],
    ["../kestra/expect-verify.ts", "hr_demo"],
  ])("%s aborts on a fixture-backed run", async (path, hint) => {
    const src = await readFile(url(path), "utf8");
    // Control: the file was found and is the harness, not an empty read.
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("flowService.testRun");
    // A CALL, not an import — matching the import alone is satisfied by a file
    // that imports and never uses it, which is exactly I-120 wearing a green
    // test (the `requireProvenanceAuthority` mistake, found by perturbing).
    expect(src).toContain(`abortUnlessScorable(`);
    expect(src).toContain(hint);
  });

  /**
   * ⚠ **`kestra:sandbox` must NEVER call it.** Its entire subject is that a
   * draft run reads fixtures — the gate there would refuse the behaviour under
   * test. Asserted as an absence so nobody adds it "for consistency".
   */
  it("kestra:sandbox does NOT — fixtures are its subject", async () => {
    const src = await readFile(url("../kestra/sandbox-verify.ts"), "utf8");
    expect(src.length).toBeGreaterThan(2000);
    expect(src).not.toContain("abortUnlessScorable");
  });

  /**
   * ⚠ `kestra:prove` does not either, and for a different reason worth writing
   * down: it deploys and executes in the LIVE namespace
   * (`namespaceFor(tenant, slug)` with no env argument), so it reads production
   * and the gate could never fire. A check that cannot fail is worse than none
   * (I-38).
   */
  it("kestra:prove does NOT — it runs live, so the gate could never fire", async () => {
    const src = await readFile(url("../kestra/phase1-prove.ts"), "utf8");
    expect(src.length).toBeGreaterThan(2000);
    expect(src).not.toContain("abortUnlessScorable");
    expect(src).not.toContain("flowService.testRun");
  });
});
