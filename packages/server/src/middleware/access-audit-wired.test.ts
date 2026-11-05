import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * ⚠ **THE DETECTOR'S OWN TESTS CANNOT CLOSE THIS GAP — ONLY A CALL SITE CAN.**
 *
 * `accessAuditService.recordDenial` was correct, tested, and **called by nothing**. That
 * is I-120's exact shape, and this repo has now met it at least four times:
 *
 *   - `shadowedSecretCollisions` lived in `resolveForExecution`, whose only production
 *     caller was the audit — so the collision refusal was a number nothing acted on.
 *   - the prompt-boundary detector's `warnings` were computed by `buildAndPersist` and
 *     dropped by every caller.
 *   - `more` was declared on the chat turn schema, defaulted, and read by nothing, so
 *     nobody was ever asked again.
 *   - and this.
 *
 * In every case the check passed its own tests, and **no behaviour anywhere depended on
 * the answer** — which is precisely what makes it invisible when it stops being true.
 *
 * So this test reads the middleware off disk and requires the call. It is the same idiom
 * as `TETHER_API_KEY`-in-three-files and `shadowedSecretCollisions`-in-`invokeTool`.
 */

const GUARDS = {
  "require-permission.middleware.ts": "src/middleware/require-permission.middleware.ts",
  "platform-permission.middleware.ts": "src/middleware/platform-permission.middleware.ts",
} as const;

function read(rel: string): string {
  return readFileSync(rel, "utf8");
}

/**
 * ⚠ **STRIP THE COMMENTS BEFORE SCANNING FOR A FORBIDDEN READ.**
 *
 * The call site's own comment says *"the DECLARED path, never `req.originalUrl`"* —
 * inside the object literal, because that is where the reason belongs. A scan over the
 * raw text flags that explanation, which is I-62 for the fourth time in this feature: a
 * guard that cries wolf gets widened, and the widening is what permits the defect. The
 * subject is the CODE, so the comments come out first.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("T096: the denial recorder is actually CALLED", () => {
  it("CONTROL: the scan can find these files and they are the ones we mean", () => {
    // Without this, a renamed or moved file reads as an empty string and every assertion
    // below passes over nothing — which is the failure mode the whole file is about.
    for (const [name, rel] of Object.entries(GUARDS)) {
      const src = read(rel);
      expect(src.length, `${name} read as empty`).toBeGreaterThan(1000);
      expect(src, `${name} is not a permission guard`).toMatch(/403/);
    }
  });

  it("both guards call recordDenial on the refusal path", () => {
    for (const [name, rel] of Object.entries(GUARDS)) {
      const src = read(rel);
      expect(src, `${name} does not record its refusals`).toMatch(
        /accessAuditService\.recordDenial\(/,
      );
    }
  });

  it("⚠ it is UNAWAITED, so bookkeeping cannot add latency to a refusal", () => {
    for (const [name, rel] of Object.entries(GUARDS)) {
      const src = read(rel);
      expect(src, `${name} awaits the audit write on the refusal path`).toMatch(
        /void accessAuditService\.recordDenial\(/,
      );
      expect(src, `${name} awaits the audit write`).not.toMatch(
        /await accessAuditService\.recordDenial\(/,
      );
    }
  });

  /**
   * ⚠ FR-034 at the CALL SITE, not only in the recorder.
   *
   * `req.originalUrl` carries resolved ids and the query string — request content, which
   * is not ours to keep. The declared route path (`req.route.path`) names the shape of
   * the request and never its contents.
   */
  it("records the DECLARED route, never the request's own URL or body", () => {
    for (const [name, rel] of Object.entries(GUARDS)) {
      const src = read(rel);
      // ⚠ **BOUND THE SLICE TO THE CALL ITSELF.** A fixed 500-character window ran past
      // the closing brace into the comment that EXPLAINS why `req.originalUrl` must not
      // be recorded — and flagged the explanation. I-62 for the fourth time in this
      // feature: state the forbidden thing, not a pattern that resembles it.
      const code = codeOnly(src);
      const start = code.indexOf("recordDenial({");
      expect(start, `${name}: no recordDenial call in the code`).toBeGreaterThan(-1);
      const call = code.slice(start, code.indexOf("});", start) + 3);
      expect(call.length, `${name}: could not isolate the call`).toBeLessThan(400);
      expect(call, `${name} records the raw URL`).not.toMatch(/originalUrl/);
      expect(call, `${name} records the request body`).not.toMatch(/req\.body/);
      expect(call, `${name} records the query string`).not.toMatch(/req\.query/);
      expect(call, `${name} does not record a route at all`).toMatch(/req\.route/);
    }
  });

  it("the workspace guard records the workspace; the platform guard records none", () => {
    const wsSrc = read(GUARDS["require-permission.middleware.ts"]);
    const platSrc = read(GUARDS["platform-permission.middleware.ts"]);
    expect(wsSrc.slice(wsSrc.indexOf("recordDenial({"), wsSrc.indexOf("recordDenial({") + 300)).toMatch(
      /workspaceId,/,
    );
    // ⚠ A deployment-level refusal has no workspace to belong to, so it goes to the
    // platform store. `null` is the routing decision, not an omission.
    expect(
      platSrc.slice(platSrc.indexOf("recordDenial({"), platSrc.indexOf("recordDenial({") + 300),
    ).toMatch(/workspaceId: null,/);
  });
});
