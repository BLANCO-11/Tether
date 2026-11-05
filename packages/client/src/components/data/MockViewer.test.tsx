// @vitest-environment jsdom
//
// MockViewer — the banner is the assertion: every row grid on this surface
// says it is mock data, and no control here can fetch production.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ getDatasourceMockRows: vi.fn() }));
import { getDatasourceMockRows } from "@/lib/api";
import { MockViewer } from "./MockViewer";

const mock = vi.mocked(getDatasourceMockRows);

afterEach(() => {
  cleanup();
  mock.mockReset();
});

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, email: `u${i + 1}@x.test` }));

describe("MockViewer", () => {
  it("says there is nothing to show when no table was introspected", () => {
    render(<MockViewer datasourceId="d1" tables={[]} />);
    expect(screen.getByText("Mock data — never production")).toBeTruthy();
    expect(screen.getByText(/No tables have been introspected/)).toBeTruthy();
    expect(mock).not.toHaveBeenCalled();
  });

  it("carries the banner on every grid it draws", async () => {
    mock.mockResolvedValue({ rows: rows(3), total: 3 });
    render(<MockViewer datasourceId="d1" tables={["users"]} />);
    await waitFor(() => expect(screen.getByText("u1@x.test")).toBeTruthy());
    expect(screen.getByText("Mock data — never production")).toBeTruthy();
    expect(screen.getByText(/never the records/)).toBeTruthy();
  });

  it("pages ten at a time", async () => {
    mock.mockResolvedValue({ rows: rows(10), total: 25 });
    render(<MockViewer datasourceId="d1" tables={["users"]} />);
    await waitFor(() => expect(screen.getByText(/page 1 of 3/)).toBeTruthy());
    expect(mock).toHaveBeenCalledWith("d1", "users", 0, 10);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("d1", "users", 1, 10));
  });

  it("switching table resets to the first page", async () => {
    mock.mockResolvedValue({ rows: rows(10), total: 25 });
    render(<MockViewer datasourceId="d1" tables={["users", "orders"]} />);
    await waitFor(() => expect(screen.getByText(/page 1 of 3/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("d1", "users", 1, 10));
    fireEvent.change(screen.getByLabelText("Table"), { target: { value: "orders" } });
    await waitFor(() => expect(mock).toHaveBeenCalledWith("d1", "orders", 0, 10));
  });

  it("an unreadable page says the check did not run — never an empty table", async () => {
    mock.mockRejectedValue(new Error("boom"));
    render(<MockViewer datasourceId="d1" tables={["users"]} />);
    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeTruthy());
    expect(screen.queryByText(/No mock rows were generated/)).toBeNull();
  });

  it("reads mock rows only — the one endpoint, with table and page", async () => {
    mock.mockResolvedValue({ rows: rows(1), total: 1 });
    render(<MockViewer datasourceId="d1" tables={["users"]} />);
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    expect(mock).toHaveBeenCalledWith("d1", "users", 0, 10);
  });
});
