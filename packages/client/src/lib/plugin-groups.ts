// src/lib/plugin-groups.ts — the engine's capabilities, GROUPED BY THE PLUGIN
// THEY CAME FROM. Pure; the page renders what this returns.
//
// ── ⚠ THE PROBLEM THIS EXISTS TO FIX ────────────────────────────────────────
//
// `/apps` flattened every plugin's classes into ONE table. Measured against the
// live engine on 2026-08-07 that is **267 rows across 8 plugins** — a list whose
// first screen is 25 variants of `io.kestra.plugin.core.*` and which never
// mentions the word "Slack" above the fold. The plugins are the thing a person
// came to look for; the classes are what is inside one.
//
// So: a card per plugin, and its actions when you open it. Same payload, same
// facts, one level of structure added.
//
// ── ⚠ THE LABEL COMES FROM THE ENGINE, NOT FROM A MAP IN HERE ───────────────
//
// `Plugin.title` is already `AWS`, `Azure`, `Slack`, `Email`, `Git`, `Python`,
// `Serialization`, `core` — the engine's own words. A friendly-name lookup table
// here would be a second naming authority that goes stale the day a plugin is
// added, and the failure would be silent: an unmapped plugin rendering as a Java
// package name, under a heading claiming these are apps.
//
// ── ⚠ `reachable` STAYS ON EVERY LEVEL, INCLUDING THE CARD ──────────────────
//
// A registered plugin is NOT a capability an automation has. `flow-compiler
// .service.ts` is the sole YAML emitter (R8) and picks from seven classes;
// today that means **Slack's card reads "0 of 45"**. That number is the honest
// headline, not a blemish to hide behind a filter — it is the difference
// between "the engine has Slack" and "an automation here can post to Slack",
// and a grouped view that dropped it would read as the second while meaning the
// first.

import type { EnginePlugins, Plugin, PluginClass } from "@/lib/types";

export type PluginFilter = {
  /** Free text, matched against the class name, its title, and the plugin's label. */
  q?: string;
  /** One of `PluginClass["kind"]`, or `"all"`. */
  kind?: PluginClass["kind"] | "all";
  /** Only classes a Foundry automation can actually emit. */
  reachableOnly?: boolean;
  /**
   * One of the engine's own category names, or `"all"`.
   *
   * ⚠ **A PLUGIN-level filter, not a class-level one**, which is why it is
   * applied differently from `kind` below: Kestra categorises the plugin
   * (`plugin-slack` is `BUSINESS`) and says nothing about the individual class.
   * Filtering classes by it would drop every row of a matching plugin.
   */
  category?: string;
};

export type PluginGroup = {
  /** The plugin's `name` — the stable key, used for selection. */
  key: string;
  /** What to put on the card. The engine's own `title`, never invented here. */
  label: string;
  /** The Java package. Shown small; it is how you tell two similarly-titled plugins apart. */
  group: string | null;
  /** Null for `core`, which ships with the engine and has no version of its own. */
  version: string | null;
  description: string | null;
  /** The engine's own categories for this plugin — `BUSINESS`, `CLOUD`, `CORE`… */
  categories: string[];
  /** The plugin's logo, base64 SVG, or null. Decorative; never the only carrier of a fact. */
  icon: string | null;
  /** The classes that survive the filter, in display order. */
  classes: PluginClass[];
  /**
   * How many of the SURVIVING `classes` an automation can use — a fact about
   * the current filtered list.
   *
   * ⚠ **Not the number to render beside `total`, and not the one that decides
   * whether a plugin is enabled.** Use `reachableTotal` for both; see below.
   */
  reachable: number;
  /**
   * How many of the plugin's classes an automation can use, BEFORE any filter.
   *
   * ⚠ **This is the honest pair for `total`, and mixing the two is a false
   * statement rather than a cosmetic slip.** Filter `core` to "Conditions" and
   * the filtered count is 0 while the plugin plainly is enabled — a card reading
   * "Not usable today", or a panel offering to compose a request to
   * an admin for a plugin that already works. Both are claims about the PLUGIN,
   * so both read this.
   */
  reachableTotal: number;
  /** Every class this plugin registers, before any filter — the card's denominator. */
  total: number;
};

/** The engine's label for a plugin, falling back to its name. Never a lookup table — see the header. */
export function pluginLabel(p: Pick<Plugin, "name" | "title">): string {
  const t = p.title?.trim();
  // `core` is the engine's own title for its own plugin, and lower-case reads as
  // a mistake beside `Slack` and `Azure`. Capitalising the first letter is a
  // presentation fix; it is deliberately not a rename.
  const raw = t && t.length ? t : p.name;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function matches(c: PluginClass, label: string, needle: string): boolean {
  if (!needle) return true;
  return (
    c.cls.toLowerCase().includes(needle) ||
    c.simpleName.toLowerCase().includes(needle) ||
    (c.title ?? "").toLowerCase().includes(needle) ||
    label.toLowerCase().includes(needle)
  );
}

/**
 * The plugins, filtered, with their surviving classes.
 *
 * ⚠ A plugin whose classes are all filtered out is DROPPED, not shown empty. An
 * empty card under a search term reads as "this plugin has nothing", which is a
 * statement about the plugin rather than about the filter.
 *
 * ⚠ Sorted by whether anything inside is USABLE first, then by label. Not
 * alphabetical: `core` and `Python` are where all seven reachable classes live,
 * and burying them under A-for-AWS would put the only rows that answer "what can
 * my automation do" in the middle of the page.
 */
export function pluginGroups(data: EnginePlugins | null, f: PluginFilter = {}): PluginGroup[] {
  if (!data) return [];
  const needle = (f.q ?? "").trim().toLowerCase();
  const kind = f.kind ?? "all";

  const category = f.category ?? "all";

  const out: PluginGroup[] = [];
  for (const p of data.plugins) {
    const label = pluginLabel(p);
    // ⚠ Applied to the PLUGIN and before its classes, unlike `kind`. See the
    // note on `PluginFilter.category`: the engine categorises the plugin, so a
    // class-level test would drop every row of a plugin that matched.
    if (category !== "all" && !p.categories.includes(category)) continue;
    const classes = p.classes.filter(
      (c) =>
        (kind === "all" || c.kind === kind) &&
        (!f.reachableOnly || c.reachable) &&
        matches(c, label, needle),
    );
    if (classes.length === 0) continue;
    out.push({
      key: p.name,
      label,
      group: p.group,
      version: p.version,
      description: p.description,
      categories: p.categories,
      icon: p.icon,
      // Usable first inside a plugin too, then by the name a person would scan
      // for. `deprecated` last within each — see the note in `sortClasses`.
      classes: sortClasses(classes),
      reachable: classes.filter((c) => c.reachable).length,
      reachableTotal: p.counts.reachable,
      total: p.counts.total,
    });
  }

  out.sort(
    (a, b) => (b.reachable > 0 ? 1 : 0) - (a.reachable > 0 ? 1 : 0) || a.label.localeCompare(b.label),
  );
  return out;
}

/**
 * Usable first, then live before deprecated, then by name.
 *
 * ⚠ Deprecated last rather than hidden. `plugin-notifications` was installed on
 * this engine and removed again when its registry read back **33 tasks, 33 of
 * them deprecated, 0 live** — a whole group that looked like a capability. A
 * deprecated class filtered out of the list is that discovery made impossible
 * for the next person.
 */
function sortClasses(cs: PluginClass[]): PluginClass[] {
  return [...cs].sort(
    (a, b) =>
      (b.reachable ? 1 : 0) - (a.reachable ? 1 : 0) ||
      (a.deprecated ? 1 : 0) - (b.deprecated ? 1 : 0) ||
      a.simpleName.localeCompare(b.simpleName),
  );
}

/**
 * The category nav, DERIVED from the plugins the engine actually reports.
 *
 * ⚠ **Never a hardcoded list of categories.** Kestra's own gallery shows a fixed
 * set (AI, Business, Cloud, Core, Data, Infrastructure); copying it here would
 * put a tab on screen that matches nothing on this engine — and, worse, would
 * silently omit a category a newly installed plugin introduces. Both failures
 * are invisible: one shows an empty list, the other shows no tab at all.
 *
 * Each entry carries its own count, so a tab never leads to an empty grid.
 * Sorted by count then name — the biggest families first, because with eight
 * plugins alphabetical order is arbitrary rather than helpful.
 */
export function pluginCategories(data: EnginePlugins | null): Array<{ key: string; count: number }> {
  if (!data) return [];
  const tally = new Map<string, number>();
  for (const p of data.plugins) {
    for (const c of p.categories) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * `BUSINESS` → `Business`. Presentation only.
 *
 * ⚠ Deliberately NOT a rename map. The engine's category names are already
 * words; a lookup table translating them would be the same second-naming-
 * authority problem `pluginLabel` refuses, for no gain beyond capitalisation.
 */
export function categoryLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
}

/**
 * Every surviving class across every plugin, flat — what a SEARCH should show.
 *
 * A person typing "Pause" wants the class, not the plugin that owns it. Each
 * entry carries its plugin so the flat list can still say where a row came from.
 */
export function pluginMatches(
  data: EnginePlugins | null,
  f: PluginFilter = {},
): Array<{ plugin: PluginGroup; cls: PluginClass }> {
  return pluginGroups(data, f).flatMap((plugin) => plugin.classes.map((cls) => ({ plugin, cls })));
}
