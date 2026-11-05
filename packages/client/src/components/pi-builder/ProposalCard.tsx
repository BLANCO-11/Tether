"use client";

// A change Forge Agent PROPOSED to a connected service (plugins phase 6), shown under its reply.
//
// ⚠ This card is the only way the change happens: Forge proposed it and cannot perform it. "Do it" sends the person's
// own request to the server, which re-checks the rules and runs exactly the values shown here, once. The values are
// shown in full, as they will be sent — what the person reads is what runs.
import { useState } from "react";
import type { GrantScope, PiAccount, PiAccountQuestion, PiProposal, PiSettingChange } from "@/lib/pi-builder";
import { Button } from "@/components/ui/Button";
import { StatusPill } from "@/components/ui/Badge";

const STATE: Record<PiProposal["status"], { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  pending: { label: "Waiting for you", tone: "warn" },
  running: { label: "Doing it…", tone: "neutral" },
  done: { label: "Done", tone: "ok" },
  partial: { label: "Partly done", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  declined: { label: "Cancelled", tone: "neutral" },
};

/** A value as it will be sent: text as typed, anything else as JSON. */
export function shownValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Text sent as base64 (a file committed to GitHub, an attachment), decoded so the person reads what they approve
 * rather than a blob. Only when it decodes to readable UTF-8 text; anything else (an image, random letters) is shown as
 * sent. The card says it was decoded: what goes out is still the base64 of exactly this text.
 */
export function decodedBase64(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 24) return null;
  const b = v.replace(/\s+/g, "");
  if (b.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return null;
  try {
    const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Readable: almost no control characters besides line breaks and tabs.
    const odd = text.replace(/[\n\r\t]/g, "").match(/[\u0000-\u001f\u007f]/g)?.length ?? 0;
    return text.length && odd / text.length < 0.01 ? text : null;
  } catch {
    return null;
  }
}

/** A value as the card shows it: short ones inline; a long one (a file) as its first lines, with "Show all". */
function Value({ v, compact = false }: { v: unknown; compact?: boolean }) {
  const decoded = decodedBase64(v);
  const text = decoded ?? shownValue(v);
  const lines = text.split("\n");
  const long = lines.length > (compact ? 2 : 6) || text.length > (compact ? 140 : 480);
  const [open, setOpen] = useState(false);
  if (!long && decoded == null) return <span className="whitespace-pre-wrap break-words">{text}</span>;
  return (
    <div className="pc-long">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 font-sans">
        <span className="pc-tag">{lines.length} {lines.length === 1 ? "line" : "lines"}</span>
        {decoded != null ? (
          <span className="pc-tag" title="Sent as base64. Shown decoded, so you read what is sent.">
            base64, shown decoded
          </span>
        ) : null}
      </div>
      <pre className={`pc-code${open || !long ? " open" : ""}${compact ? " compact" : ""}`}>{text}</pre>
      {long ? (
        <button type="button" onClick={() => setOpen((o) => !o)} className="pc-more">
          {open ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}

/** How the service's answer reads on a decided card: the outcome, where to see it, a few facts, the raw answer folded. */
function Outcome({ p }: { p: PiProposal }) {
  if (!(p.status === "done" || p.status === "failed" || p.status === "partial") || !p.result) return null;
  const tone = p.status === "done" ? "ok" : p.status === "failed" ? "danger" : "warn";
  const batch = Array.isArray(p.params);
  // A card decided before links were kept: the page address, when the stored answer still holds a whole one.
  const link = p.link ?? (p.status === "done" ? (/"html_url":"(https:\/\/[^"\\]+)"/.exec(p.result)?.[1] ?? null) : null);
  return (
    <div className={`pc-outcome ${tone}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {p.status === "failed" ? (
          <span className="min-w-0 break-words">The service said: {p.result}</span>
        ) : batch ? (
          <span>{p.result}</span>
        ) : (
          <span className="font-medium">Done in {p.connector}</span>
        )}
        {!batch && p.status === "done"
          ? (p.brief ?? []).map(([k, v]) => (
              <span key={k} className="pc-fact">
                <span className="text-dim">{k}</span> <span className="font-mono">{v}</span>
              </span>
            ))
          : null}
        {link ? (
          <a href={link} target="_blank" rel="noreferrer noopener" className="pc-open ml-auto">
            Open in {p.connector} ↗
          </a>
        ) : null}
      </div>
      {!batch && p.status === "done" ? (
        <details className="pc-raw">
          <summary>Show what {p.connector} answered</summary>
          <pre>{p.result}</pre>
        </details>
      ) : null}
    </div>
  );
}

type Decide = (id: string, decision: "run" | "decline", scope?: GrantScope, choice?: string) => Promise<void>;

/** A connection as people read it: "your own GitHub “Mine”", "the workspace's “Team GitHub”". */
export function accountName(a: PiAccount): string {
  return `${a.personal ? "your own" : "the workspace's"} “${a.label}”`;
}

export function ProposalCard({ p, onDecide }: { p: PiProposal; onDecide: Decide | null }) {
  if (p.kind === "setting" && p.setting) return <SettingCard p={p} s={p.setting} onDecide={onDecide} />;
  if (p.kind === "account" && p.choice) return <AccountCard p={p} q={p.choice} onDecide={onDecide} />;
  return <ActionCard p={p} onDecide={onDecide} />;
}

/**
 * Forge asks to switch an action of a connected service on (or off). The card says what the action does, through whose
 * connection, what each place means, that it is recorded and how to undo it — and the person picks the place by the
 * button: for them (every Forge Agent chat of theirs here), or the whole workspace. A place they may not choose is
 * shown disabled, with why.
 */
function SettingCard({ p, s, onDecide }: { p: PiProposal; s: PiSettingChange; onDecide: Decide | null }) {
  const [busy, setBusy] = useState<GrantScope | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = STATE[p.status];
  const decide = async (d: "run" | "decline", scope?: GrantScope) => {
    if (!onDecide) return;
    setBusy(scope ?? "decline");
    setError(null);
    try {
      await onDecide(p.id, d, scope);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const verb = s.on ? "on" : "off";
  // Switching OFF is offered only where it is on now.
  const places = (["me", "workspace"] as const).filter((x) => s.on || s.current === x);
  return (
    <section aria-label={`Proposed setting change: ${p.summary}`} className="pc-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="pc-eyebrow">
          {s.service} · Switch {verb} an action
        </span>
        <span className="ml-auto">
          <StatusPill status={state.tone}>{state.label}</StatusPill>
        </span>
      </div>
      <p className="text-body font-medium text-text">{p.summary}</p>
      {s.reason ? <p className="text-xs text-muted">Forge: {s.reason}</p> : null}
      <dl className="pc-values sans" aria-label="What this changes">
        <Fact k="What it does">
          {s.describes}
          <span className={`ml-1 font-medium ${s.effect === "changes" ? "text-warn" : "text-muted"}`}>
            ({s.effect === "changes" ? `changes data in ${s.service}` : `only reads from ${s.service}`})
          </span>
        </Fact>
        {s.connection ? (
          <Fact k="Runs through">
            {s.connection}
            {s.identity ? <span className="text-muted"> · {s.identity}</span> : null}
          </Fact>
        ) : null}
        <Fact k="For me">
          {s.on
            ? "Forge Agent can use it in every chat of yours in this workspace, now and later. No automation and nobody else gains it."
            : "Forge Agent stops using it in your chats."}
        </Fact>
        <Fact k="Whole workspace">
          {s.on ? "Every automation and every chat in this workspace can use it, as when it is switched on in Apps." : "No automation or chat in this workspace can use it any more."}
        </Fact>
        <Fact k="Afterwards">
          {`It is recorded in the workspace's activity. ${s.on ? "Ask Forge to switch it off again, or switch it off on the service's Apps page." : "It can be switched on again the same way."}`}
          {s.on && s.effect === "changes" ? " Each change it makes is still shown to you as its own card first." : ""}
        </Fact>
      </dl>
      {p.status === "pending" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {places.map((x, i) => {
              const may = s.scopes[x];
              const label = s.on ? (x === "me" ? "Allow for me" : "Allow for the workspace") : x === "me" ? "Switch off for me" : "Switch off for the workspace";
              return (
                <Button
                  key={x}
                  size="sm"
                  variant={i === 0 ? undefined : "ghost"}
                  disabled={!!busy || !onDecide || may !== true}
                  title={may === true ? undefined : may}
                  onClick={() => decide("run", x)}
                >
                  {busy === x ? "Applying…" : label}
                </Button>
              );
            })}
            <Button size="sm" variant="ghost" disabled={!!busy || !onDecide} onClick={() => decide("decline")}>
              Cancel
            </Button>
          </div>
          {places
            .filter((x) => s.scopes[x] !== true)
            .map((x) => (
              <p key={x} className="text-caption text-dim">
                {x === "me" ? "For you" : "The workspace"}: {s.scopes[x] as string}
              </p>
            ))}
        </div>
      )}
      {(p.status === "done" || p.status === "failed") && p.result ? (
        <p className={`text-xs ${p.status === "failed" ? "text-danger" : "text-muted"}`}>{p.result}</p>
      ) : null}
      {p.decidedBy && p.status !== "pending" && (
        <p className="text-caption text-dim">
          {p.status === "declined" ? "Cancelled" : `Applied ${p.scope === "workspace" ? "to the workspace" : p.scope === "chat" ? "to this chat" : "for them"}`} by {p.decidedBy}
          {p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleString()}` : ""}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}

/**
 * "Which GitHub should Forge use in this chat?" (plugins 8.5). More than one connection could serve the call, so nothing
 * ran: the person picks one, and the chat uses it for that service until they change it. Forge never picks.
 */
function AccountCard({ p, q, onDecide }: { p: PiProposal; q: PiAccountQuestion; onDecide: Decide | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (id: string | null) => {
    if (!onDecide) return;
    setBusy(id ?? "decline");
    setError(null);
    try {
      await onDecide(p.id, id ? "run" : "decline", undefined, id ?? undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const chosen = q.options.find((o) => o.connectionId === q.chosen);
  return (
    <section aria-label={`Choose a connection: ${p.summary}`} className="pc-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="pc-eyebrow">{q.service} · Choose a connection</span>
        <span className="ml-auto">
          <StatusPill status={p.status === "pending" ? "warn" : p.status === "done" ? "ok" : "neutral"}>
            {p.status === "pending" ? "Waiting for you" : p.status === "done" ? "Chosen" : "Not chosen"}
          </StatusPill>
        </span>
      </div>
      <p className="text-body font-medium text-text">{p.summary}</p>
      {p.status === "pending" ? (
        <>
          <p className="text-xs text-muted">
            {q.purpose === "workflow"
              ? `Nothing ran yet. The workflow acts in ${q.service} as the one you pick; it is saved and approved with the workflow, and you can change it on the workflow's page.`
              : `Nothing was done yet. Forge will read and act in ${q.service} as the one you pick, for the rest of this chat. You can change it later.`}
          </p>
          <div className="pc-accounts" role="group" aria-label={`${q.service} connections`}>
            {q.options.map((o) => (
              <button key={o.connectionId} type="button" className="pc-account" disabled={!!busy || !onDecide} onClick={() => pick(o.connectionId)}>
                <span className="font-medium text-text">{o.personal ? "Your own" : "The workspace's"}</span>
                <span className="text-muted">“{o.label}”</span>
                {o.identity ? <span className="text-caption text-dim">{o.identity}</span> : null}
                {busy === o.connectionId ? <span className="text-caption text-dim">Choosing…</span> : null}
              </button>
            ))}
          </div>
          <div>
            <Button size="sm" variant="ghost" disabled={!!busy || !onDecide} onClick={() => pick(null)}>
              Not now
            </Button>
          </div>
        </>
      ) : chosen ? (
        <p className="text-xs text-muted">
          {q.service} in this chat goes through {accountName(chosen)}
          {chosen.identity ? ` (${chosen.identity})` : ""}.
        </p>
      ) : null}
      {p.decidedBy && p.status !== "pending" && (
        <p className="text-caption text-dim">
          {p.status === "declined" ? "Not chosen" : "Chosen"} by {p.decidedBy}
          {p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleString()}` : ""}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="contents">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ActionCard({ p, onDecide }: { p: PiProposal; onDecide: Decide | null }) {
  const [busy, setBusy] = useState<"run" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = STATE[p.status];
  const decide = async (d: "run" | "decline") => {
    if (!onDecide) return;
    setBusy(d);
    setError(null);
    try {
      await onDecide(p.id, d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const batch = Array.isArray(p.params) ? p.params : null;
  const entries = batch ? [] : Object.entries(p.params as Record<string, unknown>);
  // A batch is a table: one row per entry, one column per value any entry sets — every value on screen before the click.
  const columns = batch ? [...new Set(batch.flatMap((x) => Object.keys(x)))] : [];

  return (
    <section aria-label={`Proposed change: ${p.summary}`} className="pc-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="pc-eyebrow">
          {p.connector} · {p.action}
        </span>
        <span className="ml-auto">
          <StatusPill status={state.tone}>{state.label}</StatusPill>
        </span>
      </div>
      <p className="text-body font-medium leading-snug text-text">{p.summary}</p>
      {entries.length > 0 && (
        <dl className="pc-values" aria-label="The exact values">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k}</dt>
              <dd>
                <Value v={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {batch && (
        <div className="pc-table">
          <table className="w-full text-xs" aria-label="The exact values, one row per item">
            <thead>
              <tr className="text-left text-dim">
                <th className="px-2.5 py-2 font-normal">#</th>
                {columns.map((c) => (
                  <th key={c} className="px-2.5 py-2 font-normal">
                    {c}
                  </th>
                ))}
                {p.results && <th className="px-2.5 py-2 font-normal">Result</th>}
              </tr>
            </thead>
            <tbody className="font-mono text-text">
              {batch.map((row, i) => (
                <tr key={i} className="border-t border-line/60 align-top">
                  <td className="px-2.5 py-2 text-dim">{i + 1}</td>
                  {columns.map((c) => (
                    <td key={c} className="max-w-[18rem] px-2.5 py-2">
                      {c in row ? <Value v={row[c]} compact /> : ""}
                    </td>
                  ))}
                  {p.results && (
                    <td className={`max-w-[16rem] break-words px-2.5 py-2 font-sans ${p.results[i]?.ok ? "text-ok" : "text-danger"}`}>
                      {p.results[i] ? (
                        p.results[i]!.ok ? (
                          p.results[i]!.link ? (
                            <a href={p.results[i]!.link!} target="_blank" rel="noreferrer noopener" className="hover:underline">
                              Done ↗
                            </a>
                          ) : (
                            "Done"
                          )
                        ) : (
                          p.results[i]!.result
                        )
                      ) : (
                        ""
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.status === "pending" && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button size="sm" disabled={!!busy || !onDecide} onClick={() => decide("run")}>
            {busy === "run" ? "Doing it…" : batch ? `Do all ${batch.length}` : "Do it"}
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy || !onDecide} onClick={() => decide("decline")}>
            Cancel
          </Button>
          <span className="text-caption text-dim">
            Nothing changes until you click Do it.{" "}
            {p.account ? `It goes through ${accountName(p.account)}${p.account.identity ? ` (${p.account.identity})` : ""}, ` : "It "}
            {p.account ? "and is recorded." : "is recorded."}
          </span>
        </div>
      )}
      <Outcome p={p} />
      {p.decidedBy && p.status !== "pending" && (
        <p className="text-caption text-dim">
          {p.status === "declined" ? "Cancelled" : "Confirmed"} by {p.decidedBy}
          {p.account ? `, through ${p.account.personal ? "their own" : "the workspace's"} “${p.account.label}”` : p.via === "personal" ? ", through their own connection" : ""}
          {p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleString()}` : ""}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}
