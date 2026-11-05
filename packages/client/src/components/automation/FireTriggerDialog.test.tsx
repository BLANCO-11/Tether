// @vitest-environment jsdom
/**
 * The run sheet: per-fire values for one manual fire, saved nowhere.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { fireTriggerWithInputs } from "@/lib/api";
import { FireTriggerDialog } from "./FireTriggerDialog";
import type { ReactNode } from "react";
import type { DeclaredInput, Trigger } from "@/lib/types";

afterEach(() => cleanup());

vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/api", () => ({ fireTriggerWithInputs: vi.fn() }));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));

const input = (o: Partial<DeclaredInput>): DeclaredInput => ({
  id: "period",
  type: "STRING",
  required: true,
  value: null,
  source: "none",
  format: "month",
  ...o,
});

const trig = (inputs: DeclaredInput[]): Trigger =>
  ({ id: "t1", name: "run now", declaredInputs: inputs }) as unknown as Trigger;

const open = (t: Trigger, initial?: Record<string, string>) =>
  render(
    <FireTriggerDialog trigger={t} initial={initial} open onClose={() => {}} onFired={() => {}} />,
  );

describe("the run sheet", () => {
  it("renders one typed control per declared input", () => {
    open(trig([input({}), input({ id: "sender", source: "plan", value: "ops@example.com" })]));
    expect(document.getElementById("fire-t1-period")).toBeTruthy();
    expect(document.getElementById("fire-t1-sender")).toBeTruthy();
  });

  it("disables Run while a required input nobody supplies is blank", () => {
    open(trig([input({})]));
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a blank box the plan supplies is correct — Run stays enabled", () => {
    open(trig([input({ source: "plan", value: "2026-08", format: "month" })]));
    expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the typed values with the fire, and nothing else", async () => {
    vi.mocked(fireTriggerWithInputs).mockResolvedValueOnce({ fireId: "f1", started: true });
    const onFired = vi.fn();
    const onClose = vi.fn();
    render(
      <FireTriggerDialog trigger={trig([input({})])} open onClose={onClose} onFired={onFired} />,
    );
    const el = document.getElementById("fire-t1-period") as HTMLInputElement;
    fireEvent.change(el, { target: { value: "2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await vi.waitFor(() =>
      expect(fireTriggerWithInputs).toHaveBeenCalledWith("t1", { period: "2026-08" }),
    );
  });

  it("seeds from the opener's form values when given", () => {
    open(trig([input({})]), { period: "2026-07" });
    expect((document.getElementById("fire-t1-period") as HTMLInputElement).value).toBe("2026-07");
  });

  it("a refusal stays on the sheet instead of closing it", async () => {
    vi.mocked(fireTriggerWithInputs).mockRejectedValueOnce(new Error("no approved revision"));
    const onClose = vi.fn();
    render(
      <FireTriggerDialog trigger={trig([input({})])} open onClose={onClose} onFired={() => {}} />,
    );
    const el = document.getElementById("fire-t1-period") as HTMLInputElement;
    fireEvent.change(el, { target: { value: "2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await vi.waitFor(() => expect(screen.getByText("no approved revision")).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});
