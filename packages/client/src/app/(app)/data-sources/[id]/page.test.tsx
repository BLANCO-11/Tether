// @vitest-environment jsdom
//
// Connection detail — four states (loading / unreadable / gone / ready), the
// mock banner, and credential attach. The fifth assertion is the static one
// in `page.no-prod.test.ts`: no prod-data fetch exists on this route.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("@/lib/api", () => ({
  getConnection: vi.fn(),
  getConnectionMetadata: vi.fn(),
  deleteConnection: vi.fn(),
  testConnection: vi.fn(),
  refreshConnectionSchema: vi.fn(),
  listWorkspaces: vi.fn(),
  setDatasourceCredentialName: vi.fn(),
  setDatasourcePaused: vi.fn(),
  getDatasourceMock: vi.fn(),
  getDatasourceMockRows: vi.fn(),
  listSecrets: vi.fn(),
  // Child panels read through the same module — a whole-module mock must
  // list theirs too, or the page crashes in every test in this file.
  getDatasourceSandbox: vi.fn(),
  listOperations: vi.fn(),
  createOperation: vi.fn(),
  checkOperation: vi.fn(),
  proposeOperation: vi.fn(),
  setConnectionColumnTags: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ useToast: () => { const f = vi.fn(); return Object.assign(f, { success: f, error: f, warn: f }); } }));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "d1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

import * as api from "@/lib/api";
import ConnectionDetailPage from "./page";

const getConnection = vi.mocked(api.getConnection);
const getConnectionMetadata = vi.mocked(api.getConnectionMetadata);
const listWorkspaces = vi.mocked(api.listWorkspaces);
const setCredential = vi.mocked(api.setDatasourceCredentialName);
const getMock = vi.mocked(api.getDatasourceMock);
const getMockRows = vi.mocked(api.getDatasourceMockRows);
const listSecrets = vi.mocked(api.listSecrets);

const conn = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  workspaceId: "ws-1",
  name: "hr_demo",
  connector_id: "postgres",
  status: "ready",
  credential_source: "secret_ref",
  secret_env_name: "HR_DB_DSN",
  description: null,
  last_tested_at: null,
  error_message: null,
  ...over,
});

beforeEach(() => {
  getConnection.mockResolvedValue(conn() as never);
  getConnectionMetadata.mockResolvedValue([]);
  listWorkspaces.mockResolvedValue([{ id: "ws-1", name: "HR" }] as never);
  getMock.mockResolvedValue({ status: "ready", error: null, version: 1, fingerprint: "f" });
  getMockRows.mockResolvedValue({ rows: [], total: 0 });
  listSecrets.mockResolvedValue([]);
  vi.mocked(api.getDatasourceSandbox).mockResolvedValue({ hasSandbox: false } as never);
  vi.mocked(api.listOperations).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("detail gate — four states", () => {
  it("loading draws only the wait", () => {
    const promise = new Promise<never>(() => {});
    getConnection.mockReturnValue(promise);
    render(<ConnectionDetailPage />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Mock data — never production")).toBeNull();
  });

  it("an unreadable source says so and renders no content", async () => {
    getConnection.mockRejectedValue(new Error("workspace unreachable"));
    render(<ConnectionDetailPage />);
    await waitFor(() => expect(screen.getByText("Could not load this data source")).toBeTruthy());
    expect(screen.queryByText("Mock data — never production")).toBeNull();
  });

  it("a source missing here names the workspace and points back, never a bare dead end", async () => {
    getConnection.mockResolvedValue(undefined);
    render(<ConnectionDetailPage />);
    await waitFor(() => expect(screen.getByText("This data source is not in this workspace")).toBeTruthy());
    expect(screen.getByText(/looking at the HR workspace/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to data sources" }).getAttribute("href")).toBe("/data-sources");
  });

  it("ready renders schema, mock viewer and access — one mock card", async () => {
    render(<ConnectionDetailPage />);
    // The banner is static shell now — wait on the async status beneath it.
    await waitFor(() => expect(screen.getByText(/Mock data is ready/)).toBeTruthy());
    expect(screen.getByText("Schema")).toBeTruthy();
    expect(screen.getByText("Access & guardrails")).toBeTruthy();
    // One card, not two: the old standalone "Mock data" status heading merged
    // under the shared banner — the status sentence still renders beneath it.
    expect(screen.queryByText(/^Mock data$/)).toBeNull();
    expect(screen.getByText(/Mock data is ready/)).toBeTruthy();
  });
});

describe("credential attach — references only", () => {
  it("attaching a name writes the reference and never a value", async () => {
    listSecrets.mockResolvedValue([
      { id: "s1", workspaceId: "ws-1", name: "HR_DB_DSN" },
      { id: "s2", workspaceId: "ws-1", name: "PAYROLL_RO" },
    ] as never);
    getConnection.mockResolvedValue(conn({ secret_env_name: null }) as never);
    setCredential.mockResolvedValue(conn({ secret_env_name: "PAYROLL_RO" }) as never);
    render(<ConnectionDetailPage />);
    await waitFor(() => expect(screen.getByLabelText("Credential name")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Credential name"), { target: { value: "PAYROLL_RO" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(setCredential).toHaveBeenCalledWith("d1", "PAYROLL_RO"));
  });
});

describe("declaring what a column holds (P5-I11)", () => {
  const tree = () => [{ asset_id: "s", asset_type: "db_schema", name: "public", children: [{
    asset_id: "t", asset_type: "table", name: "employee", attributes: { schema: "main" }, children: [
      { asset_id: "c1", asset_type: "column", name: "email", attributes: { type: "text" } },
      { asset_id: "c2", asset_type: "column", name: "age", attributes: { type: "integer" } },
      { asset_id: "c3", asset_type: "column", name: "work_mail", attributes: { type: "text", tag: "email" } },
    ] }] }];
  const open = async () => {
    render(<ConnectionDetailPage />);
    const expand = await screen.findByRole("button", { name: "Expand public" }).catch(() => null);
    if (expand) fireEvent.click(expand);
    fireEvent.click(await screen.findByRole("button", { name: "View schema of employee" }));
  };
  it("a text column can be declared an email address — keyed [schema.]table.column — and the save is the whole set", async () => {
    getConnectionMetadata.mockResolvedValue(tree() as never);
    vi.mocked(api.setConnectionColumnTags).mockResolvedValue(undefined);
    await open();
    fireEvent.click(await screen.findByRole("checkbox", { name: "email holds an email address" }));
    await waitFor(() => expect(api.setConnectionColumnTags).toHaveBeenCalledWith("d1", { "main.employee.email": "email" }));
  });
  it("CONTROL: a non-text column offers nothing, and a tag the schema gave is shown but not editable here", async () => {
    getConnectionMetadata.mockResolvedValue(tree() as never);
    await open();
    await screen.findByRole("checkbox", { name: "email holds an email address" });
    expect(screen.queryByRole("checkbox", { name: "age holds an email address" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "work_mail holds an email address" })).toBeNull();
  });
  it("one declared here is checked and can be withdrawn", async () => {
    getConnection.mockResolvedValue(conn({ column_tags: { "main.employee.email": "email" } }) as never);
    getConnectionMetadata.mockResolvedValue(tree() as never);
    vi.mocked(api.setConnectionColumnTags).mockResolvedValue(undefined);
    await open();
    const box = (await screen.findByRole("checkbox", { name: "email holds an email address" })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(api.setConnectionColumnTags).toHaveBeenCalledWith("d1", {}));
  });
});
