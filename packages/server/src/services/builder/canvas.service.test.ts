/**
 * The canvas's server half (phase 7, D-329): a client can take only a listed action on a state the server signed, and a
 * complete state saves through `writeRevision` while an incomplete one saves as the working copy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyFlow, SYNTHETIC, type EFlow } from "@foundry/flow-edit";

const writeRevision = vi.fn(async () => ({ revision: { revision: 7 } }));
const saveIncomplete = vi.fn(async (_w: string, _f: string, state: EFlow) => ({ diagnostics: state.holes.map(() => ({ severity: "hole" })) }));
const clearIncomplete = vi.fn(async () => undefined);
vi.mock("./builder.service.js", () => ({
  builderCatalogue: async () => ({ items: { items: [] }, cat: SYNTHETIC }),
  editStart: async () => ({ flow: {}, start: null }),
  lowerTableReaders: (f: EFlow) => f,
}));
const getIncomplete = vi.fn(async (): Promise<unknown> => null);
vi.mock("../flow.service.js", () => ({ flowService: { writeRevision, saveIncomplete, clearIncomplete, getIncomplete } }));
const created: unknown[] = [];
vi.mock("../../repositories/flow.repo.js", () => ({ flowRepo: { get: async () => ({ id: "F", kestraFlowId: "f-engine" }), create: async (row: unknown) => (created.push(row), row) } }));

const { canvasAct, canvasCreate, canvasOpen, canvasSave, signState } = await import("./canvas.service.js");
type View = Awaited<ReturnType<typeof canvasAct>> & { state: EFlow; sig: string; actions: Array<{ id: string; label: string; op?: { op: string; ref?: string; stepId?: string }; slot?: unknown; where: { at: string; port?: string } }> };

beforeEach(() => { writeRevision.mockClear(); saveIncomplete.mockClear(); clearIncomplete.mockClear(); });

describe("canvas service", () => {
  it("opens an empty flow on the flow's engine id, signed, with the palette listed", async () => {
    const v = (await canvasOpen("W", "F")) as View;
    expect(v.state.id).toBe("f-engine");
    expect(v.sig).toBe(signState("W", "F", v.state));
    expect(v.actions.some((a) => a.op?.op === "add_reader")).toBe(true);
    expect(v.actions.every((a) => typeof (a as { slot?: { make?: unknown } }).slot?.make !== "function")).toBe(true); // no function crosses the wire
  });

  it("refuses a state it did not sign — tampered, or signed for another flow", async () => {
    const v = (await canvasOpen("W", "F")) as View;
    const forged = { ...v.state, steps: [{ id: "x", kind: "transform", from: "y", pipeline: [], expr: "{{ secret('K') }}", dependsOn: [] }] };
    await expect(canvasAct("W", "F", { state: forged, sig: v.sig, actionId: "c1" })).rejects.toThrow(/not produced by the server/);
    await expect(canvasAct("W", "OTHER", { state: v.state, sig: v.sig, actionId: "c1" })).rejects.toThrow(/not produced by the server/);
    await expect(canvasAct("W", "F", { state: v.state, sig: undefined, actionId: "c1" })).rejects.toThrow(/signature/);
  });

  it("takes only a listed action, and a typed value that does not fit is refused with nothing moved", async () => {
    const v0 = (await canvasOpen("W", "F")) as View;
    await expect(canvasAct("W", "F", { state: v0.state, sig: v0.sig, actionId: "c99999" })).rejects.toThrow(/not an action/);
    const drop = v0.actions.find((a) => a.op?.op === "add_call" && a.op.ref === "mail_send")!;
    const v1 = (await canvasAct("W", "F", { state: v0.state, sig: v0.sig, actionId: drop.id })) as View;
    expect(v1.state.holes.length).toBeGreaterThan(1); // the call's required inputs, and the result
    const typed = v1.actions.find((a) => a.where.at === "port" && a.where.port === "to" && a.slot)!;
    expect(await canvasAct("W", "F", { state: v1.state, sig: v1.sig, actionId: typed.id, value: "not an address" })).toEqual({ refused: expect.any(String) });
    const v2 = (await canvasAct("W", "F", { state: v1.state, sig: v1.sig, actionId: typed.id, value: "ops@acme-corp.com" })) as View;
    expect(v2.state.holes.length).toBe(v1.state.holes.length - 1);
  });

  // 2026-09-28: "why is the email to field empty?" — an unset port the receiver fills with the run's requester is listed, so
  // every screen can say it goes to whoever starts the run; setting it takes it off the list.
  it("lists an unset port that falls back to the requester, and drops it once bound", async () => {
    const v0 = (await canvasOpen("W", "F")) as View & { requesterPorts: unknown[] };
    expect(v0.requesterPorts).toEqual([]);
    const drop = v0.actions.find((a) => a.op?.op === "add_call" && a.op.ref === "notify_me")!;
    const v1 = (await canvasAct("W", "F", { state: v0.state, sig: v0.sig, actionId: drop.id })) as View & { requesterPorts: Array<{ stepId: string; port: string }> };
    expect(v1.requesterPorts.map((r) => r.port)).toEqual(["to"]);
    const typed = v1.actions.find((a) => a.where.at === "port" && a.where.port === "to" && a.slot)!;
    const v2 = (await canvasAct("W", "F", { state: v1.state, sig: v1.sig, actionId: typed.id, value: "ops@acme-corp.com" })) as View & { requesterPorts: unknown[] };
    expect(v2.requesterPorts).toEqual([]);
  });

  // I-311/D-342: the working copy is marked as such, with what its goal asked that it does not do — a screen can then show a
  // finished-but-withheld flow as that, instead of nothing.
  it("a working copy opens marked `working`, with the build's unmet parts; a revision does not", async () => {
    expect((await canvasOpen("W", "F")) as { working?: unknown }).not.toHaveProperty("working");
    getIncomplete.mockResolvedValueOnce({ model: emptyFlow("f-engine"), stale: false, diagnostics: [], build: { trace: { unmet: ["the goal also says “x”"] } } });
    expect(((await canvasOpen("W", "F")) as { working?: unknown }).working).toEqual({ notBuilt: ["the goal also says “x”"] });
  });

  it("saves incomplete as the working copy, and complete as a revision through writeRevision", async () => {
    const v0 = (await canvasOpen("W", "F")) as View;
    const drop = v0.actions.find((a) => a.op?.op === "add_reader" && a.op.ref === "store.people")!;
    const v1 = (await canvasAct("W", "F", { state: v0.state, sig: v0.sig, actionId: drop.id })) as View;
    expect(await canvasSave("W", "F", { state: v1.state, sig: v1.sig }, { kind: "user" } as never)).toEqual({ status: "incomplete", holes: 1 });
    expect(saveIncomplete).toHaveBeenCalledTimes(1);
    expect(writeRevision).not.toHaveBeenCalled();
    const result = v1.actions.find((a) => a.op?.op === "set_output")!;
    const v2 = (await canvasAct("W", "F", { state: v1.state, sig: v1.sig, actionId: result.id })) as View;
    expect(await canvasSave("W", "F", { state: v2.state, sig: v2.sig }, { kind: "user" } as never)).toEqual({ status: "complete", revision: 7 });
    expect(writeRevision).toHaveBeenCalledWith("W", expect.anything(), expect.objectContaining({ id: "f-engine" }), expect.anything(), {}, false, { origin: "canvas" });
    expect(clearIncomplete).toHaveBeenCalledTimes(1);
  });

  it("a new flow built by hand is an empty flow whose engine id is its own uuid — no revision, nothing deployed", async () => {
    const { flowId } = await canvasCreate("W", "Weekly digest");
    expect(created.at(-1)).toMatchObject({ id: flowId, workspaceId: "W", name: "Weekly digest", draftRevision: 0, status: "draft" });
    expect((created.at(-1) as { kestraFlowId: string }).kestraFlowId).toBe(`f-${flowId}`);
    expect(writeRevision).not.toHaveBeenCalled();
  });
});
