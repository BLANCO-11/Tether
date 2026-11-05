import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { requireNotRunRequester } from "./run-requester.middleware.js";
import { requesterOf, systemRequester, triggerRequester } from "../services/run-requester.js";
import { stepApprovalService } from "../services/step-approval.service.js";

/**
 * Gate 3's self-decision refusal — archive/GAPS.md §1.1b, D-70.
 *
 * Three arms, and the third is the one that would get this deleted if it were
 * wrong: the refusal must STAND DOWN where there is genuinely nobody. A
 * scheduled run, a trigger fire, a harness run and a pre-migration run all have
 * no requester, and a gate that blocked their pauses would block every
 * historical approval on a fact nobody recorded — after which somebody removes
 * the check (I-38, by the usual road).
 */

const ROUTES_DIR = new URL("../routes/", import.meta.url).pathname;
const SRC_DIR = new URL("../", import.meta.url).pathname;

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
  return {
    req: {
      params: { workspaceId: "ws-1", approvalId: "ap-1" },
      user: { subject: "oid-alice", email: "alice@acme-hr.example" },
      ...over,
    },
    res,
    next,
  };
}

vi.mock("../services/workspace-restriction.service.js", () => ({ superAdminHere: async () => false }));
const { contentVisibility } = await import("../services/content-visibility.service.js");

const member = { subject: "oid-alice", all: false, reviewer: false, write: true };
const admin = { ...member, all: true };
/** The run: who started it, and (sharing-boundaries) who owns its workflow — the person who decides its pause. */
const run = (over: Record<string, unknown>) => ({ subject: "oid-alice", actor: "alice@acme-hr.example", kind: "user", owner: "oid-alice", flowName: "Digest", ...over });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(contentVisibility, "viewer").mockResolvedValue(member);
});

/** Passed: `next()` with NO error. An error handed to `next` is a 500, not a pass — asserting only "called" read one as allowed. */
const passed = (next: ReturnType<typeof vi.fn>) => expect(next).toHaveBeenCalledWith();

describe("requireNotRunRequester — who decides a run's pause", () => {
  it("⚠ only the workflow's OWNER decides it (sharing-boundaries P1-D1/D2) — a non-owner is refused", async () => {
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({ owner: "oid-bob", subject: "oid-carol" }) as never);
    const { req, res, next } = reqres();
    await requireNotRunRequester()(req as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: string }).error).toBe("not_the_decider");
    expect((res.body as { message: string }).message).toMatch(/Only the owner of "Digest"/);
  });

  it("⚠ an Admin does not decide a workflow somebody owns — looking is not deciding", async () => {
    vi.spyOn(contentVisibility, "viewer").mockResolvedValue(admin);
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({ owner: "oid-bob", subject: "oid-carol" }) as never);
    const { req, res, next } = reqres();
    await requireNotRunRequester()(req as never, res as never, next);
    expect(res.statusCode).toBe(403);
  });

  it("the owner decides — on somebody else's run, and on a run they started themselves", async () => {
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({ subject: "oid-bob" }) as never);
    let r = reqres();
    await requireNotRunRequester()(r.req as never, r.res as never, r.next);
    passed(r.next);
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({}) as never);
    r = reqres();
    await requireNotRunRequester()(r.req as never, r.res as never, r.next);
    passed(r.next);
  });

  it("an Admin decides a pause whose workflow has no owner — but not on a run they started (the old refusal stands for them)", async () => {
    vi.spyOn(contentVisibility, "viewer").mockResolvedValue(admin);
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({ owner: null, subject: "oid-bob" }) as never);
    let r = reqres();
    await requireNotRunRequester()(r.req as never, r.res as never, r.next);
    passed(r.next);
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({ owner: null }) as never);
    r = reqres();
    await requireNotRunRequester()(r.req as never, r.res as never, r.next);
    expect(r.res.statusCode).toBe(403);
    expect((r.res.body as { error: string }).error).toBe("self_decision");
    expect((r.res.body as { message: string }).message).toMatch(/you started this run/);
  });

  it("a member does not decide an ownerless workflow's pause", async () => {
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({ owner: null, subject: "oid-bob" }) as never);
    const { req, res, next } = reqres();
    await requireNotRunRequester()(req as never, res as never, next);
    expect(res.statusCode).toBe(403);
  });

  for (const kind of ["schedule", "trigger", "system", "unknown"]) {
    it(`the owner decides a "${kind}" run — there is nobody else to be`, async () => {
      vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(
        run({ subject: null, actor: kind === "trigger" ? "trigger:nightly" : null, kind }) as never,
      );
      const { req, res, next } = reqres();
      await requireNotRunRequester()(req as never, res as never, next);
      passed(next);
    });
  }

  it("⚠ compares SUBJECTS, not names — a matching email is not the owner", async () => {
    vi.spyOn(stepApprovalService, "requesterOfRun").mockResolvedValue(run({ owner: "oid-someone-else", subject: "oid-bob" }) as never);
    const { req, res, next } = reqres();
    await requireNotRunRequester()(req as never, res as never, next);
    expect(res.statusCode).toBe(403);
  });

  it("500s on a wiring mistake rather than passing", async () => {
    const { req, res, next } = reqres({ params: { workspaceId: "ws-1" } });
    await requireNotRunRequester()(req as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });
});

describe("requesterOf — the identity, and never the body", () => {
  it("takes the subject from the verified identity", () => {
    const r = requesterOf({ user: { subject: "oid-alice", email: "a@x.test" } } as never);
    expect(r).toEqual({ subject: "oid-alice", actor: "a@x.test", kind: "user" });
  });

  it("falls back to `system` with NO subject when nobody is signed in", () => {
    // Inventing a person here is D-60's defect arriving from the run side. A
    // null subject is what makes the refusal stand down rather than misfire.
    const r = requesterOf({} as never);
    expect(r.kind).toBe("system");
    expect(r.subject).toBeNull();
  });

  it("a trigger and a harness are both subject-less, and both name themselves", () => {
    expect(triggerRequester("nightly")).toEqual({
      subject: null,
      actor: "trigger:nightly",
      kind: "trigger",
    });
    expect(systemRequester("phase3").subject).toBeNull();
  });

  it("⚠ no route derives a requester from the REQUEST BODY", () => {
    // The I-61/I-62 shape, stated as what is FORBIDDEN rather than as a pattern
    // that resembles it: a client naming the person gate 3 will refuse to let
    // decide is the refusal switched off from outside. `createdBy` needed a body
    // field for harnesses; this needs none, because harnesses call the service.
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      for (const line of src.split("\n")) {
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        if (/req\.body[^\n]*requeste/i.test(line) || /requestedBy\s*:\s*(req\.body|input\.|body\.)/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("…and the scan finds the routes it is scanning, so it is not green over nothing", () => {
    const withTestRun = readdirSync(ROUTES_DIR).filter((f) =>
      readFileSync(join(ROUTES_DIR, f), "utf8").includes("requesterOf("),
    );
    // flows.ts (the Kestra-era test run) and pi-builder.ts (the Forge builder's test runs and decisions).
    expect(withTestRun).toEqual(["flows.ts", "pi-builder.ts"]);
  });
});

describe("the gate is mounted where gate 3 decides", () => {
  it("every route reaching stepApprovalService.decide carries it", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!src.includes("stepApprovalService.decide(")) continue;
      if (!src.includes("requireNotRunRequester")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("…and the scan finds that call site", () => {
    const found = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(ROUTES_DIR, f), "utf8").includes("stepApprovalService.decide("));
    expect(found).toEqual(["step-approvals.ts"]);
  });

  it("⚠ the requester never reaches a Kestra LABEL as a person", () => {
    // A label lives in Kestra's database and renders in `kestra-ui`, which has
    // no tenant isolation and is internal-engineers-only. Only the pointer uuid
    // may travel — the `foundry_trigger_fire` shape.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) {
          const src = readFileSync(p, "utf8");
          for (const line of src.split("\n")) {
            if (/^\s*(\/\/|\*)/.test(line)) continue;
            if (/foundry_run_request:/.test(line) && /actor|email|subject/.test(line)) {
              offenders.push(`${e.name}: ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
