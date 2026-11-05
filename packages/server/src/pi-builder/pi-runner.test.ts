import { describe, expect, it } from "vitest";
import { forgeEnv, rebaseForgeSession } from "./pi-runner.js";

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
    MAIL_GRAPH_CLIENT_SECRET_VALUE: "m",
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
