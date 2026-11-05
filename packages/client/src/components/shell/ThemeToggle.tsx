// src/components/shell/ThemeToggle.tsx — the theme control.
//
// ⚠ THIS IS NOT ITS FINAL HOME. It belongs in the topbar built in Phase 3 of
// `ui-upgrade`; it sits in the sidebar foot until then so the light theme
// is reachable — and therefore testable — in the phase that introduces it. A
// theme nobody can switch to is a theme nobody has looked at.
"use client";

import { useEffect, useState } from "react";
import { applyTheme, currentTheme, type Theme } from "@/lib/theme";
import { Sun, Moon } from "@/components/ui/icons";

/**
 * A two-state switch between the dark and earth themes.
 *
 * ⚠ It renders `null` until mounted, and that is deliberate rather than lazy.
 * The active theme lives in an attribute the pre-paint script wrote in the
 * browser; the server has no way to know it, so rendering a label on the server
 * means rendering the wrong one about half the time and then correcting it —
 * a hydration mismatch whose symptom is the control flickering the opposite
 * word on every load. Nothing else on screen depends on this element's size, so
 * an empty first frame costs nothing.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => setTheme(currentTheme()), []);

  if (theme === null) return null;

  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      // The accessible name says what the button DOES, not what is currently on
      // — "Dark theme" as a label on a control that switches to light is the
      // ambiguity that makes a toggle unusable without sight of the screen.
      aria-label={`Switch to ${next === "light" ? "earth (light)" : "dark"} theme`}
      title={`Switch to ${next === "light" ? "earth" : "dark"} theme`}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
    >
      {next === "light" ? <Sun s={16} /> : <Moon s={16} />}
    </button>
  );
}
