// @vitest-environment jsdom
//
// src/app/routes.smoke.test.tsx — does every page still render at all?
// Programme 3, Stage 2 exit criterion.
//
// ── The gap this closes, stated precisely ────────────────────────────────────
//
// `/flows/[id]` and `/runs/[id]` were written the Next 15 way — `params:
// Promise<…>` unwrapped with `use()` — against the Next 14.2.15 this repo pins.
// Every load threw React error #438 and rendered "Application error: a
// client-side exception has occurred". It survived TWO DAYS with 400+ assertions
// green, because not one of them rendered a React component: `e2e:ui` speaks
// HTTP, `ui-honesty-check.sh` greps source, and every vitest suite was
// server-side.
//
// ⚠ What this test does and does not cover, because a smoke test that is
// believed to cover more than it does is worse than none:
//
//   COVERS  — a page that throws on its FIRST render, before any data arrives.
//             That is the entire `use(params)` class, every bad hook call, every
//             missing provider, every import that blows up at module scope.
//   COVERS  — a page that throws while rendering its loading state.
//   DOES NOT— a page that throws only for particular data. Every `@/lib/api`
//             call here hangs for ever, so the loading branch is what renders.
//             Data-shaped crashes are the job of `components.smoke.test.tsx`
//             beside this file, which renders the flow components against real
//             fixtures.
//   DOES NOT— layout, styling, or anything a headless DOM cannot see.
//
// A real browser (Playwright) would cover more and is deliberately not used: it
// needs a downloaded browser, a running server and a seeded database, which
// makes it a thing that gets skipped. This runs in the same `pnpm test` as
// everything else, in under a second, so it actually runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { dualParams } from "@/lib/test-dual-params";

// The id a dynamic route is rendered with, read back by the mocked `useParams()` below. Set per route in the loop.
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));

// ── The seams every page reaches through ─────────────────────────────────────

// `@/lib/api` is mocked wholesale with a proxy: every named export becomes a
// function returning a promise that never settles. Deliberately never-settling
// rather than resolving a stub — a stub would need a plausible shape per
// function (70+ of them), and the first one to drift would make this suite fail
// for a reason that is not a bug in the page.
vi.mock("@/lib/api", () => {
  const hang = () => new Promise(() => {});
  return new Proxy(
    {},
    {
      // Vitest wraps the factory's result and refuses any property it cannot
      // see, with "No <name> export is defined on the mock". A catch-all `get`
      // is not enough — it has to answer `in` as well.
      has: () => true,
      get: (_t, prop) => {
        // ⚠ `then` MUST come back undefined. A module namespace with a callable
        // `then` is a thenable, and vitest awaits the factory's result — so a
        // catch-all proxy makes `await import("@/lib/api")` hang for ever. It
        // presents as every page timing out with no error, which reads like the
        // pages are looping rather than like the mock being wrong. Symbols get
        // the same treatment for the same class of reason.
        if (typeof prop === "symbol" || prop === "then" || prop === "default") return undefined;
        if (prop === "__esModule") return true;
        return hang;
      },
    },
  );
});

// Same reasoning, one level lower: `/runs/[id]` opens a stream rather than
// calling `@/lib/api`.
vi.mock("@/lib/flow-stream", () => ({
  openFlowStream: () => ({ close: () => {} }),
  isLive: () => false,
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  // ⚠ Enumerated rather than proxied. `next/navigation` is a real module with a
  // fixed surface, and a page reaching for a hook that is NOT in this list is
  // information — most likely an App Router API that behaves differently on the
  // pinned Next 14, which is the exact class of bug this suite exists for.
  useParams: () => routeParams.current,
  useSelectedLayoutSegment: () => null,
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { name: "tester", email: "tester@example.com" }, ready: true, signOut: vi.fn() }),
}));

vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
  useResolvedWorkspace: () => "ws-1",
}));

vi.mock("@/lib/toast", () => ({
  useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); },
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// jsdom has no layout engine, so React Flow measures a 0×0 container and warns.
// The warning is correct and irrelevant here — this suite asks whether the tree
// renders, not whether it is laid out. ResizeObserver simply does not exist in
// jsdom and React Flow calls it unconditionally.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (RO as never);
if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
}
globalThis.DOMMatrixReadOnly = globalThis.DOMMatrixReadOnly ?? (class {} as never);

afterEach(() => cleanup());

// ── The routes ───────────────────────────────────────────────────────────────
//
// Every page under `(app)`. Dynamic routes are given their id BOTH ways — as the `params` prop, in a value that reads as an
// object AND as a Promise (`lib/test-dual-params.ts`), and through the mocked `useParams()` — so this suite is green on both
// sides of the Next 14 → 16 upgrade and still fails a page that cannot read its id: a page that unwraps `params` with `use()`
// on React 18 throws here, immediately, the way it threw in the browser. `record-pages.test.tsx` asserts the id is USED.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PageModule = { default: React.ComponentType<any> };

const ROUTES: Array<{ path: string; load: () => Promise<PageModule>; props?: Record<string, unknown> }> = [
  // ⚠ `/home` is GONE — deleted 2026-08-04, restored 2026-08-05, deleted again
  // 2026-08-06 (`ui-upgrade` D-81). `/dashboard` is now the landing page
  // AND the `Dashboard` nav row.
  //
  // ⚠ NO COUNT IS WRITTEN HERE, deliberately. This comment used to say "18
  // routes, not 19" and the list was 16 — a number in a comment cannot fail, so
  // it drifted while `/live` was added with no entry at all and nothing said so.
  // `ui-honesty-check.sh` derives the count by walking the filesystem and
  // compares it against this list, which is the check that caught the omission;
  // restating the number here only gives it somewhere else to be wrong.
  { path: "/dashboard", load: () => import("./(app)/dashboard/page") },
  // Personal thin: /reports purged (redirect only).
  { path: "/chats", load: () => import("./(app)/chats/page") },
  // Sharing boundaries: a chat read, not opened.
  { path: "/chats/new", load: () => import("./(app)/chats/new/page") },
  { path: "/chats/[id]", load: () => import("./(app)/chats/[id]/page"), props: { params: { id: "c-1" } } },
  // Sharing boundaries phase 5: projects.
  { path: "/projects", load: () => import("./(app)/projects/page") },
  { path: "/projects/[id]", load: () => import("./(app)/projects/[id]/page"), props: { params: { id: "p-1" } } },
  { path: "/memory", load: () => import("./(app)/memory/page") },
  { path: "/history", load: () => import("./(app)/history/page") },
  { path: "/approvals", load: () => import("./(app)/approvals/page") },
  {
    path: "/approvals/[id]",
    load: () => import("./(app)/approvals/[id]/page"),
    props: { params: { id: "a-1" } },
  },
  { path: "/flows", load: () => import("./(app)/flows/page") },
  // The approved subset, runnable now (D-37). It renders a "Run now" form, so
  // its first render reaches `@/lib/foundry-client` as well as `@/lib/api` —
  // unmocked, exactly like `/approvals` and `/ai-provider` above and below,
  // because a never-settling `@/lib/api` is what holds every page in its
  // loading branch and that is the branch this suite covers.
  { path: "/live", load: () => import("./(app)/live/page") },
  { path: "/flows/new", load: () => import("./(app)/flows/new/page") },
  { path: "/flows/[id]", load: () => import("./(app)/flows/[id]/page"), props: { params: { id: "f-1" } } },
  { path: "/flows/[id]/builder", load: () => import("./(app)/flows/[id]/builder/page"), props: { params: { id: "f-1" } } },
  { path: "/runs/[id]", load: () => import("./(app)/runs/[id]/page"), props: { params: { id: "r-1" } } },
  { path: "/tools", load: () => import("./(app)/tools/page") },
  { path: "/apps", load: () => import("./(app)/apps/page") },
  { path: "/apps/[piece]", load: () => import("./(app)/apps/[piece]/page"), props: { params: { piece: "amazon-s3" } } },
  { path: "/triggers", load: () => import("./(app)/triggers/page") },
  { path: "/keys", load: () => import("./(app)/keys/page") },
  { path: "/email-box", load: () => import("./(app)/email-box/page") },
  { path: "/ai-provider", load: () => import("./(app)/ai-provider/page") },
  { path: "/people", load: () => import("./(app)/people/page") },
  // Personal thin: /organization and /admin/* and /incidents/* purged (redirect only).
  // ⚠ RBAC: the page a refused person lands on. It must render for somebody who holds
  // NOTHING, so it is the one page whose smoke test is closest to its real audience.
  { path: "/no-access", load: () => import("./(app)/no-access/page") },
  { path: "/resources", load: () => import("./(app)/resources/page") },
  { path: "/resources/new", load: () => import("./(app)/resources/new/page") },
  {
    path: "/resources/[id]",
    load: () => import("./(app)/resources/[id]/page"),
    props: { params: { id: "c-1" } },
  },
  {
    path: "/resources/[id]/impact",
    load: () => import("./(app)/resources/[id]/impact/page"),
    props: { params: { id: "c-1" } },
  },
  { path: "/data-sources", load: () => import("./(app)/data-sources/page") },
  { path: "/data-sources/new", load: () => import("./(app)/data-sources/new/page") },
  {
    path: "/data-sources/[id]",
    load: () => import("./(app)/data-sources/[id]/page"),
    props: { params: { id: "ds-1" } },
  },
];

describe("every page renders", () => {
  for (const route of ROUTES) {
    it(`${route.path} does not throw`, async () => {
      const mod = await route.load();
      const Page = mod.default;
      // React logs a caught render error to console.error before rethrowing;
      // silenced so a genuine failure reads as one assertion rather than a wall
      // of component stack.
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      const given = (route.props?.params ?? {}) as Record<string, string>;
      routeParams.current = given;
      const props = route.props ? { ...route.props, params: dualParams(given) } : {};
      try {
        expect(() => render(<Page {...props} />)).not.toThrow();
      } finally {
        quiet.mockRestore();
      }
    });
  }
});

describe("the shell renders", () => {
  it("the authenticated layout does not throw", async () => {
    const { default: Layout } = await import("./(app)/layout");
    expect(() => render(<Layout>{null}</Layout>)).not.toThrow();
  });
});

// ⚠ A negative control. Without it, every assertion above would keep passing if
// `render` were ever changed to swallow errors, or if the mocks stopped
// resolving and `Page` became undefined — and a smoke test that cannot fail is
// worse than none. This exact trap fired for real in `backup-verify.sh` (I-38).
describe("the harness can fail", () => {
  it("a component that throws is caught by the same assertion", () => {
    const Boom = (): JSX.Element => {
      throw new Error("planted");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<Boom />)).toThrow(/planted/);
    } finally {
      quiet.mockRestore();
    }
  });
});
