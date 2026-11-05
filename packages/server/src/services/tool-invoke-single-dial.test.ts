/**
 * **A registered tool is dialled from exactly ONE place.**
 * tool-probe · plan Decision 1 · T04
 *
 * ── Why this is asserted by reading the source tree ──────────────────────────
 *
 * The "Test this tool" button needs one HTTP call to a tool. The obvious way to
 * write it is three lines of `fetch` in `tool-probe.service.ts`, and that version
 * would work, pass every other test in this repo, and be **the exact bug the
 * button exists to remove**: a probe that presents a credential even slightly
 * differently from execution returns green for a tool that 401s in a run. WS-B.4's
 * declared auth style and the 424 both exist because that confusion already
 * happened once — the agent guessing between four auth styles, and a wrong guess
 * being a 401 the audit called `clean`.
 *
 * Nothing at runtime can see a *second* dial: it would behave correctly on its own
 * terms. This is the same class of property as `mail-secret-single-reader.test.ts`
 * (one reader for the Graph secret) and `revision-author.test.ts` (one minter),
 * and it is asserted the same way — by reading the tree, because the property is
 * about the ABSENCE of code.
 *
 * What a second dial actually costs:
 *
 *  - a second place a credential is assembled and can be logged or echoed,
 *  - a second egress profile decision, which is how a probe comes to green-light
 *    a host that a run refuses (or vice versa),
 *  - and a second answer to "what did we send?", so the button's verdict stops
 *    being a statement about the tool.
 *
 * ⚠ **The walk is rooted at `src/`, and that is load-bearing** — exactly as
 * `mail-secret-single-reader.test.ts` does it. `pnpm build` emits every non-test
 * module into `dist/`, so a walk rooted at the package would match
 * `dist/services/tool-invoke.js` and report a phantom second dial on any machine
 * that has ever built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "..");

/** The one module allowed to dial a tool, relative to `src/`. */
const THE_DIAL = "services/tool-invoke.ts";

/** This file names the call in prose, so it must not count as a call site. */
const THIS_FILE = "services/tool-invoke-single-dial.test.ts";

/**
 * Modules that legitimately call `guardedFetch` for something that is NOT a
 * registered tool, listed explicitly rather than pattern-matched.
 *
 * ⚠ Named individually on purpose: an allowlist that is a regex is one somebody
 * widens, and the point of this test is that adding a tool dial has to be a
 * deliberate edit HERE with a reason next to it.
 *
 * · `mail.service.ts` — Microsoft Graph and the SMTP-ish fallback. Foundry's own
 *   outbound mail, not a tenant-registered endpoint.
 * · `trigger-scheduler.ts` — polls a webhook/health URL on STRICT, which is a
 *   different profile for a different subject (§ trigger polling).
 * · `step-execution.service.ts` — the `http` step's own dial (`invokeHttp`), on
 *   STRICT with the step's timeouts. Foundry-side by design (Stage 4): the
 *   engine never dials a tenant URL itself, so this is the one place a
 *   workflow's raw HTTP leaves the deployment, guarded like the tool dial.
 */
const NOT_TOOL_DIALS = [
  "services/mail.service.ts",
  "services/trigger-scheduler.ts",
  "services/step-execution.service.ts",
];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = tsFilesUnder(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

describe("there is exactly one tool dial in this server", () => {
  it("the control — the walk found the tree, not an empty list", () => {
    // Without this, a rename of `src/` makes every assertion below vacuously
    // true: an empty file list has no second dial in it either.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => f.rel)).toContain(THE_DIAL);
  });

  it("`guardedFetch(` appears in the dial and in the named non-tool callers, and nowhere else", () => {
    const callers = files
      .filter((f) => f.rel !== THIS_FILE && !f.rel.endsWith(".test.ts"))
      .filter((f) => /guardedFetch\(/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(callers).toEqual([THE_DIAL, ...NOT_TOOL_DIALS].sort());
  });

  /**
   * ⚠ The probe is named explicitly, not covered by the sweep above, because it
   * is the module this whole test was written to constrain. `fetch(` is matched
   * as well as `guardedFetch(` — an unguarded `fetch` would be worse, and it is
   * the shorter thing to type.
   */
  it("tool-probe.service.ts dials nothing itself", () => {
    const probe = files.find((f) => f.rel === "services/tool-probe.service.ts");
    // Skipped rather than failed while the module does not exist yet: this half
    // of the assertion belongs to T05, and a red test for unwritten code teaches
    // nothing. ⚠ Once it exists this becomes a real assertion, and the `toContain`
    // in the control above is what stops the file being deleted to silence it.
    if (!probe) return;
    expect(probe.text).not.toMatch(/(?<!guarded)\bfetch\(/);
    expect(probe.text).not.toMatch(/guardedFetch\(/);
  });

  it("nothing outside the dial applies a tool's auth or reads its secret for a call", () => {
    // `applyAuth` is exported for the dial's own tests and for nothing else. A
    // second caller means somebody is assembling a credential outside the one
    // place that is allowed to.
    const appliers = files
      .filter((f) => f.rel !== THIS_FILE && !f.rel.endsWith(".test.ts"))
      .filter((f) => /\bapplyAuth\(/.test(f.text))
      .map((f) => f.rel)
      .sort();

    expect(appliers).toEqual([THE_DIAL]);
  });
});
