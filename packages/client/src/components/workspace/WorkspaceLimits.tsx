"use client";

// A workspace's execution budget: how much it may run at once, and per day. Moved here from the Admin overview
// (admin simplify, phase 4) so a workspace's limits live on the workspace's page, the one place they are changed.
//
// Three states for the budget, as everywhere: the budget, unreadable (which says the check did not run, never "no
// limit"), and loading. `canChange` hides the form for a reader who may only look; the route still refuses.

import { useEffect, useState, type ReactNode } from "react";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Confirm } from "@/components/ui/Confirm";
import { Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { clearBudget, getBudget, setBudget } from "@/lib/api";

export function WorkspaceLimits({ workspaceId, canChange }: { workspaceId: string; canChange: boolean }) {
  const toast = useToast();
  const budget = useAsync(() => getBudget(workspaceId), [workspaceId]);
  const [maxConc, setMaxConc] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (!budget.data) return;
    setMaxConc(String(budget.data.maxConcurrentExecutions));
    setMaxTokens(budget.data.maxTokensPerDay === null ? "" : String(budget.data.maxTokensPerDay));
  }, [budget.data]);

  const save = async () => {
    const conc = Number(maxConc);
    const tokens = maxTokens.trim() === "" ? null : Number(maxTokens);
    if (!Number.isInteger(conc) || conc <= 0) {
      toast.warn("Runs at once must be a positive whole number.");
      return;
    }
    if (tokens !== null && (!Number.isInteger(tokens) || tokens <= 0)) {
      toast.warn("Tokens per day must be a positive whole number, or empty for no daily limit.");
      return;
    }
    setSaving(true);
    try {
      await setBudget(workspaceId, { maxConcurrentExecutions: conc, maxTokensPerDay: tokens });
      toast.success("Limits saved.");
      budget.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    try {
      await clearBudget(workspaceId);
      budget.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="pane" aria-labelledby="limits-head">
      <div className="border-b border-line px-4 py-3">
        <h2 id="limits-head" className="text-body font-semibold">Limits</h2>
        <p className="mt-0.5 text-caption text-dim">How much this workspace may run at once, and per day.</p>
      </div>
      <div className="p-4">
        {budget.error ? (
          <Notice tone="warn" title="Could not load the limits">
            The limits could not be read, so nothing here is the current limit. ({budget.error})
          </Notice>
        ) : !budget.data ? (
          <Skeleton rows={3} />
        ) : (
          <>
            {!budget.data.configured && (
              <p className="mb-4 text-caption text-muted">None set for this workspace, so the deployment defaults apply.</p>
            )}
            <div className="flex flex-col gap-4 sm:flex-row">
              <Field label="Runs at once">
                <Input value={maxConc} onChange={(e) => setMaxConc(e.target.value)} inputMode="numeric" disabled={!canChange} aria-label="Runs at once" />
              </Field>
              <Field label="Tokens per day" hint="Empty means no daily limit.">
                <Input
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  inputMode="numeric"
                  placeholder="no daily limit"
                  disabled={!canChange}
                  aria-label="Tokens per day"
                />
              </Field>
            </div>
            {canChange && (
              <div className="mt-4 flex justify-end gap-2">
                {budget.data.configured && (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
                    Use the defaults
                  </Button>
                )}
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <Confirm
        open={confirmReset}
        title="Use the deployment defaults?"
        body="This workspace's own limits are removed and the deployment defaults apply again."
        confirmLabel="Use the defaults"
        onConfirm={reset}
        onClose={() => setConfirmReset(false)}
      />
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block flex-1">
      <span className="mb-1.5 block text-caption text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-caption text-dim">{hint}</span>}
    </label>
  );
}
