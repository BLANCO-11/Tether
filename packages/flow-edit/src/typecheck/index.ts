/**
 * The flow type checker — phased-typed-build phase 1. Pure, no I/O (D-240).
 * `checkFlow(model, catalogue)` is the one entry point; see `check.ts`.
 */
export { T as TypeOf, applyOnNull, assignable, convert, render as renderType, tyOfColumn, tyOfParam, enumValuesOfType, TEMPORAL_CONVERSIONS, TIME_UNITS, SECONDS_IN } from "./types.js";
export type { Ty, Scalar, Refinement, Conversion, Assign, Why, TimeUnit, NumUnit } from "./types.js";
export { CODES, diag, renderDiagnostic, sortDiagnostics, didYouMean } from "./diagnostic.js";
export type { Diagnostic, DiagnosticCode, Severity, Owner, Span } from "./diagnostic.js";
export { outputOf, portsOf, rowOf, tyOfFlowInput, isCallStep, pipelineInputType, pipelineType } from "./signature.js";
export { tyOfOutputShape, checkOutputShape } from "./output-shape.js";
export type { OutputShape } from "./output-shape.js";
export type { CatalogueSnapshot, RefSig, PortSig, CheckModel, CheckStep, CheckSource, CheckInput } from "./signature.js";
export { checkFlow, blobDisagreement, isBlankFeed, sameFeed } from "./check.js";
