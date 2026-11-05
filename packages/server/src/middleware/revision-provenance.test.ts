import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { requireProvenanceAuthority } from "./revision-provenance.middleware.js";
import { flowRepo } from "../repositories/flow.repo.js";
import { workspaceMemberService } from "../services/workspace-member.service.js";

/**
 * The provenance policy — archive/GAPS.md §1.2b, D-69.
 *
 * ⚠ Both arms, and the second is the one that matters. A gate that refused every
 * revision would satisfy "unattested revisions are refused" perfectly and be
 * indistinguishable from a broken gate — and this repo's own record is that a
 * control which cannot pass gets reverted just as fast as one that cannot fail
 * (I-38 from the other side).
 *
 * The third test is the one that would rot: it reads the route tree, because a
 * new approval route that forgot this middleware would work perfectly and report
 * nothing — the one-reader-per-secret shape, for the third time.
 */

const ROUTES_DIR = new URL("../routes/", import.meta.url).pathname;

function reqres(over: Record<string, unknown> = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  const next = vi.fn();
  const req = {
    params: { workspaceId: "ws-1", flowId: "flow-1" },
    body: {},
    user: { subject: "oid-alice", email: "alice@acme-hr.example" },
    ...over,
  };
  return { req, res, next };
}

const FLOW = { id: "flow-1", draftRevision: 3 } as never;

beforeEach(() => vi.restoreAllMocks());

describe("requireProvenanceAuthority", () => {
  it("LETS AN APPROVER THROUGH on a revision a person is recorded as writing", async () => {
    // The positive control. Without it, everything below is satisfied by a gate
    // that refuses unconditionally — which would break every browser approval in
    // the product and pass this file.
    vi.spyOn(flowRepo, "get").mockResolvedValue(FLOW);
    vi.spyOn(flowRepo, "getRevision").mockResolvedValue({
      createdBy: "alice@acme-hr.example",
      createdByKind: "user",
    } as never);
    const adminCheck = vi.spyOn(workspaceMemberService, "check");

    const { req, res, next } = reqres();
    await requireProvenanceAuthority()(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
    // ⚠ And it does not even ASK about admin — an attested revision is the
    // ordinary path and must not cost a membership query on every approval.
    expect(adminCheck).not.toHaveBeenCalled();
  });

  for (const kind of ["system", "unknown"]) {
    it(`refuses an APPROVER on a "${kind}"-authored revision, naming which problem it is`, async () => {
      vi.spyOn(flowRepo, "get").mockResolvedValue(FLOW);
      vi.spyOn(flowRepo, "getRevision").mockResolvedValue({
        createdBy: "scenarios-seed",
        createdByKind: kind,
      } as never);
      vi.spyOn(workspaceMemberService, "check").mockResolvedValue({
        allowed: false,
        status: 403,
        reason: 'holds "approver"',
      } as never);

      const { req, res, next } = reqres();
      await requireProvenanceAuthority()(req as never, res as never, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      const body = res.body as { error: string; message: string; provenance: string };
      // A distinct code, not a generic forbidden: an approver who already HAS
      // the role would otherwise go and ask for the role again.
      expect(body.error).toBe("unattested_revision");
      expect(body.provenance).toBe(kind);
      expect(body.message).toMatch(/An admin of this workspace can approve it/);
    });
  }

  it("ALLOWS an admin on the same revision — the escalation, not a block", async () => {
    vi.spyOn(flowRepo, "get").mockResolvedValue(FLOW);
    vi.spyOn(flowRepo, "getRevision").mockResolvedValue({
      createdBy: "scenarios-seed",
      createdByKind: "system",
    } as never);
    vi.spyOn(workspaceMemberService, "check").mockResolvedValue({ allowed: true } as never);

    const { req, res, next } = reqres();
    await requireProvenanceAuthority()(req as never, res as never, next);
    expect(next).toHaveBeenCalled();
  });

  it("checks the revision the BODY names, not always the draft", async () => {
    // Approving an older revision while the draft has moved on is ordinary
    // (`draft_pending`). A gate that read the draft's provenance would judge the
    // wrong subject — and in the direction that lets an unattested revision
    // through whenever the draft happens to be attested.
    vi.spyOn(flowRepo, "get").mockResolvedValue(FLOW);
    const getRevision = vi.spyOn(flowRepo, "getRevision").mockResolvedValue({
      createdBy: "x",
      createdByKind: "user",
    } as never);

    const { req, res, next } = reqres({ body: { revision: 2 } });
    await requireProvenanceAuthority()(req as never, res as never, next);
    expect(getRevision).toHaveBeenCalledWith("flow-1", 2);
    expect(next).toHaveBeenCalled();
  });

  it("⚠ 500s on a wiring mistake rather than passing", async () => {
    // Mounted where the params are not in scope, the tempting behaviour is to
    // fall through. That turns the policy off for that route and reports nothing.
    const { req, res, next } = reqres({ params: { workspaceId: "ws-1" } });
    await requireProvenanceAuthority()(req as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });

  it("404s on a revision that does not exist, rather than treating it as attested", async () => {
    vi.spyOn(flowRepo, "get").mockResolvedValue(FLOW);
    vi.spyOn(flowRepo, "getRevision").mockResolvedValue(undefined as never);
    const { req, res, next } = reqres();
    await requireProvenanceAuthority()(req as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });
});

describe("the gate is actually mounted, and the scan can find its subject", () => {
  it("every route reaching flowApprovalService.approve carries it", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!src.includes("flowApprovalService.approve(")) continue;
      /**
       * ⚠ **MATCH THE CALL, NOT THE NAME — AND THIS TEST USED TO MATCH THE NAME.**
       *
       * It was `src.includes("requireProvenanceAuthority")`, which the IMPORT LINE
       * satisfies. Commenting out the guard left the import in place, so the gate could
       * be removed from the route and this assertion stayed green. Found by perturbing
       * it during the RBAC feature's T103 sweep — by removing the control and watching
       * nothing go red, which is the only way this class of weakness is ever found.
       *
       * It is the mirror of I-62: that warns against a pattern so broad it flags the
       * explanation; this was a pattern so broad it accepted the explanation IN PLACE OF
       * the thing. Both are fixed the same way — name what must be true, which here is a
       * CALL: `requireProvenanceAuthority(`.
       */
      const code = src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
        .filter((l) => !l.trimStart().startsWith("import "))
        .join("\n");
      if (!/requireProvenanceAuthority\s*\(/.test(code)) offenders.push(file);
    }
    expect(offenders, "approval routes with no provenance gate").toEqual([]);
  });

  it("…and the scan FINDS that call site, so a rename cannot leave it green over nothing", () => {
    const found = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(ROUTES_DIR, f), "utf8").includes("flowApprovalService.approve("));
    expect(found).toEqual(["approvals.ts"]);
  });

  it("⚠ REVOKE deliberately does not carry it, and that is not an oversight", () => {
    // Revoking STOPS an automation. Making an unattested revision harder to turn
    // off would mean the least-attested flows are the ones nobody can stop —
    // the control pointing backwards.
    const src = readFileSync(join(ROUTES_DIR, "approvals.ts"), "utf8");
    const revokeBlock = src.slice(src.indexOf('"/revoke"'));
    expect(revokeBlock.slice(0, revokeBlock.indexOf("asyncHandler"))).not.toContain(
      "requireProvenanceAuthority",
    );
  });
});
