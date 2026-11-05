// src/components/ui/Field.tsx — labeled form controls (input, select, textarea).
// A "Field" is a label + control + optional hint, so forms stay consistent.
import { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const control =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-xs text-text placeholder:text-muted focus:border-accent/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 transition-colors duration-150";
/** Label + hint wrapper placed above any control. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-text">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** Text input. Pass `invalid` to flag an empty/rejected field with a danger border. */
export function Input({ className = "", invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={`${control} ${invalid ? "border-danger focus:border-danger focus-visible:ring-danger/50" : ""} ${className}`} aria-invalid={invalid || undefined} {...props} />;
}

/** Dropdown select. */
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${control} ${className}`} {...props} />;
}

/** Multi-line text area. `mono` defaults true (SQL, prompts); pass false for prose. */
export function Textarea({ className = "", mono = true, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={`${control} ${mono ? "font-mono" : ""} ${className}`} {...props} />;
}
