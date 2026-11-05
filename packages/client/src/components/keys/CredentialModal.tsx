// src/components/keys/CredentialModal.tsx — the D-01 create/edit/rotate modal:
// kind, name (env-var ref), label, write-only value with a reveal toggle, and
// the rename-impact warning.
//
// ⚠ THE VALUE IS WRITE-ONLY AND THE MODAL NEVER READS. There is no current-value
// field, and an edit opens with the value box EMPTY and "leave blank to keep the
// current one" — the only honest thing a write-only field can say. The server
// has no endpoint that returns a value; the Show toggle below only shows what
// the person TYPED, never a stored value (the ui-honesty-check pins the word
// "reveal" absent from this directory for exactly that reason).
//
// ⚠ The ref is sent as `name` (the seam's upsert keys on it). The old secrets
// surface enforced an UPPERCASE env-var regex here; the unified modal cannot —
// a database ref is a datasource name ("hr_postgres"), a webhook ref a trigger
// name — so shape validation is the server's (zod), and its refusal surfaces in
// the form's error line. The seam owns the secret store: kinds database/webhook/
// api refuse here with a clean 409, which is the server saying "managed on the
// owning page", shown verbatim.
"use client";

import { useEffect, useState } from "react";
import { upsertCredential } from "@/lib/api";
import type { CredentialKind, CredentialView } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Field";
import { Alert } from "@/components/ui/icons";

export type CredentialModalMode = "create" | "edit" | "rotate";

const KIND_LABELS: Record<CredentialKind, string> = {
  tool: "Tool",
  database: "Database",
  webhook: "Webhook",
  api: "API",
  llm: "LLM",
  generic: "Generic",
};

const TITLES: Record<CredentialModalMode, string> = {
  create: "Add credential",
  edit: "Edit credential",
  rotate: "Rotate credential",
};

export function CredentialModal({
  open,
  mode,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: CredentialModalMode;
  /** The row being edited/rotated. Null for create. */
  initial: CredentialView | null;
  onClose: () => void;
  /** Called after a successful write with the toast line. The caller reloads. */
  onSaved: (message: string) => void;
}) {
  // Reset the form every time the modal opens. `Modal` renders nothing while
  // closed, but this component stays mounted, so the open flip is the reset.
  const [kind, setKind] = useState<CredentialKind>("tool");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(initial?.kind ?? "tool");
    setName(initial?.ref ?? "");
    setLabel(initial?.label ?? "");
    setValue("");
    setShowValue(false);
    setFormError(null);
  }, [open, initial]);

  const display = label.trim() || name.trim();
  // Rotate always sends a fresh value; create requires one. An edit with a
  // blank value keeps the stored one — the write-only contract.
  const needValue = mode !== "edit";
  const canSave = Boolean(name.trim()) && (!needValue || Boolean(value.trim())) && !busy;

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await upsertCredential({
        kind,
        name: name.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        // Omitting `value` keeps the stored one — the edit path.
        ...(value.trim() ? { value: value.trim() } : {}),
      });
      onSaved(
        mode === "create" ? `${display} stored`
        : mode === "rotate" ? `${display} rotated`
        : `Updated ${display}`,
      );
    } catch (e) {
      // A 409 here is the seam refusing a kind it does not own (database/
      // webhook/api) or a name collision — the server's message is written to
      // be read, so show it as-is rather than guessing.
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={TITLES[mode]}>
      <div className="space-y-3">
        <Field label="Kind" hint={mode === "create" ? undefined : "A credential's kind is its store — it cannot be moved here."}>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as CredentialKind)}
            disabled={mode !== "create"}
            aria-label="Credential kind"
          >
            {(Object.keys(KIND_LABELS) as CredentialKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </Select>
        </Field>

        <Field
          label="Name (env-var ref)"
          hint={mode === "edit" ? "Renaming here breaks flows that reference the old name — see the note below." : "The identifier a run and the manifest reference this credential by."}
        >
          <Input
            className="font-mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="publish_token"
            aria-label="Credential ref (name)"
          />
        </Field>

        <Field label="Label" hint="Optional — shown in the list in place of the ref.">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Publish endpoint token"
            aria-label="Credential label"
          />
        </Field>

        <Field
          label="Value"
          hint={
            mode === "edit" ? "Leave blank to keep the current value."
            : mode === "rotate" ? "Replaces the stored value — the old one cannot be shown again."
            : "Write-only — stored encrypted (AES-256-GCM), never returned."
          }
        >
          <div className="flex items-center gap-2">
            <Input
              className="flex-1 font-mono"
              type={showValue ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={mode === "edit" ? "Unchanged" : "••••••••••••"}
              aria-label="Credential value"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowValue((s) => !s)}
              aria-pressed={showValue}
              className="shrink-0"
            >
              {showValue ? "Hide" : "Show"}
            </Button>
          </div>
        </Field>

        {/* The mock's impact note, verbatim. Shown in every mode — including
            create, where it is a caution about the ref the form is minting. */}
        <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-muted">
          <Alert s={14} className="mt-0.5 shrink-0 text-warn" />
          <span>
            Renaming a ref breaks flows that reference the old name. Existing
            references are listed before you confirm.
          </span>
        </div>

        {formError && <p className="text-sm text-danger">{formError}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!canSave} onClick={save}>
            Save credential
          </Button>
        </div>
      </div>
    </Modal>
  );
}
