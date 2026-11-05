/**
 * Re-export of `@foundry/redact`.
 *
 * The implementation moved out of this package in Stage 5, when the tool layer
 * became its own service: `ops-api` writes a call log and needs exactly this
 * function, and `packages/server` still needs it to redact step outputs before a
 * browser sees them (D-07). Two processes, one regex — a copied security control
 * is one that drifts silently, because each copy keeps passing its own tests.
 *
 * This file stays as a re-export rather than being deleted so the ~6 call sites
 * in this package keep their local import path, and so the reason lives where
 * someone following an import will find it. The tests live with the
 * implementation, in `packages/redact`.
 */
export { redactSecrets, redactJsonString, REDACTED } from "@foundry/redact";
