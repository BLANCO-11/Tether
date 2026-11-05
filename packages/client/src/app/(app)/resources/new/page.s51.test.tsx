// @vitest-environment jsdom
// src/app/(app)/resources/new/page.s51.test.tsx — S-51 Mock / masked data studio — page zones & copy.
// Pack truth: `18-onboarding-safe-data.png` + `S-51.md` + `flows/08-datasource-onboarding.md § Step 6`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const push = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/resources/new",
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { name: "tester", email: "tester@example.com" }, ready: true, signOut: vi.fn() }),
}));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));

import OnboardingPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  localStorage.clear();
});
afterEach(cleanup);

describe("S-51 · page header — verbatim", () => {
  it("renders eyebrow POSTGRESQL, title Create safe data, and subtitle verbatim when on safe-data step", () => {
    searchParams = new URLSearchParams("step=safe-data&type=postgres");
    render(<OnboardingPage />);
    expect(screen.getByText("POSTGRESQL")).toBeTruthy();
    expect(screen.getByText("Create safe data")).toBeTruthy();
    expect(screen.getByText("Connect, test, map and create safe data before asking for review.")).toBeTruthy();
  });

  it("eyebrow is derived from type param — S3 renders AMAZON S3", () => {
    searchParams = new URLSearchParams("step=safe-data&type=s3");
    render(<OnboardingPage />);
    expect(screen.getByText("AMAZON S3")).toBeTruthy();
  });
});

describe("S-51 · step strip — wrapping and required star", () => {
  it("renders all seven pills with step 6 trailing * and marks safe-data as current", () => {
    searchParams = new URLSearchParams("step=safe-data&type=postgres");
    render(<OnboardingPage />);
    expect(screen.getByText("✓ Choose type")).toBeTruthy();
    expect(screen.getByText("✓ Connect")).toBeTruthy();
    expect(screen.getByText("6 Create safe data *")).toBeTruthy();
    expect(screen.getByText("7 Submit for review")).toBeTruthy();
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toBe("6 Create safe data *");
  });

  it("is a wrapping row (flex-wrap) — S-51 § Layout", () => {
    searchParams = new URLSearchParams("step=safe-data&type=postgres");
    render(<OnboardingPage />);
    const nav = document.querySelector('[aria-label="Onboarding steps"]');
    expect(nav?.className).toContain("flex-wrap");
  });

  it("completed steps render as tick — 5 ticks before safe-data", () => {
    searchParams = new URLSearchParams("step=safe-data&type=postgres");
    render(<OnboardingPage />);
    // 5 completed before current (type, connect, test, schema, mapping)
    const ticks = Array.from(document.querySelectorAll('[aria-label="Onboarding steps"] span')).filter((el) =>
      (el.textContent ?? "").startsWith("✓"),
    );
    expect(ticks.length).toBe(5);
  });
});

describe("S-51 · safe-data card content via page", () => {
  it("renders SafeDataStudio empty state when not yet generated", () => {
    searchParams = new URLSearchParams("step=safe-data&type=postgres");
    render(<OnboardingPage />);
    expect(screen.getByText("This resource needs mock data before it can be published.")).toBeTruthy();
    expect(screen.getByText("The AI never sees your real data.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate 25 mock rows" })).toBeTruthy();
  });

  it("honours stored safeData — shows generated state", () => {
    localStorage.setItem(
      "onboarding:safeData",
      JSON.stringify({ generated: true, rowCount: 25, edgeCases: [], createdAt: new Date().toISOString() }),
    );
    // Seed a mapping so preview has columns
    localStorage.setItem(
      "onboarding:mapping",
      JSON.stringify([
        { source: "employee_no", type: "text", target: "employee_id", confidence: 99, include: true },
        { source: "leave_dt", type: "date", target: "leave_date", confidence: 97, include: true },
      ]),
    );
    searchParams = new URLSearchParams("step=safe-data&type=postgres");
    render(<OnboardingPage />);
    expect(screen.getByText("25 mock rows generated")).toBeTruthy();
    expect(screen.getByText("Edge cases to include")).toBeTruthy();
    expect(screen.getByText("Preview")).toBeTruthy();
  });
});
