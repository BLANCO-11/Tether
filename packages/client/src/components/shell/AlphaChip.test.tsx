// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AlphaChip } from "./AlphaChip";

afterEach(cleanup);

describe("the Beta chip carries the release version", () => {
  it("shows the version the build was made from", () => {
    expect(render(<AlphaChip version="2.6.10" />).container.textContent).toBe("Beta2.6.10");
  });
  it("CONTROL: no version, or the template's 0.x placeholder, shows the word alone", () => {
    expect(render(<AlphaChip version={undefined} />).container.textContent).toBe("Beta");
    cleanup();
    expect(render(<AlphaChip version="0.1.0" />).container.textContent).toBe("Beta");
  });
});
