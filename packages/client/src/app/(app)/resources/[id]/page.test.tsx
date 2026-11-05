// @vitest-environment jsdom
// src/app/(app)/resources/[id]/page.test.tsx — S-52 Resource detail.
// Pack truth: 29-resource-detail.png + S-52.md + flows/09 § Step 2.
// Header, notice with action inside, figures strip, Published mapping, Connection, Audit disclosure.
// Law 7: generic resource gets honest empty and plain mapping statement, never borrowed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { atRoute } from "@/lib/test-route-params";
import type { Connection, FlowSummary } from "@/lib/types";

const getConnection = vi.fn(async (_id: string): Promise<Connection | undefined> => undefined);
const getConnectionMetadata = vi.fn(async (_id: string): Promise<unknown[]> => []);
const listFlows = vi.fn(async (): Promise<FlowSummary[]> => []);

// ⚠ WHOLE-MODULE MOCK. Anything this page (or a component it mounts) imports from
// `@/lib/api` MUST appear here: an omitted export arrives as `undefined`, useAsync
// invokes it, and EVERY test in this file crashes — not just the one exercising it.
// The datasource panes below brought five of these in. Add to this list whenever you
// add a read to the page or to AssetTree/DbOperationsPanel/MockPanel.
const listOperations = vi.fn(async (_id: string): Promise<unknown[]> => []);
const getDatasourceMock = vi.fn(async (_id: string): Promise<unknown> => null);

vi.mock("@/lib/api", () => ({
  getConnection: (...a: unknown[]) => getConnection(a[0] as string),
  getConnectionMetadata: (...a: unknown[]) => getConnectionMetadata(a[0] as string),
  listFlows: () => listFlows(),
  listConnections: vi.fn(async () => []),
  // DbOperationsPanel
  listOperations: (...a: unknown[]) => listOperations(a[0] as string),
  createOperation: vi.fn(async () => ({})),
  checkOperation: vi.fn(async () => ({})),
  proposeOperation: vi.fn(async () => ({})),
  // MockPanel — what a test run reads (it replaced the retired SandboxPanel)
  getDatasourceMock: (...a: unknown[]) => getDatasourceMock(a[0] as string),
  rebuildDatasourceMock: vi.fn(async () => ({})),
}));

vi.mock("next/navigation", async () => {
  const { routeParams } = await import("@/lib/test-route-params");
  return {
  useParams: () => routeParams.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/resources/leave-management-db",
  useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { name: "tester", email: "tester@example.com" }, ready: true, signOut: vi.fn() }),
}));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));
vi.mock("@/lib/toast", () => ({
  useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); },
}));

import ResourceDetailPage from "./page";

function conn(over: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    name: "Leave management DB",
    connector_id: "postgres",
    category: "StructuredData",
    status: "pending",
    credential_source: "secret_ref",
    secret_env_name: "svc-leave-ro",
    config: { host: "leave-db.internal", port: "5432", ssl: "require", access: "Read-only" },
    ...over,
  } as Connection;
}

beforeEach(() => {
  vi.clearAllMocks();
  getConnection.mockResolvedValue(undefined);
  getConnectionMetadata.mockResolvedValue([]);
  listFlows.mockResolvedValue([]);
});

afterEach(cleanup);

describe("S-52 · Resource detail — header verbatim", () => {
  it("renders eyebrow, title, status chip and purpose verbatim", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Leave management DB")).toBeTruthy());
    expect(screen.getByText("RESOURCE · POSTGRESQL")).toBeTruthy();
    expect(screen.getByText("Pending review")).toBeTruthy();
    expect(screen.getByText("Published schema v2 has a breaking v3 change waiting for review.")).toBeTruthy();
    expect(screen.getByText("Review change")).toBeTruthy();
  });

  it("perturbation: renaming eyebrow breaks the test", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("RESOURCE · POSTGRESQL")).toBeTruthy());
    expect(screen.queryByText("RESOURCE · POSTGRES")).toBeNull();
  });
});

describe("S-52 · notice with action inside", () => {
  it("renders the change-waiting warning with its own action button inside", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("A change is waiting for review")).toBeTruthy());
    // detail contains approved_flag (appears also in mapping row) and three-state
    expect(screen.getAllByText(/approved_flag/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/three-state approval status/)).toBeTruthy();
    // action is inside the notice, not a trailing link — it renders as a button with this label
    expect(screen.getByText("View 4 affected workflows")).toBeTruthy();
  });
});

describe("S-52 · figures strip verbatim", () => {
  it("renders four figures in one row: 4 dependents, 4 mapped, 25 mock, v2 version", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Leave management DB")).toBeTruthy());
    // two 4s — one for dependents, one for mapped fields
    expect(screen.getAllByText("4").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("dependent workflows")).toBeTruthy();
    expect(screen.getByText("mapped fields")).toBeTruthy();
    expect(screen.getByText("25")).toBeTruthy();
    expect(screen.getByText("mock rows")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText("schema version")).toBeTruthy();
  });
});

describe("S-52 · Published mapping verbatim", () => {
  it("renders SOURCE · TYPE · MAPPED FIELD · AI VISIBILITY and four rows", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Published mapping")).toBeTruthy());
    expect(screen.getByText("SOURCE")).toBeTruthy();
    expect(screen.getByText("TYPE")).toBeTruthy();
    expect(screen.getByText("MAPPED FIELD")).toBeTruthy();
    expect(screen.getByText("AI VISIBILITY")).toBeTruthy();
    // rows
    expect(screen.getByText("employee_no")).toBeTruthy();
    expect(screen.getByText("employee_id")).toBeTruthy();
    expect(screen.getByText("leave_dt")).toBeTruthy();
    expect(screen.getByText("leave_date")).toBeTruthy();
    expect(screen.getByText("leave_code")).toBeTruthy();
    expect(screen.getByText("leave_type")).toBeTruthy();
    expect(screen.getAllByText("approved_flag").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("approval_status")).toBeTruthy();
    expect(screen.getAllByText("Mock").length).toBe(3);
  });

  it("perturbation: collapsing AI visibility to one flag breaks the test", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Masked")).toBeTruthy());
    // there must be both Masked and Mock — a single value would fail the second assertion
    expect(screen.getAllByText("Mock").length).toBe(3);
  });

  it("does not include manager_note (five inferred, four kept)", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Published mapping")).toBeTruthy());
    expect(screen.queryByText("manager_note")).toBeNull();
  });
});

describe("S-52 · Connection verbatim", () => {
  it("renders Owner · Host · Credential · SSL · Access with reference values", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Connection")).toBeTruthy());
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Devika Menon")).toBeTruthy();
    expect(screen.getByText("Host")).toBeTruthy();
    expect(screen.getByText("leave-db.internal:5432")).toBeTruthy();
    expect(screen.getByText("Credential")).toBeTruthy();
    expect(screen.getByText("svc-leave-ro")).toBeTruthy();
    expect(screen.getByText("SSL")).toBeTruthy();
    expect(screen.getByText("require")).toBeTruthy();
    expect(screen.getByText("Access")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
  });

  it("credential is by reference, not a value", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("svc-leave-ro")).toBeTruthy());
    // the value is the env-var name, not a secret — ensure no placeholder like "••••"
    expect(screen.queryByText("••••")).toBeNull();
  });
});

describe("S-52 · Audit & sync history", () => {
  it("renders the disclosure shut by default", async () => {
    render(atRoute("leave-management-db", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Audit & sync history")).toBeTruthy());
    const details = screen.getByText("Audit & sync history").closest("details") as HTMLDetailsElement | null;
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
  });
});

describe("S-52 · generic resource — Law 7 honest empty", () => {
  it("renders honest empty when no workflow reads or writes this resource", async () => {
    getConnection.mockResolvedValue(conn({ id: "other-1", name: "Other DB", connector_id: "postgres", status: "ready" }));
    listFlows.mockResolvedValue([]);
    const { container } = render(atRoute("other-1", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Other DB")).toBeTruthy());
    expect(screen.getByText("No workflow reads or writes this resource yet")).toBeTruthy();
    // does not borrow the worked mapping
    expect(container.textContent).not.toContain("employee_no");
    expect(container.textContent).not.toContain("approved_flag");
  });

  it("renders field mapping not modelled when generic has no mapping", async () => {
    getConnection.mockResolvedValue(conn({ id: "other-2", name: "Other DB 2", connector_id: "postgres", status: "ready" }));
    getConnectionMetadata.mockResolvedValue([]);
    render(atRoute("other-2", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Other DB 2")).toBeTruthy());
    expect(screen.getByText("Its field mapping is not modelled")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Datasource panes — Schema + DB operations + mock data.
// Feature 20260912-184048-resource-detail-schema-and-operations.
//
// ⚠ Asserted in BOTH directions. A one-sided test ("the datasource shows Schema")
// passes just as happily against a page that renders the panes on every resource
// in the product, which is the failure this gate exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

const TABLE_TREE = [
  {
    asset_type: "db_schema" as const,
    name: "public",
    id: "s1",
    children: [
      { asset_type: "table" as const, name: "invoices", id: "t1", children: [] },
      { asset_type: "table" as const, name: "vendors", id: "t2", children: [] },
    ],
  },
];

describe("datasource panes · FR-001/FR-002 — a datasource gets Schema and DB operations", () => {
  it("renders the Schema pane with the discovered tables", async () => {
    getConnection.mockResolvedValue(conn({ id: "ds-1", name: "finance_demo", connector_id: "postgres", status: "ready" }));
    getConnectionMetadata.mockResolvedValue(TABLE_TREE);
    render(atRoute("ds-1", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("finance_demo")).toBeTruthy());

    expect(screen.getByRole("heading", { name: "Schema" })).toBeTruthy();
    expect(screen.getByText("invoices")).toBeTruthy();
    expect(screen.getByText("vendors")).toBeTruthy();
  });

  it("renders the DB operations pane, reading this datasource's operations", async () => {
    getConnection.mockResolvedValue(conn({ id: "ds-2", name: "finance_demo", connector_id: "postgres", status: "ready" }));
    getConnectionMetadata.mockResolvedValue(TABLE_TREE);
    render(atRoute("ds-2", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("finance_demo")).toBeTruthy());

    // The panel is mounted AND pointed at this datasource — a panel listing some
    // other datasource's readers would satisfy a text-only assertion.
    await waitFor(() => expect(listOperations).toHaveBeenCalledWith("ds-2"));
  });

  it("states the read-only credential bound, so the pane is not read as full access", async () => {
    getConnection.mockResolvedValue(conn({ id: "ds-3", name: "finance_demo", connector_id: "postgres", status: "ready" }));
    getConnectionMetadata.mockResolvedValue(TABLE_TREE);
    const { container } = render(atRoute("ds-3", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("finance_demo")).toBeTruthy());
    expect(container.textContent).toContain("read-only credential an automation gets");
  });
});

describe("datasource panes · FR-003 — a NON-datasource gets neither", () => {
  it("renders no Schema and no DB operations for a connector resource", async () => {
    getConnection.mockResolvedValue(conn({ id: "conn-x", name: "Slack connector", connector_id: "slack", status: "ready" }));
    getConnectionMetadata.mockResolvedValue([]);
    render(atRoute("conn-x", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("Slack connector")).toBeTruthy());

    expect(screen.queryByRole("heading", { name: "Schema" })).toBeNull();
    expect(listOperations).not.toHaveBeenCalled();
    expect(getDatasourceMock).not.toHaveBeenCalled();
  });
});

describe("datasource panes · FR-005 — an empty schema says so, never a blank pane", () => {
  it("states that nothing has been discovered yet", async () => {
    getConnection.mockResolvedValue(conn({ id: "ds-empty", name: "legal_demo", connector_id: "postgres", status: "ready" }));
    getConnectionMetadata.mockResolvedValue([]);
    render(atRoute("ds-empty", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("legal_demo")).toBeTruthy());

    expect(screen.getByRole("heading", { name: "Schema" })).toBeTruthy();
    expect(screen.getByText(/No tables discovered yet/)).toBeTruthy();
  });

  it("says the schema could not be READ when the connection errored — not that there are none", async () => {
    getConnection.mockResolvedValue(conn({ id: "ds-err", name: "broken_db", connector_id: "postgres", status: "error" }));
    getConnectionMetadata.mockResolvedValue([]);
    render(atRoute("ds-err", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("broken_db")).toBeTruthy());
    expect(screen.getByText(/couldn't read this resource's schema/)).toBeTruthy();
  });
});

describe("datasource panes · FR-007 — no pointer to a surface navigation does not offer", () => {
  it("never tells a person to go to the data source schema view", async () => {
    getConnection.mockResolvedValue(conn({ id: "ds-4", name: "finance_demo", connector_id: "postgres", status: "ready" }));
    getConnectionMetadata.mockResolvedValue(TABLE_TREE);
    const { container } = render(atRoute("ds-4", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("finance_demo")).toBeTruthy());
    expect(container.textContent).not.toContain("data source schema view");
  });
});

describe("datasource panes · the table count counts TABLES, not schemas", () => {
  // ⚠ The metadata tree's top level is `db_schema`; tables are its children. Counting
  // the top level says "1 table" for a datasource with two. This was written wrong the
  // first time and caught by checking the tree shape, so it is pinned here.
  it("reports 2 tables for one schema holding two tables", async () => {
    getConnection.mockResolvedValue(conn({ id: "ds-count", name: "finance_demo", connector_id: "postgres", status: "ready" }));
    getConnectionMetadata.mockResolvedValue(TABLE_TREE);
    const { container } = render(atRoute("ds-count", <ResourceDetailPage />));
    await waitFor(() => expect(screen.getByText("finance_demo")).toBeTruthy());

    expect(screen.getByText("2 tables")).toBeTruthy();
    expect(container.textContent).toContain("2 discovered tables");
    // the schema-count answer must NOT appear
    expect(screen.queryByText("1 table")).toBeNull();
  });
});
