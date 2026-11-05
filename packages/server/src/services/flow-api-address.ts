// src/services/flow-api-address.ts — every flow has an API address.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE REPORT THIS EXISTS FOR
// ─────────────────────────────────────────────────────────────────────────────
//
// "every workfow ever that is published should be able to be called using api"
//
// Before this, an address was a `triggers` row somebody had to create by hand,
// on a different page, knowing that "an address" and "a trigger" are the same
// object. So the flow page's API tab said *"This automation has no API trigger,
// so there is no URL to call it on"* — on **all 14** flows on this deployment,
// because `draftForFlow` drafts a `manual` trigger and nothing had ever drafted
// an api one. A capability you only get if you already know it exists is not a
// capability the product has.
//
// ⚠ **IT IS A LEAF MODULE FOR THE SAME REASON `flow-arm-readiness.ts` IS.**
// Both `trigger.service.ts` (at flow creation) and `flow-approval.service.ts`
// (at publish) need this, and neither can import the other's home:
// `trigger.service.ts` imports `flowApprovalService`, and `flow.service.ts`
// — the third candidate — is imported by `trigger.service.ts` too. Copying the
// creation into the approval service would be a second definition of what an
// api address IS (D-197), and the copies would drift in the direction where one
// of them stops setting a token, which fails as a URL that addresses nothing.
import crypto from "node:crypto";
import { triggerRepo, type Trigger } from "../repositories/trigger.repo.js";

/**
 * Create this flow's api trigger if it has none. Returns the row either way.
 *
 * ⚠ **IDEMPOTENT BY TYPE, and `draftForFlow`'s guard is by "has ANY trigger" —
 * the difference is deliberate and they are not interchangeable.** That guard
 * exists so regeneration and import do not leave a second thing to arm,
 * whatever its type. This one guards a different fact — *does an api address
 * exist* — so it has to run on a flow that already has a `manual` trigger,
 * which is the reported defect. And it must not create a second api row on a
 * flow that has one: a second address is a second credential to rotate and a
 * coin flip about which one somebody pasted.
 *
 * ⚠ **`enabled: false`. Publishing is what turns it on**, through
 * `flowApprovalService._armDeclaredCapacity`, which asks gate 1 and obeys it.
 * Creating it enabled would make this function the quiet way around a gate
 * whose reason is a measured script that reported `tests_passed=true` and
 * emailed 0 of 11 people. So a flow that has never completed a run gets an
 * address that answers 404, and the API tab shows the shape with the blocker
 * named — which is what somebody wiring up a caller needs before go-live.
 */
export async function ensureApiAddress(
  workspaceId: string,
  flow: { id: string; name: string },
): Promise<{ trigger: Trigger; created: boolean }> {
  const existing = await triggerRepo.listByFlow(flow.id);
  const already = existing.find((t) => t.type === "api");
  if (already) return { trigger: already, created: false };

  const trigger = await triggerRepo.create({
    workspaceId,
    flowId: flow.id,
    name: await apiTriggerName(workspaceId, flow),
    type: "api",
    // Same provenance convention `draftForFlow` uses: `draftedFrom` lets a
    // surface say Foundry created this rather than implying somebody chose it.
    // `inputs` stays EMPTY — an api caller supplies them in its body, and a
    // value nobody knows must not arrive pre-filled in a box that looks
    // reviewed (the `period="2023-10"` failure, relocated one layer out).
    config: { inputs: {}, draftedFrom: "plan" },
    enabled: false,
    // ⚠ The token IS the address and, today, also the Bearer — see
    // `FLOW_TRIGGER_TYPES` in `trigger.service.ts` for why those are the same
    // value and cannot be separated from inside the product. A row without one
    // is a trigger with no URL at all, which `FlowIntegrationPanel` renders as
    // "no token stored, so it has no address yet".
    webhookToken: crypto.randomBytes(18).toString("hex"),
  });
  return { trigger, created: true };
}

/**
 * A name unique within the WORKSPACE, not the flow.
 *
 * ⚠ `triggerRepo.getByName` is workspace-scoped because the credential seam
 * resolves a trigger BY NAME — so two flows cannot share one. This deployment
 * has two flows called "Untitled automation", so the derived name genuinely
 * collides and the fallback is not hypothetical.
 *
 * ⚠ The suffix is the flow id's first eight characters, which makes the whole
 * thing DETERMINISTIC: re-running this for the same flow can never invent a
 * third name, so a caller cannot end up with two addresses because two
 * different code paths each generated a fresh one.
 */
async function apiTriggerName(
  workspaceId: string,
  flow: { id: string; name: string },
): Promise<string> {
  // ⚠ Truncated to leave room for the suffix. `name` is varchar(255) and
  // `createTriggerSchema` caps at 255, so a name built from a long flow name
  // plus a suffix would be REFUSED rather than silently cut.
  const base = `${flow.name.slice(0, 200)} over the API`;
  if (!(await triggerRepo.getByName(workspaceId, base))) return base;
  return `${flow.name.slice(0, 190)} over the API (${flow.id.slice(0, 8)})`;
}
