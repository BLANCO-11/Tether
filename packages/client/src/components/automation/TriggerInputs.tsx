// src/components/automation/TriggerInputs.tsx — what a trigger will send, and
// **who supplies each value**. ui-upgrade Phase 7.1/7.4, D-107.
//
// ── ⚠ WHY THE SOURCE IS ON SCREEN AND NOT JUST THE VALUE ────────────────────
//
// A value shown without its origin is one nobody can act on. Three different
// things put a value here, and each has a different consequence:
//
//   from this trigger  someone typed it. Changing it changes what fires.
//   from the plan      the automation declares a default; Kestra applies it.
//                      Changing it here creates an OVERRIDE that stops tracking
//                      the plan — which is why the value is not copied in at
//                      drafting time (D-107).
//   nobody             on a required input this is a fire the engine rejects.
//
// ⚠ **Foundry never invents the third one.** An input the plan does not name a
// value for is one nobody knows the value of, and filling it in anyway is the
// measured failure this whole migration exists to fix (`period="2023-10"`,
// 0 of 11 emailed, exit 0) arriving pre-filled in a box that looks reviewed.
// So the empty box is the honest output, and the warning beside it says what
// happens if it stays empty.
//
// ⚠ **One component, two modes, on purpose.** `/triggers` and `/flows/[id]`
// both show this, and two implementations would be two answers to "who supplies
// `period`" on two screens describing one trigger.
"use client";

import { useState } from "react";
import { setTriggerInputs } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { DeclaredInput, Trigger } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { COMPUTED_WORD, FORMAT_WORD, TypedInput, controlFor } from "@/components/automation/TypedInput";

/** The words for each source, in one place so the two modes cannot disagree. */
const SOURCE_WORD: Record<DeclaredInput["source"], string> = {
  trigger: "set here",
  plan: "from the plan",
  computed: "derived from the run's firing time",
  none: "not set",
};


/** Read-only: the list, with each value's origin. */
export function TriggerInputs({ trigger }: { trigger: Trigger }) {
  const declared = trigger.declaredInputs ?? [];
  if (!declared.length) return null;
  return (
    <div className="mt-3 space-y-1">
      <div className="text-[11px] uppercase tracking-label text-dim">
        Sends{trigger.inputsFromRevision != null ? ` — from revision v${trigger.inputsFromRevision}` : ""}
      </div>
      {declared.map((i) => (
        <div key={i.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-mono text-text">{i.id}</span>
          {i.value == null ? (
            <span className={i.required ? "text-warn" : "text-muted"}>no value</span>
          ) : (
            <span className="font-mono text-accent">{i.value}</span>
          )}
          <span className="text-dim">· {SOURCE_WORD[i.source]}{i.source === "computed" && i.computed ? ` — ${COMPUTED_WORD[i.computed]}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Editable: the same list, with a box per input.
 *
 * ⚠ Clearing a box **removes the override** rather than sending an empty value —
 * the input goes back to the plan's own default, which is where it is
 * authoritative. The server does the delete (`updateTriggerSchema.inputs`), so
 * this cannot be got wrong per call site.
 */
export function TriggerInputsEditor({
  trigger,
  onSaved,
}: {
  trigger: Trigger;
  onSaved?: () => void;
}) {
  const declared = trigger.declaredInputs ?? [];
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>(() =>
    // ⚠ Seeded from `source === "trigger"` ONLY. Pre-filling a box with the
    // plan's default would turn simply pressing Save into an override of every
    // input — the copy D-107 refuses, arrived at by accident.
    Object.fromEntries(declared.filter((i) => i.source === "trigger").map((i) => [i.id, i.value ?? ""])),
  );
  const [saving, setSaving] = useState(false);

  if (!declared.length) {
    return (
      <p className="text-xs text-muted">
        This automation declares no inputs, so there is nothing for this trigger to send.
      </p>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      // Every declared input is sent, including the ones left empty — that is
      // what makes clearing a box mean "take the override off" rather than
      // "leave whatever was there".
      await setTriggerInputs(
        trigger.id,
        Object.fromEntries(declared.map((i) => [i.id, values[i.id] ?? ""])),
      );
      toast.success("Trigger inputs saved");
      onSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the inputs.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {declared.map((i) => (
        <div key={i.id} className="space-y-1">
          <label className="flex flex-wrap items-baseline gap-2 text-xs" htmlFor={`in-${trigger.id}-${i.id}`}>
            <span className="font-mono text-text">{i.id}</span>
            <span className="text-dim">{FORMAT_WORD[controlFor(i, values[i.id] ?? "")]}</span>
            {i.required && <span className="text-dim">required</span>}
          </label>
          <TypedInput
            id={`in-${trigger.id}-${i.id}`}
            input={i}
            value={values[i.id] ?? ""}
            onChange={(next) => setValues((v) => ({ ...v, [i.id]: next }))}
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save inputs"}
        </Button>
        <span className="text-xs text-muted">Clearing a box puts the input back on the plan&rsquo;s default.</span>
      </div>
    </div>
  );
}
