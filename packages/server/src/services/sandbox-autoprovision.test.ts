/**
 * The automatic sandbox build, and the four things it must refuse.
 *
 * -----------------------------------------------------------------------------
 * WARNING: THE DECISION THIS FILE PINS IS A READING OF ANOTHER FILE'S DOCBLOCK
 * -----------------------------------------------------------------------------
 *
 * `sandbox/cli.ts` says provisioning is a command and not a button, because it
 * "generates rows with a model (minutes), drops and recreates a database, and
 * creates a login role" -- the shape of the deleted `POST /api/demo/provision`.
 *
 * The reading taken is that the objection is to **re-provisioning**: the danger
 * named is destructiveness, and at onboarding there is nothing to destroy.
 * `already_has_fixture` is the assertion that keeps that reading honest. If it
 * ever stops firing, this module IS the thing that docblock forbids, and the
 * argument for it collapses -- so it is tested before anything else here.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { MAX_AUTO_TABLES } from "./sandbox-autoprovision.service.js";

const SRC = new URL("./sandbox-autoprovision.service.ts", import.meta.url);

/**
 * Source with comments removed.
 *
 * ⚠ **I-62, and it fired on the first run of the two tests below.** Both scan
 * for a forbidden string, and the docblock EXPLAINING why it is forbidden
 * quotes it verbatim — so the guard flagged the comment that exists to stop the
 * defect. CLAUDE.md records this happening four times in one feature, every
 * time on an explanatory comment: **a well-commented control is the single most
 * likely thing to trip its own guard, because the comment and the violation say
 * the same words.** Match a USE, or strip comments first. This is the second.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}


describe("the automatic build refuses what stays a command", () => {
  it("refuses when a fixture already exists — this is the whole argument", async () => {
    const src = await readFile(SRC, "utf8");
    // The control: a renamed or moved file reads as "" and every assertion
    // below would pass over nothing (I-38).
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("provisionIfAbsent");
    // The refusal, and that it is decided from the fixture table rather than
    // from the datasource row's own sandbox pointer -- a fixture can exist
    // while `sandbox_dsn_enc` is null (a materialisation that failed after the
    // freeze), and re-generating over it is exactly the destructive case.
    expect(src).toMatch(/from\(datasourceFixtures\)[\s\S]{0,400}already_has_fixture/);
  });

  it("refuses a non-postgres datasource by name rather than attempting it", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src).toMatch(/ds\.type !== "postgres"[\s\S]{0,120}not_postgres/);
  });

  it("caps tables, and REFUSES rather than truncating", async () => {
    // A fixture covering some of a schema is a sandbox whose missing tables
    // read as empty -- a wrong answer that looks like a right one. The cap must
    // stop the build, never shrink it.
    const src = await readFile(SRC, "utf8");
    expect(MAX_AUTO_TABLES).toBeGreaterThan(0);
    // ⚠ The first version of this asserted only that the string
    // "too_many_tables" appeared somewhere, and PASSED with the `return`
    // deleted — the string survived in the message and the row update. A
    // control that cannot fail is worse than none (I-38), found by
    // perturbation. What is required is that the cap RETURNS.
    expect(src).toMatch(/return \{ started: false, why: "too_many_tables"/);
    expect(src).not.toMatch(/\.slice\(0,\s*MAX_AUTO_TABLES\)/);
    // And that nothing starts a build after the cap has been hit: the refusal
    // must sit above `inFlight.add`, not beside it.
    expect(src.indexOf('why: "too_many_tables"')).toBeLessThan(src.indexOf("inFlight.add(key)"));
  });

  it("never lets a build failure reach the caller", async () => {
    // `refreshSchema` is the onboarding wizard's blocking call. A sandbox
    // problem must not turn a successful introspection into a failed one.
    const ds = await readFile(new URL("./datasource.service.ts", import.meta.url), "utf8");
    expect(ds.length).toBeGreaterThan(2000);
    expect(ds).toMatch(/void provisionIfAbsent\([^)]*\)\.catch\(/);
    // And it is hooked to introspection, not creation: a fixture is generated
    // from the introspected shape, so `create` is too early to have one.
    const i = ds.indexOf("void provisionIfAbsent");
    expect(ds.lastIndexOf("async refreshSchema", i)).toBeGreaterThan(-1);
    expect(ds.slice(0, i)).not.toContain("async create(\n    workspaceId: string,\n    input: z.infer<typeof createDatasourceInputSchema>,\n  ): Promise<never>");
  });
});

/**
 * WARNING: **`failed` MUST NOT SATISFY `hasSandbox`.** This is the property that
 * makes an automatic build safe to add at all: it can move a datasource from
 * "reads production" to "reads fixtures" and never the other way, and it can
 * never claim to have got there. `hasSandbox` is computed from the DSN and the
 * fixture, and the build status is reported BESIDE it -- if the two are ever
 * merged, a failed build starts reading as a working sandbox.
 */
describe("a failed build does not become a sandbox", () => {
  it("hasSandbox is computed from the dsn and the fixture, never from buildStatus", async () => {
    const src = await readFile(new URL("./sandbox.service.ts", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("const hasSandbox = !!ds.sandboxDsnEnc && !!fixture;");
    expect(src).not.toMatch(/hasSandbox\s*=[^;]*sandboxBuildStatus/);
  });

  it("the exposure sentence is still emitted whenever hasSandbox is false", async () => {
    // It is what tells a person a draft run reads production. A build that
    // failed must not suppress it -- that would be the one state where the
    // warning is most needed and least present.
    const src = await readFile(new URL("./sandbox.service.ts", import.meta.url), "utf8");
    expect(src).toMatch(/exposure: hasSandbox\s*\n?\s*\?\s*null/);
  });
});

/**
 * A build that did not survive a restart must stop claiming it is running.
 *
 * ── ⚠ The measured defect, 2026-09-17 ───────────────────────────────────────
 *
 * Three datasources on this deployment had read **`building`** for **seven
 * days** against a panel that says "around two minutes":
 *
 *     hiring_demo · orders_demo · support_demo — started 2026-09-09 17:26
 *
 * A build is a detached promise in the API process, so a restart ends every one
 * in flight and leaves its row claiming otherwise. There was no timeout, no
 * heartbeat and no owner, and `sandboxBuildStartedAt` was written and read by
 * NOTHING — I-120's shape in the one place that could have noticed.
 *
 * These read the source rather than a database, in this file's own idiom, with
 * a control so a renamed file cannot pass as an empty string.
 */
describe("an abandoned build is reconciled at boot", () => {
  it("marks every `building` row failed, with a reason, and never NULL", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("export async function reconcileAbandonedBuilds");
    // ⚠ Comments stripped, because these are proximity matches and a docblock
    // between the two halves pushes them apart. The first version used a
    // 1200-character window and went red the moment the function gained one —
    // a test that fails when somebody EXPLAINS the code is a tax on writing it
    // down. The property is the code's shape, so measure the code.
    const code = stripComments(src);
    // ⚠ `failed`, never null. Null is "nobody ever asked" and would erase the
    // fact that somebody did; the panel renders the two differently.
    expect(code).toMatch(
      /reconcileAbandonedBuilds[\s\S]{0,600}sandboxBuildStatus: "failed"[\s\S]{0,600}eq\(datasources\.sandboxBuildStatus, "building"\)/,
    );
    // And the reason says what happened, rather than "unknown".
    expect(code).toMatch(/reconcileAbandonedBuilds[\s\S]{0,800}server restarted/);
  });

  /**
   * ⚠ **NO ANGLE-BRACKET PLACEHOLDER IN A MESSAGE A PERSON IS MEANT TO ACT ON.**
   *
   * This reason shipped ending `--workspace=<id> --datasource=<name>`, and it
   * was reported from the datasource page the same day. It is the mistake
   * already recorded against the chat prompt that emitted the literal ref
   * `hr_demo.<reader for approved leave requests by period>` — a template reads
   * as text to copy, and somebody copies it.
   *
   * ⚠ Scoped to messages, NOT to the file: TypeScript generics and JSX are full
   * of angle brackets, and a file-wide ban would fire on `Promise<number>`. A
   * guard that cries wolf gets widened until the widening permits the defect
   * (I-62) — so this matches the assigned string literals only.
   */
  it("no build message hands a person a placeholder to copy", async () => {
    const code = stripComments(await readFile(SRC, "utf8"));
    // ⚠ Every string LITERAL, not just the ones assigned to `sandboxBuildError`
    // — the first version tried to match that assignment and its non-greedy
    // tail ran past the short `sandboxBuildError: detail` sites and swallowed
    // code. Literals are unambiguous, and the ban is true of every message this
    // module produces, the console.warn included.
    const literals = [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    // Control: there are strings to check at all, so this cannot pass over none.
    expect(literals.length).toBeGreaterThan(10);
    expect(literals.some((l) => l.includes("server restarted"))).toBe(true);
    for (const l of literals) expect(l).not.toMatch(/<[a-z][a-z ]*>/i);
  });

  /**
   * ⚠ **ONE command on the panel, and it is the RESOLVED one.** `exposure` is
   * built per datasource with the real workspace id and name, and it renders
   * below this reason whenever `hasSandbox` is false — which is always, since
   * `failed` does not satisfy it. A command here would be a second answer to
   * "how do I fix this", and it would be the one that cannot interpolate.
   */
  it("the reason carries no provision command — `exposure` owns that", async () => {
    const code = stripComments(await readFile(SRC, "utf8"));
    const reason = code.slice(code.indexOf("export async function reconcileAbandonedBuilds"));
    expect(reason).not.toContain("sandbox:provision --workspace");
    // The control: `exposure` really does carry it, resolved.
    const sandbox = await readFile(new URL("./sandbox.service.ts", import.meta.url), "utf8");
    expect(sandbox).toMatch(/sandbox:provision \` \+\n\s*\`--workspace=\$\{workspaceId\}/);
  });

  /**
   * ⚠ **It must NOT consult `inFlight`, and that is not an oversight.** Its
   * correctness rests on running at a moment when `inFlight` is empty by
   * construction — process start. A version that filtered on it would be
   * asking a question whose answer is always "no" and reading that as proof.
   * A version that ran anywhere else would shoot a live build in the head.
   */
  it("is called from the API entry point and nowhere else", async () => {
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(index.length).toBeGreaterThan(500);
    expect(index).toMatch(/void reconcileAbandonedBuilds\(\)\.catch\(/);

    // ⚠ Not in `createApp`: every kestra:*/demo:*/scenarios:* harness imports
    // the services directly and never runs `index.ts`. One of those booting
    // beside a live server must not mark that server's build abandoned.
    const app = await readFile(new URL("../app.ts", import.meta.url), "utf8");
    expect(app.length).toBeGreaterThan(500);
    expect(app).not.toContain("reconcileAbandonedBuilds");
  });

  /**
   * ⚠ CONTROL — without it the two assertions above pass against a build that
   * can never be reconciled because nothing ever writes `building` in the first
   * place. The state has to be reachable for clearing it to mean anything.
   */
  it("CONTROL: `building` is genuinely written by the start path", async () => {
    const src = await readFile(SRC, "utf8");
    expect(src).toMatch(/sandboxBuildStatus: "building"[\s\S]{0,200}sandboxBuildStartedAt: new Date\(\)/);
  });
});
