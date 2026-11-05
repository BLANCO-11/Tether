import { normalizeForMatching } from "./normalize.js";

// T031 — the injection pattern set (research R4).
//
// Deterministic and hand-written, standard library only. Two reasons, and the
// second is the load-bearing one:
//
//   1. Article IV — no new runtime dependency.
//   2. Article X — a guardrail's inputs should be inspectable. A pattern list in
//      this repository can be read, argued with and tested. A model-based
//      classifier cannot, and a non-deterministic signal cannot be a gate — the
//      spec rules that out explicitly as OOS-001.
//
// EVERY family below has a negative test in patterns.test.ts drawn from
// realistic business content. Those negatives are not coverage padding: without
// them, the first time a pattern fires on someone's `execute_at` column it gets
// narrowed by whoever is on call, and nothing records what it used to catch.
//
// All matching runs against normalizeForMatching() output — lowercased, NFKC
// folded, invisible characters stripped, whitespace collapsed. Writing a pattern
// against the raw string would be defeated by one zero-width space.

export interface PatternFamily {
  name: string;
  /** What an operator is being told, in one line. */
  describes: string;
  test: (normalized: string) => boolean;
}

/** A URL or an email address — the "somewhere else" half of an exfiltration directive. */
const DESTINATION = String.raw`(https?:\/\/|@[a-z0-9.-]+\.[a-z]{2,})`;

export const PATTERN_FAMILIES: PatternFamily[] = [
  {
    name: "instruction_override",
    describes: "text telling the model to disregard the instructions it was given",
    test: (s) =>
      // A verb of dismissal, then a back-reference, then the thing dismissed.
      // Requiring all three is what keeps "Ignore rows where status is null"
      // and "Previous instructions are archived in this table" clean — each has
      // one part and not the others.
      /\b(ignore|disregard|forget|override)\b[^.!?]{0,40}\b(previous|prior|earlier|above|preceding)\b[^.!?]{0,40}\b(instruction|instructions|direction|directions|prompt|prompts|rule|rules)\b/.test(
        s,
      ) || /\b(ignore|disregard|forget)\b\s+(the\s+|all\s+of\s+the\s+|everything\s+)?above\b/.test(s),
  },
  {
    name: "role_reassignment",
    describes: "text attempting to redefine who the model is or what it is for",
    test: (s) =>
      /\byou are now\b/.test(s) ||
      /\bfrom now on\b[^.!?]{0,30}\byou are\b/.test(s) ||
      // A chat-role label. The colon is what separates this from a table named
      // `system_prompts` or a tool named `assistant_api`, which carry no colon.
      /(^|[\s>"'])(system|assistant|user)\s*:/.test(s),
  },
  {
    name: "exfiltration_directive",
    describes: "text directing data to an address or endpoint of its own choosing",
    test: (s) =>
      // A destination is required. Without it this fires on every legitimate
      // "Posts an invoice to the ledger service" in the registry.
      new RegExp(
        String.raw`\b(post|send|email|upload|exfiltrate|transmit|forward|leak)\b[^.!?]{0,60}\bto\b[^.!?]{0,40}` +
          DESTINATION,
      ).test(s),
  },
  {
    name: "delimiter_mimicry",
    describes: "text imitating the structural markers of a prompt or chat transcript",
    test: (s) =>
      /<\|[a-z_]+\|>/.test(s) ||
      /(^|\s)#{2,}\s*(instruction|system|prompt)/.test(s) ||
      /```\s*(system|assistant|user)\b/.test(s),
  },
  {
    name: "secret_directed",
    describes: "text directing the model at a credential",
    test: (s) =>
      // A verb of disclosure AND a credential noun. `password_last_changed_at`
      // and `token_refresh` are nouns with no verb, which is why they stay clean.
      /\b(reveal|print|output|expose|show|include|leak|dump|disclose)\b[^.!?]{0,40}\b(api key|apikey|password|passwords|token|tokens|secret|secrets|credential|credentials|private key)\b/.test(
        s,
      ),
  },
];

/**
 * Which families this value matches. Deduplicated, in declaration order, so a
 * warning list is stable across builds.
 */
export function matchFamilies(value: string): string[] {
  const normalized = normalizeForMatching(value);
  if (normalized.length === 0) return [];
  return PATTERN_FAMILIES.filter((f) => f.test(normalized)).map((f) => f.name);
}

/** One-line description for a family, for the warning an operator reads. */
export function describeFamily(name: string): string {
  return PATTERN_FAMILIES.find((f) => f.name === name)?.describes ?? name;
}
