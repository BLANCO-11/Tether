"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/ui/Confirm";
import {
  BREAK_GLASS_COPY,
  BREAK_GLASS_MESSAGES,
  DEFAULT_DURATION,
  DURATION_OPTIONS,
  SCOPE_OPTIONS,
  validateBreakGlass,
  type BreakGlassErrors,
} from "@/lib/break-glass";
import { useWorkspace } from "@/lib/workspace";
import { useAsync } from "@/lib/hooks";
import {
  activateBreakGlass,
  activeBreakGlass,
  listIncidents,
  revokeBreakGlass,
} from "@/lib/api";
import { FoundryApiError } from "@/lib/foundry-client";
import type { FABreakGlassSession } from "@/lib/foundry-client";

const FIELD_CONTROL =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

const FOUR_HOURS = "4 hours · SEV1 only" as const;

export default function BreakGlassPage() {
  const { workspaceId } = useWorkspace();
  const [incident, setIncident] = useState("");
  const [scope, setScope] = useState("");
  const [duration, setDuration] = useState<string>(DEFAULT_DURATION);
  const [justification, setJustification] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<BreakGlassErrors>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [activated, setActivated] = useState<FABreakGlassSession | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const incidentRef = useRef<HTMLSelectElement>(null);
  const scopeRef = useRef<HTMLSelectElement>(null);
  const justificationRef = useRef<HTMLTextAreaElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);

  const incidents = useAsync(
    () => (workspaceId ? listIncidents(workspaceId) : Promise.resolve([])),
    [workspaceId],
  );
  const sessions = useAsync(
    () => (workspaceId ? activeBreakGlass(workspaceId) : Promise.resolve([])),
    [workspaceId],
  );

  const openIncidents = (incidents.data ?? []).filter((i) => i.status !== "closed");
  const incidentsLoaded = incidents.data !== null && !incidents.loading;
  const selected = openIncidents.find((i) => i.id === incident) ?? null;
  const fourHoursAllowed = selected?.severity === "sev1";
  const submitBlocked =
    submitting || incidents.loading || incidents.error !== null || (incidentsLoaded && openIncidents.length === 0);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = { incident, scope, duration, justification, acknowledged };
    const next = validateBreakGlass(input);
    // The library's 4-hour check only knows the fixture severities; the real
    // severity of the selected incident is the authority here.
    if (duration === FOUR_HOURS) {
      if (fourHoursAllowed) delete next.duration;
      else next.duration = BREAK_GLASS_MESSAGES.durationSev1;
    }
    setErrors(next);
    setActionError(null);
    const keys = Object.keys(next) as Array<keyof BreakGlassErrors>;
    if (keys.length) {
      const first = keys[0];
      if (first === "incident") incidentRef.current?.focus();
      else if (first === "scope") scopeRef.current?.focus();
      else if (first === "duration") incidentRef.current?.focus();
      else if (first === "justification") justificationRef.current?.focus();
      else if (first === "acknowledged") ackRef.current?.focus();
      return;
    }
    const hours = duration === FOUR_HOURS ? 4 : duration === "1 hour" ? 1 : 2;
    if (hours === 4 && selected?.severity !== "sev1") {
      setErrors({ duration: BREAK_GLASS_MESSAGES.durationSev1 });
      incidentRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const session = await activateBreakGlass(workspaceId, {
        incidentId: incident,
        scope: scope as "hris-unmasked" | "payroll-restricted",
        durationHours: hours,
        justification,
        acknowledged: true,
      });
      setActivated(session);
      sessions.reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Break-glass activation failed.";
      setActionError(
        err instanceof FoundryApiError && err.status === 403
          ? `${message} A super admin can grant it on People & access.`
          : message,
      );
    } finally {
      setSubmitting(false);
    }
  };
  const onRevoke = async () => {
    if (!revokeId) return;
    const id = revokeId;
    setRevokeId(null);
    try {
      await revokeBreakGlass(workspaceId, id);
      sessions.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Revoking the session failed.");
    }
  };

  return (
    <Page measure="form">
      {/* PageHeader renders its own header zone — wrapping it in another drew the header area twice. */}
      <PageHeader eyebrow="Admin" title={BREAK_GLASS_COPY.title} purpose={BREAK_GLASS_COPY.purpose} />

      <Zone name="notices">
        <Notice tone="danger" title={BREAK_GLASS_COPY.noticeTitle}>
          {BREAK_GLASS_COPY.noticeBody}
        </Notice>
        {activated && (
          <Notice tone="ok" title="Break-glass is active">
            {`Session ${activated.id} is active with scope ${activated.scope} until ${activated.expiresAt}.`}
          </Notice>
        )}
        {actionError && (
          <Notice tone="danger" title="Break-glass action failed">
            {actionError}
          </Notice>
        )}
      </Zone>

      <Zone name="content">
        {incidents.error && (
          <div className="mb-4">
            <Notice tone="warn" title="Could not load incidents">
              {`The incident list could not be read, so no incident can be chosen — the check did not run. ${incidents.error}`}
            </Notice>
          </div>
        )}
        {incidentsLoaded && !incidents.error && openIncidents.length === 0 && (
          <div className="mb-4">
            <Notice tone="warn" title="No open incident">
              Break-glass needs an incident to attach the session to, and this workspace has none open.{" "}
              <Link href="/admin/incidents" className="underline">
                Open one on Incidents
              </Link>
              .
            </Notice>
          </div>
        )}
        <form
          onSubmit={onSubmit}
          noValidate
          className="rounded-lg border border-line bg-surface-1 p-6"
          aria-label="Break-glass activation form"
        >
          <div className="flex flex-col gap-5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
                Incident<span className="ml-1 text-danger" aria-hidden>*</span>
              </span>
              <select
                ref={incidentRef}
                value={incident}
                onChange={(e) => setIncident(e.target.value)}
                aria-label="Incident"
                aria-invalid={errors.incident ? true : undefined}
                aria-describedby={errors.incident ? "err-incident" : undefined}
                className={`${FIELD_CONTROL} ${errors.incident ? "border-danger focus:border-danger focus-visible:ring-danger/50" : ""}`}
              >
                <option value="">Select an incident</option>
                {openIncidents.map((i) => (
                  <option key={i.id} value={i.id}>
                    {`${i.id} — ${i.title} (${i.severity.toUpperCase()})`}
                  </option>
                ))}
              </select>
              {errors.incident && (
                <span id="err-incident" className="mt-1 block text-xs text-danger">
                  {errors.incident}
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
                Emergency scope<span className="ml-1 text-danger" aria-hidden>*</span>
              </span>
              <select
                ref={scopeRef}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                aria-label="Emergency scope"
                aria-invalid={errors.scope ? true : undefined}
                aria-describedby={errors.scope ? "err-scope" : undefined}
                className={`${FIELD_CONTROL} ${errors.scope ? "border-danger focus:border-danger focus-visible:ring-danger/50" : ""}`}
              >
                {SCOPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {errors.scope && (
                <span id="err-scope" className="mt-1 block text-xs text-danger">
                  {errors.scope}
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">Duration</span>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                aria-label="Duration"
                aria-invalid={errors.duration ? true : undefined}
                aria-describedby={errors.duration ? "err-duration" : undefined}
                className={`${FIELD_CONTROL} ${errors.duration ? "border-danger focus:border-danger focus-visible:ring-danger/50" : ""}`}
              >
                {DURATION_OPTIONS.map((o) => (
                  <option
                    key={o.value}
                    value={o.value}
                    disabled={o.value === FOUR_HOURS && !fourHoursAllowed}
                  >
                    {o.label}
                  </option>
                ))}
              </select>
              {errors.duration && (
                <span id="err-duration" className="mt-1 block text-xs text-danger">
                  {errors.duration}
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text">
                Justification<span className="ml-1 text-danger" aria-hidden>*</span>
              </span>
              <textarea
                ref={justificationRef}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                aria-label="Justification"
                placeholder={BREAK_GLASS_COPY.justificationHint}
                rows={4}
                aria-invalid={errors.justification ? true : undefined}
                aria-describedby={errors.justification ? "err-justification" : "hint-justification"}
                className={`${FIELD_CONTROL} font-normal ${errors.justification ? "border-danger focus:border-danger focus-visible:ring-danger/50" : ""}`}
              />
              {!errors.justification ? (
                <span id="hint-justification" className="mt-1 block text-xs text-muted">
                  {BREAK_GLASS_COPY.justificationHint}
                </span>
              ) : (
                <span id="err-justification" className="mt-1 block text-xs text-danger">
                  {errors.justification}
                </span>
              )}
            </label>

            <label className="flex items-start gap-2">
              <input
                ref={ackRef}
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                aria-label={BREAK_GLASS_COPY.checkbox}
                aria-invalid={errors.acknowledged ? true : undefined}
                aria-describedby={errors.acknowledged ? "err-acknowledged" : undefined}
                className="mt-1 h-4 w-4 rounded border-line"
              />
              <span className="text-sm text-text">{BREAK_GLASS_COPY.checkbox}</span>
            </label>
            {errors.acknowledged && (
              <span id="err-acknowledged" className="-mt-3 block text-xs text-danger">
                {errors.acknowledged}
              </span>
            )}

            <div className="flex justify-end pt-2">
              <Button type="submit" variant="danger" disabled={submitBlocked}>
                {BREAK_GLASS_COPY.button}
              </Button>
            </div>
          </div>
        </form>
        <p className="mt-3 text-xs text-muted">
          Break-glass access expires automatically. The longest duration is severity-gated — 4 hours · SEV1 only, stated in the
          option label itself.
        </p>

        <div className="mt-8">
          <h2 className="text-sm font-medium text-text">Active sessions</h2>
          {sessions.error ? (
            <div className="mt-2">
              <Notice tone="warn" title="Could not load active sessions">
                {`The active sessions could not be read, so this is not “no active sessions” — the check did not run. ${sessions.error}`}
              </Notice>
            </div>
          ) : sessions.data === null || sessions.loading ? (
            <p className="mt-2 text-sm text-muted">Loading active sessions…</p>
          ) : sessions.data.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No break-glass session is active in this workspace.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {sessions.data.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-1 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-text">{s.id}</p>
                    <p className="mt-1 text-xs text-muted">
                      {`Scope ${s.scope} · activated by ${s.activatedBySubject} · expires ${s.expiresAt} · ${s.status}`}
                    </p>
                  </div>
                  <Button variant="ghost" onClick={() => setRevokeId(s.id)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Confirm
          open={revokeId !== null}
          title="Revoke this break-glass session?"
          body="The session ends immediately. Every action taken in it stays in the audit trail for the post-incident review."
          confirmLabel="Revoke session"
          danger
          onConfirm={onRevoke}
          onClose={() => setRevokeId(null)}
        />
      </Zone>

      <Zone name="related">
        <p className="text-sm text-muted">
          Every session ends in a post-incident review — the justification above is read there.
        </p>
      </Zone>
    </Page>
  );
}
