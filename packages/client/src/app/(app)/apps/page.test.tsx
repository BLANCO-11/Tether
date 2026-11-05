// @vitest-environment jsdom
//
// src/app/(app)/apps/page.test.tsx — the Connectors page (plans/plugins-2026-10-27, phase 5).
//
// ⚠ What this pins, because `ui-honesty-check.sh` greps source and cannot see whether a sentence RENDERS:
//   * a failed read renders as a failure with its reason — never as an empty list or "nothing installed";
//   * a marketplace entry says whether it is installed, and Install is offered only to whoever may install;
//   * an OAuth-only connector is marked as not connectable yet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConnectorMarketplace, WorkspaceConnector } from "@/lib/types";

const api = vi.hoisted(() => ({
  listWorkspaceConnectors: vi.fn(),
  connectorMarketplace: vi.fn(),
  installConnector: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

const perms = vi.hoisted(() => ({ ws: "allowed" as "allowed" | "denied" | "unreadable", platform: "denied" as "allowed" | "denied" | "unreadable" }));
vi.mock("@/lib/permissions", () => ({
  usePermissions: () => ({
    data: null,
    loading: false,
    error: null,
    can: () => perms.ws,
    canPlatform: () => perms.platform,
    why: () => [],
    refresh: () => {},
  }),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/apps", useParams: () => ({}) }));

import ConnectorsPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  perms.ws = "allowed";
  perms.platform = "denied";
});

const connector = (over: Partial<WorkspaceConnector> = {}): WorkspaceConnector => ({
  name: "@activepieces/piece-amazon-s3",
  short: "amazon-s3",
  displayName: "Amazon S3",
  description: "Object storage",
  logoUrl: "https://cdn.activepieces.com/pieces/amazon-s3.png",
  version: "0.8.1",
  auth: [],
  actions: [],
  connections: [],
  enabled: [],
  ...over,
});

const market = (over: Partial<ConnectorMarketplace> = {}): ConnectorMarketplace => ({
  fetchedAt: "2026-10-27T10:00:00Z",
  stale: false,
  connectorReachable: true,
  entries: [
    { name: "@activepieces/piece-amazon-s3", short: "amazon-s3", displayName: "Amazon S3", description: "Object storage", logoUrl: null, version: "0.8.1", categories: ["CONTENT_AND_FILES"], authTypes: ["CUSTOM_AUTH"], actions: 19, triggers: 2, installedVersion: "0.8.1" },
    { name: "@activepieces/piece-slack", short: "slack", displayName: "Slack", description: "Messages", logoUrl: null, version: "1.2.3", categories: ["COMMUNICATION"], authTypes: ["OAUTH2"], actions: 30, triggers: 4, installedVersion: null },
  ],
  ...over,
});

describe("Connected here", () => {
  it("lists installed connectors with what is switched on in this workspace", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([
      connector({ connections: [{ id: "c1" } as never], enabled: [{ action: "a", tool: "t", connection: "c1", version: "0.8.1" }] }),
      connector({ name: "@activepieces/piece-service-now", short: "service-now", displayName: "ServiceNow" }),
    ]);
    render(<ConnectorsPage />);
    expect(await screen.findByText("Amazon S3")).toBeTruthy();
    expect(screen.getByText("1 action on")).toBeTruthy();
    expect(screen.getByText("Not connected here")).toBeTruthy();
    expect(screen.getByText("Amazon S3").closest("a")?.getAttribute("href")).toBe("/apps/amazon-s3");
  });

  it("⚠ a failed read is a failure with its reason — never 'nothing installed'", async () => {
    api.listWorkspaceConnectors.mockRejectedValue(new Error("the connector service could not be reached"));
    render(<ConnectorsPage />);
    expect(await screen.findByText("Could not read this workspace's connectors")).toBeTruthy();
    expect(screen.getByText(/the connector service could not be reached/)).toBeTruthy();
    expect(screen.queryByText(/No connector is installed/)).toBeNull();
  });

  it("an empty deployment says so, and points at the marketplace", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([]);
    render(<ConnectorsPage />);
    expect(await screen.findByText("No connector is installed on this deployment yet")).toBeTruthy();
  });

  it("someone who may not see connectors is told so rather than shown an empty page", async () => {
    perms.ws = "denied";
    render(<ConnectorsPage />);
    expect(screen.getByText("You cannot see this workspace's connectors")).toBeTruthy();
    expect(api.listWorkspaceConnectors).not.toHaveBeenCalled();
  });
});

describe("Marketplace", () => {
  const open = async () => {
    api.listWorkspaceConnectors.mockResolvedValue([]);
    render(<ConnectorsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  };

  it("says which entries are installed, and says a sign-in one connects by signing in", async () => {
    api.connectorMarketplace.mockResolvedValue(market());
    await open();
    expect(await screen.findByText("Installed · 0.8.1")).toBeTruthy();
    expect(screen.getByText(/Connects by signing in \(OAuth\)/)).toBeTruthy();
    expect(screen.getByText("2 of 2 connectors")).toBeTruthy();
  });

  it("Install is offered only to whoever may install; anyone else sees 'Not installed'", async () => {
    api.connectorMarketplace.mockResolvedValue(market());
    await open();
    await screen.findByText("Slack");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(screen.getByText("Not installed")).toBeTruthy();
    cleanup();

    perms.platform = "allowed";
    await open();
    await screen.findByText("Slack");
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("installing calls the server with the catalogue's exact version, then opens the connector", async () => {
    perms.platform = "allowed";
    api.connectorMarketplace.mockResolvedValue(market());
    api.installConnector.mockResolvedValue({});
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install 1.2.3" }));
    await waitFor(() => expect(api.installConnector).toHaveBeenCalledWith("slack", { version: "1.2.3" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/apps/slack"));
  });

  it("search narrows the list", async () => {
    api.connectorMarketplace.mockResolvedValue(market());
    await open();
    await screen.findByText("Slack");
    fireEvent.change(screen.getByLabelText("Search the marketplace"), { target: { value: "storage" } });
    expect(screen.queryByText("Slack")).toBeNull();
    expect(screen.getByText("1 of 2 connectors")).toBeTruthy();
  });

  it("⚠ an unreadable marketplace says so; a stale one says when it was read", async () => {
    api.connectorMarketplace.mockRejectedValue(new Error("answered 503"));
    await open();
    expect(await screen.findByText("Could not read the marketplace")).toBeTruthy();
    cleanup();
    api.connectorMarketplace.mockResolvedValue(market({ stale: true }));
    await open();
    expect(await screen.findByText("Showing the last copy of the marketplace")).toBeTruthy();
  });
});
