// @vitest-environment jsdom
/**
 * ⚠ The load-bearing test is the FALLBACK. A picker handed a value it cannot
 * hold renders empty, and Save then writes that emptiness over a real override —
 * the setting gone, the widget tidy throughout. Everything else here is the
 * ordinary "the right control appears".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { TriggerInputs, TriggerInputsEditor } from "./TriggerInputs";
import type { DeclaredInput, Trigger } from "@/lib/types";

vi.mock("@/lib/api", () => ({ setTriggerInputs: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));

afterEach(() => cleanup());

const input = (o: Partial<DeclaredInput>): DeclaredInput => ({
  id: "period",
  type: "STRING",
  required: true,
  value: null,
  source: "none",
  ...o,
});

const trig = (inputs: DeclaredInput[]): Trigger =>
  ({ id: "t1", name: "n", type: "manual", enabled: true, declaredInputs: inputs }) as unknown as Trigger;

describe("the editor renders the derived control", () => {
  it("gives a month input a month picker rather than a text box", () => {
    render(<TriggerInputsEditor trigger={trig([input({ format: "month" })])} />);
    const el = document.getElementById("in-t1-period") as HTMLInputElement;
    expect(el.type).toBe("month");
  });

  it("gives a boolean a two-value list, plus the empty option that REMOVES the override", () => {
    render(<TriggerInputsEditor trigger={trig([input({ id: "dry", format: "boolean" })])} />);
    const el = document.getElementById("in-t1-dry") as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    expect([...el.options].map((o) => o.value)).toEqual(["", "true", "false"]);
  });

  /**
   * ⚠ The ROUND TRIP, not the rendering. `datetime-local` carries no zone, so
   * the stored `Z` is stripped going in and re-asserted coming out — and if the
   * two halves ever disagree, a person who opens the box and presses Save
   * without touching it moves the timestamp by hours. jsdom renders this control
   * at minute precision whatever `step` says, so asserting its `value` verbatim
   * would pin a jsdom detail rather than the property.
   */
  it("strips the zone for the datetime control and puts it back on the way out", async () => {
    const { setTriggerInputs } = await import("@/lib/api");
    render(
      <TriggerInputsEditor
        trigger={trig([input({ id: "as_of", format: "datetime", value: "2026-06-29T10:00:00Z", source: "trigger" })])}
      />,
    );
    const el = document.getElementById("in-t1-as_of") as HTMLInputElement;
    expect(el.type).toBe("datetime-local");
    expect(el.value).toMatch(/^2026-06-29T10:00/); // the zone is gone for the control
    fireEvent.change(el, { target: { value: "2026-07-01T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: /Save inputs/ }));
    await vi.waitFor(() =>
      expect(setTriggerInputs).toHaveBeenCalledWith("t1", { as_of: "2026-07-01T09:30:00Z" }),
    );
  });

  it("⚠ says the value is the wrong shape rather than showing a bare text box", () => {
    render(<TriggerInputsEditor trigger={trig([input({ format: "month", value: "Q3", source: "trigger" })])} />);
    const el = document.getElementById("in-t1-period") as HTMLInputElement;
    expect(el.type).toBe("text");
    expect(screen.getByText(/not in the shape the automation expects/)).toBeTruthy();
  });

  it("does not accuse an ordinary text input of being the wrong shape", () => {
    render(<TriggerInputsEditor trigger={trig([input({ value: "Engineering", source: "trigger" })])} />);
    expect(screen.queryByText(/not in the shape/)).toBeNull();
  });
});

describe("what the label says", () => {
  it("names the control, so a person can see why it is not free text", () => {
    render(<TriggerInputsEditor trigger={trig([input({ format: "month" })])} />);
    expect(screen.getByText("month")).toBeTruthy();
  });

  it("says UTC on a datetime, because the control carries no zone", () => {
    render(<TriggerInputsEditor trigger={trig([input({ id: "as_of", format: "datetime" })])} />);
    expect(screen.getByText("date and time · UTC")).toBeTruthy();
  });
});

describe("clearing still removes the override", () => {
  it("sends an empty string for a picker the person emptied", async () => {
    const { setTriggerInputs } = await import("@/lib/api");
    render(
      <TriggerInputsEditor
        trigger={trig([input({ format: "month", value: "2026-06", source: "trigger" })])}
      />,
    );
    const el = document.getElementById("in-t1-period") as HTMLInputElement;
    fireEvent.change(el, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Save inputs/ }));
    await vi.waitFor(() => expect(setTriggerInputs).toHaveBeenCalledWith("t1", { period: "" }));
  });
});

describe("the read-only list names a derivation", () => {
  it("a computed input reads derived, with which derivation — and the editor is untouched", () => {
    const { container } = render(
      <TriggerInputs trigger={trig([input({ value: null, source: "computed", computed: "priorMonth" })])} />,
    );
    expect(container.textContent).toContain("derived from the run's firing time");
    expect(container.textContent).toContain("month just ended");
    expect(container.textContent).toContain("no value");
  });
});
