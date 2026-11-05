/**
 * The one place `node:sqlite` is loaded.
 *
 * ⚠ Through `createRequire`, not `import`: vitest 2's Vite does not know
 * `node:sqlite` is a builtin (it arrived in Node 22.5, after Vite 5's list was
 * written), strips the prefix, and fails to load a package called `sqlite`.
 * The type import is erased at compile time, so every caller is still typed.
 * Built into Node — no native dependency, nothing to compile in the image.
 */
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = NodeSqlite.DatabaseSync;
