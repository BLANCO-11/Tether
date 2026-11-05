import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { pool, hrPool } from "./db/index.js";
import { opsRouter } from "./routes/ops.js";
import { adminRouter } from "./routes/admin.js";

/**
 * ops-api — the operational tool layer, on :4004.
 *
 * Fourteen HTTP endpoints over synthetic HR data, plus a flaky probe and an LLM
 * text-transformation tool. Every one of them authenticates. This used to be
 * `/stub-api/*` inside the parent Express app; see `routes/ops.ts` for what the
 * move changed and why it was not cosmetic.
 *
 * ⚠ ALL DATA IS SYNTHETIC. Nothing here sends mail, posts to a chat service or
 * files a ticket anywhere. Every write lands in a capture table in this
 * service's own database.
 *
 * ⚠ ONE EXCEPTION, added in Stage 6: `POST /llm/complete` makes a real outbound
 * request to a configured LLM gateway with a billable credential. It is the only
 * route here that talks to anything outside the stack, and the only one whose
 * output is non-deterministic. Read the header comment above it and
 * `config.llm` before adding a second — the bounds it runs under are the reason
 * "the tool layer holds nothing worth stealing" is still roughly true.
 */
const app = express();
app.disable("x-powered-by");
/**
 * Express 5 changed two defaults this service was written against; keep Express 4's. `query parser` "extended" (qs)
 * keeps `?a[b]=1` an object, and `req.body` stays `{}` when nothing parsed one (body-parser 2 leaves it `undefined`).
 * Set before any parser, which still parses a body that arrives.
 */
app.set("query parser", "extended");
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});
/**
 * ⚠ TWO parsers, and the order is the point — see `config.llm.maxBodyBytes`.
 *
 * `/llm/*` is mounted FIRST with the larger limit so that an oversize `input`
 * reaches the handler and is refused by **`maxInputChars`'s 422**, which names
 * both numbers and the remedy. Under a single 1 MB parser that 422 was
 * unreachable for every body over 1 MB, and body-parser's error arrived at the
 * last-resort handler below as `500 internal` — a caller mistake reported as our
 * fault. body-parser skips a request whose body is already parsed, so the global
 * parser below is a no-op for these two routes rather than a second opinion.
 */
app.use("/llm", express.json({ limit: config.llm.maxBodyBytes }));
app.use(express.json({ limit: "1mb" }));

/**
 * Liveness AND the database boundary, in one probe.
 *
 * It reports which databases it can reach, because "ops-api is up" and "ops-api
 * is up and correctly walled off" are different facts and only the second one is
 * worth a green tick. `parentReachable` should always be false; `kestra:check`
 * asserts it by attempting the connection itself rather than trusting this
 * field, since a service reporting on its own containment is the weakest
 * possible evidence.
 */
app.get("/healthz", async (_req, res) => {
  const probe = async (p: typeof pool) => {
    try {
      await p.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  };
  const [ops, hr] = await Promise.all([probe(pool), probe(hrPool)]);
  res.status(ops ? 200 : 503).json({ ok: ops, databases: { ops, hr } });
});

app.use("/admin", adminRouter);
app.use("/", opsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "not_found", message: "no such endpoint — GET / lists them" } });
});

// Last resort. An unhandled error must not leak a stack or a DSN to a caller
// that is, by construction, running generated code.
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  /**
   * ⚠ An oversize body is the CALLER's problem and must say so.
   *
   * body-parser throws with `type: "entity.too.large"` and a 413 status, and this
   * handler used to flatten it — like everything else — into
   * `500 {"code":"internal"}`. That is the worst available answer: it tells a
   * caller the fault is ours, on the one failure they can fix themselves, and it
   * hid the fact that this service had a 1 MB transport cap in front of a route
   * documented as accepting 32,000 characters of text.
   *
   * Named `payload_too_large` rather than the generic `internal`, and the limit
   * is stated so acting on it needs no guesswork. No part of the body is echoed
   * or logged — at this size it is both tenant data and unreadable.
   */
  const type = (err as { type?: string }).type;
  if (type === "entity.too.large") {
    const limit = (err as { limit?: number }).limit;
    console.error(`[ops-api] 413 body too large on ${req.method} ${req.originalUrl} limit=${limit}`);
    return res.status(413).json({
      error: {
        code: "payload_too_large",
        message:
          `the request body is larger than this endpoint accepts` +
          (limit ? ` (${limit.toLocaleString("en-US")} bytes)` : "") +
          `. Reduce it upstream — for /llm/complete, note that \`input\` is additionally ` +
          `capped at ${config.llm.maxInputChars.toLocaleString("en-US")} characters, which is ` +
          `the bound worth designing to.`,
      },
    });
  }
  console.error("[ops-api] unhandled:", err.message);
  res.status(500).json({ error: { code: "internal", message: "internal error" } });
});

const server = app.listen(config.port, () => {
  console.log(`[ops-api] listening on :${config.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void Promise.all([pool.end(), hrPool.end()]).finally(() => process.exit(0));
    });
  });
}
