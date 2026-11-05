"use client";

/** Grant / revoke per-person read access to a run (Phase 5) — People-listed members only; no public link. */
import { useEffect, useState } from "react";
import { grantRunShare, listMembers, listRunShares, revokeRunShare } from "@/lib/api";
import type { WorkspaceMember } from "@/lib/types";
import { useResolvedWorkspace } from "@/lib/workspace";
import { Modal } from "@/components/ui/Modal";
import { Notice } from "@/components/ui/Notice";
import { Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/lib/toast";

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ShareRunDialog({
  runId,
  open,
  onClose,
}: {
  runId: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const workspaceId = useResolvedWorkspace();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [shares, setShares] = useState<Array<{ subject: string }>>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !workspaceId) return;
    setError(null);
    setPick("");
    void Promise.all([listMembers(workspaceId), listRunShares(runId)])
      .then(([m, s]) => {
        setMembers(m);
        setShares(s);
      })
      .catch((e) => setError(said(e)));
  }, [open, runId, workspaceId]);

  const sharedSubjects = new Set(shares.map((s) => s.subject));
  const candidates = members.filter((m) => !sharedSubjects.has(m.subject));

  const add = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      await grantRunShare(runId, pick);
      setShares(await listRunShares(runId));
      setPick("");
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (subject: string) => {
    try {
      await revokeRunShare(runId, subject);
      setShares(await listRunShares(runId));
    } catch (e) {
      toast.error(said(e));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Share this run">
      <p className="text-caption text-muted">They can read this run. Only you (or an Admin) can share it. No public link.</p>
      {error ? (
        <Notice tone="danger" title="Could not share" className="mt-3">
          {error}
        </Notice>
      ) : null}
      <ul className="mt-3 flex flex-col gap-1">
        {shares.length === 0 ? <li className="text-caption text-muted">Nobody yet.</li> : null}
        {shares.map((s) => {
          const name = members.find((m) => m.subject === s.subject)?.email ?? s.subject;
          return (
            <li key={s.subject} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-body">
              <span className="truncate">{name}</span>
              <button type="button" className="text-caption font-medium text-danger hover:underline" onClick={() => void remove(s.subject)}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex gap-2">
        <Select aria-label="Person to share with" className="min-w-0 flex-1" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || !candidates.length}>
          <option value="">{candidates.length ? "Choose someone…" : "Everyone who can be added already has it"}</option>
          {candidates.map((m) => (
            <option key={m.subject} value={m.subject}>
              {m.email || m.subject}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!pick || busy} onClick={() => void add()}>
          {busy ? "…" : "Share"}
        </Button>
      </div>
    </Modal>
  );
}
