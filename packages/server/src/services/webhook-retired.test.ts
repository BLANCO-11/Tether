// src/services/webhook-retired.test.ts
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ `webhook` IS RETIRED AND `api` IS WHAT REPLACED IT (2026-09-08)
// ─────────────────────────────────────────────────────────────────────────────
//
// Asked for directly — "we should merge webhook with api" — and the merge went
// the safe way round: the UNAUTHENTICATED receiver is the one that went.
//
// What the two actually differed by, measured at the source before deciding,
// because the obvious answer was wrong:
//
//   * NOT authentication. An `api` trigger's Bearer resolves through
//     `credentialProviderService.resolveCredential` to `trigger.webhookToken`
//     — byte-identical to the token already in its own URL — and
//     `SECRET_OWNED_KINDS` is {tool, llm, generic}, so a workspace secret of
//     kind `api` cannot be created by any write path in the product. Anyone
//     holding the URL held the credential, on both types.
//   * INPUTS. `/api` type-checks the body's `inputs` and passes them to the
//     flow; `/webhook`'s body never reached the engine at all.
//
// So `webhook` was the strictly weaker of two equally-reachable endpoints.
//
// ⚠ Nothing was migrated because there was nothing to migrate: measured on this
// deployment, `triggers` held `api=4, manual=4` and ZERO webhooks, and 0 of 30
// revisions declared `model.webhook`.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTriggerSchema } from "./trigger.service.js";
import { flowModelSchema } from "./flow.service.js";
import { checkFlowInputResolution } from "./flow-validator.service.js";

const here = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const triggerSrc = here("./trigger.service.ts");
const routesSrc = here("../routes/triggers.ts");
const compilerSrc = here("./flow-compiler.service.ts");
const approvalSrc = here("./flow-approval.service.ts");

describe("a webhook cannot be created", () => {
  it("⚠ the type is still ACCEPTED by the schema, so the refusal can explain itself", () => {
    /**
     * The same treatment `schedule` gets, for the same reason (D-18): a caller
     * asking for a retired type must get a 409 naming the replacement, not a
     * 400 saying the enum value does not exist. A retired concept has to be
     * able to say it is retired.
     */
    const parsed = createTriggerSchema.safeParse({ name: "x", type: "webhook" });
    expect(parsed.success).toBe(true);
  });

  it("⚠ and `createForFlow` refuses it with a 409 that names `api`", () => {
    expect(triggerSrc).toContain("RETIRED_TRIGGER_TYPES");
    const at = triggerSrc.indexOf("const RETIRED_TRIGGER_TYPES");
    const block = triggerSrc.slice(at, at + 1200);
    expect(block).toContain("webhook");
    expect(block).toContain('use "api" instead');
    // It must say what an existing caller LOSES, which is nothing — the body
    // never reached the flow. A migration note that omits that reads as a
    // capability being taken away.
    // ⚠ Matched on `never reached` alone: the sentence is split across a string
    // concatenation in the source, so the full phrase is not present as one
    // literal. Asserting the whole phrase failed here and the CODE was right.
    expect(block).toMatch(/never reached/);
  });

  it("⚠ the refusal is checked BEFORE the generic flow-trigger refusal", () => {
    // The generic message talks about Kestra owning schedules, which would be
    // simply untrue about a webhook. A refusal naming the wrong reason is worse
    // than a 400.
    const retiredAt = triggerSrc.indexOf("const retired = RETIRED_TRIGGER_TYPES[input.type]");
    const genericAt = triggerSrc.indexOf("if (!FLOW_TRIGGER_TYPES.has(input.type))");
    expect(retiredAt).toBeGreaterThan(0);
    expect(genericAt).toBeGreaterThan(0);
    expect(retiredAt).toBeLessThan(genericAt);
  });

  it("CONTROL: `api`, `manual` and `poll` are still flow trigger types", () => {
    // Without this, an empty FLOW_TRIGGER_TYPES would satisfy everything above.
    const at = triggerSrc.indexOf("const FLOW_TRIGGER_TYPES = new Set(");
    const line = triggerSrc.slice(at, triggerSrc.indexOf(";", at));
    for (const t of ["manual", "poll", "api"]) expect(line).toContain(`"${t}"`);
    expect(line).not.toContain('"webhook"');
  });
});

describe("a webhook cannot be declared on a model", () => {
  it("⚠ `flowModelSchema` STRIPS a `webhook` declaration", () => {
    const out = flowModelSchema.parse({
      id: "k1",
      // ⚠ At least one step — `flowModelSchema` requires it, and a zero-step
      // model fails on `steps` before it ever reaches the keys under test.
      steps: [{ id: "s1", kind: "transform", expr: "json(1)" }],
      webhook: { name: "orders" },
      api: { name: "orders-api" },
    });
    expect("webhook" in out).toBe(false);
    // CONTROL: `api` survives the same parse, so the strip is about the key and
    // not about the schema rejecting both.
    expect((out as { api?: { name: string } }).api).toEqual({ name: "orders-api" });
  });

  it("the input-resolution rule no longer has a webhook arm", () => {
    const f = checkFlowInputResolution({
      steps: [],
      webhook: { name: "orders" },
      inputs: [{ id: "tenant", type: "STRING" }],
    } as never);
    expect(f).toHaveLength(0);
  });

  it("⚠ approve()'s webhook refusal is DELETED, not left unreachable", () => {
    // A refusal that can never fire reads as a live control (I-38).
    expect(approvalSrc).not.toContain("this flow declares a webhook");
    // And the reason is written down where the code used to be.
    expect(approvalSrc).toContain("THE WEBHOOK REFUSAL THAT STOOD HERE IS DELETED");
  });
});

describe("the receiver refuses", () => {
  it("⚠ `/:token/webhook` answers 404 WITHOUT looking the token up", () => {
    /**
     * Refusing only an existing webhook would leave the retirement depending on
     * there being no rows — measured zero here, and not a property of the code.
     * Unconditional means a legacy row on any deployment cannot fire.
     */
    const at = routesSrc.indexOf('webhookRouter.post(');
    const body = routesSrc.slice(at, routesSrc.indexOf("\n);", at));
    expect(body).toContain('status(404)');
    expect(body).not.toContain("getByWebhookToken");
    expect(body).not.toContain("triggerService.fire");
  });

  it("⚠ it stays RATE LIMITED — a retired public route is still callable", () => {
    const at = routesSrc.indexOf('webhookRouter.post(');
    expect(routesSrc.slice(at, at + 200)).toContain("limitPublicReceiver");
  });

  it("⚠ it logs only the token PREFIX — the token in the URL is the credential", () => {
    const at = routesSrc.indexOf('webhookRouter.post(');
    const body = routesSrc.slice(at, routesSrc.indexOf("\n);", at));
    expect(body).toContain("console.warn");
    expect(body).toContain(".slice(0, 6)");
  });

  it("CONTROL: the `api` receiver still authenticates and still fires", () => {
    // Without this, a file that had lost both receivers would pass every
    // assertion above.
    const at = routesSrc.indexOf('apiTriggerRouter.post(');
    const body = routesSrc.slice(at, routesSrc.length);
    // ⚠ `timingSafeEqual` lives in `constantTimeEqual`, which is declared ABOVE
    // this router — so it is asserted against the FILE and the call against the
    // body. Slicing from the router and looking for it failed, and the code was
    // right; a test that "fixes" that by widening to the file for everything
    // would stop distinguishing the two receivers at all.
    expect(routesSrc).toContain("timingSafeEqual");
    expect(body).toContain("constantTimeEqual(");
    expect(body).toContain("validateFireInputs");
    expect(body).toContain('fire(trigger.id, "api"');
    expect(body).toContain('status(401)');
  });
});

describe("what must NOT be tidied away", () => {
  it("⚠ `structureHash` still carries a `webhook` key, pinned to null", () => {
    /**
     * THE ONE THING IN THIS RETIREMENT THAT IS LOAD-BEARING BY ITS ABSENCE OF
     * CHANGE. `structureHash` is STORED on every `flow_revisions` row and
     * compared between stored rows by `flowApprovalService.diff`. Removing the
     * key changes the JSON the hash is taken over, so every existing revision's
     * hash would stop matching a newly written one and every diff spanning the
     * change would report a structural change that did not happen.
     *
     * Same shape as `manifest-builder`'s hardcoded `isDummy: false`, whose own
     * comment says: a key inside a hash is load-bearing long after the feature
     * behind it is gone.
     */
    const at = compilerSrc.indexOf("const shape");
    const block = compilerSrc.slice(at, compilerSrc.indexOf("sha256", at));
    expect(block).toContain("webhook: null");
    expect(block).toContain("api: model.api?.name ?? null");
  });

  it("`webhook_token` is still the column BOTH types use", () => {
    // The column name is not the type. An api trigger's token lives here, so a
    // rename would be a migration for no reason.
    expect(triggerSrc).toContain("webhookToken");
  });
});

/**
 * ⚠ THE RETIREMENT WAS CHECKED EVERYWHERE THE KEY IS CONSUMED AND NOWHERE IT
 * WAS TAUGHT — which is how `DRAFT_RULES` went on offering a retired trigger
 * for eight days after the schema stopped accepting it.
 *
 * `flowModelSchema` dropped `webhook` on 2026-09-08 and `z.object` strips
 * unknown keys, so a draft declaring one lost the declaration silently on
 * write: no error, no finding, no log line. Every assertion in this file above
 * this point was green throughout, because each one reads a module that
 * CONSUMES the key. The prompt is the one surface that PRODUCES it.
 *
 * ⚠ The assertion matches the DECLARATION SHAPE the prompt used (`"webhook":`
 * inside a backtick-quoted rules line), not the bare word — this module's
 * comments discuss the retirement at length, and a bare-word ban would flag the
 * explanation of why the rule is gone. That is I-62's exact failure mode, and
 * it has fired four times in this repo already: a well-commented control is the
 * single most likely thing to trip its own guard, because the comment and the
 * violation say the same words.
 */
describe("the builder does not teach a retired trigger", () => {
  /**
   * The DRAFT prompt this block pinned went with the drafter (phase 8, D-333).
   * The compiled builder is now the one surface that PRODUCES a flow from a
   * model, so the ban moves to its modules. It names `webhook` nowhere today —
   * not even in a comment — so a bare-word ban is safe here and says more.
   */
  const dir = new URL("./builder/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("CONTROL: the builder's modules were read", () => {
    expect(files).toContain("build.ts");
    expect(files).toContain("builder.service.ts");
  });

  it("no builder module names webhook", () => {
    const offending = files.filter((f) => /\bwebhook\b/i.test(readFileSync(new URL(f, dir), "utf8")));
    expect(offending).toEqual([]);
  });
});
