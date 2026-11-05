/**
 * Mock engine registry — datasource type string to driver.
 *
 * postgres/postgresql run on the in-process PGlite driver. Every other type
 * (mysql, mariadb, and the inert free-form strings the introspector registry
 * already refuses) has no driver in v1 and throws `UnsupportedMockEngineError`
 * — an explicit refused test run with reason, never warn-and-read-prod.
 *
 * MySQL verdict (spike, 2026-09-13): CUT. There is no embedded-MySQL
 * equivalent of PGlite for Node — the only path is a go-mysql-server-style
 * sidecar: a second-language process per datasource with an ephemeral port,
 * a wire-protocol client, and no in-process teardown handle. A crash between
 * spawn and kill orphans the process, and the staging/promote/drop teardown
 * pattern the plan requires cannot be enforced from Node without a
 * supervisor. Until a managed sidecar exists, mysql/mariadb stay refused.
 */

import { pgliteDriver } from "./pglite.driver.js";
import { sqliteMockDriver } from "./sqlite.driver.js";
import { UnsupportedMockEngineError } from "./types.js";
import type { MockEngineDriver } from "./types.js";

const REGISTRY: Record<string, MockEngineDriver> = {
  postgres: pgliteDriver,
  postgresql: pgliteDriver,
  // SQLite mocks run in SQLite, through the same translator its production reads use.
  sqlite: sqliteMockDriver,
};

export function supportsMockType(datasourceType: string): boolean {
  return Boolean(REGISTRY[datasourceType.toLowerCase()]);
}

/** Unknown type throws `UnsupportedMockEngineError` — the caller refuses the run. */
export function driverFor(datasourceType: string): MockEngineDriver {
  const driver = REGISTRY[datasourceType.toLowerCase()];
  if (!driver) throw new UnsupportedMockEngineError(datasourceType);
  return driver;
}
