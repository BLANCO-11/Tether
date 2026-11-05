// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("Pi's Markdown renders as elements, never as HTML", () => {
  it("bold, code, lists and paragraphs", () => {
    const { container } = render(<Markdown text={"Built **Monthly Hours**. Enter `YYYY-MM`.\n\n- one\n- two"} />);
    expect(container.querySelector("strong")?.textContent).toBe("Monthly Hours");
    expect(container.querySelector("code")?.textContent).toBe("YYYY-MM");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).not.toContain("**");
  });

  it("markup in the text stays text — a model cannot inject an element", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> **ok**'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });
});
