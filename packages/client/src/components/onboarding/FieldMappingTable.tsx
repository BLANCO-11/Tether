// src/components/onboarding/FieldMappingTable.tsx — S-50 mapping table.
// Pack truth: `17-onboarding-mapping.png` + `S-50.md` + `flows/08-datasource-onboarding.md § Step 5`.
// Table columns: SOURCE FIELD (mono) · TYPE (dim) · MAPS TO (select) · CONFIDENCE (percentage) · INCLUDE (checkbox).
// The unmappable row shows `Do not map` in the select, `—` for confidence, and unchecked dimmed include.
"use client";

export type MappingRow = {
  source: string;
  type: string;
  target: string | null;
  confidence: number | null;
  include: boolean;
};

type Props = {
  rows: readonly MappingRow[];
  onTargetChange: (index: number, target: string | null) => void;
  onIncludeChange: (index: number, include: boolean) => void;
  canonicalTargets?: readonly string[];
};

export function FieldMappingTable({ rows, onTargetChange, onIncludeChange, canonicalTargets }: Props) {
  // Build per-type select options from canonical or derived from rows.
  const dedup: Record<string, true> = {};
  for (const r of rows) if (r.target !== null) dedup[r.target] = true;
  const optionsFromRows = Object.keys(dedup);
  const options = canonicalTargets ?? optionsFromRows;


  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th className="px-4 py-3">Source field</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Maps to</th>
            <th className="px-4 py-3">Confidence</th>
            <th className="px-4 py-3">Include</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const isUnmappable = row.target === null;
            return (
              <tr key={row.source} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-mono text-xs text-text">{row.source}</td>
                <td className="px-4 py-3 text-xs text-muted">{row.type}</td>
                <td className="px-4 py-3">
                  <select
                    aria-label={`Maps to for ${row.source}`}
                    value={row.target ?? "Do not map"}
                    onChange={(e) => {
                      const v = e.target.value;
                      onTargetChange(idx, v === "Do not map" ? null : v);
                    }}
                    className="w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-text focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    {row.target !== null && !options.includes(row.target) ? (
                      <option value={row.target}>{row.target}</option>
                    ) : null}
                    {options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                    <option value="Do not map">Do not map</option>
                  </select>
                </td>
                <td className="px-4 py-3 text-sm text-text">
                  {row.confidence === null ? "—" : `${row.confidence}%`}
                </td>
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Include ${row.source}`}
                    checked={row.include}
                    disabled={isUnmappable && !row.include}
                    onChange={(e) => onIncludeChange(idx, e.target.checked)}
                    className={`h-4 w-4 rounded border-line text-accent focus:ring-accent ${isUnmappable && !row.include ? "opacity-40" : ""}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
