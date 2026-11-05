/**
 * The two PUBLIC trigger receivers are the app's only routes that answer an
 * anonymous caller and then do work: `POST /api/triggers/:token/webhook` and
 * `POST /api/triggers/:token/api`. Both look the token up in the database, and
 * on a hit the webhook receiver fires a flow.
 *
 * ── What this is defending ──────────────────────────────────────────────────
 *
 * There was no bound of any kind on that path. Every other surface has one —
 * `requireApiKey` has the auth-failure throttle, generation has
 * `MAX_CONCURRENT_GENERATIONS`, execution starts have the M3 tenant budget — and
 * these two, the only ones reachable with no credential at all, had none. A loop
 * against the receiver path drove unlimited lookups.
 *
 * ⚠ What these tests do NOT claim. This is a DoS bound keyed on IP, so it is not
 * an authentication control (the token is), and it does not bound flow
 * executions (the M3 budget does). Both statements are in the route's docblock
 * for the same reason they are here: a limiter is easy to mistake for the thing
 * keeping callers out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

// Set BEFORE `config` is imported below — the ceiling is read at module load, and
// a 3-request window keeps this suite three requests long instead of sixty.
process.env.PUBLIC_RECEIVER_RATE_PER_MINUTE = "3";

vi.mock("../services/trigger.service.js", () => ({
  triggerService: {
    // Every lookup misses: this file is about what happens BEFORE the lookup, and
    // a 404 is a clean way to see that a request got through to it.
    getByWebhookToken: vi.fn(async () => null),
    fire: vi.fn(),
    fires: vi.fn(),
    validateFireInputs: vi.fn(),
  },
  createTriggerSchema: {},
  updateTriggerSchema: {},
}));
vi.mock("../services/credential-provider.service.js", () => ({
  credentialProviderService: { resolveCredential: vi.fn(async () => null) },
}));

const { webhookRouter, apiTriggerRouter, resetReceiverLimiterForTests } = await import(
  "./triggers.js"
);
const { errorHandler } = await import("../middleware/error.middleware.js");
const { config } = await import("../config/index.js");

const LIMIT = config.publicReceiverRatePerMinute;

const app = express();
app.use(express.json());
app.use("/api/triggers", webhookRouter);
app.use("/api/triggers", apiTriggerRouter);
app.use(errorHandler);

let base = "";
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    // Express 5 hands a listen failure to this callback; passing `resolve` straight in would resolve on it.
    server = app.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => resetReceiverLimiterForTests());

const post = (path: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

describe("the public receivers are rate limited", () => {
  it("lets exactly `max` requests through, then answers 429 with Retry-After", async () => {
    expect(LIMIT).toBe(3); // the env above took effect; otherwise this suite proves nothing

    for (let i = 0; i < LIMIT; i++) {
      const res = await post("/api/triggers/tok/webhook");
      expect(res.status, `request ${i + 1} of ${LIMIT} must not be limited`).toBe(404);
    }

    const limited = await post("/api/triggers/tok/webhook");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: "rate_limited" });
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  /**
   * ⚠ One limiter across both receivers, on purpose. Two would let a caller
   * spend the full allowance twice against the same database lookup, which is
   * the thing being bounded.
   */
  it("shares one allowance across both receivers", async () => {
    for (let i = 0; i < LIMIT; i++) await post("/api/triggers/tok/webhook");

    const other = await post("/api/triggers/tok/api");
    expect(other.status).toBe(429);
  });

  /**
   * ⚠ THE CONTROL. A limiter that refuses the first request is an outage, and it
   * would present as "webhooks are broken" rather than as a security decision.
   */
  it("CONTROL — an ordinary single call is not limited, and reaches the lookup", async () => {
    const res = await post("/api/triggers/tok/webhook");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
  });

  /**
   * The token is the credential and it is in the path, so it must not be copied
   * into the log line the refusal writes.
   */
  it("never logs the token it refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i <= LIMIT; i++) await post("/api/triggers/super-secret-token/webhook");

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.flat().map((c) => JSON.stringify(c)).join(" ");
    expect(logged).not.toContain("super-secret-token");
    warn.mockRestore();
  });
});
