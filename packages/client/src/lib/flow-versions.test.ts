// src/lib/flow-versions.test.ts — approvals → versions.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ A VERSION IS AN APPROVAL, AND ITS NUMBER IS THE APPROVAL ORDINAL
// ─────────────────────────────────────────────────────────────────────────────
//
// Reported from use, twice. First: *"for each change on builder it increments
// the version… it should only increment once we save a draft."* The first answer
// hid intermediate revisions from the version LIST and left the NUMBER climbing,
// so it came back. Then, decisively: *"increment revision only on approval —
// without that there won't be any versioning."*
//
// `flow_revisions` is written on every edit (a chat turn, a canvas save, a seed,
// a harness); `flow_approvals` is insert-only, closed by timestamp, and written
// only when a person approves. So the ordinal over approvals is a number that
// cannot move while somebody is drafting — which is the whole requirement.
import { describe, expect, it } from "vitest";
import { versionsFromApprovals } from "./api";

const at = (iso: string, revision: number) => ({
  revision,
  approverUserId: "alice",
  note: null,
  approvedAt: iso,
  revokedAt: null,
  staleReason: null,
});

describe("versionsFromApprovals", () => {
  it("numbers approvals 1..n in the order they were APPROVED", () => {
    const v = versionsFromApprovals([at("2026-09-02T00:00:00Z", 11), at("2026-09-01T00:00:00Z", 4)]);
    expect(v.map((x) => [x.version, x.revision])).toEqual([
      [1, 4],
      [2, 11],
    ]);
  });

  it("⚠ orders by approvedAt, NOT by revision", () => {
    /**
     * The claim this file exists for. `flow-approval.service.ts` allows arming
     * ANY revision — gate 1 was downgraded to a warning, so somebody may
     * deliberately approve an older revision after a newer one. Numbering by
     * revision would then show v2 as having been approved before v1. The
     * ordinal is a fact about when somebody signed something off.
     *
     * ⚠ Perturbation: sorting on `revision` makes this fail — revision 11 was
     * approved FIRST here, so it must be v1.
     */
    const v = versionsFromApprovals([at("2026-09-05T00:00:00Z", 4), at("2026-09-01T00:00:00Z", 11)]);
    expect(v.map((x) => [x.version, x.revision])).toEqual([
      [1, 11],
      [2, 4],
    ]);
  });

  it("⚠ a revoked approval KEEPS its number and stays in the list", () => {
    /**
     * `flow_approvals` is never deleted — the row is the audit artefact.
     * Excluding revoked rows would renumber every version above one the moment
     * somebody turned it off, silently changing which version an audit trail
     * refers to.
     */
    const v = versionsFromApprovals([
      { ...at("2026-09-01T00:00:00Z", 4), revokedAt: "2026-09-04T00:00:00Z" },
      at("2026-09-02T00:00:00Z", 11),
    ]);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ version: 1, revision: 4, revokedAt: "2026-09-04T00:00:00Z" });
    expect(v[1]).toMatchObject({ version: 2, revision: 11 });
  });

  it("⚠ an unstamped approval sorts LAST, never first", () => {
    /**
     * A null `approvedAt` is not evidence of being the earliest approval, and
     * the obvious `?? ""` would win an ascending compare against every real
     * timestamp — making an unstamped row v1 and renumbering everything real.
     */
    const v = versionsFromApprovals([
      { ...at("2026-09-01T00:00:00Z", 4), approvedAt: null },
      at("2026-09-02T00:00:00Z", 11),
    ]);
    expect(v.map((x) => x.revision)).toEqual([11, 4]);
  });

  it("an automation nobody has approved has NO versions — not a v1", () => {
    // The honest empty. A `v1` here would be a version nobody signed.
    expect(versionsFromApprovals([])).toEqual([]);
    expect(versionsFromApprovals([null])).toEqual([]);
  });
});
