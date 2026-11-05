// src/components/wizard/WizardSteps.tsx — S-49/S-50 onboarding step strip.
// Seven pills, current filled accent, rest outlined dim. Step 6 carries trailing `*`.
// All seven show from the start with the current one marked — wizard never hides ahead.
// S-50: completed steps lose their number, gain a tick, and lose the border.
// Used by `resources/new` wizard (flows/08-datasource-onboarding.md § The step strip, S-50 § Layout).
"use client";

type Props = {
  steps: readonly string[];
  current: number;
  className?: string;
};

export function WizardSteps({ steps, current, className = "" }: Props) {
  return (
    <div
      role="navigation"
      aria-label="Onboarding steps"
      className={`flex flex-wrap gap-2 ${className}`}
    >
      {steps.map((label, i) => {
        const isCompleted = i < current;
        const isActive = i === current;
        // S-50: completed pills show tick instead of number.
        const displayLabel = isCompleted ? label.replace(/^\d+\s+/, "✓ ") : label;
        return (
          <span
            key={`${i}-${label}`}
            aria-current={isActive ? "step" : undefined}
            className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive
                ? "border-accent bg-accent text-white"
                : isCompleted
                  ? "border-transparent bg-surface-2 text-text"
                  : "border-line bg-transparent text-muted"
            }`}
          >
            {displayLabel}
          </span>
        );
      })}
    </div>
  );
}
