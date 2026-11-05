// @vitest-environment jsdom
//
// src/app/(app)/resources/page.test.tsx — S-48 Resource list.
//
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Connection, FlowSummary } from "@/lib/types";

const listConnections = vi.fn(async (): Promise<Connection[]> => []);
const listFlows = vi.fn(async (): Promise<FlowSummary[]> => []);
const push = vi.fn();
const replace = vi.fn();
let searchParams = new URLSearchParams();

const deleteConnection = vi.fn(async (_id: string) => {});
const setDatasourcePaused = vi.fn(async (_id: string, _paused: boolean) => ({}) as never);

// ⚠ `vi.mock` is a WHOLE-MODULE replacement, so every read this page makes must
// be listed or it arrives `undefined` and the row menu throws on click. Add the
// name here in the same commit that adds the import.
vi.mock("@/lib/api", () => ({
  listConnections: () => listConnections(),
  listFlows: () => listFlows(),
  deleteConnection: (id: string) => deleteConnection(id),
  setDatasourcePaused: (id: string, paused: boolean) => setDatasourcePaused(id, paused),
}));

// Resources → Files (2026-10-12): the page reads the workspace's files too.
const listWorkspaceFiles = vi.fn(async (): Promise<unknown[]> => []);
const deleteWorkspaceFile = vi.fn(async (_id: string) => {});
vi.mock("@/lib/workspace-files", () => ({
  listWorkspaceFiles: () => listWorkspaceFiles(),
  deleteWorkspaceFile: (id: string) => deleteWorkspaceFile(id),
  uploadWorkspaceFile: vi.fn(),
  workspaceFileUrl: vi.fn(async (id: string) => `/api/foundry/workspaces/ws-1/files/${id}/content`),
  fileRefusal: () => null,
  FILE_ACCEPT: ".pdf,.xlsx",
}));
vi.mock("@/lib/foundry-client", () => ({ resolveWorkspaceId: async () => "ws-1" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, prefetch: vi.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => "/resources",
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { name: "tester", email: "tester@example.com" }, ready: true, signOut: vi.fn() }),
}));
vi.mock("@/lib/workspace", () => ({
  useWorkspace: () => ({ workspaceId: "ws-1", switchWorkspace: vi.fn() }),
}));
vi.mock("@/lib/toast", () => ({
  useToast: () => { const f = () => {}; return Object.assign(f, { success: f, error: f, warn: f }); },
}));

import ResourcesPage from "./page";

function conn(over: Partial<Connection> = {}): Connection {
  return {
    id: "ds-1",
    name: "Vendor master (REST)",
    connector_id: "rest",
    category: "StructuredData",
    status: "ready",
    credential_source: "direct",
    ...over,
  } as Connection;
}

type FlowWithResources = FlowSummary & { resources: string[] };
function flow(over: Record<string, unknown> = {}): FlowWithResources {
  return {
    id: "flow-1",
    name: "Headcount reconciliation",
    description: "",
    status: "approved",
    kestraFlowId: "flow-1",
    draftRevision: 1,
    armedRevision: 1,
    draftAhead: false,
    resources: [],
    ...over,
  } as unknown as FlowWithResources;
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  listConnections.mockResolvedValue([]);
  listFlows.mockResolvedValue([]);
});

afterEach(cleanup);

describe("S-48 · Resource list — pack copy verbatim", () => {
  it("renders title, purpose and Add resource action", async () => {
    render(<ResourcesPage />);
    expect(screen.getByText("Resources")).toBeTruthy();
    expect(screen.getByText("Datasources, files and tools that workflows depend on.")).toBeTruthy();
    expect(screen.getByText("Add resource")).toBeTruthy();
  });

  it("renders four category tabs without counts", async () => {
    render(<ResourcesPage />);
    expect(screen.getByRole("tab", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Datasources" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Tools" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Connectors" })).toBeNull();
    const allTab = screen.getByRole("tab", { name: "All" });
    expect(allTab.textContent).toBe("All");
  });

  it("search input has placeholder Search resources", async () => {
    render(<ResourcesPage />);
    expect(screen.getByPlaceholderText("Search resources")).toBeTruthy();
    expect(screen.getByLabelText("Search resources")).toBeTruthy();
  });

  it("table headers are NAME · TYPE · STATUS · OWNER · DEPENDENTS · HEALTH", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("Vendor master (REST)")).toBeTruthy());
    expect(screen.getByText("NAME")).toBeTruthy();
    expect(screen.getByText("TYPE")).toBeTruthy();
    expect(screen.getByText("STATUS")).toBeTruthy();
    expect(screen.getByText("OWNER")).toBeTruthy();
    expect(screen.getByText("DEPENDENTS")).toBeTruthy();
    expect(screen.getByText("HEALTH")).toBeTruthy();
  });

  it("empty workspace copy verbatim", async () => {
    render(<ResourcesPage />);
    await waitFor(() =>
      expect(screen.getByText("There are no resources in this workspace yet. Connect one before building a workflow that reads or writes data.")).toBeTruthy(),
    );
  });

  it("filtered-empty is a different screen with Clear filters", async () => {
    listConnections.mockResolvedValue([conn({ id: "a", name: "Alpha", connector_id: "postgres", status: "ready" })]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search resources"), { target: { value: "zzzz-no-match" } });
    await waitFor(() => expect(screen.getByText("No resources match your filters.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    expect(screen.queryByText("There are no resources in this workspace yet. Connect one before building a workflow that reads or writes data.")).toBeNull();
  });

  it("clear filters resets search and URL", async () => {
    listConnections.mockResolvedValue([conn({ id: "a", name: "Alpha", connector_id: "postgres" })]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search resources"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("No resources match your filters.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    expect(replace).toHaveBeenCalledWith("/resources");
  });
});

describe("S-48 · filters via URL (?type=)", () => {
  it("?type=datasource shows only datasources", async () => {
    listConnections.mockResolvedValue([
      conn({ id: "pg", name: "PG db", connector_id: "postgres", status: "ready" }),
      conn({ id: "rest1", name: "Vendor master (REST)", connector_id: "rest", status: "ready" }),
    ]);
    searchParams = new URLSearchParams("type=datasource");
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("PG db")).toBeTruthy());
    expect(screen.queryByText("Vendor master (REST)")).toBeNull();
  });

  it("the retired ?type=connector falls back to All, where connector rows still show", async () => {
    listConnections.mockResolvedValue([
      conn({ id: "pg", name: "PG db", connector_id: "postgres" }),
      conn({ id: "rest1", name: "Vendor master (REST)", connector_id: "rest" }),
    ]);
    searchParams = new URLSearchParams("type=connector");
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("Vendor master (REST)")).toBeTruthy());
    expect(screen.getByText("PG db")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
  });

  it("?type=files with no files invites an upload, not \"nothing matched\", and lists no data source", async () => {
    listConnections.mockResolvedValue([conn({ id: "pg", name: "PG db", connector_id: "postgres" })]);
    searchParams = new URLSearchParams("type=files");
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText(/No files yet\. Upload what a workflow should read when it runs/)).toBeTruthy());
    expect(screen.queryByText("PG db")).toBeNull();
    expect(screen.queryByText("No resources match your filters.")).toBeNull();
    expect(screen.queryByText(/SQLite/)).toBeNull();
  });

  it("?type=files lists the workspace's files with their kind, size and the workflows that read them", async () => {
    listWorkspaceFiles.mockResolvedValueOnce([
      { id: "f1", name: "Rate card.xlsx", contentType: "x", sizeBytes: 2 * 1024 * 1024, uploadedBy: "a@b.example", createdAt: "2026-10-12", usedBy: [{ id: "w", name: "Monthly report" }] },
    ]);
    searchParams = new URLSearchParams("type=files");
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("Rate card.xlsx")).toBeTruthy());
    expect(screen.getByText("File · Excel")).toBeTruthy();
    expect(screen.getByText("2.0 MB")).toBeTruthy();
    expect(screen.getByText("1 workflows").getAttribute("title")).toBe("Monthly report");
  });

  it("?type=tool with no tool rows shows filtered-empty", async () => {
    listConnections.mockResolvedValue([conn({ id: "pg", name: "PG db", connector_id: "postgres" })]);
    searchParams = new URLSearchParams("type=tool");
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("No resources match your filters.")).toBeTruthy());
  });

  it("unrecognised ?type falls back to All", async () => {
    listConnections.mockResolvedValue([
      conn({ id: "pg", name: "PG db", connector_id: "postgres" }),
      conn({ id: "rest1", name: "Vendor master (REST)", connector_id: "rest" }),
    ]);
    searchParams = new URLSearchParams("type=banana");
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("PG db")).toBeTruthy());
    expect(screen.getByText("Vendor master (REST)")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a tab writes via replace (not push) and deletes param for All", async () => {
    listConnections.mockResolvedValue([conn({ id: "rest1", name: "Vendor master (REST)", connector_id: "rest" })]);
    searchParams = new URLSearchParams("type=datasource");
    render(<ResourcesPage />);
    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(replace).toHaveBeenCalledWith("/resources");
    expect(push).not.toHaveBeenCalled();
  });

  it("clicking Files writes ?type=files", async () => {
    render(<ResourcesPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(replace).toHaveBeenCalledWith("/resources?type=files");
  });
});

describe("the Add action follows the tab", () => {
  const cases: Array<[string, string, string | null]> = [
    ["", "Add resource", "/data-sources/new"],
    ["type=datasource", "Add data source", "/data-sources/new"],
    ["type=tool", "Add tool", "/tools?new=1"],
  ];
  for (const [qs, label, href] of cases) {
    it(`${qs || "All"} → ${label}`, () => {
      searchParams = new URLSearchParams(qs);
      render(<ResourcesPage />);
      const link = screen.getByText(label).closest("a");
      expect(link?.getAttribute("href")).toBe(href);
    });
  }

  it("Files → Upload file, enabled, and it opens the file picker", () => {
    searchParams = new URLSearchParams("type=files");
    render(<ResourcesPage />);
    const btn = screen.getAllByText("Upload file")[0]!.closest("button")!;
    expect(btn.disabled).toBe(false);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(btn);
    expect(click).toHaveBeenCalled();
  });
});

describe("S-48 · columns and row rules", () => {
  it("DEPENDENTS renders as N workflows (verbatim, even 1)", async () => {
    const c = conn({ id: "ds-1", name: "HRIS employee master", connector_id: "rest" });
    listConnections.mockResolvedValue([c]);
    listFlows.mockResolvedValue([flow({ id: "f1", resources: ["HRIS employee master"] }), flow({ id: "f2", resources: ["other"] })]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("1 workflows")).toBeTruthy());
  });

  it("DEPENDENTS is derived from workflow graph, not stored", async () => {
    const c = conn({ id: "ds-1", name: "Payroll extract", connector_id: "sftp", status: "untested" });
    listConnections.mockResolvedValue([c]);
    listFlows.mockResolvedValue([flow({ id: "f-payroll", resources: ["Payroll extract"] })]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("1 workflows")).toBeTruthy());
    cleanup();
    listConnections.mockResolvedValue([c]);
    listFlows.mockResolvedValue([]);
    searchParams = new URLSearchParams();
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("0 workflows")).toBeTruthy());
  });

  it("Payroll extract (Draft) carries Not visible to AI badge", async () => {
    listConnections.mockResolvedValue([conn({ id: "payroll", name: "Payroll extract", connector_id: "sftp", status: "untested" })]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("Payroll extract")).toBeTruthy());
    expect(screen.getByText("Not visible to AI")).toBeTruthy();
  });

  it("non-Draft does not carry badge", async () => {
    listConnections.mockResolvedValue([conn({ id: "pg", name: "PG db", connector_id: "postgres", status: "ready" })]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("PG db")).toBeTruthy());
    expect(screen.queryByText("Not visible to AI")).toBeNull();
  });

  it("STATUS Published vs Draft per connection status", async () => {
    listConnections.mockResolvedValue([
      conn({ id: "a", name: "A", connector_id: "postgres", status: "ready" }),
      conn({ id: "b", name: "B", connector_id: "postgres", status: "untested" }),
    ]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("A")).toBeTruthy());
    expect(screen.getByText("Published")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
  });

  it("HEALTH renders sentence when pending", async () => {
    listConnections.mockResolvedValue([conn({ id: "a", name: "A", connector_id: "postgres", status: "pending" })]);
    render(<ResourcesPage />);
    await waitFor(() => expect(screen.getByText("A change is waiting for review")).toBeTruthy());
  });

  it("measure is wide — Page owns it", async () => {
    render(<ResourcesPage />);
    const page = document.querySelector(".max-w-wide");
    expect(page).toBeTruthy();
  });
});

/**
 * **THE ROW MENU — the `⋯` that used to do nothing.**
 *
 * It rendered `aria-label="More actions for <name>"` with no `onClick`: an
 * affordance announcing actions that did not exist, while `/data-sources` had
 * both of them. Reported as *"I see no buttons for pause and delete"*.
 *
 * ⚠ Every assertion carries its control, because the failure this replaces was
 * a control that could not fail.
 */
describe("the row menu offers Pause and Delete, and they act", () => {
  const openMenu = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /more actions/i }));
  };

  it("CONTROL: the kebab is still labelled for the row it belongs to", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    expect(await screen.findByRole("button", { name: /more actions/i })).toBeTruthy();
  });

  it("⚠ opening it reveals BOTH actions — it used to reveal nothing at all", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("Pause calls through with the datasource id", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(setDatasourcePaused).toHaveBeenCalledWith("ds-1", true));
  });

  it("⚠ a paused row offers Resume, and pressing it RESUMES rather than pausing again", async () => {
    listConnections.mockResolvedValue([conn({ paused_from_model: true } as Partial<Connection>)]);
    render(<ResourcesPage />);
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
    await waitFor(() => expect(setDatasourcePaused).toHaveBeenCalledWith("ds-1", false));
  });

  it("⚠ Delete does NOT act on the pick — it asks first", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(deleteConnection).not.toHaveBeenCalled();
    expect(await screen.findByText(/Remove Vendor master \(REST\)\?/)).toBeTruthy();
  });

  it("CONTROL: confirming the dialog is what deletes", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleteConnection).toHaveBeenCalledWith("ds-1"));
  });

  it("⚠ the dialog says the database itself is untouched — the difference from Pause", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText(/The database itself is not touched/)).toBeTruthy();
  });
});

describe("a paused resource says so on the row", () => {
  it("⚠ SAID, because every other column is identical to a running resource", async () => {
    listConnections.mockResolvedValue([conn({ paused_from_model: true } as Partial<Connection>)]);
    render(<ResourcesPage />);
    expect(await screen.findByText(/Paused — hidden from the designer/)).toBeTruthy();
  });

  it("CONTROL: an unpaused resource says nothing of the kind", async () => {
    listConnections.mockResolvedValue([conn()]);
    render(<ResourcesPage />);
    await screen.findByText("Vendor master (REST)");
    expect(screen.queryByText(/Paused — hidden from the designer/)).toBeNull();
  });
});

describe("Resources → Files — select several and delete", () => {
  const file = (id: string, name: string, usedBy: Array<{ id: string; name: string }> = []) => ({
    id, name, contentType: "x", sizeBytes: 1024, uploadedBy: "a@b.example", createdAt: "2026-10-12", usedBy,
  });

  it("checkboxes are hidden until Select; Delete is disabled with nothing ticked; Clear all and Esc leave", async () => {
    listWorkspaceFiles.mockResolvedValue([file("f1", "Rate card.xlsx"), file("f2", "Policy.pdf")]);
    searchParams = new URLSearchParams("type=files");
    render(<ResourcesPage />);
    await screen.findByText("Rate card.xlsx");
    expect(screen.queryByLabelText("Select Rate card.xlsx")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Select Rate card.xlsx"));
    expect((screen.getByRole("button", { name: "Delete (1)" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByLabelText("Select Rate card.xlsx")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect((screen.getByLabelText("Select Rate card.xlsx") as HTMLInputElement).checked).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Select Rate card.xlsx")).toBeNull();
    listWorkspaceFiles.mockReset();
    listWorkspaceFiles.mockImplementation(async () => []);
  });

  it("Select all picks the files shown, the confirmation counts those in use, and each is deleted", async () => {
    listWorkspaceFiles.mockResolvedValue([file("f1", "Rate card.xlsx", [{ id: "w", name: "Monthly report" }]), file("f2", "Policy.pdf")]);
    searchParams = new URLSearchParams("type=files");
    render(<ResourcesPage />);
    await screen.findByText("Policy.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByLabelText("Select all files shown"));
    fireEvent.click(screen.getByRole("button", { name: "Delete (2)" }));
    expect(screen.getByText(/1 of them is read by a workflow/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));
    await waitFor(() => expect(deleteWorkspaceFile).toHaveBeenCalledTimes(2));
    expect(deleteWorkspaceFile.mock.calls.map((c) => c[0]).sort()).toEqual(["f1", "f2"]);
    listWorkspaceFiles.mockReset();
    listWorkspaceFiles.mockImplementation(async () => []);
  });

  it("no Select button outside the Files tab", async () => {
    listWorkspaceFiles.mockResolvedValue([file("f1", "Rate card.xlsx")]);
    render(<ResourcesPage />);
    await screen.findByText("Rate card.xlsx");
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    listWorkspaceFiles.mockReset();
    listWorkspaceFiles.mockImplementation(async () => []);
  });
});
