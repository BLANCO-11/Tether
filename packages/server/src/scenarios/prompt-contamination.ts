/**
 * Prompt contamination (compiled-builder, 2026-09-27): a prompt EXAMPLE copied from a goal we measure on teaches the model that goal's
 * answer, and the score then says the builder generalises when it only remembers. Measured once, by accident of how it was written:
 * 16 of 23 examples in the spec prompt were phrases of the tuned goals. This finds them — a quoted example of two or more words, or
 * one word of five or more letters, that appears as whole words in a goal. Pure: the harness refuses to measure when it finds any.
 */
export function promptExamples(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/"([^"\n]{2,60})"/g)].map((m) => m[1]!.trim()).filter(Boolean))];
}

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();

/** Each example that appears, as whole words, in one of the goals — with the goal ids it appears in. */
export function contamination(examples: string[], goals: Array<{ id: string; goal: string }>): Array<{ example: string; goals: string[] }> {
  const out: Array<{ example: string; goals: string[] }> = [];
  for (const e of examples) {
    const w = words(e);
    if (!w || (!w.includes(" ") && w.length < 5)) continue; // a pronoun or a short word is the language, not a goal's phrase
    const hit = goals.filter((g) => ` ${words(g.goal)} `.includes(` ${w} `)).map((g) => g.id);
    if (hit.length) out.push({ example: e, goals: hit });
  }
  return out;
}
