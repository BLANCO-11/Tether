// @vitest-environment jsdom
//
// src/components/layout/primitives.test.tsx — the layout primitives, and the
// properties that make them worth having.
//
// ── WHAT IS AND IS NOT ASSERTED HERE ────────────────────────────────────────
//
// These components exist to make a LAYOUT RULE checkable, so the assertions are
// about the rule, not about pixels: which measure a page carries, that the five
// zones keep one order, that a tone reaches the element that shows it. jsdom
// performs no layout — it computes no widths and resolves no custom properties
// across a media query — so an assertion about how anything LOOKS would run over
// nothing and pass for ever (`ISSUES.md` I-38). The screenshot ledger in
// `ui-upgrade/evidence.md` §5 is where appearance gets checked.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Page, Zone, type ZoneName } from "./Page";
import { PageHeader } from "./PageHeader";
import { Workbench, WorkbenchPane } from "./Workbench";
import { PANES, type WorkbenchVariant } from "@/lib/workbench";
import { Notice } from "@/components/ui/Notice";
import { Tile } from "@/components/ui/Tile";
import { DataTable, COLUMN_SETS, type ColumnSet } from "@/components/ui/DataTable";
import { Strip, cellStyle, type CellState } from "@/components/ui/Strip";
import { STATUS_WORDS, STATUS_STYLE, STATUS_LABEL } from "@/lib/status";

afterEach(cleanup);

describe("Page owns the measure", () => {
  it("defaults to the page measure", () => {
    const { container } = render(<Page><Zone name="content">x</Zone></Page>);
    expect(container.firstElementChild?.className).toContain("max-w-page");
  });

  it("carries the archetype it was given", () => {
    for (const [measure, cls] of [["form", "max-w-form"], ["wide", "max-w-wide"]] as const) {
      cleanup();
      const { container } = render(<Page measure={measure}><Zone name="content">x</Zone></Page>);
      expect(container.firstElementChild?.className).toContain(cls);
    }
  });

  it("offers exactly three measures and no arbitrary width", () => {
    // The whole point of D-78 is that a page cannot invent a fourth. If this
    // component ever grows a `width` prop, the honesty assertion that no page
    // sets `max-w-` becomes theatre — the width just moves one file over.
    const { container } = render(<Page measure="wide"><Zone name="content">x</Zone></Page>);
    const cls = container.firstElementChild?.className ?? "";
    expect(cls).not.toMatch(/max-w-\[/); // no arbitrary-value escape hatch
    expect(cls.match(/max-w-\S+/g)).toHaveLength(1);
  });
});

describe("Zone keeps one order", () => {
  const ORDER: ZoneName[] = ["header", "notices", "controls", "content", "related"];

  it("renders the five zones in the order they were written", () => {
    const { container } = render(
      <Page>
        {ORDER.map((n) => (
          <Zone key={n} name={n}>{n}</Zone>
        ))}
      </Page>,
    );
    const seen = [...container.querySelectorAll("[data-zone]")].map((e) => e.getAttribute("data-zone"));
    expect(seen).toEqual(ORDER);
  });

  it("marks each zone so the structure is inspectable", () => {
    // `data-zone` is the only way a reviewer, a test or a person with dev tools
    // can see the rule being followed. A layout rule nobody can inspect is a
    // layout rule nobody can check.
    render(<Page><Zone name="notices">n</Zone></Page>);
    expect(document.querySelector('[data-zone="notices"]')).not.toBeNull();
  });

  it("lets a zone be absent without disturbing the rest", () => {
    const { container } = render(
      <Page>
        <Zone name="header">h</Zone>
        <Zone name="content">c</Zone>
      </Page>,
    );
    expect([...container.querySelectorAll("[data-zone]")].map((e) => e.getAttribute("data-zone")))
      .toEqual(["header", "content"]);
  });

  it("gives zone 5 its own separation and no other zone one", () => {
    // /flows renders FlowLibrary flush against the automation list today, where
    // it reads as more of the list. The gap IS the difference between "more
    // rows" and "a different question".
    render(
      <Page>
        <Zone name="content">c</Zone>
        <Zone name="related">r</Zone>
      </Page>,
    );
    const related = document.querySelector('[data-zone="related"]')!;
    const content = document.querySelector('[data-zone="content"]')!;
    expect(related.className).toContain("border-t");
    expect(content.className).not.toContain("border-t");
  });

  it("renders zone 1 as a real <header> when asked", () => {
    render(<Page><Zone name="header" as="header">h</Zone></Page>);
    expect(document.querySelector("header[data-zone='header']")).not.toBeNull();
  });
});

describe("Notice replaces the four inline recipes", () => {
  it("shows the claim and the detail", () => {
    render(<Notice tone="danger" title="Two secrets share a name">The second one is shadowed.</Notice>);
    expect(screen.getByText("Two secrets share a name")).toBeTruthy();
    expect(screen.getByText("The second one is shadowed.")).toBeTruthy();
  });

  it("keeps warn and danger visibly distinct", () => {
    // The boundary this component exists to hold: "it needs a person" and "it
    // went wrong" are different problems with different fixes, and a UI that
    // renders both amber makes the actionable one invisible.
    const { container: warn } = render(<Notice tone="warn" title="Needs a first run" />);
    const { container: danger } = render(<Notice tone="danger" title="It failed" />);
    const w = warn.firstElementChild!.className;
    const d = danger.firstElementChild!.className;
    expect(w).toContain("warn");
    expect(d).toContain("danger");
    expect(w).not.toEqual(d);
  });

  it("defaults to info rather than to an alarm", () => {
    const { container } = render(<Notice title="This page is a placeholder" />);
    expect(container.firstElementChild?.getAttribute("data-tone")).toBe("info");
  });

  it("renders every tone through a token, never a literal", () => {
    // The Phase 1 rule, enforced where it is easiest to break: a tone map is
    // exactly the shape that tempts a hex.
    for (const tone of ["danger", "warn", "info", "ok"] as const) {
      cleanup();
      const { container } = render(<Notice tone={tone} title="t" />);
      expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it("announces without interrupting", () => {
    // role=status, not role=alert: these render WITH the page. `alert` on a
    // banner present at load talks over whatever the person was reading.
    render(<Notice tone="danger" title="t" />);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});

describe("Tile can say that a figure is bad", () => {
  it("accepts all five status words", () => {
    for (const tone of STATUS_WORDS) {
      cleanup();
      const { container } = render(<Tile label="Success rate" value="40%" note={STATUS_LABEL[tone]} tone={tone} />);
      expect(container.firstElementChild?.getAttribute("data-tone")).toBe(tone);
    }
  });

  it("renders a failing figure in danger, not in amber", () => {
    // This is I-76, as an assertion. `/dashboard` passed `rate >= 95 ? ok : warn`
    // against a two-tone component, so 40% rendered amber — the worst colour it
    // had. The point of widening the vocabulary is that this line can now fail.
    const { container } = render(<Tile label="Success rate" value="40%" note="12 of 20 failed" tone="failed" />);
    expect(container.innerHTML).toContain(STATUS_STYLE.failed.text);
    expect(container.innerHTML).not.toContain(STATUS_STYLE.blocked.text);
  });

  it("defaults to neutral, not to ok", () => {
    // The old default was `ok`, so a tile whose author had not thought about
    // tone claimed everything was fine. A tile with nothing to say says nothing.
    const { container } = render(<Tile label="Runs today" value="3" note="since midnight" />);
    expect(container.firstElementChild?.getAttribute("data-tone")).toBe("draft");
    expect(container.innerHTML).toContain(STATUS_STYLE.draft.text);
  });

  it("never colours the figure itself", () => {
    // A large coloured number is read as a status on its own, and then the note
    // beneath it has nothing left to say.
    render(<Tile label="Failed" value="7" note="in the last day" tone="failed" />);
    const figure = screen.getByText("7");
    expect(figure.className).toContain("text-text");
    expect(figure.className).not.toContain("text-danger");
  });
});

describe("the status vocabulary is one definition", () => {
  it("has exactly five words", () => {
    // Widening this is a design decision, not a convenience. The list is short
    // because a person has to hold all of it in their head to read a dashboard.
    expect(STATUS_WORDS).toHaveLength(5);
  });

  it("gives every word a style and a label", () => {
    for (const w of STATUS_WORDS) {
      expect(STATUS_STYLE[w], `${w} has no style`).toBeTruthy();
      expect(STATUS_LABEL[w], `${w} has no label`).toBeTruthy();
    }
  });

  it("gives blocked and failed different colours", () => {
    // "It has never run" is fixed by running it; "it failed" is fixed by finding
    // out why. One colour can only be right about one of them.
    expect(STATUS_STYLE.blocked.text).not.toEqual(STATUS_STYLE.failed.text);
  });

  it("keeps draft neutral", () => {
    // Most drafts are drafts on purpose. Colouring them as a problem makes the
    // colour meaningless on the screens where something actually is one.
    expect(STATUS_STYLE.draft.text).toBe("text-muted");
  });

  it("uses no colour literal anywhere in the map", () => {
    expect(JSON.stringify(STATUS_STYLE)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

describe("PageHeader is zone 1, and zone 1 is only it", () => {
  it("renders its own header zone", () => {
    // Not decoration: if the header did NOT own the zone, a page could put a
    // second thing in zone 1 and the "verbs only" rule would hold for the
    // component while being false of the top of the page.
    render(<PageHeader title="Triggers" purpose="What starts an automation." />);
    expect(document.querySelector("header[data-zone='header']")).not.toBeNull();
  });

  it("shows the eyebrow, the title and the purpose", () => {
    render(<PageHeader eyebrow="Connect" title="Triggers" purpose="What starts an automation." />);
    expect(screen.getByText("Connect")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Triggers");
    expect(screen.getByText("What starts an automation.")).toBeTruthy();
  });

  it("makes the eyebrow optional and the purpose not", () => {
    // `purpose` is required by the type. This asserts the rendered consequence:
    // a page with no eyebrow still has exactly one h1 and one purpose line.
    const { container } = render(<PageHeader title="Keys" purpose="Credentials this workspace can use." />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders one action, and runs it", () => {
    const onClick = vi.fn();
    render(<PageHeader title="Triggers" purpose="p" actions={[{ label: "New trigger", onClick }]} />);
    fireEvent.click(screen.getByRole("button", { name: "New trigger" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("makes the first action primary and the second not", () => {
    // Two solid primaries side by side is a choice with no recommendation.
    render(
      <PageHeader
        title="Flows"
        purpose="p"
        actions={[{ label: "New automation" }, { label: "Import" }]}
      />,
    );
    const first = screen.getByRole("button", { name: "New automation" });
    const second = screen.getByRole("button", { name: "Import" });
    expect(first.className).toContain("bg-accent");
    expect(second.className).not.toContain("bg-accent");
  });

  it("renders an href action as a link, not a button", () => {
    render(<PageHeader title="Runs" purpose="p" actions={[{ label: "All runs", href: "/history" }]} />);
    const link = screen.getByRole("link", { name: "All runs" });
    expect(link.getAttribute("href")).toBe("/history");
  });

  it("refuses a control by having nowhere to put one", () => {
    // The real assertion is in the TYPE: `actions` is a tuple of HeaderAction
    // records, so `<Input>` and `<Select>` are not expressible and `tsc` is the
    // check (D-93). What is checkable at runtime is the consequence — the header
    // renders no form control of any kind, whatever it was handed.
    const { container } = render(
      <PageHeader title="Apps" purpose="p" actions={[{ label: "Connect an app" }, { label: "Refresh" }]} />,
    );
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });
});

describe("DataTable declares columns by role", () => {
  const SECRET_HEADS = {
    identity: "Name",
    meaning: "What it is for",
    state: "Stored",
    time: "Last used",
    actions: "",
  } as const;

  const row = (key: string) => ({
    key,
    cells: {
      identity: <span>{key}</span>,
      meaning: "the mailbox password",
      state: "Set",
      time: "2 days ago",
      actions: <button>Change</button>,
    },
  });

  it("renders one row per record, plus a head row", () => {
    render(
      <DataTable set="secret" caption="Secrets" heads={SECRET_HEADS} empty="none yet" rows={[row("A"), row("B")]} />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
  });

  it("puts the cells in the SET's order, not the object's", () => {
    // The property that makes two pages showing secrets look alike. The cells
    // object below is deliberately written in a scrambled order.
    render(
      <DataTable
        set="secret"
        caption="Secrets"
        heads={SECRET_HEADS}
        empty="none yet"
        rows={[
          {
            key: "one",
            cells: {
              actions: "act",
              time: "time",
              identity: "identity",
              state: "state",
              meaning: "meaning",
            },
          },
        ]}
      />,
    );
    const cells = [...document.querySelectorAll("[role='cell']")].map((c) => c.textContent);
    expect(cells).toEqual(["identity", "meaning", "state", "time", "act"]);
  });

  // ── The `detail` slot (Phase 4, added for /tools' expandable rows) ─────────
  it("renders a row's detail panel when the page supplies one", () => {
    render(
      <DataTable
        set="secret"
        caption="Secrets"
        heads={SECRET_HEADS}
        empty="none yet"
        rows={[{ ...row("A"), detail: <span>the parameters</span> }]}
      />,
    );
    expect(screen.getByText("the parameters")).toBeTruthy();
  });

  // ⚠ The property that keeps `DataTable` stateless. A table that owned an
  // open/closed set would be a second place deciding what a page shows; the page
  // passes `detail` only for the rows it wants open, so a collapsed row has no
  // panel in the DOM at all rather than a hidden one.
  it("renders NO panel for a row with no detail", () => {
    render(
      <DataTable set="secret" caption="Secrets" heads={SECRET_HEADS} empty="none yet" rows={[row("A")]} />,
    );
    expect(screen.queryByText("the parameters")).toBeNull();
  });

  // ⚠ A detail panel must not be able to line up with a column heading — that is
  // what stops it becoming the free-form template the named sets replaced. It is
  // outside the grid, so it holds no `role="cell"`.
  it("keeps the detail panel outside the column grid", () => {
    render(
      <DataTable
        set="secret"
        caption="Secrets"
        heads={SECRET_HEADS}
        empty="none yet"
        rows={[{ ...row("A"), detail: <span>the parameters</span> }]}
      />,
    );
    const cells = [...document.querySelectorAll("[role='cell']")].map((c) => c.textContent);
    expect(cells).toHaveLength(5);
    expect(cells.join("|")).not.toContain("the parameters");
  });

  it("names itself for a screen reader", () => {
    render(<DataTable set="run" caption="Recent runs" heads={{ time: "When", workflowName: "Workflow name", workflowId: "Workflow ID", runId: "Run ID", status: "Status", actions: "" }} empty="no runs" rows={[]} />);
    expect(screen.getByRole("table", { name: "Recent runs" })).toBeTruthy();
  });

  it("says why a collection is empty rather than rendering an empty box", () => {
    // Several of the nine grids this replaces render nothing at all, leaving the
    // reader to decide whether that means "none yet" or "it failed".
    render(<DataTable set="secret" caption="Secrets" heads={SECRET_HEADS} empty="No secrets yet." rows={[]} />);
    expect(screen.getByText("No secrets yet.")).toBeTruthy();
    expect(screen.queryAllByRole("row")).toHaveLength(1); // the head, and nothing else
  });

  it("offers a closed list of sets and no free-form template", () => {
    // A `columns={[…]}` prop would be the same nine bespoke grids with a shared
    // renderer. The set list IS the system; adding to it is a visible edit here.
    //
    // ⚠ It grew from five to seven in Phase 4, and this assertion is what made
    // that a decision rather than a drift: `/data-sources` and `/approvals` each
    // needed a shape no existing set had, and going red here is how the addition
    // got read. Do NOT relax this to a length check or a superset — the whole
    // value is that a new set cannot arrive unnoticed.
    //
    // ⚠ **`capability` is the eighth, added when `/apps` stopped being one flat
    // table of 267 rows.** It went red here first, which is the mechanism
    // working. The reason it is not a reuse of `plugin`: once you have opened
    // Slack, `source` (which plugin) and `time` (its version) are constant down
    // all 45 rows and belong in the heading, and D-94's own rule is that a set
    // which has to repeat itself is the wrong set. `/apps` still uses `plugin`
    // for a search ACROSS plugins, where the source genuinely varies.
    // ⚠ `incident` and `gate` are the ninth and tenth, added when /admin/incidents
    // and /admin/gates stopped rendering bespoke row markup. Neither reuses an
    // existing set: no set has the (identity · meaning · state · time · subject ·
    // actions) or (identity · meaning · state · actions) shape.
    expect(Object.keys(COLUMN_SETS).sort()).toEqual([
      "approval", "capability", "column", "datasource", "gate", "incident", "mapping", "plugin", "resource", "rollup", "run", "secret", "tool",
      "trigger",
    ]);
  });

  // ⚠ NARROWED in Phase 4, from "every set has actions" to "actions, WHERE THEY
  // EXIST, are last and right-aligned" (D-98). `rollup` is a list of things you
  // have measured rather than things you operate, and there is nothing to do to
  // a row of it — so the old assertion would have been satisfied by padding in an
  // empty column, which is a column existing to satisfy a rule. The property that
  // was actually worth having is unchanged and still fires: an actions column
  // cannot appear in the middle, and cannot be left-aligned.
  it("puts an actions column last and right-aligned wherever one exists", () => {
    let checked = 0;
    for (const name of Object.keys(COLUMN_SETS) as ColumnSet[]) {
      const cols = COLUMN_SETS[name].columns as readonly { key: string; align: string }[];
      const at = cols.findIndex((c) => c.key === "actions");
      if (at === -1) continue;
      checked += 1;
      expect(at, `${name}'s actions column position`).toBe(cols.length - 1);
      expect(cols[at].align, `${name}'s actions column`).toBe("end");
    }
    // A guard on the guard: a `continue`-based loop passes trivially if the role
    // is ever renamed and no set matches (I-38). Most sets still have one.
    expect(checked).toBeGreaterThan(4);
  });

  it("declares as many grid tracks as it has columns", () => {
    // The defect this catches is silent: a set whose grid has five tracks and six
    // roles drops the sixth cell into a phantom row with nothing to say about it.
    for (const name of Object.keys(COLUMN_SETS) as ColumnSet[]) {
      const spec = COLUMN_SETS[name];
      const tracks = spec.grid.replace(/^grid-cols-\[|\]$/g, "").split("_");
      expect(tracks.length, `${name} has ${spec.columns.length} roles`).toBe(spec.columns.length);
    }
  });
});

describe("Strip keeps its own vocabulary, and shares no word by accident", () => {
  const cells = (state: CellState) => [{ key: "k", label: "Send the email", state }];

  it("marks each cell with the state it was given", () => {
    for (const state of ["done", "active", "waiting", "warning", "failed", "skipped", "todo"] as CellState[]) {
      cleanup();
      render(<Strip cells={cells(state)} />);
      expect(document.querySelector(`[data-state="${state}"]`), state).not.toBeNull();
    }
  });

  it("shows a run waiting for a PERSON differently from a run doing work", () => {
    // I-82. `paused` used to render as `active`, so a run parked in somebody's
    // inbox for a week looked exactly like a run mid-execution.
    expect(cellStyle("waiting")).not.toEqual(cellStyle("active"));
    expect(cellStyle("waiting")).toContain("warn");
  });

  it("shows a degraded step differently from a failed one", () => {
    // It used to render as a failure. "Did not fully do its job" and "did not do
    // its job" are different claims about the same step.
    expect(cellStyle("warning")).not.toEqual(cellStyle("failed"));
  });

  it("agrees with the status vocabulary on every word the two share", () => {
    // D-92's actual rule. Two vocabularies are fine; one word meaning two things
    // is not — `blocked` meant "reached and failed" here and "needs a person"
    // there, in two different colours. Today `failed` is the only shared word.
    const shared = STATUS_WORDS.filter((w) => cellStyleFor(w) !== undefined);
    expect(shared).toEqual(["failed"]);
    for (const w of shared) {
      expect(cellStyle(w as CellState), `${w} must mean one thing`).toContain(
        STATUS_STYLE[w].text,
      );
    }
  });

  it("uses no colour literal", () => {
    for (const state of ["done", "active", "waiting", "warning", "failed", "skipped", "todo"] as CellState[]) {
      expect(cellStyle(state)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });
});

/**
 * ⚠ **The workbench's class name is a CONTRACT with `globals.css`**, and this is
 * the third leg of it. `lib/workbench.test.ts` proves the stylesheet's three
 * breakpoints equal `foldWidth()`; this proves the component asks for the class
 * those rules are keyed on. Without it, renaming the variant would leave a
 * workbench that silently never gets its columns — folded at every width, with
 * a stylesheet still claiming a breakpoint.
 */
describe("Workbench", () => {
  it("keys its class on the variant, which is what globals.css matches", () => {
    for (const variant of Object.keys(PANES) as WorkbenchVariant[]) {
      cleanup();
      const { container } = render(
        <Workbench variant={variant}>
          <WorkbenchPane label="only">x</WorkbenchPane>
        </Workbench>,
      );
      const el = container.querySelector(".workbench") as HTMLElement;
      expect(el.classList.contains(`wb-${variant}`), variant).toBe(true);
      expect(el.dataset.variant).toBe(variant);
    }
  });

  it("names every pane, because a grid of unlabelled regions cannot be navigated", () => {
    render(
      <Workbench variant="inspector">
        <WorkbenchPane label="Step palette">a</WorkbenchPane>
        <WorkbenchPane label="The flow you are building">b</WorkbenchPane>
        <WorkbenchPane label="Step settings">c</WorkbenchPane>
      </Workbench>,
    );
    for (const label of ["Step palette", "The flow you are building", "Step settings"]) {
      expect(screen.getByRole("region", { name: label })).toBeTruthy();
    }
  });

  it("sets no height of its own — the canvas density owns that", () => {
    // ⚠ D-102 and the note in globals.css: two owners of the row height disagree
    // the first time a density changes, leaving a band of empty surface nobody
    // chose. The grid must contribute nothing to it.
    const { container } = render(
      <Workbench variant="compose">
        <WorkbenchPane label="only">x</WorkbenchPane>
      </Workbench>,
    );
    const el = container.querySelector(".workbench") as HTMLElement;
    expect(el.style.height).toBe("");
    expect(el.style.minHeight).toBe("");
  });
});

/** `cellStyle` for a word that may not be a `CellState` — `undefined` when it is not one. */
function cellStyleFor(word: string): string | undefined {
  const states: CellState[] = ["done", "active", "waiting", "warning", "failed", "skipped", "todo"];
  return states.includes(word as CellState) ? cellStyle(word as CellState) : undefined;
}
