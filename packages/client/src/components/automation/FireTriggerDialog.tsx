"use client";
// src/components/automation/FireTriggerDialog.tsx — the run sheet: per-fire
// values for one manual fire.
//
// ⚠ **These values are for THIS fire, and go nowhere else.** The trigger editor
// (`TriggerInputsEditor`) writes standing values onto the trigger; this writes
// nothing — the values travel in the fire request's `inputs` and the trigger's
// stored config is untouched. That is the whole reason the live page's
// set-then-fire is gone: a one-off run must not rewrite shared state.
import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { FORMAT_WORD, TypedInput } from "@/components/automation/TypedInput";
import { fireTriggerWithInputs } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { Trigger } from "@/lib/types";

export function FireTriggerDialog({
  trigger,
  initial,
  open,
  onClose,
  onFired,
}: {
  trigger: Trigger;
  /** Values the opener already holds (the live page's form) — blank otherwise. */
  initial?: Record<string, string>;
  open: boolean;
  onClose: () => void;
  onFired: (fired: { fireId: string; started: boolean }) => void;
}) {
  const declared = trigger.declaredInputs ?? [];
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...(initial ?? {}) }));
  const [firing, setFiring] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // A blank box whose source is `plan` is correct — the engine resolves it —
  // so Run waits only on a required input NOBODY supplies.
  const blocked = declared.some(
    (i) => i.required && (values[i.id] ?? "") === "" && i.source === "none",
  );

  const run = async () => {
    setFiring(true);
    setRefusal(null);
    try {
      const fired = await fireTriggerWithInputs(
        trigger.id,
        Object.fromEntries(declared.map((i) => [i.id, values[i.id] ?? ""])),
      );
      if (fired.started) {
        toast.success(`"${trigger.name}" — run started.`);
        onClose();
        onFired(fired);
      } else {
        // A 202 that started nothing (the approval gate, almost always): the
        // values are not the problem, so the dialog stays open on the answer.
        setRefusal(fired.error ?? "The run did not start.");
      }
    } catch (e) {
      // A thrown refusal (422 validation, 404/409): keep the context, show it.
      setRefusal(e instanceof Error ? e.message : "Could not fire the trigger.");
    } finally {
      setFiring(false);
    }
  };

  if (!open) return null;
  return (
    <Modal open onClose={onClose} title={`Run "${trigger.name}"`}>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          Values for this run only — nothing here is saved onto the trigger.
        </p>
        {declared.map((i) => (
          <div key={i.id} className="space-y-1">
            <Field
              label={`${i.id} · ${FORMAT_WORD[i.format ?? "text"]}${i.required ? " · required" : ""}`}
            >
              <TypedInput
                id={`fire-${trigger.id}-${i.id}`}
                input={i}
                value={values[i.id] ?? ""}
                onChange={(next) => setValues((v) => ({ ...v, [i.id]: next }))}
              />
            </Field>
          </div>
        ))}
        {refusal && (
          <Notice tone="danger" title="That did not go through">
            {refusal}
          </Notice>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={firing || blocked}>
            {firing ? "Starting…" : "Run"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
