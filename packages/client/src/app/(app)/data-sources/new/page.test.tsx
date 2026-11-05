// @vitest-environment jsdom
//
// The SQLite branch of "Connect a data source": a file, not a sign-in form.
//
// What must hold: picking SQLite asks for the FILE and nothing a DSN is built
// from, offers read-only and nothing wider, drops the schema list (a SQLite
// database has one), refuses an oversized file before uploading it, and sends
// the file — not a connection string — to `createConnection`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CONNECTORS } from "@/lib/connectors";

vi.mock("@/lib/api", () => ({
  listManifests: vi.fn(async () => CONNECTORS),
  createConnection: vi.fn(),
  getConnection: vi.fn(),
  testConnection: vi.fn(),
  refreshConnectionSchema: vi.fn(),
  replaceSqliteFile: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/data/MockPanel", () => ({ MockPanel: () => null }));

import * as api from "@/lib/api";
import NewDataSourcePage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function pickSqlite() {
  render(<NewDataSourcePage />);
  await waitFor(() => expect(screen.getByText("SQLite")).toBeTruthy());
  fireEvent.click(screen.getByText("SQLite"));
}

function chooseFile(bytes: number, name = "hr.db") {
  const file = new File([new Uint8Array(1)], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: bytes });
  fireEvent.change(screen.getByLabelText("Database file"), { target: { files: [file] } });
  return file;
}

describe("Connect a data source — SQLite", () => {
  it("asks for the file, not a host / user / password", async () => {
    await pickSqlite();
    expect(screen.getByLabelText("Database file")).toBeTruthy();
    expect(screen.queryByText("Host")).toBeNull();
    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.queryByLabelText("Schemas to read")).toBeNull();
  });

  it("offers read-only and nothing wider", async () => {
    await pickSqlite();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(1);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
  });

  it("refuses a file over 50 MB before uploading it", async () => {
    await pickSqlite();
    fireEvent.change(screen.getByPlaceholderText("e.g. hr_database"), { target: { value: "hr_file" } });
    chooseFile(50 * 1024 * 1024 + 1);
    expect(screen.getByText(/at most 50 MB/)).toBeTruthy();
    expect((screen.getByText("Test connection").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the file, and no connection string, to createConnection", async () => {
    vi.mocked(api.createConnection).mockResolvedValue({ id: "ds1", status: "ready" } as never);
    await pickSqlite();
    fireEvent.change(screen.getByPlaceholderText("e.g. hr_database"), { target: { value: "hr_file" } });
    const file = chooseFile(2048);
    const test = screen.getByText("Test connection").closest("button") as HTMLButtonElement;
    expect(test.disabled).toBe(false);
    fireEvent.click(test);
    await waitFor(() => expect(api.createConnection).toHaveBeenCalled());
    const arg = vi.mocked(api.createConnection).mock.calls[0][0];
    expect(arg).toMatchObject({ name: "hr_file", connector_id: "sqlite", accessPolicy: "read", file });
    expect(arg).not.toHaveProperty("schema_allowlist");
  });
});
