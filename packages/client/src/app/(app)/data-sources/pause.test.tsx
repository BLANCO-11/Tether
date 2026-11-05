// @vitest-environment jsdom
//
// **Pausing a data source — and saying so on screen.**
//
// The server half is invisible from here: a paused source still connects, still
// has a schema, and its existing automations still run. So the only thing this
// screen can get wrong is failing to say which state it is in, or offering the
// wrong action — and both are what these assert, each with its control.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";


vi.mock("@/lib/api", () => ({
  listConnections: vi.fn(),
  deleteConnection: vi.fn(),
  testConnection: vi.fn(),
  setDatasourcePaused: vi.fn(),
  listWorkspaces: vi.fn(),
  getDatasourceMock: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));

import * as api from "@/lib/api";
import DataSourcesPage from "./page";

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
  vi.mocked(api.getDatasourceMock).mockResolvedValue({
    status: "ready",
    error: null,
    version: 1,
    fingerprint: "f",
  } as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the row says which state it is in", () => {
  it("⚠ a paused row SAYS so — it is otherwise indistinguishable from a running one", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn({ paused_from_model: true }) as never]);
    render(<DataSourcesPage />);
    expect(await screen.findByText(/hidden from the designer/i)).toBeTruthy();
  });

  it("CONTROL: an unpaused row says nothing of the kind", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn() as never]);
    render(<DataSourcesPage />);
    await screen.findByText("hr_demo");
    expect(screen.queryByText(/hidden from the designer/i)).toBeNull();
  });

  it("⚠ the sentence says running automations are unaffected — the whole difference from Remove", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn({ paused_from_model: true }) as never]);
    render(<DataSourcesPage />);
    expect(await screen.findByText(/running automations unaffected/i)).toBeTruthy();
  });
});

describe("the button offers the action that is available", () => {
  it("offers Pause on a running source, and pressing it pauses", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn() as never]);
    vi.mocked(api.setDatasourcePaused).mockResolvedValue(conn({ paused_from_model: true }) as never);
    render(<DataSourcesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.setDatasourcePaused).toHaveBeenCalledWith("d1", true));
  });

  it("⚠ offers Resume on a paused one, and pressing it RESUMES — not pauses again", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn({ paused_from_model: true }) as never]);
    vi.mocked(api.setDatasourcePaused).mockResolvedValue(conn() as never);
    render(<DataSourcesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.setDatasourcePaused).toHaveBeenCalledWith("d1", false));
  });

  it("⚠ pausing asks for NO confirmation — Remove keeps its dialog, and that asymmetry is the point", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn() as never]);
    vi.mocked(api.setDatasourcePaused).mockResolvedValue(conn({ paused_from_model: true }) as never);
    render(<DataSourcesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.setDatasourcePaused).toHaveBeenCalled());
    expect(api.deleteConnection).not.toHaveBeenCalled();
  });

  it("CONTROL: Remove does NOT call through without its confirmation", async () => {
    vi.mocked(api.listConnections).mockResolvedValue([conn() as never]);
    render(<DataSourcesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(api.deleteConnection).not.toHaveBeenCalled();
  });
});
