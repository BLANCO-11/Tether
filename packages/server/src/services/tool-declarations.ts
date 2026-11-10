/**
 * What a tool DECLARES about itself beyond its parameter types (compiled-builder I-292): which ports are addresses, which
 * take one value where a list is declared, which fall back to the run's requester when unset, which refinements the
 * receiving service enforces, and whether its output is a model's text (D-34).
 *
 * ⚠ The rule: the engine and the checker read the FLAGS this produces (`PortSig`/`RefSig`) and never a component's name
 * (`name-free.test.ts` asserts it of their source). Names live here and only here, as the declaration of the tools this
 * product ships — the same place a tenant tool's own declaration is read from (a param's `format: "email"`).
 *
 * ⚠ The old name rule (`mailAddressField`, I-284/I-121) survives as a FALLBACK for an undeclared tool, because the save
 * funnel still refuses by it and the two must agree — and it is LOGGED when it fires, so a tool typed by its name is visible
 * rather than silently right.
 */
import { TypeOf as T, type Ty } from "@foundry/flow-edit";
import { mailAddressField } from "./flow-validator.service.js";
import { SUBJECT_MAX_CHARS } from "./mail-recipients.js";

/** `message`: the port carries the words a person reads (a body, a chat line, a ticket's title) — D-324's drafted template goes only here. */
/** `data`: the port that takes the upstream data, as text. */
/** `needs`: a value here is useless unless that port is bound too (a file's name/format without its rows) — the solver binds it. */
export interface PortDeclaration { fromStep?: boolean; address?: boolean; liftsScalar?: boolean; fallsBackToRequester?: boolean; message?: boolean; heading?: boolean; data?: boolean; needs?: string; group?: string; ty?: Ty }
export interface ToolDeclaration { modelText?: boolean; ports?: Record<string, PortDeclaration> }

/** ops-api's mail services (`parseMailBody`: `asArray` wraps one address into the list). */
const MAIL_SERVICE: ToolDeclaration = { ports: { sender: { address: true }, recipients: { address: true, liftsScalar: true }, cc: { address: true, liftsScalar: true }, subject: { heading: true }, body: { message: true } } };

/** The two files Foundry generates from rows (`file-builder.ts`). */
const ATTACH_FORMAT = T.text([{ r: "OneOf", values: ["csv", "xlsx"] }]);
/** The section the flat file's three ports are shown under, as one thing a person reads. */
const ATTACHMENT = "Attachment";

/** The tools this product ships, each with what its receiving code enforces — cited, never guessed. */
export const DECLARED: Readonly<Record<string, ToolDeclaration>> = {
  // `routes/mail.ts` + `mail-recipients.ts`: a subject is one non-empty line of at most SUBJECT_MAX_CHARS; `to`/`cc` are
  // address lists that take one address; `resolveRecipients`: an empty `to` becomes the run's requester (I-287).
  tether_email_send: { ports: {
    /**
     * ⚠ The route's real shape, not `array`. Typed as "a list of anything" (I-287's hole) a reader's rows fit this port and
     * every check was green — then `mail.ts` refused each row at run time: no `name`, unknown keys. A row now misses `name`.
     */
    attachments: { ty: T.list(T.record({
      name: T.text([{ r: "NonEmpty" }]),
      content: T.option(T.text()),
      format: T.option(ATTACH_FORMAT),
      rows: T.option(T.list(T.record({}))),
    })) },
    /**
     * The FLAT attachment: a step's rows, a file name and a format — three ports the engine can bind and fill (a binding and two
     * literals), where `attachments` needs a record the engine has no combinator to build. The route folds them into one
     * generated file.
     *
     * ⚠ `attach_rows` is TEXT, as `body` is: the engine's only way to hand a port a step's WHOLE output is `from: "text"` (the
     * output as JSON) — there is no binding source for "the rows as a list". The route unwraps it exactly as the report does.
     * ⚠ Deliberately NOT `data`: the solver binds upstream output to a `data` port first, which would move every email flow's
     * rows out of `body` and into a file. Optional, so it opens no hole and the solver's email behaviour is unchanged.
     */
    attach_rows: { group: ATTACHMENT, ty: T.text(), fromStep: true },
    // A name or a format alone builds no file: each NEEDS the rows, so a goal that says "a csv report" gets its rows bound too.
    attach_name: { group: ATTACHMENT, needs: "attach_rows", ty: T.text([{ r: "SingleLine" }, { r: "NonEmpty" }, { r: "MaxLen", n: 100 }]) },
    attach_format: { group: ATTACHMENT, needs: "attach_rows", ty: ATTACH_FORMAT },
    subject: { heading: true, ty: T.text([{ r: "SingleLine" }, { r: "NonEmpty" }, { r: "MaxLen", n: SUBJECT_MAX_CHARS }]) },
    to: { address: true, liftsScalar: true, fallsBackToRequester: true },
    cc: { address: true, liftsScalar: true },
    body: { message: true },
  } },
  mail_send: MAIL_SERVICE,
  mail_send_template: MAIL_SERVICE,
  test_email_send: MAIL_SERVICE,
  // D-34: its output is a model's text, for a person to read.
  // `input` is what the model reads (the data); `instruction` is what to do with it — the person's words.
  llm_complete: { modelText: true, ports: { input: { data: true } } },
  // D-324: the words a person reads. NOT `page_oncall.dedupe_key` (it must be a stable row identity — a template of changing values
  // would defeat the deduplication and page again) and NOT its `target` (a person, not prose).
  chat_post_message: { ports: { text: { message: true } } },
  // `assignee` is an ADDRESS — `packages/ops-api` refuses anything else with a 422 (2026-10-01: "raise a ticket for legal" bound
  // "legal", passed every static check, and failed at the run). Declared so the engine refuses it at build time, as the service does.
  ticket_create: { ports: { title: { message: true, heading: true }, description: { message: true }, assignee: { address: true } } },
  // `packages/ops-api` paging: repeats are suppressed on `dedupe_key` — it must be the ROW's identity (the incident code), so it
  // is a Key, which no literal is: a typed key ("same incident") would be one key for every incident and silence all but the
  // first. `target`/`escalation_target` are the address to wake.
  page_oncall: { ports: {
    summary: { message: true },
    dedupe_key: { ty: T.key() },
    target: { address: true },
    escalation_target: { address: true },
  } },
};

const warned = new Set<string>();
/** A tool's declaration: the shipped one, else the name-rule fallback (logged once per port). */
export function declarationOf(ref: string, params: Array<{ name: string }>): ToolDeclaration {
  const shipped = DECLARED[ref];
  if (shipped) return shipped;
  const ports: Record<string, PortDeclaration> = {};
  for (const p of params) {
    if (!mailAddressField(ref, p.name)) continue;
    ports[p.name] = { address: true, liftsScalar: true };
    const key = `${ref}.${p.name}`;
    if (!warned.has(key)) { warned.add(key); console.warn(`[catalogue] ${key} typed as an address by its NAME (I-292) — declare \`format: "email"\` on the tool's parameter`); }
  }
  return Object.keys(ports).length ? { ports } : {};
}

/** A port's type under its declaration: the declared type, else an address (or list of) where declared, else as typed. */
export function declaredPortTy(base: Ty, d: PortDeclaration | undefined): Ty {
  if (!d) return base;
  if (d.ty) return d.ty;
  if (d.address) {
    if (base.t === "Text") return T.address();
    if (base.t === "List" && (base.of.t === "Text" || base.of.t === "Json")) return T.list(T.address());
  }
  return base;
}
