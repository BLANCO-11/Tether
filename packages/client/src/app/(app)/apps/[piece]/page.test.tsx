// @vitest-environment jsdom
//
// src/app/(app)/apps/[piece]/page.test.tsx — one connector's page (plans/plugins-2026-10-27, phase 5).
//
// ⚠ The rules pinned here are the ones a grep cannot see:
//   * a connection that was never tested, or whose connector has no check, is never shown as "Connected";
//   * changing a connection opens an EMPTY form — no stored value is ever put on screen;
//   * a password the piece typed as plain text (ServiceNow) is still a masked input;
//   * the raw API call and unserved actions cannot be switched on; an undeclared write reads "May change data";
//   * the install panel appears only for whoever may install.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ConnectorAction, ConnectorConnection, PersonalConnectorView, WorkspaceConnector } from "@/lib/types";

const api = vi.hoisted(() => ({
  listWorkspaceConnectors: vi.fn(),
  listConnectorInstalls: vi.fn(),
  createConnectorConnection: vi.fn(),
  updateConnectorConnection: vi.fn(),
  testConnectorConnection: vi.fn(),
  deleteConnectorConnection: vi.fn(),
  setConnectorActions: vi.fn(),
  setConnectorHosts: vi.fn(),
  upgradeConnector: vi.fn(),
  uninstallConnector: vi.fn(),
  startConnectorOauth: vi.fn(),
  connectorOauthApp: vi.fn(),
  setConnectorOauthApp: vi.fn(),
  removeConnectorOauthApp: vi.fn(),
  // Declared API calls (plans/declared-api-calls-2026-10-29): the panel under the actions when the piece has a raw call.
  listDeclaredCalls: vi.fn(async () => ({ calls: [], packs: [] })),
  declareCall: vi.fn(),
  enableCallPack: vi.fn(),
  removeDeclaredCall: vi.fn(),
  // For me (plans/personal-actions-2026-10-29): allowed, not connected, nothing on — unless a test says otherwise.
  personalConnector: vi.fn(async (): Promise<PersonalConnectorView> => ({ allowed: true, connected: false, actions: [], calls: [], packs: [] })),
  setMyConnectorActions: vi.fn(),
  enableMyCallPack: vi.fn(),
  removeMyDeclaredCall: vi.fn(),
  setPersonalUse: vi.fn(),
}));
vi.mock("@/lib/api", () => api);

const perms = vi.hoisted(() => ({ ws: "allowed" as "allowed" | "denied", platform: "denied" as "allowed" | "denied" }));
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/apps/service-now", useParams: () => ({ piece: "service-now" }) }));

import ConnectorPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/apps/service-now"); // the tab lives in the address; each test starts fresh
  perms.ws = "allowed";
  perms.platform = "denied";
});

const action = (name: string, over: Partial<ConnectorAction> = {}): ConnectorAction => ({
  name,
  displayName: name,
  description: `${name} does a thing`,
  classification: "READ",
  writes: false,
  destructive: false,
  idempotent: null,
  params: {},
  unsupported: [],
  ...over,
});
const conn = (over: Partial<ConnectorConnection> = {}): ConnectorConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  piece: "@activepieces/piece-service-now",
  label: "production",
  authType: "CUSTOM_AUTH",
  fieldNames: ["instanceUrl", "password", "username"],
  createdBy: "admin@example.com",
  createdAt: "2026-10-27T10:00:00Z",
  updatedAt: "2026-10-27T10:00:00Z",
  lastTestedAt: null,
  lastTestOk: null,
  lastTestMessage: null,
  ...over,
});
const serviceNow = (over: Partial<WorkspaceConnector> = {}): WorkspaceConnector => ({
  name: "@activepieces/piece-service-now",
  short: "service-now",
  displayName: "ServiceNow",
  description: "IT service management",
  logoUrl: null,
  version: "0.3.2",
  auth: [
    {
      type: "CUSTOM_AUTH",
      displayName: "Connection",
      required: true,
      checks: false,
      fields: [
        { name: "instanceUrl", label: "Instance URL", type: "SHORT_TEXT", required: true, secret: false, description: "" },
        { name: "username", label: "Username", type: "SHORT_TEXT", required: true, secret: false, description: "" },
        // ⚠ ServiceNow really does type its password as SHORT_TEXT.
        { name: "password", label: "Password", type: "SHORT_TEXT", required: true, secret: false, description: "" },
      ],
    },
  ],
  actions: [
    action("find_record"),
    action("create_record", { writes: true, classification: "WRITE" }),
    action("update_record", { writes: true, classification: null }),
    action("delete_record", { writes: true, destructive: true, classification: "DESTRUCTIVE" }),
    action("custom_api_call", { writes: true, classification: null }),
    action("pick_table", { unsupported: ['input "x" is a DYNAMIC property'] }),
  ],
  connections: [],
  enabled: [],
  ...over,
});

describe("connections", () => {
  it("⚠ an untested connection is 'Not tested' and a connector with no check is 'Not checked' — never 'Connected'", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([
      serviceNow({
        connections: [conn(), conn({ id: "22222222-2222-2222-2222-222222222222", label: "staging", lastTestedAt: "2026-10-27T11:00:00Z", lastTestOk: null, lastTestMessage: "This connector has no check of its own" })],
      }),
    ]);
    render(<ConnectorPage />);
    const list = await screen.findByRole("list", { name: "Workspace connections" });
    expect(within(list).getByText("Not tested")).toBeTruthy();
    expect(within(list).getByText("Not checked")).toBeTruthy();
    expect(within(list).queryByText("Connected")).toBeNull();
    expect(within(list).getAllByText(/Holds instanceUrl, password, username/).length).toBe(2);
  });

  it("creating one masks the password the piece typed as plain text, and sends what was typed", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    api.createConnectorConnection.mockResolvedValue(conn());
    render(<ConnectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect for the workspace" }));
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("Instance URL") as HTMLInputElement).type).toBe("text");
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "production" } });
    fireEvent.change(screen.getByLabelText("Instance URL"), { target: { value: "https://dev1.service-now.com" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "u" } });
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true); // the password is still missing
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "p" } });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    await waitFor(() =>
      expect(api.createConnectorConnection).toHaveBeenCalledWith("service-now", {
        label: "production",
        authType: "CUSTOM_AUTH",
        fields: { instanceUrl: "https://dev1.service-now.com", username: "u", password: "p" },
        asMe: false,
      }),
    );
  });

  it("⚠ changing one opens an EMPTY form and sends only what changed", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()] })]);
    api.updateConnectorConnection.mockResolvedValue(conn());
    render(<ConnectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    for (const label of ["Instance URL", "Username", "Password"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
    expect(screen.getByText(/Stored values are never shown/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "rotated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateConnectorConnection).toHaveBeenCalledWith(conn().id, { fields: { password: "rotated" } }));
  });

  it("the server's refusal is shown in the form, in its words", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    api.createConnectorConnection.mockRejectedValue(new Error('ServiceNow already has a connection called "production" here'));
    render(<ConnectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect for the workspace" }));
    for (const [l, v] of [["Connection name", "production"], ["Instance URL", "x"], ["Username", "u"], ["Password", "p"]]) {
      fireEvent.change(screen.getByLabelText(l!), { target: { value: v } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/already has a connection called "production"/)).toBeTruthy();
  });

  it("someone who may not connect services sees the workspace's connections but no buttons to change them", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()] })]);
    render(<ConnectorPage />);
    // A member opens on "For me"; the workspace's tab is there to read.
    fireEvent.click(await screen.findByRole("tab", { name: "For the workspace" }));
    await screen.findByRole("list", { name: "Workspace connections" });
    expect(screen.queryByRole("button", { name: "Connect for the workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  const oauthAuth = { type: "OAUTH2", displayName: "Connection", required: true, fields: [] };
  const oauthStatus = (configured: boolean) => ({ configured, useSignInApp: false, scopes: ["repo"], redirectUri: "http://localhost:4002/api/oauth/callback" });

  it("a sign-in connector with no app set up says so — no form for a token, no connect button", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ auth: [oauthAuth], oauth: oauthStatus(false) })]);
    render(<ConnectorPage />);
    expect(await screen.findByText(/Signing in to ServiceNow is not set up yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect for the workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect as yourself" })).toBeNull();
  });

  it("signing in shows what will be asked for, starts on the server, and sends the browser to the provider", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ auth: [oauthAuth], oauth: oauthStatus(true) })]);
    api.startConnectorOauth.mockResolvedValue({ authorizeUrl: "https://provider.example/authorize?x=1", scopes: ["repo"] });
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...real, assign, search: "", pathname: "/apps/service-now" } });
    try {
      render(<ConnectorPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Connect for the workspace" }));
      expect(screen.getByText("repo")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "acme" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue to ServiceNow" }));
      await waitFor(() => expect(api.startConnectorOauth).toHaveBeenCalledWith("service-now", { label: "acme", asMe: false, props: {} }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith("https://provider.example/authorize?x=1"));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    }
  });

  it("⚠ someone who may not connect for the workspace can still connect as themselves — signing in or with a key", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ auth: [oauthAuth], oauth: oauthStatus(true) })]);
    api.startConnectorOauth.mockResolvedValue({ authorizeUrl: "https://provider.example/a", scopes: [] });
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...real, assign, search: "", pathname: "/apps/service-now" } });
    try {
      render(<ConnectorPage />);
      expect(screen.queryByRole("button", { name: "Connect for the workspace" })).toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: "Connect as yourself" }));
      expect(screen.getByText(/Only you can see or use it/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "mine" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue to ServiceNow" }));
      await waitFor(() => expect(api.startConnectorOauth).toHaveBeenCalledWith("service-now", { label: "mine", asMe: true, props: {} }));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    }
  });

  it("connecting as yourself with a key sends it as a personal connection", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    api.createConnectorConnection.mockResolvedValue(conn());
    render(<ConnectorPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect as yourself" }));
    for (const [l, v] of [["Connection name", "mine"], ["Instance URL", "x"], ["Username", "u"], ["Password", "p"]]) {
      fireEvent.change(screen.getByLabelText(l!), { target: { value: v } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.createConnectorConnection).toHaveBeenCalledWith("service-now", expect.objectContaining({ label: "mine", asMe: true })));
  });

  it("⚠ a personal connection is listed apart as yours, and never offered as the connection actions run through", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([
      serviceNow({
        connections: [conn(), conn({ id: "22222222-2222-2222-2222-222222222222", label: "mine", personal: true, authType: "OAUTH2" })],
      }),
    ]);
    render(<ConnectorPage />);
    // An admin opens on the workspace's tab: the personal connection is not in it, and not offered to run actions.
    const ws = await screen.findByRole("list", { name: "Workspace connections" });
    expect(within(ws).queryByText("mine")).toBeNull();
    // One workspace connection ⇒ no picker at all; a personal one would have made two.
    expect(screen.queryByLabelText("Through which connection")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "For me" }));
    const yours = await screen.findByRole("list", { name: "Your connections" });
    expect(within(yours).getByText("mine")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Workspace connections" })).toBeNull();
  });
});

describe("actions", () => {
  it("groups each by what it does; the raw API call and unserved actions cannot be switched on", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()] })]);
    render(<ConnectorPage />);
    const list = await screen.findByRole("list", { name: "Actions" });
    const group = (name: string) => within(list).getByLabelText(`Use ${name}`).closest(".act-group")!.querySelector(".act-group-title")!.textContent;
    expect(group("find_record")).toBe("Reads");
    expect(group("create_record")).toBe("Changes data");
    expect(group("update_record")).toBe("Changes data");
    expect(within(within(list).getByLabelText("Use update_record").closest("li")!).getByText("May change data")).toBeTruthy();
    expect(group("delete_record")).toBe("Deletes data");
    expect(group("custom_api_call")).toBe("Not offered");
    expect((within(list).getByLabelText("Use custom_api_call") as HTMLInputElement).disabled).toBe(true);
    expect((within(list).getByLabelText("Use pick_table") as HTMLInputElement).disabled).toBe(true);
    expect((within(list).getByLabelText("Use find_record") as HTMLInputElement).disabled).toBe(false);
  });

  it("search narrows the list, and 'On' shows only what is on", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()], enabled: [{ action: "find_record", tool: "service_now_find_record", connection: conn().id }] as never })]);
    render(<ConnectorPage />);
    const list = await screen.findByRole("list", { name: "Actions" });
    fireEvent.change(screen.getByLabelText("Search actions"), { target: { value: "create" } });
    expect(within(list).queryByLabelText("Use find_record")).toBeNull();
    expect(within(list).getByLabelText("Use create_record")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search actions"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "On (1)" }));
    expect(within(list).getByLabelText("Use find_record")).toBeTruthy();
    expect(within(list).queryByLabelText("Use create_record")).toBeNull();
  });

  it("the save bar appears only once something changed, and Discard puts it back", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()] })]);
    render(<ConnectorPage />);
    const list = await screen.findByRole("list", { name: "Actions" });
    expect(screen.queryByRole("button", { name: "Save actions" })).toBeNull();
    fireEvent.click(within(list).getByLabelText("Use find_record"));
    expect(screen.getByText("1 change not saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("button", { name: "Save actions" })).toBeNull();
    expect((within(list).getByLabelText("Use find_record") as HTMLInputElement).checked).toBe(false);
  });

  it("saving sends the chosen actions through the chosen connection", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()] })]);
    api.setConnectorActions.mockResolvedValue(serviceNow());
    render(<ConnectorPage />);
    const list = await screen.findByRole("list", { name: "Actions" });
    fireEvent.click(within(list).getByLabelText("Use find_record"));
    fireEvent.click(within(list).getByLabelText("Use create_record"));
    fireEvent.click(screen.getByRole("button", { name: "Save actions" }));
    await waitFor(() => expect(api.setConnectorActions).toHaveBeenCalledWith("service-now", conn().id, ["find_record", "create_record"]));
  });

  it("with no connection, nothing can be switched on", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    render(<ConnectorPage />);
    const list = await screen.findByRole("list", { name: "Actions" });
    expect((within(list).getByLabelText("Use find_record") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("For me and For the workspace (plans/personal-actions-2026-10-29)", () => {
  const mine = (over: Partial<PersonalConnectorView> = {}): PersonalConnectorView => ({ allowed: true, connected: true, actions: [], calls: [], packs: [], ...over });
  const personal = conn({ id: "22222222-2222-2222-2222-222222222222", label: "mine", personal: true });

  it("a member opens on For me; an admin on For the workspace; the address keeps a chosen tab", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    render(<ConnectorPage />);
    expect((await screen.findByRole("tab", { name: "For me" })).getAttribute("aria-selected")).toBe("true");
    cleanup();
    perms.ws = "allowed";
    render(<ConnectorPage />);
    expect((await screen.findByRole("tab", { name: "For the workspace" })).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "For me" }));
    cleanup();
    render(<ConnectorPage />);
    expect((await screen.findByRole("tab", { name: "For me" })).getAttribute("aria-selected")).toBe("true");
  });

  it("⚠ a member reads the workspace's actions with no switches, and no say over personal use", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()], enabled: [{ action: "find_record", tool: "service_now_find_record", connection: conn().id, version: "0.3.2" }] })]);
    render(<ConnectorPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "For the workspace" }));
    const list = await screen.findByRole("list", { name: "Actions" });
    const on = within(list).getByLabelText("Use find_record") as HTMLInputElement;
    expect(on.checked).toBe(true);
    expect(on.disabled).toBe(true);
    expect((within(list).getByLabelText("Use create_record") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Only an admin changes these/)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Members may use their own/ })).toBeNull();
  });

  it("For me: switch an action on for yourself through your own account; one on for everyone is locked on", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([
      serviceNow({ connections: [conn(), personal], enabled: [{ action: "find_record", tool: "service_now_find_record", connection: conn().id, version: "0.3.2" }] }),
    ]);
    api.personalConnector.mockResolvedValue(mine());
    api.setMyConnectorActions.mockResolvedValue(mine({ actions: ["create_record"] }));
    render(<ConnectorPage />);
    const list = await screen.findByRole("list", { name: "Actions" });
    const everyone = within(list).getByLabelText("Use find_record") as HTMLInputElement;
    expect(everyone.checked && everyone.disabled).toBe(true);
    expect(within(list).getAllByText("On for everyone").length).toBeGreaterThan(0);
    fireEvent.click(within(list).getByLabelText("Use create_record"));
    fireEvent.click(screen.getByRole("button", { name: "Save my actions" }));
    await waitFor(() => expect(api.setMyConnectorActions).toHaveBeenCalledWith("service-now", ["create_record"]));
    expect(api.setConnectorActions).not.toHaveBeenCalled(); // never the workspace's list
  });

  it("For me, without your own connection or with personal use turned off: says why, and nothing switches", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    api.personalConnector.mockResolvedValue(mine({ connected: false }));
    render(<ConnectorPage />);
    expect(await screen.findByText(/Connect your own ServiceNow account first/)).toBeTruthy();
    expect((within(screen.getByRole("list", { name: "Actions" })).getByLabelText("Use find_record") as HTMLInputElement).disabled).toBe(true);
    cleanup();
    api.personalConnector.mockResolvedValue(mine({ allowed: false }));
    render(<ConnectorPage />);
    expect(await screen.findByText(/An admin has turned off members switching ServiceNow actions on/)).toBeTruthy();
  });

  it("⚠ an unreadable For me says the check did not run — never 'nothing is on'", async () => {
    perms.ws = "denied";
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    api.personalConnector.mockRejectedValue(new Error("boom"));
    render(<ConnectorPage />);
    expect(await screen.findByText("Your actions could not be read")).toBeTruthy();
  });

  it("an admin decides whether members may use their own account", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow({ connections: [conn()] })]);
    api.personalConnector.mockResolvedValue(mine());
    api.setPersonalUse.mockResolvedValue({ allowed: false });
    render(<ConnectorPage />);
    const sw = (await screen.findByRole("switch", { name: "Members may use their own ServiceNow account" })) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await waitFor(() => expect(api.setPersonalUse).toHaveBeenCalledWith("service-now", false));
  });
});

describe("the page itself", () => {
  it("⚠ a failed read is a failure — never 'not installed'", async () => {
    api.listWorkspaceConnectors.mockRejectedValue(new Error("the connector service could not be reached"));
    render(<ConnectorPage />);
    expect(await screen.findByText("Could not read this connector")).toBeTruthy();
    expect(screen.queryByText("Not installed on this deployment")).toBeNull();
  });

  it("the install panel appears only for whoever may install, and offers the suggested hosts", async () => {
    api.listWorkspaceConnectors.mockResolvedValue([serviceNow()]);
    render(<ConnectorPage />);
    await screen.findByRole("list", { name: "Actions" });
    expect(screen.queryByText("Installation (this deployment)")).toBeNull();
    expect(api.listConnectorInstalls).not.toHaveBeenCalled();
    cleanup();

    perms.platform = "allowed";
    api.listConnectorInstalls.mockResolvedValue([
      { name: "@activepieces/piece-service-now", short: "service-now", displayName: "ServiceNow", description: "", logoUrl: null, version: "0.3.2", license: null, hosts: [], suggestedHosts: ["dev12345.service-now.com"], status: "installed", installedBy: "admin@example.com", installedAt: "2026-10-27T10:00:00Z", auth: [], actions: [] },
    ]);
    render(<ConnectorPage />);
    expect(await screen.findByText("Installation (this deployment)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ dev12345.service-now.com" }));
    expect((screen.getByLabelText("Approved hosts") as HTMLTextAreaElement).value).toBe("dev12345.service-now.com");
  });
});
