/**
 * V8 — independent evidence-producing rules (FR-004, FR-005). Each rule reads
 * only the request and the config; none reads another rule's output, and
 * none returns a decision. `capability` is static per-rule metadata the
 * combinator reads instead of special-casing a rule by name (FR-007).
 */
import type { Evidence, ResolvedRequest, RuleCapability } from "./evidence.js";
import type { PolicyConfig } from "./config.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  // Word-ish boundary so "like" doesn't match inside "Likert", "similar" doesn't
  // match "similarity" incorrectly for a single-token phrase; multi-word
  // phrases just need substring containment with surrounding non-letters.
  const re = new RegExp(`(^|[^a-z])${escapeRegExp(phrase)}([^a-z]|$)`, "i");
  return re.test(haystack);
}

/** Rule: does the request name a cataloged product (by name or alias)? capability: cannot reject alone (FR-013). */
export const productReference = {
  name: "productReference",
  capability: { name: "productReference", canRejectAlone: false } as RuleCapability,
  evaluate(request: ResolvedRequest, config: PolicyConfig): Evidence[] {
    const task = request.task.toLowerCase();
    const out: Evidence[] = [];
    for (const product of config.products) {
      for (const alias of [product.name, ...product.aliases]) {
        if (containsPhrase(task, alias.toLowerCase())) {
          out.push({ kind: "productReference", product: product.name, matchedAlias: alias });
          break; // one hit per product is enough evidence
        }
      }
    }
    return out;
  },
};

/**
 * A request whose opening CLAUSE is "<build-verb> [me] [a/an/the] <product>"
 * — "Build Facebook", "Clone Instagram", "Make me a Slack" — names no other
 * intent word from the lexicon, yet is exactly the canonical direct-clone
 * request this whole feature exists to catch. Detected as its own bare-form
 * pattern (not by adding "build" to the reproduction lexicon generally,
 * which would fire on every request and defeat FR-013's restraint — e.g.
 * "build a tool that exports data to Slack" must NOT match, and does not,
 * because "tool" sits between the verb and any cataloged alias).
 *
 * The match is required to end at a clause boundary — `,`, `.`, `!`, `?`, or
 * end-of-string — immediately after the alias, not at true end-of-string.
 * Two real submissions showed why a true end-of-string anchor was wrong:
 * "Build Facebook, with everything" (comma) and "Build Facebook. Data
 * sources it can use: none." (a trailing sentence the client appends
 * whenever anything is attached in the builder UI) were both silently
 * ALLOWED by an earlier version requiring the whole string to end there.
 *
 * The boundary is NOT dropped entirely (i.e. this is not a bare prefix
 * match), because doing so reopens a genuine, structural ambiguity this
 * heuristic cannot resolve by itself: "Build an Uber for doctors" (a novel
 * business-model comparison, spec's own worked example, must ALLOW) and
 * "Build Facebook for my team" (a literal clone with an audience clause,
 * arguably should reject) produce IDENTICAL surface evidence — `<verb> <an?>
 * <product> for <lowercase words>` — once the alias is allowed to be
 * followed by anything. Text pattern matching alone cannot tell "for X"
 * meaning "a differentiated vertical" from "for X" meaning "who this literal
 * clone is for", and guessing wrong on that either breaks the spec's own
 * Uber-for-doctors example or silently under-rejects. Stopping at a clause
 * boundary avoids having to guess: it fixes both confirmed real bugs (an
 * unrelated clause SEPARATE from the product mention) without reaching into
 * the one case (a "for"-clause modifying the SAME clause) that is genuinely
 * ambiguous and already deliberately handled elsewhere (differentiationQualifier
 * + FR-008's suppression) rather than here.
 */
function bareProductRequest(task: string, alias: string, bareBuildVerbs: readonly string[]): string | null {
  const verbs = bareBuildVerbs.map(escapeRegExp).join("|");
  const re = new RegExp(
    `^(?:${verbs})\\s+(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+)?${escapeRegExp(alias)}(?=\\s*[,.!?]|$)`,
    "i",
  );
  const match = task.trim().match(re);
  return match ? match[0] : null;
}

/** Rule: does the request contain reproduction-intent language? capability: cannot reject alone (only the combination with productReference may, per FR-013 — enforced by the combinator, not this rule). */
export const reproductionIntent = {
  name: "reproductionIntent",
  capability: { name: "reproductionIntent", canRejectAlone: false } as RuleCapability,
  evaluate(request: ResolvedRequest, config: PolicyConfig): Evidence[] {
    const task = request.task.toLowerCase();
    const out: Evidence[] = [];
    for (const phrase of config.intentLexicon.reproduction) {
      if (containsPhrase(task, phrase.toLowerCase())) {
        out.push({ kind: "reproductionIntent", phrase });
      }
    }
    if (out.length === 0) {
      // No lexicon phrase matched — check the bare-form pattern before giving up.
      for (const product of config.products) {
        for (const alias of [product.name, ...product.aliases]) {
          const bare = bareProductRequest(task, alias.toLowerCase(), config.intentLexicon.bareBuildVerbs);
          if (bare) {
            out.push({ kind: "reproductionIntent", phrase: bare });
            break;
          }
        }
      }
    }
    return out;
  },
};

/** Rule: does the request contain differentiation/alternative-framing language? Independent of the two rules above (FR-008, plan.md Q2) — the combinator, not this rule, reconciles co-occurrence with reproduction intent. */
export const differentiationQualifier = {
  name: "differentiationQualifier",
  capability: { name: "differentiationQualifier", canRejectAlone: false } as RuleCapability,
  evaluate(request: ResolvedRequest, config: PolicyConfig): Evidence[] {
    const task = request.task.toLowerCase();
    const out: Evidence[] = [];
    const d = config.intentLexicon.differentiation;
    for (const phrase of d.alternative) {
      if (containsPhrase(task, phrase.toLowerCase())) {
        out.push({ kind: "differentiationQualifier", phrase, qualifierKind: "alternative" });
      }
    }
    for (const phrase of d.interop) {
      if (containsPhrase(task, phrase.toLowerCase())) {
        out.push({ kind: "differentiationQualifier", phrase, qualifierKind: "interop" });
      }
    }
    for (const phrase of d.similar) {
      if (containsPhrase(task, phrase.toLowerCase())) {
        out.push({ kind: "differentiationQualifier", phrase, qualifierKind: "similar" });
      }
    }
    const verticalRe = new RegExp(d.verticalPattern, "i");
    const verticalMatch = task.match(verticalRe);
    if (verticalMatch) {
      out.push({ kind: "differentiationQualifier", phrase: verticalMatch[0], qualifierKind: "vertical" });
    }
    return out;
  },
};

/**
 * Rule: does the request's described features match a cataloged product's
 * signature closely enough, with no name required? capability: cannot reject
 * alone (FR-013) — its strongest reachable outcome is TRANSFORM (or the
 * REJECT that mode produces under confirmation-unavailable, per FR-012).
 *
 * Match threshold, documented here because it is the one number in this
 * module that isn't derived from config data: at least 2 distinguishing
 * features must match, AND they must cover at least 60% of that product's
 * signature. Both conditions guard against a single incidental word
 * ("marketplace" appearing in an unrelated sentence) counting as a match.
 */
export const capabilitySignature = {
  name: "capabilitySignature",
  capability: { name: "capabilitySignature", canRejectAlone: false } as RuleCapability,
  evaluate(request: ResolvedRequest, config: PolicyConfig): Evidence[] {
    const task = request.task.toLowerCase();
    const out: Evidence[] = [];
    for (const product of config.products) {
      const matched: string[] = [];
      const missing: string[] = [];
      for (const feature of product.distinguishingFeatures) {
        if (containsPhrase(task, feature.toLowerCase())) matched.push(feature);
        else missing.push(feature);
      }
      const total = product.distinguishingFeatures.length;
      const meetsThreshold = matched.length >= 2 && matched.length / total >= 0.6;
      if (meetsThreshold) {
        out.push({ kind: "capabilitySignature", product: product.name, matched, missing });
      }
    }
    return out;
  },
};

/** Named distinctly from the top-level `rules` export (V7's field-validation `RuleDefinition[]`) to avoid an ambiguous re-export from `index.ts`. */
export const policyRules = [
  productReference,
  reproductionIntent,
  differentiationQualifier,
  capabilitySignature,
];
