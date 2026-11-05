/**
 * Background edge settles must continue Forge — not dump stdout into the chat,
 * and not fire one Forge turn per job (that flooded chats with micro-updates).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "service.ts"), "utf8");
const tool = readFileSync(join(here, "../../pi-builder-template/sandbox/tools/edge-run.mjs"), "utf8");

describe("edge background settle continues Forge instead of dumping chat", () => {
  it("onEdgeJobSettled does not push Background job finished / _bg-job blobs", () => {
    const body = src.slice(src.indexOf("onEdgeJobSettled("));
    expect(body).not.toMatch(/Background job finished on your computer/);
    expect(body).not.toMatch(/_bg-job:/);
    expect(body).toMatch(/queueOrContinueAfterEdge/);
  });

  it("queues settles and flushes a batched continue when idle (never one turn per job)", () => {
    expect(src).toMatch(/function queueOrContinueAfterEdge/);
    expect(src).toMatch(/function scheduleFlushEdgeContinues/);
    expect(src).toMatch(/function flushPendingEdgeContinues/);
    expect(src).toMatch(/EDGE_FLUSH_MS/);
    expect(src).toMatch(/edgeContinueToldBatch/);
    expect(src).toMatch(/seedActivities/);
    expect(src).toMatch(/edgeJobToActivity/);
    expect(src).toMatch(/pendingEdgeContinues/);
    expect(src).toMatch(/\(work on your computer finished\)/);
    expect(src).toMatch(/silent:\s*true/);
    // Queue always parks the job; only flush starts the turn.
    const queue = src.slice(
      src.indexOf("function queueOrContinueAfterEdge"),
      src.indexOf("function scheduleFlushEdgeContinues"),
    );
    expect(queue).not.toMatch(/void runTurn\(/);
    expect(queue).toMatch(/scheduleFlushEdgeContinues\(s\)/);
    const flush = src.slice(src.indexOf("function flushPendingEdgeContinues"));
    expect(flush).toMatch(/edgeContinueToldBatch\(fresh\)/);
    expect(flush).toMatch(/seedActivities:\s*fresh\.map/);
    expect(flush).toMatch(/void runTurn\(/);
  });

  it("continue prompt asks for one short summary; Actions hold the per-job list", () => {
    const batch = src.slice(src.indexOf("function edgeContinueToldBatch"), src.indexOf("function queueOrContinueAfterEdge"));
    expect(batch).toMatch(/ONE short summary/);
    expect(batch).toMatch(/What Forge did/);
    expect(batch).toMatch(/do not narrate every file/);
  });

  it("catch-up only continues unfinished cards (pending/running), not historical Done", () => {
    const body = src.slice(src.indexOf("async function catchUpSettledEdgeJobs"));
    expect(body).toMatch(/p\.status === "pending" \|\| p\.status === "running"/);
    expect(body).not.toMatch(/Card may already show Done/);
  });

  it("turn end marks open edge Approve / running cards as awaiting, not Ready", () => {
    expect(src).toMatch(/pendingEdgeWork\(s\)/);
    expect(src).toMatch(/An edge Approve card is open/);
  });

  it("edge-run tool tells Forge not to ask for okay", () => {
    expect(tool).toMatch(/do not ask them to say okay/i);
  });

  it("decideProposal skips the asker rule for edge cards (null-subject continue must not 403 Approve)", () => {
    const body = src.slice(src.indexOf("async function decideProposal"));
    expect(body).toMatch(/if \(p\.kind !== "edge"\)/);
    expect(body).toMatch(/m\.by\?\.subject/);
    expect(body).toMatch(/device ownership is checked in approveJob/);
  });

  it("Approve watches the job on this session and settle can find a reopened chat", () => {
    expect(src).toMatch(/function findSessionForEdgeJob/);
    expect(src).toMatch(/followEdgeJobAfterApprove/);
    expect(src).toMatch(/catchUpSettledEdgeJobs/);
  });

  it("Stop clears pending edge continues so Forge does not restart after abort", () => {
    const stop = src.slice(src.indexOf("stop(workspaceId: string, sessionId: string)"));
    expect(stop).toMatch(/pendingEdgeContinues = \[\]/);
    expect(stop).toMatch(/edgeFlushTimer/);
    expect(src).toMatch(/Stop must mean stop/);
  });

  it("Approve of a folder-touching edge job persists the directory grant", () => {
    const body = src.slice(src.indexOf("async function decideProposal"));
    expect(body).toMatch(/folderPatternFromJob/);
    expect(body).toMatch(/ask once, then work there/);
    expect(src).toMatch(/approvePendingEdgeUnderFolder/);
  });
});
