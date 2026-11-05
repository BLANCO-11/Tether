// @vitest-environment jsdom
//
// src/lib/theme.test.ts — the two themes, and the ways they silently half-work.
//
// ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
//
// A broken theme does not throw. Nothing logs, nothing 500s, no test that
// renders a component notices: the element is simply the wrong colour, or the
// same colour as its background, for whichever half of the users are on the
// theme the author was not looking at. Every assertion below is aimed at one of
// those silent halves.
//
// The four failure modes, and the assertion that catches each:
//
//   1. A token is applied in one light branch and not the other → the theme is
//      correct for whoever chose it explicitly and broken for whoever got it
//      from their OS. §"both light branches".
//   2. A `--l-*` value is declared and never wired to a live token → the light
//      theme silently inherits the dark value for that token. §"every light
//      value is wired".
//   3. A component reads `var(--something)` that no longer exists → the
//      property resolves to nothing, which for a colour means transparent.
//      §"every token a component reads".
//   4. The pre-paint script and the runtime switch disagree about the fallback
//      order → the attribute stamped before paint differs from the one React
//      settles on, and the flash the script exists to prevent comes back.
//      §"the boot script".
//
// ⚠ These read the CSS as TEXT. jsdom does not implement the cascade for custom
// properties across a media query, so there is no way to ask a rendered document
// "what is --bg here?" — and a test that pretended to would pass over an empty
// set, which is this repo's worst kind of green (ISSUES.md I-38).

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  currentTheme,
  osTheme,
} from "./theme";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8");

/** The declarations inside one rule, as `name → value`, whitespace normalised. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(name, value.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** The body of the first rule whose header matches, brace-counted. */
function ruleBody(header: string): string {
  const at = CSS.indexOf(header);
  expect(at, `globals.css no longer contains a rule starting \`${header}\``).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated rule for \`${header}\``);
}

const rootBlock = declarations(ruleBody(":root {"));
const mediaBlock = declarations(ruleBody('@media (prefers-color-scheme: light)'));
const attrBlock = declarations(ruleBody(':root[data-theme="light"]'));

describe("both light branches apply the same tokens", () => {
  // CSS cannot share one declaration block between a media query and an
  // attribute selector, so the light map is APPLIED twice. The values live once
  // (`--l-*`) and therefore cannot drift; these two lists can, and a token in
  // only one of them is the hardest theme bug to notice, because it is correct
  // for the person who reported it.
  it("declares an identical set of properties", () => {
    expect([...attrBlock.keys()].sort()).toEqual([...mediaBlock.keys()].sort());
  });

  it("gives every property the same value in both", () => {
    for (const [name, value] of mediaBlock) {
      expect(attrBlock.get(name), `${name} differs between the two light branches`).toBe(value);
    }
  });

  it("sets color-scheme in both, so native controls follow the tokens", () => {
    // A light page with dark scrollbars, a dark <select> popup and a dark date
    // picker is the tell that this was forgotten. It is one line and it is
    // invisible in a screenshot of the page body.
    expect(ruleBody("@media (prefers-color-scheme: light)")).toContain("color-scheme: light");
    expect(ruleBody(':root[data-theme="light"]')).toContain("color-scheme: light");
    expect(ruleBody(":root {")).toContain("color-scheme: dark");
  });

  it("guards the media query against an explicit dark choice", () => {
    // Without `:not([data-theme="dark"])`, someone on a light-mode OS who
    // explicitly picks dark gets light back: a media query and a plain attribute
    // selector have the same specificity and source order decides. See D-76.
    expect(CSS).toContain(':root:not([data-theme="dark"])');
  });

  it("has no third copy of the dark map", () => {
    // `[data-theme="dark"]` needs no block — the guard above already excludes
    // that case, so `:root`'s own values apply. A block here would be a second
    // definition of the dark palette, which is what this whole arrangement
    // exists to avoid.
    expect(CSS).not.toMatch(/:root\[data-theme="dark"\]\s*\{/);
  });
});

describe("every light value is wired to a live token", () => {
  const lightValues = [...rootBlock.keys()].filter((n) => n.startsWith("--l-"));

  it("declares a light palette at all", () => {
    // Guards the guard: if the naming convention changes, every assertion in
    // this block would otherwise iterate an empty list and pass.
    expect(lightValues.length).toBeGreaterThan(30);
  });

  it("points a live token at each one", () => {
    // A `--l-*` nobody reads is a light value that never reaches the screen —
    // the light theme quietly keeps the dark value for that token.
    for (const light of lightValues) {
      const live = `--${light.slice("--l-".length)}`;
      expect(mediaBlock.get(live), `${light} is declared but no token reads it`).toBe(
        `var(${light})`,
      );
    }
  });

  it("gives every applied token a dark value to fall back from", () => {
    // The reverse direction: a token the light branches set but `:root` does
    // not is a token with no dark value, so dark renders it as nothing.
    for (const name of mediaBlock.keys()) {
      expect(rootBlock.has(name), `${name} is set for light but has no dark value`).toBe(true);
    }
  });

  it("keeps the RGB triplets in step with the light theme", () => {
    // ⚠ Tailwind composes opacity onto the TRIPLET, not onto the hex — so a
    // light theme that forgets these leaves `bg-accent/80` rendering the dark
    // blue on a clay ground, and only the classes carrying an opacity modifier
    // are wrong. Half a component being off-theme reads as a design choice.
    for (const name of ["--surface-rgb", "--accent-rgb", "--ok-rgb", "--warn-rgb", "--orange-rgb", "--danger-rgb"]) {
      expect(mediaBlock.get(name), `${name} has no light value`).toBe(`var(--l${name.slice(1)})`);
    }
  });

  it("declares the three measures", () => {
    // D-78. Not a colour, but the same rule: a page that cannot reach a measure
    // by name will invent one.
    for (const m of ["--w-page", "--w-form", "--w-wide"]) {
      expect(rootBlock.has(m), `${m} is missing`).toBe(true);
    }
  });
});

describe("every token a component reads is declared", () => {
  // Failure mode 3, and it is silent in the worst way: an undefined custom
  // property resolves to nothing, and `color: ` nothing is transparent text.
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.(tsx?|css)$/.test(entry)) out.push(path);
    }
    return out;
  }

  /**
   * Comments out. Both this file and `globals.css` DISCUSS tokens in prose —
   * `var(--x-rgb)` in the config note, `var(--l-x)` in the pattern description —
   * and a scan that counted those would fire on the documentation rather than on
   * the code, which is the shape of guard that gets widened until it permits the
   * real defect (ISSUES.md I-62).
   */
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("finds no var(--x) with no declaration behind it", () => {
    const declared = new Set(rootBlock.keys());
    const missing = new Map<string, string>();
    for (const file of walk(SRC)) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      // A variable the SAME file sets inline (`style={{ "--kc": colour }}`) is declared, locally: a per-element value
      // read by that element's own classes. Only a name set nowhere is missing.
      const local = new Set([...text.matchAll(/["'](--[a-z0-9-]+)["']\s*:/g)].map((m) => m[1]!));
      // A stylesheet's own SCOPED declaration (`.pis-tree { --pis-row-bg: … }`) is declared too, just not on `:root`.
      if (file.endsWith(".css")) for (const m of text.matchAll(/[{;]\s*(--[a-z0-9-]+)\s*:/g)) local.add(m[1]!);
      for (const [, name, fallback] of text.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)) {
        if (local.has(name)) continue;
        // `var(--x, 400px)` names its own value when --x is unset, so it never resolves to nothing.
        if (fallback) continue;
        // The React Flow block re-points the library's OWN variables at ours;
        // `--xy-*` are declared by the library, not here.
        if (name.startsWith("--xy-")) continue;
        // Fonts are declared in a second `:root` rule further down the file.
        if (name === "--font-sans" || name === "--font-mono") continue;
        if (!declared.has(name)) missing.set(name, file.slice(SRC.length + 1));
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  it("finds nothing reading a --l-* value directly", () => {
    // `--l-*` is the light palette's storage, not an API. Reading one hardcodes
    // the light theme into a component, which is the same defect as a hex.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith("globals.css") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      if (/var\(--l-/.test(stripComments(readFileSync(file, "utf8")))) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the boot script", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  /** Run the real script string, the way `<head>` will. */
  const boot = () => new Function(THEME_BOOT_SCRIPT)();

  /** Point `matchMedia` at a fixed answer — jsdom has none by default. */
  function osSays(light: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (q: string) => ({
        matches: q.includes("light") ? light : !light,
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
  }

  it("prefers a stored choice over the OS", () => {
    osSays(true);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    boot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("falls back to the OS when nothing is stored", () => {
    osSays(true);
    boot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("falls back to dark when the OS says nothing", () => {
    osSays(false);
    boot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores a stored value that is not a theme", () => {
    // The key is on the origin and anything can write it. A junk value must
    // reach the OS fallback, not be stamped onto the element — `data-theme="{}"`
    // matches neither branch, so the page would render dark while the toggle
    // believed something else.
    osSays(true);
    localStorage.setItem(THEME_STORAGE_KEY, "{}");
    boot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("agrees with applyTheme about what it just decided", () => {
    // Failure mode 4. If these two ever disagree, the pre-paint attribute and
    // the post-hydration one differ and the flash comes back with an extra step.
    osSays(false);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    boot();
    expect(currentTheme()).toBe("light");
    applyTheme("dark");
    expect(currentTheme()).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("interpolates nothing, so injecting it raw is safe", () => {
    // The script goes into the document through `dangerouslySetInnerHTML`. That
    // is safe only while it is a constant. This asserts the property the call
    // site depends on rather than trusting a comment.
    expect(THEME_BOOT_SCRIPT).not.toMatch(/\$\{/);
    expect(THEME_BOOT_SCRIPT).not.toContain("</script");
    expect(THEME_BOOT_SCRIPT).toContain(THEME_STORAGE_KEY);
  });

  it("survives storage throwing", () => {
    // Partitioned iframes and some privacy settings throw on access. This runs
    // before React; if it throws it takes the document with it.
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    osSays(true);
    expect(() => boot()).not.toThrow();
    // No attribute set — the CSS media query decides, which is the right
    // fallback rather than a guess.
    expect(document.documentElement.getAttribute("data-theme")).toBe(null);
    if (original) Object.defineProperty(window, "localStorage", original);
  });

  it("reports the OS honestly when matchMedia is absent", () => {
    // @ts-expect-error — deleting a DOM global on purpose.
    delete window.matchMedia;
    expect(osTheme()).toBe("dark");
  });
});

describe("card depth reaches the canvas and the panel", () => {
  // The `--card-*` role tokens only segment a theme that actually paints with
  // them. The wiring (both light branches, dark fallback) is covered above;
  // this pins the two call sites the redesign owns.
  it("paints the node card and the step pane from the role tokens", () => {
    expect(CSS).toMatch(/\.node-card\s*\{[^}]*var\(--card-bg\)/);
    expect(CSS).toMatch(/\.step-pane\s*\{[^}]*var\(--card-bg\)/);
    expect(readFileSync(join(SRC, "components/flow/FlowCanvas.tsx"), "utf8")).toContain("node-card");
    expect(readFileSync(join(SRC, "components/flow/builder/StepPanel.tsx"), "utf8")).toContain("step-pane");
  });
});
