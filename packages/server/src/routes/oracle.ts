import { Router } from "express";
import { asyncHandler } from "../middleware/error.middleware.js";
import { expectedScreening } from "../demo/hr-dataset.js";

/**
 * The correctness oracle — a TEST surface, and named like one.
 *
 * `expectedScreening()` computes the right answer for the attendance-screening
 * task from the DATASET DEFINITION: which employees fall below their
 * department's threshold, which are excluded, which cannot be mailed, which
 * bounce. It does not run a flow, read a flow's output, or consult anything a
 * generated step produced. That independence is the whole point — it is what
 * makes "was the automation right?" a check rather than an opinion, and it is
 * how the measured "emailed 0 of 11 and still reported success" was caught.
 *
 * ── Why it moved off `/api/demo/*` ──────────────────────────────────────────
 *
 * It used to sit beside the Outbox reads under a prefix that also, historically,
 * carried `POST /provision` and `POST /reset`. Two unrelated things shared that
 * name: a fixture surface, and this. Mixing them invites the reading that the
 * oracle is part of the demo — decoration that ships alongside it — when it is
 * the measuring instrument the demo is scored against. It is now the only thing
 * under `/api/test-oracle`, so what it is is legible from the URL.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 *
 * It is not a validator, and nothing in the product may call it. A flow that
 * asked the oracle whether it was right would be grading itself against the
 * answer key, and every scenario would pass. It is called by the harnesses
 * (`kestra:prove`, `kestra:phase3/6`, `e2e:ui`, `showcase:verify`) and by the
 * client's read-only comparison view, both of which are outside the thing being
 * measured.
 *
 * It answers only for the primary `hr_demo` dataset. The swap rehearsal has its
 * own separate oracle function on purpose — a shared, parameterised one would
 * let a shared bug produce a wrong answer that agrees with itself.
 */
export const oracleRouter = Router();

oracleRouter.get(
  "/screening",
  asyncHandler(async (req, res) => {
    const period = typeof req.query.period === "string" ? req.query.period : undefined;
    res.json({
      note:
        "Computed from the dataset definition, independently of any flow. " +
        "Not a validator — nothing in the product may call this.",
      ...expectedScreening(period),
    });
  }),
);
