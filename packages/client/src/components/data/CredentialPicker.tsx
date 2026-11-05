"use client";

/**
 * Credential reference picker — NAMES only, never values.
 *
 * A datasource's `secret_env_name` is a reference into the workspace secret
 * store, and so is every option here (`listSecrets` returns presence —
 * `hasValue` — never content, and there is deliberately no `?reveal=`).
 * Picking a name links the reference; the VALUE is written once at creation
 * or rotation and never read back — not here, not anywhere in the UI.
 */

import { listSecrets } from "@/lib/api";
import { useAsync } from "@/lib/hooks";

export function CredentialPicker({
  value,
  onPick,
  disabled = false,
}: {
  /** Currently attached credential NAME, or null for none. Never a value. */
  value: string | null;
  onPick: (name: string | null) => void;
  disabled?: boolean;
}) {
  const { data, loading, error, reload } = useAsync(listSecrets, []);

  const names = (data ?? []).map((s) => s.name).sort();

  return (
    <div className="space-y-2">
      <label htmlFor="credential-name" className="block text-xs font-medium text-muted">
        Credential name
      </label>
      {loading && <p className="text-xs text-muted">Reading stored credential names…</p>}
      {error && (
        <p className="text-xs text-warn">
          Stored names could not be read — so this is not “no credential”, the check did not run. (
          {error}){" "}
          <button type="button" onClick={reload} className="text-accent hover:underline">
            Try again
          </button>
        </p>
      )}
      {!loading && !error && (
        <select
          id="credential-name"
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onPick(e.target.value === "" ? null : e.target.value)}
          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-text disabled:opacity-40"
        >
          <option value="">No credential attached</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
      <p className="text-caption text-dim">
        Names only — credential values are write-only and never read back, here or anywhere else.
      </p>
    </div>
  );
}
