/**
 * `GatewayInference` and the model that refuses the temperature we send.
 *
 * -----------------------------------------------------------------------------
 * REPORTED FROM USE (2026-09-04) -- and found by a DIFFERENT failure
 * -----------------------------------------------------------------------------
 *
 * `llm_complete` was failing for every flow, which was ops-api's provider. That
 * was fixed, `llm_complete` started working, and this client -- the generation
 * one -- was still broken, because the two are deliberately separate (D-35) and
 * the generation model is its own row (`generation_llm`, D-115). Both were
 * pointing at `gpt-5.6-luna`.
 *
 * WARNING: The blast radius here is wider than one step kind. `draftFlow`,
 * `authorFlow`, every chat turn, fragment generation and sandbox fixtures all
 * come through `GatewayInference.complete`, so a model that refuses the value
 * stops anything being authored at all -- which is how this was found: a
 * `sandbox:provision` run died on its first table with a 400 about temperature.
 *
 * The four properties below are the control. The second and third are what stop
 * the fix being "retry any 400 with less in it"; the FIRST is what stops it
 * silently moving every generation measurement in this repo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayInference, InferenceError } from "./inference.service.js";

const REFUSAL =
  '{"error":{"message":"litellm.BadRequestError: AzureException BadRequestError - ' +
  "Unsupported value: 'temperature' does not support 0 with this model. " +
  'Only the default (1) value is supported.. Received Model Group=gpt-5.6-luna"}}';

const OK = JSON.stringify({
  choices: [{ finish_reason: "stop", message: { content: "the answer" } }],
});

function stub(replies: Array<{ status: number; body: string }>) {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const r = replies[sent.length - 1];
    if (!r) throw new Error(`unexpected call ${sent.length}`);
    return new Response(r.body, { status: r.status });
  });
  return sent;
}

const client = () => new GatewayInference("https://gw.example/v1", "sk-k", "gpt-5.6-luna");

describe("GatewayInference — a model that refuses the temperature we send", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * ⚠ **THE VALUE IS STATED HERE, AS A LITERAL, ON PURPOSE.**
   *
   * It was `0` until 2026-09-17 and this test asserted so, with the comment
   * below — kept, because it is still the right reason to state the number:
   *
   * > The control on the whole change. `draft:measure`, `outline:measure`,
   * > `chat:measure` and `kestra:refusal` were all taken against a body
   * > carrying `temperature: 0`, and the first attempt is still exactly that
   * > body. A version that dropped the field pre-emptively would pass the
   * > retry test below and quietly invalidate every number in CLAUDE.md.
   *
   * The number changed by request, and the reasoning survives it: those
   * measurements were taken at 0 and are now **not comparable**, which is a
   * cost to state rather than a reason not to change it. Asserting against the
   * constant instead would make this test agree with any future value — the one
   * thing a test about a product setting must not do.
   */
  it("sends the declared temperature on the first attempt", async () => {
    const sent = stub([{ status: 200, body: OK }]);
    expect(await client().complete("p", { label: "l" })).toBe("the answer");
    expect(sent).toHaveLength(1);
    expect(sent[0].temperature).toBe(1);
  });

  it("retries ONCE without it when the gateway names temperature", async () => {
    const sent = stub([
      { status: 400, body: REFUSAL },
      { status: 200, body: OK },
    ]);
    expect(await client().complete("p", { label: "l" })).toBe("the answer");
    expect(sent).toHaveLength(2);
    expect(sent[0].temperature).toBe(1);
    // Absent, not zero and not null: a gateway that rejects the value rejects
    // it however it is spelled, and `"temperature": null` is still the key.
    expect("temperature" in sent[1]).toBe(false);
    // Everything else about the request is the same request.
    expect(sent[1].model).toBe("gpt-5.6-luna");
    expect(sent[1].messages).toEqual(sent[0].messages);
    expect(sent[1].max_tokens).toBe(sent[0].max_tokens);
  });

  it("does NOT retry a 400 that says nothing about temperature", async () => {
    // Re-sending a malformed prompt reports the SECOND failure, which is the
    // one carrying less about what was actually wrong -- and on this path the
    // first failure is the diagnosis a person acts on.
    const sent = stub([{ status: 400, body: "context_length_exceeded" }]);
    await expect(client().complete("p", { label: "l" })).rejects.toThrow(InferenceError);
    expect(sent).toHaveLength(1);
  });

  it("does not retry twice — a second refusal is returned as it arrived", async () => {
    const sent = stub([
      { status: 400, body: REFUSAL },
      { status: 400, body: REFUSAL },
    ]);
    await expect(client().complete("p", { label: "l" })).rejects.toThrow(/does not support 0/);
    expect(sent).toHaveLength(2);
  });
});

/**
 * WARNING: **THERE ARE TWO SENDERS AND THERE MUST NOT BE A THIRD WITHOUT ITS
 * OWN COPY.** `packages/ops-api/src/llm/provider.ts` carries the same predicate
 * for the runtime path. They are NOT merged (D-35: runtime and generation
 * inference share a provider and nothing else), and the cost of that is exactly
 * what happened on 2026-09-04 -- one was fixed, `llm_complete` recovered, and
 * drafting stayed broken for hours.
 *
 * This reads THIS package off disk and requires the predicate to be here. It
 * cannot see ops-api (a different package with no dependency either way), so it
 * pins the half it can and the comment names the other.
 */
describe("the predicate lives in this file", () => {
  it("is present, with a control that the file was actually read", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./inference.service.ts", import.meta.url), "utf8");
    // The control: a renamed or moved file would read as an empty string and
    // every absence assertion below would pass over nothing (I-38).
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("class GatewayInference");
    expect(src).toContain("function rejectsTemperature");
  });
});

/**
 * ⚠ **The 67-of-67 finding, 2026-09-06.** The retry above is correct and it was
 * paying for itself on every single call: a measured run of the chat builder
 * made 67 gateway requests and every one of them was refused, warned about and
 * re-sent. A chat turn only gets `MAX_TURN_ATTEMPTS` tries, so half of that
 * budget was being spent before the model saw a real prompt.
 *
 * ⚠ The property that must NOT change is the one the file's first test pins:
 * the FIRST call this client ever makes is byte-identical to what it has always
 * sent, so a model that accepts the value is unaffected for ever and no
 * recorded measurement moves.
 */
describe("GatewayInference — the refusal is remembered, not re-discovered", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stops sending temperature after the model has refused it once", async () => {
    const sent = stub([
      { status: 400, body: REFUSAL },
      { status: 200, body: OK },
      { status: 200, body: OK },
      { status: 200, body: OK },
    ]);
    const c = client();
    await c.complete("one", { label: "a" });
    await c.complete("two", { label: "b" });
    await c.complete("three", { label: "c" });

    // Four bodies for three completions: the first call paid the discovery.
    expect(sent).toHaveLength(4);
    expect(sent[0]).toHaveProperty("temperature", 1);
    // Everything after the refusal omits it — no second round trip is spent.
    for (const body of sent.slice(1)) expect(body).not.toHaveProperty("temperature");
  });

  it("warns ONCE, not once per call", async () => {
    // 67 identical warnings is how a real signal becomes something people
    // scroll past — the reason this was not noticed for two days.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stub([
      { status: 400, body: REFUSAL },
      { status: 200, body: OK },
      { status: 200, body: OK },
    ]);
    const c = client();
    await c.complete("one", { label: "a" });
    await c.complete("two", { label: "b" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  /**
   * ⚠ **The control.** Without it the two above are satisfied by a client that
   * never sends `temperature` at all, which would change what every model
   * receives and silently invalidate every generation number in this repo.
   */
  it("keeps sending it for ever to a model that accepts it", async () => {
    const sent = stub([
      { status: 200, body: OK },
      { status: 200, body: OK },
      { status: 200, body: OK },
    ]);
    const c = client();
    await c.complete("one", { label: "a" });
    await c.complete("two", { label: "b" });
    await c.complete("three", { label: "c" });
    expect(sent).toHaveLength(3);
    for (const body of sent) expect(body).toHaveProperty("temperature", 1);
  });

  /** Two deployments, two models: one refusing must not mute the other. */
  it("remembers per client, not globally", async () => {
    const sent = stub([
      { status: 400, body: REFUSAL },
      { status: 200, body: OK },
      { status: 200, body: OK },
    ]);
    const refusing = client();
    await refusing.complete("one", { label: "a" });
    const other = new GatewayInference("https://gw.example/v1", "sk-k", "gemma");
    await other.complete("two", { label: "b" });
    expect(sent[2]).toHaveProperty("temperature", 1);
  });
});
