/**
 * Mock onboarding hooks: every entry point builds (or loudly refuses), and the
 * service surface derives state instead of trusting client input.
 *
 * Source-pinned like `sandbox-autoprovision-seeders.test.ts`: the property that
 * matters is "this file calls the hook after introspection", which a
 * file-content assertion pins without a database. Deterministic, no prod touch.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** All seeder paths that introspect directly, one layer below `refreshSchema`. */
const SEEDERS = [
  "../demo/generic/provision.ts",
  "../demo/provision.ts",
  "../demo/alt/provision-alt.ts",
  "../demo/finance/provision-finance.ts",
  "../demo/itops/provision-itops.ts",
  "../demo/legal/provision-legal.ts",
  "../scenarios/uat-lifecycle-setup.ts",
];

describe("every seeder path builds a mock after introspecting", () => {
  for (const rel of SEEDERS) {
    it(`${rel.split("/").pop()} calls requestMockBuild after introspecting`, () => {
      const src = read(rel);
      expect(src.length).toBeGreaterThan(3000);
      const introspect = src.indexOf("schemaIntrospectorService.refresh(");
      const hook = src.indexOf("requestMockBuild(workspaceId, datasourceId)");
      expect(introspect).toBeGreaterThan(-1);
      expect(hook).toBeGreaterThan(introspect);
    });
  }

  it("uses the mock hook name, not the sandbox one — the sandbox asymmetry stays pinned", () => {
    for (const rel of SEEDERS) {
      if (rel.endsWith("demo/generic/provision.ts")) continue;
      expect(read(rel)).not.toContain("provisionIfAbsent");
    }
  });
});

describe("datasource.service hook placement", () => {
  const src = () => read("./datasource.service.ts");

  it("is reading the real service", () => {
    expect(src().length).toBeGreaterThan(8000);
  });

  it("hooks refreshSchema post-introspection, fire-and-forget", () => {
    const s = src();
    expect(s).toMatch(/void requestMockBuild\(workspaceId, id\)\.catch\(/);
    const i = s.indexOf("void requestMockBuild");
    expect(s.lastIndexOf("async refreshSchema", i)).toBeGreaterThan(-1);
  });

  it("rebuilds (not just invalidates) on credential/allowlist edits", () => {
    const s = src();
    expect(s).toMatch(/void rebuildMockDataset\(workspaceId, id\)\.catch\(/);
    const i = s.indexOf("void rebuildMockDataset");
    expect(s.lastIndexOf("async update(", i)).toBeGreaterThan(-1);
  });

  it("never hooks create (nothing introspected there) or test (dial only)", () => {
    const s = src();
    const createStart = s.indexOf("async create(");
    const updateStart = s.indexOf("async update(");
    const testStart = s.indexOf("async test(");
    const refreshStart = s.indexOf("async refreshSchema");
    expect(createStart).toBeGreaterThan(-1);
    expect(s.slice(createStart, updateStart)).not.toContain("requestMockBuild");
    expect(s.slice(createStart, updateStart)).not.toContain("rebuildMockDataset");
    expect(s.slice(testStart, refreshStart)).not.toContain("requestMockBuild");
    expect(s.slice(testStart, refreshStart)).not.toContain("rebuildMockDataset");
  });
});

describe("server-derived mock state (never client-writable)", () => {
  const src = () => read("./datasource.service.ts");

  it("updateDatasourceSchema has no has_mock_data", () => {
    const s = src();
    const start = s.indexOf("export const updateDatasourceSchema");
    const end = s.indexOf("});", start);
    expect(s.slice(start, end)).not.toContain("hasMockData");
  });

  it("no patch line writes hasMockData", () => {
    expect(src()).not.toContain("patch.hasMockData");
  });

  it("toPublic derives hasMockData from READY fixtures, not the stored column", () => {
    const s = src();
    expect(s).not.toContain("Boolean(raw.hasMockData)");
    expect(s).toContain("readyIdsForWorkspace");
    expect(s).toContain("hasReadyMock");
  });
});

describe("mock-only-until-linked rows", () => {
  const src = () => read("./datasource.service.ts");

  it("create accepts a missing connection string and stores null", () => {
    const s = src();
    expect(s).toContain("connectionString: z.string().min(1).max(8192).optional()");
    expect(s).toContain("input.connectionString !== undefined ? encrypt(input.connectionString) : null");
  });

  it("update skips credential gates when no DSN exists on either side", () => {
    expect(src()).toContain("existing.connectionStringEnc");
  });

  it("test() reports instead of throwing when no credential is linked", () => {
    expect(src()).toContain("no credential linked to this datasource");
  });

  it("refreshSchema() refuses with a 409 when no credential is linked", () => {
    const s = src();
    const i = s.indexOf("async refreshSchema");
    expect(s.slice(i)).toContain("statusCode = 409");
  });

  it("secretEnvName is nullable for detach", () => {
    expect(src()).toContain("secretEnvName: z.string().max(255).optional().nullable()");
  });
});

describe("rebuild trigger for pre-existing databases", () => {
  it("covers per-datasource and rebuild-all", () => {
    const cli = read("../mock/cli.ts");
    expect(cli.length).toBeGreaterThan(1500);
    expect(cli).toContain("rebuildMockDataset");
    expect(cli).toContain("--datasource=");
    expect(cli).toContain("--all");
  });
});
