// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Sidebar, groups } from "./Sidebar";

/**
 * Personal Foundry fork — rail tests.
 * Enterprise Admin / Reports chrome is thinned out; AI models stays as settings.
 */

vi.mock("@/lib/api", () => ({
  getMe: vi.fn(),
  listPendingApprovals: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { name: "A", email: "a@x.test" }, signOut: vi.fn() }),
}));
vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ workspaceId: "ws-1" }) }));
vi.mock("@/lib/activity", () => ({ useActivityEpoch: () => 0 }));

const api = await import("@/lib/api");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listPendingApprovals).mockResolvedValue([]);
});
afterEach(cleanup);

const me = (superAdmin: boolean, canViewReports = false, userAdmin?: boolean) => ({
  subject: "oid-x",
  email: "x@x.test",
  superAdmin,
  superAdminConfigured: true,
  canViewReports,
  userAdmin,
});

describe("Sidebar — personal fork thins enterprise Admin", () => {
  it("does not offer Admin even to a super admin", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(true));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Workflows")).toBeTruthy());
    expect(screen.queryByText("Admin")).toBeNull();
  });

  it("offers AI models as personal settings", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("AI models")).toBeTruthy());
  });
});

describe("Sidebar — Users link", () => {
  it("shows Users to a user admin", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false, false, true));
    render(<Sidebar />);
    await waitFor(() => expect(document.querySelector('a[href="/admin/users"]')).toBeTruthy());
  });

  it.each([false, undefined])("hides Users when userAdmin is %s", async (ua) => {
    vi.mocked(api.getMe).mockResolvedValue(me(false, false, ua));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Workflows")).toBeTruthy());
    expect(document.querySelector('a[href="/admin/users"]')).toBeNull();
  });
});

describe("Sidebar — personal rail sanity", () => {
  it("renders New chat and the personal product rows", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false, true));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("New chat")).toBeTruthy());
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Workflows")).toBeTruthy();
    expect(screen.getByText("Chats")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByText("Approvals")).toBeTruthy();
    expect(screen.getByText("Runs & Activity")).toBeTruthy();
    expect(screen.queryByText("Dashboards & Reports")).toBeNull();
    expect(screen.queryByText("Admin")).toBeNull();
  });
});

describe("Sidebar — every static page is reachable, or exempt with a reason", () => {
  /** Reached from somewhere other than the rail — or removed from the personal product. */
  const NOT_A_RAIL_DESTINATION: Record<string, string> = {
    "/live": "opened from a run, not browsed to",
    "/flows/new": "an old address; it redirects to /chats/new",
    "/chats/new": "the rail's primary action, New chat",
    "/resources/new": "reached from the Resources list's own button",
    "/no-access": "redirected to from the app shell when the workspace list is empty",
  };

  it("claims every page it does not exempt", async () => {
    const { readdirSync, statSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { groups: navGroups, getActiveTopHref } = await import("./Sidebar");

    const root = join(process.cwd(), "src/app/(app)");
    const pages: string[] = [];
    const walk = (dir: string, url: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (!statSync(full).isDirectory()) continue;
        if (name.startsWith("[")) continue;
        const here = `${url}/${name}`;
        if (existsSync(join(full, "page.tsx"))) pages.push(here);
        walk(full, here);
      }
    };
    walk(root, "");

    expect(pages.length).toBeGreaterThan(10);
    expect(pages).toContain("/ai-provider");

    const childHrefs = new Set(
      navGroups.flatMap((g) => g.items.flatMap((i) => (i.children ?? []).map((c) => c.href.split("?")[0]))),
    );

    const unreachable = pages.filter(
      (p) => !(p in NOT_A_RAIL_DESTINATION) && !childHrefs.has(p) && getActiveTopHref(p) === null,
    );
    expect(unreachable, `pages the rail neither claims nor exempts: ${unreachable.join(", ")}`).toEqual([]);
  });

  it("offers AI models on the rail (top-level settings)", async () => {
    const { groups: navGroups } = await import("./Sidebar");
    const items = navGroups.flatMap((g) => g.items);
    const row = items.find((i) => i.href === "/ai-provider");
    expect(row, "the rail must offer /ai-provider").toBeTruthy();
    expect(row!.label).toBe("AI models");
  });
});

describe("the collapsed rail is legible", () => {
  const items = groups.flatMap((g) => g.items);

  it("gives every nav row its own glyph", () => {
    expect(items.length).toBeGreaterThan(5);
    const seen = new Map<string, string[]>();
    for (const i of items) {
      const name = i.Icon.name || i.Icon.toString().slice(0, 40);
      const list = seen.get(name) ?? [];
      list.push(i.label);
      seen.set(name, list);
    }
    const collisions = [...seen.entries()].filter(([, labels]) => labels.length > 1);
    expect(collisions, `shared glyphs: ${collisions.map(([n, l]) => `${n}→${l.join("|")}`).join("; ")}`).toEqual([]);
  });
});

describe("Sidebar — rail at every width (no drawer)", () => {
  it("is never off-canvas and its toggle flips between icon rail and expanded rail", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false));
    const onToggle = vi.fn();
    const { rerender } = render(<Sidebar collapsed onToggleCollapsed={onToggle} />);
    const aside = document.querySelector("aside")!;
    expect(aside.className).not.toContain("-translate-x-full");
    expect(aside.className).toContain("w-[var(--sidebar-collapsed-w)]");
    expect(aside.className).not.toContain("lg:static");

    const toggle = screen.getByRole("button", { name: "Expand the navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<Sidebar collapsed={false} onToggleCollapsed={onToggle} />);
    expect(document.querySelector("aside")!.className).toContain("w-[var(--sidebar-w)]");
    const open = screen.getByRole("button", { name: "Collapse the navigation" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "Close menu" })).toBeNull();
  });

  it("taps on a nav item report back so a small screen can fold the rail", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false));
    const onNavigate = vi.fn();
    render(<Sidebar collapsed={false} onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText("Chats")).toBeTruthy());
    screen.getByText("Chats").click();
    expect(onNavigate).toHaveBeenCalled();
  });

  it("a tap on the collapsed rail background expands it, but a nav link does not toggle", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false));
    const onToggle = vi.fn();
    render(<Sidebar collapsed onToggleCollapsed={onToggle} />);
    await waitFor(() => expect(document.querySelector('a[href="/chats"]')).toBeTruthy());
    document.querySelector<HTMLElement>("nav")!.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    document.querySelector<HTMLElement>('a[href="/chats"]')!.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("the logo expands a collapsed rail instead of navigating", () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false));
    const onToggle = vi.fn();
    render(<Sidebar collapsed onToggleCollapsed={onToggle} />);
    document.querySelector<HTMLElement>('a[href="/dashboard"]')!.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
