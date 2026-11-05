/**
 * One view transition at a time.
 *
 * Three call sites animate state changes (`/flows/new`'s mode switches and its
 * immersive `body.wb` toggle, the builder's chat/manual switch). Fired
 * together, the second call aborts the first mid-flight — Chrome reports
 * `Skipped ViewTransition due to another transition starting`, and the torn
 * snapshot can leave the new surface blank. So every starter funnels through
 * here: while a transition is flying, updates apply directly with no new
 * transition, and the old transition's `finished` rejection is caught rather
 * than surfacing as an uncaught console error.
 *
 * Route-change entrances do NOT belong here — those are the CSS-only
 * `.page-enter` animation in globals.css, which cannot race anything.
 */
let flying: { finished?: Promise<unknown> } | null = null;

export function transitionUpdate(cb: () => void): void {
  if (typeof document === "undefined") {
    cb();
    return;
  }
  const doc = document as unknown as {
    startViewTransition?: (cb: () => void) => { finished?: Promise<unknown> } | undefined;
  };
  if (typeof doc.startViewTransition !== "function" || flying) {
    cb();
    return;
  }
  try {
    const t = doc.startViewTransition(cb);
    if (t?.finished) {
      flying = t;
      t.finished
        .catch(() => {
          // A skip from outside this helper (e.g. the browser chrome) is not
          // a failure — the DOM update already applied.
        })
        .finally(() => {
          if (flying === t) flying = null;
        });
    }
  } catch {
    cb();
  }
}
