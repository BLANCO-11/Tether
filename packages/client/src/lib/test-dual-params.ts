/**
 * Test-only. A value that reads as BOTH a plain object and a Promise of itself.
 *
 * Next 14 hands a page its `params` / `searchParams` as plain objects; Next 15 hands a Promise, and Next 16 removes the
 * synchronous shim. A test that passes one shape goes red on the other side of the upgrade for a reason that has nothing to do
 * with the code under test. This passes both, so the SAME test is green before and after and goes red only when the code
 * misreads its input — which is the thing the upgrade can break and the old suite could not see.
 *
 * Phase 2 of `specs/20261012-123549-nextjs-16-upgrade` switches it to a real Promise (`promiseParams`) once the plain-object
 * form is no longer valid, and deletes the plain-object cases rather than skipping them.
 */
export function dualParams<T extends object>(value: T): T & Promise<T> {
  return Object.assign(Promise.resolve(value), value);
}
