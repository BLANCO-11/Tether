/**
 * Request Policy Engine (V8 — research.md Decision 5).
 *
 * Ported near-verbatim from `origin/krt/guardrail_validation`'s
 * `packages/shared/src/request-policy/`. Genuinely domain-agnostic: its only
 * inputs are `{ task: string }` and a plain-data `PolicyConfig`, with no
 * reference to script generation or any product-shape concept unique to the
 * source branch. `evaluatePolicy` is the one entry point both
 * `packages/server`'s `request-policy.service.ts` and any future client-side
 * caller must use identically (FR-018).
 */
export * from "./evidence.js";
export * from "./config.js";
export * from "./rules.js";
export * from "./transform.js";
export * from "./combinator.js";
