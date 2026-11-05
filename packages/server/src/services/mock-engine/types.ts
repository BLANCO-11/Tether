/**
 * Mock engine slot — the interface every test-data driver implements.
 *
 * A driver is an isolated, in-process database loaded with generated fixture
 * rows. The execution seam (`runSqlBatch`) picks a driver by datasource type,
 * loads `MockTable`s built FROM `datasource_fixtures.rows_json`, runs the
 * frozen step SQL through it, and tears it down. Drivers enforce read-only
 * themselves (write-reject, statement timeout, row caps) — the live read-only
 * role is not the control here.
 *
 * Unknown datasource types are a hard refuse upstream: `driverFor` throws
 * `UnsupportedMockEngineError`, and the caller turns that into a refused test
 * run with reason — never a silent read of production.
 */

export interface MockColumn {
  name: string;
  type: string;
}

export interface MockTable {
  name: string;
  columns: MockColumn[];
  rows: Record<string, unknown>[];
}

/**
 * Opaque handle to a loaded engine instance. The fingerprint is the build
 * fingerprint the instance was loaded from, so callers can gate on drift
 * without reopening the driver. Downcast only inside the owning driver.
 */
export interface MockHandle {
  readonly driver: string;
  readonly workspaceId: string;
  readonly datasourceId: string;
  readonly fingerprint: string;
  /** Driver-internal instance key (worker id). Opaque to callers; safe to log. */
  readonly handleId: string;
}

export interface MockEngineDriver {
  readonly dialect: string;
  prepare(
    workspaceId: string,
    datasourceId: string,
    fingerprint: string,
    tables: MockTable[],
  ): Promise<MockHandle>;
  query(
    handle: MockHandle,
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  destroy(handle: MockHandle): Promise<void>;
}

/** No driver exists for this datasource type — refuse the test run, loudly. */
export class UnsupportedMockEngineError extends Error {
  readonly code = "mock_engine_unsupported";
  readonly datasourceType: string;

  constructor(datasourceType: string) {
    super(
      `no mock engine for datasource type "${datasourceType}" — test runs against this ` +
        `datasource are refused. Rebuild it against a supported (postgres or sqlite) datasource, ` +
        `or run with an explicit production opt-in.`,
    );
    this.name = "UnsupportedMockEngineError";
    this.datasourceType = datasourceType;
  }
}

/** The step SQL tried to write — refused before anything executed. */
export class MockEngineWriteRejectedError extends Error {
  readonly code = "mock_write_rejected";

  constructor(detail: string) {
    super(`mock engine refused a non-read statement: ${detail}`);
    this.name = "MockEngineWriteRejectedError";
  }
}

/** The step SQL outran the engine statement timeout — refused, nothing returned. */
export class MockEngineTimeoutError extends Error {
  readonly code = "mock_statement_timeout";

  constructor(timeoutMs: number) {
    super(`mock engine statement timeout after ${timeoutMs}ms — nothing was returned`);
    this.name = "MockEngineTimeoutError";
  }
}
