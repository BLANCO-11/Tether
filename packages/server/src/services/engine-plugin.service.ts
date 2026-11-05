/**
 * What the execution engine can actually do — read from the engine, not declared.
 * ui-upgrade Phase 9 · D-111
 *
 * ── ⚠ WHY THIS IS A SERVER ROUTE AND NOT A BROWSER FETCH ────────────────────
 *
 * Kestra **publishes no port and cannot have one** — its only network is
 * `internal: true`, and Docker discards a `ports:` stanza on it silently, which
 * `kestra:check` asserts. Even if it did, `kestra-ui` has no tenant isolation:
 * `CLAUDE.md` is explicit — *"never proxy it, never iframe it, never give a
 * client the URL."* So the plugin registry is a **parent-server read**, shaped
 * here and handed to the browser as data. A client never addresses the engine
 * (R5), and that stays true of this page.
 *
 * ── ⚠ THE FACT THAT MAKES THIS PAGE HONEST ──────────────────────────────────
 *
 * **A registered plugin is not a capability an automation has.** The engine
 * registers 60-odd core task types; `flow-compiler.service.ts` is the sole YAML
 * emitter (R8) and chooses from **seven**. A page listing everything Kestra
 * knows how to do, under a heading about this product's capabilities, is a
 * catalogue of things you cannot ask for — the `/apps` mock defect with real
 * data behind it instead of `SEED_APPS`.
 *
 * So every class is marked `reachable` or not, the counts are reported both
 * ways, and `FOUNDRY_EMITS` is pinned against the compiler's own source by
 * `engine-plugin.test.ts`. An eighth emitted type must not leave this page
 * saying seven.
 *
 * ── ⚠ AND WHY THE PLUGIN COUNT IS TWO ───────────────────────────────────────
 *
 * Not an accident and not a gap. The image is built from
 * `kestra/kestra:v1.3.29-**no-plugins**` plus exactly one plugin, because the
 * full image registers 1404 plugins and **OOMs the engine** (`ISSUES.md` I-05) —
 * a failure that presented as *"healthy but every call hangs"* and died with
 * exit 0 / `OOMKilled: false`. The page says so, because "2 plugins" with no
 * reason reads as a broken installation.
 */
import { kestra, type KestraPlugin, type KestraPluginClass } from "./kestra-client.service.js";

/**
 * The task, trigger and runner types `flow-compiler.service.ts` can emit.
 *
 * ⚠ **Pinned against the compiler's source by a test**, not maintained by hand.
 * The list is short because the compiler chooses task types itself — that is
 * what makes R8 a containment property rather than a style rule, and it is why
 * `paramsExpr` being an opaque string is survivable.
 */
export const FOUNDRY_EMITS = [
  "io.kestra.plugin.core.debug.Return",
  // ⚠ `core.execution.Fail` was here and is NOT. Its only emission was the
  // outcome-check task an `agent` step synthesised — the third task that turned
  // a failed agent run into a failed STEP — and it went with that kind. Removed
  // rather than kept "in case": this array is what `/apps` counts to say how
  // many registered classes an automation can actually reach, and a class
  // nothing emits inflates that number by one.
  // Phase 3 — the conditional guard. A `core.flow` class, already registered by
  // the engine (measured: 18 of them), so this needed no plugin and no rebuild.
  "io.kestra.plugin.core.flow.If",
  // Phase F — for each (D-361): a loop box's body runs once per item. Another core.flow class the engine already registers;
  // proven on the engine by `kestra:foreach` (identity, order, per-item paths, failure) and `foreach-e2e` (the compiled loop).
  "io.kestra.plugin.core.flow.ForEach",
  "io.kestra.plugin.core.flow.Pause",
  "io.kestra.plugin.core.http.Request",
  "io.kestra.plugin.core.trigger.Schedule",
  "io.kestra.plugin.scripts.python.Script",
  "io.kestra.plugin.scripts.runner.docker.Docker",
] as const;

const EMITTED = new Set<string>(FOUNDRY_EMITS);

export type PluginClassView = {
  cls: string;
  /** The last segment — `Request`, `Pause`. What a person reads. */
  simpleName: string;
  kind: "task" | "trigger" | "condition" | "taskRunner" | "storage" | "other";
  title: string | null;
  deprecated: boolean;
  /**
   * ⚠ **Whether an automation in this product can actually use it.** The engine
   * registering a class and Foundry being able to emit it are different facts,
   * and conflating them is what would make this page a catalogue of things you
   * cannot ask for.
   */
  reachable: boolean;
};

export type PluginView = {
  name: string;
  group: string | null;
  title: string | null;
  description: string | null;
  /** Absent for `core`, which ships with the engine and has no version of its own. */
  version: string | null;
  categories: string[];
  /**
   * The plugin's own logo as a base64 SVG, or null when the engine has none.
   *
   * ⚠ **From the engine, never from a map in this repo.** Same rule the label
   * follows: a hand-kept icon table is a second naming authority that is correct
   * the day it is typed and silently wrong after the next plugin is added — and
   * the failure is a brand mark on the wrong product, which nothing can test.
   *
   * ⚠ **It is DECORATIVE.** Every fact this page makes a claim about — what is
   * reachable, what is deprecated, what a plugin needs to sign in — is carried
   * by text beside it. A card whose meaning depends on recognising a logo is a
   * card a screen reader cannot read.
   */
  icon: string | null;
  /** Every class, in one list. `kind` is what separates them. */
  classes: PluginClassView[];
  counts: {
    total: number;
    /** How many of `total` a Foundry automation can actually reach. */
    reachable: number;
    tasks: number;
    triggers: number;
    conditions: number;
    taskRunners: number;
    other: number;
  };
};

export type EnginePluginsView = {
  /** False when the engine could not be read. ⚠ NEVER a silently empty list. */
  reachable: boolean;
  engine: { version: string | null; edition: string | null };
  plugins: PluginView[];
  /** The seven, so a client can state the bound without recomputing it. */
  foundryEmits: string[];
  totals: { plugins: number; classes: number; reachable: number };
  /**
   * Why the number is small, said in the payload rather than in the page —
   * two readers, one sentence.
   */
  notes: string[];
  /** Present only when `reachable` is false. The diagnosis, not "no data". */
  detail?: string;
};

const KINDS: Array<[keyof KestraPlugin, PluginClassView["kind"]]> = [
  ["tasks", "task"],
  ["triggers", "trigger"],
  ["conditions", "condition"],
  ["taskRunners", "taskRunner"],
  ["storages", "storage"],
  ["charts", "other"],
  ["dataFilters", "other"],
  ["dataFiltersKPI", "other"],
  ["logExporters", "other"],
  ["secrets", "other"],
  ["apps", "other"],
  ["appBlocks", "other"],
];

/**
 * The logo to put on a plugin's card: the most COMMON non-empty icon among the
 * classes that plugin actually registers.
 *
 * ⚠ **Keyed off the plugin's own classes, never off a package prefix.** Guessing
 * `io.kestra.plugin.<name>` looks equivalent and is not — `plugin-email`'s
 * classes live under `io.kestra.plugin.ee.email`, so a prefix rule drops its
 * logo and nothing fails.
 *
 * ⚠ **Most common, not first.** Icons carry per-class overrides, and Slack
 * registers a class whose icon is the EMPTY STRING — measured. "First non-empty"
 * would pick whichever variant sorted earliest; the mode is the brand mark.
 */
export function iconFor(
  classes: Array<Pick<PluginClassView, "cls">>,
  icons: PluginIcons,
): string | null {
  const tally = new Map<string, number>();
  for (const c of classes) {
    const icon = icons[c.cls]?.icon;
    if (!icon) continue;
    tally.set(icon, (tally.get(icon) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [icon, n] of tally) {
    if (n > bestN) {
      best = icon;
      bestN = n;
    }
  }
  return best;
}

export type PluginIcons = Record<string, { name?: string; icon?: string } | null>;

function viewOf(p: KestraPlugin, icons: PluginIcons): PluginView {
  const classes: PluginClassView[] = [];
  for (const [key, kind] of KINDS) {
    const list = p[key];
    if (!Array.isArray(list)) continue;
    for (const c of list as KestraPluginClass[]) {
      if (!c?.cls) continue;
      classes.push({
        cls: c.cls,
        simpleName: c.cls.split(".").pop() ?? c.cls,
        kind,
        title: c.title ?? null,
        deprecated: Boolean(c.deprecated),
        reachable: EMITTED.has(c.cls),
      });
    }
  }
  classes.sort((a, b) => a.cls.localeCompare(b.cls));
  const by = (k: PluginClassView["kind"]) => classes.filter((c) => c.kind === k).length;
  return {
    name: p.name ?? p.group ?? "unnamed",
    group: p.group ?? null,
    title: p.title ?? null,
    description: p.description ?? p.manifest?.["X-Kestra-Description"] ?? null,
    version: p.version ?? p.manifest?.["X-Kestra-Version"] ?? null,
    categories: p.categories ?? [],
    icon: iconFor(classes, icons),
    classes,
    counts: {
      total: classes.length,
      reachable: classes.filter((c) => c.reachable).length,
      tasks: by("task"),
      triggers: by("trigger"),
      conditions: by("condition"),
      taskRunners: by("taskRunner"),
      other: by("other") + by("storage"),
    },
  };
}

export const enginePluginService = {
  /**
   * ⚠ **Fails LOUD, never to an empty list.** An unreachable engine returning
   * `plugins: []` renders as "this engine can do nothing", which is a confident
   * wrong answer — the `faFallback` shape with no fabricated rows. `reachable:
   * false` plus the transport diagnosis is the honest one, and the page says
   * which it got.
   */
  async list(): Promise<EnginePluginsView> {
    const health = await kestra.health();
    const engine = { version: health.version ?? null, edition: health.edition ?? null };

    let raw: KestraPlugin[];
    try {
      raw = await kestra.listPlugins();
    } catch (e) {
      return {
        reachable: false,
        engine,
        plugins: [],
        foundryEmits: [...FOUNDRY_EMITS],
        totals: { plugins: 0, classes: 0, reachable: 0 },
        notes: [],
        detail: (e as Error).message,
      };
    }

    // ⚠ **A missing icon is not a missing answer.** The logos are decoration and
    // the registry is the point, so this failure DEGRADES to a logo-less gallery
    // instead of taking the page down — the opposite of the `listPlugins` catch
    // above, which fails loud because an empty registry is a wrong answer.
    // It is cached for the life of the process for the same reason the credential
    // scan is: plugins are baked into the engine's image (D-85), so this cannot
    // change without a redeploy, which restarts this process.
    if (!iconCache) {
      try {
        iconCache = await kestra.listPluginIcons();
      } catch {
        // Logged rather than swallowed: `CLAUDE.md`'s rule for a
        // degrade-gracefully catch is that it must say what it degraded FROM,
        // or the class of bug presents as "the field is just null sometimes".
        console.warn("[engine-plugins] icons unavailable; rendering without logos");
        iconCache = {};
      }
    }

    const plugins = (Array.isArray(raw) ? raw : []).map((p) => viewOf(p, iconCache ?? {}));
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    const classes = plugins.reduce((n, p) => n + p.counts.total, 0);
    const reachable = plugins.reduce((n, p) => n + p.counts.reachable, 0);

    return {
      reachable: true,
      engine,
      plugins,
      foundryEmits: [...FOUNDRY_EMITS],
      totals: { plugins: plugins.length, classes, reachable },
      notes: [
        // ⚠ Both of these belong in the payload rather than only on the page.
        // The first is the reason a small number is correct; the second is the
        // reason a large number would still not mean what it looks like.
        "This engine runs a deliberately minimal plugin set. The image is built from " +
          "kestra/kestra:v1.3.29-no-plugins plus one plugin, because the full image registers " +
          "1404 of them and exhausts the engine's memory — it comes up healthy and then every " +
          "call hangs.",
        `A registered class is not something an automation can ask for. Foundry's compiler is the ` +
          `only thing that writes flow definitions, and it emits ${FOUNDRY_EMITS.length} of the ` +
          `${classes} classes below. The rest are what the engine knows how to run, not what this ` +
          `product will run.`,
      ],
    };
  },

  /**
   * What one plugin needs in order to authenticate — READ FROM THE ENGINE.
   *
   * ── ⚠ WHY THIS IS A READ AND NOT A TABLE ──────────────────────────────────
   *
   * Kestra marks every property with a `$group`, and `"connection"` is the one
   * it uses for the fields that authenticate: Slack's `url`, AWS's
   * `accessKeyId`/`secretKeyId`/`region`, Azure's connection string. A
   * hand-written map of "what Slack needs" in this repo would be a second naming
   * authority for someone else's plugin — correct on the day it is typed and
   * silently wrong after the next version bump, with no test able to notice.
   *
   * ── ⚠ WHAT IT DOES NOT DO, AND THE PARAGRAPH THAT MUST TRAVEL WITH IT ─────
   *
   * **Nothing in this product can call these plugins.** `flow-compiler
   * .service.ts` is the sole YAML emitter (R8) and emits seven classes, none of
   * which are in any of these plugins. So this endpoint answers *"what would it
   * take"*, and `usableToday` is on the payload saying so — because a
   * credentials form on a screen is the strongest possible claim that filling it
   * in will make something work, and here it would not. Inert is worse than
   * refused; a page that shows the fields AND says nothing reads them is
   * neither.
   *
   * ⚠ **Foundry's model is that a secret never appears in a flow definition**,
   * and every one of these plugins takes its credential INLINE in the YAML. That
   * is the open question Phase 8 stopped on — D-22 exists because
   * `{{ secret('FOUNDRY_CALLBACK') }}` reaching a task field was a real hole.
   * This read is the groundwork for answering it; it is not the answer.
   */
  async credentials(pluginName: string): Promise<PluginCredentialsView> {
    const all = await this.list();
    if (!all.reachable) {
      return {
        plugin: pluginName,
        reachable: false,
        fields: [],
        classesRead: 0,
        classesTotal: 0,
        usableToday: false,
        detail: all.detail ?? "The engine did not answer.",
        notes: [],
      };
    }

    const plugin = all.plugins.find((p) => p.name === pluginName);
    if (!plugin) {
      return {
        plugin: pluginName,
        reachable: true,
        fields: [],
        classesRead: 0,
        classesTotal: 0,
        usableToday: false,
        detail: `This engine does not have a plugin called "${pluginName}".`,
        notes: [],
      };
    }

    // ⚠ EVERY class, not a sample — and that is a MEASURED correction. The first
    // version read the first 12 and the reasoning was *"connection properties
    // live on a plugin's shared abstract base, so a sample finds them"*. Against
    // the live engine that was false twice over: Slack's `url` is on
    // `notifications.SlackIncomingWebhook`, which is not in its first 12
    // alphabetically, and AWS came back with **zero fields** from 12 classes.
    //
    // Reading all of them is affordable because the answer is IMMUTABLE for a
    // given engine build — plugins are baked into the image (D-85) — so it is
    // cached for the life of the process. The cap is a runaway guard, not a
    // sampling strategy, and `classesRead` still travels with the answer.
    const cached = credentialCache.get(plugin.name);
    const scanned = plugin.classes.slice(0, MAX_SCHEMA_READS);
    const scan = cached ?? (await scanClasses(scanned.map((c) => c.cls)));
    if (!cached) credentialCache.set(plugin.name, scan);

    return {
      plugin: plugin.name,
      reachable: true,
      fields: scan.fields,
      classesRead: scan.read,
      classesTotal: plugin.classes.length,
      // The whole point. `plugin.counts.reachable` is how many of its classes
      // Foundry's compiler can emit — zero for every one of these today.
      usableToday: plugin.counts.reachable > 0,
      notes: [
        plugin.counts.reachable > 0
          ? `An automation can use ${plugin.counts.reachable} of this plugin's ${plugin.counts.total} capabilities.`
          : `No automation can call this plugin yet. Foundry writes every flow definition itself and ` +
            `emits ${FOUNDRY_EMITS.length} class types, none of them from this plugin — so a value ` +
            `stored for it today would not be read by anything.`,
        `Read from the engine's own schema for ${scan.read} of this plugin's ` +
          `${plugin.classes.length} capabilities. There is no list of plugin credentials maintained ` +
          `by Foundry.`,
        // ⚠ The heuristic declares itself. See `CREDENTIAL_NAME` below.
        scan.fields.some((f) => f.source === "inferred")
          ? `Fields marked "declared" are ones the plugin's own author classified as part of ` +
            `connecting. Fields marked "recognised" were matched by NAME, because this plugin ` +
            `classifies none of its properties — that is a good guess, not the author's word.`
          : `Every field below is one the plugin's own author classified as part of connecting.`,
      ],
    };
  },
};

/**
 * A runaway guard, NOT a sampling strategy — see the note at the call site. The
 * largest plugin on this engine registers 102 classes.
 */
const MAX_SCHEMA_READS = 200;

/** How many schema reads run at once. The engine is local; this is politeness, not a limit. */
const SCHEMA_CONCURRENCY = 8;

/**
 * ⚠ Cached for the LIFE OF THE PROCESS, and that is sound rather than lazy:
 * plugins are baked into the engine's image (D-85), so this answer cannot change
 * without a redeploy — which restarts this process.
 */
const credentialCache = new Map<string, { fields: PluginCredentialField[]; read: number }>();

/**
 * The engine's icon map, read once. ⚠ 2.4 MB on the wire from Kestra and it must
 * never travel further — `iconFor` reduces it to one icon per plugin (**27.6 KB
 * for all eight**, measured through `/api/engine/plugins`) before anything is
 * serialised to a browser.
 */
let iconCache: PluginIcons | null = null;

/**
 * Property names that are a credential whatever the plugin says.
 *
 * ── ⚠ WHY A NAME HEURISTIC EXISTS HERE AT ALL ───────────────────────────────
 *
 * `$group: "connection"` is Kestra's own classification and is the right primary
 * signal — Slack uses it for the webhook `url`. **AWS does not use it at all**:
 * `accessKeyId`, `secretKeyId`, `sessionToken` and `region` carry no `$group`,
 * and a filter on the group alone reports that AWS needs nothing to sign in.
 * Measured against the live engine, which is how the first version of this
 * function was found to be wrong.
 *
 * So there is a second, weaker signal, and **it is labelled on screen** —
 * `source: "inferred"` — because a guess presented as the author's word is the
 * failure mode. The precedent is `redactSecrets`, which matches credential-shaped
 * KEYS for the same reason: it holds for parameters nobody has thought of yet.
 *
 * ⚠ It runs only when the plugin classifies NOTHING. A plugin that uses
 * `$group` is taken at its word, so the heuristic can never override an author
 * who has said what their connection fields are.
 */
const CREDENTIAL_NAME =
  /(^|[a-z])(accessKey|secretKey|sessionToken|apiKey|api_key|token|password|passphrase|credential|connectionString|privateKey|clientSecret|tenantId|clientId|region|endpointOverride)/i;

async function scanClasses(classes: string[]): Promise<{ fields: PluginCredentialField[]; read: number }> {
  const declared = new Map<string, PluginCredentialField>();
  const inferred = new Map<string, PluginCredentialField>();
  let read = 0;

  for (let i = 0; i < classes.length; i += SCHEMA_CONCURRENCY) {
    const batch = classes.slice(i, i + SCHEMA_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (cls) => {
        try {
          const r = await kestra.pluginSchema(cls);
          read += 1;
          return r;
        } catch {
          // ⚠ Counted by NOT incrementing `read`, so the shortfall is visible in
          // the payload. A swallowed failure that still counted would report a
          // complete scan of a plugin half of which was never asked about.
          return null;
        }
      }),
    );

    for (const r of results) {
      const props = r?.schema?.properties?.properties ?? {};
      for (const [name, p] of Object.entries(props)) {
        if (!p) continue;
        const isDeclared = p.$group === "connection";
        const isInferred = !p.$group && CREDENTIAL_NAME.test(name);
        if (!isDeclared && !isInferred) continue;
        const into = isDeclared ? declared : inferred;
        const existing = into.get(name);
        // Required ANYWHERE in the plugin counts as required: a person reading
        // this is deciding what to obtain, not which class to use.
        if (existing) {
          existing.required = existing.required || Boolean(p.$required);
          continue;
        }
        into.set(name, {
          name,
          title: p.title ?? null,
          // ⚠ Kestra's descriptions carry raw HTML anchors. Stripped here rather
          // than rendered: a client that interprets them is rendering markup
          // from a third-party plugin manifest.
          description: stripTags(p.description ?? null),
          type: p.type ?? "string",
          required: Boolean(p.$required),
          source: isDeclared ? "declared" : "inferred",
        });
      }
    }
  }

  // ⚠ The heuristic is used ONLY when the author classified nothing. A plugin
  // that uses `$group` is taken at its word — otherwise a name match would add
  // fields alongside the author's own list, and the two would read as one.
  const chosen = declared.size > 0 ? declared : inferred;
  const fields = [...chosen.values()].sort(
    (a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name),
  );
  return { fields, read };
}

/** One field this plugin needs in order to connect, and how that was established. */
export type PluginCredentialField = {
  name: string;
  title: string | null;
  description: string | null;
  type: string;
  required: boolean;
  /**
   * ⚠ `declared` — the plugin's author marked it `$group: "connection"`.
   * `inferred` — matched by NAME because this plugin classifies nothing. The
   * difference is rendered; a guess presented as the author's word is the
   * failure mode this field exists to prevent.
   */
  source: "declared" | "inferred";
};

export type PluginCredentialsView = {
  plugin: string;
  /** False when the engine could not be read — never a silently empty field list. */
  reachable: boolean;
  fields: PluginCredentialField[];
  /** How many classes were actually asked about, and out of how many. Both, always. */
  classesRead: number;
  classesTotal: number;
  /** ⚠ Whether a flow in this product can call this plugin AT ALL. False for every non-core plugin today. */
  usableToday: boolean;
  notes: string[];
  detail?: string;
};

/** Kestra's property descriptions carry raw HTML anchors; a client must not render them. */
function stripTags(s: string | null): string | null {
  if (!s) return null;
  const out = s.replace(/<[^>]*>/g, "").trim();
  return out.length ? out : null;
}
