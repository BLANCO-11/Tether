// @vitest-environment jsdom
import * as fs from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ConsumerMePage from "./page";
import ConsumerLayout from "../layout";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { name: "Meera Iyer", email: "meera@pack.test" }, ready: true, signOut: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/me",
}));

afterEach(cleanup);

describe("S-42 · consumer shell — structure", () => {
  it("has 64px topbar with Foundry mark, not workspace name", () => {
    render(
      <ConsumerLayout>
        <ConsumerMePage />
      </ConsumerLayout>,
    );
    expect(screen.getByText("Foundry")).toBeTruthy();
    const header = document.querySelector("header");
    expect(header?.className).toContain("h-[64px]");
    expect(screen.queryByPlaceholderText(/Search/)).toBeNull();
    expect(screen.queryByLabelText(/Switch workspace/)).toBeNull();
  });

  it("has three tabs, My status active, no sidebar ever", () => {
    render(
      <ConsumerLayout>
        <ConsumerMePage />
      </ConsumerLayout>,
    );
    expect(screen.getByText("My status")).toBeTruthy();
    expect(screen.getByText("Reports")).toBeTruthy();
    expect(screen.getByText("My requests")).toBeTruthy();
    expect(screen.getByText("My status").getAttribute("aria-current")).toBe("page");
    expect(document.querySelector("aside")).toBeNull();
    const wfCap = "Work" + "flows";
    expect(screen.queryByText(wfCap)).toBeNull();
  });

  it("body is centred 880px — max-w-[880px] and w-[880px] literal present", () => {
    render(
      <ConsumerLayout>
        <ConsumerMePage />
      </ConsumerLayout>,
    );
    const column = document.querySelector(".max-w-\\[880px\\]");
    expect(column).toBeTruthy();
    const literal = document.querySelector(".w-\\[880px\\]");
    expect(literal).toBeTruthy();
    const shell = document.querySelector(".text-\\[15px\\]");
    expect(shell).toBeTruthy();
  });

  it("never mentions w-word", () => {
    render(
      <ConsumerLayout>
        <ConsumerMePage />
      </ConsumerLayout>,
    );
    const w = "work" + "flow";
    expect(document.body.textContent?.toLowerCase()).not.toContain(w);
  });

  it("has no W-word in the shell source — grep guard", () => {
    const w = "work" + "flow";
    const txt = fs.readFileSync("src/components/shell/ConsumerTopbar.tsx", "utf8");
    expect(txt.toLowerCase()).not.toContain(w);
    const layoutTxt = fs.readFileSync("src/app/(consumer)/layout.tsx", "utf8");
    expect(layoutTxt.toLowerCase()).not.toContain(w);
    const pageTxt = fs.readFileSync("src/app/(consumer)/me/page.tsx", "utf8");
    expect(pageTxt.toLowerCase()).not.toContain(w);
  });
});

describe("S-42 · My attendance status — copy verbatim", () => {
  it("renders identity above title", () => {
    render(<ConsumerMePage />);
    expect(screen.getByText("Meera Iyer · HR Operations Lead")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "My attendance status" })).toBeTruthy();
  });

  it("renders Non-compliant chip with ✕ (chip + history)", () => {
    render(<ConsumerMePage />);
    expect(screen.getByText("Non-compliant")).toBeTruthy();
    const crosses = screen.getAllByText("✕");
    expect(crosses.length).toBeGreaterThanOrEqual(3);
  });

  it("renders July 2026 · Your own information only", () => {
    render(<ConsumerMePage />);
    expect(screen.getByText("July 2026 · Your own information only")).toBeTruthy();
  });

  it("renders figures 9 days in office, 12 required days, 7h 20m average hours", () => {
    render(<ConsumerMePage />);
    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.getByText("days in office")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("required days")).toBeTruthy();
    expect(screen.getByText("7h 20m")).toBeTruthy();
    expect(screen.getByText("average hours")).toBeTruthy();
  });

  it("renders freshness line with last and next", () => {
    render(<ConsumerMePage />);
    expect(screen.getByText("Last calculated 1 Aug 2026, 02:00 IST · Next 1 Sep 2026, 02:00 IST")).toBeTruthy();
  });

  it("renders How July was calculated with 48px rows and Result as last row", () => {
    render(<ConsumerMePage />);
    expect(screen.getByText("How July was calculated")).toBeTruthy();
    expect(screen.getByText("Office days meeting 6 hours")).toBeTruthy();
    expect(screen.getByText("9 of 9 days")).toBeTruthy();
    expect(screen.getByText("Approved annual leave")).toBeTruthy();
    expect(screen.getByText("2 days")).toBeTruthy();
    expect(screen.getByText("Public holidays")).toBeTruthy();
    expect(screen.getByText("1 day")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getByText("3 days short")).toBeTruthy();
    const rows = document.querySelectorAll(".h-12");
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it("renders Six-month history Feb–Jul with ✓/✕", () => {
    render(<ConsumerMePage />);
    expect(screen.getByText("Six-month history")).toBeTruthy();
    for (const m of ["Feb", "Mar", "Apr", "May", "Jun", "Jul"]) {
      expect(screen.getByText(m)).toBeTruthy();
    }
    const checks = screen.getAllByText("✓");
    expect(checks.length).toBe(4);
    const crosses = screen.getAllByText("✕");
    expect(crosses.length).toBeGreaterThanOrEqual(2);
  });

  it("renders Request an exception with 44px touch", () => {
    render(<ConsumerMePage />);
    const btn = screen.getByText("Request an exception");
    expect(btn).toBeTruthy();
    expect(btn.className).toContain("h-11");
    expect(btn.className).toContain("min-h-[44px]");
  });
});
