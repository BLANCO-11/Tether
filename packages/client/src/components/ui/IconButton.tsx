// src/components/ui/IconButton.tsx — a square button holding one icon (design doc §4: 28px tiny, 32px default).
// The label is required: an icon alone names nothing to a screen reader, and the same text becomes the tooltip.
import { forwardRef, type ButtonHTMLAttributes } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  /** What the button does — becomes `aria-label` and the tooltip. */
  label: string;
  size?: "sm" | "md";
};

const sizes = { sm: "h-7 w-7", md: "h-8 w-8" } as const;

/** One icon, a hover tint, a visible focus ring. Children are the icon (14–16px). */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { label, size = "md", className = "", title, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 ease-out hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40 ${sizes[size]} ${className}`}
      {...rest}
    />
  );
});
