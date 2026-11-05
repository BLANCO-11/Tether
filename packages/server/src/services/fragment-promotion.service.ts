import type { SQL } from "drizzle-orm";
import crypto from "node:crypto";
import { flowRepo } from "../repositories/flow.repo.js";
import type { StepContract, ContractField } from "./step-contract.service.js";
import type { CodeStep } from "./flow-compiler.service.js";

/**
 * **Fragment promotion tracking** — phase 6.5.
 * archive/kestra-migration/04-generation-model.md §5.1 "The graduation loop"
 *
 * > *"A fragment appearing across many flows is a candidate to become a
 * > pre-written tool — the same path by which a prompt-run graduates into a flow.
 * > Track recurring fragments; each one promoted removes a class of generation
 * > error permanently."*
 *
 * That last clause is why this is worth building rather than nice to have. Every
 * `code` step is a generation, and generation is the one part of this system with
 * a measured first-pass failure rate. Promoting a recurring fragment to a
 * hand-written tool does not make it *more likely* to be right; it takes it out
 * of the generated set altogether. §5.1's other observation — *"code-step
 * frequency is inversely proportional to manifest coverage"* — is the same
 * statement from the other end, and this service is how you find out which gap in
 * the manifest to close first.
 *
 * ── It is a SURFACING HEURISTIC, and must never be described as a detector ────
 *
 * Nothing here can tell that two fragments do the same job. What it can do is
 * mechanical and stated exactly:
 *
 *   * group `code` steps by their contract's **interface** — input and output
 *     field names and types. Two steps that agree on that agree on something
 *     real: they are interchangeable at the boundary.
 *   * report every distinct **purpose** in a group verbatim, and never merge or
 *     summarise them, because the purpose is the only evidence of intent and a
 *     human is the one judging it.
 *   * report how many distinct fragments the group produced. A group where three
 *     flows generated **byte-identical** code is the strongest signal available
 *     and it needs no interpretation; a group with three different bodies may
 *     still be three different jobs sharing a shape.
 *
 * The failure mode to keep in mind is a false positive that reads as certainty:
 * `{rows: array<object>} → {result: array<object>}` is the shape of an enormous
 * number of unrelated steps. So a candidate carries its *evidence* rather than a
 * score, `shapeOnly` is set when the shape is the only thing that matched, and
 * the ranking exists to order a list a person reads — not to decide anything.
 */

export interface PromotionOccurrence {
  flowId: string;
  flowName: string;
  revision: number;
  stepId: string;
  purpose: string;
  /** Digest of the generated body, whitespace- and comment-normalised. */
  codeDigest: string | null;
}

export interface PromotionCandidate {
  /** The contract interface these steps share. Stable and comparable. */
  shapeKey: string;
  /** The same interface, rendered the way a fragment prompt renders it. */
  signature: string;
  /** How many DISTINCT flows contain a step with this interface. The headline. */
  flowCount: number;
  occurrences: PromotionOccurrence[];
  /** Every distinct purpose in the group, verbatim and unmerged. */
  purposes: string[];
  /**
   * How many distinct fragment bodies the group produced. `1` across several
   * flows means the same code was generated more than once from the same
   * contract, which is a promotion candidate with no judgement required.
   */
  distinctBodies: number;
  /**
   * True when the interface matched but the purposes did not agree at all —
   * i.e. the only evidence is the shape. Reported so a UI can say so instead of
   * presenting a coincidence as a finding.
   */
  shapeOnly: boolean;
}

/** `name:type` / `name:array<items>` — the field as it affects a caller. */
function fieldKey(f: ContractField): string {
  return `${f.name}:${f.type === "array" && f.items ? `array<${f.items}>` : f.type}`;
}

/**
 * The grouping key.
 *
 * Inputs and outputs are SORTED, because a contract's fields are named and two
 * drafts of the same step must not land in different groups over declaration
 * order. Descriptions are excluded — they are prose written by a model and will
 * differ wording-wise for identical steps, so including them would make the
 * grouping never fire.
 */
export function shapeKeyOf(contract: StepContract): string {
  const ins = contract.input.map(fieldKey).sort().join(",");
  const outs = contract.output.map(fieldKey).sort().join(",");
  return `in(${ins})->out(${outs})`;
}

/**
 * Normalise a fragment body before digesting it, so "the same code" is not
 * defeated by a blank line.
 *
 * Comments go, indentation is collapsed, blank lines are dropped. Deliberately
 * NOT a parse: this feeds a count that a human reads, and a normaliser that
 * needed to be correct about Python syntax would be a much bigger thing than the
 * signal justifies. It errs towards reporting bodies as *different*, which is the
 * safe direction — an inflated `distinctBodies` understates a candidate rather
 * than inventing one.
 */
export function normaliseBody(code: string): string {
  return code
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

function digest(code: string): string {
  return crypto.createHash("sha256").update(normaliseBody(code)).digest("hex").slice(0, 16);
}

function renderSignature(contract: StepContract): string {
  const render = (fs: ContractField[]) => (fs.length ? fs.map(fieldKey).join(", ") : "—");
  return `(${render(contract.input)}) → (${render(contract.output)})`;
}

/** Do two purposes plausibly describe the same job? Word overlap, and nothing cleverer. */
function purposesAgree(purposes: string[]): boolean {
  if (purposes.length < 2) return true;
  const bags = purposes.map(
    (p) =>
      new Set(
        p
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 3),
      ),
  );
  for (let i = 1; i < bags.length; i++) {
    const shared = [...bags[0]].filter((w) => bags[i].has(w)).length;
    const smallest = Math.min(bags[0].size, bags[i].size) || 1;
    // A third of the significant words in the shorter description. Low, on
    // purpose: this only decides whether a candidate is labelled `shapeOnly`, and
    // a candidate wrongly labelled "shape only" is still shown.
    if (shared / smallest < 0.34) return false;
  }
  return true;
}

/**
 * Every promotion candidate in a workspace, ranked for a human to read.
 *
 * Scoped to one workspace because a candidate is an argument for adding a TOOL,
 * and tools are per workspace. Aggregating across tenants would be the more
 * interesting product question and a schema leak — the purposes are written
 * against one tenant's data.
 */
export async function promotionCandidates(
  workspaceId: string,
  opts: { minFlows?: number; visible?: SQL } = {},
): Promise<PromotionCandidate[]> {
  const minFlows = opts.minFlows ?? 2;
  // A candidate quotes each step's purpose verbatim, so it may only draw on workflows the reader can see.
  const rows = await flowRepo.listCodeStepsAtDraft(workspaceId, opts.visible);

  const groups = new Map<string, PromotionOccurrence[]>();
  const contractByKey = new Map<string, StepContract>();

  for (const { flowId, flowName, revision, step } of rows) {
    // A hand-written `code` step has no contract, so it has no interface to group
    // by. Skipping it is the honest answer rather than inventing one from its
    // code — and a fragment with no contract cannot be promoted anyway, since
    // there is nothing declaring what a tool replacing it would have to do.
    const contract = step.contractJson as StepContract | null;
    if (!contract) continue;

    const key = shapeKeyOf(contract);
    if (!contractByKey.has(key)) contractByKey.set(key, contract);

    const cfg = step.configJson as CodeStep | null;
    groups.set(key, [
      ...(groups.get(key) ?? []),
      {
        flowId,
        flowName,
        revision,
        stepId: step.stepId,
        purpose: contract.purpose,
        codeDigest: cfg?.code ? digest(cfg.code) : null,
      },
    ]);
  }

  const candidates: PromotionCandidate[] = [];
  for (const [shapeKey, occurrences] of groups) {
    // DISTINCT flows, not occurrences. Two `code` steps with the same shape
    // inside ONE flow is duplication within an automation — a real smell, and a
    // different one from "this job recurs across automations". Counting them the
    // same way would put single-flow duplication at the top of a list titled
    // "candidates to become tools".
    const flowCount = new Set(occurrences.map((o) => o.flowId)).size;
    if (flowCount < minFlows) continue;

    const purposes = [...new Set(occurrences.map((o) => o.purpose))];
    const bodies = new Set(occurrences.map((o) => o.codeDigest).filter(Boolean));
    candidates.push({
      shapeKey,
      signature: renderSignature(contractByKey.get(shapeKey)!),
      flowCount,
      occurrences,
      purposes,
      distinctBodies: bodies.size,
      shapeOnly: !purposesAgree(purposes),
    });
  }

  // Distinct flows first, then agreement on the code (identical bodies beat
  // divergent ones), then total occurrences. Ordering for a reader; nothing acts
  // on it.
  return candidates.sort(
    (a, b) =>
      b.flowCount - a.flowCount ||
      a.distinctBodies - b.distinctBodies ||
      b.occurrences.length - a.occurrences.length,
  );
}

export const fragmentPromotionService = {
  promotionCandidates,
  shapeKeyOf,
  normaliseBody,
};
