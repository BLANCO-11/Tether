// src/lib/secret-edit.ts — the rules behind editing a secret in place, as pure
// functions. ui-upgrade Phase 8.4, D-110.
//
// ── WHY THESE ARE NOT IN THE COMPONENT ──────────────────────────────────────
//
// Three of them decide whether a credential's name moves and what the PATCH body
// contains, and jsdom cannot watch a person type. Same seam the canvas
// (`lib/flow-authoring.ts`) and the trigger groups (`lib/trigger-groups.ts`)
// were extracted onto, for the same reason: the component reports intents and
// the rules are somewhere a test can reach them.
//
// ⚠ **None of this is the control.** `workspaceSecretService.update` refuses a
// rename that orphans a reference with a 409 unless `confirmOrphans: true`
// arrives. What lives here is the readable half — asking first, showing what
// breaks, and sending the flag only when it has actually been acknowledged.
import type { SecretImpact, WorkspaceSecret } from "./types";

// Ours, not the shared package's: the client must not import `@foundry/shared`
// by its ROOT specifier — the index re-exports the egress module, which pulls
// `node:dns` into the Next build and fails `next build` outright. The mirror is
// the merge ruling (D-28): the client keeps its own vocabulary where the shared
// list is a server-side concern.
//
// ⚠ **The root is what is banned, not the package — 2026-09-17.** `./rules` is
// an exports subpath whose module imports NOTHING, so `@foundry/shared/rules`
// is browser-safe and is what the access-policy vocabulary travels on. The
// blanket wording above was read as permission to import the root, which broke
// the web image build; a subpath is how a genuinely shared list stays one
// definition (D-197) instead of becoming a mirror that drifts.
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EditDraft = {
  name: string;
  description: string;
  /** ⚠ A REPLACEMENT, never the stored one. There is no endpoint that reads a value. */
  value: string;
};

export type EditState = {
  renaming: boolean;
  nameInvalid: boolean;
  /** What the rename would orphan. Empty unless the name is actually moving. */
  orphans: SecretImpact["references"];
  /** True when the orphan list has to be acknowledged before saving. */
  needsAck: boolean;
  nameTaken: boolean;
};

/**
 * ⚠ `impact` is only consulted while the name is moving, and `orphans` is empty
 * otherwise even when the impact object says otherwise.
 *
 * `GET …/:id/impact` with no `name` reports what references the CURRENT name —
 * a useful answer for a delete, and the wrong one for an edit that is only
 * changing a description. Reading it unconditionally would put "3 things break"
 * over an edit that breaks nothing, which is how a warning stops being read.
 */
export function editState(
  secret: WorkspaceSecret,
  draft: EditDraft,
  impact: SecretImpact | null,
): EditState {
  const renaming = draft.name !== secret.name;
  const orphans = renaming ? (impact?.references ?? []) : [];
  return {
    renaming,
    nameInvalid: draft.name !== "" && !ENV_NAME_RE.test(draft.name),
    orphans,
    needsAck: orphans.length > 0,
    nameTaken: renaming && Boolean(impact?.nameTaken),
  };
}

/**
 * Whether Save is refused, and it fails CLOSED in one specific place: while a
 * rename's impact has not come back yet.
 *
 * ⚠ An unanswered impact must not read as "nothing breaks". The consequence of
 * this rename is invisible afterwards — nothing is suspended, no fingerprint
 * moves, no manifest changes, and the first sign is a 401 inside a run — so
 * saving into an unknown is the one direction that cannot be undone by looking.
 */
export function saveBlocked(
  state: EditState,
  draft: EditDraft,
  opts: { impactKnown: boolean; accepted: boolean; busy: boolean },
): boolean {
  if (opts.busy) return true;
  if (!draft.name.trim() || state.nameInvalid) return true;
  if (state.renaming && !opts.impactKnown) return true;
  if (state.nameTaken) return true;
  if (state.needsAck && !opts.accepted) return true;
  return false;
}

/**
 * The PATCH body — and everything it LEAVES OUT is deliberate.
 *
 * - `value` is omitted when the box is blank, so "leave it blank to keep the
 *   current one" is true rather than a sentence over a field that writes `""`.
 * - `name` is omitted when it has not moved, so an ordinary description edit
 *   never travels down the rename path at all.
 * - ⚠ `confirmOrphans` is sent ONLY when something is actually being
 *   acknowledged. A client that always sends `true` has turned the server's
 *   refusal off from the outside — the flag would then be a field that exists
 *   and never refuses, which reads exactly like one that works.
 */
export function patchFor(
  secret: WorkspaceSecret,
  draft: EditDraft,
  state: EditState,
): {
  name?: string;
  description?: string;
  value?: string;
  confirmOrphans?: boolean;
} {
  return {
    ...(state.renaming ? { name: draft.name.trim() } : {}),
    ...(draft.value ? { value: draft.value } : {}),
    ...(draft.description !== (secret.description ?? "") ? { description: draft.description } : {}),
    ...(state.needsAck ? { confirmOrphans: true } : {}),
  };
}

/**
 * What the toast says. A rename that orphaned something says so — the write
 * SUCCEEDED and left references pointing at nothing, and a bare "Saved" is the
 * false green this whole phase is about.
 */
export function savedMessage(
  secretName: string,
  rename: { to: string; orphaned: unknown[] } | null,
): string {
  if (!rename) return `${secretName} updated.`;
  if (rename.orphaned.length === 0) return `Renamed to ${rename.to}.`;
  return (
    `Renamed to ${rename.to}. ${rename.orphaned.length} reference(s) now point at a name ` +
    "nothing holds — they will fail to sign in."
  );
}
