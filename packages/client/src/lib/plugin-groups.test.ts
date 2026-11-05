// src/lib/plugin-groups.test.ts — the grouping rules, asserted without rendering.
//
// The ordering is the part worth pinning: `/apps` opened as 267 flat rows, and
// the fix is only a fix if the plugins whose capabilities an automation can
// actually use come first. That is a property of a pure function, so it is
// checkable here rather than by looking at a screen.
import { describe, expect, it } from "vitest";
import {
  categoryLabel,
  pluginCategories,
  pluginGroups,
  pluginLabel,
  pluginMatches,
} from "./plugin-groups";
import type { EnginePlugins, Plugin, PluginClass } from "./types";

const cls = (over: Partial<PluginClass> & { cls: string }): PluginClass => ({
  simpleName: over.cls.split(".").pop() ?? over.cls,
  kind: "task",
  title: null,
  deprecated: false,
  reachable: false,
  ...over,
});

const plugin = (over: Partial<Plugin> & { name: string }): Plugin => {
  const classes = over.classes ?? [];
  return {
    group: `io.kestra.plugin.${over.name}`,
    title: null,
    description: null,
    version: "1.3.0",
    categories: [],
    icon: null,
    classes,
    counts: {
      total: classes.length,
      reachable: classes.filter((c) => c.reachable).length,
      tasks: classes.length,
      triggers: 0,
      conditions: 0,
      taskRunners: 0,
      other: 0,
    },
    ...over,
  };
};

const engine = (plugins: Plugin[]): EnginePlugins => ({
  reachable: true,
  engine: { version: "1.3.29", edition: "OSS" },
  plugins,
  foundryEmits: [],
  totals: {
    plugins: plugins.length,
    classes: plugins.reduce((n, p) => n + p.counts.total, 0),
    reachable: plugins.reduce((n, p) => n + p.counts.reachable, 0),
  },
  notes: [],
});

describe("pluginLabel", () => {
  it("uses the engine's own title, never a lookup table", () => {
    expect(pluginLabel({ name: "plugin-slack", title: "Slack" })).toBe("Slack");
    expect(pluginLabel({ name: "plugin-aws", title: "AWS" })).toBe("AWS");
  });

  it("falls back to the plugin name when the engine gives no title", () => {
    // ⚠ A fallback, not a guess. An unmapped plugin showing its raw name is
    // legible; one showing nothing, or a name this repo invented for it, is not.
    expect(pluginLabel({ name: "plugin-brand-new", title: null })).toBe("Plugin-brand-new");
  });

  it("capitalises `core`, which the engine titles in lower case", () => {
    expect(pluginLabel({ name: "core", title: "core" })).toBe("Core");
  });
});

describe("pluginGroups", () => {
  const data = engine([
    plugin({ name: "plugin-aws", title: "AWS", classes: [cls({ cls: "a.S3Upload" })] }),
    plugin({
      name: "core",
      title: "core",
      version: null,
      classes: [cls({ cls: "c.Pause", reachable: true }), cls({ cls: "c.Log" })],
    }),
    plugin({ name: "plugin-slack", title: "Slack", classes: [cls({ cls: "s.Post" })] }),
  ]);

  it("puts plugins with something usable first, then orders by label", () => {
    // The whole point of the regrouping. `core` holds the reachable class, so it
    // leads even though A-for-AWS would sort above it.
    expect(pluginGroups(data).map((g) => g.label)).toEqual(["Core", "AWS", "Slack"]);
  });

  it("reports BOTH numbers, so `0 of N` is sayable", () => {
    const slack = pluginGroups(data).find((g) => g.label === "Slack")!;
    expect(slack.reachable).toBe(0);
    expect(slack.classes.length).toBe(1);
  });

  it("drops a plugin whose classes are all filtered out rather than showing it empty", () => {
    // An empty card under a search term is a statement about the plugin, not
    // about the filter.
    const only = pluginGroups(data, { q: "s3" });
    expect(only.map((g) => g.label)).toEqual(["AWS"]);
  });

  it("matches on the plugin's label as well as on the class", () => {
    // Typing "slack" is a question about the plugin; it must not return nothing
    // just because no class is called Slack.
    expect(pluginGroups(data, { q: "slack" }).map((g) => g.label)).toEqual(["Slack"]);
  });

  it("filters by kind and by reachability", () => {
    expect(pluginGroups(data, { reachableOnly: true }).map((g) => g.label)).toEqual(["Core"]);
    expect(pluginGroups(data, { kind: "trigger" })).toEqual([]);
  });

  it("returns nothing at all for a null payload, and does not invent a shape", () => {
    expect(pluginGroups(null)).toEqual([]);
    expect(pluginMatches(null)).toEqual([]);
  });

  it("keeps `total` as the plugin's real class count, not the filtered one", () => {
    // The card's denominator has to survive a filter — otherwise searching makes
    // every plugin look like it has exactly as many capabilities as matched.
    const filtered = pluginGroups(data, { q: "pause" })[0]!;
    expect(filtered.classes.length).toBe(1);
    expect(filtered.total).toBe(2);
  });
});

describe("pluginGroups — class ordering inside a plugin", () => {
  it("puts usable first, then live before deprecated, then by name", () => {
    // ⚠ Deprecated LAST, never hidden. `plugin-notifications` was installed on
    // this engine and removed again when its registry read back 33 tasks, 33 of
    // them deprecated, 0 live — a whole group that looked like a capability.
    // Filtering deprecated out is that discovery made impossible.
    const data = engine([
      plugin({
        name: "plugin-x",
        title: "X",
        classes: [
          cls({ cls: "x.Zebra", reachable: true }),
          cls({ cls: "x.Old", deprecated: true }),
          cls({ cls: "x.Apple" }),
        ],
      }),
    ]);
    expect(pluginGroups(data)[0]!.classes.map((c) => c.simpleName)).toEqual([
      "Zebra",
      "Apple",
      "Old",
    ]);
  });
});

describe("pluginMatches", () => {
  it("flattens across plugins and keeps the source on every entry", () => {
    const data = engine([
      plugin({ name: "core", title: "core", classes: [cls({ cls: "c.Pause" })] }),
      plugin({ name: "plugin-slack", title: "Slack", classes: [cls({ cls: "s.Pause" })] }),
    ]);
    const hits = pluginMatches(data, { q: "pause" });
    expect(hits).toHaveLength(2);
    // Without the plugin on each entry, a flat search cannot say where a row
    // came from — and two classes can share a simple name, as these do.
    expect(hits.map((h) => h.plugin.label).sort()).toEqual(["Core", "Slack"]);
  });
});

describe("the category nav is derived from the engine", () => {
  const data = () =>
    engine([
      plugin({ name: "plugin-slack", title: "Slack", categories: ["BUSINESS"], classes: [cls({ cls: "s.Post" })] }),
      plugin({ name: "plugin-email", title: "Email", categories: ["BUSINESS"], classes: [cls({ cls: "e.Send" })] }),
      plugin({ name: "plugin-aws", title: "AWS", categories: ["CLOUD", "STORAGE"], classes: [cls({ cls: "a.S3" })] }),
    ]);

  it("lists every category the plugins declare, with counts", () => {
    expect(pluginCategories(data())).toEqual([
      { key: "BUSINESS", count: 2 },
      { key: "CLOUD", count: 1 },
      { key: "STORAGE", count: 1 },
    ]);
  });

  it("invents no category the engine did not report", () => {
    // ⚠ The rule this pins. Kestra's own gallery shows a fixed nav (AI,
    // Business, Cloud, Core, Data, Infrastructure); copying that list here would
    // put tabs on screen matching nothing on THIS engine, and would silently
    // omit a category a newly installed plugin introduces. Both failures are
    // invisible — one shows an empty grid, the other shows no tab at all.
    const keys = pluginCategories(data()).map((c) => c.key);
    expect(keys).not.toContain("AI");
    expect(keys).not.toContain("INFRASTRUCTURE");
  });

  it("returns nothing when the engine could not be read", () => {
    // Never a default nav over an unreachable engine: a full-looking set of tabs
    // is a confident claim about a registry nobody managed to ask.
    expect(pluginCategories(null)).toEqual([]);
  });

  it("filters plugins by category, keeping ALL of a matching plugin's classes", () => {
    // ⚠ The reason `category` is applied to the plugin rather than to each
    // class: Kestra categorises the plugin and says nothing about the class, so
    // a class-level test would drop every row of a plugin that matched.
    const got = pluginGroups(data(), { category: "BUSINESS" });
    expect(got.map((g) => g.label).sort()).toEqual(["Email", "Slack"]);
    expect(got.every((g) => g.classes.length === 1)).toBe(true);
  });

  it("titles a category without renaming it", () => {
    expect(categoryLabel("BUSINESS")).toBe("Business");
    expect(categoryLabel("INFRASTRUCTURE")).toBe("Infrastructure");
  });
});

describe("a plugin's enabled-ness is a fact about the PLUGIN, not about the filter", () => {
  const data = engine([
    plugin({
      name: "core",
      title: "core",
      classes: [cls({ cls: "c.Pause", reachable: true }), cls({ cls: "c.Log" })],
    }),
  ]);

  it("keeps reachableTotal unfiltered while reachable follows the filter", () => {
    // ⚠ The bug this pins. Narrowing to a kind that excludes the reachable class
    // drops the FILTERED count to zero — and `/apps` renders "Not enabled for
    // automations" plus an offer to compose a request to an admin off exactly
    // that number. For `core`, which holds six of the seven emittable classes,
    // both would be false.
    const narrowed = pluginGroups(data, { q: "log" })[0]!;
    expect(narrowed.reachable).toBe(0);
    expect(narrowed.reachableTotal).toBe(1);
  });

  it("pairs reachableTotal with total, both unfiltered", () => {
    // The card reads "N of M". Mixing a filtered N with an unfiltered M is a
    // sentence that is wrong in both directions as soon as anyone types.
    const narrowed = pluginGroups(data, { q: "log" })[0]!;
    expect(narrowed.total).toBe(2);
    expect(narrowed.reachableTotal).toBeLessThanOrEqual(narrowed.total);
  });
});
