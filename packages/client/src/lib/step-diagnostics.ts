// src/lib/step-diagnostics.ts — the server's type-checker diagnostics, grouped
// by the step they are ON. Phase 2 (enforcement) of the typed build.
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// Every checker error now refuses a save, and a refusal that names a step in a
// sentence makes the person do the matching by eye — the same work the canvas
// `flag` was added to remove. This module turns both shapes the checker's
// answer arrives in into ONE map a canvas can paint from:
//
//   1. a direct save refused 400 → `FoundryApiError.diagnostics`, structured
//      `{ code, severity, span: { stepId?, port?, field? }, message, help? }`;
//   2. a canvas/authored generation job that FAILED → `findings: string[]`,
//      where each type error is ONE LINE in the server's `diagnosticLine`
//      format: `FT0202 send.to: <message> — help: <help>`.
//
// ⚠ Both inputs are `unknown` on purpose (see `FoundryApiError.findings`): the
// shape is the SERVER's contract, so it is narrowed here, where it is read, and
// anything this client guessed wrong is dropped rather than rendered empty.
//
// ⚠ The line format is a COUPLING, stated as one: it is
// `packages/server/src/services/flow-typecheck.ts`'s `diagnosticLine`. The
// regex is strict — an `FTxxxx` code at the very start — so the plain-prose
// findings that share the array (caps, refs, the redraft loop) never match and
// are left for the findings list to render as they always have.
//
// ⚠ It NEVER throws. It is read on a failure path, and a crash there would
// replace the most useful diagnosis on the screen with a blank one.

export type StepDiagnostic = {
  code: string;
  port?: string;
  message: string;
  help?: string;
  severity: "error" | "warning" | "hole";
};

/** The key a diagnostic with no step goes under — it is about the whole flow. */
export const FLOW_WIDE = "";

/**
 * `${code}${at ? " " + at : ""}: ${message}${help ? " — help: " + help : ""}`,
 * with `at = [stepId, port].join(".")`. Anchored at both ends; the message is
 * lazy so a trailing ` — help: ` is split off rather than swallowed.
 */
const LINE = /^(FT\d{4})(?: ([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?)?: (.*?)(?: — help: (.*))?$/;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function push(out: Map<string, StepDiagnostic[]>, stepId: string, d: StepDiagnostic) {
  const at = out.get(stepId);
  if (at) at.push(d);
  else out.set(stepId, [d]);
}

/** One structured diagnostic, or null when it cannot be read as one. */
function fromStructured(raw: unknown): { stepId: string; d: StepDiagnostic } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { code?: unknown; severity?: unknown; span?: unknown; message?: unknown; help?: unknown };
  if (!nonEmpty(o.code) || !nonEmpty(o.message)) return null;
  const span = o.span && typeof o.span === "object" ? (o.span as { stepId?: unknown; port?: unknown }) : {};
  return {
    stepId: nonEmpty(span.stepId) ? span.stepId : FLOW_WIDE,
    d: {
      code: o.code,
      message: o.message,
      // ⚠ Anything that is not literally "warning" is an error. The server
      // refuses on errors only, so an unreadable severity on a refusal is far
      // more likely to be the reason than not — reading it as a warning would
      // soften the one badge that explains why the save failed.
      // A `hole` is kept as one (compiled-builder D-317): an undecided site is not a fault, and painting it as an error
      // would say a flow is broken when it is only unfinished.
      severity: o.severity === "warning" ? "warning" : o.severity === "hole" ? "hole" : "error",
      ...(nonEmpty(span.port) ? { port: span.port } : {}),
      ...(nonEmpty(o.help) ? { help: o.help } : {}),
    },
  };
}

/** One `diagnosticLine` finding, or null for prose (and anything else). */
function fromLine(raw: unknown): { stepId: string; d: StepDiagnostic } | null {
  if (typeof raw !== "string") return null;
  const m = LINE.exec(raw.trim());
  if (!m || !nonEmpty(m[4])) return null;
  return {
    stepId: m[2] ?? FLOW_WIDE,
    d: {
      code: m[1]!,
      message: m[4],
      // A finding line is only ever produced from a BLOCKING diagnostic.
      severity: "error",
      ...(m[3] ? { port: m[3] } : {}),
      ...(nonEmpty(m[5]) ? { help: m[5] } : {}),
    },
  };
}

/**
 * The checker's diagnostics by step id; flow-wide ones under `FLOW_WIDE` ("").
 *
 * ⚠ Structured diagnostics WIN when present. A 400 carries both (the
 * structured list AND the same lines joined into `message`), and reading both
 * would double every badge's count.
 */
export function diagnosticsByStep(input: { diagnostics?: unknown; findings?: unknown }): Map<string, StepDiagnostic[]> {
  const out = new Map<string, StepDiagnostic[]>();
  try {
    const structured = Array.isArray(input?.diagnostics) ? input.diagnostics : [];
    for (const raw of structured) {
      const r = fromStructured(raw);
      if (r) push(out, r.stepId, r.d);
    }
    if (out.size > 0) return out;
    const findings = Array.isArray(input?.findings) ? input.findings : [];
    for (const raw of findings) {
      const r = fromLine(raw);
      if (r) push(out, r.stepId, r.d);
    }
  } catch {
    /* never throw on a failure path — see the header */
  }
  return out;
}

/**
 * The short word the canvas puts beside a step's badge: `FT0202`, or
 * `FT0202 +1` when there are more. A count alone would be colour-only in all
 * but name; the code is the thing a person can look up.
 */
export function typeErrorBadge(list: readonly StepDiagnostic[]): string {
  const first = list[0];
  if (!first) return "";
  return list.length > 1 ? `${first.code} +${list.length - 1}` : first.code;
}

/** The hover/accessible text: every diagnostic on the step, one per line. */
export function typeErrorTitle(list: readonly StepDiagnostic[]): string {
  return list
    .map((d) => `${d.code}${d.port ? ` ${d.port}` : ""}: ${d.message}${d.help ? ` — ${d.help}` : ""}`)
    .join("\n");
}
