"use client";

// The two ways a cost report leaves the screen (2026-10-26). They are separate buttons with separate dialogs on the
// page because they are different acts: Download saves a file for the person who can already see it, and Email sends
// it to people who may hold NO access to these workspaces. This component renders both so the choices (period,
// workspaces, person) are one definition, and says plainly which act the person is about to make.
//
// What a person may choose is limited to what the server returned for them: the workspace list comes from the
// summary, which the server already narrowed to the workspaces they administer. The server checks again on send.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/lib/toast";
import { downloadReport, emailReport, getReportSummary } from "@/lib/api";
import { parseRecipients, recipientProblem, usd, type ReportQuery, type ReportSummary } from "@/lib/reports";

type Period = "30" | "60" | "90" | "custom";
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function ReportDialog({
  mode,
  open,
  onClose,
  workspaces,
  start,
}: {
  mode: "download" | "email";
  open: boolean;
  onClose: () => void;
  /** Everything this person may report on — never more than the server offered. */
  workspaces: Array<{ id: string; name: string }>;
  /** What is on screen now, so the dialog opens on it. */
  start: ReportQuery;
}) {
  const toast = useToast();
  const email = mode === "email";
  const [period, setPeriod] = useState<Period>("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [preview, setPreview] = useState<ReportSummary | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [to_, setTo_] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  // What goes in the file(s): the PDF report, the Excel raw data, or both. At least one must stay ticked.
  const [wantReport, setWantReport] = useState(true);
  const [wantExcel, setWantExcel] = useState(true);
  const format: "xlsx" | "pdf" | "both" = wantReport && wantExcel ? "both" : wantReport ? "pdf" : "xlsx";
  const nothingChosen = !wantReport && !wantExcel;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Open on what the page is showing.
  useEffect(() => {
    if (!open) return;
    const today = new Date();
    const days = start.days ?? 30;
    setPeriod(start.from && start.to ? "custom" : days === 60 || days === 90 ? (String(days) as Period) : days === 30 ? "30" : "custom");
    setFrom(start.from ?? isoDay(new Date(today.getTime() - (days - 1) * 86_400_000)));
    setTo(start.to ?? isoDay(today));
    setPicked(start.workspaces?.length ? start.workspaces : workspaces.map((w) => w.id));
    setSubject(start.subject ?? "");
    setTo_("");
    setNote("");
    setTouched(false);
    setFailure(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rangeProblem =
    period !== "custom" ? null : !from || !to ? "Pick both a start and an end date." : from > to ? "The start date is after the end date." : null;
  const everyone = picked.length === workspaces.length;
  const base: ReportQuery = useMemo(
    () => ({
      ...(period === "custom" ? { from, to } : { days: Number(period) }),
      ...(everyone ? {} : { workspaces: picked }),
    }),
    [period, from, to, picked, everyone],
  );
  const query: ReportQuery = useMemo(() => ({ ...base, ...(subject ? { subject } : {}) }), [base, subject]);
  const nothingPicked = picked.length === 0;

  // The people to choose from: everyone with usage in the chosen period and workspaces (no person filter applied).
  useEffect(() => {
    if (!open || rangeProblem || nothingPicked) return setPeople([]);
    let live = true;
    getReportSummary(base)
      .then((s) => live && setPeople(s.lenses.people.filter((p) => p.id).map((p) => ({ id: p.id as string, name: p.name }))))
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [open, base, rangeProblem, nothingPicked]);

  // The live count and cost, from the same endpoint the page reads, so the file and the screen agree.
  useEffect(() => {
    if (!open || rangeProblem || nothingPicked) return setPreview(null);
    let live = true;
    setPreviewError(null);
    getReportSummary(query)
      .then((s) => live && setPreview(s))
      .catch((e) => live && (setPreview(null), setPreviewError(e?.message ?? "Could not count what this report holds.")));
    return () => {
      live = false;
    };
  }, [open, query, rangeProblem, nothingPicked]);

  // A person who is not in the chosen scope cannot stay selected.
  useEffect(() => {
    if (subject && people.length && !people.some((p) => p.id === subject)) setSubject("");
  }, [people, subject]);

  const recipients = parseRecipients(to_);
  const recipientsIssue = email ? recipientProblem(recipients) : null;
  const empty = !!preview && preview.tiles.runs === 0;
  const blocked = busy || nothingChosen || !!rangeProblem || nothingPicked || empty || !preview || (email && !!recipientsIssue);

  function toggle(id: string) {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function go() {
    setBusy(true);
    setFailure(null);
    try {
      if (email) {
        const r = await emailReport(query, { recipients, note: note.trim() || undefined, formats: [...(wantReport ? (['pdf'] as const) : []), ...(wantExcel ? (['xlsx'] as const) : [])] });
        toast.success(`Sent ${r.filename} to ${r.recipients.join(", ")}`);
      } else {
        const { blob, filename } = await downloadReport(query, format);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast.success(`Downloaded ${filename}`);
      }
      onClose();
    } catch (e) {
      setFailure((e as Error)?.message || (email ? "The report was not sent." : "The report could not be downloaded."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={email ? "Email report" : "Download report"}>
      <div className="space-y-4 text-sm">
        {email ? (
          <Notice tone="info" title="This shares the report outside the workspaces">
            The people you send it to do not need access to these workspaces to read it. It goes as attached
            files (the ones you tick below), a snapshot taken now, and each send is recorded.
          </Notice>
        ) : null}

        {email ? (
          <div className="space-y-1">
            <label htmlFor="rep-to" className="text-caption font-medium uppercase tracking-wide text-dim">Send to</label>
            <input
              id="rep-to"
              type="text"
              inputMode="email"
              autoComplete="off"
              value={to_}
              onChange={(e) => setTo_(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={touched && !!recipientsIssue}
              placeholder="name@microland.com, another@microland.com"
              className="h-9 w-full rounded-md border border-line bg-surface px-3 text-text"
            />
            <p className="text-xs text-muted">Separate several addresses with commas. Only company addresses are accepted.</p>
            {touched && recipientsIssue ? <p className="text-xs text-danger">{recipientsIssue}</p> : null}
          </div>
        ) : null}

        <fieldset className="space-y-2">
          <legend className="text-caption font-medium uppercase tracking-wide text-dim">Period</legend>
          <div className="flex flex-wrap gap-2">
            {(["30", "60", "90", "custom"] as const).map((p) => (
              <label key={p} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 ${period === p ? "border-accent bg-accent/10" : "border-line"}`}>
                <input type="radio" name="rep-period" value={p} checked={period === p} onChange={() => setPeriod(p)} />
                {p === "custom" ? "Custom range" : `Last ${p} days`}
              </label>
            ))}
          </div>
          {period === "custom" ? (
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-1 flex-col gap-1 text-xs text-muted">From
                <input id="rep-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-text" />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-xs text-muted">To
                <input id="rep-to-day" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-text" />
              </label>
            </div>
          ) : null}
          {rangeProblem ? <p className="text-xs text-danger">{rangeProblem}</p> : null}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-caption font-medium uppercase tracking-wide text-dim">Workspaces</legend>
          <label className="flex items-center gap-2 border-b border-line pb-2 font-medium">
            <input type="checkbox" checked={everyone} onChange={() => setPicked(everyone ? [] : workspaces.map((w) => w.id))} />
            All workspaces
          </label>
          <div className="grid gap-1 sm:grid-cols-2">
            {workspaces.map((w) => (
              <label key={w.id} className="flex items-center gap-2">
                <input type="checkbox" checked={picked.includes(w.id)} onChange={() => toggle(w.id)} />
                {w.name}
              </label>
            ))}
          </div>
          {nothingPicked ? <p className="text-xs text-danger">Pick at least one workspace.</p> : null}
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="rep-person" className="text-caption font-medium uppercase tracking-wide text-dim">Person</label>
          <select id="rep-person" value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-text">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        {email ? (
          <div className="space-y-1">
            <label htmlFor="rep-note" className="text-caption font-medium uppercase tracking-wide text-dim">Message (optional)</label>
            <textarea id="rep-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-md border border-line bg-surface px-3 py-2 text-text" />
          </div>
        ) : null}

        <fieldset className="space-y-1">
          <legend className="text-caption font-medium uppercase tracking-wide text-dim">{email ? "Attach" : "Include"}</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-text">
              <input type="checkbox" checked={wantReport} onChange={(e) => setWantReport(e.target.checked)} />
              Report (PDF)
            </label>
            <label className="flex items-center gap-2 text-text">
              <input type="checkbox" checked={wantExcel} onChange={(e) => setWantExcel(e.target.checked)} />
              Excel (raw data)
            </label>
          </div>
          {nothingChosen ? <p className="text-xs text-danger">Choose at least one.</p> : null}
        </fieldset>

        <p className="text-xs text-muted">
          {nothingChosen
            ? ""
            : [
                wantReport ? "Report (PDF): key figures, highlights, charts and how it compares with the previous period." : "",
                wantExcel ? "Excel (raw data): a sheet each for workspaces, workflows, people and every run." : "",
              ]
                .filter(Boolean)
                .join(" ")}
          {!email && wantReport && wantExcel ? " Downloaded together as one zip." : ""}
        </p>

        {previewError ? <p className="text-xs text-danger">{previewError}</p> : null}
        {failure ? <Notice tone="danger" title={email ? "The report was not sent" : "The report could not be downloaded"}>{failure}</Notice> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <span className="text-xs tabular-nums text-muted" aria-live="polite">
            {nothingPicked || rangeProblem
              ? ""
              : preview
                ? empty
                  ? "No runs match these choices."
                  : `${preview.tiles.runs} runs · ${usd(preview.tiles.costUsd)} in this report`
                : "Counting…"}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={onClose}>Cancel</Button>
            <Button size="sm" type="button" disabled={blocked} onClick={go}>
              {busy ? (email ? "Sending…" : "Preparing…") : email ? "Send email" : format === "pdf" ? "Download PDF" : format === "both" ? "Download both (zip)" : "Download workbook"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
