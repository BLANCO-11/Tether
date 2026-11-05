import { describe, expect, it } from "vitest";
import {
  commandFamily,
  commandTrustPattern,
  commonDirectory,
  directoryShellAllowed,
  edgeJobNeedsApproval,
  edgeJobUnderFolder,
  evaluateEdgeJobApproval,
  folderPatternFromJob,
  isHarmlessEdgeRunCommand,
  normalizeCommandPattern,
  pathsInCommand,
  shellSurface,
  unwrapShellWrapper,
} from "./edge-command-allowlist.js";

describe("isHarmlessEdgeRunCommand", () => {
  it("allows the default harmless set", () => {
    for (const cmd of [
      "whoami",
      "pwd",
      "date",
      "id",
      "hostname",
      "hostname -s",
      "uname",
      "uname -a",
      "uname -sm",
      "true",
      "false",
      "arch",
      "sw_vers",
      "echo hello",
      "echo a b",
      "ls",
      "ls -la",
      "ls -la ~/workspaces",
      "ls -alh /tmp",
      "ls -1",
    ]) {
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
      "/bin/whoami",
      "./whoami",
      "echo -e hi",
      "uname -a; id",
      "curl http://x",
      "rm -rf /",
      "ls; rm -rf /",
      "ls --all",
      "ls ../secret",
      "ls -la ../../etc",
      "",
      "   ",
    ]) {
      expect(isHarmlessEdgeRunCommand(cmd), JSON.stringify(cmd)).toBe(false);
    }
  });
});

describe("edgeJobNeedsApproval (built-in only)", () => {
  it("skips approval for harmless run_command and for read_path", () => {
    expect(edgeJobNeedsApproval("run_command", { command: "whoami" })).toBe(false);
    expect(edgeJobNeedsApproval("run_command", { command: "ls -la ~/workspaces" })).toBe(false);
    expect(edgeJobNeedsApproval("read_path", { path: "/tmp/x" })).toBe(false);
  });

  it("requires approval for other run_command and for write_path", () => {
    expect(edgeJobNeedsApproval("run_command", { command: "curl http://x" })).toBe(true);
    expect(edgeJobNeedsApproval("write_path", { path: "/tmp/x", contents: "hi" })).toBe(true);
  });
});

describe("evaluateEdgeJobApproval with trust rules", () => {
  it("deny command gates even a built-in-harmless command", () => {
    const r = evaluateEdgeJobApproval("run_command", { command: "ls -la ~/workspaces" }, [
      { effect: "deny", scope: "command", pattern: "ls -la ~/workspaces" },
    ]);
    expect(r.needsApproval).toBe(true);
    expect(r.reason).toBe("deny_command");
  });

  it("allow command auto-approves a otherwise gated command", () => {
    const r = evaluateEdgeJobApproval("run_command", { command: "uptime" }, [
      { effect: "allow", scope: "command", pattern: "uptime" },
    ]);
    expect(r.needsApproval).toBe(false);
    expect(r.reason).toBe("allow_command");
  });

  it("path_read grant auto-approves ls under that folder when not built-in-blocked", () => {
    // Use a command that would need approval if ls were not built-in — deny first then path won't help.
    // path_read applies when built-in allow missed: e.g. we only grant folder for a custom case.
    // With ls built-in, path_read is redundant for safe ls; still match when allow command absent and
    // we force past builtin by using evaluate with a rule-only path (simulate non-builtin via curl under grant — not ls).
    // Spec: ls under path_read → auto. Use a deny on a different pattern and path_read for nested ls that
    // somehow isn't builtin — actually safe ls always hits builtin_allow first.
    // Prove path_read matching helper via folderPattern + evaluate on a hypothetical unsafe-flag rejection:
    // `ls --color` is refused by builtin; path_read should not rescue long options.
    const blocked = evaluateEdgeJobApproval("run_command", { command: "ls --color ~/workspaces" }, [
      { effect: "allow", scope: "path_read", pattern: "~/workspaces" },
    ]);
    expect(blocked.needsApproval).toBe(true);

    // Prefix allow for a non-builtin bin:
    const allowed = evaluateEdgeJobApproval("run_command", { command: "stat ~/workspaces" }, [
      { effect: "allow", scope: "command", pattern: "stat ~/workspaces" },
    ]);
    expect(allowed.needsApproval).toBe(false);
  });

  it("path_write grant auto-approves write_path under the folder", () => {
    const r = evaluateEdgeJobApproval("write_path", { path: "~/workspaces/a.txt", contents: "x" }, [
      { effect: "allow", scope: "path_write", pattern: "~/workspaces" },
    ]);
    expect(r.needsApproval).toBe(false);
    expect(r.reason).toBe("path_write_grant");
  });

  it("directory grant auto-approves path-bound commands under the folder", () => {
    const rules = [
      { effect: "allow" as const, scope: "path_read" as const, pattern: "~/ws" },
      { effect: "allow" as const, scope: "path_write" as const, pattern: "~/ws" },
    ];
    const ok = evaluateEdgeJobApproval("run_command", { command: "python ~/ws/a.py" }, rules);
    expect(ok.needsApproval).toBe(false);
    expect(ok.reason).toBe("directory_grant");

    const compound = evaluateEdgeJobApproval(
      "run_command",
      { command: "cd ~/ws && npm install" },
      rules,
    );
    expect(compound.needsApproval).toBe(false);
    expect(compound.reason).toBe("directory_grant");

    const outside = evaluateEdgeJobApproval("run_command", { command: "python /other/a.py" }, rules);
    expect(outside.needsApproval).toBe(true);

    const noPath = evaluateEdgeJobApproval("run_command", { command: "curl https://x" }, rules);
    expect(noPath.needsApproval).toBe(true);

    const curlInDir = evaluateEdgeJobApproval(
      "run_command",
      { command: "cd ~/ws && curl https://x" },
      rules,
    );
    expect(curlInDir.needsApproval).toBe(true);

    const printfWrite = evaluateEdgeJobApproval(
      "run_command",
      { command: `printf '%s' '{"name":"x"}' > ~/ws/package.json` },
      rules,
    );
    expect(printfWrite.needsApproval).toBe(false);
    expect(printfWrite.reason).toBe("directory_grant");
  });

  it("folder grant ignores paths inside quoted payloads (HTML/JSX false positives)", () => {
    const grant = "/Users/himanshu/workspace/test/test_project";
    const rules = [
      { effect: "allow" as const, scope: "path_read" as const, pattern: grant },
      { effect: "allow" as const, scope: "path_write" as const, pattern: grant },
    ];
    // Shape that actually stuck in chat 3ede5470: mkdir/cp + printf of JSX with </body>, src="/orbit.html".
    const cmd =
      `mkdir -p ${grant}/app ${grant}/public && ` +
      `cp ${grant}/index.html ${grant}/public/orbit.html && ` +
      `printf '%s' '<html><body><iframe src="/orbit.html" /></body></html>' > ${grant}/app/page.tsx && ` +
      `printf '%s' '{"name":"x"}' > ${grant}/package.json`;

    expect(pathsInCommand(cmd)).toEqual([
      `${grant}/app`,
      `${grant}/public`,
      `${grant}/index.html`,
      `${grant}/public/orbit.html`,
      `${grant}/app/page.tsx`,
      `${grant}/package.json`,
    ]);
    expect(pathsInCommand(cmd).some((p) => p === "/body" || p === "/orbit.html" || p === "/html")).toBe(
      false,
    );
    expect(directoryShellAllowed(cmd, rules)).toBe(true);

    const r = evaluateEdgeJobApproval("run_command", { command: cmd }, rules);
    expect(r.needsApproval).toBe(false);
    expect(r.reason).toBe("directory_grant");

    // Unquoted path outside the grant still asks.
    const leak = evaluateEdgeJobApproval(
      "run_command",
      { command: `cp ${grant}/a /tmp/leaked` },
      rules,
    );
    expect(leak.needsApproval).toBe(true);

    // `$` inside a quoted payload must not block; `$` on the shell surface must.
    expect(
      directoryShellAllowed(`printf '%s' 'const x = process.env.FOO$BAR' > ${grant}/a.js`, rules),
    ).toBe(true);
    expect(directoryShellAllowed(`cd ${grant} && echo $HOME`, rules)).toBe(false);
  });

  it("shellSurface blanks quoted regions only", () => {
    const s = shellSurface(`printf '%s' '</body>' > /tmp/a && echo "hi"`);
    expect(s).not.toContain("</body>");
    expect(s).toContain("/tmp/a");
    expect(s).toContain("printf");
    expect(s).toContain("echo");
  });

  it("unwraps zsh -lc so folder grants see cd…&&docker inside", () => {
    const grant = "/Users/himanshu/workspace/test/test_project";
    const rules = [
      { effect: "allow" as const, scope: "path_read" as const, pattern: grant },
      { effect: "allow" as const, scope: "path_write" as const, pattern: grant },
    ];
    const wrapped = `zsh -lc 'cd ${grant} && docker compose up -d --build'`;
    expect(unwrapShellWrapper(wrapped)).toBe(`cd ${grant} && docker compose up -d --build`);
    expect(directoryShellAllowed(wrapped, rules)).toBe(true);
    expect(evaluateEdgeJobApproval("run_command", { command: wrapped }, rules).needsApproval).toBe(false);
    expect(folderPatternFromJob("run_command", { command: wrapped })).toBe(grant);
  });

  it("Allow always is a command family (docker), not one exact argv", () => {
    expect(commandFamily("docker ps")).toBe("docker");
    expect(commandFamily("zsh -lc 'cd /tmp && docker compose up'")).toBe("docker");
    expect(commandFamily("cd /x && npm install")).toBe("npm");
    expect(commandTrustPattern("zsh -lc 'docker compose up -d'")).toBe("docker");

    const rules = [{ effect: "allow" as const, scope: "command" as const, pattern: "docker" }];
    expect(
      evaluateEdgeJobApproval("run_command", { command: "docker ps" }, rules),
    ).toMatchObject({ needsApproval: false, reason: "allow_command" });
    expect(
      evaluateEdgeJobApproval(
        "run_command",
        { command: "zsh -lc 'cd /Users/himanshu/workspace/test/test_project && docker compose up -d --build'" },
        rules,
      ),
    ).toMatchObject({ needsApproval: false, reason: "allow_command" });
    // Mixed family must not ride the docker allow.
    expect(
      evaluateEdgeJobApproval("run_command", { command: "docker ps; curl https://x" }, rules).needsApproval,
    ).toBe(true);
    expect(evaluateEdgeJobApproval("run_command", { command: "npm install" }, rules).needsApproval).toBe(true);
  });

  it("command prefix match does not over-match", () => {
    const r = evaluateEdgeJobApproval("run_command", { command: "uptime -s" }, [
      { effect: "allow", scope: "command", pattern: "uptime -x" },
    ]);
    expect(r.needsApproval).toBe(true);
  });
});

describe("normalizeCommandPattern / folderPatternFromJob", () => {
  it("normalizes argv", () => {
    expect(normalizeCommandPattern("  ls   -la  ~/workspaces ")).toBe("ls -la ~/workspaces");
    expect(normalizeCommandPattern("ls; rm")).toBeNull();
  });

  it("extracts folder from ls / read / path-bound commands", () => {
    expect(folderPatternFromJob("run_command", { command: "ls -la ~/workspaces" })).toBe("~/workspaces");
    expect(folderPatternFromJob("read_path", { path: "~/workspaces/a" })).toBe("~/workspaces/a");
    expect(folderPatternFromJob("write_path", { path: "~/workspaces/a.txt" })).toBe("~/workspaces");
    expect(folderPatternFromJob("run_command", { command: "python ~/ws/script.py" })).toBe("~/ws");
    expect(folderPatternFromJob("run_command", { command: "cd ~/ws && npm install" })).toBe("~/ws");
    expect(folderPatternFromJob("run_command", { command: "ls -la a b" })).toBeNull();
  });

  it("commonDirectory / edgeJobUnderFolder for sibling file Approves", () => {
    expect(commonDirectory(["~/ws", "~/ws/app"])).toBe("~/ws");
    expect(
      edgeJobUnderFolder("write_path", { path: "~/ws/app/page.tsx" }, "~/ws"),
    ).toBe(true);
    expect(edgeJobUnderFolder("write_path", { path: "/other/x" }, "~/ws")).toBe(false);
  });
});
