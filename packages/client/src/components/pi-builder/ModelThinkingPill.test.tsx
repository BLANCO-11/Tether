// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelThinkingPill, type PillMenu } from "./ModelThinkingPill";
import type { ThinkingLevel } from "@/lib/thinking-levels";

afterEach(() => cleanup());

const MODELS = ["gpt-6-luna", "DeepSeek-V4-Flash-0731"];

function Harness(p: {
  models?: string[];
  thinking?: ThinkingLevel;
  disabled?: boolean;
  initial?: PillMenu | null;
  onPickModel?: (id: string) => Promise<void>;
  onPickThinking?: (l: ThinkingLevel) => Promise<void>;
}) {
  const [menu, setMenu] = useState<PillMenu | null>(p.initial ?? null);
  return (
    <ModelThinkingPill
      model="gpt-6-luna"
      models={p.models ?? MODELS}
      thinking={p.thinking}
      disabled={p.disabled ?? false}
      menu={menu}
      onMenu={setMenu}
      onPickModel={p.onPickModel ?? (async () => undefined)}
      onPickThinking={p.onPickThinking ?? (async () => undefined)}
    />
  );
}

describe("ModelThinkingPill", () => {
  it("shows the clean model name and the effort word", () => {
    render(<Harness thinking="balanced" />);
    const pill = screen.getByTestId("model-pill");
    expect(pill.textContent).toContain("GPT-6 Luna");
    expect(pill.textContent).toContain("Balanced");
    expect(pill.getAttribute("title")).toContain("gpt-6-luna");
  });

  it("has no effort word and no Thinking group without a thinking level", () => {
    render(<Harness />);
    expect(screen.getByTestId("model-pill").textContent).toBe("GPT-6 Luna");
    fireEvent.click(screen.getByTestId("model-pill"));
    expect(screen.getByRole("group", { name: "Model" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Thinking" })).toBeNull();
  });

  it("opens a menu listing both models with raw ids and the current one checked", () => {
    render(<Harness thinking="balanced" />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByTestId("model-pill"));
    const group = within(screen.getByRole("group", { name: "Model" }));
    const luna = group.getByRole("menuitemradio", { name: /GPT-6 Luna/ });
    expect(luna.getAttribute("aria-checked")).toBe("true");
    expect(luna.textContent).toContain("gpt-6-luna");
    const deep = group.getByRole("menuitemradio", { name: /DeepSeek V4 Flash/ });
    expect(deep.getAttribute("aria-checked")).toBe("false");
    expect(deep.textContent).toContain("DeepSeek-V4-Flash-0731");
  });

  it("picking a model sends the raw id and closes the menu", async () => {
    const onPickModel = vi.fn(async () => undefined);
    render(<Harness thinking="balanced" onPickModel={onPickModel} />);
    fireEvent.click(screen.getByTestId("model-pill"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /DeepSeek V4 Flash/ }));
    await waitFor(() => expect(onPickModel).toHaveBeenCalledWith("DeepSeek-V4-Flash-0731"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("picking a thinking level calls onPickThinking", async () => {
    const onPickThinking = vi.fn(async () => undefined);
    render(<Harness thinking="balanced" onPickThinking={onPickThinking} />);
    fireEvent.click(screen.getByTestId("model-pill"));
    fireEvent.click(within(screen.getByRole("group", { name: "Thinking" })).getByRole("menuitemradio", { name: /^High/ }));
    await waitFor(() => expect(onPickThinking).toHaveBeenCalledWith("high"));
  });

  it("is locked while Forge is working", () => {
    render(<Harness thinking="balanced" disabled />);
    const pill = screen.getByTestId("model-pill") as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    expect(pill.getAttribute("title")).toContain("Wait for Forge to finish to change it");
  });

  it("keeps the menu open and shows the reason when a change is refused", async () => {
    const onPickModel = vi.fn(async () => {
      throw new Error("Forge is still working.");
    });
    render(<Harness onPickModel={onPickModel} />);
    fireEvent.click(screen.getByTestId("model-pill"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /DeepSeek V4 Flash/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Forge is still working.");
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("Escape closes; ArrowDown moves focus and Enter picks", async () => {
    const onPickModel = vi.fn(async () => undefined);
    render(<Harness onPickModel={onPickModel} />);
    fireEvent.click(screen.getByTestId("model-pill"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByTestId("model-pill"));
    const luna = screen.getByRole("menuitemradio", { name: /GPT-6 Luna/ });
    const deep = screen.getByRole("menuitemradio", { name: /DeepSeek V4 Flash/ });
    expect(document.activeElement).toBe(luna);
    fireEvent.keyDown(luna, { key: "ArrowDown" });
    expect(document.activeElement).toBe(deep);
    fireEvent.keyDown(deep, { key: "Enter" });
    await waitFor(() => expect(onPickModel).toHaveBeenCalledWith("DeepSeek-V4-Flash-0731"));
  });

  it("with one model and no thinking it is plain text, not a button", () => {
    render(<Harness models={["gpt-6-luna"]} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("model-pill").textContent).toBe("GPT-6 Luna");
  });

  it("filters the model list", () => {
    render(<Harness initial={{ focus: "model", filter: "deep" }} />);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    expect(screen.getByRole("menuitemradio", { name: /DeepSeek V4 Flash/ })).toBeTruthy();
  });
});
