// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Sidebar, groups } from "./Sidebar";

/**
 * The Manage Workspaces nav row is super-admin-only.
 *
 * ⚠ **Both directions are asserted, and that is the point of the file.** A row
 * that is hidden from everybody passes a one-sided "it is absent for a
 * non-super-admin" test perfectly — I-38's shape, and the reason every control
 * in this repo owes a positive control.
 *
 * ⚠ This is presentation, NOT the control: `requireSuperAdmin` on the API
 * refuses the actions regardless of what renders here.
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

const me = (superAdmin: boolean, canViewReports = false) => ({
  subject: "oid-x",
  email: "x@x.test",
  superAdmin,
  superAdminConfigured: true,
  canViewReports,
});

describe("Sidebar — the Admin row (pack nav)", () => {
  it("is SHOWN to a super admin — the positive control", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(true));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Admin")).toBeTruthy());
  });

  it("is hidden from a non-super-admin", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Workflows")).toBeTruthy());
    expect(screen.queryByText("Admin")).toBeNull();
  });

  it("⚠ the Admin row is gone when hidden — no empty group heading", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Workflows")).toBeTruthy());
    expect(screen.queryByText("Admin")).toBeNull();
    // Previously this checked for an empty "Admin" group heading; now Admin is a
    // top-level row with superAdminOnly, so hidden row means no leftover heading.
  });

  it("and is back for a super admin — the positive control", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(true));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Admin")).toBeTruthy());
    expect(screen.getByText("Admin")).toBeTruthy();
  });

  it("⚠ is hidden when the access check FAILS — 'we could not check' is not 'you may'", async () => {
    vi.mocked(api.getMe).mockRejectedValue(new Error("down"));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Workflows")).toBeTruthy());
    expect(screen.queryByText("Admin")).toBeNull();
  });
});

describe("Sidebar — pack rail sanity", () => {
  it("renders the primary + New chat and the 5 prototype rows", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false, true));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("New chat")).toBeTruthy());
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByText("Workflows")).toBeTruthy();
    expect(screen.getByText("Approvals")).toBeTruthy();
    expect(screen.getByText("Runs & Activity")).toBeTruthy();
    expect(screen.getByText("Dashboards & Reports")).toBeTruthy();
  });
});

/**
 * The cost report is an Admin's (2026-10-26). Presentation only: the report routes answer 403 to anybody else, so this
 * decides whether the link shows. Both directions are asserted, and an unreadable check hides it.
 */
describe("Sidebar — the cost report row", () => {
  it("is SHOWN when the server says this person may open it — the positive control", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false, true));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Dashboards & Reports")).toBeTruthy());
  });

  it("is hidden from somebody who may not, while the rest of the rail is there", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false, false));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Workflows")).toBeTruthy());
    expect(screen.queryByText("Dashboards & Reports")).toBeNull();
  });

  it("⚠ is hidden when the check FAILS — 'we could not check' is not 'you may'", async () => {
    vi.mocked(api.getMe).mockRejectedValue(new Error("down"));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Workflows")).toBeTruthy());
    expect(screen.queryByText("Dashboards & Reports")).toBeNull();
  });

  it("is not granted by being a super admin on the client: only the server's answer shows it", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(true, false));
    render(<Sidebar />);
    await waitFor(() => expect(screen.getByText("Admin")).toBeTruthy());
    expect(screen.queryByText("Dashboards & Reports")).toBeNull();
  });
});

/**
 * ⚠ **THE CONTROL THAT WOULD HAVE CAUGHT `/ai-provider`, AND THE REASON IT IS
 * A SWEEP RATHER THAN ONE ASSERTION.**
 *
 * `app/(app)/ai-provider/page.tsx` was reachable only by typing the URL: the
 * page, its `alpha-registry` entry and its `routes.smoke.test` row were all
 * present and correct, and the one thing missing — a rail entry — is the one
 * thing no per-page test looks at. Reported from use as *"the LLM configuration
 * page is no longer there"*, which is what an unreachable page looks like from
 * outside.
 *
 * So this walks the filesystem and requires every STATIC page to be either
 * claimed by the rail or **named here with a reason**. A page dropped from the
 * rail then goes red at the next run instead of at the next complaint.
 *
 * ⚠ **The exemption list is the honest half.** Several pages genuinely are not
 * rail destinations — they are reached from a row, a card or a button — and
 * pretending otherwise would mean adding rail entries nobody wants. What the
 * list buys is that dropping a page out of the nav becomes a DECISION with a
 * sentence beside it, not a silent diff.
 */
describe("Sidebar — every static page is reachable, or exempt with a reason", () => {
  /** Reached from somewhere other than the rail. Each entry says from where. */
  const NOT_A_RAIL_DESTINATION: Record<string, string> = {
    // `/apps` WAS exempt here as "a declared placeholder". It is the Connectors page now (plugins, 2026-10-27) and the
    // rail claims it, so the exemption is removed rather than left as a sentence nobody is holding to anything.
    "/live": "opened from a run, not browsed to",
    "/flows/new": "an old address; it redirects to /chats/new",
    "/chats/new": "the rail's primary action, New chat",
    "/resources/new": "reached from the Resources list's own button",
    "/incidents/break-glass": "reached from Admin > Break-glass",
    // ⚠ RBAC: it is REDIRECTED to, not browsed to. `(app)/layout.tsx` sends anybody whose
    // filtered workspace list comes back EMPTY here. Putting it in the rail would offer
    // "you have no access" as a destination to people who do have access, which is worse
    // than it sounds: the rail is the one place the product asserts what exists.
    "/no-access": "redirected to from the app shell when the workspace list is empty",
    // ⚠ **`/organization/roles` WAS EXEMPTED HERE AND THE PAGE IS GONE** — it is the
    // Roles tab on `/admin/members` now. Worth recording why no replacement entry was
    // added, and why `/organization/platform-roles` never needed one: the Admin group's
    // `ownedPaths` carries `/organization`, and the claim check prefix-matches
    // (`pathname.startsWith(p + "/")`), so BOTH of those pages were already claimed by
    // the rail and this entry was dead. Read the claim logic before adding an exemption
    // — an exemption that was never consulted is a sentence nobody is holding to
    // anything.
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
        // A dynamic segment is not a destination anybody navigates to blind.
        if (name.startsWith("[")) continue;
        const here = `${url}/${name}`;
        if (existsSync(join(full, "page.tsx"))) pages.push(here);
        walk(full, here);
      }
    };
    walk(root, "");

    // The control on the walk itself: a scan that finds nothing passes every
    // assertion below, which is exactly the failure this file exists to refuse.
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

  it("⚠ offers the AI models page, and names MODELS rather than the provider", async () => {
    // Two settings live there (D-115), and calling the row "AI provider" is how
    // somebody changes the `llm_complete` model and concludes drafting is still
    // slow. The label is part of the fix, so it is asserted.
    const { groups: navGroups } = await import("./Sidebar");
    const kids = navGroups.flatMap((g) => g.items.flatMap((i) => i.children ?? []));
    const row = kids.find((c) => c.href === "/ai-provider");
    expect(row, "the rail must offer /ai-provider").toBeTruthy();
    expect(row!.label).toBe("AI models");
  });
});


/**
 * ⚠ **COLLAPSED, THE RAIL IS ITS ICONS.** Every label is `max-w-0` and every
 * heading is gone, so a glyph used twice is two rows a person cannot tell apart
 * — and the only way back is to expand the rail the icons exist to replace.
 *
 * `Activity` was on THREE rows (Tools, Credentials, Runs & Activity), so the
 * whole Resources group and one Operations row were the same picture. This is
 * the control, because the defect returns the moment a nav row is added and the
 * nearest-looking icon is reached for.
 */
describe("the collapsed rail is legible", () => {
  const items = groups.flatMap((g) => g.items);

  it("gives every nav row its own glyph", () => {
    expect(items.length).toBeGreaterThan(5); // control: there is something to collide
    const seen = new Map<string, string[]>();
    for (const i of items) {
      const key = (i.Icon as unknown as { name?: string }).name ?? String(i.Icon);
      seen.set(key, [...(seen.get(key) ?? []), i.label]);
    }
    const shared = [...seen.entries()].filter(([, rows]) => rows.length > 1);
    expect(shared).toEqual([]);
  });

});

/**
 * The collapsed rail's ALIGNMENT — reported from use, 2026-09-08.
 *
 * ── The bug class, and why every instance of it looked like a one-off ───────
 *
 * The rail is 56px and every collapsing label animates via
 * `max-w-0 / opacity-0` rather than `display:none`, because the width
 * transition is the point. **A zero-width flex item still gets its `gap`.** So
 * `flex items-center gap-2` around `[icon][label]` stays 8px wider than the
 * icon and, under `justify-center`, puts the icon 4px LEFT of centre. The
 * header was worse: an outer `gap-2` plus the lockup's own `gap-2` put the logo
 * 8px off. Five containers had the same defect and each read as a separate
 * cosmetic nit; they are one bug.
 *
 * `ml-auto` on a collapsing trailing badge is the same class with a bigger
 * blast radius: on a `justify-center` row it absorbs ALL the free space and
 * shoves the icon to the far left edge — so `/approvals` jumped out of line the
 * moment somebody had a pending approval, and only then.
 *
 * ⚠ These assert CLASS INTENT, which is as far as jsdom can go — it performs no
 * layout, so no test here can measure a pixel. That bound is why the classes
 * are asserted per container rather than one "the rail looks right" test that
 * could never fail (I-38). The expanded direction is asserted too: a fix that
 * flattened the gap in BOTH states would pass a one-sided test and quietly
 * break the open sidebar.
 */
describe("the collapsed rail is aligned", () => {
  /*
   * ⚠ NOTHING CHANGES LAYOUT WHEN THE RAIL FOLDS — 2026-10-11, the janky collapse.
   *
   * Each row used to swap its own padding, gap and centring on the click tick (`lg:gap-0 lg:px-0 lg:mx-auto`),
   * and the group divider mounted — so every row jumped on frame one and the rail's width then animated under
   * rows that had already moved. Now the geometry is fixed so the icon sits on the collapsed rail's centre line
   * in BOTH states (nav px-2 + row pl-3 = 20px; 56px rail → centre 28 = 20 + 16/2), and only the rail's width
   * animates while the labels fade. jsdom performs no layout, so this asserts the intent: the same classes on
   * every structural element in both states.
   */
  const shape = () => {
    const pick = (sel: string) => [...document.querySelectorAll(sel)].map((e) => e.className);
    return {
      rows: pick("nav a.rail-item"),
      newButton: screen.getByLabelText("New chat").className,
      nav: document.querySelector("nav")!.className,
      header: document.querySelector("aside > div")!.className,
      footer: pick("aside > div:last-child > *"),
    };
  };

  it("gives every structural element the same classes collapsed and expanded", () => {
    const { unmount } = render(<Sidebar />);
    const open = shape();
    unmount();
    render(<Sidebar collapsed />);
    const shut = shape();
    expect(open.rows.length).toBeGreaterThan(5); // control: there are rows to compare
    expect(shut).toEqual(open);
  });

  it("hides the labels only when collapsed — invisible, so they leave the tab order", () => {
    const { unmount } = render(<Sidebar collapsed />);
    expect(screen.getByText("Workflows").className).toContain("lg:invisible");
    unmount();
    render(<Sidebar />);
    expect(screen.getByText("Workflows").className).not.toContain("lg:invisible");
  });

  it("keeps a group heading mounted when collapsed, turned into the hairline — no rule element appears", () => {
    render(<Sidebar collapsed />);
    const labels = document.querySelectorAll("nav [data-rail-group-label]");
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.className).toContain("lg:is-collapsed");
    expect(document.querySelectorAll("nav .border-t").length).toBe(0);
  });

  it("is a plain heading when expanded — the control", () => {
    render(<Sidebar />);
    const labels = document.querySelectorAll("nav [data-rail-group-label]");
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.className).not.toContain("lg:is-collapsed");
  });

  it("marks waiting approvals with a dot on the icon when collapsed, where the count is hidden", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false) as never);
    vi.mocked(api.listPendingApprovals).mockResolvedValue([{ id: "a" }, { id: "b" }] as never);
    render(<Sidebar collapsed />);
    await waitFor(() => expect(document.querySelector(".rail-dot")).toBeTruthy());
    expect(screen.getByLabelText("Approvals").getAttribute("title")).toContain("2 waiting");
  });

  it("draws no dot when nothing is waiting — the control", async () => {
    vi.mocked(api.getMe).mockResolvedValue(me(false) as never);
    vi.mocked(api.listPendingApprovals).mockResolvedValue([] as never);
    render(<Sidebar collapsed />);
    await waitFor(() => expect(screen.getByLabelText("Approvals")).toBeTruthy());
    expect(document.querySelector(".rail-dot")).toBeNull();
  });
});
