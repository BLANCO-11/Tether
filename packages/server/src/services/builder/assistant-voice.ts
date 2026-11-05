/**
 * Grounded assistant voice (Strategy B Phase 4b): code builds a fact card;
 * the model (or a deterministic fallback) phrases it. Never invents steps/tools.
 */
import type { Chooser } from "./build.js";
import { S, parseStrict, type Schema } from "./strict-schema.js";

export interface FactCard {
  goal?: string;
  summary: string;
  steps: string[];
  schedule?: string | null;
  gaps: string[];
  catalogueHints?: string[];
}

const phraseSchema: Schema = S.obj({ text: S.str() });

/** Deterministic friendly phrasing from a fact card (no model). */
export function phraseFromFacts(card: FactCard): string {
  const bits: string[] = [];
  if (card.summary) bits.push(card.summary);
  else if (card.goal) bits.push(`You’re building: ${card.goal}`);
  if (card.steps.length) bits.push(`Here’s what it does so far:\n${card.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  if (card.schedule) bits.push(`It runs: ${card.schedule}.`);
  if (card.gaps.length) bits.push(`Still open: ${card.gaps.join("; ")}. I can help set those when you’re ready.`);
  if (!bits.length) bits.push("Nothing is built yet — tell me what you’d like this automation to do.");
  bits.push("I’m here to help — ask what a step does, or tell me what to change.");
  return bits.join("\n\n");
}

/**
 * Optional model polish: may ONLY rephrase the fact card. If the model fails or
 * the flag asks for code-only, returns phraseFromFacts.
 */
export async function assistantReply(
  card: FactCard,
  chooser?: Chooser,
): Promise<{ text: string; calls: number }> {
  const fallback = phraseFromFacts(card);
  if (!chooser) return { text: fallback, calls: 0 };
  const prompt = [
    "You are a helpful automation assistant. Rephrase the FACTS into short, warm, clear prose.",
    "Use ONLY the facts below. Do not invent steps, tools, tables, or behaviour.",
    "If gaps are listed, acknowledge them honestly and offer to help.",
    "",
    "FACTS",
    JSON.stringify(card),
  ].join("\n");
  try {
    const raw = await chooser(prompt, { name: "assistant_voice", schema: phraseSchema }, "chat:assistant");
    const { text } = parseStrict<{ text: string }>(phraseSchema, raw, "chat:assistant");
    const grounded = text.trim();
    // Refuse invented catalogue refs: if model names a step/tool token not in facts, fall back.
    const allowed = new Set(
      [...card.steps, card.summary, card.goal ?? "", ...(card.catalogueHints ?? []), ...card.gaps]
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9_.]+/)
        .filter((w) => w.length > 2),
    );
    const suspect = grounded.toLowerCase().match(/\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/g) ?? [];
    if (suspect.some((s) => !allowed.has(s) && !(card.catalogueHints ?? []).some((h) => h.toLowerCase().includes(s)))) {
      return { text: fallback, calls: 1 };
    }
    return { text: grounded || fallback, calls: 1 };
  } catch {
    return { text: fallback, calls: 1 };
  }
}

/** Fact card from plain describeFlow lines + gaps (no IR required). */
export function factCardFromLines(opts: {
  goal?: string;
  summary: string;
  inventory: string[];
  gaps?: string[];
  schedule?: string | null;
  catalogueHints?: string[];
}): FactCard {
  return {
    goal: opts.goal,
    summary: opts.summary,
    steps: opts.inventory.filter(Boolean),
    schedule: opts.schedule ?? null,
    gaps: opts.gaps ?? [],
    catalogueHints: opts.catalogueHints,
  };
}
