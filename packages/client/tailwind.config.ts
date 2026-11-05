// tailwind.config.ts — Tailwind setup. Colors map to the CSS variables in globals.css
// so components never hard-code hex values.
import type { Config } from "tailwindcss";

/**
 * A colour token that takes an opacity modifier (2026-10-10). A raw "var(--x)" cannot carry one, and Tailwind
 * SILENTLY DROPS `border-line/50`, `bg-muted/10`, `bg-surface-2/40` … rather than generating them: 101 such uses in
 * this client rendered nothing — and a `border` whose colour class was dropped falls back to the preflight grey, which
 * is the bright "embossed" outline seen in dark mode. `color-mix` lets every token take an alpha with no RGB triplet;
 * with no modifier it is the token itself. `tailwind-tokens.test.ts` fails if a plain "var(--x)" colour comes back.
 */
// ⚠ Typed as a string because Tailwind's `Config` type lists only strings for a colour, while Tailwind ACCEPTS a
// function of `{ opacityValue }` at runtime (documented, and proven by the compiled CSS carrying `color-mix(…)`).
const mix = (token: string): string =>
  ((({ opacityValue }: { opacityValue?: string }) =>
    opacityValue === undefined || opacityValue === "1"
      ? `var(${token})`
      : `color-mix(in srgb, var(${token}) calc(${opacityValue} * 100%), transparent)`) as unknown as string);

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: mix("--bg"),
        // rgb(var(--x-rgb) / <alpha-value>) lets opacity modifiers work
        // (bg-accent/80); a raw var(--x) string can't take an alpha, and
        // Tailwind silently drops classes like bg-accent/80 instead of
        // generating them — invisible elements, no error.
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        "surface-2": mix("--surface-2"),
        "surface-raised": mix("--surface-2"),
        line: mix("--line"),
        // Hover border, inset well, dot grid, dashed outline. Each replaces a
        // literal that was already being written by hand somewhere.
        "line-2": mix("--line-2"),
        // ⚠ The only border on a control whose bounds are otherwise undefined —
        // inputs, selects, textareas, choice cards. It clears 3:1 where `line`
        // (a decorative hairline) does not, so `border-line-interactive` is an
        // accessibility choice and not a shade. See globals.css and
        // `ux-flow/02-design-language.md:25`.
        "line-interactive": mix("--line-interactive"),
        sunken: mix("--sunken"),
        dots: mix("--dots"),
        dash: mix("--dash"),
        text: mix("--text"),
        muted: mix("--muted"),
        dim: mix("--dim"),
        "muted-soft": mix("--muted-soft"),
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        // Accent as a tint, a border or secondary text. These are already
        // composed with their own alpha, so they take no opacity modifier —
        // which is why they are plain var() and not an rgb() triplet.
        "accent-bg": mix("--accent-bg"),
        "accent-bg-2": mix("--accent-bg-2"),
        "accent-line": mix("--accent-line"),
        "accent-soft": mix("--accent-soft"),
        // Text on a solid accent fill. It FLIPS between the themes, so it can
        // never be `text-black` or `text-white` — see the token's own note.
        "on-accent": mix("--on-accent"),
        // Character set (theme-mock): chalk · horizon · ember · mauve · sea
        chalk: mix("--chalk"),
        horizon: "rgb(var(--horizon-rgb) / <alpha-value>)",
        "horizon-soft": mix("--horizon-soft"),
        ember: "rgb(var(--ember-rgb) / <alpha-value>)",
        "ember-soft": mix("--ember-soft"),
        mauve: "rgb(var(--mauve-rgb) / <alpha-value>)",
        sea: "rgb(var(--sea-rgb) / <alpha-value>)",
        // CTA role (chalk↔ink) — separate from interactive --accent (horizon/slate)
        cta: "rgb(var(--cta-fill-rgb) / <alpha-value>)",
        "on-cta": mix("--on-cta"),
        info: mix("--info"),
        "info-bg": mix("--info-bg"),
        "info-line": mix("--info-line"),
        "badge-fg": mix("--badge-fg"),
        "badge-bg": mix("--badge-bg"),
        "badge-line": mix("--badge-line"),
        ok: "rgb(var(--ok-rgb) / <alpha-value>)",
        warn: "rgb(var(--warn-rgb) / <alpha-value>)",
        "warn-line": mix("--warn-line"),
        orange: "rgb(var(--orange-rgb) / <alpha-value>)",
        danger: "rgb(var(--danger-rgb) / <alpha-value>)",
        "danger-soft": mix("--danger-soft"),
        "danger-line": mix("--danger-line"),
        // Alpha-stage chrome. Never --warn: a permanent product disclaimer and
        // a live incident must not share a hue (D-86).
        alpha: mix("--alpha"),
        "alpha-bg": mix("--alpha-bg"),
        "alpha-line": mix("--alpha-line"),
        // The scrim behind a modal, and the canvas minimap's out-of-view mask.
        scrim: mix("--scrim"),
        mask: mix("--mask"),
        // Step kinds. Previously reachable only through inline style, which is
        // how the two canvas renderers drifted apart in the first place.
        "k-datasource": mix("--k-datasource"),
        "k-transform": mix("--k-transform"),
        "k-code": mix("--k-code"),
        "k-tool": mix("--k-tool"),
        "k-approval": mix("--k-approval"),
        "k-agent": mix("--k-agent"),
        "k-unknown": mix("--k-unknown"),
      },
      backgroundColor: {
        "ok-bg": "var(--ok-bg)",
        "warn-bg": "var(--warn-bg)",
        "orange-bg": "var(--orange-bg)",
        "danger-bg": "var(--danger-bg)",
      },
      // The three measures (D-78). A page picks one by ARCHETYPE — index,
      // detail and console take `page`; a single-record form takes `form`; the
      // workbench takes `wide`. ⚠ These exist so that `<Page measure>` is the
      // only thing that sets a width; a page reaching for `max-w-page` directly
      // is the old per-file free-for-all with tokenised names.
      maxWidth: {
        page: "var(--w-page)",
        form: "var(--w-form)",
        wide: "var(--w-wide)",
      },
      // The shell bar's height, so the one number the topbar and anything
      // sticking below it both need has exactly one definition (Phase 3.1).
      height: { topbar: "var(--topbar)" },
      boxShadow: { raised: "0 8px 28px -12px var(--shadow)" },
      borderRadius: { md: "8px", lg: "12px" },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      // ── The closed type scale (FR-012) ────────────────────────────────────
      // Seven steps, and nothing else may set a size. `xs`/`sm`/`lg`/`xl` are
      // Tailwind defaults (12/14/18/20px); the three below are the steps the
      // app had been writing as `text-[10px]`/`text-[11px]`/`text-[13px]` (and
      // the half-pixel `text-[11.5px]`/`text-[12.5px]`), now named. A surface
      // reaching for `text-[…px]` outside this scale is the hierarchy breaking.
      fontSize: {
        micro: ["10px", { lineHeight: "1.4" }],
        caption: ["11px", { lineHeight: "1.4" }],
        body: ["13px", { lineHeight: "1.5" }],
      },
      letterSpacing: { label: "0.08em" },
      // ── The motion vocabulary (FR-012) ────────────────────────────────────
      // Two durations and one easing curve; every transition in the app picks
      // one of these rather than a raw millisecond literal. `fast` for hover/
      // active feedback, `base` for layout movement (panels, tabs, folds).
      transitionDuration: {
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
      },
      transitionTimingFunction: {
        app: "var(--ease)",
      },
    },
  },
  plugins: [],
};

export default config;
