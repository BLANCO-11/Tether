/**
 * Two decisions a chat's save makes about a workflow that may have changed since the chat last saved it
 * (sharing-boundaries P2-I2). Pure, so they are pinned by tests rather than by reading `saveVersion`.
 */
import type { PiRunAs } from "../services/run-as.service.js";

type Model = { workflow?: unknown; files?: unknown } | null | undefined;

/** Did the WORKFLOW (its steps and files) change between two saved versions? Whose account it runs as is not that. */
export function workflowChanged(base: Model, current: Model): boolean {
  const content = (m: Model) => JSON.stringify({ w: m?.workflow ?? null, f: m?.files ?? null });
  return content(base) !== content(current);
}

/** The account a save records for one service: what this chat chose, else what the saved workflow already had. */
export function keptChoice(piece: string, chatChose: Record<string, unknown>, saved: Record<string, PiRunAs> | undefined): PiRunAs | null {
  return chatChose[piece] ? null : (saved?.[piece] ?? null);
}
