import { describe, expect, it } from "vitest";
import {
  actionEffect,
  catalogueAuthNote,
  categoryLabel,
  connectableAuths,
  fieldHint,
  setupInstructions,
  connectionState,
  fieldInput,
  filterCatalogue,
  offerable,
  parseHosts,
  workspaceState,
} from "./connector-ui";
import type { ConnectorAction, ConnectorCatalogueEntry } from "./types";

const action = (over: Partial<ConnectorAction> = {}): ConnectorAction => ({
  name: "a",
  displayName: "A",
  description: "",
  classification: "READ",
  writes: false,
  destructive: false,
  idempotent: null,
  params: {},
  unsupported: [],
  ...over,
});

describe("what an action does", () => {
  it("reads, changes, deletes — and an UNDECLARED write is 'may change', never 'only reads'", () => {
    expect(actionEffect(action())).toEqual({ label: "Only reads", tone: "ok" });
    expect(actionEffect(action({ writes: true, classification: "WRITE" })).label).toBe("Changes data");
    expect(actionEffect(action({ writes: true, destructive: true, classification: "DESTRUCTIVE" }))).toEqual({ label: "Deletes data", tone: "danger" });
    expect(actionEffect(action({ writes: true, classification: null }))).toEqual({ label: "May change data", tone: "warn" });
  });
  it("an action the connector cannot serve, and the raw API call, are not offered", () => {
    expect(actionEffect(action({ unsupported: ["x"] })).label).toBe("Not offered");
    expect(offerable(action({ unsupported: ["x"] }))).toBe(false);
    expect(offerable(action({ name: "custom_api_call" }))).toBe(false);
    expect(offerable(action())).toBe(true);
  });
});

describe("a connection's state", () => {
  it("never says Connected unless the service accepted it", () => {
    expect(connectionState({ lastTestedAt: null, lastTestOk: null, lastTestMessage: null }).label).toBe("Not tested");
    expect(connectionState({ lastTestedAt: "2026-10-27T10:00:00Z", lastTestOk: null, lastTestMessage: "no check" })).toMatchObject({ label: "Not checked", detail: "no check" });
    expect(connectionState({ lastTestedAt: "2026-10-27T10:00:00Z", lastTestOk: false, lastTestMessage: "bad key" })).toMatchObject({ label: "Refused", tone: "danger", detail: "bad key" });
    expect(connectionState({ lastTestedAt: "2026-10-27T10:00:00Z", lastTestOk: true, lastTestMessage: "Connected" }).label).toBe("Connected");
  });
});

describe("connection fields", () => {
  it("masks anything that may be a secret, including a password the piece typed as plain text", () => {
    const f = (name: string, secret = false) => ({ name, type: "SHORT_TEXT", required: true, secret, description: "" });
    expect(fieldInput(f("password"))).toBe("password");
    expect(fieldInput(f("apiKey"))).toBe("password");
    expect(fieldInput(f("anything", true))).toBe("password");
    expect(fieldInput(f("instanceUrl"))).toBe("text");
    expect(fieldInput({ ...f("cloud"), options: [{ label: "x", value: "x" }] })).toBe("select");
  });
  it("a sign-in connector is connected by signing in, never offered a form for its token; OIDC alone is not yet", () => {
    const oauth = { type: "OAUTH2", displayName: null, required: true };
    expect(connectableAuths([oauth])).toEqual({ forms: [], signIn: oauth, notYet: false, none: false });
    expect(connectableAuths([oauth, { type: "SECRET_TEXT", displayName: null, required: true }]).forms.map((a) => a.type)).toEqual(["SECRET_TEXT"]);
    expect(connectableAuths([{ type: "OIDC", displayName: null, required: true }]).notYet).toBe(true);
    expect(connectableAuths([]).none).toBe(true);
    expect(catalogueAuthNote({ authTypes: ["OAUTH2"] })).toMatch(/signing in \(OAuth\)/);
    expect(catalogueAuthNote({ authTypes: ["OIDC"] })).toMatch(/not available yet/);
    expect(catalogueAuthNote({ authTypes: ["OAUTH2", "CUSTOM_AUTH"] })).toBeNull();
  });
});

describe("the marketplace list", () => {
  const e = (short: string, over: Partial<ConnectorCatalogueEntry> = {}): ConnectorCatalogueEntry => ({
    name: `@activepieces/piece-${short}`,
    short,
    displayName: short.toUpperCase(),
    description: "",
    logoUrl: null,
    version: "1.0.0",
    categories: [],
    authTypes: [],
    actions: 1,
    triggers: 0,
    installedVersion: null,
    ...over,
  });
  const list = [e("amazon-s3", { categories: ["CONTENT_AND_FILES"], installedVersion: "0.8.1" }), e("slack", { categories: ["COMMUNICATION"], description: "Send messages" })];
  it("filters by text, category and installed", () => {
    expect(filterCatalogue(list, { q: "messages", category: "all", installedOnly: false }).map((x) => x.short)).toEqual(["slack"]);
    expect(filterCatalogue(list, { q: "", category: "CONTENT_AND_FILES", installedOnly: false }).map((x) => x.short)).toEqual(["amazon-s3"]);
    expect(filterCatalogue(list, { q: "", category: "all", installedOnly: true }).map((x) => x.short)).toEqual(["amazon-s3"]);
  });
  it("labels", () => {
    expect(categoryLabel("CONTENT_AND_FILES")).toBe("Content and files");
    expect(parseHosts("API.github.com\n s3:8333, api.github.com")).toEqual(["api.github.com", "s3:8333"]);
  });
  it("a workspace connector says what is switched on, or that nothing is", () => {
    expect(workspaceState({ connections: [], enabled: [] }).label).toBe("Not connected here");
    expect(workspaceState({ connections: [{} as never], enabled: [] }).tone).toBe("warn");
    expect(workspaceState({ connections: [{} as never], enabled: [{ action: "a", tool: "t", connection: null, version: "1" }] }).label).toBe("1 action on");
  });
});

describe("a piece's setup instructions, as Foundry shows them", () => {
  it("⚠ drops a paragraph about Activepieces' own screens, keeps how to get the credential", () => {
    const teams = "When you connect, Activepieces shows a **permissions** selector.\nTick only what you need.\n\nUse your **tenant id** from the Azure portal.";
    expect(setupInstructions(teams)).toBe("Use your **tenant id** from the Azure portal.");
    expect(setupInstructions(undefined)).toBe("");
  });
  it("a field hint that only repeats the instructions above it is not shown twice", () => {
    const pat = "Authenticate with a GitHub personal access token (classic or fine-grained).";
    expect(fieldHint(pat, pat)).toBeUndefined();
    expect(fieldHint("Your AWS access key ID.", "Connect your Amazon S3 account.")).toBe("Your AWS access key ID.");
    expect(fieldHint("", "x")).toBeUndefined();
  });
});
