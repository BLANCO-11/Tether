// @vitest-environment jsdom
//
// src/lib/workspace-resolve.test.ts — which workspace a REQUEST is scoped to.
// platform-coherence Phase 1.6, I-103, D-113.
//
// ── ⚠ IT ASSERTS ON THE URL, NOT ON THE CONTEXT VALUE ───────────────────────
//
// This is the whole point of the file. Before Phase 1 the context value was
// always right: `useWorkspace().workspaceId` changed on a switch, the topbar
// showed the new name, and `app/(app)/layout.tsx` keyed `<main>` on it so every
// page visibly remounted and refetched. A test on the context would have passed
// throughout. What was wrong was the id the refetch CARRIED — `lib/api.ts`
// resolves through `resolveWorkspaceId()`, whose cache the switch never touched.
//
// So every assertion here reads the path a stubbed `fetch` was called with. A
// display test could not have caught I-103 and cannot catch its return.
//
// ⚠ And the sharpest one is the WRITE. A list showing the wrong rows is a bug
// you can see; `createTool` posting into the workspace you switched away from is
// data misplacement, with the topbar naming the other one the entire time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

/** `created_at DESC`, exactly as the server returns it — so A is the OLDEST. */
const SPACES = [
  { id: WS_B, name: "Finance", description: null, kind: null, createdAt: "2026-02-01T00:00:00Z" },
  { id: WS_A, name: "HR", description: null, kind: null, createdAt: "2026-01-01T00:00:00Z" },
];

let paths: string[] = [];

/**
 * Routes on the proxy path and records every URL. Anything not named here is a
 * failure rather than an empty object: a silent `{}` for an unexpected call is
 * how a test starts asserting about a request that never happened.
 */
function stubFetch(config: { workspaceId?: string; workspaceName?: string } = {}) {
  return vi.fn(async (url: string) => {
    paths.push(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url === "/api/foundry-config") return json(config);
    if (url === "/api/foundry/workspaces") return json({ workspaces: SPACES });
    if (/\/tools$/.test(url)) return json({ tools: [], tool: { id: "t-1" } });
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

/**
 * A fresh copy of the module graph per test.
 *
 * ⚠ `_wsId` is module-level and deliberately has no reset export — a test-only
 * escape hatch on the one cache this defect lives in is a second way to write it.
 * `vi.resetModules()` gives a clean instance without adding one to the product.
 */
async function load() {
  vi.resetModules();
  return {
    api: await import("@/lib/api"),
    fc: await import("@/lib/foundry-client"),
    choice: await import("@/lib/workspace-choice"),
  };
}

/** The workspace id in `/api/foundry/workspaces/<id>/…`, or null. */
function scopeOf(path: string): string | null {
  return /\/api\/foundry\/workspaces\/([^/]+)\//.exec(path)?.[1] ?? null;
}

beforeEach(() => {
  paths = [];
  window.localStorage.clear();
  vi.stubGlobal("fetch", stubFetch());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("platform-coherence 1 — a call is scoped to the workspace on screen", () => {
  it("resolves to the OLDEST workspace when nobody has chosen", async () => {
    // Not `list[0]`. The server orders `created_at DESC`, so newest-wins would
    // mean creating any workspace silently repoints the whole UI at it — which
    // it once did, on 2026-07-26.
    const { api } = await load();
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_A);
  });

  it("honours a stored choice over the oldest workspace", async () => {
    const { api, choice } = await load();
    choice.storeWorkspaceChoice(WS_B);
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_B);
  });

  it("puts the person's choice ABOVE the deployment's pinned default", async () => {
    // The env settings pin where you LAND, not where you stay. One that outranks
    // the switcher makes the switcher a control that cannot work — I-103 again
    // with a different cause.
    vi.stubGlobal("fetch", stubFetch({ workspaceId: WS_A }));
    const { api, choice } = await load();
    choice.storeWorkspaceChoice(WS_B);
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_B);
  });

  it("uses the pinned default when nobody has chosen", async () => {
    // The control for the test above: without it, "the choice wins" would also
    // pass against a resolver that ignored the config entirely.
    vi.stubGlobal("fetch", stubFetch({ workspaceId: WS_B }));
    const { api } = await load();
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_B);
  });

  it("forgets a stored choice that no longer resolves", async () => {
    // A workspace deleted from another tab, or a browser profile carried to a
    // different deployment. Pinning to it would 404 every scoped call while the
    // topbar still named it.
    const { api, choice } = await load();
    choice.storeWorkspaceChoice("33333333-3333-4333-8333-333333333333");
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_A);
    expect(choice.storedWorkspaceChoice()).toBeNull();
  });

  it("switching mid-page changes what the NEXT call is scoped to", async () => {
    // ⚠ Phase 1.2, and the half that tests green without the fix if you reload
    // between the two calls. `_wsId` is assigned once for the life of the page.
    const { api, fc } = await load();
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_A);

    fc.adoptWorkspaceId(WS_B);

    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_B);
  });

  it("a tool created after a switch is created in the workspace on screen", async () => {
    // The data-misplacement half. This is the assertion the exit criterion is
    // written around, and the one no display test could make.
    const { api, fc } = await load();
    await api.listTools();
    fc.adoptWorkspaceId(WS_B);

    await api.createTool({
      name: "ticket_create",
      description: "Raise a ticket",
      app: "Ticketing",
      type: "changes data",
      endpoint: "https://ops.example/tickets",
    });

    const posted = paths.filter((p) => /\/tools$/.test(p)).at(-1)!;
    expect(scopeOf(posted)).toBe(WS_B);
    expect(scopeOf(posted)).not.toBe(WS_A);
  });

  it("the display id agrees with the id the calls carry", async () => {
    // `activeFoundryWorkspaceId()` is what four flow components build links
    // from. If it and the resolver could differ, a link would point at a run in
    // a workspace the page is not showing.
    const { api, fc } = await load();
    await api.listTools();
    expect(fc.activeFoundryWorkspaceId()).toBe(scopeOf(paths.at(-1)!));
    fc.adoptWorkspaceId(WS_B);
    expect(fc.activeFoundryWorkspaceId()).toBe(WS_B);
  });

  it("a switch during an in-flight resolve does not get overwritten by it", async () => {
    // The race the generation counter exists for: a resolve started before the
    // switch lands after it. Its own caller may legitimately still get the old
    // id — the call was made in the old workspace — but it must not repoint
    // everything that follows.
    const { api, fc } = await load();
    const inflight = api.listTools();
    fc.adoptWorkspaceId(WS_B);
    await inflight;
    expect(fc.activeFoundryWorkspaceId()).toBe(WS_B);
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_B);
  });
});

describe("restricted workspaces (phase 4) — a workspace you are outside of is never one you are in", () => {
  const WS_CLOSED = "99999999-9999-4999-8999-999999999999";
  // Last, where the oldest-workspace fallback looks, and stored as the choice: both ways it could be picked.
  const withStub = [...SPACES, { id: WS_CLOSED, name: "Board", restricted: true, closed: true, admins: ["ada@acme.example"] }];
  const stubWithClosed = () =>
    vi.fn(async (url: string) => {
      paths.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "/api/foundry-config") return json({});
      if (url === "/api/foundry/workspaces") return json({ workspaces: withStub });
      if (/\/tools$/.test(url)) return json({ tools: [] });
      throw new Error(`unstubbed fetch: ${url}`);
    });

  it("is not resolved as the active workspace, even when it was the stored choice", async () => {
    vi.stubGlobal("fetch", stubWithClosed());
    const { api, choice } = await load();
    choice.storeWorkspaceChoice(WS_CLOSED);
    await api.listTools();
    expect(scopeOf(paths.at(-1)!)).toBe(WS_A);
  });

  it("is not listed as a workspace, and is listed as a closed one", async () => {
    vi.stubGlobal("fetch", stubWithClosed());
    const { api } = await load();
    expect((await api.listWorkspaces()).map((w) => w.id)).toEqual([WS_B, WS_A]);
    expect(await api.listClosedWorkspaces()).toEqual([{ id: WS_CLOSED, name: "Board", admins: ["ada@acme.example"] }]);
  });
});
