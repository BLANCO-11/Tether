/**
 * The Postgres SQLSTATE behind an error, wherever the driver's error sits.
 *
 * ⚠ From drizzle-orm 0.44 every query error is a `DrizzleQueryError` whose `cause` is the driver's error — the SQLSTATE is
 * on `err.cause.code`, not `err.code`. A check written `err.code === "22P02"` still compiles and still passes a test that
 * hands it a plain `{ code }`, and silently stops matching anything Drizzle threw: a malformed id became a 500 again.
 * So every SQLSTATE check on an error that may have come through Drizzle reads it here.
 *
 * Walks `cause` a few levels (a wrapper may itself be wrapped); a raw `pg`/PGlite error is matched at the first level.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === "object"; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
