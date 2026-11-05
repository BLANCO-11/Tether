/**
 * WHO a real email may be delivered to. Pure policy, no I/O.
 * email-send-tool · US2, US3 · plan.md Decision 3
 *
 * ── Why this is a separate module, and why it is the first one written ───────
 *
 * `foundry_email_send` is the first tool in Foundry that leaves the building.
 * Every other tool in the catalogue talks to `packages/ops-api`, which is a
 * *simulation* — a wrong recipient there costs a row in `api_call_log`. Here a
 * wrong recipient is a message in a stranger's inbox, and there is no unsend.
 *
 * So the decision "may this address be written to?" is deliberately kept where
 * it can be proved without a database, without express and without Microsoft
 * Graph: a function of its arguments, exhaustively unit tested. The route
 * (`routes/mail.ts`) does not decide anything — it resolves inputs, calls
 * `resolveRecipients`, and obeys the answer.
 *
 * ⚠ **The policy cannot live at the provider.** Graph delivers to whatever the
 * request body names, so a tool pointed straight at `graph.microsoft.com` would
 * hand the model the destination. That is the whole reason this feature is a
 * Foundry-owned endpoint rather than a registered tool aimed at Microsoft
 * (plan.md Decision 1).
 *
 * ── The rule, in one sentence ────────────────────────────────────────────────
 *
 * **No `to` means the person who started the run, and nobody else; an explicit
 * `to` must be allowlisted.**
 *
 * The default matters more than the allowlist. "Email me the result" is the
 * request this feature exists to serve, and the form that serves it carries no
 * address at all — so the model never has to produce one, and cannot get one
 * wrong. An address the model *did* produce is treated as a claim to be checked,
 * never as an instruction to be followed: prompt-injected content in a script's
 * output cannot redirect a message, because a redirect requires passing the
 * allowlist.
 *
 * ── Refuse the whole call, never part of it ──────────────────────────────────
 *
 * If any one recipient fails, nothing is sent (FR-007). There is no partial-send
 * path here, deliberately — not "we send to the ones that passed and report the
 * rest", because that shape is how a caller ends up believing eleven people were
 * emailed when three were. The failure this whole migration was built around was
 * a script that "emailed 0 of 11 people and reported `clean`"; a half-send that
 * reports success is the same lie with a smaller gap.
 */

/**
 * Deliberately conservative: one `@`, no whitespace anywhere, and a dot in the
 * domain. Byte-identical in behaviour to the regex `ops-api/src/routes/ops.ts`
 * uses at its line 369 — but **copied, not imported**. ops-api is the simulated
 * SaaS layer and a different package; importing across that seam would make the
 * real sender depend on the fake one, and the two are allowed to diverge.
 *
 * It rejects plenty of technically-legal RFC 5322 addresses (quoted local parts,
 * bracketed IP domains, TLD-only domains). That is the intended trade: this
 * gate's job is to decide whether a `requested_by` value is an address at all —
 * the alternative failure, treating an Entra object id or the literal string
 * `system` as a mailbox, is worse than refusing an exotic address that Graph
 * would probably have bounced anyway.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Longest subject we will hand Graph. Not a provider limit — a sanity limit. */
export const SUBJECT_MAX_CHARS = 250;

/**
 * The six values `flow_executions.requested_by_kind` can hold. Mirrors the union
 * documented at `db/schema.ts` — kept as a local type rather than imported so
 * this module stays free of database imports and testable with no fixture.
 */
export type RequestedByKind = "user" | "replay" | "trigger" | "system" | "schedule" | "unknown";

/** Where the recipient list came from. Surfaced to the run page so the destination is explainable. */
export type ResolvedFrom = "requester" | "explicit";

/**
 * A refusal, in the one shape the route turns into a response.
 *
 * `status` is carried here rather than decided at the route because the reason
 * and its status are one fact: "no requester" is a 422 wherever it is reported,
 * and a route free to choose is a route that can disagree with the contract.
 */
export type MailRefusal = {
  ok: false;
  status: 422;
  message: string;
  detail: Record<string, unknown>;
};

export type RecipientResolution =
  | { ok: true; to: string[]; cc: string[]; resolvedFrom: ResolvedFrom; reservedAllowed?: string[] }
  | MailRefusal;

export type MessageCapsResult = { ok: true } | MailRefusal;

export type MailCaps = { maxRecipients: number; maxBodyBytes: number };

const refuse = (message: string, detail: Record<string, unknown>): MailRefusal => ({
  ok: false,
  status: 422,
  message,
  detail,
});

/** Lowercase and trim. A mailbox is not case-sensitive, and a trailing space is not an address. */
const canon = (address: string): string => address.trim().toLowerCase();

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);

/**
 * The person who started this run, or `null` — and `null` is a legitimate,
 * common answer that callers must handle rather than paper over.
 *
 * ⚠ **Only `user` and `replay` runs have a person.** A `schedule`, `trigger`,
 * `system` or `unknown` run has none *by definition*, and the column may still
 * hold something address-shaped (a trigger's name, the literal `system`). Any
 * fallback here — the flow's author, the workspace owner, a configured operator
 * address — would mean a nightly job quietly emailing a tenant's payroll report
 * to whoever was convenient. Refusing is the correct behaviour and US3 exists to
 * assert that it is loud.
 *
 * The second guard is the one that is easy to forget: a `user` run's
 * `requested_by` is `user.email ?? user.subject`, so an identity whose token
 * carries no email claim leaves an **Entra object id** in a column named like an
 * address. `EMAIL_RE` is what stops that becoming a mailbox.
 */
export function resolveRequester(row: {
  requestedBy: string | null | undefined;
  requestedByKind: string | null | undefined;
}): string | null {
  if (row.requestedByKind !== "user" && row.requestedByKind !== "replay") return null;
  const candidate = canon(row.requestedBy ?? "");
  return EMAIL_RE.test(candidate) ? candidate : null;
}

/**
 * Is this address permitted as an explicit recipient?
 *
 * Two gates, and **both** must pass: the deployment's `MAIL_ALLOWED_RECIPIENT_DOMAINS`
 * and the workspace's optional narrowing list. That ordering is the containment
 * property — a workspace admin editing their own allowlist cannot reach a domain
 * the operator excluded, because the workspace list only ever removes.
 *
 * The requester is exempt from both. They are already entitled to this output
 * (they started the run and the default sends it to them), so requiring an
 * allowlist entry would only mean "email me" works and "email me at my own
 * address" does not.
 */
/**
 * RFC 2606 / RFC 6761 names that can never receive mail: the `.example`,
 * `.test`, `.invalid` and `.localhost` TLDs, and `example.com/net/org`. Every
 * demo dataset in this repo mails addresses on these, by design.
 */
export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return /\.(example|test|invalid|localhost)$/.test(d) || ["example.com", "example.net", "example.org"].includes(d);
}

function isPermitted(
  address: string,
  requester: string | null,
  deploymentAllowlist: readonly string[],
  workspaceAllowlist: readonly string[] | null,
): boolean {
  if (!EMAIL_RE.test(address)) return false;
  if (requester && address === requester) return true;

  const domain = domainOf(address);
  const deploymentOk = deploymentAllowlist.some((entry) => canon(entry) === domain);
  if (!deploymentOk) return false;

  if (workspaceAllowlist === null) return true; // null = no narrowing
  return workspaceAllowlist.some((entry) => {
    const e = canon(entry);
    return e === address || e === domain; // entries are addresses or bare domains
  });
}

/**
 * THE decision. Pure, total, and the only place a recipient list is produced.
 *
 * ⚠ **A refusal is total.** One bad address sends nothing — there is no
 * partial-send return value, so there is no partial-send code path for a later
 * change to accidentally take (FR-007). Every rejected address is named at once,
 * because a caller fixing them one at a time round-trips through the model once
 * per address.
 */
export function resolveRecipients(args: {
  explicitTo: readonly string[];
  explicitCc: readonly string[];
  requester: string | null;
  deploymentAllowlist: readonly string[];
  workspaceAllowlist: readonly string[] | null;
  caps: MailCaps;
  /**
   * ⚠ DRAFT RUNS ONLY (phased-typed-build D-267). When true, an address on an
   * RFC 2606 reserved domain passes the allowlists — it can never receive mail,
   * and a draft run is captured, never delivered. The ROUTE sets it from
   * `envForExecution` (the execution's namespace, D-52), never from a body.
   * Live runs never pass it, so live policy is unchanged. The passed addresses
   * are returned in `reservedAllowed` so the capture can say so: for these, a
   * draft proves less than a live run would.
   */
  draftAllowsReserved?: boolean;
}): RecipientResolution {
  const { requester, deploymentAllowlist, workspaceAllowlist, caps } = args;
  const reservedOk = (a: string) => !!args.draftAllowsReserved && EMAIL_RE.test(a) && isReservedDomain(domainOf(a));

  // Blanks are not recipients. A `to` of `[""]` is a `to` of nothing, which
  // means the requester default applies rather than a confusing refusal.
  const to = dedupe(args.explicitTo.map(canon).filter(Boolean));
  const cc = dedupe(args.explicitCc.map(canon).filter(Boolean)).filter((a) => !to.includes(a));

  if (to.length === 0) {
    if (cc.length > 0) {
      // A cc with no to would make the cc the de-facto recipient while bypassing
      // the reading of the rule that governs `to`. Refuse rather than promote.
      return refuse("cannot send with `cc` but no `to`", {
        remedy: "name the recipient in `to`, or omit both to send to the person who started the run",
      });
    }
    if (!requester) {
      return refuse(
        "no recipient: this run has no person to send to, and no `to` was given",
        {
          remedy: "name a recipient in `to`",
          rule:
            "only a run started by a signed-in person (or replayed by one) has a requester; " +
            "scheduled, triggered and system runs must name their recipients",
        },
      );
    }
    return { ok: true, to: [requester], cc: [], resolvedFrom: "requester" };
  }

  const rejected = [...to, ...cc].filter(
    (a) => !reservedOk(a) && !isPermitted(a, requester, deploymentAllowlist, workspaceAllowlist),
  );
  if (rejected.length > 0) {
    return refuse("one or more recipients are not allowed, so nothing was sent", {
      rejected,
      rule:
        "an explicitly named recipient must be the person who started the run, or on a domain in " +
        "MAIL_ALLOWED_RECIPIENT_DOMAINS (and on the workspace's recipient allowlist when it is set)",
    });
  }

  // Counted after dedup: a list that repeats one address twenty times is one
  // recipient, and refusing it as "20 > 10" would be wrong.
  const total = to.length + cc.length;
  if (total > caps.maxRecipients) {
    return refuse("too many recipients", {
      actual: total,
      allowed: caps.maxRecipients,
      rule: "MAIL_MAX_RECIPIENTS counts `to` and `cc` together",
    });
  }

  const reservedAllowed = [...to, ...cc].filter((a) => reservedOk(a) && !isPermitted(a, requester, deploymentAllowlist, workspaceAllowlist));
  return { ok: true, to, cc, resolvedFrom: "explicit", ...(reservedAllowed.length ? { reservedAllowed } : {}) };
}

/**
 * Subject and body limits.
 *
 * ⚠ **The body is measured in BYTES.** A UTF-8 report of 200k characters is not
 * 200k bytes, and `.length` would wave through a body Graph then rejects — at
 * which point the refusal arrives from Microsoft, in Microsoft's words, about a
 * limit nobody configured here.
 *
 * The newline check on the subject is a header-injection shape. Graph would very
 * likely sanitise it; "the provider probably handles it" is not a control.
 */
export function checkMessageCaps(args: {
  subject: string;
  body: string;
  caps: MailCaps;
}): MessageCapsResult {
  const subject = args.subject.trim();
  if (subject.length === 0) {
    return refuse("subject is required", { remedy: "give the message a one-line subject" });
  }
  if (/[\r\n]/.test(args.subject)) {
    return refuse("subject must not contain a newline", {
      rule: "the subject is a single header line",
    });
  }
  if (subject.length > SUBJECT_MAX_CHARS) {
    return refuse("subject is too long", {
      actual: subject.length,
      allowed: SUBJECT_MAX_CHARS,
    });
  }

  if (args.body.length === 0) {
    return refuse("body is required", { remedy: "put the script output in `body`" });
  }
  const bytes = Buffer.byteLength(args.body, "utf8");
  if (bytes > args.caps.maxBodyBytes) {
    return refuse("body is too large", {
      actual: bytes,
      allowed: args.caps.maxBodyBytes,
      rule: "MAIL_MAX_BODY_BYTES is measured in UTF-8 bytes, not characters",
    });
  }

  return { ok: true };
}

/** Order-preserving dedup. First occurrence wins, so the caller's ordering survives. */
function dedupe(addresses: string[]): string[] {
  return [...new Set(addresses)];
}
