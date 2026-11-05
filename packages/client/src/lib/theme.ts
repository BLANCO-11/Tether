// src/lib/theme.ts — the two themes, the one place that decides which is on.
//
// ── WHY THE CHOICE IS STAMPED BEFORE FIRST PAINT ────────────────────────────
//
// `globals.css` resolves the theme from `:root[data-theme]`, with the OS
// preference as a guarded fallback. That means the attribute has to be on the
// element BEFORE the first paint, and a `useEffect` cannot be: it runs after
// hydration, so a person who has chosen light sees a full dark frame first, on
// every navigation. On a light-preferring machine the flash is the whole screen
// going near-black and back.
//
// Next 14's App Router gives exactly one hook early enough — a synchronous
// inline `<script>` in `<head>`. `THEME_BOOT_SCRIPT` is that script, and it is a
// string rather than a function because it must be serialised into the document,
// not bundled and executed later.
//
// ⚠ The boot script and `applyTheme()` below must agree on the fallback ORDER:
//   stored choice → OS preference → dark.
// If they disagree, the pre-paint attribute and the post-hydration one differ,
// and the flash comes back with an extra step in it.
//
// ⚠ The script fails SOFT. `localStorage` throws in a partitioned iframe and
// under some privacy settings; if it does, no attribute is set and the CSS media
// query decides. Never make this throw — it runs before React and would take the
// whole document with it.

export type Theme = "dark" | "light";

/** The one key. Namespaced so it cannot collide with anything else on the origin. */
export const THEME_STORAGE_KEY = "foundry.theme";

/**
 * The pre-paint stamper, as source. Injected via `dangerouslySetInnerHTML` in
 * `app/layout.tsx`'s `<head>`.
 *
 * ⚠ This is a static literal with no interpolation of any kind, which is what
 * makes the `dangerouslySetInnerHTML` at the call site safe. It must stay that
 * way: the moment a value from anywhere is concatenated into it, the call site
 * becomes an injection point in the one script that runs before every defence.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");var t=(s==="light"||s==="dark")?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

/** What the OS is asking for, with dark as the answer when it will not say. */
export function osTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * The theme in effect right now — read off the attribute the boot script wrote,
 * so this agrees with what is actually on screen rather than re-deriving it.
 */
export function currentTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return osTheme();
}

/**
 * Switch, and remember. Writing the attribute is what changes the screen; the
 * `localStorage` write is only what makes it survive a reload — so the order
 * matters if storage throws, and the visible change happens first.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable: the choice holds for this document and is forgotten
    // on reload. Silently, because there is nothing the person can do about it
    // and a toast on every theme switch is worse than a forgotten preference.
  }
}
