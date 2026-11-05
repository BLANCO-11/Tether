"use client";

/**
 * A ```mermaid block drawn as a picture (2026-10-29) — in a Markdown file's preview and in a chat reply.
 *
 * ⚠ The diagram is SHOWN AS AN IMAGE: mermaid renders it to SVG text, and the page gets an `<img>` of that SVG as a
 * `data:` URL, exactly as an .svg file is shown (FileRenderers `SvgPreview`). An image cannot run script, reach the
 * page or load anything, so a diagram's text — written by a model, or by whoever wrote the file — never becomes markup
 * here, which is the rule both Markdown renderers keep. `securityLevel: "strict"` and no HTML labels on top: labels are
 * SVG text, so nothing inside the image depends on HTML either.
 *
 * Mermaid is loaded only when a diagram is on screen, and renders one diagram at a time (it is not safe to run two at
 * once). A block that does not parse shows its source and why, never an empty box.
 */
import { useEffect, useId, useState } from "react";
import { currentTheme } from "@/lib/theme";

/** Whether a fenced block's language is a diagram this draws. */
export const isDiagram = (lang: string | undefined | null): boolean => (lang ?? "").trim().toLowerCase() === "mermaid";

type Drawn = { svg: string } | { error: string };

let queue: Promise<unknown> = Promise.resolve();

/** Draw one diagram, after any already drawing. */
function draw(id: string, code: string): Promise<Drawn> {
  const run = queue.then(async (): Promise<Drawn> => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      theme: currentTheme() === "light" ? "default" : "dark",
    });
    try {
      const { svg } = await mermaid.render(id, code);
      return { svg };
    } catch (e) {
      // Mermaid leaves its scratch element behind when a diagram fails.
      if (typeof document !== "undefined") document.getElementById(`d${id}`)?.remove();
      return { error: firstLine((e as Error)?.message ?? String(e)) };
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "it could not be read";

export function MermaidDiagram({ code }: { code: string }) {
  const id = `mmd-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn | null>(null);

  useEffect(() => {
    let live = true;
    setDrawn(null);
    draw(id, code).then(
      (d) => live && setDrawn(d),
      (e) => live && setDrawn({ error: firstLine((e as Error)?.message ?? String(e)) }),
    );
    return () => {
      live = false;
    };
  }, [id, code]);

  if (!drawn) {
    return (
      <div className="my-3 rounded-md border border-line px-3 py-2 text-[12.5px] text-muted" data-testid="diagram-drawing">
        Drawing the diagram…
      </div>
    );
  }
  if ("error" in drawn) {
    return (
      <div className="my-3 space-y-1" data-testid="diagram-error">
        <p className="text-[12.5px] text-warn">This diagram could not be drawn: {drawn.error}</p>
        <pre className="overflow-auto rounded-md border border-line bg-sunken/50 p-3 font-mono text-[12.5px] leading-[1.55]">{code}</pre>
      </div>
    );
  }
  return (
    <figure className="my-3" data-testid="diagram">
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg)}`}
        alt="Diagram"
        className="max-w-full rounded-md border border-line bg-surface p-2"
      />
      <details className="mt-1 text-[12px] text-muted">
        <summary className="cursor-pointer select-none">Diagram source</summary>
        <pre className="mt-1 overflow-auto rounded-md border border-line bg-sunken/50 p-3 font-mono text-[12.5px] leading-[1.55]">{code}</pre>
      </details>
    </figure>
  );
}
