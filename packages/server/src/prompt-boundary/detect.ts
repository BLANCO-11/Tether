import { describeFamily, matchFamilies } from "./patterns.js";
import type { SpanSource, UntrustedSpan } from "./spans.js";

// T035 — spans in, warnings out (spec US2).
//
// WHAT THIS DELIBERATELY DOES NOT DO: alter anything. The manifest delivered
// alongside a warning is byte-identical to the manifest that would have been
// delivered with detection switched off. Silently stripping matched content
// would violate Article XV, and it would also make the manifest stop describing
// the world — an operator's registered tool would quietly differ from what the
// model was told about it. manifest-builder.service.test.ts asserts the
// byte-identity (invariant W1), because this is the single most likely
// "improvement" a later change makes.

/**
 * Upper bound on warnings returned for one build. A workspace with hundreds of
 * flagged tables must not produce a list so long that operators stop reading it —
 * but the cut is always ANNOUNCED (`truncated`), never silent.
 */
export const WARNING_CAP = 50;

/** Longest excerpt quoted back, so one pathological field cannot flood a response. */
const EXCERPT_MAX = 200;

export interface ManifestWarning {
  source: SpanSource;
  /** The tool or datasource to go and look at. */
  itemName: string;
  field: string;
  /** Which pattern family matched, e.g. "instruction_override". */
  pattern: string;
  /** One line an operator can act on. */
  describes: string;
  /** A bounded excerpt of the RAW value — normalised text would be unfindable. */
  excerpt: string;
}

export interface DetectionResult {
  items: ManifestWarning[];
  /** True when `total` exceeded the cap. Stated, never silent (FR-014). */
  truncated: boolean;
  /** How many warnings there were before capping. */
  total: number;
  cap: number;
}

function excerpt(value: string): string {
  return value.length <= EXCERPT_MAX ? value : `${value.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * Scan spans for injection-indicative content.
 *
 * Never throws. A malformed span is logged with the field that caused it and
 * skipped — a detector fault must not take down manifest building, which is on
 * the path of every generation (Article V, and FR-012's "reports; does not gate").
 */
export function detectInjection(spans: UntrustedSpan[]): DetectionResult {
  const all: ManifestWarning[] = [];

  for (const span of spans) {
    try {
      for (const pattern of matchFamilies(span.value)) {
        all.push({
          source: span.source,
          itemName: span.itemName,
          field: span.field,
          pattern,
          describes: describeFamily(pattern),
          excerpt: excerpt(span.value),
        });
      }
    } catch (e) {
      // Named field, named item: a failure must be diagnosable as itself.
      console.warn(
        `[prompt-boundary] could not scan field '${span?.field}' of '${span?.itemName}': ` +
          `${(e as Error).message}. Continuing — the manifest is unaffected.`,
      );
    }
  }

  return {
    items: all.slice(0, WARNING_CAP),
    truncated: all.length > WARNING_CAP,
    total: all.length,
    cap: WARNING_CAP,
  };
}
