// @vitest-environment jsdom
//
// AI models: ONE connection for the deployment (2026-11-04) — one Models view, one enabled list, one default; the
// Costs tab is a URL. Save sends the single list and default, and only when something changed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let tab: string | null = null;
const replace = vi.fn((url: string) => {
  tab = url.includes("tab=pricing") ? "pricing" : null;
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => ({ get: (k: string) => (k === "tab" ? tab : null) }),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("@/components/ops/ModelPricingPanel", () => ({
  ModelPricingPanel: (props: { knownModels: string[] }) => <div>pricing:{props.knownModels.join(",")}</div>,
}));

const api = vi.hoisted(() => ({
  getLlmProvider: vi.fn(),
  saveLlmProvider: vi.fn(),
  llmModels: vi.fn(),
  llmTest: vi.fn(),
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
  forgeReachable: true,
  forgeWarning: null,
};

let Page: React.ComponentType;
beforeEach(async () => {
  tab = null;
  api.saveLlmProvider.mockReset();
  api.saveLlmProvider.mockResolvedValue(runtime);
  api.getLlmProvider.mockResolvedValue(runtime);
  Page = (await import("./page")).default;
});
afterEach(cleanup);

describe("AI models", () => {
  it("opens one Models view by default", async () => {
    render(<Page />);
    expect(await screen.findByText("Connection")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Models" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Builder" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Runtime" })).toBeNull();
    expect(screen.getByText("Stored key ab12cd34. Leave blank to keep it.")).toBeTruthy();
  });

  it("Save is off until something changes", async () => {
    render(<Page />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Enable gpt-b"));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows one default among the ticked models", async () => {
    render(<Page />);
    // Fetched, so the unticked row stays listed (a saved model only stays on screen while enabled or advertised).
    api.llmModels.mockResolvedValue({ models: ["gpt-a", "gpt-b"], caveat: "" });
    await screen.findByRole("button", { name: "Save" });
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    await waitFor(() => expect(api.llmModels).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText("Enable gpt-b"));
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).disabled).toBe(true);
  });

  it("Save sends one list and one default", async () => {
    render(<Page />);
    await screen.findByRole("button", { name: "Save" });
    fireEvent.click(screen.getByLabelText("Enable gpt-b"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveLlmProvider).toHaveBeenCalledWith({
        baseUrl: "https://gw.example/v1",
        apiKey: undefined,
        defaultModel: "gpt-a",
        allowedModels: ["gpt-a"],
      }),
    );
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

  it("shows a Forge warning when Forge cannot reach the gateway", async () => {
    api.getLlmProvider.mockResolvedValue({ ...runtime, forgeReachable: false, forgeWarning: "Forge chats can only reach gw.example." });
    render(<Page />);
    expect(await screen.findByText("Forge chats cannot reach this gateway")).toBeTruthy();
    expect(screen.getByText("Forge chats can only reach gw.example.")).toBeTruthy();
  });

  it("the Costs tab is a URL", async () => {
    tab = "pricing";
    render(<Page />);
    expect(await screen.findByText("pricing:gpt-a,gpt-b")).toBeTruthy();
    expect(screen.queryByText("Connection")).toBeNull();
  });
});
