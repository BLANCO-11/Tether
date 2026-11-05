import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("./step-execution.service.js", async () => {
  const { StepError } = await import("./step-error.js");
  return {
    StepError,
    stepExecutionService: {
      tool: vi.fn(),
      datasource: vi.fn(),
      operation: vi.fn(),
    },
  };
});

const { stepTryService, stepTrySchema, TRYABLE_KINDS, UNTRYABLE_REASON } = await import(
  "./step-try.service.js"
);
const { stepExecutionService } = await import("./step-execution.service.js");
const { StepError } = await import("./step-error.js");

const tool = stepExecutionService.tool as unknown as ReturnType<typeof vi.fn>;
const datasource = stepExecutionService.datasource as unknown as ReturnType<typeof vi.fn>;
const operation = stepExecutionService.operation as unknown as ReturnType<typeof vi.fn>;

const OK = { results: [{ ok: true, data: { id: 1 } }], succeeded: 1, failed: 0, warnings: [] };

beforeEach(() => {
  vi.clearAllMocks();
  tool.mockResolvedValue(OK);
  datasource.mockResolvedValue({ ...OK, readFrom: "production" });
  operation.mockResolvedValue({ ...OK, readFrom: "sandbox" });
});

describe("what a try may run", () => {
  it("runs exactly the three kinds Foundry itself executes", () => {
    expect([...TRYABLE_KINDS]).toEqual(["tool", "datasource", "query"]);
  });

  it.each(["transform", "code", "approval", "branch"])(
    "refuses %s with 422 and a reason of its own",
    async (kind) => {
      await expect(
        stepTryService.tryStep("ws", { stepKind: kind, ref: "x", params: {} }),
      ).rejects.toMatchObject({ status: 422, message: UNTRYABLE_REASON[kind as "code"] });
    },
  );

  it("gives every refused kind a DIFFERENT reason", () => {
    const reasons = Object.values(UNTRYABLE_REASON);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("names the kinds that can be tried in the refusal detail", async () => {
    await expect(
      stepTryService.tryStep("ws", { stepKind: "code", ref: "x", params: {} }),
    ).rejects.toMatchObject({ detail: { tryable: ["tool", "datasource", "query"] } });
  });

  it("refuses an unknown kind without claiming to know why", async () => {
    await expect(
      stepTryService.tryStep("ws", { stepKind: "notify", ref: "x", params: {} }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("calls no executor at all when the kind is refused", async () => {
    await stepTryService.tryStep("ws", { stepKind: "approval", ref: "x", params: {} }).catch(() => {});
    expect(tool).not.toHaveBeenCalled();
    expect(datasource).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });
});

describe("one call, never a batch", () => {
  it("sends exactly one params entry", async () => {
    await stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: { to: "a@b.example" } });
    expect(tool).toHaveBeenCalledWith("ws", { ref: "mail", params: [{ to: "a@b.example" }] });
  });

  it("the schema takes ONE object, so an array cannot be smuggled in", () => {
    expect(stepTrySchema.safeParse({ stepKind: "tool", ref: "m", params: [{}, {}] }).success).toBe(false);
  });

  it("defaults to one empty invocation, because a query with no parameters still runs once", () => {
    const parsed = stepTrySchema.parse({ stepKind: "tool", ref: "m" });
    expect(parsed.params).toEqual({});
  });

  it("passes NO stepId or taskrunId, so nothing can correlate it to a run", async () => {
    await stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} });
    const sent = tool.mock.calls[0][1];
    expect(sent).not.toHaveProperty("stepId");
    expect(sent).not.toHaveProperty("taskrunId");
  });

  it("passes NO run id to the tool dial — there was no run", async () => {
    await stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} });
    expect(tool.mock.calls[0].length).toBe(2);
  });
});

describe("the environment is draft and the request cannot choose it", () => {
  it("runs a datasource try as draft", async () => {
    await stepTryService.tryStep("ws", { stepKind: "datasource", ref: "hr.q", params: {} });
    // The fourth arg is the production opt-in, explicit and default-off: the
    // request still cannot choose the environment (always "draft" here), and
    // it cannot choose production either without the admin-gated flag.
    expect(datasource).toHaveBeenCalledWith("ws", expect.anything(), "draft", {
      workspaceId: "ws",
      useProdOverride: false,
    });
  });

  it("runs an operation try as draft", async () => {
    await stepTryService.tryStep("ws", { stepKind: "query", ref: "hr.op", params: {} });
    expect(operation).toHaveBeenCalledWith("ws", expect.anything(), "draft", {
      workspaceId: "ws",
      useProdOverride: false,
    });
  });

  it("has no request field for the environment", () => {
    const parsed = stepTrySchema.parse({ stepKind: "datasource", ref: "hr.q", env: "live" } as never);
    expect(parsed).not.toHaveProperty("env");
  });

  it("reports readFrom even when it is the ordinary production case", async () => {
    const r = await stepTryService.tryStep("ws", { stepKind: "datasource", ref: "hr.q", params: {} });
    expect(r.readFrom).toBe("production");
  });

  it("omits readFrom for a tool, which has no such choice", async () => {
    const r = await stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} });
    expect(r.readFrom).toBeUndefined();
  });
});

describe("a failed call is a result; a refused request is an error", () => {
  it("returns the failure as data when every item failed (502)", async () => {
    tool.mockRejectedValue(
      new StepError('tool "mail": all 1 call(s) failed', 502, {
        results: [{ ok: false, error: "connect ECONNREFUSED", status: 0 }],
      }),
    );
    const r = await stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} });
    expect(r.ok).toBe(false);
    expect(r.item.error).toContain("ECONNREFUSED");
    expect(r.warnings[0]).toContain("all 1 call(s) failed");
  });

  it("carries readFrom through a failed datasource try", async () => {
    datasource.mockRejectedValue(
      new StepError("all failed", 502, { results: [{ ok: false, error: "x" }], readFrom: "sandbox" }),
    );
    const r = await stepTryService.tryStep("ws", { stepKind: "datasource", ref: "hr.q", params: {} });
    expect(r.readFrom).toBe("sandbox");
  });

  it.each([
    [404, "unknown tool"],
    [409, "shadowed secret"],
    [424, "credential never stored"],
    [501, "unsupported datasource type"],
  ])("lets a %i refusal leave as an error", async (status, msg) => {
    tool.mockRejectedValue(new StepError(msg, status));
    await expect(
      stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} }),
    ).rejects.toMatchObject({ status });
  });

  it("rethrows a 502 that carries no results rather than inventing one", async () => {
    tool.mockRejectedValue(new StepError("all failed", 502, {}));
    await expect(
      stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("redaction", () => {
  it("redacts a credential the endpoint echoed back in its own body", async () => {
    tool.mockResolvedValue({
      results: [{ ok: true, data: { api_key: "sk-live-abcdef", rows: 3 } }],
      succeeded: 1,
      failed: 0,
      warnings: [],
    });
    const r = await stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} });
    expect(JSON.stringify(r.item)).not.toContain("sk-live-abcdef");
    expect((r.item.data as { rows: number }).rows).toBe(3);
  });

  it("redacts a failed item too", async () => {
    tool.mockRejectedValue(
      new StepError("all failed", 502, {
        results: [{ ok: false, error: "x", data: { password: "hunter2" } }],
      }),
    );
    const r = await stepTryService.tryStep("ws", { stepKind: "tool", ref: "mail", params: {} });
    expect(JSON.stringify(r.item)).not.toContain("hunter2");
  });
});

describe("what this route is NOT allowed to grow", () => {
  const src = readFileSync(new URL("./step-try.service.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../routes/step-try.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("has a control: the sources were actually read", () => {
    expect(code.length).toBeGreaterThan(500);
    expect(routeCode).toContain("stepTryService.tryStep");
  });

  it("dials nothing itself — every call goes through the execution path", () => {
    expect(code).not.toMatch(/\bfetch\s*\(|guardedFetch|axios/);
    expect(routeCode).not.toMatch(/\bfetch\s*\(|guardedFetch|axios/);
  });

  it("writes no pointer row, no execution and no revision", () => {
    for (const forbidden of ["flowStepRunRepo", "flowExecutionRepo", "writeRevision", "recordStepRun"]) {
      expect(code).not.toContain(forbidden);
      expect(routeCode).not.toContain(forbidden);
    }
  });

  /**
   * ⚠ Matched on IMPORTS, not on the word. The refusal text for `transform` and
   * `code` names Kestra on purpose — that is the reason those two kinds cannot
   * be tried — so a grep for the word would fail on the very strings that make
   * the refusal honest. What must be absent is a way to REACH the engine.
   */
  it("imports nothing that could reach Kestra or the tenant budget", () => {
    const imports = (code + routeCode).match(/from\s+"[^"]+"/g) ?? [];
    expect(imports.length).toBeGreaterThan(3);
    for (const i of imports) {
      expect(i).not.toMatch(/kestra|budget|flow-execution|approval/i);
    }
  });

  it("resolves no secret of its own", () => {
    expect(code).not.toMatch(/workspaceSecretRepo|decrypt\(/);
  });

  it("is gated on a verified identity and a workspace role", () => {
    expect(routeCode).toContain("requireIdentity");
    expect(routeCode).toContain('requireWorkspaceRole("author")');
  });
});
