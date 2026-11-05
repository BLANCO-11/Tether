/**
 * ⚠ **EVERY ROUTE HANDLER THAT AWAITS MUST BE WRAPPED IN `asyncHandler`.**
 *
 * Found by running, 2026-09-06, not by reading. A UAT lifecycle probe issued
 * `GET /workspaces/:ws/flow-executions/undefined` — the sort of URL a client
 * produces when a value it expected is missing — and Postgres refused the uuid
 * with `22P02`. On a BARE `async (req, res) => …` handler, Express 4 does not
 * catch a rejected promise, so it surfaced as an unhandled rejection and **Node
 * 22 exited the process**. The API server went down and restarted; the next
 * request was served by a fresh process, which is exactly why it reads as a
 * network blip rather than as a crash.
 *
 * ⚠ **`middleware/error.middleware.ts` was NOT missing the branch.** F5 added a
 * `22P02 → 400` branch and it works — the same malformed id on `routes/catalogue.ts`
 * returned a clean 400 in the same log. The branch simply cannot run for a
 * handler whose rejection never reaches Express. **A correct middleware nothing
 * routes to is I-120's shape**, and the four `routes/steps.ts` callbacks were the
 * sharpest instance: `fail()` deliberately RETHROWS anything that is not a
 * `StepError`, which is right only if something catches it. Nothing did.
 *
 * The three routes that crashed were the whole run-visibility surface, plus
 * `POST /executions/begin` — which every execution calls — and the four step
 * callbacks Kestra hits during every run.
 *
 * ⚠ **This is a source scan, and it needs its control.** A renamed directory
 * read as an empty list would pass an `expect([]).toEqual([])` for ever, so the
 * count of files and the count of handlers found are both asserted.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * A bare async request handler — one whose rejection reaches no `next`.
 *
 * ⚠ **THE FIRST VERSION OF THIS PATTERN HAD A FALSE NEGATIVE THAT LET THE SAME
 * OUTAGE HAPPEN AGAIN, TWO DAYS LATER.** It was
 * `\.(get|post|…)\(\s*"[^"]*",\s*async \(` — a verb, a path, then `async (`
 * IMMEDIATELY. So it saw `.get("/x", async (req, res) => …)` and was blind to
 * `.get("/", requireIdentity, async (req, res) => …)`, i.e. to **every route
 * with a middleware between its path and its handler** — which is most
 * authenticated routes in the product. `routes/me.ts` was one, and on
 * 2026-09-08 `GET /api/me?workspaceId=ws_it` exited the process fifteen times
 * while these three assertions stayed green.
 *
 * ⚠ It was also blind to **middleware**, which is not declared with a verb and a
 * path at all. Four were bare async — `resolveIdentity`, `requireStepToken`,
 * `provenanceGate`, `selfDecisionGate` — and `resolveIdentity` runs on every
 * request that presents an identity.
 *
 * So the pattern no longer looks for the declaration; it looks for **the
 * handler signature** — `async (req` / `async function x(req` — and asks only
 * whether `asyncHandler(` sits immediately before it. That is the property, and
 * it does not care how the handler is registered.
 */
const HANDLER = /\basync\s*(?:function\s+\w+\s*)?\(\s*(?:_?req)\b/g;
/** Any handler at all, wrapped or not — the control's denominator. */
const ANY = /\.(get|post|put|patch|delete)\(\s*\n?\s*"[^"]*",/g;

/**
 * ⚠ **`src/middleware` IS SCANNED TOO.** It was not, and four bare async
 * middlewares were the result — see `HANDLER`'s note. A middleware's rejection
 * exits the process exactly as a route's does.
 */
const MW = fileURLToPath(new URL("../middleware/", import.meta.url));
const files = [
  ...readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => DIR + f),
  ...readdirSync(MW)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    // `error.middleware.ts` DEFINES the wrapper and `async-routes.ts` is the
    // runtime guard; neither is a handler and neither can wrap itself.
    .filter((f) => f !== "error.middleware.ts" && f !== "async-routes.ts")
    .map((f) => MW + f),
];

describe("route handlers are wrapped", () => {
  it("has route files to scan at all", () => {
    // The control. Without it every assertion below passes over nothing.
    expect(files.length).toBeGreaterThan(10);
  });

  it("finds handlers, so the pattern still matches this codebase's style", () => {
    // The second control, and the one that matters: if a refactor changed how
    // routes are declared, `BARE` would find nothing and this file would go on
    // reporting success about a check that had stopped looking.
    const total = files.reduce(
      (n, f) => n + [...readFileSync(f, "utf8").matchAll(ANY)].length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  it("finds handler signatures, so HANDLER still matches this codebase", () => {
    // ⚠ The third control, and the one the OLD pattern needed and did not have:
    // it counted route DECLARATIONS, which stayed plentiful while the pattern
    // that mattered matched almost nothing. This counts what is actually
    // asserted on.
    const total = files.reduce(
      (n, f) => n + [...readFileSync(f, "utf8").matchAll(HANDLER)].length,
      0,
    );
    expect(total).toBeGreaterThan(100);
  });

  it("has NO bare async handler — an unhandled rejection exits the process", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(HANDLER)) {
        // Wrapped iff `asyncHandler(` sits immediately before the signature.
        if (/asyncHandler\($/.test(src.slice(Math.max(0, m.index! - 14), m.index!))) continue;
        offenders.push(
          `${f.slice(f.lastIndexOf("/") + 1)}:${src.slice(0, m.index).split("\n").length}  ${m[0].trim()}`,
        );
      }
    }
    expect(
      offenders,
      "wrap these in asyncHandler(...) — a rejected promise in a bare handler is " +
        "an unhandled rejection, and Node exits on one:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });
});
