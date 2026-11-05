/**
 * Installing a piece: one npm package of the `@activepieces` scope, at one exact version, into its own folder.
 *
 * A piece is third-party code that will be handed a customer's credential, so three rules:
 *   - only `@activepieces/piece-<name>` at an exact `x.y.z` (no ranges, no tags, no other scope);
 *   - npm runs with `--ignore-scripts` — nothing in the package or its dependencies executes at install time;
 *   - the installed package's integrity (from npm's lockfile) must equal the registry's, and the pinned value when one
 *     is given. A mismatch deletes the folder and refuses.
 *
 * Dependencies are installed too: a piece's bundle is not always self-contained (S3 0.8.1 declares `openpgp`).
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const NAME = /^@activepieces\/piece-[a-z0-9][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const REGISTRY = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";

export class InstallError extends Error {}

export function pieceDir(root, name, version) {
  return join(root, `${name.replace("@activepieces/", "")}@${version}`);
}

/** npm, through the egress proxy when one is given (the connector has no other way out). */
function npm(args, { cwd, proxyUrl, timeout = 180_000 }) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", npm_config_cache: process.env.npm_config_cache ?? "/tmp/npm-cache" };
  if (proxyUrl) Object.assign(env, { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, npm_config_proxy: proxyUrl, npm_config_https_proxy: proxyUrl });
  return run("npm", [...args, "--registry", REGISTRY], { cwd, env, timeout, maxBuffer: 16 << 20 });
}

/** The registry's record of one version: its integrity and licence. */
export async function registryVersion(name, version, { proxyUrl } = {}) {
  let out;
  try {
    out = await npm(["view", `${name}@${version}`, "dist.integrity", "license", "--json"], { cwd: "/tmp", proxyUrl, timeout: 60_000 });
  } catch (e) {
    const why = String(e.stderr || e.message);
    if (/E404|not in this registry/i.test(why)) throw new InstallError(`${name}@${version} is not on the registry`);
    throw new InstallError(`could not read ${name}@${version} from the registry: ${why.slice(-300)}`);
  }
  // ⚠ With one of the two fields absent (most pieces publish no licence), npm prints the other as a bare value, not
  // an object — so a string here IS the integrity.
  const parsed = out.stdout.trim() ? JSON.parse(out.stdout) : {};
  const body = typeof parsed === "string" ? { "dist.integrity": parsed } : parsed ?? {};
  const integrity = body["dist.integrity"];
  if (!integrity) throw new InstallError(`${name}@${version} is not on the registry`);
  return { integrity, license: typeof body.license === "string" ? body.license : null };
}

/**
 * Install (or re-verify) one piece. Returns where it lives and the integrity it was checked against.
 * `pinned` is the integrity a manifest recorded; when given, the registry must still serve exactly that.
 */
export async function installPiece(root, { name, version, integrity: pinned }, { proxyUrl } = {}) {
  if (!NAME.test(name ?? "")) throw new InstallError(`not an Activepieces piece name: ${JSON.stringify(name)}`);
  if (!VERSION.test(version ?? "")) throw new InstallError(`a piece is installed at an exact version (x.y.z), got ${JSON.stringify(version)}`);

  const reg = await registryVersion(name, version, { proxyUrl });
  if (pinned && pinned !== reg.integrity) {
    throw new InstallError(`${name}@${version}: the registry serves integrity ${reg.integrity}, the manifest pins ${pinned}`);
  }

  const dir = pieceDir(root, name, version);
  const installedIntegrity = readInstalledIntegrity(dir, name);
  if (installedIntegrity !== reg.integrity) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "piece-host", private: true }));
    try {
      await npm(["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", `${name}@${version}`], { cwd: dir, proxyUrl });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new InstallError(`npm could not install ${name}@${version}: ${String(e.stderr || e.message).slice(-600)}`);
    }
    const got = readInstalledIntegrity(dir, name);
    if (got !== reg.integrity) {
      rmSync(dir, { recursive: true, force: true });
      throw new InstallError(`${name}@${version}: installed integrity ${got} does not match the registry's ${reg.integrity}`);
    }
  }
  return { name, version, dir, integrity: reg.integrity, license: reg.license };
}

/**
 * After a restart: a piece already on disk comes back without the network, if what npm installed still carries the
 * integrity that was pinned when it was installed. Anything else must be installed again.
 */
export function verifyInstalled(root, { name, version, integrity, license = null }) {
  if (!NAME.test(name ?? "") || !VERSION.test(version ?? "")) throw new InstallError(`not a valid piece: ${name}@${version}`);
  const dir = pieceDir(root, name, version);
  const got = readInstalledIntegrity(dir, name);
  if (!integrity || got !== integrity) throw new InstallError(`${name}@${version} on disk does not match its pinned integrity`);
  return { name, version, dir, integrity, license };
}

function readInstalledIntegrity(dir, name) {
  const lock = join(dir, "package-lock.json");
  if (!existsSync(lock)) return null;
  try {
    return JSON.parse(readFileSync(lock, "utf8")).packages?.[`node_modules/${name}`]?.integrity ?? null;
  } catch {
    return null;
  }
}

/** The piece's main file, as text (for suggesting hosts) — read, never executed, in the parent. */
export function pieceSource(dir, name) {
  const pkgDir = join(dir, "node_modules", ...name.split("/"));
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  return readFileSync(join(pkgDir, pkg.main ?? "src/index.js"), "utf8");
}

/** Load an installed piece: the one export that is a Piece (has `actions()` and `displayName`). */
export function loadPiece(dir, name) {
  const req = createRequire(join(dir, "package.json"));
  const mod = req(name);
  const piece = Object.values(mod).find((v) => v && typeof v.actions === "function" && typeof v.displayName === "string");
  if (!piece) throw new InstallError(`${name} exports no piece`);
  return piece;
}
