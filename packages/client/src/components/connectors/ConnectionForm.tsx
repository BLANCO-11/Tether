"use client";

// The form that creates or rotates a connection, generated from the connector's own auth declaration.
//
// ⚠ A value is TYPED here and sent once; it is never shown back. On a rotation every field starts EMPTY and a blank
// field keeps the stored value (the server merges), so changing one key never requires re-entering — or displaying —
// the others. Anything that may be a secret is masked (`fieldInput`), including fields the piece typed as plain text.
import { useMemo, useState } from "react";
import type { ConnectorAuth, ConnectorConnection } from "@/lib/types";
import { fieldHint, fieldInput, setupInstructions } from "@/lib/connector-ui";
import { Markdown } from "@/components/pi-builder/Markdown";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";

type Values = Record<string, string>;

export function ConnectionForm({
  auths,
  existing,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  /** The connectable auth kinds (OAuth already filtered out). */
  auths: ConnectorAuth[];
  /** Set when rotating: the connection whose credential is being changed. */
  existing?: ConnectorConnection;
  busy: boolean;
  error: string | null;
  onSubmit: (input: { label: string; authType: string; fields: Values }) => void;
  onCancel: () => void;
}) {
  const [authType, setAuthType] = useState(existing?.authType ?? auths[0]?.type ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [values, setValues] = useState<Values>({});
  const decl = useMemo(() => auths.find((a) => a.type === authType) ?? auths[0], [auths, authType]);
  const fields = decl?.fields ?? [];
  const rotating = !!existing;
  const missing = rotating
    ? []
    : fields.filter((f) => f.required && f.defaultValue === undefined && !values[f.name]?.trim()).map((f) => f.label ?? f.name);

  if (!decl) return <Notice tone="warn" title="Nothing to fill in">This connector offers no connection a form can create.</Notice>;

  return (
    <form
      className="flex flex-col gap-4"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim() || missing.length) return;
        // A blank field is not sent: on a rotation that keeps the stored value, on a create the default applies.
        const sent: Values = {};
        for (const [k, v] of Object.entries(values)) if (v !== "") sent[k] = v;
        onSubmit({ label: label.trim(), authType: decl.type, fields: sent });
      }}
    >
      <Field label="Name" hint="How this connection is called here, e.g. production or the team mailbox.">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required aria-label="Connection name" />
      </Field>

      {!rotating && auths.length > 1 && (
        <Field label="How it signs in">
          <Select value={authType} onChange={(e) => { setAuthType(e.target.value); setValues({}); }} aria-label="How it signs in">
            {auths.map((a) => (
              <option key={a.type} value={a.type}>
                {a.displayName ?? a.type}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {setupInstructions(decl.description) && (
        <div className="text-xs text-muted">
          <Markdown text={setupInstructions(decl.description)} links />
        </div>
      )}

      {rotating && (
        <p className="text-xs text-muted">
          Stored values are never shown. Fill in only what changes; a field left blank keeps its current value.
        </p>
      )}

      {fields.map((f) => {
        const kind = fieldInput(f);
        const label = `${f.label ?? f.name}${f.required ? "" : " (optional)"}`;
        return (
          <Field key={f.name} label={label} hint={fieldHint(f.description, decl.description)}>
            {kind === "select" ? (
              <Select
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                aria-label={f.label ?? f.name}
              >
                <option value="">{rotating ? "Keep the current choice" : f.defaultValue !== undefined ? `Default (${String(f.defaultValue)})` : "Choose…"}</option>
                {f.options!.map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={kind}
                autoComplete={kind === "password" ? "new-password" : "off"}
                spellCheck={false}
                value={values[f.name] ?? ""}
                placeholder={rotating ? "Leave blank to keep the current value" : f.defaultValue !== undefined ? String(f.defaultValue) : undefined}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                aria-label={f.label ?? f.name}
              />
            )}
          </Field>
        );
      })}

      {error && (
        <Notice tone="danger" title={rotating ? "Not changed" : "Not connected"}>
          {error}
        </Notice>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !label.trim() || missing.length > 0} title={missing.length ? `Still needed: ${missing.join(", ")}` : undefined}>
          {busy ? "Saving…" : rotating ? "Save" : "Connect"}
        </Button>
      </div>
    </form>
  );
}
