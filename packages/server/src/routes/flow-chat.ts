import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/error.middleware.js";
import { authorOf } from "../middleware/identity.middleware.js";

import {
  chatTurnSchema,
  createThreadSchema,
  flowChatService,
} from "../services/flow-chat.service.js";
import { mayChangeFlowNamedInBody } from "../middleware/content-guard.middleware.js";
import { contentVisibility } from "../services/content-visibility.service.js";
import { flowRepo } from "../repositories/flow.repo.js";

/**
 * Chat mode. Mounted at `/api/workspaces/:workspaceId/flow-chat`, behind
 * `requireApiKey`. Phase 2.8 · D-118/D-119/D-120.
 *
 * ── Four routes, and the shape of the set is the design ─────────────────────
 *
 * ⚠ **A turn is SYNCHRONOUS, deliberately.** A turn is a message to the compiled builder: a few bounded, schema-constrained
 * model calls, seconds each. A job row per turn would be a second lifecycle, a second poll loop and a second place for a status
 * to be wrong, bought for a wait nobody has.
 *
 * ⚠ **And there is no socket.** `/ws/generation` streamed exactly this kind of
 * progress and was authorised by NOTHING — `?scriptId=<uuid>` and you were
 * subscribed. A socket here would owe a single-use ticket the way flow progress
 * does (D-15); a synchronous POST owes no new auth surface at all.
 *
 * ⚠ **There is no route that takes a goal, and there must not be one.** The
 * thread has no goal column (`db/flow-chat-schema.test.ts`), the service imports
 * no design function (`flow-chat-imports.test.ts`), and a body field here would
 * be the retry channel §6.7 forbids arriving through the one door those two
 * checks do not watch.
 */
export const flowChatRouter = Router({ mergeParams: true });

/**
 * Start a conversation. **No flow is created** — D-120: the flow row appears at
 * the first APPLIED turn and never before, so a conversation whose every turn
 * was refused leaves a thread and no automation, which is the honest outcome.
 */
flowChatRouter.post(
  "/threads",
  asyncHandler(async (req, res) => {
    const input = createThreadSchema.parse(req.body);
    const thread = await flowChatService.createThread(
      req.params.workspaceId,
      input,
      // archive/GAPS.md §1.2 — `authorOf` is the only minter of a `user` attestation, and
      // it refuses a body-supplied name from a signed-in caller. No `createdBy`
      // is accepted here at all: a thread has one author and it is whoever
      // started it.
      authorOf(req, undefined),
    );
    res.status(201).json({ thread });
  }),
);

/**
 * Bind the flow a generation job seeded to a thread that has none yet. A
 * conversation may open with questions (turns that create no flow, D-120) and
 * then state a goal; the goal goes to the generation job — the skeleton pipeline
 * and its live canvas — and the job's flow is attached HERE, so the questions
 * stay in the same conversation. Takes a flow id, never a goal: there is still
 * no chat endpoint that drafts.
 */
flowChatRouter.post(
  "/threads/:threadId/flow",
  asyncHandler(async (req, res) => {
    const input = z.object({ flowId: z.string().uuid() }).strict().parse(req.body);
    if (!(await mayChangeFlowNamedInBody(req.user, req.params.workspaceId, input.flowId))) {
      return res.status(404).json({ error: "not_found", message: "This is not here any more." });
    }
    const thread = await flowChatService.attachSeededFlow(req.params.workspaceId, req.params.threadId, input.flowId);
    res.json({ thread });
  }),
);

flowChatRouter.get(
  "/threads",
  asyncHandler(async (req, res) => {
    // A thread is a building conversation, private like a Forge chat (rbac-observability): its workflow must be
    // the caller's to change; a thread with no workflow yet is listed to the person who started it, or an Admin.
    const ws = req.params.workspaceId;
    const viewer = await contentVisibility.viewer(req.user, ws);
    const me = [req.user?.email, req.user?.name].filter(Boolean);
    const threads = [];
    for (const t of await flowChatService.listThreads(ws)) {
      if (viewer.all) threads.push(t);
      else if (t.flowId) {
        const flow = await flowRepo.get(ws, t.flowId);
        if (!flow || contentVisibility.flowChangeable(viewer, flow)) threads.push(t);
      } else if (t.createdBy && me.includes(t.createdBy)) threads.push(t);
    }
    res.json({ threads });
  }),
);

/**
 * The transcript. Oldest-first, including refused turns — ⚠ **a person sees
 * every turn; only the PROMPT filters to applied ones** (`recentApplied`). The
 * two audiences need different things: a person needs to know their instruction
 * was refused and why, and a model given the same list would be re-asking a
 * refused design one turn later with the refusal as encouragement.
 */
flowChatRouter.get(
  "/threads/:threadId/turns",
  asyncHandler(async (req, res) => {
    const thread = await flowChatService.listThreads(req.params.workspaceId);
    if (!thread.some((t) => t.id === req.params.threadId)) {
      res.status(404).json({ error: "conversation not found" });
      return;
    }
    res.json({
      turns: await flowChatService.listTurns(req.params.workspaceId, req.params.threadId),
    });
  }),
);

/**
 * One turn.
 *
 * ⚠ **Every terminal state is a 200**, including `insufficient_contract`,
 * `too_structural` and `ambiguous_referent`. Filing the most useful diagnosis
 * this system produces under "error" is how a client renders it as a failure and
 * offers a retry — which is exactly the control §6.7 exists to keep. The status
 * is on the turn; the HTTP code says only that the turn was processed.
 *
 * The two non-200s are genuine refusals to process at all: a second turn on a
 * thread already working (409) and the per-workspace concurrency bound (429).
 */
flowChatRouter.post(
  "/threads/:threadId/turns",
  asyncHandler(async (req, res) => {
    const input = chatTurnSchema.parse(req.body);
    const outcome = await flowChatService.turn(
      req.params.workspaceId,
      req.params.threadId,
      input,
      authorOf(req, undefined),
    );
    res.json(outcome);
  }),
);
