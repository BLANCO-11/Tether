/**
 * **What a datasource is allowed to do**, and where that is enforced.
 *
 * ── ⚠ This REPLACES a refusal with a control (2026-09-17) ───────────────────
 *
 * Until now `datasource.service.ts` refused outright any credential that could
 * write (D-40, Stage 9.2), and that gate was right about the danger: the whole
 * reason `hr_demo` is a separate database is that a generated script must not
 * be able to satisfy "send the email" with an `INSERT INTO mail_outbox`.
 *
 * Its failure mode is who it stops. A tenant whose only credential is an
 * administrator — an Azure `*_admin` account, say — cannot onboard at all, and
 * the fix on offer is "go and create a role", which many people cannot do on
 * the database they were told to connect. A control that a whole class of users
 * has to route around is one they route around.
 *
 * ── The three layers, and only the third is load-bearing ────────────────────
 *
 *  1. **The declaration.** `datasources.access_policy` — chosen at onboarding.
 *     On its own it is a label, and a label is exactly what this must not be.
 *  2. **The observation.** `credential_can_write`, probed at registration. It
 *     no longer refuses; it is shown beside the policy so a person can see that
 *     the credential is wider than the permission, which is a legitimate and
 *     common state rather than a misconfiguration.
 *  3. ⚠ **THE CONTROL: the transaction.** A `read` datasource runs its
 *     statements inside `BEGIN READ ONLY`, and **Postgres refuses every write
 *     itself** — `cannot execute INSERT in a read-only transaction` — whatever
 *     the role is granted, including a superuser. That is what makes layer 1
 *     true rather than merely stated, and it is why an administrator credential
 *     on a `read` datasource is safe.
 *
 * ⚠ **Layer 3 is why the old gate could be relaxed, and removing it puts the
 * gate back or leaves nothing.** If a future change stops opening the
 * transaction, `access_policy` instantly becomes the documentation-only field
 * this module exists to avoid — the deleted `faFallback` shape applied to a
 * security boundary, where the screen says read-only and nothing makes it so.
 */

/**
 * ⚠ **The list and the copy come from `@foundry/shared`, not from here.** The
 * onboarding form renders the same members this file validates against, and a
 * second copy drifts in the direction where the screen offers a level the
 * server refuses on submit — the trap `AUTH_STYLES` was moved there to close.
 * What stays in this module is the ENFORCEMENT, which must never be computable
 * in a browser.
 */
export { ACCESS_POLICIES, ACCESS_POLICY_COPY, type AccessPolicy } from "@foundry/shared";
import { ACCESS_POLICIES as POLICIES, type AccessPolicy as Policy } from "@foundry/shared";

export const DEFAULT_ACCESS_POLICY: Policy = "read";

/**
 * Is `value` a policy this build understands?
 *
 * ⚠ Unknown is NOT read, and must never be silently coerced to it. A column
 * holding something outside the set means a migration, a manual edit or a newer
 * build wrote it, and the honest response is to fail closed at the call site
 * rather than to guess the safest-looking member — guessing is how a `full`
 * datasource written by a newer server starts running under a read-only
 * transaction and failing every write for a reason nobody can find.
 */
export function isAccessPolicy(value: unknown): value is Policy {
  return typeof value === "string" && (POLICIES as readonly string[]).includes(value);
}

/**
 * The policy to enforce for a stored value.
 *
 * ⚠ **Fails CLOSED: anything unrecognised, including null, becomes `read`.**
 * That is the opposite of the rule above and the difference is where it is
 * used — `isAccessPolicy` guards what a caller may SET, this decides what to
 * ENFORCE on a row that already exists. Refusing to run at all because a column
 * holds a surprise would take every flow in the workspace down; running the
 * narrowest policy degrades to "reads work, writes do not", which is loud in
 * the right direction and cannot lose data.
 */
export function enforcedPolicy(stored: unknown): Policy {
  return isAccessPolicy(stored) ? stored : DEFAULT_ACCESS_POLICY;
}

/**
 * Must this datasource's statements run inside a read-only transaction?
 *
 * ⚠ The one question `step-execution.service.ts` asks. Expressed as its own
 * function rather than `policy === "read"` at the call site so there is ONE
 * definition of "this datasource may not write" (D-197) — a second copy is how
 * the executor and the UI come to disagree about what `read` means.
 */
export function requiresReadOnlyTransaction(stored: unknown): boolean {
  return enforcedPolicy(stored) === "read";
}
