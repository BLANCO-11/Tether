// src/app/(app)/email-box/page.tsx — the Email box.
//
// ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
//
// Testing an automation that emails somebody used to deliver real mail from a
// draft run: a flow naming `foundry_email_send`, draft-run — and gate 1 requires a
// successful run before a flow can be armed, so it delivered before anybody had
// approved anything.
//
// The delivery half is closed at the boundary: `routes/mail.ts` captures
// instead of dialling when the execution's namespace says `draft` (D-52's
// mechanism, migration 0058). This page is where a person reads what was held.
//
// ── ⚠ THE ONE THING THIS PAGE MUST NEVER DO ─────────────────────────────────
//
// It must never let `captured` read as `sent`. A held message is a SUCCESS and
// is not a delivery, so every affordance keeps the two apart: different label,
// different tone, and the caveat sentence rendered beside the list rather than
// tucked into a tooltip. `delivered` is computed server-side as `outcome ===
// "sent"` precisely so no screen reinvents that test as `outcome !== "failed"`,
// which counts a held message as a delivered one.
//
// ── 2026-10-12: an inbox, with a reading pane ───────────────────────────────
//
// A list on the left (outcome dot + word, subject, recipients, time) and the
// selected message on the right, filtered by outcome and searchable. The rule
// is one line rather than a banner. "Clear" removes every NEVER-DELIVERED
// message (held, refused, failed) and the reading pane can delete one; a
// DELIVERED message is the record of real mail and no button removes it — the
// server fixes both sets (`DELETE …/email-box/undelivered`, `…/messages/:id`).

"use client";

import { useMemo, useState } from "react";
import NextLink from "next/link";
import { clearUndeliveredEmails, deleteEmail, getEmailBox } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import type { EmailBoxMessage, Status } from "@/lib/types";
import { ChatFilePreview } from "@/components/pi-builder/ChatFilePreview";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusPill } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/ui/Confirm";
import { Modal } from "@/components/ui/Modal";
import { IconButton } from "@/components/ui/IconButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { Input } from "@/components/ui/Field";
import { Download, FileDoc, Link as LinkIcon, Search, Trash } from "@/components/ui/icons";

/**
 * ⚠ The four outcomes, each with its OWN words. `captured` is deliberately not
 * "Sent" in a different colour: the label is the only thing most people read.
 */
const OUTCOME: Record<
  EmailBoxMessage["outcome"],
  { label: string; tone: Status; what: string }
> = {
  sent: { label: "Delivered", tone: "ok", what: "A person received this." },
  captured: {
    label: "Held (test run)",
    tone: "warn",
    what: "Rendered and addressed, and NOT delivered — the run was a draft.",
  },
  refused: {
    label: "Refused",
    tone: "danger",
    what: "Foundry declined before contacting the mail provider.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    what: "The mail provider was contacted and did not accept it.",
  },
};

function when(at: string | null): string {
  if (!at) return "—";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function Recipients({ to, cc }: { to: string[]; cc: string[] }) {
  if (!to.length && !cc.length) return <span className="text-muted">no recipients</span>;
  return (
    <span className="break-words">
      {to.join(", ")}
      {cc.length > 0 && <span className="text-muted"> · cc {cc.join(", ")}</span>}
    </span>
  );
}

/** "25 Oct 2026, 7:23 pm" — the reading pane's own format; the list keeps the locale string. */
function whenLong(at: string | null): string {
  if (!at) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return `${date}, ${time}`;
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files a message carried. A HELD one can be viewed and downloaded — a test run keeps what it would have sent,
 * at any size, fetched one file at a time (2026-10-13). A delivered one lists names and sizes only, and says so
 * rather than offering a button that has nothing behind it.
 */
function Attachments({ m }: { m: EmailBoxMessage }) {
  const list = m.attachments ?? [];
  const [viewing, setViewing] = useState<number | null>(null);
  if (list.length === 0) return null;
  const shown = viewing === null ? null : list.find((a) => a.position === viewing && a.href);
  const btn =
    "inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-caption text-text transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  return (
    <div>
      <ul className="space-y-2" aria-label="Attachments">
        {list.map((a) => (
          <li key={a.position} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2">
            <span className="text-muted" aria-hidden><FileDoc s={16} /></span>
            <span className="min-w-0 truncate text-caption font-medium text-text">{a.name}</span>
            <span className="text-caption text-dim">{kb(a.bytes)}</span>
            {a.held && a.href ? (
              <span className="ml-auto flex items-center gap-1.5">
                <button type="button" onClick={() => setViewing(a.position)} className={btn}>
                  View
                </button>
                <a href={a.href} download={a.name} className={btn}>
                  <Download s={13} /> Download
                </a>
              </span>
            ) : (
              <span className="ml-auto text-caption text-muted">
                {m.outcome === "captured"
                  ? "this file was not kept (held before files of any size were kept)"
                  : "the file itself is not kept for a delivered message"}
              </span>
            )}
          </li>
        ))}
      </ul>
      {/* The viewer is a dialog: a sheet is a table and wants the width, and closing it leaves the email as it was. */}
      <Modal open={!!shown?.href} onClose={() => setViewing(null)} title={shown?.name ?? "Attachment"} wide>
        {shown?.href ? <ChatFilePreview key={shown.href} name={shown.name} href={shown.href} /> : null}
      </Modal>
    </div>
  );
}

/** The dot beside a message in the list — colour plus the word beside it, never colour alone. */
const DOT: Record<Status, string> = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", neutral: "bg-muted" };

type Filter = "all" | "captured" | "sent" | "problems";
const FILTERS: { key: Filter; label: string; match: (m: EmailBoxMessage) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "captured", label: "Held", match: (m) => m.outcome === "captured" },
  { key: "sent", label: "Delivered", match: (m) => m.outcome === "sent" },
  { key: "problems", label: "Problems", match: (m) => m.outcome === "refused" || m.outcome === "failed" },
];

/** One row of the list. Selecting it opens the message in the reading pane. */
function MessageRow({ m, selected, onSelect }: { m: EmailBoxMessage; selected: boolean; onSelect: () => void }) {
  const o = OUTCOME[m.outcome];
  return (
    <li className="border-b border-line last:border-0">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`flex w-full flex-col gap-0.5 px-4 py-3 text-left transition-colors duration-150 ${
          selected ? "bg-accent-bg-2" : "hover:bg-surface-2"
        }`}
      >
        <span className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[o.tone] ?? "bg-muted"}`} aria-hidden />
          <span className="text-caption text-muted">{o.label}</span>
          <span className="ml-auto shrink-0 text-caption tabular-nums text-dim">{when(m.at)}</span>
        </span>
        <span className="truncate text-body text-text">{m.subject || "no subject"}</span>
        <span className="truncate text-caption text-dim">
          {m.recipients.length ? m.recipients.join(", ") : "no recipients"}
        </span>
      </button>
    </li>
  );
}

/** The reading pane: everything about one message. The body is present only for a held one. */
function Reader({ m, onDelete, busy }: { m: EmailBoxMessage; onDelete: () => void; busy: boolean }) {
  const o = OUTCOME[m.outcome];
  return (
    <article className="flex min-w-0 flex-col gap-4 p-5" aria-label="Selected email">
      <div>
        <div className="flex items-center gap-1.5">
          <h3 className="min-w-0 truncate text-lg font-medium text-text">{m.subject || <span className="text-muted">no subject</span>}</h3>
          {/* The workflow that sent it, in a new tab. A deleted workflow keeps its name (the run's snapshot) and
              loses its page, so it shows as unavailable rather than leading to a 404. */}
          {m.flowId ? (
            <NextLink
              href={`/flows/${m.flowId}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open workflow${m.flowName ? `: ${m.flowName}` : ""}`}
              title={`Open workflow${m.flowName ? `: ${m.flowName}` : ""} (new tab)`}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <LinkIcon s={15} />
            </NextLink>
          ) : m.flowName ? (
            <span
              title={`Workflow deleted: ${m.flowName}`}
              aria-label={`Workflow deleted: ${m.flowName}`}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim opacity-50"
            >
              <LinkIcon s={15} />
            </span>
          ) : null}
          <span className="ml-auto" />
          {/* ⚠ Never on a delivered message: it is the record that real mail was sent. */}
          {m.outcome !== "sent" && (
            <IconButton label="Delete this email" disabled={busy} onClick={onDelete} className="hover:text-danger">
              <Trash s={16} />
            </IconButton>
          )}
        </div>
        <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] leading-4 text-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${DOT[o.tone] ?? "bg-muted"}`} aria-hidden />
          {o.label}
        </span>
      </div>
      <dl className="space-y-1.5 text-caption">
        <div className="flex items-baseline gap-3">
          <dt className="w-14 shrink-0 text-[11px] uppercase tracking-label text-dim">To</dt>
          <dd className="min-w-0 text-text"><Recipients to={m.recipients} cc={m.cc} /></dd>
        </div>
        {m.resolvedFrom && (
          <div className="flex items-baseline gap-3">
            <dt className="w-14 shrink-0 text-[11px] uppercase tracking-label text-dim">Why</dt>
            <dd className="text-muted">{m.resolvedFrom === "requester" ? "Sent to whoever started the run" : "Addresses named by the automation"}</dd>
          </div>
        )}
        <div className="flex items-baseline gap-3">
          <dt className="w-14 shrink-0 text-[11px] uppercase tracking-label text-dim">When</dt>
          <dd className="text-muted">{whenLong(m.at)}</dd>
        </div>
      </dl>
      <Attachments m={m} />
      {/* One quiet line, kept: it is what stops a held message reading as a delivered one. */}
      <p className="text-caption text-dim">{o.what}</p>
      {m.failureReason && <p className="break-words text-caption text-danger">{m.failureReason}</p>}
      {/* ⚠ Only a HELD message has a body to show. A delivered one stores none,
          and the absence is stated rather than rendered as an empty box. */}
      {m.outcome === "captured" &&
        (m.body ? (
          <div
            className="max-h-[60vh] overflow-auto rounded-md border border-line bg-bg p-4 text-body"
            // The stored value is the report `mail-report.ts` rendered, and
            // that module escapes every value it interpolates — which is the
            // same guarantee that lets it be sent as HTML. Nothing from a
            // flow can become markup here that could not already become
            // markup in the mailbox.
            dangerouslySetInnerHTML={{ __html: m.body }}
          />
        ) : (
          <p className="text-caption text-muted">The message body was not recorded for this one.</p>
        ))}
      {m.outcome !== "captured" && (
        <p className="text-caption text-dim">A delivered, refused or failed message keeps no body — only a held one does.</p>
      )}
    </article>
  );
}


/** One compact count in the header: a coloured dot, the number, the label. Read-only. */
function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} aria-hidden />
      <span className="text-body font-medium tabular-nums text-text">{n}</span>
      <span className="text-caption text-muted">{label}</span>
    </div>
  );
}

export default function EmailBoxPage() {
  const box = useAsync(getEmailBox);
  const toast = useToast();
  const [confirmingUndelivered, setConfirmingUndelivered] = useState(false);
  const [confirmingOne, setConfirmingOne] = useState<EmailBoxMessage | null>(null);
  const [clearing, setClearing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const foundry = box.data?.foundry ?? [];
  const held = foundry.filter((m) => m.outcome === "captured").length;
  const delivered = foundry.filter((m) => m.outcome === "sent").length;
  const problems = foundry.filter((m) => m.outcome === "refused" || m.outcome === "failed").length;
  /** Everything a button may remove: held, refused and failed. Never a delivered message. */
  const undelivered = held + problems;
  // ⚠ "Still loading" is no data AND no error: a failed read must not sit on a skeleton for ever.
  const waiting = !box.data && !box.error;

  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const needle = q.trim().toLowerCase();
    return foundry.filter(
      (m) =>
        f.match(m) &&
        (!needle ||
          (m.subject ?? "").toLowerCase().includes(needle) ||
          [...m.recipients, ...m.cc].some((r) => r.toLowerCase().includes(needle))),
    );
  }, [foundry, filter, q]);
  // Nothing is open until a person clicks a message, and one filtered out of the list closes rather than being
// replaced by another — a reading pane that opens an email nobody chose is a pane that may be read by mistake.
const selected = shown.find((m) => m.id === selectedId) ?? null;

  const doClearUndelivered = async () => {
    setClearing(true);
    try {
      const r = await clearUndeliveredEmails();
      toast.success(r.cleared === 1 ? "Cleared 1 email" : `Cleared ${r.cleared} emails`);
      setSelectedId(null);
      box.reload();
    } catch (e) {
      toast.error(`Could not clear the emails: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setClearing(false);
    }
  };

  const doDeleteOne = async (m: EmailBoxMessage) => {
    setClearing(true);
    try {
      await deleteEmail(m.id);
      toast.success("Email deleted");
      setSelectedId(null);
      box.reload();
    } catch (e) {
      toast.error(`Could not delete the email: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Page>
      <PageHeader
        eyebrow="Resources"
        title="Email box"
        aside={
          box.data ? (
            <>
              <Stat n={delivered} label="Delivered" tone="bg-ok" />
              <Stat n={held} label="Held (test runs)" tone="bg-warn" />
              <Stat n={problems} label="Refused or failed" tone={problems ? "bg-danger" : "bg-muted"} />
            </>
          ) : undefined
        }
      />

      <Zone name="notices" gap="tight">
        {/* ⚠ `error` is read. A page that cannot report failure renders an empty
            list instead, which is the same lie with fewer steps. */}
        {box.error && (
          <Notice tone="danger" title="The Email box could not be read">
            <p>{box.error}</p>
            {/* ⚠ Its own element, so the sentence is one text node and a test
                can assert on it. And its own SENTENCE, because an error banner
                above an empty list otherwise reads as a confirmed absence. */}
            <p className="mt-1">Nothing below is a claim that no email was sent.</p>
          </Notice>
        )}
      </Zone>

      <Zone name="content">
        <section className="pane overflow-hidden" aria-label="Emails sent by your automations">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
            <div className="relative w-56">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"><Search s={13} /></span>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject or recipient" aria-label="Search emails" className="pl-8" />
            </div>
            <div role="tablist" aria-label="Filter emails" className="flex items-center gap-1">
              {FILTERS.map((f) => {
                const n = foundry.filter(f.match).length;
                const on = f.key === filter;
                return (
                  <button
                    key={f.key}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setFilter(f.key)}
                    className={`rounded-md px-2.5 py-1 text-caption transition-colors duration-150 ${
                      on ? "bg-surface-2 text-text" : "text-muted hover:text-text"
                    }`}
                  >
                    {f.label} <span className="tabular-nums text-dim">{n}</span>
                  </button>
                );
              })}
            </div>
            {/* Offered only when there is something a button may remove. */}
            {undelivered > 0 && (
              <Button className="ml-auto" variant="ghost" size="sm" disabled={clearing} onClick={() => setConfirmingUndelivered(true)}>
                Clear undelivered
              </Button>
            )}
          </div>

          {waiting ? (
            <Skeleton rows={4} className="p-4" />
          ) : foundry.length === 0 ? (
            <EmptyState title="No automation in this workspace has sent an email yet — when one does it appears here, held if the run was a test and delivered if it was live." />
          ) : shown.length === 0 ? (
            <p className="px-4 py-6 text-caption text-muted">No email matches this filter.</p>
          ) : (
            <div className="flex flex-col lg:flex-row">
              <ul className="max-h-[70vh] overflow-auto border-line lg:w-[360px] lg:shrink-0 lg:border-r" aria-label="Emails">
                {shown.map((m) => (
                  <MessageRow key={m.id} m={m} selected={selected?.id === m.id} onSelect={() => setSelectedId(selected?.id === m.id ? null : m.id)} />
                ))}
              </ul>
              <div className="min-w-0 flex-1 border-t border-line lg:border-t-0">
                {selected ? (
                  <Reader m={selected} busy={clearing} onDelete={() => setConfirmingOne(selected)} />
                ) : (
                  <div className="flex h-full min-h-[240px] items-center justify-center p-8 text-center text-caption text-dim">
                    Select an email to read it.
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </Zone>

      <Confirm
        open={confirmingUndelivered}
        title="Clear the undelivered emails?"
        body={`This permanently deletes the ${undelivered} email${undelivered === 1 ? "" : "s"} in this workspace that were never delivered — ${held} held from test runs and ${problems} refused or failed. Delivered emails stay: they are the record of real mail. This cannot be undone.`}
        confirmLabel={`Clear ${undelivered === 1 ? "1 email" : `${undelivered} emails`}`}
        danger
        onConfirm={doClearUndelivered}
        onClose={() => setConfirmingUndelivered(false)}
      />
      <Confirm
        open={!!confirmingOne}
        title="Delete this email?"
        body={`“${confirmingOne?.subject || "no subject"}” was never delivered, and is removed from the Email box. This cannot be undone.`}
        confirmLabel="Delete email"
        danger
        onConfirm={() => confirmingOne && doDeleteOne(confirmingOne)}
        onClose={() => setConfirmingOne(null)}
      />
    </Page>
  );
}
