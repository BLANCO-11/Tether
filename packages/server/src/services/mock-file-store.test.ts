/**
 * Mock file store: 0600 atomic files under <DATA_DIR>/mocks, fingerprint-gated reads.
 *
 * Real fs, but strictly inside a per-test tmp dir via `$MOCK_DATA_DIR` — never
 * the repo, never prod. Deterministic: no clock, no network, no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMockFile, resolveMockFilePath, rootOwnerToAdopt, writeMockFile } from "./mock-file-store.js";

const WS = "ws-test-1";
const DS = "ds-test-1";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mock-store-"));
  vi.stubEnv("MOCK_DATA_DIR", dir);
  vi.stubEnv("DATA_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function sampleTables() {
  return [
    {
      name: "authors",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
      ],
      rows: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `mock_name_${i}` })),
    },
  ];
}

describe("write + read round-trip", () => {
  it("writes under mocks/<workspace>/<datasource>/v<N>.json and reads back", async () => {
    const dest = await writeMockFile({
      workspaceId: WS,
      datasourceId: DS,
      version: 1,
      fingerprint: "fp-1",
      tables: sampleTables(),
    });
    expect(dest).toBe(resolveMockFilePath(WS, DS, 1));
    expect(dest).toContain(path.join("mocks", WS, DS, "v1.json"));

    const back = await readMockFile(WS, DS, 1, "fp-1");
    expect(back.version).toBe(1);
    expect(back.fingerprint).toBe("fp-1");
    expect(back.tables).toHaveLength(1);
    expect(back.tables[0].rows).toHaveLength(10);
  });

  it("stores files owner-only (0600)", async () => {
    const dest = await writeMockFile({
      workspaceId: WS,
      datasourceId: DS,
      version: 1,
      fingerprint: "fp-1",
      tables: sampleTables(),
    });
    const st = await stat(dest);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("leaves no tmp files behind (atomic publish)", async () => {
    await writeMockFile({
      workspaceId: WS,
      datasourceId: DS,
      version: 2,
      fingerprint: "fp-2",
      tables: sampleTables(),
    });
    const files = await readdir(path.join(dir, "mocks", WS, DS));
    expect(files).toEqual(["v2.json"]);
  });
});

describe("fail-closed reads", () => {
  it("refuses a stale file whose fingerprint is not the fixtures one", async () => {
    await writeMockFile({
      workspaceId: WS,
      datasourceId: DS,
      version: 1,
      fingerprint: "fp-old",
      tables: sampleTables(),
    });
    await expect(readMockFile(WS, DS, 1, "fp-new")).rejects.toThrow(/stale/);
  });

  it("refuses a missing file with a rebuild sentence, never an empty set", async () => {
    await expect(readMockFile(WS, DS, 7, "fp-x")).rejects.toThrow(/rebuild/);
  });

  it("refuses corrupt JSON rather than serving it", async () => {
    const dest = resolveMockFilePath(WS, DS, 1);
    await writeMockFile({
      workspaceId: WS,
      datasourceId: DS,
      version: 1,
      fingerprint: "fp-1",
      tables: sampleTables(),
    });
    await writeFile(dest, "{not json");
    await expect(readMockFile(WS, DS, 1, "fp-1")).rejects.toThrow(/not valid JSON/);
  });
});

describe("path safety", () => {
  it("refuses traversal segments — the path is derived, never user input", async () => {
    await expect(
      writeMockFile({
        workspaceId: "../evil",
        datasourceId: DS,
        version: 1,
        fingerprint: "fp",
        tables: [],
      }),
    ).rejects.toThrow(/plain identifier/);
    await expect(readMockFile(WS, "..", 1)).rejects.toThrow(/plain identifier/);
  });

  it("refuses non-positive versions", () => {
    expect(() => resolveMockFilePath(WS, DS, 0)).toThrow(/positive integer/);
  });

  it("keeps a .gitignore in the mocks root so repo checkouts never commit the cache", async () => {
    await writeMockFile({
      workspaceId: WS,
      datasourceId: DS,
      version: 1,
      fingerprint: "fp-1",
      tables: sampleTables(),
    });
    const ignore = await readFile(path.join(dir, "mocks", ".gitignore"), "utf8");
    expect(ignore).toContain("*");
  });
});

describe("rootOwnerToAdopt — a root writer hands its writes to the mocks root's owner (I-229)", () => {
  it("as root, over a user-owned mocks root, adopts that user", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mocks-owner-"));
    const st = await stat(dir);
    const spy = vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);
    try {
      // The test user owns `dir` (a non-root uid), so a root writer adopts it.
      if (st.uid === 0) return;
      expect(await rootOwnerToAdopt(dir)).toEqual({ uid: st.uid, gid: st.gid });
    } finally {
      spy.mockRestore();
    }
  });
  it("CONTROL: not root → null (nothing to adopt, and chown would fail)", async () => {
    const spy = vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(1001);
    try {
      expect(await rootOwnerToAdopt(tmpdir())).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it("as root, over a missing root, is null rather than a throw", async () => {
    const spy = vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);
    try {
      expect(await rootOwnerToAdopt("/nonexistent/mocks-root")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
