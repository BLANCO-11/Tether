// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BannerText } from "./PiBuilderWorkbench";

describe("the builder's banner", () => {
  afterEach(cleanup);
  const raw = 'VERIFY FAIL\n  - read "muster_rows": this join cannot use an index';
  it("says one sentence and keeps the raw result behind Details", () => {
    render(<BannerText state={{ text: "The workflow did not pass its checks, so the test did not start.", detail: raw }} />);
    expect(screen.getByText(/did not pass its checks/)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();
    expect(screen.getByText(/VERIFY FAIL/).closest("details")).toBeTruthy();
  });
  it("has no Details when there is nothing more to show", () => {
    render(<BannerText state={{ text: "Could not save." }} />);
    expect(screen.queryByText("Details")).toBeNull();
  });
});
