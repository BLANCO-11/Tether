import { describe, expect, it } from "vitest";
import { parsePluginUrl, pluginToolName, pluginUrl } from "./plugin-connector.service.js";
import { workspaceLines } from "../pi-builder/service.js";

describe("plugin tool address", () => {
  it("round-trips piece, exact version and action", () => {
    const ref = { piece: "@activepieces/piece-amazon-s3", version: "0.8.1", action: "amazon_s3_upload_file" };
    expect(parsePluginUrl(pluginUrl(ref))).toEqual(ref);
    expect(parsePluginUrl("plugin://@activepieces/piece-amazon-s3@0.8.1/upload-file")?.action).toBe("upload-file");
  });

  it("refuses anything that is not one exact piece version (an approved revision must name exact code)", () => {
    expect(parsePluginUrl("https://example.com/x")).toBeNull();
    expect(parsePluginUrl("plugin://@activepieces/piece-amazon-s3@^0.8.1/a")).toBeNull();
    expect(parsePluginUrl("plugin://@activepieces/piece-amazon-s3@latest/a")).toBeNull();
    expect(parsePluginUrl("plugin://left-pad@1.3.0/a")).toBeNull();
    expect(parsePluginUrl(null)).toBeNull();
  });

  it("names a tool after its piece once, never twice", () => {
    expect(pluginToolName("@activepieces/piece-amazon-s3", "amazon_s3_upload_file")).toBe("amazon_s3_upload_file");
    expect(pluginToolName("@activepieces/piece-service-now", "create_record")).toBe("service_now_create_record");
    expect(pluginToolName("@activepieces/piece-amazon-s3", "upload-file")).toBe("amazon_s3_upload_file");
  });
});

describe("Forge's per-turn line about connected services", () => {
  const base = { purpose: "p", files: [] as string[] };
  it("names the plugin tools and says a change is refused, where Forge may read real data", () => {
    const lines = workspaceLines({ ...base, assistant: true, plugins: ["amazon_s3_list_files"] });
    const line = lines.find((l) => l.startsWith("On for the workspace"));
    expect(line).toContain('"amazon_s3_list_files"');
    expect(line).toContain("tools/use-plugin.mjs");
    expect(line).toContain("refused");
  });

  it("says nothing where the workspace does not let Forge read real data, or has no plugins", () => {
    expect(workspaceLines({ ...base, assistant: false, plugins: ["x"] }).some((l) => l.startsWith("On for the workspace"))).toBe(false);
    expect(workspaceLines({ ...base, assistant: true, plugins: [] }).some((l) => l.startsWith("On for the workspace"))).toBe(false);
    expect(workspaceLines({ ...base, assistant: true })).toHaveLength(3);
  });

  it("names the person's own actions in both modes, and how a workflow uses them (plans/personal-actions-2026-10-29)", () => {
    for (const assistant of [true, false]) {
      const line = workspaceLines({ ...base, assistant, myTools: ["azure_devops_list_branches"] }).find((l) => l.startsWith("On for this person only"));
      expect(line).toContain('"azure_devops_list_branches"');
      expect(line).toContain("catalogue.mine.json");
      expect(line).toContain("owner's own account");
      expect(line!.includes("use-plugin.mjs")).toBe(assistant); // read from now only where Forge may read real data
    }
    // A name the workspace already has on is not repeated as the person's own.
    expect(workspaceLines({ ...base, assistant: true, plugins: ["x"], myTools: ["x"] }).some((l) => l.startsWith("On for this person only"))).toBe(false);
  });

  it("keeps the plugin line when the Files list could not be read (only the Files line is dropped)", () => {
    const lines = workspaceLines({ purpose: "p", assistant: true, plugins: ["x"] });
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.startsWith("Workspace Files"))).toBe(false);
    expect(lines.at(-1)).toMatch(/^On for the workspace/);
  });
});
