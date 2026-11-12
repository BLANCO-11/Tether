// @vitest-environment jsdom
//
// ── ⚠ A WORKSPACE SWITCH IS A NAVIGATION ────────────────────────────────────────────
//
// Every page under the shell is scoped to a workspace, and many are scoped to a THING
// inside one — `/flows/<id>`, `/runs/<id>`, `/admin/members?tab=roles`. Switching while
// standing on one of those used to leave the person on a page about an object the new
// workspace does not contain: `<main key={workspaceId}>` remounts it, it refetches, and
// it renders a 404 or an empty state that reads as "your data is gone".
//
// So the switcher lands on Home. These tests pin the three halves of that: it goes to
// `/dashboard`, it adopts the workspace FIRST, and it does neither when the pick is the
// workspace you are already in.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const push = vi.fn();
const back = vi.fn();
const switchWorkspace = vi.fn();
/** What the mocked context reports. Changed per test, not per render. */
let activeWorkspace = "ws-a";
/** What `usePathname()` reports. Changed per test, not per render. */
let currentPathname = "/flows/flow-42";
/** Every call, in order, so "adopt then navigate" is checkable rather than assumed. */
const order: string[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({
    push: (p: string) => { order.push(`push:${p}`); push(p); },
    back: () => { order.push("back"); back(); },
  }),
}));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({
    workspaceId: activeWorkspace,
    switchWorkspace: (id: string) => { order.push(`switch:${id}`); switchWorkspace(id); },
  }),
}));
vi.mock("@/lib/api", () => ({
  listWorkspaces: vi.fn(async () => [
    { id: "ws-a", name: "Alpha", createdAt: null, kind: null },
    { id: "ws-b", name: "Beta", createdAt: null, kind: null },
  ]),
}));
vi.mock("@/components/shell/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/shell/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/shell/ThemeToggle", () => ({ ThemeToggle: () => null }));

import { Topbar } from "./Topbar";
import { PageHeaderProvider, usePageHeader } from "@/lib/page-header";

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  activeWorkspace = "ws-a";
  currentPathname = "/flows/flow-42";
});
afterEach(cleanup);

async function pickBeta() {
  render(<Topbar />);
  fireEvent.click(screen.getByLabelText("Switch workspace"));
  const beta = await screen.findByRole("option", { name: /Beta/ });
  fireEvent.click(beta);
}

describe("the workspace switcher", () => {
  it("CONTROL: the menu lists the workspaces, so a null pick cannot pass silently", async () => {
    render(<Topbar />);
    fireEvent.click(screen.getByLabelText("Switch workspace"));
    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeTruthy();
    expect(await screen.findByRole("option", { name: /Beta/ })).toBeTruthy();
  });

  it("switches the workspace AND lands on Home", async () => {
    await pickBeta();
    expect(switchWorkspace).toHaveBeenCalledWith("ws-b");
    expect(push).toHaveBeenCalledWith("/dashboard");
  });

  /**
   * ⚠ `switchWorkspace` calls `adoptWorkspaceId`, which repoints the cache every scoped
   * call reads. Navigating first would let `/dashboard` mount and fetch against the
   * workspace being switched AWAY from — I-103 reintroduced from the other end.
   */
  it("adopts the workspace BEFORE it navigates", async () => {
    await pickBeta();
    expect(order).toEqual(["switch:ws-b", "push:/dashboard"]);
  });

  it("does nothing at all when the pick is the workspace you are already in", async () => {
    render(<Topbar />);
    fireEvent.click(screen.getByLabelText("Switch workspace"));
    fireEvent.click(await screen.findByRole("option", { name: /Alpha/ }));
    expect(switchWorkspace).not.toHaveBeenCalled();
    // ⚠ Not even the navigation. Choosing where you already are must not throw away the
    // page you are reading.
    expect(push).not.toHaveBeenCalled();
  });
});

// ── The Back button: leftmost in the bar, BELOW a destination only ─────────
//
// It used to be on every route, including Home, where "back" has nowhere in the
// product to go and can leave the app. It now shows only where the path has a
// parent (a workflow, a run, a form, an admin sub-page). The two flow-authoring
// surfaces have a specific destination; everything else uses real history, or
// goes up a level when the page was opened straight from a link.
describe("the Back button", () => {
  const withHistory = (n: number) => Object.defineProperty(window.history, "length", { value: n, configurable: true });

  it("is absent on a page the rail opens directly", () => {
    currentPathname = "/dashboard";
    render(<Topbar />);
    expect(screen.queryByLabelText("Back")).toBeNull();
  });

  it("renders as the leftmost control in the bar below a destination — the control", () => {
    currentPathname = "/runs/run-7";
    render(<Topbar />);
    const header = screen.getByLabelText("Back").closest("header");
    expect(header?.querySelector("button, a")).toBe(screen.getByLabelText("Back"));
  });

  it("has no hamburger — the rail expands by tapping it", () => {
    currentPathname = "/runs/run-7";
    render(<Topbar />);
    expect(screen.queryByLabelText("Expand the navigation")).toBeNull();
    expect(screen.queryByLabelText("Collapse the navigation")).toBeNull();
  });

  it("navigates to the real previous route when there is one", () => {
    currentPathname = "/runs/run-7";
    withHistory(3);
    render(<Topbar />);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(back).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("goes up a level when the page was opened directly, with no history to go back through", () => {
    currentPathname = "/runs/run-7";
    withHistory(1);
    render(<Topbar />);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(push).toHaveBeenCalledWith("/runs");
    expect(back).not.toHaveBeenCalled();
  });

  it("goes to the owning flow from its builder, not raw history", () => {
    currentPathname = "/flows/flow-42/builder";
    render(<Topbar />);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(push).toHaveBeenCalledWith("/flows/flow-42");
    expect(back).not.toHaveBeenCalled();
  });

  it("goes to the flows list from the new-flow wizard", () => {
    currentPathname = "/flows/new";
    render(<Topbar />);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(push).toHaveBeenCalledWith("/flows");
    expect(back).not.toHaveBeenCalled();
  });
});

// ── A page that sets its own title keeps the real section in the trail ─────
//
// The trail used to hardcode "Workflows /" before any page-set title — right only
// because the builder was the one page using it.
describe("a page-set title in the trail", () => {
  function Titled({ title }: { title: string }) {
    usePageHeader({ title }, [title]);
    return null;
  }

  it("leads with the page's own section, linked, then the title", async () => {
    currentPathname = "/tools/tool-9";
    render(
      <PageHeaderProvider>
        <Topbar />
        <Titled title="Send report" />
      </PageHeaderProvider>,
    );
    const trail = screen.getByLabelText("Breadcrumb");
    expect(await within(trail).findByText("Send report")).toBeTruthy();
    expect(within(trail).getByRole("link", { name: "Tools" }).getAttribute("href")).toBe("/tools");
    expect(within(trail).queryByText("Workflows")).toBeNull();
  });
});
