// @vitest-environment jsdom
//
// Links in Markdown are opt-in (a connector's setup instructions), and only `https:` ever becomes one.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("Markdown links", () => {
  it("renders an https link, opening a new tab, only when asked", () => {
    render(<Markdown text="Open the [AWS IAM Console](https://console.aws.amazon.com/iam/) and **Users**." links />);
    const a = screen.getByRole("link", { name: "AWS IAM Console" });
    expect(a.getAttribute("href")).toBe("https://console.aws.amazon.com/iam/");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toMatch(/noopener/);
    expect(screen.getByText("Users").tagName).toBe("STRONG");
  });
  it("⚠ never links anything but https, and links nothing without the option (Pi's chat)", () => {
    render(<Markdown text="[click](javascript:alert(1)) and [plain](http://x.example)" links />);
    expect(screen.queryByRole("link")).toBeNull();
    cleanup();
    render(<Markdown text="[docs](https://example.com)" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
