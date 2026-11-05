// @vitest-environment jsdom
// src/components/flow/TestWorkbenchPanel.test.tsx — the builder's inline test drawer.
//
// Source picker copy (Synthetic data = schema-derived, never real data), the
// dead situation-description box staying gone, the real-data gate order,
// and values reaching `run`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

const toast = vi.fn();
Object.assign(toast, { success: toast, error: toast, warn: toast });
vi.mock("@/lib/toast", () => ({ useToast: () => toast }));

import { TestWorkbenchPanel } from "./TestWorkbenchPanel";

vi.mock("@/lib/api", () => ({ flowReadSources: vi.fn(async () => []) }));
import { flowReadSources } from "@/lib/api";
const readSources = vi.mocked(flowReadSources);

afterEach(() => {
  cleanup();
  toast.mockClear();
});

function props(over: Record<string, unknown> = {}) {
  return {
    flowId: "flow-1",
    inputs: [{ id: "period", type: "string", required: true }],
    testing: false,
    notice: null,
    run: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ THE SOURCE PICKER IS GONE — and seven tests here covered it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * They asserted, correctly, that a run was refused until a card was chosen,
 * that "Real data" opened a gate needing an acknowledgement and the phrase
 * `RUN ON REAL DATA`, and that "Synthetic data" said it used
 * "datasource schemas and tool outputs, never real data".
 *
 * All of that was true of the COMPONENT and none of it was true of the SYSTEM.
 * `selected` was never sent anywhere — both cards produced identical requests —
 * and no datasource in this deployment has a sandbox, so every draft run reads
 * production. The tests were a faithful record of a ceremony.
 *
 * ⚠ **The three that asserted real behaviour are kept, with the ceremony taken
 * out of them**: values reaching `run`, a missing required input being refused
 * by name, and `initialValues` prefilling. Those properties did not change and
 * deleting them alongside the picker would have been the quiet option.
 *
 * See the component's header for the measurements behind the removal.
 */
describe("the inline test drawer", () => {
  it("⚠ the source picker and its gate are gone, along with the claim they carried", () => {
    render(<TestWorkbenchPanel {...props()} />);
    // The drawer is portalled to `document.body` (a `fixed` element inside an
    // ancestor carrying a `view-transition-name` is not fixed to the viewport),
    // so `container` is empty by design. Read the panel itself.
    const text = screen.getByRole("complementary", { name: "Test workflow" }).textContent ?? "";
    expect(screen.queryByRole("radio", { name: "Synthetic data" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Real data" })).toBeNull();
    // The claim that was false: no sandbox exists, so nothing was ever synthetic.
    expect(text).not.toContain("never real data");
    expect(text).not.toContain("RUN ON REAL DATA");
    // The inert checkbox that said email would not be sent, and sent it.
    expect(text).not.toContain("Suppress sending");
    // The control: the panel really did render.
    expect(screen.getByRole("button", { name: "Run all" })).toBeTruthy();
  });

  it("⚠ one click runs it — nothing to choose, nothing to confirm", () => {
    const run = vi.fn();
    render(<TestWorkbenchPanel {...props({ run })} />);
    fireEvent.change(screen.getByLabelText("period"), { target: { value: "2024-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ period: "2024-01" });
  });

  /** Unchanged property: the refusal names the field, and it is not the picker's. */
  it("a missing required input blocks the run and says which", () => {
    const run = vi.fn();
    render(<TestWorkbenchPanel {...props({ run })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText(/Give a value for period/)).toBeTruthy();
  });

  /**
   * A derivation IS an answer: a required input with `computed` is never
   * `missing`, is never prefilled with an expression (there is nothing to
   * prefill — the engine resolves it at run creation), and the hint says why
   * the blank box is correct. Typing a value still overrides it for that run.
   */
  it("a derived input is not demanded and says it derives when the run starts", () => {
    const run = vi.fn();
    render(
      <TestWorkbenchPanel
        {...props({
          run,
          inputs: [{ id: "period", type: "STRING", required: true, computed: "priorMonth" }],
        })}
      />,
    );
    // Blank, not prefilled with anything — and nothing demands a value.
    expect((screen.getByLabelText("period") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("derived when the run starts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({});
    expect(screen.queryByText(/still needed/)).toBeNull();
    expect(screen.queryByText(/Give a value for/)).toBeNull();
  });

  it("typing a value for a derived input overrides it for that run", () => {
    const run = vi.fn();
    render(
      <TestWorkbenchPanel
        {...props({
          run,
          inputs: [{ id: "period", type: "STRING", required: true, computed: "priorMonth" }],
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText("period"), { target: { value: "2024-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).toHaveBeenCalledWith({ period: "2024-01" });
  });

  it("initialValues prefill the inputs and pass straight through", () => {
    const run = vi.fn();
    render(<TestWorkbenchPanel {...props({ run, initialValues: { period: "2024-01" } })} />);
    expect((screen.getByLabelText("period") as HTMLInputElement).value).toBe("2024-01");
    fireEvent.click(screen.getByRole("button", { name: "Run all" }));
    expect(run).toHaveBeenCalledWith({ period: "2024-01" });
  });
  /**
   * Step 7 — the drawer renders the SERVER's derived control, not the declared
   * type alone: a STRING the flow uses as a month gets a month picker. An input
   * the server derived nothing for falls back to its declared type.
   */
  it("a STRING input with server format month renders a month picker", () => {
    render(
      <TestWorkbenchPanel
        {...props({ inputs: [{ id: "period", type: "STRING", required: true, format: "month" }] })}
      />,
    );
    expect((screen.getByLabelText("period") as HTMLInputElement).type).toBe("month");
  });

  it("an input with no server format falls back to its declared type", () => {
    render(
      <TestWorkbenchPanel
        {...props({ inputs: [{ id: "as_of", type: "DATE", required: true }] })}
      />,
    );
    expect((screen.getByLabelText("as_of") as HTMLInputElement).type).toBe("date");
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(<TestWorkbenchPanel {...props({ onClose })} />);
    fireEvent.click(screen.getByRole("button", { name: "Close test panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * ---------------------------------------------------------------------------
   * REPORTED FROM USE, TWICE -- "no way to hide or remove it"
   * ---------------------------------------------------------------------------
   *
   * The test above has passed the whole time the drawer was unclosable in a
   * browser, and it will keep passing: jsdom lays nothing out, so it can click
   * a button that is scrolled off the top or painted over. That is I-38 at the
   * one place a person is stuck, and it is why these three exist -- not because
   * they discriminate better (they cannot; nothing here can), but because they
   * pin the three dismissals that do NOT depend on hitting one small target.
   */
  it("Escape closes it, without the drawer holding focus", () => {
    const onClose = vi.fn();
    render(<TestWorkbenchPanel {...props({ onClose })} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click outside closes it", () => {
    const onClose = vi.fn();
    render(<TestWorkbenchPanel {...props({ onClose })} />);
    fireEvent.click(screen.getByTestId("test-panel-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the header is sticky, so the close button survives a scrolled result", () => {
    // The likeliest cause of the report: this `<aside>` is its own scroll
    // container and a run's results are long, so reading them took the header
    // off the top. Asserting the class is all jsdom can do -- there is no
    // layout to measure -- and it is still the difference between the control
    // existing and not.
    render(<TestWorkbenchPanel {...props()} />);
    const close = screen.getByRole("button", { name: "Close test panel" });
    const header = close.parentElement!;
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    // A transparent sticky header shows the content sliding under it.
    expect(header.className).toContain("bg-surface");
  });

  it("is portalled out of the tree it was rendered in", () => {
    // `position: fixed` resolves against an ancestor carrying a
    // `view-transition-name`, and `.builder-route` carries one. Out at the body
    // there is no such ancestor -- and no `z-40` canvas click-catcher and no
    // `z-50` expanded-canvas overlay to lose to either.
    const { container } = render(<TestWorkbenchPanel {...props()} />);
    expect(container.textContent).toBe("");
    const aside = screen.getByRole("complementary", { name: "Test workflow" });
    expect(aside.parentElement).toBe(document.body);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ REPORTED FROM USE — "runs but i dont see any data"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The drawer took no run result at all. It showed a source picker, the declared
 * inputs, a button and a one-line notice; the outcome lived only as coloured
 * rings on canvas nodes, which this fixed right-hand drawer was covering. The
 * complaint was a literal description of the component.
 *
 * ⚠ Every test below is about what is SHOWN, and the shape they run against is
 * a real `FlowExecutionDetail` — including a step that never ran, because on a
 * branching flow the arm that did not fire is precisely what a person opened
 * this panel to see.
 */
function step(over: Record<string, unknown> = {}) {
  return {
    stepId: "fetch",
    status: "succeeded",
    kind: "datasource",
    platform: false,
    ref: "support_demo.csat_by_team",
    readFrom: "production",
    attempt: 0,
    startedAt: null,
    endedAt: null,
    durationMs: 42,
    request: null,
    responseCode: null,
    output: { results: [{ a: 1 }, { a: 2 }] },
    error: null,
    logs: [],
    kestraTaskrunId: null,
    auditVerdict: null,
    oracleScore: null,
    ...over,
  };
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: "3e04cf71-0e24-49d8-a2b8-7e1ef6d1340b",
    engineStatus: "succeeded",
    steps: [step()],
    graph: null,
    expectations: [],
    ...over,
  } as never;
}

describe("what the run actually did", () => {
  /** The control: with no run there is no results section, not an empty one. */
  it("shows nothing before a run — an empty section is not a result", () => {
    render(<TestWorkbenchPanel {...props()} />);
    expect(screen.queryByTestId("test-run-result")).toBeNull();
  });

  it("⚠ names each step, its outcome and how many rows it produced", () => {
    render(<TestWorkbenchPanel {...props({ result: run() })} />);
    expect(screen.getByTestId("test-run-result")).toBeTruthy();
    expect(screen.getByText("fetch")).toBeTruthy();
    expect(screen.getByText(/2 rows/)).toBeTruthy();
  });

  /**
   * ⚠ A draft run that read PRODUCTION is the value worth surfacing, not the
   * one to hide (D-52): it means this test just touched the tenant's real data.
   */
  it("says which database a step read", () => {
    render(<TestWorkbenchPanel {...props({ result: run() })} />);
    expect(screen.getByText(/read production/)).toBeTruthy();
  });

  /**
   * ⚠ **THE FAILURE THAT STARTED THIS.** The engine's own words reached a
   * database column and a log line and no screen; the person saw "failed" and
   * had nowhere to go. The reason is rendered verbatim — never summarised,
   * because a paraphrase of an engine error is a second, worse error message.
   */
  it("shows the engine's reason for a failed step, verbatim", () => {
    const why = "Unable to find `trigger` used in the expression";
    render(
      <TestWorkbenchPanel
        {...props({
          result: run({
            engineStatus: "failed",
            steps: [step({ status: "failed", error: why, output: null })],
          }),
        })}
      />,
    );
    expect(screen.getByText(why)).toBeTruthy();
  });

  /** A step that never ran is listed, or the arm that did not fire is invisible. */
  it("lists a step that never started rather than omitting it", () => {
    render(
      <TestWorkbenchPanel
        {...props({
          result: run({ steps: [step(), step({ stepId: "allclear", status: "created", output: null })] }),
        })}
      />,
    );
    expect(screen.getByText("allclear")).toBeTruthy();
    expect(screen.getByText(/not started/)).toBeTruthy();
  });

  /** I-301 C: a green run whose filter kept nothing says so on that step — valid, deployed, and empty looks exactly like this. */
  it("says when a step produced no rows; CONTROL: nothing is said without the server's note", () => {
    const { unmount } = render(<TestWorkbenchPanel {...props({ result: run({ noRows: [{ stepId: "fetch", note: "kept no rows" }] }) })} />);
    expect(screen.getByTestId("step-no-rows").textContent).toMatch(/This step kept no rows/);
    unmount();
    render(<TestWorkbenchPanel {...props({ result: run() })} />);
    expect(screen.queryByTestId("step-no-rows")).toBeNull();
  });

  /** Unreadable renders as unreadable — never as "it did nothing". */
  it("says so when the engine's view could not be read", () => {
    render(
      <TestWorkbenchPanel
        {...props({ result: run({ steps: [], engineUnavailable: "connect ECONNREFUSED" }) })}
      />,
    );
    expect(screen.getByText(/could not be reached/)).toBeTruthy();
    expect(screen.queryByText(/No steps have been reported/)).toBeNull();
  });
});

/**
 * ⚠ The panel used to print *"This will not send email. Step 10 runs against a
 * mock mailbox"* on every flow — a claim from the design pack's flagship
 * example, naming a step number no other flow has, sitting directly above the
 * button that runs the thing. On a real-data run against a tool that delivers,
 * it was false reassurance.
 */
describe("the pre-run sentence makes no promise it cannot keep", () => {
  it("does not claim email is suppressed, and names no step number", () => {
    render(<TestWorkbenchPanel {...props()} />);
    // The drawer is portalled to `document.body` (a `fixed` element inside an
    // ancestor carrying a `view-transition-name` is not fixed to the viewport),
    // so `container` is empty by design. Read the panel itself.
    const text = screen.getByRole("complementary", { name: "Test workflow" }).textContent ?? "";
    // The control: the sentence being asserted about is actually present.
    expect(text).toContain("really calls this workflow's tools");
    expect(text).not.toContain("will not send email");
    expect(text).not.toContain("Step 10");
    expect(text).not.toContain("mock mailbox");
  });
});


/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REPORTED FROM USE — "I don't see the option for test with real data or
 * synthetic data"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There is no option, and there must not be one. Selection is bound to the
 * Kestra namespace (D-52): `stepBatchSchema` has no field for it and nothing in
 * a request can change it. The picker that used to be here sent BYTE-IDENTICAL
 * requests for both of its cards — measured before it was deleted.
 *
 * What was genuinely missing is the ANSWER, before the button rather than only
 * after it. These four cases are that answer's four states.
 */
describe("what this run will read, before it runs", () => {
  beforeEach(() => readSources.mockReset());

  it("ready mock data says SYNTHETIC COPY, and not 'safe'", async () => {
    readSources.mockResolvedValue([{ name: "hr_demo", hasSandbox: false, dbName: null, mockStatus: "ready" }]);
    render(<TestWorkbenchPanel {...props({ datasourceRefs: ["hr_demo.attendance_all"] })} />);
    await waitFor(() => expect(screen.getByTestId("test-reads").textContent).toContain("hr_demo"));
    expect(screen.getByTestId("test-reads").textContent).toContain("synthetic copy");
  });

  it("NO mock data says the run REFUSES — never 'real records', which is the opposite of what happens", async () => {
    // A draft run with no mock data is refused by `runMockBatch` (409); it never reads production without the opt-in.
    readSources.mockResolvedValue([{ name: "orders_demo", hasSandbox: false, dbName: null, mockStatus: "none" }]);
    render(<TestWorkbenchPanel {...props({ datasourceRefs: ["orders_demo.late"] })} />);
    await waitFor(() => expect(screen.getByTestId("test-reads").textContent).toContain("no mock data"));
    expect(screen.getByTestId("test-reads").textContent).toContain("refuses");
    expect(screen.getByTestId("test-reads").textContent).not.toContain("real records");
  });

  it("an unreadable mock status says so, and claims neither answer", async () => {
    readSources.mockResolvedValue([{ name: "orders_demo", hasSandbox: false, dbName: null, mockStatus: null }]);
    render(<TestWorkbenchPanel {...props({ datasourceRefs: ["orders_demo.late"] })} />);
    await waitFor(() => expect(screen.getByTestId("test-reads").textContent).toContain("could not be checked"));
    expect(screen.getByTestId("test-reads").textContent).not.toContain("real records");
    expect(screen.getByTestId("test-reads").textContent).not.toContain("synthetic copy");
  });

  it("unreadable says the check did not run, and claims NEITHER answer", async () => {
    // The `faFallback` shape is the one to avoid here above anywhere: an empty
    // list would render as "nothing to worry about" when the truth is "we could
    // not find out whether real records are about to be read".
    readSources.mockRejectedValueOnce(new Error("workspace unreachable"));
    render(<TestWorkbenchPanel {...props({ datasourceRefs: ["hr_demo.attendance_all"] })} />);
    // ⚠ Scoped to THIS panel, not `document.body`. The drawer is portalled to
    // the body, so a body-wide read picks up whatever an earlier test left
    // behind and the negative assertions pass or fail for the wrong reason —
    // the same trap the SandboxPanel suite hit.
    const aside = () => screen.getByRole("complementary", { name: "Test workflow" });
    await waitFor(() => expect(aside().textContent).toContain("could not be checked"));
    // ⚠ The LIST is absent, which is the claim. Not a substring check on the
    // words: the failure sentence itself says "…whether it reads a synthetic
    // copy or the real one", so `not.toContain("synthetic copy")` fails against
    // correct copy. Found by writing it wrong.
    expect(screen.queryByTestId("test-reads")).toBeNull();
    expect(aside().textContent).not.toContain("real records");
  });

  it("the TOOL sentence stays, and stays FIRST", async () => {
    // ⚠ Sandboxing the reads changes nothing about the sends: `/api/steps/tool`
    // never calls `envForExecution`, so a draft run really delivers. A panel
    // leading with "synthetic" would read as "this run is safe" — the false
    // reassurance the deleted hardcoded sentence gave, rebuilt.
    readSources.mockResolvedValue([{ name: "hr_demo", hasSandbox: false, dbName: null, mockStatus: "ready" }]);
    const { container } = render(
      <TestWorkbenchPanel {...props({ datasourceRefs: ["hr_demo.attendance_all"] })} />,
    );
    await waitFor(() => expect(screen.getByTestId("test-reads")).toBeTruthy());
    const text = screen.getByRole("complementary", { name: "Test workflow" }).textContent ?? "";
    expect(text).toContain("really calls this workflow's tools");
    expect(text.indexOf("really calls this workflow's tools")).toBeLessThan(
      text.indexOf("synthetic copy"),
    );
    expect(container).toBeTruthy();
  });

  it("offers no picker and no source cards — the deleted ceremony stays deleted", async () => {
    readSources.mockResolvedValue([{ name: "hr_demo", hasSandbox: true, dbName: "foundry_sbx_x" }]);
    render(<TestWorkbenchPanel {...props({ datasourceRefs: ["hr_demo.attendance_all"] })} />);
    await waitFor(() => expect(screen.getByTestId("test-reads")).toBeTruthy());
    const text = screen.getByRole("complementary", { name: "Test workflow" }).textContent ?? "";
    expect(text).not.toContain("Synthetic data");
    expect(text).not.toContain("Real data");
    expect(text).not.toContain("RUN ON REAL DATA");
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
