// src/components/automation/TypedInput.tsx — the one typed input control.
//
// Extracted verbatim from `TriggerInputs.tsx` (Step 2 of fire-time-inputs):
// the trigger editor, the run sheet and the test drawer all describe the same
// inputs, so they render the same control. A second implementation would be a
// second answer to "what does this input take".
import { Input } from "@/components/ui/Field";
import type { ComputedInputFn, DeclaredInput, FlowInputFormat } from "@/lib/types";
/** The words for each format, so every surface names a box the same way. */
export const FORMAT_WORD: Record<FlowInputFormat, string> = {
  month: "month",
  date: "date",
  datetime: "date and time · UTC",
  number: "number",
  boolean: "true or false",
  text: "text",
};

/**
 * The format a form should render for a declared input: what the server
 * derived wins; otherwise the declared type.
 *
 * The fallback exists only for an input the server has not derived a format
 * for. It never reads the id or the value's shape — that inference is refused
 * (see `flow-input-form`'s tests): `period: "2026-06"` looks date-ish to a
 * regex and is a month, and a date picker there would write `2026-06-01`
 * into a query expecting `YYYY-MM`.
 */
export function formatFor(decl: {
  type?: string | null;
  format?: FlowInputFormat | null;
}): FlowInputFormat {
  if (decl.format) return decl.format;
  switch ((decl.type ?? "").toUpperCase()) {
    case "DATE":
      return "date";
    case "DATETIME":
      return "datetime";
    case "INT":
    case "FLOAT":
      return "number";
    case "BOOLEAN":
      return "boolean";
    default:
      return "text";
  }
}

/**
 * ⚠ **A PICKER MUST NEVER SILENTLY DROP THE VALUE IT WAS GIVEN.**
 *
 * The format is derived server-side (`flowInputFormat`) from the declared type,
 * the flow's own use of the input and the value's shape — but the value in the
 * box is whatever a person last saved, and an `<input type="month">` handed
 * `Q3-2026` renders EMPTY. Pressing Save then writes an empty override and the
 * setting is gone, with the widget looking tidy throughout.
 *
 * So a control is used only when the current value is one the control can hold.
 * Anything else falls back to text and says why — the value is the fact, and the
 * widget is a convenience that must yield to it.
 */
const FITS: Record<string, RegExp> = {
  month: /^\d{4}-(0[1-9]|1[0-2])$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  // `datetime-local` holds `YYYY-MM-DDTHH:mm[:ss]` and cannot hold a zone.
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
  number: /^-?\d+(\.\d+)?$/,
  boolean: /^(true|false)$/i,
};

/** `2026-06-29T10:00:00Z` → `2026-06-29T10:00:00`, which the control can hold. */
function forDatetimeControl(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(v);
  return m ? `${m[1]}T${m[2]}` : v;
}

/**
 * ⚠ Back out as UTC, explicitly, and the field SAYS so. `datetime-local` carries
 * no zone, so something has to decide — and the two live defaults on this
 * deployment are both `Z`. Silently reinterpreting a stored UTC timestamp as
 * whatever zone the browser is in would move the value by hours every time
 * somebody opened the box and pressed Save without touching it.
 */
function fromDatetimeControl(v: string): string {
  if (!v) return "";
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00` : v;
  return `${withSeconds}Z`;
}

/**
 * The control to actually render: what the server derived, unless the value in
 * hand does not fit it.
 *
 * The parameter is widened past `DeclaredInput` on purpose: this never read
 * anything but `format`, and the run sheet and the test drawer hold decls that
 * are not trigger inputs.
 */
export function controlFor(
  input: { format?: FlowInputFormat | null },
  current: string,
): FlowInputFormat {
  const fmt = input.format ?? "text";
  if (fmt === "text") return "text";
  if (current === "") return fmt;
  const probe = fmt === "datetime" ? forDatetimeControl(current) : current;
  return FITS[fmt]!.test(probe) ? fmt : "text";
}

/** What a surface passes for one input. `DeclaredInput` satisfies this. */
export type TypedInputDecl = {
  format?: FlowInputFormat | null;
  source?: DeclaredInput["source"];
  value?: string | null;
};

/**
 * One input's control.
 *
 * ⚠ **The fallback is VISIBLE.** When a stored value does not fit the control
 * the format asked for, this renders text AND says the value is not in the shape
 * the automation expects — rather than quietly showing a text box, which reads
 * as "this input is free text" and is how the wrong shape gets saved again.
 */
export function TypedInput({
  id,
  input,
  value,
  onChange,
  ariaLabel,
}: {
  id: string;
  input: TypedInputDecl;
  value: string;
  onChange: (next: string) => void;
  /**
   * The accessible name for the control. The test drawer passes the input's ID
   * (the name the flow's expressions use and the engine puts in errors), not
   * the human label — a surface with its own labelling reads this instead.
   */
  ariaLabel?: string;
}) {
  const control = controlFor(input, value);
  const coerced = (input.format ?? "text") !== "text" && control === "text" && value !== "";
  const placeholder = input.source === "plan" ? `${input.value} — from the plan` : "no value";

  if (control === "boolean") {
    return (
      <select
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none"
      >
        {/* ⚠ The empty option is not a third value — it is how an override is
            removed, which is what an empty box has always meant here. */}
        <option value="">no value{input.source === "plan" ? ` — ${input.value} from the plan` : ""}</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (control === "datetime") {
    return (
      <Input
        id={id}
        aria-label={ariaLabel}
        type="datetime-local"
        step={1}
        value={value ? forDatetimeControl(value) : ""}
        onChange={(e) => onChange(fromDatetimeControl(e.target.value))}
      />
    );
  }

  if (control !== "text") {
    return (
      <Input
        id={id}
        aria-label={ariaLabel}
        type={control}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <>
      <Input id={id} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {coerced && (
        <p className="text-[11px] leading-relaxed text-warn">
          This is not in the shape the automation expects, so it is shown as text. Clear it to pick a{" "}
          {FORMAT_WORD[input.format as FlowInputFormat]} instead.
        </p>
      )}
    </>
  );
}

/** The words for each firing-time derivation, so every surface names the choice the same way. */
export const COMPUTED_WORD: Record<ComputedInputFn, string> = {
  priorMonth: "month just ended",
  currentMonth: "this month",
  priorDate: "yesterday",
  currentDate: "today",
  currentYear: "this year",
  runTimestamp: "the moment the run starts",
};
