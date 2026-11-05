// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatFilePreview, previewKind } from "./ChatFilePreview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("previewKind", () => {
  it("shows images and PDFs as themselves, asks the server for sheets and documents, and has no preview otherwise", () => {
    expect(previewKind("a.PNG")).toBe("image");
    expect(previewKind("r.pdf")).toBe("pdf");
    expect(previewKind("notes.md")).toBe("markdown");
    expect(previewKind("mock.html")).toBe("html");
    expect(previewKind("logo.svg")).toBe("svg");
    expect(previewKind("App.tsx")).toBe("code");
    expect(previewKind("data.json")).toBe("code");
    expect(previewKind("run.log")).toBe("plain");
    expect(previewKind("rates.xlsx")).toBe("server");
    expect(previewKind("rates.csv")).toBe("server");
    expect(previewKind("letter.docx")).toBe("server");
    expect(previewKind("deck.pptx")).toBe("none");
  });
});

describe("ChatFilePreview", () => {
  const serve = (body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));

  it("⚠ runs a web page only in a sandboxed frame with no same-origin and no network", async () => {
    serve("<h1>Desk</h1><script>fetch('/api/x')</script>");
    render(<ChatFilePreview name="mock.html" href="/f/mock.html" />);
    const frame = (await screen.findByTestId("html-preview")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const doc = frame.getAttribute("srcdoc")!;
    expect(doc.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'')).toBe(true);
    expect(doc).toContain("<h1>Desk</h1>");
  });

  it("shows a page's source as code when asked", async () => {
    serve("<h1>Desk</h1>");
    render(<ChatFilePreview name="mock.html" href="/f/mock.html" view="source" />);
    expect((await screen.findByTestId("code-view")).textContent).toContain("<h1>Desk</h1>");
    expect(screen.queryByTestId("html-preview")).toBeNull();
  });

  it("lays Markdown out as a document, and its HTML stays text", async () => {
    serve("# Concept\n\nA **fast** desktop.\n\n- dock\n- search\n\n<img src=x onerror=alert(1)>");
    const { container } = render(<ChatFilePreview name="README.md" href="/f/README.md" />);
    expect((await screen.findByRole("heading", { name: "Concept" })).getAttribute("aria-level")).toBe("1");
    expect(screen.getByText("fast").tagName).toBe("STRONG");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws an SVG as a picture (no script runs in an image) and code with line numbers", async () => {
    serve("<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>");
    const { container, unmount } = render(<ChatFilePreview name="logo.svg" href="/f/logo.svg" />);
    await screen.findByAltText("logo.svg");
    expect(container.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    unmount();
    serve("const a = 1;\nexport default a;");
    render(<ChatFilePreview name="App.tsx" href="/f/App.tsx" />);
    const code = await screen.findByTestId("code-view");
    expect(code.querySelectorAll("tr")).toHaveLength(2);
    expect(screen.getByText("const").className).toMatch(/text-accent/);
  });

  it("draws a sheet as a table and says when only part of it is shown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ preview: { kind: "table", sheets: [{ name: "Rates", rows: [["name", "rate"], ["Asha", "10"]], totalRows: 500, totalCols: 2 }] } })),
      ),
    );
    render(<ChatFilePreview name="rates.xlsx" href="/f/rates.xlsx" />);
    expect(await screen.findByText("Asha")).toBeTruthy();
    expect(screen.getByText(/Showing 2 of 500 rows/)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/f/rates.xlsx?preview=1");
  });

  it("shows an image inline, and offers the download for a file it cannot show", () => {
    const { container, unmount } = render(<ChatFilePreview name="a.png" href="/f/a.png" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/f/a.png?inline=1");
    unmount();
    render(<ChatFilePreview name="deck.pptx" href="/f/deck.pptx" />);
    expect(screen.getByText(/no preview/)).toBeTruthy();
    expect(screen.getByText("Download deck.pptx")).toBeTruthy();
  });

  it("while a sheet is being made, says so with a spinner and a table-shaped placeholder", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (answer = r))));
    render(<ChatFilePreview name="rates.xlsx" href="/f/rates.xlsx" />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading the preview/);
    expect(screen.getByTestId("preview-loading").querySelectorAll(".skel-bar").length).toBe(45);
    answer(new Response(JSON.stringify({ preview: { kind: "table", sheets: [{ name: "S", rows: [["a"]], totalRows: 1, totalCols: 1 }] } })));
    expect(await screen.findByText("a")).toBeTruthy();
    expect(screen.queryByTestId("preview-loading")).toBeNull();
  });

  it("a document loads as lines of text, not a table", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<ChatFilePreview name="letter.docx" href="/f/letter.docx" />);
    expect(screen.getByTestId("preview-loading").querySelectorAll(".skel-bar").length).toBe(7);
  });

  it("an image shows the loading state until the browser has it", () => {
    const { container } = render(<ChatFilePreview name="a.png" href="/f/a.png" />);
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    fireEvent.load(container.querySelector("img")!);
    expect(screen.queryByTestId("preview-loading")).toBeNull();
  });
});
