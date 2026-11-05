/**
 * The fixed states `chat:edit-measure` labels its requests against (phase X, task 8) — built ONLY from actions the canvas lists,
 * on the engine's neutral synthetic catalogue (plan §5 rule 7), so the set leans on no demo workspace. Pure: no database, no model.
 */
import { canvasActions, canvasApply, emptyFlow, SYNTHETIC, type EFlow } from "@foundry/flow-edit";

/** Take the first listed action whose label matches, typing `value` into a slot; throws when the canvas does not offer it. */
function take(f: EFlow, label: RegExp, value?: string, where?: (w: unknown) => boolean): EFlow {
  const a = canvasActions(f, SYNTHETIC).find((x) => label.test(x.label) && (!where || where(x.where)));
  if (!a) throw new Error(`the canvas offers no “${label}” here`);
  const r = canvasApply(f, SYNTHETIC, a, value);
  if (!r.ok) throw new Error(`“${a.label}”: ${r.error}`);
  return r.flow;
}

/** A: read the people, send a mail, a person approves first, weekly. */
export function stateA(): EFlow {
  let f = emptyFlow("people_mail");
  f = take(f, /^read store\.people$/);
  f = take(f, /^call mail_send once$/);
  f = take(f, /^a person approves before this runs$/, "Send these?");
  f = take(f, /^run on a schedule$/, "0 9 * * 1");
  return f;
}

/** B: read the widgets and the monthly totals, post one to chat and open a ticket. */
export function stateB(): EFlow {
  let f = emptyFlow("widgets_watch");
  f = take(f, /^read store\.widgets$/);
  f = take(f, /^read store\.by_month$/);
  f = take(f, /^call chat_post once$/);
  f = take(f, /^call ticket_open once$/);
  return f;
}

export const STATES = { A: stateA, B: stateB } as const;
