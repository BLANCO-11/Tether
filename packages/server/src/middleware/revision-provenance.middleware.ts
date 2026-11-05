import type { NextFunction, Request, Response } from "express";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceMemberService } from "../services/workspace-member.service.js";
import { asyncHandler } from "./error.middleware.js";

/**
 * A policy over `flow_revisions.created_by_kind` — archive/GAPS.md §1.2b, D-69.
 *
 * ── What §1.2 left, and why §1.1 landing did not close it ────────────────────
 *
 * D-60 recorded whether a revision's authorship was **attested**: `user` when
 * `authorOf()` minted it from a signed identity, `system` when a harness, seed
 * or import wrote it, `unknown` for the 37 rows that predate the column. It
 * refused nothing on it, deliberately — refusing every `system`-authored
 * revision breaks `kestra:phase3`, the seeds, the showcase and the scenarios,
 * all of which arm flows that way.
 *
 * §1.1 was named as the unblocker and, on landing, turned out not to be
 * sufficient on its own: roles made a policy *expressible*, they did not make
 * "refuse system-authored revisions" any less breaking.
 *
 * ── The policy, and why it is the one that does not break the net ────────────
 *
 * **An `approver` may approve a revision a person is recorded as having
 * written. Approving one nobody is recorded as having written needs an
 * `admin`.**
 *
 * The nobody-wrote-this case does not go away — that would be the day-one
 * refusal everybody routes around (D-52's argument) — it goes *up*. Somebody
 * with the authority to grant roles has to be the one who says "I have read what
 * this flow does and I am arming it anyway", which is exactly the judgement an
 * unattested revision needs and exactly what an approver cannot supply, because
 * there is nobody for the self-approval refusal to compare them against.
 *
 * ⚠ **It lives at the ROUTE, not in `flow-approval.service.ts`, and that is the
 * same argument D-67 makes for the role check itself.** It needs `req.user`, and
 * a harness has none. In the service it would be satisfied by a constant or it
 * would break every harness — and every harness arms flows through
 * `systemAuthor()`, so this policy in the service would refuse the entire
 * regression net. `kestra:phase3`, `scenarios:seed` and the showcase call the
 * service directly and are untouched by design; what is governed is a person
 * approving through a browser.
 *
 * ⚠ **This is still not separation of duties** (I-13). It never becomes that
 * while anything holding `RUNTIME_JWT_SECRET` can mint an identity. Say: *an
 * approver cannot arm a revision whose authorship nobody attested — an admin
 * has to.*
 */

/** The kinds a plain `approver` may act on. Everything else needs an admin. */
const ATTESTED = new Set(["user"]);

export function requireProvenanceAuthority() {
  return asyncHandler(async function provenanceGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const workspaceId = req.params.workspaceId;
    const flowId = req.params.flowId;
    if (!workspaceId || !flowId) {
      // ⚠ A 500 naming the wiring mistake, never a silent pass. Mounting this
      // where the params are absent would otherwise turn the policy off for
      // that route and report nothing — `requireWorkspaceRole` fails the same
      // way for the same reason.
      return res.status(500).json({
        error: "misconfigured",
        message:
          "requireProvenanceAuthority is mounted where :workspaceId/:flowId are not both in scope",
      });
    }

    const flow = await flowRepo.get(workspaceId, flowId);
    if (!flow) return res.status(404).json({ error: "not_found" });

    // The revision being approved: the body's, or the draft. Read the same way
    // `flowApprovalService.approve` reads it, so the gate and the act cannot
    // disagree about their subject.
    const target = Number((req.body as { revision?: unknown } | undefined)?.revision);
    const revisionNumber = Number.isInteger(target) ? target : flow.draftRevision;
    const revision = await flowRepo.getRevision(flow.id, revisionNumber);
    if (!revision) return res.status(404).json({ error: "not_found", message: "no such revision" });

    const kind = revision.createdByKind ?? "unknown";
    if (ATTESTED.has(kind)) return next();

    const verdict = await workspaceMemberService.check(workspaceId, req.user, "admin");
    if (verdict.allowed) return next();

    // ⚠ The message says WHICH of the two problems this is. "Forbidden" alone
    // sends an approver to ask for a role they may already have, when the actual
    // fact is that this particular revision needs a different kind of sign-off.
    return res.status(403).json({
      error: "unattested_revision",
      message:
        `revision ${revisionNumber} of this flow records its author as "${revision.createdBy}" ` +
        `with provenance "${kind}" — nobody signed in is recorded as having written it, so ` +
        `there is nobody for the self-approval refusal to check you against. An admin of this ` +
        `workspace can approve it; an approver cannot.`,
      provenance: kind,
      recordedAuthor: revision.createdBy,
      revision: revisionNumber,
    });
  });
}
