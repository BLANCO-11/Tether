/**
 * Diagnostics — phase 1's output value (plan "Diagnostic shape").
 *
 * One value, two renderings: rustc-style text for prompts and logs, and the
 * value itself as JSON for the UI. The CODE is the stable identity — tests,
 * report counts and retry routing all key on it, never on the message.
 */

/**
 * `hole` (compiled-builder phase 3, D-317): an UNDECIDED site — not an error. A flow with holes is valid and incomplete: it
 * saves as a draft and cannot run or be approved. Anything filtering for `"error"` ignores it by construction.
 */
export type Severity = "error" | "warning" | "hole";
/** Who can fix it — routes a retry to the phase that owns it (D-248). */
export type Owner = "skeleton" | "wiring" | "person";

export interface Span {
  stepId?: string;
  port?: string;
  field?: string;
  inputId?: string;
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  span: Span;
  /** One sentence that names the place. */
  message: string;
  /** The fix. */
  help?: string;
  /** Provenance — what the checker knew that made this true. */
  note?: string;
  owner: Owner;
}

/**
 * Every code the checker can emit, with its default severity and owner.
 * A rule that emits a code not listed here does not compile.
 */
export const CODES = {
  // Shape
  FT0101: { severity: "error", owner: "skeleton", title: "cycle in dependsOn" },
  FT0102: { severity: "error", owner: "skeleton", title: "unknown step" },
  FT0103: { severity: "error", owner: "skeleton", title: "duplicate or malformed id" },
  FT0104: { severity: "warning", owner: "skeleton", title: "output read by nothing" },
  FT0105: { severity: "error", owner: "skeleton", title: "unknown component" },
  FT0106: { severity: "error", owner: "skeleton", title: "flow exceeds a cap" },
  // Binding
  FT0201: { severity: "error", owner: "wiring", title: "required input unbound" },
  FT0202: { severity: "error", owner: "wiring", title: "type mismatch" },
  FT0203: { severity: "error", owner: "wiring", title: "nullable value into a required input" },
  FT0204: { severity: "error", owner: "wiring", title: "undeclared flow input" },
  FT0205: { severity: "warning", owner: "wiring", title: "flow input read by nothing" },
  FT0206: { severity: "error", owner: "wiring", title: "two representations of one step's inputs disagree" },
  FT0207: { severity: "error", owner: "wiring", title: "fan-out over something that is not a list" },
  FT0208: { severity: "error", owner: "wiring", title: "untyped JSON into a typed input" },
  FT0209: { severity: "error", owner: "wiring", title: "binding names an input the component does not have" },
  // Fields
  FT0301: { severity: "error", owner: "wiring", title: "field does not exist upstream" },
  FT0302: { severity: "error", owner: "wiring", title: "field not declared by the upstream step" },
  FT0303: { severity: "error", owner: "wiring", title: "wrong path into a step's output" },
  FT0304: { severity: "warning", owner: "wiring", title: "field read off an undeclared output — unchecked" },
  // Literals
  FT0401: { severity: "error", owner: "wiring", title: "literal is not a valid value for its input" },
  FT0402: { severity: "error", owner: "wiring", title: "literal violates a refinement" },
  FT0403: { severity: "error", owner: "wiring", title: "constructed date a month cannot have" },
  // Data-flow policy
  FT0501: { severity: "error", owner: "wiring", title: "raw rows with timestamps into a call body" },
  FT0502: { severity: "warning", owner: "wiring", title: "llm output consumed downstream" },
  FT0503: { severity: "warning", owner: "person", title: "recipients a draft run will refuse" },
  // Build-time policy (compiled-builder 2e, D-301): a flow the deployment's own policy would refuse is an ERROR here.
  FT0507: { severity: "error", owner: "person", title: "a recipient the deployment refuses" },
  FT0508: { severity: "error", owner: "person", title: "an unattended send with no recipient" },
  FT0509: { severity: "error", owner: "wiring", title: "a fan-out with no bound" },
  // D-242's gradual typing: the same rule on a LEGACY source (a reader, or an \`expr\` transform) is a warning. The new
  // builder never produces that shape (construction rule, phases 3/5); cutover deletes it and this code (D-293).
  FT0510: { severity: "warning", owner: "wiring", title: "a fan-out with no bound (legacy source)" },
  FT0504: { severity: "error", owner: "skeleton", title: "a step that produces nothing is the flow's result" },
  FT0505: { severity: "error", owner: "wiring", title: "text tool fed a description of the data" },
  // Expressions
  FT0601: { severity: "error", owner: "wiring", title: "expression outside the allowlist" },
  FT0602: { severity: "warning", owner: "wiring", title: "hand-written template — unchecked (unsafe)" },
  FT0603: { severity: "error", owner: "wiring", title: "template will not render (serialization)" },
  // Compiler limits
  FT0701: { severity: "error", owner: "skeleton", title: "nested branch" },
  FT0702: { severity: "error", owner: "wiring", title: "merge sources disagree" },
  FT0703: { severity: "error", owner: "skeleton", title: "a loop inside a loop, or an approval inside one" },
  FT0704: { severity: "error", owner: "wiring", title: "a read across a loop's edge" },
  // Holes (compiled-builder phase 3, D-317): an undecided site is not an error; a hole that lies is.
  FT0801: { severity: "hole", owner: "person", title: "undecided" },
  FT0802: { severity: "error", owner: "skeleton", title: "a hole and its site disagree" },
  // Combinators (compiled-builder 2d): a transform pipeline whose stage does not type
  FT0901: { severity: "error", owner: "wiring", title: "combinator does not type" },
  FT0902: { severity: "error", owner: "wiring", title: "combinator reads a step it cannot" },
  // A check that already exists, wrapped (D-249) but not yet mapped to a code
  FT0999: { severity: "error", owner: "wiring", title: "existing check" },
} as const satisfies Record<string, { severity: Severity; owner: Owner; title: string }>;

export type DiagnosticCode = keyof typeof CODES;

export function diag(
  code: DiagnosticCode,
  span: Span,
  message: string,
  extra: { help?: string; note?: string; severity?: Severity } = {},
): Diagnostic {
  const c = CODES[code];
  return {
    code,
    severity: extra.severity ?? c.severity,
    span,
    message,
    ...(extra.help ? { help: extra.help } : {}),
    ...(extra.note ? { note: extra.note } : {}),
    owner: c.owner,
  };
}

function place(s: Span): string {
  const parts = [s.stepId ? `step \`${s.stepId}\`` : "", s.port ? `input \`${s.port}\`` : "", s.field ? `field \`${s.field}\`` : "", s.inputId ? `flow input \`${s.inputId}\`` : ""];
  return parts.filter(Boolean).join(", ") || "flow";
}

/** rustc-style: `error[FT0201]: …` / `  --> step x, input y` / `  = help: …`. */
export function renderDiagnostic(d: Diagnostic): string {
  const lines = [`${d.severity}[${d.code}]: ${d.message}`, `  --> ${place(d.span)}`];
  if (d.note) lines.push(`  = note: ${d.note}`);
  if (d.help) lines.push(`  = help: ${d.help}`);
  return lines.join("\n");
}

/** Errors first, then by step, then code — so a diff between two runs is stable. */
export function sortDiagnostics(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
      (a.span.stepId ?? "").localeCompare(b.span.stepId ?? "") ||
      a.code.localeCompare(b.code),
  );
}

/** The closest candidate by edit distance, when it is close enough to suggest. */
export function didYouMean(word: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
