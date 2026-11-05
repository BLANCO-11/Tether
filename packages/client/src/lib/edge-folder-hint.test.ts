import { describe, expect, it } from "vitest";
import { commandFamily, commonEdgeFolder, edgeActionLine, edgeFolderHint } from "./edge-folder-hint";

describe("edgeFolderHint", () => {
  it("infers folder from write_path file and path-bound commands", () => {
    expect(edgeFolderHint("write_path", { path: "/Users/himanshu/workspace/test/test_project/package.json" })).toBe(
      "/Users/himanshu/workspace/test/test_project",
    );
    expect(edgeFolderHint("run_command", { command: "python ~/ws/script.py" })).toBe("~/ws");
    expect(edgeFolderHint("run_command", { command: "ls -la ~/workspaces" })).toBe("~/workspaces");
    expect(edgeFolderHint("run_command", { command: "cd /Users/himanshu/workspace/test/test_project && npm install" })).toBe(
      "/Users/himanshu/workspace/test/test_project",
    );
    expect(
      edgeFolderHint("run_command", {
        command: "zsh -lc 'cd /Users/himanshu/workspace/test/test_project && docker compose up'",
      }),
    ).toBe("/Users/himanshu/workspace/test/test_project");
  });

  it("commandFamily names the tool for Allow always", () => {
    expect(commandFamily("docker ps")).toBe("docker");
    expect(commandFamily("zsh -lc 'docker compose up -d'")).toBe("docker");
    expect(commandFamily("cd /x && npm install")).toBe("npm");
  });

  it("returns null when no single folder can be inferred", () => {
    expect(edgeFolderHint("run_command", { command: "curl https://x" })).toBeNull();
    expect(edgeFolderHint("run_command", { command: "python ~/a/x.py ~/b/y.py" })).toBeNull();
  });

  it("commonEdgeFolder takes the shared ancestor of nested paths", () => {
    expect(
      commonEdgeFolder([
        "/Users/himanshu/workspace/test/test_project",
        "/Users/himanshu/workspace/test/test_project/app",
      ]),
    ).toBe("/Users/himanshu/workspace/test/test_project");
  });

  it("edgeActionLine is a short Actions one-liner", () => {
    expect(edgeActionLine("mac", "run_command", { command: "npm install" })).toBe("mac · $ npm install");
    expect(edgeActionLine("mac", "write_path", { path: "/Users/himanshu/workspace/test/test_project/package.json" })).toBe(
      "mac · Wrote package.json",
    );
    expect(edgeActionLine("mac", "read_path", { path: "~/ws/index.html" })).toBe("mac · Read index.html");
  });
});
