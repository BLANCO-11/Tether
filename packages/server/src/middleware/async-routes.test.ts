// A rejected route promise must become a RESPONSE, not the end of the process.
// See `async-routes.ts` for the outage this closes.
import { describe, it, expect } from "vitest";
import express from "express";
import { wrapAsyncRoutes } from "./async-routes.js";
import { errorHandler } from "./error.middleware.js";
import { requestId } from "./request-id.middleware.js";

/** Stand up a tiny app with one throwing async handler and no try/catch. */
function appWith(thrown: unknown) {
  const app = express();
  app.use(requestId);
  const r = express.Router();
  r.get("/boom", async () => {
    throw thrown;
  });
  app.use("/t", r);
  app.use(errorHandler);
  return app;
}

async function call(app: express.Express, path: string) {
  const srv = app.listen(0);
  try {
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    srv.close();
  }
}

describe("wrapAsyncRoutes", () => {
  it("routes a rejected async handler to the error middleware", async () => {
    const app = appWith(new Error("kaboom"));
    expect(wrapAsyncRoutes(app)).toBeGreaterThan(0);
    const { status, body } = await call(app, "/t/boom");
    expect(status).toBe(500);
    expect(body.error).toBe("internal_error");
  });

  /**
   * ⚠ The reported defect, end to end. Postgres `22P02` on a non-uuid had a
   * correct `400` branch in `error.middleware.ts` the whole time; a rejected
   * promise never reached it, so the process died instead.
   */
  it("makes error.middleware's 22P02 branch reachable — the reported outage", async () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "ws_it"'), {
      code: "22P02",
    });
    const app = appWith(pgErr);
    wrapAsyncRoutes(app);
    const { status, body } = await call(app, "/t/boom");
    expect(status).toBe(400);
    expect(body.error).toBe("request_error");
  });

  /**
   * ⚠ WHAT CHANGED UNDER EXPRESS 5. This was the control — under Express 4 the unwrapped request answered nothing and
   * the rejection escaped, which is the outage this module was written for. Express 5's router forwards a rejected
   * handler to the error middleware itself, so the outage cannot happen even unwrapped, and the wrap above is now a
   * second layer rather than the only one. Asserted, so a router that stopped doing it would turn this red.
   */
  it("Express 5 forwards an UNWRAPPED rejection to the error middleware itself", async () => {
    const app = appWith(new Error("kaboom"));
    const seen: unknown[] = [];
    const onRejection = (r: unknown) => seen.push(r);
    process.on("unhandledRejection", onRejection);
    try {
      // No wrapAsyncRoutes call.
      const { status, body } = await call(app, "/t/boom");
      expect(status).toBe(500);
      expect(body.error).toBe("internal_error");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(seen).toEqual([]);
  });

  it("leaves a 4-arg error handler alone — wrapping one would unregister it", () => {
    const app = express();
    const r = express.Router();
    r.get("/x", (_req, res) => res.json({ ok: true }));
    app.use("/t", r);
    app.use(errorHandler);
    const n = wrapAsyncRoutes(app);
    // errorHandler is 4-arity and must not be counted.
    expect(n).toBeGreaterThan(0);
    // A second walk wraps nothing: idempotent.
    expect(wrapAsyncRoutes(app)).toBe(0);
  });
});

describe("the real app", () => {
  /**
   * ⚠ **A FLOOR, NOT A BOOLEAN.** The walk reads Express's internal layer
   * stack; if that shape changes it would match nothing, wrap nothing, and this
   * module would read as fixed while every route was one bad query string away
   * from taking the deployment down again. ~90 handlers across 27 route files
   * share the shape, so 50 is a conservative floor that still fails loudly on a
   * walk that stopped working.
   */
  it("wraps the whole mounted surface", async () => {
    const { createApp } = await import("../app.js");
    // ⚠ The COUNT is read from the boot line, not from a re-walk. A re-walk
    // returning 0 is satisfied by a walk that never matched anything — which is
    // the exact failure this floor exists to catch.
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    let app: ReturnType<typeof createApp>;
    try {
      app = createApp();
    } finally {
      console.log = log;
    }
    const boot = lines.find((l) => l.includes("async route guard active on"));
    expect(boot).toBeTruthy();
    const n = Number(/on (\d+) handlers/.exec(boot!)?.[1]);
    expect(n).toBeGreaterThan(200);
    // And it is idempotent: nothing is left unwrapped for a second walk.
    expect(wrapAsyncRoutes(app!)).toBe(0);
  });
});
