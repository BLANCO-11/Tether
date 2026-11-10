import { readFileSync } from "node:fs";

// The release version shown beside "Beta" — the ROOT package.json's, which `scripts/release.sh` sets in the same commit it tags, so
// the screen, the commit and the tag always agree. Inlined at build (the web image copies the root package.json).
const appVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: appVersion },

  async redirects() {
    return [
      { source: "/home", destination: "/dashboard", permanent: false },
      // ── Pack → Foundry route aliases (Phase 03, 04 nav table) ─────────────
      // Sidebar now speaks the pack's hrefs; the pages still live at Foundry's
      // legacy paths. These keep every rail link live until the page moves.
      // Remove each entry when its destination page is rebuilt at the pack path.
      // Specific template bookmarks must 308 before the wildcard aliases below.
      { source: "/create/templates", destination: "/chats/new", permanent: true },
      { source: "/workflows/templates", destination: "/flows/new", permanent: true },
      { source: "/workflows", destination: "/flows", permanent: false },
      { source: "/workflows/:path*", destination: "/flows/:path*", permanent: false },
      { source: "/runs", destination: "/history", permanent: false },
      // `/reports` is a real page now (Dashboards & Reports, pi-runtime P-OBS) — no alias.
      // ⚠ `/admin` and `/incidents` have no entries here on purpose: both are
      // real pages now (`(app)/admin/page.tsx` is the overview, `(app)/incidents`
      // redirects to the canonical `/admin/incidents`). A config redirect would
      // shadow the page.
      { source: "/create", destination: "/chats/new", permanent: false },
      { source: "/create/:path*", destination: "/chats/new", permanent: false },

      // ── Personal fork: enterprise surfaces → Home ─────────────────────────
      // Admin / org / incidents / reports stay in the tree for now but are not
      // product. See packages/client/src/lib/personal.ts.
      { source: "/admin", destination: "/dashboard", permanent: false },
      // /admin/users is the allowlist admin page: deliberately not redirected.
      { source: "/admin/:path((?!users).*)", destination: "/dashboard", permanent: false },
      { source: "/organization", destination: "/dashboard", permanent: false },
      { source: "/organization/:path*", destination: "/dashboard", permanent: false },
      { source: "/incidents", destination: "/dashboard", permanent: false },
      { source: "/incidents/:path*", destination: "/dashboard", permanent: false },
      { source: "/reports", destination: "/dashboard", permanent: false },
      { source: "/reports/:path*", destination: "/dashboard", permanent: false },
    ];
  },
};

export default nextConfig;
