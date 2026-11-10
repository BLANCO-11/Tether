import { describe, expect, it } from "vitest";
import { config } from "../config/index.js";
import { rememberModelConnection } from "../services/model-connection.js";
import { forgeEnv, forgeGateway, forgeOpenCodeEnv, rebaseForgeSession } from "./pi-runner.js";

const OLD = "/repo/packages/server/.pi-sandboxes/ws/old-session/sandbox";
const NEW = "/repo/packages/server/.pi-sandboxes/ws/new-session/sandbox";
const file = [
  JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: OLD }),
  JSON.stringify({ type: "message", content: [{ type: "text", text: `read ${OLD}/files/spec.pdf` }] }),
  "",
].join("\n");

describe("rebaseForgeSession — a stored conversation moved to a new sandbox", () => {
  it("points the header at the new sandbox, so Pi does not refuse a directory that is gone", () => {
    const out = rebaseForgeSession(file, NEW);
    const header = JSON.parse(out.split("\n")[0]!);
    expect(header).toEqual({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: NEW });
  });

  it("renames the old path everywhere in the history, and keeps every line", () => {
    const out = rebaseForgeSession(file, NEW);
    expect(out).not.toContain("old-session");
    expect(out).toContain(`${NEW}/files/spec.pdf`);
    expect(out.split("\n")).toHaveLength(3);
  });

  it("leaves a file it cannot read alone, rather than guessing", () => {
    expect(rebaseForgeSession("not json\nrest", NEW)).toBe("not json\nrest");
    expect(rebaseForgeSession(JSON.stringify({ type: "other" }), NEW)).toBe(JSON.stringify({ type: "other" }));
  });
});

describe("forgeEnv", () => {
  const server = {
    PATH: "/usr/bin",
    HOME: "/root",
    NODE_EXTRA_CA_CERTS: "/etc/foundry/corp-ca.pem",
    PI_BIN: "/usr/local/bin/pi",
    LITELLM_OFFLINE: "0",
    PARENT_API_KEY: "k",
    DATABASE_URL: "postgres://x",
    CREDENTIAL_ENC_KEY: "c",
    RUNTIME_JWT_SECRET: "j",
    SMTP_PASS: "m",
    LOCAL_ADMIN_PASSWORD: "p",
    LLM_API_KEY: "l",
    SOMETHING_ADDED_LATER: "s",
  };

  it("passes the shell, trust and Forge's own settings, and none of the server's secrets", () => {
    const env = forgeEnv(server);
    expect(Object.keys(env).sort()).toEqual(["HOME", "LITELLM_OFFLINE", "NODE_EXTRA_CA_CERTS", "PATH", "PI_BIN"]);
  });

  it("puts Forge's document tools first on its PATH when the image has them", () => {
    expect(forgeEnv({ ...server, FORGE_PYTHON_BIN: "/opt/forge-py/bin" }).PATH).toBe("/opt/forge-py/bin:/usr/bin");
  });
});

describe("forgeGateway (2026-11-04) — the one model connection's gateway", () => {
  it("is the environment's when nothing has been resolved", () => {
    expect(forgeGateway()).toEqual({
      LITELLM_BASE_URL: config.inference.baseUrl.replace(/\/v1\/?$/, ""),
      LITELLM_API_KEY: config.inference.apiKey,
    });
  });

  it("is the last resolved connection once one is remembered", () => {
    rememberModelConnection({ baseUrl: "https://gw2.example/v1", apiKey: "k2" });
    expect(forgeGateway()).toEqual({ LITELLM_BASE_URL: "https://gw2.example", LITELLM_API_KEY: "k2" });
  });
});

describe("forgeOpenCodeEnv — OpenCode's session headers via the tether-gateway extension", () => {
  it("Go: switches to the extension provider with the session header", () => {
    const url = "https://opencode.ai/inference/go/openai/v1";
    rememberModelConnection({ baseUrl: url, apiKey: "k", providerId: "opencode_go" });
    const env = forgeOpenCodeEnv("sess-1");
    expect(env.PI_PROVIDER).toBe("tether-gateway");
    expect(env.PI_GATEWAY_BASE_URL).toBe(url);
    expect(JSON.parse(env.PI_GATEWAY_HEADERS)).toEqual({ "x-opencode-session": "sess-1", "User-Agent": "Tether/1.0" });
  });

  it("Zen: only the User-Agent", () => {
    rememberModelConnection({ baseUrl: "https://opencode.ai/zen/v1", apiKey: "k", providerId: "opencode_zen" });
    expect(JSON.parse(forgeOpenCodeEnv("sess-1").PI_GATEWAY_HEADERS)).toEqual({ "User-Agent": "Tether/1.0" });
  });

  it("a custom gateway gets nothing", () => {
    rememberModelConnection({ baseUrl: "https://gw2.example/v1", apiKey: "k", providerId: "custom" });
    expect(forgeOpenCodeEnv("sess-1")).toEqual({});
  });
});
