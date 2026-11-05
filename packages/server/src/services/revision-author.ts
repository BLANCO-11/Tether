/**
 * WHO wrote a revision — and whether this server has any reason to believe it.
 * archive/GAPS.md §1.2 · ISSUES.md I-32
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 *
 * Gate 2 refuses an approval whose approver matches `flow_revisions.created_by`.
 * Since Stage 9.1 the APPROVER side is verified — a signed identity, and the
 * route refuses a body that names one. The AUTHOR side was not: `created_by`
 * came from the verified identity through the browser and from a body field
 * everywhere else, **and the row did not record which**. So the comparison was
 * between one value the server established and one it may merely have been told,
 * and a caller holding the API key could author a flow as `someone-else@…` and
 * approve it as themselves with nothing looking wrong.
 *
 * ── Why a NAME could never fix it, and a KIND can ────────────────────────────
 *
 * The tempting fix is to stop accepting a name from anyone. It does not work:
 * every harness, seed, import and CLI path writes revisions and none of them has
 * a session, so "authorship requires an identity" means the demo, the regression
 * net and the seeds all stop. The name has to keep being writable by things that
 * are not people.
 *
 * What has to stop is the name being read as if somebody checked it. So the row
 * now carries the attestation beside the name, and the two travel together as
 * ONE value — this interface — for the same reason `agentRuntimeService
 * .resolveKey()` returns `{ key, shared, secretName }` rather than a bare string
 * (D-42): the qualifier is the whole mechanism, and a qualifier that can be
 * dropped at a call site is one that will be.
 *
 * ⚠ **This is still not separation of duties** (I-13) — though not for the
 * reason this paragraph originally gave. Roles exist since GAPS §1.1, so it is
 * no longer true that anyone who can sign in can approve. What remains is that
 * anything holding `RUNTIME_JWT_SECRET` can mint an identity (`e2e:ui` does),
 * and a minted identity holding the approver role approves. What this adds is smaller and checkable:
 * *"a second pair of eyes was possible and happened"* and *"there was nobody to
 * be the first pair"* are now different states rather than the same string.
 */

/**
 * Three values, and each one is a different answer to *"was there a person, and
 * did this server verify them?"*
 *
 *  * **`user`** — a verified identity was resolved from `x-foundry-identity`
 *    and `created_by` is that person. Mintable in exactly ONE place,
 *    `authorOf()` in `middleware/identity.middleware.ts`, which a test asserts
 *    by reading the source tree. A second minter would work perfectly and
 *    report nothing, which is how a control stops being one.
 *  * **`system`** — no identity existed. A harness, a seed, a CLI, an import run
 *    by a machine, or the drafter invoked without a session. `created_by` is
 *    whatever that caller called itself: informative, and load-bearing for
 *    nothing.
 *  * **`unknown`** — written by the backfill and by nothing else. Rows that
 *    predate this column may have come from a browser or from a harness and
 *    **nothing recorded which**, so stamping them `system` would assert a fact
 *    no one established and stamping them `user` would manufacture the exact
 *    verification this column exists to make honest.
 *
 * ⚠ There is deliberately no `import` value. The column answers one question —
 * was the AUTHORSHIP attested — and importing is a statement about where the
 * bytes came from, which is a different axis. A bundle imported by a signed-in
 * person is authored by that person here: they chose it, they will be the one
 * gate 2 refuses if they then approve it, and calling that `import` would take
 * a real self-approval out of the comparison. A bundle imported by a harness is
 * `system` for the same reason every other harness write is. Two axes in one
 * column is how a value gets used for the question it does not answer.
 */
export type RevisionAuthorKind = "user" | "system" | "unknown";

/**
 * A name and the reason to believe it, together.
 *
 * Always passed as a unit and never as two arguments. Two arguments is one call
 * site away from a `user` kind over a body-supplied name, which is the original
 * defect with an extra column.
 */
export interface RevisionAuthor {
  /** What gets recorded. An email for a person; a self-chosen label otherwise. */
  createdBy: string;
  createdByKind: RevisionAuthorKind;
}

/** What a non-interactive writer is called when it does not name itself. */
export const SYSTEM_AUTHOR_NAME = "foundry-system";

/**
 * The author of a revision nobody signed for.
 *
 * ⚠ **Cannot return `user`, and that is the point.** Harnesses, seeds and the
 * CLI construct their author through this function, so no amount of passing a
 * person-shaped string can produce an attested one — `systemAuthor("alice@x")`
 * records the name and still says `system`. The only path to `user` is a token
 * this server verified.
 */
export function systemAuthor(name: string = SYSTEM_AUTHOR_NAME): RevisionAuthor {
  const trimmed = name.trim();
  return {
    createdBy: (trimmed || SYSTEM_AUTHOR_NAME).slice(0, 255),
    createdByKind: "system",
  };
}

/**
 * One sentence a UI or an audit reader can print, per kind.
 *
 * Shared so the three surfaces that say this (`ApprovalPanel`, the revision
 * list, the approval history) cannot drift into three different claims about
 * the same column — the `llm_complete` seam rule applied to prose.
 */
export function authorClaim(kind: RevisionAuthorKind, name: string | null): string {
  switch (kind) {
    case "user":
      return `${name ?? "someone"} was signed in when this revision was written.`;
    case "system":
      return `written by ${name ?? "a system caller"} with no signed-in user, so there was nobody to be the first pair of eyes. The name is self-asserted.`;
    default:
      return "written before authorship was recorded — nothing says whether a person was behind it.";
  }
}
