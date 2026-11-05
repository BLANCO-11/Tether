/**
 * Forge-authored chat surface cards (list / choice) — allowlisted JSON only, no free HTML.
 * Shown mid-turn like edge Approve; `ask` pauses until the person acts.
 * Info actions are agent-defined (id, label, payload); a click resumes Forge with that context — no hardcoded handlers.
 */
import { z } from "zod";
import type { PiSurface, PiSurfaceAction, PiSurfaceItem } from "./types.js";

const ACTION_ID = /^[a-z][a-z0-9_]{0,63}$/;
const ITEM_ID = /^[A-Za-z0-9._:@+/-]{1,128}$/;

const itemSchema = z
  .object({
    id: z.string().regex(ITEM_ID),
    title: z.string().min(1).max(200),
    subtitle: z.string().max(400).optional(),
    tone: z.enum(["ok", "warn", "danger", "neutral", "muted"]).optional(),
    meta: z.string().max(200).optional(),
  })
  .strict();

/** Flat context Forge wants back when the person clicks — keys bounded, values scalars only. */
const actionPayloadSchema = z
  .record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((o) => Object.keys(o).length <= 20, { message: "Action payload may have at most 20 keys." });

const actionSchema = z
  .object({
    id: z.string().regex(ACTION_ID),
    label: z.string().min(1).max(80),
    style: z.enum(["primary", "ghost"]).optional(),
    itemId: z.string().regex(ITEM_ID).optional(),
    payload: actionPayloadSchema.optional(),
  })
  .strict();

export const surfaceSchema = z
  .object({
    mode: z.enum(["info", "ask"]),
    type: z.enum(["list", "choice"]),
    title: z.string().min(1).max(200),
    subtitle: z.string().max(400).optional(),
    items: z.array(itemSchema).min(1).max(50),
    actions: z.array(actionSchema).max(20).optional(),
    multi: z.boolean().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.type === "list" && s.mode === "ask") {
      ctx.addIssue({ code: "custom", message: 'A list card cannot ask — use type "choice" to ask the person to pick.' });
    }
    if (s.type === "choice" && s.actions?.length) {
      ctx.addIssue({ code: "custom", message: "A choice card has no actions — the person picks from the items." });
    }
    if (s.multi && s.type !== "choice") {
      ctx.addIssue({ code: "custom", message: "multi is only for choice cards." });
    }
    const ids = new Set<string>();
    for (const it of s.items) {
      if (ids.has(it.id)) ctx.addIssue({ code: "custom", message: `Duplicate item id “${it.id}”.` });
      ids.add(it.id);
    }
    for (const a of s.actions ?? []) {
      if (a.itemId && !ids.has(a.itemId)) {
        ctx.addIssue({ code: "custom", message: `Action “${a.id}” names unknown item “${a.itemId}”.` });
      }
    }
  });

export type SurfaceInput = z.infer<typeof surfaceSchema>;

/** Parse Forge's card JSON into a PiSurface (throws zod errors). */
export function parseSurface(raw: unknown): PiSurface {
  const s = surfaceSchema.parse(raw);
  return {
    mode: s.mode,
    type: s.type,
    title: s.title,
    ...(s.subtitle ? { subtitle: s.subtitle } : {}),
    items: s.items as PiSurfaceItem[],
    ...(s.actions?.length ? { actions: s.actions as PiSurfaceAction[] } : {}),
    ...(s.multi ? { multi: true } : {}),
  };
}

/** True when this proposal is an unanswered ask-mode surface. */
export function isPendingAskSurface(p: { kind?: string; status?: string; surface?: { mode?: string } | null }): boolean {
  return p.kind === "surface" && p.status === "pending" && p.surface?.mode === "ask";
}
