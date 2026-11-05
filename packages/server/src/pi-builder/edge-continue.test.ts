/**
 * Background edge settles must continue Forge — not dump stdout into the chat.
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

  it("queues a continuation when a turn is still running, and flushes when idle", () => {
    expect(src).toMatch(/function queueOrContinueAfterEdge/);
    expect(src).toMatch(/function flushPendingEdgeContinues/);
    expect(src).toMatch(/flushPendingEdgeContinues\(s\)/);
    expect(src).toMatch(/pendingEdgeContinues/);
    expect(src).toMatch(/\(work on your computer finished\)/);
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
});
