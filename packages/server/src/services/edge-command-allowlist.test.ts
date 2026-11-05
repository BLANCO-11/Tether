import { describe, expect, it } from "vitest";
import { edgeJobNeedsApproval, isHarmlessEdgeRunCommand } from "./edge-command-allowlist.js";

describe("isHarmlessEdgeRunCommand", () => {
  it("allows the default harmless set", () => {
    for (const cmd of ["whoami", "pwd", "date", "id", "hostname", "hostname -s", "uname", "uname -a", "uname -sm", "true", "false", "arch", "sw_vers", "echo hello", "echo a b"]) {
      expect(isHarmlessEdgeRunCommand(cmd), cmd).toBe(true);
    }
  });

  it("refuses shell metacharacters and unknown bins", () => {
    for (const cmd of [
      "whoami; rm -rf /",
      "whoami && id",
      "echo $(whoami)",
      "echo `id`",
      "cat /etc/passwd",
      "ls",
      "/bin/whoami",
      "./whoami",
      "echo -e hi",
      "uname -a; id",
      "curl http://x",
      "rm -rf /",
      "",
      "   ",
    ]) {
      expect(isHarmlessEdgeRunCommand(cmd), JSON.stringify(cmd)).toBe(false);
    }
  });
});

describe("edgeJobNeedsApproval", () => {
  it("skips approval for harmless run_command and for read_path", () => {
    expect(edgeJobNeedsApproval("run_command", { command: "whoami" })).toBe(false);
    expect(edgeJobNeedsApproval("read_path", { path: "/tmp/x" })).toBe(false);
  });

  it("requires approval for other run_command and for write_path", () => {
    expect(edgeJobNeedsApproval("run_command", { command: "ls -la" })).toBe(true);
    expect(edgeJobNeedsApproval("write_path", { path: "/tmp/x", contents: "hi" })).toBe(true);
  });
});
