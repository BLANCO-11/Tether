/**
 * Which environment an execution is running in — the ONE function that decides.
 * DECISIONS.md D-52 · ISSUES.md I-54
 *
 * ── Why this is a namespace read and not a parameter ─────────────────────────
 *
 * A draft run must read fixtures and a live run must read production, and the
 * temptation is to pass that decision down as an argument or a flag. Every such
 * shape has the same hole: whoever can set the argument can point a draft run at
 * production, and there are more callers than there are reviewers.
 *
 * So the selector is the execution's Kestra namespace:
 *
 *   foundry.<tenant>.<ws>.draft  →  draft
 *   foundry.<tenant>.<ws>        →  live
 *
 * and the namespace on the row was written by `POST /api/executions/begin` from
 * **Kestra's own record of the execution** — never from the request body, which
 * is I-07's whole point. A flow cannot lie about where it lives, so a step
 * callback cannot lie about which data it should be reading.
 *
 * ⚠ Fails CLOSED. An execution row that cannot be read, or a namespace that does
 * not parse, resolves to `draft`. The wrong answer in that direction reads
 * fixtures on a production run — a wrong result, loudly, on a run somebody is
 * watching. The other direction silently ships tenant rows to a model during
 * development, which is the exposure this stage exists to close.
 */
import { config } from "../config/index.js";
import { flowExecutionRepo } from "../repositories/flow-execution.repo.js";

export type ExecutionEnv = "draft" | "live";

export interface ParsedNamespace {
  env: ExecutionEnv;
  tenantSlug: string;
  slug: string;
}

/**
 * Take a namespace apart: `<prefix>.<tenant>.<slug>[.draft]`.
 *
 * ⚠ **Counted against the configured prefix, not by looking at the last
 * segment**, and the difference is a real bug this replaced. The old rule was
 * *"ends in `draft` ⇒ draft"* — so a workspace whose slug is literally `draft`
 * has the LIVE namespace `foundry.default.draft`, which that rule read as a
 * draft run. A production execution would then have read the sandbox: the wrong
 * data, silently, on the one kind of run where it matters.
 *
 * A live namespace has exactly `prefix + 2` segments and a draft one `prefix + 3`
 * ending in `draft`, so counting is unambiguous where suffix-matching is not.
 * Found by `execution-env.test.ts`.
 *
 * Returns null for anything that is not one of those two shapes, including a
 * namespace under a different prefix.
 */
export function parseNamespace(namespace: string | null | undefined): ParsedNamespace | null {
  if (!namespace) return null;
  const parts = namespace.split(".");
  const prefix = config.kestra.namespacePrefix.split(".");
  const isDraft = parts.length === prefix.length + 3 && parts[parts.length - 1] === "draft";
  const isLive = parts.length === prefix.length + 2;
  if (!isDraft && !isLive) return null;
  const body = isDraft ? parts.slice(0, -1) : parts;
  if (body.slice(0, prefix.length).join(".") !== config.kestra.namespacePrefix) return null;
  return {
    env: isDraft ? "draft" : "live",
    tenantSlug: body[body.length - 2]!,
    slug: body[body.length - 1]!,
  };
}

/** `foundry.acme.hr.draft` → draft · `foundry.acme.hr` → live · anything else → draft. */
export function envForNamespace(namespace: string | null | undefined): ExecutionEnv {
  return parseNamespace(namespace)?.env ?? "draft";
}

/**
 * The environment for a step callback, resolved from its execution.
 *
 * Called once per step callback, on a row already in the request path — the
 * pointer row and the budget check both read it — so this costs one indexed
 * lookup and is not worth caching. A cache here would be a place for a stale
 * `live` to survive a redeploy.
 */
export async function envForExecution(flowExecutionId: string): Promise<ExecutionEnv> {
  try {
    const row = await flowExecutionRepo.get(flowExecutionId);
    return envForNamespace(row?.kestraNamespace);
  } catch (e) {
    console.warn(
      `[execution-env] could not resolve the environment for execution ${flowExecutionId}; ` +
        `treating it as DRAFT: ${(e as Error).message}`,
    );
    return "draft";
  }
}
