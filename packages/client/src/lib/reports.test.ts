import { describe, expect, it } from "vitest";
import {
  dayLabel,
  niceMax,
  topRows,
  workspaceColour,
  NO_DRILL,
  NO_FLOW,
  drillInto,
  drillQuery,
  filenameFrom,
  parseRecipients,
  queryString,
  recipientProblem,
  type ReportGroup,
} from "./reports";

const group = (o: Partial<ReportGroup>): ReportGroup => ({
  id: "x", name: "X", costUsd: 1, tokens: 1, runs: 1, workflows: 1, people: 1, workspaces: 1, share: 1, ...o,
});

describe("the query the page and the file share", () => {
  it("a period in days, or an explicit range, never both", () => {
    expect(queryString({ days: 7 })).toBe("days=7");
    expect(queryString({ from: "2026-10-01", to: "2026-10-03", days: 7 })).toBe("from=2026-10-01&to=2026-10-03");
  });

  it("carries the workspaces and the drill, and leaves empty ones out", () => {
    expect(queryString({ days: 30, workspaces: ["a", "b"], flowId: "f", subject: "s" })).toBe("days=30&workspaces=a%2Cb&flowId=f&subject=s");
    expect(queryString({ days: 30, workspaces: [] })).toBe("days=30");
  });

  it("appends paging after the scope", () => {
    expect(queryString({ days: 30 }, { sort: "cost", offset: 50, limit: undefined })).toBe("days=30&sort=cost&offset=50");
  });
});

describe("the drill", () => {
  it("a workspace opens its workflows", () => {
    const r = drillInto("workspaces", group({ id: "w1", name: "Finance" }), NO_DRILL);
    expect(r.lens).toBe("workflows");
    expect(r.drill.workspace).toEqual({ id: "w1", name: "Finance" });
  });

  it("a workflow opens its runs, and carries its workspace so the trail reads true", () => {
    const r = drillInto("workflows", group({ id: "f1", name: "Invoice chase", workspaceId: "w1", workspaceName: "Finance" }), NO_DRILL);
    expect(r.lens).toBe("runs");
    expect(r.drill).toEqual({ workspace: { id: "w1", name: "Finance" }, flow: { id: "f1", name: "Invoice chase" }, person: null });
  });

  it("a person opens the workflows they used, and keeps any workspace already chosen", () => {
    const start = { ...NO_DRILL, workspace: { id: "w1", name: "Finance" } };
    const r = drillInto("people", group({ id: "s1", name: "Priya" }), start);
    expect(r.lens).toBe("workflows");
    expect(r.drill.workspace?.id).toBe("w1");
    expect(r.drill.person?.id).toBe("s1");
  });

  it("an unsaved build is filtered as `none`", () => {
    expect(drillInto("workflows", group({ id: null, name: "Unsaved build" }), NO_DRILL).drill.flow?.id).toBe(NO_FLOW);
  });

  it("the drill narrows the picker's choice and never widens it", () => {
    const q = drillQuery({ days: 30, workspaces: ["a", "b"] }, { workspace: { id: "a", name: "A" }, flow: { id: "f", name: "F" }, person: null });
    expect(q).toEqual({ days: 30, workspaces: ["a"], flowId: "f" });
    expect(drillQuery({ days: 30, workspaces: ["a", "b"] }, NO_DRILL).workspaces).toEqual(["a", "b"]);
  });
});

describe("emailing: what is typed", () => {
  it("splits on commas, semicolons and spaces, lowercases and de-duplicates", () => {
    expect(parseRecipients("A@x.com, b@x.com;a@X.com  c@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("says what is wrong, and nothing when it is fine", () => {
    expect(recipientProblem([])).toMatch(/at least one/i);
    expect(recipientProblem(["nope"])).toMatch(/nope/);
    expect(recipientProblem(["a@microland.com"])).toBeNull();
  });
});

describe("the downloaded file's name", () => {
  it("prefers the server's, and falls back", () => {
    expect(filenameFrom('attachment; filename="cost-report_a.xlsx"', "x.xlsx")).toBe("cost-report_a.xlsx");
    expect(filenameFrom(null, "x.xlsx")).toBe("x.xlsx");
  });
});

describe("chart helpers", () => {
  it("niceMax rounds up to a figure an axis can show, and never to zero", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.0034)).toBeCloseTo(0.005, 9);
    expect(niceMax(1.2)).toBe(2);
    expect(niceMax(4.9)).toBe(5);
    expect(niceMax(6)).toBe(10);
    expect(niceMax(10)).toBe(10);
    expect(niceMax(37)).toBe(50);
  });

  it("dayLabel is the UTC day the server bucketed, however the viewer's clock is set", () => {
    expect(dayLabel("2026-09-27")).toBe("27 Sept");
    expect(dayLabel("2026-10-26")).toBe("26 Oct");
  });

  it("a workspace's colour comes from its place in the list, and wraps rather than running out", () => {
    expect(workspaceColour(0)).not.toBe(workspaceColour(1));
    expect(workspaceColour(7)).toBe(workspaceColour(0));
    expect(workspaceColour(-1)).toBeTruthy();
  });

  it("topRows keeps the biggest, rolls the rest up, and the rolled-up row is not a group", () => {
    const gs = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, costUsd: i + 1, tokens: 0, runs: 1, workflows: 1, people: 1, workspaces: 1, share: (i + 1) / 55 }));
    const rows = topRows(gs, 8);
    expect(rows.length).toBe(9);
    expect(rows[0]!.name).toBe("G9");
    const other = rows.at(-1)!;
    expect(other).toMatchObject({ name: "Other (2)", costUsd: 3, group: null });
    expect(topRows(gs.slice(0, 3), 8).length).toBe(3); // nothing to roll up, no "Other"
  });
});
