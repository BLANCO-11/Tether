// src/components/ui/DynamicForm.tsx — renders a FormField[] (from a connector manifest or
// a vault provider spec) as labeled controls. Pairs consecutive half-width fields into a
// 2-column grid. Values are held as strings by the caller and coerced on submit.
"use client";

import { useState } from "react";
import { Field, Input, Select } from "@/components/ui/Field";
import { checkFormField, type FormField } from "@/lib/manifest-form";

/** A file input that reads the picked file into a data-URL string (for format:data-url). */
function FileControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="space-y-1.5">
      <input
        type="file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) { setName(""); onChange(""); return; }
          setName(file.name);
          const reader = new FileReader();
          reader.onload = () => onChange(typeof reader.result === "string" ? reader.result : "");
          reader.readAsDataURL(file);
        }}
        className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-text hover:file:bg-surface"
      />
      {name && value && <span className="block text-xs text-ok">{name} — stored write-only</span>}
    </div>
  );
}

/**
 * One field as a labeled control.
 *
 * ⚠ **The field's own constraints are now SHOWN, not just enforced** (V7). The
 * `min`/`max`/`integer` values have ridden along on `FormField` since it was
 * written and nothing read them, so a wrong value was accepted here and refused
 * by the server one action later, in the server's words, with no indication of
 * which box was wrong. `checkFormField` is the one definition of those rules —
 * the wizard's submit gate calls `checkFields`, which is the same function over
 * the whole set, so the message beside the box and the reason the button is
 * disabled can never disagree.
 *
 * ⚠ **`required` problems are deliberately NOT rendered here.** They fire on an
 * untouched field, so showing them would paint a form red before anyone typed
 * anything — and "you have not filled this in yet" is already said by the empty
 * box and the disabled button. What is worth saying is what is wrong with text
 * somebody actually entered.
 */
function FieldControl({ field, value, onChange }: { field: FormField; value: string; onChange: (v: string) => void }) {
  const problems = checkFormField(field, value).filter((p) => p.rule !== "required");
  return (
    <Field label={field.label} hint={field.hint}>
      {field.type === "select" ? (
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          {field.options!.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : field.type === "boolean" ? (
        <Select value={value || "false"} onChange={(e) => onChange(e.target.value)}>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      ) : field.type === "file" ? (
        <FileControl value={value} onChange={onChange} />
      ) : (
        <Input
          type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
          value={value}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      )}
      {!!problems.length && (
        <p className="mt-1 text-caption text-danger">{problems.map((p) => p.message).join(". ")}</p>
      )}
    </Field>
  );
}

/** Lay out a field list, pairing consecutive `half` fields into a 2-column grid. */
export function DynamicForm({ fields, values, set }: {
  fields: FormField[];
  values: Record<string, string>;
  set: (key: string, value: string) => void;
}) {
  const rows: FormField[][] = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (f.half && last && last.length === 1 && last[0].half) last.push(f);
    else rows.push([f]);
  }
  return (
    <div className="space-y-4">
      {rows.map((row, i) => (
        <div key={i} className={row.length === 2 ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : ""}>
          {row.map((f) => (
            <FieldControl key={f.key} field={f} value={values[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
          ))}
        </div>
      ))}
    </div>
  );
}
