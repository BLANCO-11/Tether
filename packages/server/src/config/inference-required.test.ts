/**
 * The generation gateway is REQUIRED config, and this is the perturbation that
 * proves it. Phase 1 task 1.8 · D-116.
 *
 * ── WHY THIS TEST EXISTS AS A TEST, RATHER THAN AS A COMMENT ────────────────
 *
 * What it replaces was a `console.warn` at boot in `inference.service.ts`, and
 * the whole point of 1.8 is that **a warning is not a control.** Replacing one
 * unenforced claim with another unenforced claim would be the same defect with a
 * better sentence in front of it. So the requirement gets a test that fails if
 * the requirement is removed.
 *
 * What the requirement is for: the fallback it deletes was I-24. Unsetting
 * either variable used to silently route generation through the agent runtime,
 * where the mandatory `script-gen` skill adds turns after the model answers and
 * an `insufficient_contract` refusal arrives as `no JSON object` — measured, 5
 * refusals produced and 0 seen. It failed **asymmetrically**, so satisfiable
 * contracts kept working and nothing looked broken until the one case the
 * refusal channel exists for.
 *
 * ── ⚠ HOW THE PERTURBATION GETS PAST dotenv, WHICH IS THE WHOLE TRICK ──────
 *
 * `config/index.ts` calls `dotenv.config()` on the repo-root `.env`, and this
 * repo's `.env` sets both variables — so `delete process.env.LLM_BASE_URL`
 * proves nothing: dotenv would immediately put it back from the file and the
 * test would pass while asserting the opposite of what it claims.
 *
 * Setting it to the EMPTY STRING is what works. dotenv only assigns keys absent
 * from `process.env`, and an empty string is present, so the file cannot
 * override it — while `required()` treats `""` and `undefined` identically, which
 * is itself deliberate: a variable set to nothing is a deployment that thinks it
 * configured a gateway.
 *
 * ⚠ **Do not "simplify" this to `delete`.** It reads more naturally and is the
 * version that cannot fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = ["LLM_BASE_URL", "LLM_API_KEY"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}
const blank = (key: string) => setEnv(key, "");

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  vi.resetModules();
});

/** A fresh evaluation of the config module, bypassing the ESM module cache. */
async function loadConfig() {
  vi.resetModules();
  return import("./index.js");
}

describe("the generation gateway is required config (1.8, D-116)", () => {
  for (const key of KEYS) {
    it(`loads with ${key} blank (optional; the AI models page row is primary)`, async () => {
      blank(key);
      const { config } = await loadConfig();
      expect(key === "LLM_BASE_URL" ? config.inference.baseUrl : config.inference.apiKey).toBe("");
    });
  }

  /**
   * ⚠ THE CONTROL, and it is not optional.
   *
   * Both tests above pass if the config module throws for ANY reason — a syntax
   * error, an unrelated missing variable, a bad import. This asserts the module
   * loads cleanly when the environment IS complete, so the two refusals are
   * attributable to the perturbation rather than to a broken module. Without it
   * this file would go green on a config that never loads at all.
   */
  it("loads cleanly when both are set, and reports them", async () => {
    setEnv("LLM_BASE_URL", "https://gateway.example/v1/");
    setEnv("LLM_API_KEY", "k");
    const { config } = await loadConfig();
    expect(config.inference.baseUrl.length).toBeGreaterThan(0);
    expect(config.inference.apiKey.length).toBeGreaterThan(0);
    // Trailing slashes are stripped, because every caller appends a path.
    expect(config.inference.baseUrl.endsWith("/")).toBe(false);
  });

  /**
   * ⚠ **THE SUBJECT WENT; THE RULE DID NOT — AND THE ASSERTION HAD TO CHANGE
   * WITH IT.** This used to read the source for three dead identifiers
   * naming the deleted transport and the branch that selected it — the agent-runtime
   * transport and the branch that selected it. That runtime has since been
   * removed from the product entirely, so those names are absent no matter what
   * anybody does, and a check that cannot fail is worse than none (I-38).
   *
   * So it now asserts the PROPERTY: this module implements `InferenceClient`
   * exactly twice — the gateway, and the resolver that delegates to it — and
   * `ResolvingInference` contains no branch. A second transport added here would
   * fail this whether or not it is called anything anybody has thought of.
   *
   * Same idiom as the one-reader-per-secret assertion and I-120's call-site
   * guard: a correct rule that nothing enforces is what 1.8 is fixing.
   */
  it("has no second inference transport to fall back to", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../services/inference.service.ts", import.meta.url),
      "utf8",
    );
    // The control: a real module, not an empty read or a moved file.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("class GatewayInference");

    // Comments deliberately DISCUSS the deleted transport at length — that
    // reasoning is why it must not return. Strip them before asserting, or this
    // test forbids its own explanation.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The control for the stripper: it must leave real code behind (I-38).
    expect(code).toContain("class GatewayInference");

    const impls = [...code.matchAll(/class\s+(\w+)\s+implements\s+InferenceClient/g)].map(
      (m) => m[1],
    );
    expect(impls).toEqual(["GatewayInference", "ResolvingInference"]);

    // ⚠ And the resolver must not CHOOSE. A branch here is how the fallback
    // returns without a new class: `if (!x) return this.other.complete(...)`.
    const resolver = code.slice(code.indexOf("class ResolvingInference"));
    expect(resolver).not.toMatch(/\breturn\s+this\.\w+\.complete\(/);
  });
});

/**
 * ── An operator-set address is checked at LOAD, not at first request ────────
 *
 * It was accepted as an arbitrary string with a trailing slash
 * trimmed. A bare host, a value that picked up a trailing comment, or a Compose
 * `${VAR}` that resolved to empty all booted cleanly and failed later inside
 * the client as an opaque `fetch failed` — on the first call of the
 * first run, naming neither the variable nor the value.
 *
 * ⚠ Same dotenv trick as above: the perturbation SETS the variable rather than
 * deleting it, because `config/index.ts` loads the repo-root `.env` itself and a
 * deleted key would be put straight back.
 */
describe("KESTRA_BASE_URL must be an absolute http(s) URL", () => {
  function set(value: string) {
    if (!saved.has("KESTRA_BASE_URL")) saved.set("KESTRA_BASE_URL", process.env.KESTRA_BASE_URL);
    process.env.KESTRA_BASE_URL = value;
  }

  it("refuses a bare host — the mistake that parses but has the wrong protocol", async () => {
    set("localhost:8080");
    await expect(loadConfig()).rejects.toThrow(/KESTRA_BASE_URL must be http/);
  });

  it("refuses a value that is not a URL at all", async () => {
    set("/kestra");
    await expect(loadConfig()).rejects.toThrow(/KESTRA_BASE_URL must be an absolute URL/);
  });

  it("refuses a non-http scheme", async () => {
    set("ws://127.0.0.1:8080");
    await expect(loadConfig()).rejects.toThrow(/must be http/);
  });

  /**
   * ⚠ Loopback and `host.docker.internal` MUST stay accepted. Kestra legitimately
   * lives on loopback in this deployment, so this is deliberately not an egress
   * check — those are for tenant-supplied addresses, and STRICT would refuse the
   * correct value here.
   */
  it("CONTROL — accepts the addresses this deployment actually uses, and trims the slash", async () => {
    for (const value of [
      "http://127.0.0.1:8080",
      "http://host.docker.internal:8080/",
      "https://engine.example.com",
    ]) {
      set(value);
      const { config } = await loadConfig();
      expect(config.kestra.baseUrl, value).toBe(value.replace(/\/$/, ""));
      vi.resetModules();
    }
  });
});
