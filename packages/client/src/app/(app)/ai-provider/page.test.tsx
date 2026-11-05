// @vitest-environment jsdom
//
// AI models: two summary cards say what each model is today; ONE of the two is open below (tab in the URL); the
// runtime settings save only when something changed. Nothing about what is saved changed in the 2026-10-12 restyle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let tab: string | null = null;
const replace = vi.fn((url: string) => {
  tab = url.includes("tab=builder") ? "builder" : null;
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => ({ get: (k: string) => (k === "tab" ? tab : null) }),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));

const api = vi.hoisted(() => ({
  getLlmProvider: vi.fn(),
  getGenerationProvider: vi.fn(),
  saveLlmProvider: vi.fn(),
}));
vi.mock("@/lib/foundry-client", () => ({ foundryApi: api }));

const runtime = {
  configured: true,
  baseUrl: "https://gw.example/v1",
  keyFingerprint: "ab12cd34",
  defaultModel: "gpt-a",
  allowedModels: ["gpt-a", "gpt-b"],
  source: "configured" as const,
  updatedAt: null,
};
const builder = {
  baseUrl: "https://gw.example/v1",
  keyFingerprint: null,
  defaultModel: "luna",
  allowedModels: ["luna"],
  source: "environment" as const,
  environmentModel: "luna",
  updatedAt: null,
  updatedBy: null,
};

let Page: React.ComponentType;
beforeEach(async () => {
  tab = null;
  api.getLlmProvider.mockResolvedValue(runtime);
  api.getGenerationProvider.mockResolvedValue(builder);
  Page = (await import("./page")).default;
});
afterEach(cleanup);

describe("AI models", () => {
  it("summarises both models, and opens the runtime settings by default", async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getAllByText("gpt-a").length).toBeGreaterThan(0));
    expect(screen.getAllByText("luna").length).toBeGreaterThan(0);
    expect(screen.getByText("2 models")).toBeTruthy();
    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Runtime" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Save is off until something changes", async () => {
    render(<Page />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Enable gpt-b"));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the Builder tab is a URL, and shows where the builder model comes from", async () => {
    tab = "builder";
    render(<Page />);
    expect(await screen.findByText("Builder model")).toBeTruthy();
    expect(screen.getByText("the deployment's environment")).toBeTruthy();
    expect(screen.queryByText("Connection")).toBeNull();
  });

  it("names who set the builder model by name, never by sign-in id", async () => {
    tab = "builder";
    api.getGenerationProvider.mockResolvedValue({ ...builder, source: "configured", updatedBy: "oid-e75e0815", updatedByName: "Priya Shah" });
    const { container } = render(<Page />);
    await screen.findByText("Builder model");
    expect(container.textContent).toContain("by Priya Shah");
    expect(container.textContent).not.toContain("oid-e75e0815");
  });

  it("Reset to saved puts the form back without sending anything", async () => {
    render(<Page />);
    await screen.findByRole("button", { name: "Save" });
    fireEvent.click(screen.getByLabelText("Enable gpt-b"));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset to saved" }));
    expect(screen.getByText("No unsaved changes.")).toBeTruthy();
    expect(api.saveLlmProvider).not.toHaveBeenCalled();
  });

  it("says so when the two point at different gateways", async () => {
    api.getGenerationProvider.mockResolvedValue({ ...builder, baseUrl: "https://other.example/v1" });
    render(<Page />);
    expect(await screen.findByText("These two point at different gateways")).toBeTruthy();
  });
});
