import type { Request } from "express";
import { db } from "../db/index.js";
import { flowRunRequests } from "../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * Who asked for a run — archive/GAPS.md §1.1b · D-70.
 *
 * The counterpart to `revision-author.ts` (D-60), and deliberately shaped the
 * same way. That module answers *"who wrote this revision, and did anything
 * verify them"*; this one answers *"who asked for this run"*, which is the
 * subject gate 3 never had.
 *
 * ── Why gate 3 needed one ────────────────────────────────────────────────────
 *
 * Gate 2 refuses self-approval by comparing the approver against
 * `flow_revisions.created_by`. Gate 3 had nothing to compare against: an
 * execution was started by *a schedule, a trigger or a test run*, and the
 * product recorded none of them as a person. So §1.1's role check was the entire
 * control there, with no second layer behind it — which is exactly what the
 * GAPS entry says and what this closes.
 *
 * ⚠ **It does not make gate 3 separation of duties** (I-13), and it cannot: a
 * `RUNTIME_JWT_SECRET` holder mints any identity, so both sides of the
 * comparison are only as good as that secret. Say: *the person who started a run
 * cannot also be the one who approves its pause.*
 *
 * ── The five kinds, and the one that is absent on purpose ────────────────────
 *
 *   user      a signed-in person pressed "test run"
 *   replay    a signed-in person replayed an earlier run
 *   trigger   a manual/webhook/poll trigger fired; no person
 *   system    a harness, a seed or an internal caller
 *   schedule  Kestra started it from the flow definition
 *
 * `schedule` is the one that never appears in `flow_run_requests`. A scheduled
 * execution does not pass through a Foundry route at all, so there is nothing to
 * write a row from — `begin` infers it from the ABSENCE of a pointer. Storing a
 * `schedule` row would mean writing a value nothing can produce, which reads as
 * a reachable case and is not.
 */

export type RunRequesterKind = "user" | "replay" | "trigger" | "system" | "schedule" | "unknown";

/** The kinds a route may actually create a row for. See above for `schedule`. */
export type StoredRequesterKind = "user" | "replay" | "trigger" | "system";

export interface RunRequester {
  /** The identity `sub`. Null for anything that is not a person. */
  subject: string | null;
  /** For display and for the refusal message. Never used to decide identity. */
  actor: string;
  kind: StoredRequesterKind;
}

/**
 * The requester for a request, from the VERIFIED identity when there is one.
 *
 * ⚠ **There is no body field for this and there must never be one.** D-60's
 * `createdBy` had to stay on the schema because a harness posting over HTTP has
 * a label worth keeping; here a harness calls the service directly and passes
 * `systemRequester()` in process, so a body value would be pure attack surface —
 * a client naming the person a self-decision refusal will compare against is the
 * refusal switched off from outside. `revision-author.test.ts`'s grep has a
 * sibling in `run-requester.test.ts` for exactly this.
 */
export function requesterOf(req: Request, kind: "user" | "replay" = "user"): RunRequester {
  const user = req.user;
  if (user?.subject) {
    return { subject: user.subject, actor: user.email ?? user.subject, kind };
  }
  // No identity: an API-key-only caller — a harness, or the client's proxy on a
  // path that does not require identity. `system`, and it says so; inventing a
  // person here is the defect D-60 exists to prevent, arriving from the run side.
  return { subject: null, actor: "system", kind: "system" };
}

/** A named non-person caller. Harnesses and seeds say this and mean it. */
export function systemRequester(actor: string): RunRequester {
  return { subject: null, actor, kind: "system" };
}

/** A trigger fire. No person, and the trigger's own name is the actor. */
export function triggerRequester(triggerName: string): RunRequester {
  return { subject: null, actor: `trigger:${triggerName}`, kind: "trigger" };
}

export const runRequesterRepo = {
  /**
   * Record a requester and return the pointer Kestra will carry.
   *
   * Written BEFORE `startExecution`, so the label can never name a row that does
   * not exist. The reverse order would produce a pointer `begin` cannot resolve
   * for whatever window the insert takes, and the failure would be intermittent
   * and load-dependent — the worst kind to diagnose on a scheduled run.
   */
  async record(
    workspaceId: string,
    flowId: string | null,
    requester: RunRequester,
  ): Promise<string> {
    const rows = await db
      .insert(flowRunRequests)
      .values({
        workspaceId,
        flowId,
        subject: requester.subject,
        actor: requester.actor,
        kind: requester.kind,
      })
      .returning({ id: flowRunRequests.id });
    return rows[0]!.id;
  },

  async get(id: string) {
    const rows = await db
      .select()
      .from(flowRunRequests)
      .where(eq(flowRunRequests.id, id))
      .limit(1);
    return rows[0];
  },
};
