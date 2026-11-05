/**
 * The `/llm/*` transport bound — the ladder rung found MISSING while implementing
 * `specs/20260819-045902-step-payload-bounds`.
 *
 * ── What was broken, and why nothing noticed ────────────────────────────────
 *
 * That feature raised Foundry's step-callback cap to 5 MB on one thesis: a coarse
 * transport limit must never fire where a specific per-parameter limit has
 * something useful to say. The specific limit it was clearing the way for is
 * `maxInputChars` — *"input is N characters; the limit is 32,000. Summarise or
 * filter upstream — this step is a text transformer, not a bulk reader."*
 *
 * But this service parsed every body at **1 MB**, and its last-resort handler
 * answered body-parser's 413 as `500 {"code":"internal"}`. So:
 *
 *   input ≤ 32,000 chars      → works
 *   32 KB … 1 MB              → the 422, correctly
 *   **1 MB … 5 MB**           → **500 internal** — the ladder broken one hop on,
 *                               and worse than a 413, because a 500 tells the
 *                               caller the fault is ours
 *   > 5 MB                    → Foundry's own 413
 *
 * Measured at the wire on 2026-08-19 before the fix (4 MB body → `500
 * {"code":"internal"}`) and after (4 MB body → `422 "input is 4000000
 * characters; the limit is 32000…"`).
 *
 * ⚠ **Why these are config assertions and not request tests.** `index.ts` calls
 * `app.listen` at module scope, so the app cannot be imported without binding a
 * port — there is no `createApp()` to exercise here, and inventing one is a
 * refactor of a service this feature had no business restructuring. So the
 * property that can silently rot is pinned instead: the ORDERING of the caps.
 * The wire behaviour itself is verified by the phase gate in
 * `specs/20260819-045902-step-payload-bounds/tasks.md`.
 */
import { describe, it, expect } from "vitest";
import { config } from "./config.js";

/**
 * Foundry's `STEP_CALLBACK_MAX_BYTES` default.
 *
 * ⚠ Duplicated as a literal, deliberately. `packages/ops-api` has no dependency
 * on `@foundry/server` and must not gain one — ops-api is a service across a
 * port, not a library (D-33), and the whole point of the boundary is that this
 * process holds no control-plane code. The duplication is the lesser evil, and
 * it is the *direction* of the inequality below that matters rather than either
 * number: if Foundry's cap is raised above this one, the 1 MB … 5 MB hole
 * reopens, and the only symptom is a 413 where a 422 belonged.
 */
const FOUNDRY_STEP_CALLBACK_MAX_BYTES = 5_242_880;

describe("the /llm/* body cap keeps the 422 reachable", () => {
  it("accepts at least everything Foundry is willing to forward", () => {
    // ⚠ If this goes red, do not lower Foundry's cap to match — raise this one.
    // The 422 naming both numbers is the message worth protecting.
    expect(config.llm.maxBodyBytes).toBeGreaterThanOrEqual(FOUNDRY_STEP_CALLBACK_MAX_BYTES);
  });

  /**
   * The transport bound must sit well above the semantic one, or `maxInputChars`
   * is unreachable for exactly the inputs it exists to describe. ×4 is the
   * headroom for UTF-8 bytes per character plus the JSON envelope.
   */
  it("sits far above the character cap it is protecting", () => {
    expect(config.llm.maxBodyBytes).toBeGreaterThan(config.llm.maxInputChars * 4);
  });

  it("the character cap is still the tightest rung in the ladder", () => {
    // It is the bound worth designing to; every other cap is a backstop.
    expect(config.llm.maxInputChars).toBeLessThan(config.llm.maxBodyBytes);
    expect(config.llm.maxInstructionChars).toBeLessThan(config.llm.maxInputChars);
  });
});
