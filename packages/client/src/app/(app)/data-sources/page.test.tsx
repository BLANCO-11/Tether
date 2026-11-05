// @vitest-environment jsdom
//
// Data-sources catalogue — per-row mock safety text follows the fixture row,
// not the connection status above it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  listConnections: vi.fn(),
  deleteConnection: vi.fn(),
  testConnection: vi.fn(),
  listWorkspaces: vi.fn(),
  getDatasourceMock: vi.fn(),
  setDatasourcePaused: vi.fn(),
}));
// ⚠ `vi.mock` is a WHOLE-MODULE replacement, so every read this page makes has
// to be listed here or it arrives `undefined` and the page throws on the click
// that calls it. Add the name here in the same commit that adds the import.
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));

import * as api from "@/lib/api";
import DataSourcesPage from "./page";

const listConnections = vi.mocked(api.listConnections);
const getMock = vi.mocked(api.getDatasourceMock);

const conn = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  workspaceId: "ws-1",
  name: "hr_demo",
  connector_id: "postgres",
  status: "ready",
  last_tested_at: null,
  error_message: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(api.listWorkspaces).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("catalogue mock safety text", () => {
  it("a ready mock reads ready beside a connected row", async () => {
    listConnections.mockResolvedValue([conn() as never]);
    getMock.mockResolvedValue({ status: "ready", error: null, version: 1, fingerprint: "f" });
    render(<DataSourcesPage />);
    await waitFor(() => expect(screen.getByText("Mock data ready")).toBeTruthy());
  });

  it("a connected source with no mock says test runs refuse", async () => {
    listConnections.mockResolvedValue([conn() as never]);
    getMock.mockResolvedValue({ status: null, error: null, version: null, fingerprint: null });
    render(<DataSourcesPage />);
    await waitFor(() => expect(screen.getByText(/No mock data — test runs refuse/)).toBeTruthy());
  });

  it("a failed build reads failed, not the connection status", async () => {
    listConnections.mockResolvedValue([conn() as never]);
    getMock.mockResolvedValue({ status: "failed", error: "too many tables", version: null, fingerprint: null });
    render(<DataSourcesPage />);
    await waitFor(() => expect(screen.getByText("Mock build failed")).toBeTruthy());
  });

  it("an unreadable mock state says so — never a readiness", async () => {
    listConnections.mockResolvedValue([conn() as never]);
    getMock.mockRejectedValue(new Error("boom"));
    render(<DataSourcesPage />);
    await waitFor(() => expect(screen.getByText("Mock state unreadable")).toBeTruthy());
    expect(screen.queryByText("Mock data ready")).toBeNull();
  });
});
