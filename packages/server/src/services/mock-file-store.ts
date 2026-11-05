/**
 * Mock file store — the derived, rebuildable projection of `datasource_fixtures.rows_json`.
 *
 * ── Authority ────────────────────────────────────────────────────────────────
 * `datasource_fixtures.rows_json` is authoritative; a JSON mock file is a cache
 * keyed by fingerprint, never a second source of truth. Every file is built FROM
 * a fixtures row, and a file whose fingerprint does not match the row it claims
 * to project fails closed on read — a stale cache must refuse, never serve.
 *
 * ── Layout ───────────────────────────────────────────────────────────────────
 * `<DATA_DIR>/mocks/<workspaceId>/<datasourceId>/v<N>.json`
 * (`DATA_DIR` = `$MOCK_DATA_DIR` ?? `$DATA_DIR` ?? `<repo>/data`).
 * Segments are validated identifiers (uuids pass); the path is derived from DB
 * ids, never from user input — a `..` or `/` in any segment refuses rather than
 * escaping the base.
 *
 * ── Durability ───────────────────────────────────────────────────────────────
 * Files are mode 0600 (owner-only: they hold synthetic rows shaped like tenant
 * data), written atomically (tmp file in the same directory + rename, so a
 * crash never leaves a half-written version), and the `mocks/` root carries a
 * `.gitignore` (`*`, best-effort) so a `git add -A` inside the repo default can
 * never commit them as a second layer behind the 0600.
 *
 * ── Ownership (I-229, D-269) ─────────────────────────────────────────────────
 * `mocks/` is a BIND mount shared by the server container (root) and the host
 * provisioners (`demo:seed` & co, the host user). A 0700 directory the server
 * creates as root is one the host can then never write into — the named-volume
 * split this replaced, by another route. So a root writer hands every directory
 * and file it writes to the OWNER OF THE `mocks/` ROOT: no uid to configure, and
 * correct on whatever host the checkout lives on. A non-root writer changes
 * nothing (it already is that user, or cannot chown anyway).
 */

import { chmod, chown, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MockFileColumn {
  name: string;
  type: string;
}

export interface MockFileTable {
  /** The fixture key — `"<schema>.<table>"` or `"<table>"`, matching `rows_json`. */
  name: string;
  columns: MockFileColumn[];
  rows: Array<Record<string, unknown>>;
}

export interface MockFileEnvelope {
  version: number;
  fingerprint: string;
  tables: MockFileTable[];
}

export interface WriteMockFileInput {
  workspaceId: string;
  datasourceId: string;
  version: number;
  fingerprint: string;
  tables: MockFileTable[];
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(value: string, what: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`refusing mock file path: ${what} is not a plain identifier`);
  }
}

/** Operator override first; repo-local `data/` only as the last resort default. */
export function resolveMockBaseDir(): string {
  const override = process.env.MOCK_DATA_DIR ?? process.env.DATA_DIR;
  if (override && override.trim()) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..", "data");
}

export function resolveMockFilePath(
  workspaceId: string,
  datasourceId: string,
  version: number,
): string {
  assertSafeId(workspaceId, "workspaceId");
  assertSafeId(datasourceId, "datasourceId");
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`refusing mock file path: version must be a positive integer, got ${version}`);
  }
  return path.join(resolveMockBaseDir(), "mocks", workspaceId, datasourceId, `v${version}.json`);
}

function assertEnvelope(value: unknown): asserts value is MockFileEnvelope {
  const e = value as MockFileEnvelope;
  if (typeof e !== "object" || e === null) throw new Error("mock file is not a JSON object");
  if (!Number.isInteger(e.version) || e.version < 1) throw new Error("mock file has no valid version");
  if (typeof e.fingerprint !== "string" || !e.fingerprint) {
    throw new Error("mock file has no fingerprint");
  }
  if (!Array.isArray(e.tables)) throw new Error("mock file has no tables array");
  for (const t of e.tables) {
    if (typeof t?.name !== "string" || !t.name) throw new Error("mock file has a table with no name");
    if (!Array.isArray(t.columns) || !Array.isArray(t.rows)) {
      throw new Error(`mock file table "${t.name}" has no columns/rows arrays`);
    }
  }
}

/**
 * The owner a ROOT writer must hand its writes to: the `mocks/` root's, when that
 * is not root. `null` when this process is not root (nothing to adopt, and chown
 * would fail) or the root is itself root-owned (a named volume, or no host).
 */
export async function rootOwnerToAdopt(mocksRoot: string): Promise<{ uid: number; gid: number } | null> {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  const st = await stat(mocksRoot).catch(() => null);
  if (!st || st.uid === 0) return null;
  return { uid: st.uid, gid: st.gid };
}

/**
 * Write the file for one fixtures version. Directories are 0700, the file is
 * 0600, and the publish is a same-directory rename — readers never see a
 * partial write.
 */
export async function writeMockFile(input: WriteMockFileInput): Promise<string> {
  const { workspaceId, datasourceId, version, fingerprint, tables } = input;
  if (!fingerprint) throw new Error("refusing mock file write: fingerprint is required");
  const dest = resolveMockFilePath(workspaceId, datasourceId, version);
  const dir = path.dirname(dest);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const mocksRoot = path.join(resolveMockBaseDir(), "mocks");
  const owner = await rootOwnerToAdopt(mocksRoot);
  if (owner) for (const d of [path.dirname(dir), dir]) await chown(d, owner.uid, owner.gid);

  // Second layer behind the 0600: never commit the projection when the base
  // dir lives inside the repo checkout. Best-effort — a build must not fail
  // because a gitignore could not be written.
  await writeFile(path.join(mocksRoot, ".gitignore"), "*\n!.gitignore\n", { mode: 0o600 }).catch(
    () => {},
  );

  const body = JSON.stringify({ version, fingerprint, tables } satisfies MockFileEnvelope);
  const tmp = path.join(
    dir,
    `v${version}.json.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`,
  );
  try {
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => {});
    if (owner) await chown(tmp, owner.uid, owner.gid);
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return dest;
}

/**
 * Read one file back, failing closed: unparseable JSON, a malformed envelope,
 * or a fingerprint that is not the expected one all throw — never an empty
 * table set that reads as "no data".
 */
export async function readMockFile(
  workspaceId: string,
  datasourceId: string,
  version: number,
  expectedFingerprint?: string,
): Promise<MockFileEnvelope> {
  const dest = resolveMockFilePath(workspaceId, datasourceId, version);
  let raw: string;
  try {
    raw = await readFile(dest, "utf8");
  } catch {
    throw new Error(
      `mock file v${version} for datasource ${datasourceId} is missing — rebuild it before running tests`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `mock file v${version} for datasource ${datasourceId} is not valid JSON — refusing to serve a corrupt cache`,
    );
  }
  assertEnvelope(parsed);
  if (parsed.version !== version) {
    throw new Error(
      `mock file version mismatch: path says v${version}, file says v${parsed.version} — refusing to serve a misfiled cache`,
    );
  }
  if (expectedFingerprint && parsed.fingerprint !== expectedFingerprint) {
    throw new Error(
      `mock file v${version} for datasource ${datasourceId} is stale (file ${parsed.fingerprint} != fixtures ${expectedFingerprint}) — rebuild it before running tests`,
    );
  }
  return parsed;
}

/** Best-effort removal of one version's file (failed-build cleanup). Never throws. */
export async function deleteMockFile(
  workspaceId: string,
  datasourceId: string,
  version: number,
): Promise<void> {
  try {
    await rm(resolveMockFilePath(workspaceId, datasourceId, version), { force: true });
  } catch {
    // best effort — a leftover file for a failed version is untidy, not dangerous
  }
}
