import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Mock-data execution seam (plan §4) — `runSqlBatch` routing.
 *
 *   draft + no override + READY mock → mock engine (`readFrom: "mock"`),
 *     and the production DSN is never decrypted;
 *   draft + missing/building/failed mock → hard 409 refusal with reason;
 *   draft + admin override → production + `usedProductionData: true`;
 *   live (+ override or not) → production, override ignored;
 *   unknown engine type → 501; write-shaped frozen SQL → 400.
 *
 * `checkSqlShape` is REAL (pure) — the 400 case has teeth. Everything that
 * dials (pg), decrypts, or reads the database is mocked. No prod touch.
 */

const resolveRef = vi.fn();
const listQueriesByWorkspace = vi.fn();
const getDatasourceByName = vi.fn();
const fixtureLatest = vi.fn();
const getOperationByRef = vi.fn();
const listOperationsByWorkspace = vi.fn();
const decryptMock = vi.fn((s: string) => `decrypted:${s}`);
const driverForMock = vi.fn();
const prepareMock = vi.fn();
const queryMock = vi.fn();
const destroyMock = vi.fn();

vi.mock("../repositories/datasource-query.repo.js", () => ({
  datasourceQueryRepo: {
    resolveRef: (...a: unknown[]) => resolveRef(...a),
    listByWorkspace: (...a: unknown[]) => listQueriesByWorkspace(...a),
  },
}));
vi.mock("../repositories/datasource.repo.js", () => ({
  datasourceRepo: { getByName: (...a: unknown[]) => getDatasourceByName(...a) },
}));
vi.mock("../repositories/datasource-fixture.repo.js", () => ({
  datasourceFixtureRepo: { latest: (...a: unknown[]) => fixtureLatest(...a) },
}));
vi.mock("../repositories/db-operation.repo.js", () => ({
  dbOperationRepo: {
    getByRef: (...a: unknown[]) => getOperationByRef(...a),
    listByWorkspace: (...a: unknown[]) => listOperationsByWorkspace(...a),
  },
}));
vi.mock("../utils/encryptor.js", () => ({ decrypt: (s: string) => decryptMock(s) }));
vi.mock("./mock-engine/registry.js", () => ({
  driverFor: (...a: unknown[]) => driverForMock(...a),
  supportsMockType: () => true,
}));
vi.mock("../repositories/tool.repo.js", () => ({
  toolRepo: { listByWorkspace: vi.fn(async () => []) },
}));
vi.mock("../repositories/workspace-secret.repo.js", () => ({
  workspaceSecretRepo: { getByName: vi.fn(async () => undefined) },
}));
vi.mock("./workspace-secret.service.js", () => ({
  shadowedSecretCollisions: vi.fn(async () => []),
}));
/**
 * ⚠ **The mock FILE is where the column types come from (2026-09-18).** It is
 * mocked here rather than written to disk because this suite is about routing;
 * `step-mock-tables.test.ts` owns what the shape does, and `mock-file-store`'s
 * own suite owns reading it. What this file must still prove is that a MISSING
 * shape refuses and never falls through to production — the test below.
 */
const readMockFileMock = vi.fn();
vi.mock("./mock-file-store.js", () => ({
  readMockFile: (...a: unknown[]) => readMockFileMock(...a),
}));

const pgQueryMock = vi.fn();
const pgConnectMock = vi.fn();
const pgEndMock = vi.fn();
let pgSeenConnectionString: string | undefined;
vi.mock("../db/index.js", () => ({ db: {}, pool: {}, schema: {} }));
vi.mock("pg", () => ({
  default: {
    Client: class {
      constructor(opts: { connectionString: string }) {
        pgSeenConnectionString = opts.connectionString;
      }
      connect = (...a: unknown[]) => pgConnectMock(...a);
      query = (...a: unknown[]) => pgQueryMock(...a);
      end = (...a: unknown[]) => pgEndMock(...a);
    },
    Pool: class {
      query = vi.fn();
      end = vi.fn();
    },
  },
}));
const { stepExecutionService, StepError } = await import("./step-execution.service.js");

const DS = {
  id: "ds-1",
  workspaceId: "ws-1",
  name: "hr_demo",
  type: "postgres",
  connectionStringEnc: "enc:prod-dsn",
};
const STORED_QUERY = {
  sqlText: "SELECT id FROM users WHERE period = $1",
  paramOrder: ["period"],
  paramsSchema: { period: { type: "string", required: true } },
};
const READY_FIXTURE = {
  mockStatus: "ready",
  mockError: null,
  version: 3,
  schemaFingerprint: "fp1",
  rowsJson: { "public.users": [{ id: 1, name: "Ada" }] },
};
/**
 * What the mock FILE declares — the same tables and columns as the fixture's
 * rows, with their real types. ⚠ `id` is `bigint` and `name` is `varchar(64)`
 * deliberately: neither is what guessing at `{id: 1, name: "Ada"}` would say,
 * so the assertion below fails if anything ever infers again.
 */
const DECLARED_TABLES = [
  {
    name: "public.users",
    columns: [
      { name: "id", type: "bigint" },
      { name: "name", type: "varchar(64)" },
    ],
    rows: [],
  },
];
const batch = (over: Record<string, unknown> = {}) => ({
  ref: "hr_demo.active_users",
  params: [{ period: "2026-06" }],
  ...over,
});

beforeEach(() => {
  resolveRef.mockResolvedValue({ query: STORED_QUERY, datasource: DS });
  listQueriesByWorkspace.mockResolvedValue([]);
  getDatasourceByName.mockResolvedValue(DS);
  fixtureLatest.mockResolvedValue(READY_FIXTURE);
  readMockFileMock.mockResolvedValue({ version: 3, fingerprint: "fp1", tables: DECLARED_TABLES });
  getOperationByRef.mockResolvedValue(undefined);
  listOperationsByWorkspace.mockResolvedValue([]);
  decryptMock.mockClear();
  decryptMock.mockImplementation((s: string) => `decrypted:${s}`);
  driverForMock.mockReturnValue({
    dialect: "postgres",
    prepare: prepareMock,
    query: queryMock,
    destroy: destroyMock,
  });
  prepareMock.mockResolvedValue({ driver: "fake", workspaceId: "ws-1", datasourceId: "ds-1", fingerprint: "fp1" });
  queryMock.mockResolvedValue({ rows: [{ id: 1, name: "Ada" }] });
  destroyMock.mockResolvedValue(undefined);
  pgSeenConnectionString = undefined;
  pgConnectMock.mockResolvedValue(undefined);
  pgEndMock.mockResolvedValue(undefined);
  pgQueryMock.mockResolvedValue({ rows: [{ id: 9 }] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("draft without override reads the mock and never decrypts prod", () => {
  it("returns mock rows with readFrom mock", async () => {
    const out = await stepExecutionService.datasource("ws-1", batch(), "draft", {
      workspaceId: "ws-1",
    });
    expect(out.readFrom).toBe("mock");
    expect(out.results).toEqual([{ ok: true, data: [{ id: 1, name: "Ada" }] }]);
    expect(out.usedProductionData).toBeUndefined();
    expect(out.warnings.join(" ")).toMatch(/MOCK data/);
  });

  it("never decrypts the production DSN on the mock path", async () => {
    await stepExecutionService.datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(pgConnectMock).not.toHaveBeenCalled();
  });

  it("⚠ loads rows from rows_json and TYPES from the declared shape, never from the values", async () => {
    await stepExecutionService.datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" });
    expect(prepareMock).toHaveBeenCalledWith(
      "ws-1",
      "ds-1",
      "fp1",
      [
        {
          name: "users",
          columns: [{ name: "id", type: "bigint" }, { name: "name", type: "varchar(64)" }],
          rows: [{ id: 1, name: "Ada" }],
        },
      ],
    );
  });

  it("asks for the file by the fixture's OWN version and fingerprint", async () => {
    // A file that does not match is stale, and `readMockFile` refuses it — but
    // only if it is asked the right question.
    await stepExecutionService.datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" });
    expect(readMockFileMock).toHaveBeenCalledWith("ws-1", "ds-1", 3, "fp1");
  });

  it("runs the stored statement with positional params", async () => {
    await stepExecutionService.datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" });
    expect(queryMock).toHaveBeenCalledWith(expect.anything(), STORED_QUERY.sqlText, ["2026-06"]);
  });

  it("runs frozen SQL verbatim when the step carries it", async () => {
    const frozen = "SELECT name FROM users WHERE period = $1";
    await stepExecutionService.datasource("ws-1", batch({ sql: frozen }), "draft", {
      workspaceId: "ws-1",
    });
    expect(queryMock).toHaveBeenCalledWith(expect.anything(), frozen, ["2026-06"]);
  });

  it("tears the engine down on success", async () => {
    await stepExecutionService.datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});

describe("draft without a usable mock hard-refuses, never reading prod", () => {
  it.each([
    ["no fixture row", undefined, /no mock data/],
    ["still building", { ...READY_FIXTURE, mockStatus: "building" }, /still building/],
    ["failed build names its reason", { ...READY_FIXTURE, mockStatus: "failed", mockError: "taxonomy boom" }, /taxonomy boom/],
  ])("%s → 409", async (_name, fixture, message) => {
    fixtureLatest.mockResolvedValue(fixture);
    const err = await stepExecutionService
      .datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(message);
    expect(err.message).toMatch(/refused rather than reading production/);
    expect(decryptMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("⚠ a mock with no DECLARED shape → 409, and prod is still never dialled", async () => {
    // The 2026-09-18 fix. Guessing the types from JSONB values produced a TEXT
    // column for every timestamp, so the alternative to refusing here is a run
    // that either errors on an operator or answers wrongly and looks green.
    readMockFileMock.mockRejectedValue(new Error("mock file v3 for datasource ds-1 is missing"));
    const err = await stepExecutionService
      .datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/does not declare its column types/);
    expect(err.message).toMatch(/is missing/);
    expect(err.message).toMatch(/rather than reading production/);
    expect(decryptMock).not.toHaveBeenCalled();
    expect(pgConnectMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("unknown engine type → 501", async () => {
    resolveRef.mockResolvedValue({ query: STORED_QUERY, datasource: { ...DS, type: "snowflake" } });
    const { UnsupportedMockEngineError } = await import("./mock-engine/types.js");
    driverForMock.mockImplementation(() => {
      throw new UnsupportedMockEngineError("snowflake");
    });
    const err = await stepExecutionService
      .datasource("ws-1", batch(), "draft", { workspaceId: "ws-1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.status).toBe(501);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("write-shaped frozen SQL → 400 before anything executes", async () => {
    const err = await stepExecutionService
      .datasource("ws-1", batch({ sql: "DELETE FROM users WHERE period = $1" }), "draft", {
        workspaceId: "ws-1",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.status).toBe(400);
    expect(decryptMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });
});

describe("override and live paths", () => {
  it("draft + override reads production with the flag, decrypting once", async () => {
    const out = await stepExecutionService.datasource("ws-1", batch(), "draft", {
      workspaceId: "ws-1",
      useProdOverride: true,
    });
    expect(out.readFrom).toBe("production");
    expect(out.usedProductionData).toBe(true);
    expect(out.results).toEqual([{ ok: true, data: [{ id: 9 }] }]);
    expect(decryptMock).toHaveBeenCalledTimes(1);
    expect(pgSeenConnectionString).toBe("decrypted:enc:prod-dsn");
    expect(prepareMock).not.toHaveBeenCalled();
    expect(out.warnings.join(" ")).toMatch(/explicit opt-in/);
  });

  it("live ignores the override: production without the flag", async () => {
    const out = await stepExecutionService.datasource("ws-1", batch(), "live", {
      workspaceId: "ws-1",
      useProdOverride: true,
    });
    expect(out.readFrom).toBe("production");
    expect(out.usedProductionData).toBeUndefined();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("live without override reads production without the flag", async () => {
    const out = await stepExecutionService.datasource("ws-1", batch(), "live", {
      workspaceId: "ws-1",
    });
    expect(out.readFrom).toBe("production");
    expect(out.usedProductionData).toBeUndefined();
  });

  it("override with no linked credential refuses instead of decrypting null", async () => {
    resolveRef.mockResolvedValue({
      query: STORED_QUERY,
      datasource: { ...DS, connectionStringEnc: null },
    });
    const err = await stepExecutionService
      .datasource("ws-1", batch(), "draft", { workspaceId: "ws-1", useProdOverride: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.status).toBe(409);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("operation steps take the same branches", async () => {
    getOperationByRef.mockResolvedValue({
      operation: { specJson: {}, compiledSql: "SELECT 1", paramsSchema: {} },
      datasource: DS,
    });
    const out = await stepExecutionService.operation(
      "ws-1",
      { ref: "hr_demo.headcount", params: [{}] },
      "draft",
      { workspaceId: "ws-1" },
    );
    expect(out.readFrom).toBe("mock");
    expect(decryptMock).not.toHaveBeenCalled();
  });
});
