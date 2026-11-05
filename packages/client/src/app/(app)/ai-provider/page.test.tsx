// @vitest-environment jsdom
//
// AI connection: personal BYOK — provider picker, Connection + Costs tabs.
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

const presets = [
  {
    id: "openai" as const,
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEditable: false,
    keyHint: "sk-…",
    blurb: "GPT models via OpenAI’s API.",
  },
  {
    id: "openrouter" as const,
    label: "Claude and more (OpenRouter)",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEditable: false,
    keyHint: "sk-or-…",
    blurb: "Use this for Anthropic/Claude models.",
  },
  {
    id: "custom" as const,
    label: "Custom gateway",
    baseUrl: "",
    baseUrlEditable: true,
    keyHint: "API key",
    blurb: "Any OpenAI-compatible /v1 host.",
  },
];

const api = vi.hoisted(() => ({
  getLlmProvider: vi.fn(),
  saveLlmProvider: vi.fn(),
  llmModels: vi.fn(),
  llmTest: vi.fn(),
}));
vi.mock("@/lib/foundry-client", () => ({ foundryApi: api }));

const runtime = {
  configured: true,
  baseUrl: "https://api.openai.com/v1",
  keyFingerprint: "ab12cd34",
  defaultModel: "gpt-a",
  allowedModels: ["gpt-a", "gpt-b"],
  providerId: "openai",
  source: "configured" as const,
  updatedAt: null,
  forgeReachable: true,
  forgeWarning: null,
  presets,
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

describe("AI connection (personal BYOK)", () => {
  it("opens Your AI connection with provider picker", async () => {
    render(<Page />);
    expect(await screen.findByText("Your AI connection")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Connection" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText(/Connected · ab12cd34/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    expect(screen.getByRole("option", { name: /Claude and more/ })).toBeTruthy();
    expect(screen.getByText("Stored key ab12cd34. Leave blank to keep it.")).toBeTruthy();
  });

  it("Save is off until something changes", async () => {
    render(<Page />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Enable gpt-b"));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("picking OpenRouter fills its gateway URL", async () => {
    render(<Page />);
    await screen.findByRole("button", { name: "Save" });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI/ }));
    fireEvent.click(screen.getByRole("option", { name: /Claude and more/ }));
    expect((screen.getByDisplayValue("https://openrouter.ai/api/v1") as HTMLInputElement).value).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("Save sends providerId with the list and default", async () => {
    render(<Page />);
    await screen.findByRole("button", { name: "Save" });
    fireEvent.click(screen.getByLabelText("Enable gpt-b"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveLlmProvider).toHaveBeenCalledWith({
        baseUrl: "https://api.openai.com/v1",
        apiKey: undefined,
        defaultModel: "gpt-a",
        allowedModels: ["gpt-a"],
        providerId: "openai",
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
    expect(screen.queryByText("Choose a provider")).toBeNull();
  });

  it("with no personal key, shows the build default instead of Not connected", async () => {
    api.getLlmProvider.mockResolvedValue({
      configured: false,
      baseUrl: "",
      keyFingerprint: "",
      defaultModel: "",
      allowedModels: [],
      providerId: "openai",
      source: "env",
      updatedAt: null,
      forgeReachable: true,
      forgeWarning: null,
      presets,
      deploymentDefault: {
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-build",
        allowedModels: ["gpt-build", "gpt-other"],
        keyFingerprint: "deadbeef",
      },
    });
    render(<Page />);
    expect(await screen.findByText(/Build default · gpt-build/)).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(screen.getByText("Using the build default")).toBeTruthy();
    expect(screen.getByLabelText("Build default models")).toBeTruthy();
    expect(screen.getByText("Default · build")).toBeTruthy();
  });

  it("Not connected only when there is no personal key and no build default", async () => {
    api.getLlmProvider.mockResolvedValue({
      configured: false,
      baseUrl: "",
      keyFingerprint: "",
      defaultModel: "",
      allowedModels: [],
      providerId: "openai",
      source: "env",
      updatedAt: null,
      forgeReachable: true,
      forgeWarning: null,
      presets,
      deploymentDefault: null,
    });
    render(<Page />);
    expect(await screen.findByText("Not connected")).toBeTruthy();
  });
});
