/**
 * The two dataset facts this service needs, duplicated from
 * `packages/server/src/demo/hr-dataset.ts` — deliberately, and this is the
 * argument for it.
 *
 * The alternative is a build dependency from ops-api on `@foundry/server`,
 * which would drag the parent's config loader, Drizzle schema and credential
 * encryptor into a process whose entire reason for existing is that it holds
 * none of those. A shared `@foundry/demo-dataset` package is the tidier answer
 * and buys nothing here: the parent's copy is the definition (it seeds the
 * database), and this copy is a default that is only reached when a caller
 * omits `?period=`.
 *
 * Drift is bounded, not silent. `DEMO_PERIOD` is a fallback that the harnesses
 * always override with `--period=`, so a stale value shows up as an oracle
 * mismatch naming the period, not as a wrong answer that looks right.
 * `DEMO_BOUNCE_DOMAIN` is asserted from both sides: `demo:verify` checks the
 * dataset holds exactly one address on it, and the mail route's own bounce
 * behaviour is checked by `showcase:verify`.
 */

/** The reporting month the dataset's traps are tuned to. Overridable per call. */
export const DEMO_PERIOD = "2026-06";

/**
 * The RFC 2606 reserved domain that hard-bounces, for the HR dataset.
 *
 * One employee's address lives on it, so an automation that reports "sent 11"
 * without reading the per-recipient status is visibly wrong. It cannot resolve
 * or receive mail; nothing is transmitted anywhere by this service.
 */
export const DEMO_BOUNCE_DOMAIN = "acme-hr-bounce.example";

/**
 * The CONVENTION, rather than the one domain — any address whose domain ends
 * `-bounce.example` hard-bounces.
 *
 * The Finance dataset needs its own undeliverable vendor, and naming that
 * vendor's address `@acme-hr-bounce.example` would have been the quiet option:
 * it works, and it says "HR" inside a Finance flow's outbox. Hardcoding a second
 * literal is worse again — the next dataset needs a third, and the check that
 * every dataset's bouncing address actually bounces has to be written once per
 * domain.
 *
 * A suffix rule holds for any dataset, and it stays inside `.example`, so no
 * address matching it can resolve or receive mail. `DEMO_BOUNCE_DOMAIN` above
 * remains the HR dataset's specific value because `demo:verify` asserts the
 * count of addresses on exactly that domain.
 */
export const BOUNCE_DOMAIN_SUFFIX = "-bounce.example";

/** Does this address land on a domain that always hard-bounces? */
export function isBouncingAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  return address.slice(at + 1).toLowerCase().endsWith(BOUNCE_DOMAIN_SUFFIX);
}
