// src/app/layout.tsx — root layout: loads self-hosted fonts (no external requests,
// so it works on locked-down networks), stamps the theme before first paint, and
// wraps the app in the auth + toast providers.
import type { Metadata } from "next";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
// Self-hosted fonts (bundled via @fontsource) — the weights the UI actually uses.
import "@fontsource/ibm-plex-sans/300.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider } from "@/lib/workspace";
import { ToastProvider } from "@/lib/toast";

// ⚠ The title is the PRODUCT NAME. It read `Foundry-Alpha-V1` and the stage
// moved to `components/shell/AlphaChip` — which is a handle onto the per-page
// disclosure rather than a word in a tab nobody reads. A suffix here is the
// weakest possible place to declare a maturity: it is decoration, it is what
// travels into screenshots and links, and it cannot say WHICH parts are alpha.
// The disclosure itself is on every page and did not move (D-86).
export const metadata: Metadata = {
  title: "Foundry — Automation Studio",
  description: "Enterprise automation — onboard resources and build automations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* ⚠ Runs before the first paint, and it has to. `globals.css` resolves
            the theme from `:root[data-theme]`; an effect that stamps the
            attribute after hydration is a visible flash of the wrong theme on
            every navigation. See `lib/theme.ts` for the fallback order and for
            why this is a static string — the value is a module constant with no
            interpolation, which is what makes the raw injection below safe. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <AuthProvider>
          <WorkspaceProvider>
            <ToastProvider>{children}</ToastProvider>
          </WorkspaceProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
