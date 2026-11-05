/**
 * One place that turns a datasource's connection health into words.
 *
 * ── Why this is a module and not three literals ──────────────────────────────
 *
 * The map lived, copy-pasted, in `data-sources/page.tsx`,
 * `data-sources/[id]/page.tsx` and `keys/page.tsx`. Adding `untested` broke two
 * of them at the typecheck — which was luck: a `Record<ConnectionStatus, …>`
 * happens to be exhaustive, and had any copy been typed loosely it would have
 * rendered `undefined` for the new state, which reads on screen as a blank pill
 * rather than as an error.
 *
 * ⚠ `untested` is NOT "Queued", and that was the bug the extraction came from.
 * The server clears `test_status` whenever a connection string changes and never
 * re-tests on its own, so a NULL means "nobody has checked", not "a check is
 * running". The old wording promised background work that would never happen,
 * and the list page polled forever waiting for it — see `IN_FLIGHT`.
 */
import type { ConnectionStatus, Status } from "@/lib/types";

export const CONNECTION_PILL: Record<ConnectionStatus, { status: Status; text: string }> = {
  untested: { status: "neutral", text: "Not tested" },
  pending: { status: "warn", text: "Testing…" },
  discovering: { status: "warn", text: "Testing…" },
  ready: { status: "ok", text: "Connected" },
  error: { status: "danger", text: "Can't connect" },
};

/**
 * The only states that justify polling — a test genuinely in flight.
 *
 * `untested` and `error` are RESTING states: nothing changes them but a person
 * pressing Test. Polling on them is a spinner over a settled answer.
 */
export const IN_FLIGHT: ConnectionStatus[] = ["pending", "discovering"];

/** Is this answer current, or is it waiting for somebody to ask? */
export function needsTesting(s: ConnectionStatus): boolean {
  return s === "untested" || s === "error";
}
