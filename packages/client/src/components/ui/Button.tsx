// src/components/ui/Button.tsx — button with three looks: primary (solid accent),
// ghost (hairline), and subtle (filled dark, for "Fix now" style).
import { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `danger-quiet`: a destructive action that is not the page's point — red words, no fill until hovered. */
  variant?: "primary" | "ghost" | "subtle" | "danger" | "danger-quiet";
  size?: "xs" | "sm" | "md";
};

const looks: Record<string, string> = {
  primary: "btn-primary",
  ghost: "border border-line text-text hover:bg-surface-2",
  subtle: "bg-surface-2 text-text hover:bg-[color-mix(in_srgb,var(--text)_8%,var(--surface-2))]",
  danger: "bg-danger text-white hover:opacity-90",
  "danger-quiet": "border border-transparent text-danger hover:border-danger-line hover:bg-danger-soft",
};

const sizes: Record<string, string> = {
  xs: "h-7 px-2.5 text-caption whitespace-nowrap",
  sm: "h-8 px-3 text-body",
  md: "h-9 px-4 text-sm",
};

/** A styled button. Pass `variant` and `size`; everything else is native. */
export function Button({ variant = "primary", size = "md", className = "", ...rest }: Props) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 disabled:cursor-not-allowed ${looks[variant]} ${sizes[size]} ${className}`}
      {...rest}
    />
  );
}
