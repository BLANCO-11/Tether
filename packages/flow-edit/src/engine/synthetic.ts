/**
 * Synthetic catalogues for the property test (compiled-builder phase 3, task 4): generic shapes — nullable columns, a lifting
 * recipient list, a model, refinements — in a NEUTRAL domain (plan §5 rule 7), so the walk explores every rule without
 * leaning on a demo workspace's nouns. `syntheticCatalogue(seed)` varies the shapes; `SYNTHETIC` is the fixed one.
 */
import { T, type Ty } from "../typecheck/types.js";
import type { CatalogueSnapshot, PortSig, RefSig } from "../typecheck/signature.js";
import { rng } from "./walk.js";

const port = (name: string, ty: Ty, required = true, liftsScalar = false): PortSig => ({ name, ty, required, ...(liftsScalar ? { liftsScalar } : {}) });
const reader = (params: PortSig[], fields: Record<string, Ty>): RefSig => ({ kind: "operation", params, payload: T.rows(T.record(fields)) });
const tool = (params: PortSig[], out: Record<string, Ty>): RefSig => ({ kind: "tool", params, payload: T.record(out) });

export const SYNTHETIC: CatalogueSnapshot = {
  mailAllowedDomains: ["acme-corp.com"],
  refs: {
    "store.widgets": reader([port("as_of", T.date())], { code: T.text(), owner_email: T.option(T.address()), qty: T.int(), weight: T.option(T.number()), due: T.option(T.date()), state: T.text(), active: T.bool() }),
    "store.people": reader([], { name: T.text(), email: T.address(), team: T.option(T.text()), score: T.option(T.number()) }),
    "store.by_month": reader([port("period", T.month()), port("limit_to", T.int(), false)], { label: T.text(), total: T.number(), seen_at: T.dateTime() }),
    mail_send: tool([port("to", T.list(T.address()), true, true), port("subject", T.text([{ r: "SingleLine" }, { r: "MaxLen", n: 200 }])), port("body", T.text()), port("cc", T.list(T.address()), false, true)], { status: T.text(), message_id: T.text() }),
    // `tether_email_send`'s shape: an unset `to` goes to whoever started the run (I-287) — the port a schedule makes a hole.
    notify_me: tool([{ ...port("to", T.list(T.address()), false, true), fallsBackToRequester: true }, port("text", T.text())], { status: T.text() }),
    llm_complete: { ...tool([port("input", T.text()), port("instruction", T.text(), false)], { text: T.text() }), modelText: true },
    chat_post: tool([port("channel", T.text([{ r: "OneOf", values: ["#ops", "#alerts"] }])), port("text", T.text())], { ok: T.bool() }),
    ticket_open: tool([port("title", T.text([{ r: "MaxLen", n: 120 }])), port("priority", T.text([{ r: "OneOf", values: ["low", "normal", "high"] }])), port("assignee", T.address(), false)], { ticket_key: T.text() }),
  },
};

const SCALARS: Array<() => Ty> = [T.text, T.int, T.number, T.bool, T.date, T.dateTime, T.address];
/** A random catalogue: 1–4 readers of 1–6 columns (some nullable), plus the fixed tools. */
export function syntheticCatalogue(seed: number): CatalogueSnapshot {
  const r = rng(seed);
  const refs: Record<string, RefSig> = {};
  for (let i = 0; i < 1 + Math.floor(r() * 4); i++) {
    const fields: Record<string, Ty> = {};
    for (let j = 0; j < 1 + Math.floor(r() * 6); j++) {
      const t = SCALARS[Math.floor(r() * SCALARS.length)]!();
      fields[`c${j}`] = r() < 0.4 ? T.option(t) : t;
    }
    const params = r() < 0.5 ? [port("p", [T.date, T.month, T.int, T.text][Math.floor(r() * 4)]!())] : [];
    refs[`ds.r${i}`] = reader(params, fields);
  }
  for (const k of ["mail_send", "llm_complete", "chat_post", "ticket_open"]) refs[k] = SYNTHETIC.refs[k]!;
  return { mailAllowedDomains: ["acme-corp.com"], refs };
}
