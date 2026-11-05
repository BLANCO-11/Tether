/**
 * The datasource access policy, and the three properties that make it a control
 * rather than a label.
 *
 * ⚠ **This replaced a refusal** (2026-09-17). `datasource.service.ts` used to
 * reject any credential that could write. It now records what the credential
 * can do and enforces the DECLARED policy at execution. So the tests that
 * matter are not "does the enum parse" — they are: does the narrowest policy
 * win when anything is unclear, and is the transaction actually opened.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  ACCESS_POLICIES,
  DEFAULT_ACCESS_POLICY,
  enforcedPolicy,
  isAccessPolicy,
  requiresReadOnlyTransaction,
} from "./datasource-access-policy.js";

describe("the policy set", () => {
  it("is ordered widest-last and defaults to the narrowest", () => {
    expect([...ACCESS_POLICIES]).toEqual(["read", "read_write", "full"]);
    expect(DEFAULT_ACCESS_POLICY).toBe("read");
    // ⚠ The default is asserted as a LITERAL, not as ACCESS_POLICIES[0]. A test
    // that reads the answer out of the thing it is testing agrees with any
    // future reordering — which is exactly how "the default quietly became
    // read_write" would ship green.
  });

  it("refuses to recognise a value outside the set", () => {
    for (const p of ACCESS_POLICIES) expect(isAccessPolicy(p)).toBe(true);
    for (const bad of ["sudo", "READ", "readwrite", "", null, undefined, 1, {}]) {
      expect(isAccessPolicy(bad)).toBe(false);
    }
  });
});

/**
 * ⚠ **The two functions answer the same question in opposite directions, and
 * that is deliberate.** `isAccessPolicy` guards what a caller may SET — unknown
 * is refused. `enforcedPolicy` decides what to ENFORCE on a row that already
 * exists — unknown becomes the narrowest. Refusing to run at all over a
 * surprising column value would take every flow in the workspace down;
 * narrowing degrades to "reads work, writes do not", which cannot lose data.
 */
describe("enforcement fails closed", () => {
  it("anything unrecognised — including null — enforces `read`", () => {
    for (const stored of [null, undefined, "", "sudo", "FULL", 7, {}, []]) {
      expect(enforcedPolicy(stored)).toBe("read");
      expect(requiresReadOnlyTransaction(stored)).toBe(true);
    }
  });

  it("a recognised policy is enforced as written", () => {
    expect(enforcedPolicy("read_write")).toBe("read_write");
    expect(enforcedPolicy("full")).toBe("full");
    // The control: the narrowing above is not simply "always true".
    expect(requiresReadOnlyTransaction("read_write")).toBe(false);
    expect(requiresReadOnlyTransaction("full")).toBe(false);
    expect(requiresReadOnlyTransaction("read")).toBe(true);
  });
});

/**
 * ⚠ **THE WIRING, and without it everything above is a correct module nothing
 * calls** — I-120's shape, which a module's own tests can never close.
 *
 * The transaction is the entire reason the registration refusal could be
 * dropped. If `BEGIN READ ONLY` stops being emitted, `access_policy` silently
 * becomes documentation: a screen saying read-only with nothing making it true.
 */
describe("the executor opens the transaction", () => {
  const SRC = new URL("./step-execution.service.ts", import.meta.url);

  it("asks the policy, and asks it about the STORED row", async () => {
    const src = await readFile(SRC, "utf8");
    // Control: the file was found and is the executor.
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("requiresReadOnlyTransaction(");
    // ⚠ Off the datasource ROW, never off the request. `stepBatchSchema` has no
    // field that could reach it, and this is the same rule `envForExecution`
    // follows for `readFrom` (D-52) — nothing in a call may widen its own
    // permissions.
    expect(src).toMatch(/requiresReadOnlyTransaction\(\s*\(datasource as/);
    expect(src).not.toMatch(/requiresReadOnlyTransaction\(\s*input\./);
  });

  /**
   * ⚠ **This asserts the OPENING, positionally, and the first version did not.**
   * It matched `client.query("BEGIN READ ONLY")` anywhere in the file — and the
   * error path restarts the transaction with that same string, so deleting the
   * line that OPENS it left this test green. The single most important control
   * in the feature, and the assertion for it could not fail (I-38). Found by
   * perturbing, not by reading it back.
   *
   * The property is order: the transaction is opened BEFORE the statement loop.
   * Per-statement or after-the-fact leaves the first row unprotected, and a
   * batch that wrote half its rows is the state the policy exists to prevent.
   */
  it("opens the transaction BEFORE the statement loop, on both drivers", async () => {
    const src = await readFile(SRC, "utf8");

    const pgOpen = src.indexOf('if (readOnlyTx) await client.query("BEGIN READ ONLY");');
    const pgLoop = src.indexOf("for (const params of input.params)", pgOpen);
    expect(pgOpen, "postgres never opens a read-only transaction").toBeGreaterThan(-1);
    expect(pgLoop).toBeGreaterThan(pgOpen);

    const myOpen = src.indexOf('conn.query("START TRANSACTION READ ONLY")');
    const myLoop = src.indexOf("for (const params of input.params)", myOpen);
    expect(myOpen, "mysql never opens a read-only transaction").toBeGreaterThan(-1);
    expect(myLoop).toBeGreaterThan(myOpen);

    // The control: both statements are guarded by the policy rather than
    // unconditional, or a `read_write` datasource could never write at all.
    expect(src).toContain('if (readOnlyTx) await conn.query("START TRANSACTION READ ONLY");');
  });

  /**
   * ⚠ A failed statement POISONS a Postgres transaction — every later query
   * answers "current transaction is aborted". Without the restart, the first
   * bad row in a batch turns every remaining row into one repeated error that
   * says nothing about the rows themselves, and the symptom would appear only
   * once the read-only transaction existed — i.e. it would look like the policy
   * breaking the step.
   */
  it("restarts the transaction after a failed statement", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src).toMatch(/ROLLBACK[\s\S]{0,400}BEGIN READ ONLY/);
  });
});
