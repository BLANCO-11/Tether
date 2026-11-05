// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getModelPricing: vi.fn(),
  setModelPrice: vi.fn(),
  getModelSpend: vi.fn(),
}));
const can = vi.hoisted(() => ({ allowed: true, spend: false }));

vi.mock("@/lib/foundry-client", () => ({ foundryApi: api }));
vi.mock("@/components/access/Can", () => ({
  useCanPlatform: (p: string) => {
    const ok = p === "platform.signals.read" ? can.spend : can.allowed;
    return { state: ok ? "allowed" : "denied", allowed: ok, denied: !ok, unreadable: false };
  },
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); } }));

const { ModelPricingPanel } = await import("./ModelPricingPanel");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  can.allowed = true;
  can.spend = false;
});

/** The models selected on the provider tabs, for the tests that edit a price. */
const SEL = ["gpt-x", "seen-only"];
const SEL_USE = { "seen-only": ["Builder"] };

const pricing = {
  prices: [{ model: "gpt-x", inputPer1m: 2, outputPer1m: 8, effectiveFrom: "2026-10-01T00:00:00Z", updatedBy: "a" }],
  modelsSeen: ["gpt-x", "seen-only"],
  currency: "USD",
  unit: "per 1M tokens",
};

describe("ModelPricingPanel", () => {
  it("lists only the models IN USE and those already priced — not every model allowed or seen", async () => {
    api.getModelPricing.mockResolvedValue(pricing);
    render(<ModelPricingPanel knownModels={["allowed-only", "gpt-x"]} inUse={{ "in-use": ["Workflows"] }} />);
    await screen.findByText("gpt-x");
    expect((screen.getByLabelText("gpt-x input price per 1M tokens") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("gpt-x output price per 1M tokens") as HTMLInputElement).value).toBe("8");
    expect(screen.getByText("in-use")).toBeTruthy();
    expect(screen.queryByText("allowed-only")).toBeNull();
    expect(screen.queryByText("seen-only")).toBeNull();
    expect(screen.getAllByText("no price — reported cost is used")).toHaveLength(1);
    // An allowed model is offered by "Add model", not listed.
    expect(document.querySelector('#pricing-known-models option[value="allowed-only"]')).toBeTruthy();
  });

  it("saves a new price for a model, as numbers", async () => {
    api.getModelPricing.mockResolvedValue(pricing);
    api.setModelPrice.mockResolvedValue({ prices: [] });
    render(<ModelPricingPanel knownModels={SEL} inUse={SEL_USE} />);
    await screen.findByText("seen-only");
    fireEvent.change(screen.getByLabelText("seen-only input price per 1M tokens"), { target: { value: "0.5" } });
    fireEvent.change(screen.getByLabelText("seen-only output price per 1M tokens"), { target: { value: "1.25" } });
    // The panel's other tables (spend) are absent here, so every row is a price row.
    const rows = screen.getAllByRole("row");
    const row = rows.find((r) => r.textContent?.includes("seen-only"))!;
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() =>
      expect(api.setModelPrice).toHaveBeenCalledWith({ model: "seen-only", inputPer1m: 0.5, outputPer1m: 1.25, cachedInputPer1m: null, cacheWritePer1m: null }),
    );
  });

  it("refuses a price that is not a number zero or more, without calling the server", async () => {
    api.getModelPricing.mockResolvedValue(pricing);
    render(<ModelPricingPanel knownModels={SEL} inUse={SEL_USE} />);
    await screen.findByText("gpt-x");
    fireEvent.change(screen.getByLabelText("gpt-x input price per 1M tokens"), { target: { value: "-1" } });
    expect(screen.getByText("A price is a number, zero or more.")).toBeTruthy();
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("gpt-x"))!;
    expect((row.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("is read-only for someone who may not change the models", async () => {
    can.allowed = false;
    api.getModelPricing.mockResolvedValue(pricing);
    render(<ModelPricingPanel knownModels={SEL} inUse={SEL_USE} />);
    await screen.findByText("gpt-x");
    expect((screen.getByLabelText("gpt-x input price per 1M tokens") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(/Only an administrator/)).toBeTruthy();
  });

  it("saves the cached-input and cache-write prices beside input and output", async () => {
    api.getModelPricing.mockResolvedValue(pricing);
    api.setModelPrice.mockResolvedValue({ prices: [] });
    render(<ModelPricingPanel knownModels={SEL} inUse={SEL_USE} />);
    await screen.findByText("gpt-x");
    fireEvent.change(screen.getByLabelText("gpt-x cached input price per 1M tokens"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("gpt-x cache write price per 1M tokens"), { target: { value: "2.5" } });
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("gpt-x"))!;
    fireEvent.click(row.querySelector("button:not([aria-expanded])")!);
    await waitFor(() =>
      expect(api.setModelPrice).toHaveBeenCalledWith({ model: "gpt-x", inputPer1m: 2, outputPer1m: 8, cachedInputPer1m: 0.2, cacheWritePer1m: 2.5 }),
    );
  });

  it("refuses a cached price with no input or output price to go with it", async () => {
    api.getModelPricing.mockResolvedValue(pricing);
    render(<ModelPricingPanel knownModels={SEL} inUse={SEL_USE} />);
    await screen.findByText("seen-only");
    fireEvent.change(screen.getByLabelText("seen-only cached input price per 1M tokens"), { target: { value: "0.1" } });
    expect(screen.getByText("Set an input or an output price.")).toBeTruthy();
  });

  it("marks the models in use and shows a model's price history, removals included", async () => {
    api.getModelPricing.mockResolvedValue({
      ...pricing,
      history: [
        { model: "gpt-x", inputPer1m: 2, outputPer1m: 8, effectiveFrom: "2026-10-01T00:00:00Z", updatedBy: "ada@x.example" },
        { model: "gpt-x", inputPer1m: null, outputPer1m: null, effectiveFrom: "2026-09-01T00:00:00Z", updatedBy: "ada@x.example" },
      ],
    });
    render(<ModelPricingPanel knownModels={SEL} inUse={{ "gpt-x": ["Workflows", "Builder"] }} />);
    await screen.findByText("gpt-x");
    expect(screen.getByText("Workflows")).toBeTruthy();
    expect(screen.getByText("Builder")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "History (2)" }));
    const list = screen.getByRole("list", { name: "Price history of gpt-x" });
    expect(list.textContent).toContain("input $2");
    expect(list.textContent).toContain("Price removed");
  });

  it("shows spend by model to someone who may read the deployment's usage, and calls out what nothing costed", async () => {
    can.spend = true;
    api.getModelPricing.mockResolvedValue(pricing);
    api.getModelSpend.mockResolvedValue({
      days: 30,
      currency: "USD",
      models: [
        { model: "gpt-x", calls: 4, tokensIn: 2_000_000, tokensCached: 500_000, tokensOut: 1_000_000, costUsd: 12, pricedUsd: 10, reportedUsd: 2, uncostedCalls: 0 },
        { model: "seen-only", calls: 3, tokensIn: 900, tokensCached: 0, tokensOut: 100, costUsd: 0, pricedUsd: 0, reportedUsd: 0, uncostedCalls: 3 },
      ],
    });
    render(<ModelPricingPanel knownModels={SEL} inUse={SEL_USE} />);
    expect(await screen.findByText("Spend by model")).toBeTruthy();
    expect((await screen.findAllByText("$12.00")).length).toBe(2); // the row and the total
    expect(screen.getByText(/3 call\(s\) to seen-only have no price/)).toBeTruthy();
    expect(api.getModelSpend).toHaveBeenCalledWith(30);
    fireEvent.change(screen.getByLabelText("Spend window"), { target: { value: "7" } });
    await waitFor(() => expect(api.getModelSpend).toHaveBeenCalledWith(7));
  });

  it("does not show or ask for the deployment's spend without permission", async () => {
    api.getModelPricing.mockResolvedValue(pricing);
    render(<ModelPricingPanel knownModels={SEL} inUse={SEL_USE} />);
    await screen.findByText("gpt-x");
    expect(screen.queryByText("Spend by model")).toBeNull();
    expect(api.getModelSpend).not.toHaveBeenCalled();
  });
});
