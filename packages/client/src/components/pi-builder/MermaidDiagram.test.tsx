// @vitest-environment jsdom
/**
 * ```mermaid blocks drawn as a picture, in a Markdown file's preview and in a chat reply (MermaidDiagram.tsx).
 * jsdom has no layout, so mermaid itself cannot draw here: it is replaced by a stand-in that returns a fixed SVG, or
 * fails for a block containing "BROKEN" — what is under test is what the page does with each answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, code: string) => {
    if (code.includes("BROKEN")) throw new Error("Parse error on line 2:\n...expecting 'NODE_STRING'");
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${code.length}</text></svg>` };
  }),
}));
vi.mock("mermaid", () => ({ default: { initialize: m.initialize, render: m.render } }));

import { Markdown, fencedParts } from "./Markdown";
import { markdownBlocks } from "./FileRenderers";

const FLOW = "flowchart LR\n  A[Chat] --> B[Server]";
const doc = (code: string, lang = "mermaid") => `# Architecture\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\nAfter.`;

beforeEach(() => {
  m.initialize.mockClear();
  m.render.mockClear();
});
afterEach(cleanup);

describe("a diagram is drawn as an IMAGE, so its text can never become markup", () => {
  it("in a Markdown file's preview", async () => {
    render(<article>{markdownBlocks(doc(FLOW))}</article>);
    const img = (await screen.findByAltText("Diagram")) as HTMLImageElement;
    expect(img.src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(m.render).toHaveBeenCalledWith(expect.stringMatching(/^mmd-/), FLOW);
    expect(m.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", htmlLabels: false, startOnLoad: false }));
    // The SVG is the image's source, never elements in the page.
    expect(document.querySelector("article svg")).toBeNull();
    expect(screen.getByText("After.")).toBeTruthy();
  });

  it("in a chat reply", async () => {
    render(<Markdown text={`Here is the design:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``} />);
    expect(((await screen.findByAltText("Diagram")) as HTMLImageElement).src).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText("Here is the design:")).toBeTruthy();
  });

  it("the source stays readable beside the picture", async () => {
    render(<Markdown text={`\`\`\`mermaid\n${FLOW}\n\`\`\``} />);
    await screen.findByAltText("Diagram");
    expect(screen.getByText("Diagram source")).toBeTruthy();
    expect(screen.getByTestId("diagram").textContent).toContain("A[Chat] --> B[Server]");
  });
});

describe("a diagram that does not parse", () => {
  it("shows why and its source — never an empty box", async () => {
    render(<article>{markdownBlocks(doc("flowchart LR\n  BROKEN -->"))}</article>);
    const box = await screen.findByTestId("diagram-error");
    expect(box.textContent).toContain("This diagram could not be drawn: Parse error on line 2:");
    expect(box.textContent).toContain("BROKEN -->");
    expect(screen.queryByAltText("Diagram")).toBeNull();
  });
  it("does not stop the next one drawing", async () => {
    render(<Markdown text={`\`\`\`mermaid\nBROKEN\n\`\`\`\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``} />);
    await screen.findByTestId("diagram-error");
    expect(await screen.findByAltText("Diagram")).toBeTruthy();
  });
});

describe("CONTROL: what is not a diagram is not drawn", () => {
  it("another language's block stays code, in both", () => {
    const { container } = render(
      <div>
        <article>{markdownBlocks(doc("const a = 1;", "js"))}</article>
        <Markdown text={"```js\nconst b = 2;\n```"} />
      </div>,
    );
    expect([...container.querySelectorAll("pre")].map((p) => p.textContent)).toEqual(["const a = 1;", "const b = 2;"]);
    expect(m.render).not.toHaveBeenCalled();
  });
  it("⚠ a reply still streaming in shows a half-written diagram as text, and draws it once it is whole", async () => {
    const { container, rerender } = render(<Markdown text={"```mermaid\nflowchart LR\n  A -->"} />);
    expect(container.querySelector("pre")?.textContent).toBe("flowchart LR\n  A -->");
    expect(m.render).not.toHaveBeenCalled();
    rerender(<Markdown text={`\`\`\`mermaid\n${FLOW}\n\`\`\``} />);
    expect(await screen.findByAltText("Diagram")).toBeTruthy();
  });
});

describe("a chat reply's fenced blocks", () => {
  it("are kept whole across blank lines, and prose either side stays prose", () => {
    expect(fencedParts("Before\n\n```sql\nselect 1\n\nfrom t\n```\nAfter")).toEqual([
      { kind: "text", text: "Before\n" },
      { kind: "fence", lang: "sql", body: "select 1\n\nfrom t", closed: true },
      { kind: "text", text: "After" },
    ]);
  });
});
