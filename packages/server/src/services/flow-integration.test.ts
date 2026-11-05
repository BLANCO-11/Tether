import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/flow.repo.js", () => ({ flowRepo: { get: vi.fn(), getRevision: vi.fn() } }));
vi.mock("../repositories/trigger.repo.js", () => ({ triggerRepo: { listByFlow: vi.fn() } }));
vi.mock("../repositories/workspace-secret.repo.js", () => ({
  workspaceSecretRepo: { getByName: vi.fn() },
}));
vi.mock("../config/index.js", () => ({ config: { publicApiBaseUrl: null } }));

const { flowIntegrationService } = await import("./flow-integration.service.js");
const { flowRepo } = await import("../repositories/flow.repo.js");
const { triggerRepo } = await import("../repositories/trigger.repo.js");
const { workspaceSecretRepo } = await import("../repositories/workspace-secret.repo.js");

const get = flowRepo.get as unknown as ReturnType<typeof vi.fn>;
const getRevision = flowRepo.getRevision as unknown as ReturnType<typeof vi.fn>;
const listByFlow = triggerRepo.listByFlow as unknown as ReturnType<typeof vi.fn>;
const getSecret = workspaceSecretRepo.getByName as unknown as ReturnType<typeof vi.fn>;

const apiTrigger = {
  id: "t1",
  name: "nightly",
  type: "api",
  enabled: true,
  webhookToken: "TOK",
};

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ id: "f1", armedRevision: 3 });
  getRevision.mockResolvedValue({
    modelJson: { inputs: [{ id: "period", type: "string", required: true }, { id: "dry", type: "boolean" }] },
  });
  listByFlow.mockResolvedValue([apiTrigger]);
  getSecret.mockResolvedValue(null);
});

describe("live, and why not", () => {
  it("is live when a revision is armed", async () => {
    const r = await flowIntegrationService.get("ws", "f1");
    expect(r.live).toBe(true);
    expect(r.liveBlockedReason).toBeNull();
  });

  it("says WHY it is not live rather than rendering nothing", async () => {
    get.mockResolvedValue({ id: "f1", armedRevision: null });
    const r = await flowIntegrationService.get("ws", "f1");
    expect(r.live).toBe(false);
    expect(r.liveBlockedReason).toMatch(/no approved revision armed/);
  });

  it("still lists the endpoints when not live, so the shape is visible", async () => {
    get.mockResolvedValue({ id: "f1", armedRevision: null });
    const r = await flowIntegrationService.get("ws", "f1");
    expect(r.endpoints).toHaveLength(1);
  });

  it("404s for a flow that is not in this workspace", async () => {
    get.mockResolvedValue(null);
    await expect(flowIntegrationService.get("ws", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("the inputs come from the ARMED revision", () => {
  it("reads the armed revision, not the draft", async () => {
    await flowIntegrationService.get("ws", "f1");
    expect(getRevision).toHaveBeenCalledWith("f1", 3);
  });

  it("projects id, type and required", async () => {
    const r = await flowIntegrationService.get("ws", "f1");
    expect(r.inputs).toEqual([
      { id: "period", type: "string", required: true },
      { id: "dry", type: "boolean", required: false },
    ]);
  });

  it("reads no revision at all when nothing is armed", async () => {
    get.mockResolvedValue({ id: "f1", armedRevision: null });
    const r = await flowIntegrationService.get("ws", "f1");
    expect(getRevision).not.toHaveBeenCalled();
    expect(r.inputs).toEqual([]);
  });

  it("survives a revision whose model declares no inputs", async () => {
    getRevision.mockResolvedValue({ modelJson: {} });
    expect((await flowIntegrationService.get("ws", "f1")).inputs).toEqual([]);
  });
});

describe("⚠ where the Bearer actually comes from", () => {
  it("falls back to the TRIGGER TOKEN when no secret of that name exists", async () => {
    const r = await flowIntegrationService.get("ws", "f1");
    expect(r.endpoints[0].bearerSource).toBe("trigger_token");
  });

  it("looks the secret up by the TRIGGER'S NAME, which is how the receiver resolves it", async () => {
    await flowIntegrationService.get("ws", "f1");
    expect(getSecret).toHaveBeenCalledWith("ws", "nightly");
  });

  it("reports a real second factor when an api-kind secret exists", async () => {
    getSecret.mockResolvedValue({ kind: "api" });
    expect((await flowIntegrationService.get("ws", "f1")).endpoints[0].bearerSource).toBe(
      "workspace_secret",
    );
  });

  it("reports wrong_kind when a secret of that name has another kind — every call 401s", async () => {
    getSecret.mockResolvedValue({ kind: "generic" });
    expect((await flowIntegrationService.get("ws", "f1")).endpoints[0].bearerSource).toBe("wrong_kind");
  });

  it("asks nothing about a webhook trigger, which takes no Bearer", async () => {
    listByFlow.mockResolvedValue([{ ...apiTrigger, type: "webhook" }]);
    const r = await flowIntegrationService.get("ws", "f1");
    expect(r.endpoints[0].auth).toBe("none");
    expect(r.endpoints[0].bearerSource).toBeNull();
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe("the endpoints", () => {
  it("builds the api path with the token in it", async () => {
    expect((await flowIntegrationService.get("ws", "f1")).endpoints[0].path).toBe(
      "/api/triggers/TOK/api",
    );
  });

  it("builds the webhook path on the other suffix", async () => {
    listByFlow.mockResolvedValue([{ ...apiTrigger, type: "webhook" }]);
    expect((await flowIntegrationService.get("ws", "f1")).endpoints[0].path).toBe(
      "/api/triggers/TOK/webhook",
    );
  });

  it("has no path when the trigger carries no token", async () => {
    listByFlow.mockResolvedValue([{ ...apiTrigger, webhookToken: null }]);
    expect((await flowIntegrationService.get("ws", "f1")).endpoints[0].path).toBeNull();
  });

  it("leaves out schedule, manual and poll triggers, which no URL fires", async () => {
    listByFlow.mockResolvedValue([
      apiTrigger,
      { ...apiTrigger, id: "t2", type: "schedule" },
      { ...apiTrigger, id: "t3", type: "manual" },
      { ...apiTrigger, id: "t4", type: "poll" },
    ]);
    const r = await flowIntegrationService.get("ws", "f1");
    expect(r.endpoints.map((e) => e.triggerId)).toEqual(["t1"]);
  });

  it("reports enabled as a boolean, never null", async () => {
    listByFlow.mockResolvedValue([{ ...apiTrigger, enabled: null }]);
    expect((await flowIntegrationService.get("ws", "f1")).endpoints[0].enabled).toBe(false);
  });
});

describe("the base URL is never guessed", () => {
  it("is null when the deployment did not declare one", async () => {
    expect((await flowIntegrationService.get("ws", "f1")).baseUrl).toBeNull();
  });
});
