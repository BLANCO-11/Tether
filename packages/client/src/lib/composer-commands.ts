/** Slash commands in the Forge composer. Pure, no React. */

export type SlashCommand = { name: "model" | "think"; hint: string };

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", hint: "Choose the model" },
  { name: "think", hint: "How hard Forge thinks" },
];

/** Splits `/name arg...` into its parts. Null unless the text starts with "/". */
export function parseSlash(text: string): { name: string; arg: string; hasArg: boolean } | null {
  if (text[0] !== "/") return null;
  const body = text.slice(1);
  const ws = body.search(/\s/);
  if (ws === -1) return { name: body.toLowerCase(), arg: "", hasArg: false };
  return { name: body.slice(0, ws).toLowerCase(), arg: body.slice(ws).trim(), hasArg: true };
}

/** The available commands whose name starts with `name`. */
export function commandsFor(name: string, available: SlashCommand[]): SlashCommand[] {
  return available.filter((c) => c.name.startsWith(name));
}

/** The available command whose name equals the typed name exactly, with its argument. */
export function exactCommand(text: string, available: SlashCommand[]): { command: SlashCommand; arg: string } | null {
  const parsed = parseSlash(text);
  if (!parsed) return null;
  const command = available.find((c) => c.name === parsed.name);
  return command ? { command, arg: parsed.arg } : null;
}

/**
 * Picks one item for a typed query. Tiers in order: exact label, label prefix, label substring.
 * The first tier with a hit decides: one hit picks it, several are returned as candidates.
 */
export function bestMatch(
  query: string,
  items: { key: string; labels: string[] }[],
): { pick: string | null; candidates: string[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { pick: null, candidates: items.map((i) => i.key) };
  const tiers: ((label: string) => boolean)[] = [
    (label) => label === q,
    (label) => label.startsWith(q),
    (label) => label.includes(q),
  ];
  for (const test of tiers) {
    const hits = items.filter((i) => i.labels.some((l) => test(l.toLowerCase()))).map((i) => i.key);
    if (hits.length === 1) return { pick: hits[0], candidates: hits };
    if (hits.length > 1) return { pick: null, candidates: hits };
  }
  return { pick: null, candidates: [] };
}
