import { Router, type Request, type Response, type NextFunction } from "express";
import { desc, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import {
  clearProvider,
  listModels,
  loadProvider,
  ProviderError,
  saveProvider,
  testCompletion,
  viewOf,
} from "../llm/provider.js";

/**
 * The operator surface: read the five capture tables, and truncate them.
 *
 * ── Why this exists rather than a second database credential in the parent ──
 *
 * The parent still needs to render the Outbox page and the harnesses still need
 * to assert "which tools did the automation actually call?". The obvious way to
 * keep both working is to hand `packages/server` the ops DSN and let it SELECT.
 * That would leave Stage 5 half-done: the tool layer would be a separate process
 * whose database the control plane still reaches, so a compromise of the parent
 * still reads and writes everything the tool layer holds, and the only thing the
 * move bought is a second port.
 *
 * Reading over HTTP with the root key instead means the boundary is a network
 * hop with an allowlist at the far end. The parent can read these four tables
 * and cannot reach anything else in the ops database — no arbitrary SQL, no
 * table it was not given, no writes except the one truncate.
 *
 * ── Why the ROOT key and not a service key ──────────────────────────────────
 *
 * The five service keys are what an *automation* presents; they are seeded into
 * `workspace_secrets` and are therefore reachable by a generated step. Reset is
 * destructive and the call log is the audit trail *of* those automations — a
 * tool step being able to erase the record of its own calls would make the log
 * worth exactly nothing. So this surface takes `OPS_API_KEY` itself, which is
 * held by the parent process and by nothing that runs inside a flow.
 */
export const adminRouter = Router();

function requireRootKey(req: Request, res: Response, next: NextFunction) {
  const presented = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
  if (presented === config.apiKey) return next();
  res.status(401).json({
    error: {
      code: "unauthorized",
      message:
        "the operator surface requires the ops root key as an Authorization: Bearer token " +
        "(OPS_API_KEY). A per-service tool credential is deliberately not accepted here.",
    },
  });
}
adminRouter.use(requireRootKey);

/**
 * The tables the parent may read, by name.
 *
 * An allowlist rather than a `:table` parameter passed to SQL. The four values
 * are the whole point — the alternative reads a caller-supplied identifier into
 * a query, which is the exact class of bug that moving this service out of the
 * parent was meant to stop mattering. It should not matter here either.
 */
const READABLE = {
  mail: { table: schema.mailOutbox, order: schema.mailOutbox.sentAt },
  chat: { table: schema.chatMessages, order: schema.chatMessages.postedAt },
  tickets: { table: schema.tickets, order: schema.tickets.createdAt },
  pages: { table: schema.pages, order: schema.pages.pagedAt },
  "call-log": { table: schema.apiCallLog, order: schema.apiCallLog.calledAt },
} as const;
type Readable = keyof typeof READABLE;

adminRouter.get("/records/:name", async (req, res, next) => {
  try {
    const name = req.params.name as Readable;
    const entry = READABLE[name];
    if (!entry) {
      res.status(404).json({
        error: {
          code: "not_found",
          message: `unknown record set "${req.params.name}" — one of ${Object.keys(READABLE).join(", ")}`,
        },
      });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 1000);
    // Newest first. The old `stub_*` reads were oldest-first by accident of
    // insertion order, and a page of the oldest 100 rows in a 2000-row log is
    // indistinguishable from an empty log to anyone checking a recent run.
    const rows = await db.select().from(entry.table).orderBy(desc(entry.order)).limit(limit);
    res.json({ records: rows, count: rows.length, limit });
  } catch (e) {
    next(e);
  }
});

/**
 * Clear ONE capture table.
 *
 * The Email box's "Clear test inbox" button rides this with `:name = "mail"`.
 * `POST /reset` below truncates all five tables plus the probe counter, which
 * is a broader action than that button's label promises — so the button needs
 * a scoped clear, and the scope is this allowlist, not a caller-supplied
 * identifier. Unknown names 404 exactly like the record read above.
 *
 * Plain `DELETE` rather than `TRUNCATE ... RESTART IDENTITY`: no identity
 * column is consumed by inserts (uuid defaults), and `DELETE` returns the row
 * count the caller confirms with.
 */
adminRouter.delete("/records/:name", async (req, res, next) => {
  try {
    const name = req.params.name as Readable;
    const entry = READABLE[name];
    if (!entry) {
      res.status(404).json({
        error: {
          code: "not_found",
          message: `unknown record set "${req.params.name}" — one of ${Object.keys(READABLE).join(", ")}`,
        },
      });
      return;
    }
    const deleted = await db.delete(entry.table);
    res.json({ ok: true, cleared: deleted.rowCount ?? 0, set: name });
  } catch (e) {
    next(e);
  }
});

/**
 * Truncate all four tables.
 *
 * `demo:reset` used to do this with a SQL `TRUNCATE stub_*` inside the parent;
 * it now calls here. It resets the flaky probe's attempt counter as a side
 * effect, because that counter is derived from the call log rather than kept in
 * memory — see the `/flaky` handler.
 */
adminRouter.post("/reset", async (_req, res, next) => {
  try {
    // ⚠ `llm_provider` is NOT in this list. Reset exists to clear the record of
    // automation runs between harness passes; the provider configuration is
    // operator state, and wiping a pasted credential every time a test suite
    // starts would be a reset that breaks the thing it was meant to prepare.
    await db.execute(
      sql`TRUNCATE mail_outbox, chat_messages, tickets, pages, api_call_log RESTART IDENTITY`,
    );
    res.json({
      ok: true,
      truncated: ["mail_outbox", "chat_messages", "tickets", "pages", "api_call_log"],
    });
  } catch (e) {
    next(e);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM PROVIDER — the operator surface
// ═══════════════════════════════════════════════════════════════════════════
//
// ── Why this is on the ADMIN surface and not a tool route ───────────────────
//
// A flow calls `POST /llm/complete` with a service credential seeded into
// `workspace_secrets`, which means anything running inside a flow can reach it.
// Choosing the provider and pasting the billable key is the opposite kind of
// act: it is operator configuration, and it takes `OPS_API_KEY`, which the
// parent process holds and nothing inside a flow does. The same separation the
// reset route already relies on.
//
// ── What is never returned ──────────────────────────────────────────────────
//
// The provider key. Not on GET, not after PUT, not behind a `?reveal=`. The
// parent has deliberately had no endpoint that returns a secret value since long
// before this file existed, and a config page is exactly where that rule gets
// quietly broken "so the operator can check what they pasted". `keyFingerprint`
// answers that question instead — eight hex characters of a salted digest, which
// distinguishes two keys and reconstructs neither.

adminRouter.get("/llm/provider", async (_req, res, next) => {
  try {
    res.json(viewOf(await loadProvider()));
  } catch (e) {
    next(e);
  }
});

adminRouter.put("/llm/provider", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim() : "";
    if (!/^https?:\/\/.+/.test(baseUrl)) {
      res.status(400).json({
        error: {
          code: "bad_request",
          message:
            "baseUrl must be an http(s) URL ending at the OpenAI-compatible root, " +
            "e.g. https://gateway.example/v1",
        },
      });
      return;
    }
    // Absent means keep; empty string is rejected rather than silently storing a
    // blank credential, which would present later as a 401 from the provider.
    let apiKey: string | undefined;
    if (b.apiKey !== undefined && b.apiKey !== null) {
      if (typeof b.apiKey !== "string" || !b.apiKey.trim()) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "apiKey must be a non-empty string, or omitted entirely to keep the stored one",
          },
        });
        return;
      }
      apiKey = b.apiKey.trim();
    }

    const allowedModels = Array.isArray(b.allowedModels)
      ? [...new Set(b.allowedModels.map((m) => String(m).trim()).filter(Boolean))]
      : [];
    const defaultModel = typeof b.defaultModel === "string" ? b.defaultModel.trim() : "";
    if (defaultModel && !allowedModels.includes(defaultModel)) {
      // Otherwise the default is a model every call is refused for, and the
      // error a flow gets names the model it did not choose.
      res.status(400).json({
        error: {
          code: "bad_request",
          message: `defaultModel "${defaultModel}" must also appear in allowedModels`,
          details: { allowedModels },
        },
      });
      return;
    }

    const saved = await saveProvider({ baseUrl, apiKey, defaultModel, allowedModels });
    res.json(viewOf(saved));
  } catch (e) {
    next(e);
  }
});

/** Forget the stored row; the environment variables become live again. */
adminRouter.delete("/llm/provider", async (_req, res, next) => {
  try {
    res.json(viewOf(await clearProvider()));
  } catch (e) {
    next(e);
  }
});

/**
 * The models the gateway advertises, for the operator to choose an allowlist
 * from — optionally against credentials that have not been saved yet, so the
 * page can populate the list as soon as a key is pasted.
 *
 * ⚠ A successful listing is NOT evidence that completions work, and this
 * response says so in the payload rather than in a comment nobody reads. It is
 * the same false green as `GET /api/tether/health`'s `llmConnected: true`, which
 * "verifies" the LLM by listing models — a gateway enumerates models happily for
 * a key with no quota, no access and no billing. `POST /llm/test` is the
 * evidence.
 */
adminRouter.post("/llm/models", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const stored = await loadProvider();
    const probe = {
      ...stored,
      baseUrl: typeof b.baseUrl === "string" && b.baseUrl.trim() ? b.baseUrl.trim().replace(/\/+$/, "") : stored.baseUrl,
      apiKey: typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : stored.apiKey,
    };
    const models = await listModels(probe);
    res.json({
      models,
      caveat:
        "The gateway listed these models. That is not proof the key can complete with any of " +
        "them — listing succeeds for a key with no quota or no access. Run the test completion.",
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status).json({ error: { code: e.code, message: e.message } });
      return;
    }
    next(e);
  }
});

/** A real completion — the only thing that proves the configuration works. */
adminRouter.post("/llm/test", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const stored = await loadProvider();
    const probe = {
      ...stored,
      baseUrl: typeof b.baseUrl === "string" && b.baseUrl.trim() ? b.baseUrl.trim().replace(/\/+$/, "") : stored.baseUrl,
      apiKey: typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : stored.apiKey,
    };
    const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined;
    const result = await testCompletion(probe, model);
    res.json({
      ok: true,
      model: result.model,
      text: result.text,
      latencyMs: result.latencyMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status).json({ ok: false, error: { code: e.code, message: e.message } });
      return;
    }
    next(e);
  }
});
