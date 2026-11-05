// @vitest-environment jsdom
//
// src/app/record-pages.test.tsx — does each record page open THE RECORD IT WAS ASKED FOR?
//
// ── The gap this closes ──────────────────────────────────────────────────────
// `routes.smoke.test.tsx` renders every page with an id but cannot tell whether the page used it: every `@/lib/api` call hangs
// and the assertion is only "did not throw". The Next 14 → 16 upgrade changes HOW a page learns its id (a plain `params` prop
// on 14, a Promise on 15, the synchronous form gone on 16), and the failure is not a throw — it is a page that asks for record
// `undefined` and shows an empty or "not found" state. This test asserts the id actually reaches the thing that loads or
// labels the record.
//
// ⚠ The id is supplied BOTH ways — as the `params` prop (in a shape that reads as an object AND as a Promise) and through
// `useParams()` — so the same test is green before the upgrade (page reads the prop) and after it (page reads the hook), and
// goes red only when a page reads its id from neither. See `lib/test-dual-params.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { dualParams } from "@/lib/test-dual-params";

const ID = "rec-42";

const spies = vi.hoisted(() => ({
  getFlowDetail: vi.fn(),
  getConnection: vi.fn(),
  getConnectionMetadata: vi.fn(),
  openFlowStream: vi.fn(),
  routeParams: { current: {} as Record<string, string> },
}));

vi.mock("@/lib/api", () => {
  const hang = () => new Promise(() => {});
  const known: Record<string, unknown> = {
    getFlowDetail: (...a: unknown[]) => { spies.getFlowDetail(...a); return hang(); },
    getConnection: (...a: unknown[]) => { spies.getConnection(...a); return hang(); },
    getConnectionMetadata: (...a: unknown[]) => { spies.getConnectionMetadata(...a); return hang(); },
  };
  return new Proxy({}, {
    has: () => true,
    get: (_t, prop) => {
      if (typeof prop === "symbol" || prop === "then" || prop === "default") return undefined;
      if (prop === "__esModule") return true;
      return (known[prop as string] as unknown) ?? hang;
    },
  });
});
vi.mock("@/lib/flow-stream", () => ({
  openFlowStream: (...a: unknown[]) => { spies.openFlowStream(...a); return { close: () => {} }; },
  isLive: () => false,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => spies.routeParams.current,
  useSelectedLayoutSegment: () => null,
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { name: "t", email: "t@example.com" }, ready: true, signOut: vi.fn() }) }));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }) }));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); }, ToastProvider: ({ children }: { children: React.ReactNode }) => children }));

class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (RO as never);
if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
}
globalThis.DOMMatrixReadOnly = globalThis.DOMMatrixReadOnly ?? (class {} as never);

beforeEach(() => {
  for (const s of [spies.getFlowDetail, spies.getConnection, spies.getConnectionMetadata, spies.openFlowStream]) s.mockClear();
  spies.routeParams.current = { id: ID };
});
afterEach(() => cleanup());

async function open(load: () => Promise<{ default: React.ComponentType<never> }>) {
  const { default: Page } = await load();
  const Any = Page as unknown as React.ComponentType<{ params: unknown }>;
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return render(<Any params={dualParams({ id: ID })} />);
  } finally {
    quiet.mockRestore();
  }
}

describe("a record page opens the record it was asked for", () => {
  it("/flows/[id] loads THAT workflow", async () => {
    await open(() => import("./(app)/flows/[id]/page"));
    expect(spies.getFlowDetail).toHaveBeenCalledWith(ID);
  });

  it("/flows/[id]/builder loads THAT workflow", async () => {
    await open(() => import("./(app)/flows/[id]/builder/page"));
    expect(spies.getFlowDetail).toHaveBeenCalledWith(ID);
  });

  it("/runs/[id] streams THAT run", async () => {
    await open(() => import("./(app)/runs/[id]/page"));
    expect(spies.openFlowStream).toHaveBeenCalled();
    expect(spies.openFlowStream.mock.calls[0][0]).toBe(ID);
  });

  it("/resources/[id] loads THAT resource and its metadata", async () => {
    await open(() => import("./(app)/resources/[id]/page"));
    expect(spies.getConnection).toHaveBeenCalledWith(ID);
    expect(spies.getConnectionMetadata).toHaveBeenCalledWith(ID);
  });

  it("/data-sources/[id] loads THAT data source", async () => {
    await open(() => import("./(app)/data-sources/[id]/page"));
    expect(spies.getConnection).toHaveBeenCalledWith(ID);
  });

  it("/resources/[id]/impact labels THAT resource, not the worked example", async () => {
    const { container } = await open(() => import("./(app)/resources/[id]/impact/page"));
    expect(container.textContent).toContain("REC 42");
  });

  it("/approvals/[id] labels THAT approval, not the pack's default", async () => {
    const { container } = await open(() => import("./(app)/approvals/[id]/page"));
    expect(container.textContent).toContain(ID);
  });
});

describe("CONTROL — the assertions can tell one id from another", () => {
  it("a different id reaches the loader as that id", async () => {
    spies.routeParams.current = { id: "other-7" };
    const { default: Page } = await import("./(app)/flows/[id]/page");
    const Any = Page as unknown as React.ComponentType<{ params: unknown }>;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<Any params={dualParams({ id: "other-7" })} />);
    } finally {
      quiet.mockRestore();
    }
    expect(spies.getFlowDetail).toHaveBeenCalledWith("other-7");
    expect(spies.getFlowDetail).not.toHaveBeenCalledWith(ID);
  });
});
