/**
 * The workspace placeholder must never reach a request.
 *
 * ⚠ This is the client half of the 2026-09-08 outage: six admin pages call
 * `getMe(workspaceId)` with the context value on first render, and that value is
 * `ws_it` until the resolver answers. `/api/me?workspaceId=ws_it` is not a uuid,
 * and the API server died on it fifteen times. See `lib/workspace-choice.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const me = vi.fn();
const resolveWorkspaceId = vi.fn();

vi.mock("@/lib/foundry-client", () => ({
  foundryApi: { me },
  resolveWorkspaceId,
  FoundryApiError: class extends Error {},
  NO_WORKSPACE_MESSAGE: "none",
}));

const REAL = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("getMe never sends the placeholder", () => {
  beforeEach(() => {
    me.mockReset().mockResolvedValue({ subject: "s", superAdmin: false });
    resolveWorkspaceId.mockReset().mockResolvedValue(REAL);
  });

  it("translates the unresolved placeholder into the resolved workspace", async () => {
    const { getMe } = await import("@/lib/api");
    const { UNRESOLVED_WORKSPACE } = await import("@/lib/workspace-choice");
    await getMe(UNRESOLVED_WORKSPACE);
    expect(resolveWorkspaceId).toHaveBeenCalled();
    expect(me).toHaveBeenCalledWith(REAL);
    // The literal that took the server down must appear in no call.
    expect(me.mock.calls.flat()).not.toContain(UNRESOLVED_WORKSPACE);
  });

  it("passes a real workspace id through untouched, and does not resolve", async () => {
    const { getMe } = await import("@/lib/api");
    await getMe(REAL);
    expect(me).toHaveBeenCalledWith(REAL);
    expect(resolveWorkspaceId).not.toHaveBeenCalled();
  });

  it("leaves the no-workspace call alone — it is a legal question", async () => {
    const { getMe } = await import("@/lib/api");
    await getMe();
    expect(me).toHaveBeenCalledWith(undefined);
  });

  /**
   * ⚠ A resolution failure must NOT degrade to the no-workspace call. That
   * answers without `capabilities`, and every admin page reads a missing
   * capability as "you are not an admin" — a wrong answer that looks
   * authoritative on the screen where being wrong matters most.
   */
  it("surfaces a resolution failure instead of asking without a workspace", async () => {
    const { getMe } = await import("@/lib/api");
    const { UNRESOLVED_WORKSPACE } = await import("@/lib/workspace-choice");
    resolveWorkspaceId.mockRejectedValue(new Error("no workspaces"));
    await expect(getMe(UNRESOLVED_WORKSPACE)).rejects.toThrow("no workspaces");
    expect(me).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE CONTROL FOR THE WHOLE FIX. `getMe(workspaceId)` is asserted to be the
   * only place a page hands the raw context value to an api function — if a
   * second one appears, the single guard above stops being sufficient and this
   * goes red rather than the outage coming back.
   */
  it("CONTROL: getMe is still the only consumer of the raw context value", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e) && !e.includes(".test.")) files.push(p);
      }
    };
    walk(join(process.cwd(), "src/app"));
    walk(join(process.cwd(), "src/components"));
    expect(files.length).toBeGreaterThan(50); // the scan can find things

    const calls = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!/useWorkspace\(\)/.test(src)) continue;
      for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\(\s*workspaceId\s*[,)]/g)) {
        calls.add(m[1]);
      }
    }
    // Every function a page hands the raw context value to must translate it.
    const api = readFileSync(join(process.cwd(), "src/lib/api.ts"), "utf8");
    const translating = new Set(
      [...api.matchAll(/export async function ([A-Za-z_$][\w$]*)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
        .filter(([, , body]) => body.includes("scopedWorkspace("))
        .map(([, name]) => name),
    );
    expect(translating.size).toBeGreaterThan(0); // the scan can find things
    expect([...calls].sort().filter((c) => !translating.has(c))).toEqual([]);
  });
});
