import { describe, expect, it } from "vitest";
import { runsAsSummary } from "./runs-as-summary";

const svc = (service: string, choice: Record<string, unknown> | null, approved: Record<string, unknown> | null = null) => ({ piece: service, service, current: choice, approved, options: [] }) as never;
const team = { connectionId: "t", label: "Team", personal: false, service: "GitHub" };
const mine = { connectionId: "m", label: "Mine", personal: true, service: "GitHub" };
const own = { connectionId: "", label: "Its owner's own account", personal: true, service: "GitHub", own: true };
const each = { connectionId: "", label: "Each person", personal: false, service: "GitHub", each: true };

describe("Runs as, in one line and the three words", () => {
  it("Workspace, Owner or Each person", () => {
    expect(runsAsSummary({ services: [svc("GitHub", team)], owner: true, approved: false }, "Ada")).toBe("Workspace");
    expect(runsAsSummary({ services: [svc("GitHub", mine)], owner: true, approved: false }, "Ada")).toBe("Owner (Ada's own account)");
    expect(runsAsSummary({ services: [svc("GitHub", own)], owner: true, approved: false, mySpace: true }, "Ada")).toBe("Owner (Ada's own account)");
    expect(runsAsSummary({ services: [svc("GitHub", each)], owner: true, approved: false }, "Ada")).toBe("Each person");
  });
  it("the APPROVED choice wins (it is what runs unattended); different per service says each", () => {
    expect(runsAsSummary({ services: [svc("GitHub", each, team)], owner: true, approved: true }, "Ada")).toBe("Workspace");
    expect(runsAsSummary({ services: [svc("GitHub", team), svc("Slack", each)], owner: true, approved: false }, "Ada")).toBe("GitHub: Workspace · Slack: Each person");
  });
  it("no connected service says nothing; one not chosen says so", () => {
    expect(runsAsSummary({ services: [], owner: true, approved: false }, "Ada")).toBeNull();
    expect(runsAsSummary(null, "Ada")).toBeNull();
    expect(runsAsSummary({ services: [svc("GitHub", null)], owner: true, approved: false }, "Ada")).toBe("Not chosen yet");
  });
});
