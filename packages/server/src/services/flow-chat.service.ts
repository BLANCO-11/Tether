

import { buildPreview, withBuildProgress } from "./builder/progress.js";
import { z } from "zod";

import { flowChatRepo, type FlowChatThread, type FlowChatTurn } from "../repositories/flow-chat.repo.js";
import { flowRepo } from "../repositories/flow.repo.js";

import type { RevisionAuthor } from "./revision-author.js";
import { requestPolicyService } from "./request-policy.service.js";

/**
 * Chat: threads, turns, and their bounds. A turn is a message to the COMPILED BUILDER (`flow-chat-builder.ts` →
 * `builder/conversation.ts`): a goal starts a build, each reply answers its one pending question, an edit is additive (D-321).
 * The one-op editor that stood here — `CHAT_RULES`, the op loop, the corrective pass, laya's edit advice — was deleted at the
 * compiled-builder cutover (phase 8): a model no longer writes an op; changes and removals are the canvas's, where every edit
 * is a legal move.
 */

/**
 * A `running` turn older than this is a process death mid-turn, not a slow model: a builder turn is a few bounded model calls
 * (each with the gateway's own timeout), so a row this old has lost its owner, and every later turn would 409 for ever. Ten
 * minutes — the ceiling the deleted one-op editor used (2 × its five-minute per-call abort), kept so nothing reclaims sooner.
 */
export const STALE_RUNNING_MS = 10 * 60_000;
/** Per workspace. One conversation must not consume every inference slot. */
export const MAX_CONCURRENT_CHAT_TURNS = 3;

export const chatTurnSchema = z.object({
  /** A goal, an answer to the builder's pending question, or an addition to the flow. */
  message: z.string().min(3).max(2000),
  // ⚠ `replan` (Enable replan) and `mode` (Build/Ask) are DELETED (2026-10-10) — see `builder/chat-route.ts`.
});
export type ChatTurnInput = z.infer<typeof chatTurnSchema>;

export const createThreadSchema = z.object({
  name: z.string().min(1).max(255),
  /**
   * The flow this conversation edits — Phase 3 (FE-3.2/FE-3.3).
   *
   * ⚠ **NOT the seed of a new flow.** A thread created by the split surface is
   * bound to a flow the generation job already seeded (decision ① routes the
   * first message — a goal or a step list — to the generation job, never to a
   * chat turn, because a turn cannot seed from an empty thread: measured 0 of 5
   * on `chat:measure`, 2026-08-12). The flow MUST already exist in this
   * workspace; D-120's "no flow at thread creation" rule is about a thread not
   * CREATING a flow, and is untouched — this attaches one that already exists.
   * Absent ⇒ the thread stays unbound and D-120 behaves as before.
   */
  flowId: z.string().uuid().optional(),
  /** Copied to `flows.design_selection` at the seed and never read again. */
  designSelection: z.unknown().optional(),
});

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = statusCode;
  return e;
}

// ── The turn ─────────────────────────────────────────────────────────────────

export type TurnOutcome = {
  turn: FlowChatTurn;
  flowId: string | null;
  diff?: unknown;
};

export const flowChatService = {

  async createThread(
    workspaceId: string,
    input: z.infer<typeof createThreadSchema>,
    author: RevisionAuthor,
  ): Promise<FlowChatThread> {
    // ⚠ A thread may bind to a flow the split surface already seeded (Phase 3),
    // but never to a flow it does not own. The workspace check is what keeps
    // "attach a flow id" from becoming "read another tenant's flow through a
    // conversation you control".
    if (input.flowId) {
      const owned = await flowRepo.get(workspaceId, input.flowId);
      if (!owned) throw httpError("that flow is not in this workspace", 404);
    }
    return flowChatRepo.createThread({
      workspaceId,
      name: input.name,
      // NULL until the first APPLIED turn (D-120), UNLESS the split surface
      // bound the thread to a flow the generation job already seeded — a
      // conversation that edits an existing flow has one from the start.
      flowId: input.flowId ?? null,
      designSelection: (input.designSelection ?? null) as never,
      createdByKind: author.createdByKind,
    });
  },

  /**
   * Bind a flow the GENERATION JOB seeded to a thread that has none yet — the
   * conversation that started with questions, then stated a goal. The goal went
   * to the job (skeleton pipeline, live canvas) rather than a chat turn, and this
   * keeps the questions already asked in the same thread instead of starting a
   * second one beside them.
   *
   * ⚠ Same ownership rule as `createThread`: the flow must be in this workspace.
   * ⚠ Set once (`attachFlow`'s `IS NULL` guard): a thread already bound to a
   * DIFFERENT flow is a 409, never a repoint — every earlier turn's diff is about
   * the flow it was made against. Re-binding the same flow is a no-op.
   */
  async attachSeededFlow(workspaceId: string, threadId: string, flowId: string): Promise<FlowChatThread> {
    const thread = await flowChatRepo.getThread(workspaceId, threadId);
    if (!thread) throw httpError("conversation not found", 404);
    const owned = await flowRepo.get(workspaceId, flowId);
    if (!owned) throw httpError("that flow is not in this workspace", 404);
    if (thread.flowId === flowId) return thread;
    if (thread.flowId) throw httpError("this conversation already builds a different flow", 409);
    const bound = await flowChatRepo.attachFlow(workspaceId, threadId, flowId);
    if (!bound) throw httpError("this conversation already builds a different flow", 409);
    return bound;
  },

  listThreads: (workspaceId: string) => flowChatRepo.listThreads(workspaceId),
  /** The transcript; a RUNNING turn also carries what it has built so far (`preview`), for the canvas to draw read-only. */
  listTurns: async (workspaceId: string, threadId: string) =>
    (await flowChatRepo.listTurns(workspaceId, threadId)).map((t) => {
      const preview = t.status === "running" ? buildPreview(t.id) : null;
      return preview ? { ...t, preview } : t;
    }),

  /**
   * One turn.
   *
   * ⚠ The row is written `running` **before** the inference call, so a lost
   * response leaves a readable record rather than nothing at all.
   */
  async turn(
    workspaceId: string,
    threadId: string,
    input: ChatTurnInput,
    author: RevisionAuthor,
  ): Promise<TurnOutcome> {
    const parsed = chatTurnSchema.parse(input);
    const thread = await flowChatRepo.getThread(workspaceId, threadId);
    if (!thread) throw httpError("conversation not found", 404);

    // Two bounds, two different questions. One turn per thread stops two turns
    // reading the same revision and the second silently discarding the first;
    // the workspace bound stops one tenant's conversations taking every slot.
    // ⚠ A process death mid-turn orphans a `running` row and every later turn
    // would 409 for ever. A running turn older than STALE_RUNNING_MS outlived
    // its owner's per-call abort, so the owner is gone: fail it with the
    // stall on the record and let the new turn proceed. A row with no usable
    // timestamp is never reclaimed — without an age there is no safe call.
    const inFlight = await flowChatRepo.runningTurn(threadId);
    if (inFlight) {
      const started = inFlight.createdAt ? new Date(inFlight.createdAt).getTime() : NaN;
      if (!Number.isNaN(started) && Date.now() - started > STALE_RUNNING_MS) {
        await flowChatRepo.finishTurn(inFlight.id, {
          status: "failed",
          findingsJson: [
            "the previous turn stalled while running — likely a restart mid-turn — " +
              "so it was marked failed and this turn was allowed to proceed",
          ] as never,
        });
      } else {
        throw httpError("this conversation is still working on the previous message", 409);
      }
    }
    if ((await flowChatRepo.runningCount(workspaceId)) >= MAX_CONCURRENT_CHAT_TURNS) {
      throw httpError(
        `this workspace already has ${MAX_CONCURRENT_CHAT_TURNS} conversations working. ` +
          `Wait for one to finish.`,
        429,
      );
    }

    // FR-007/FR-008 (guardrail-port V4/V5/V8) — evaluated on the raw message,
    // before `readThreadFlow` or any inference call. A reject/transform
    // decision never reaches `running` status (research.md Decision 2): the
    // turn is written directly with its final status, the same way an
    // existing refused turn is recorded, never as a "running" row that then
    // gets finished.
    const policyDecision = requestPolicyService.evaluate(parsed.message, {
      confirmationAvailable: true,
    });
    if (policyDecision.decision === "reject" || policyDecision.decision === "transform") {
      const seq = await flowChatRepo.nextSeq(threadId);
      const turn = await flowChatRepo.createTurn({
        threadId,
        seq,
        message: parsed.message,
        status: policyDecision.decision === "reject" ? "policy_reject" : "policy_transform",
        attempts: 0,
        findingsJson: (policyDecision.decision === "reject"
          ? [policyDecision.reason]
          : [policyDecision.reason, JSON.stringify(policyDecision.proposal)]) as never,
      });
      return { turn, flowId: thread.flowId };
    }

    // The turn goes to the COMPILED BUILDER (compiled-builder phase 8 cutover): the one-op editor that stood beside it is deleted.
    // Everything above — the concurrency bounds and the policy gate — still applies.
    const seq = await flowChatRepo.nextSeq(threadId);
    const turn = await flowChatRepo.createTurn({ threadId, seq, message: parsed.message, status: "running", attempts: 0 });
    try {
      const { builderChatTurn } = await import("./flow-chat-builder.js");
      // The build's moves are readable as a preview while it works (`listTurns`), so the canvas fills in step by step.
      return await withBuildProgress(turn.id, () => builderChatTurn({ workspaceId, thread, turn, message: parsed.message, author }));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      await flowChatRepo.finishTurn(turn.id, { status: "failed", findingsJson: [err.message] as never });
      throw err;
    }
  },
};
