// src/lib/break-glass.ts — S-58 validation (pack record removed 2026-09-11; the five messages below are the surviving specification)
//
// Five rules, five messages, verbatim. This is NOT generic form validation —
// these messages are specification, and a rewording is a defect. See
// flows/11-incidents-and-break-glass.md and reference/screens/S-58.md.
//
// ⚠ One deliberate rewording (admin simplify, phase 6, 2026-10-30): "emergency access" became "break-glass access" in
// three messages. "Emergency access" is now the name of something else — a super admin entering a restricted workspace
// (workspace Settings) — and two features under one name is what the plan set out to end.

export const BREAK_GLASS_COPY = {
  title: "Activate break-glass access",
  purpose: "Break-glass access must attach to an incident, expire automatically and leave a complete decision trail.",
  noticeTitle: "This exposes real data",
  noticeBody: "Every view, query and export in the session is recorded and reviewed after the incident.",
  checkbox: "I understand every action is audited and a post-incident review is required.",
  button: "Activate break-glass",
  justificationHint: "Explain why break-glass access is needed. This is read in the post-incident review.",
} as const;

export const BREAK_GLASS_MESSAGES = {
  incident: "Break-glass access must attach to an incident.",
  scope: "Choose the narrowest scope that resolves the incident.",
  durationSev1: "Four hours is available for SEV1 incidents only.",
  justification: "Explain why break-glass access is needed. This is read in the post-incident review.",
  acknowledgement: "Confirm you understand the session is audited.",
} as const;

export const INCIDENT_OPTIONS = [
  { value: "", label: "Select an incident" },
  { value: "INC-2026-08-0004", label: "INC-2026-08-0004 · Unusual HRIS access", severity: "SEV2" as const },
  { value: "INC-2026-08-0009", label: "INC-2026-08-0009 · Payroll extract anomaly", severity: "SEV1" as const },
  { value: "__create__", label: "Create a new incident" },
] as const;

export const SCOPE_OPTIONS = [
  { value: "", label: "Select a scope" },
  { value: "hris-unmasked", label: "Read HRIS employee master, unmasked" },
  { value: "payroll-restricted", label: "Read Payroll extract, restricted fields" },
] as const;

export const DURATION_OPTIONS = [
  { value: "1 hour", label: "1 hour" },
  { value: "2 hours", label: "2 hours" },
  { value: "4 hours · SEV1 only", label: "4 hours · SEV1 only" },
] as const;

export const DEFAULT_DURATION = "2 hours" as const;

export type BreakGlassInput = {
  incident: string;
  scope: string;
  duration: string;
  justification: string;
  acknowledged: boolean;
};

export type BreakGlassErrors = Partial<Record<keyof BreakGlassInput, string>>;

/** Validate S-58 fields per 08-validation. Returns map of field → message; empty means valid. */
export function validateBreakGlass(input: BreakGlassInput): BreakGlassErrors {
  const errors: BreakGlassErrors = {};

  const incidentTrimmed = input.incident.trim();
  if (!incidentTrimmed || incidentTrimmed === "") {
    errors.incident = BREAK_GLASS_MESSAGES.incident;
  }

  if (!input.scope.trim()) {
    errors.scope = BREAK_GLASS_MESSAGES.scope;
  }

  if (input.duration === "4 hours · SEV1 only") {
    const found = INCIDENT_OPTIONS.find((o) => (o as { value: string }).value === input.incident);
    const sev = found && "severity" in found ? (found as { severity?: string }).severity ?? null : null;
    if (sev !== "SEV1") {
      if (incidentTrimmed && incidentTrimmed !== "__create__") {
        errors.duration = BREAK_GLASS_MESSAGES.durationSev1;
      } else if (incidentTrimmed === "__create__") {
        errors.duration = BREAK_GLASS_MESSAGES.durationSev1;
      } else if (!incidentTrimmed) {
        errors.duration = BREAK_GLASS_MESSAGES.durationSev1;
      }
    }
  }

  const j = input.justification.trim();
  if (!j || j.length < 20) {
    errors.justification = BREAK_GLASS_MESSAGES.justification;
  }

  if (!input.acknowledged) {
    errors.acknowledged = BREAK_GLASS_MESSAGES.acknowledgement;
  }

  return errors;
}
