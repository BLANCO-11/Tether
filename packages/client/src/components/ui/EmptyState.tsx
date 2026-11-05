// src/components/ui/EmptyState.tsx — the closure empty state (design doc §5).
//
// Every empty state = (icon or fact) + one line + one action. The action is the
// page's responsibility (a `<Button>`/`<Link>`), so the empty state itself stays
// dumb; a list that cannot offer an action (search with no matches on History)
// simply omits it. Colour never carries the meaning — the icon and the line do.

import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  action,
}: {
  /** optional 16px glyph above the line (use an icon from `@/components/ui/icons`) */
  icon?: ReactNode;
  /** the one line that says what is missing and/or what happens next */
  title: ReactNode;
  /** optional single action (button or link) */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {icon && (
        <span className="mb-1 flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">
          {icon}
        </span>
      )}
      <p className="text-body text-muted">{title}</p>
      {action}
    </div>
  );
}
