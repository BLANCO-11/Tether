// src/components/onboarding/SafeDataStudio.tsx — S-51 Mock / masked data studio.
// Pack truth: `18-onboarding-safe-data.png` + `S-51.md` + `flows/08-datasource-onboarding.md § Step 6`.
// Header handled by page (eyebrow POSTGRESQL, title Create safe data, subtitle Connect, test, map and create safe data before asking for review.)
// Content: one card holding a centred empty state (mark, two centred sentences, centred Generate 25 mock rows) with Back bottom-left inside card.
// After generating: `25 mock rows generated`, edge cases (six presets each with note), preview (columns follow mapping, values follow declared type, type-correct samples).
// UI-only: fixture rows generated client-side and persisted to localStorage `onboarding:safeData`; no `datasource_fixtures` write — see `backend-required.md` B-24.
// Honest empty: if no mapping exists, preview states columns follow your mapping.
// Behaviour: Back → ?step=mapping, Generate persists and shows generated state, edge cases persisted.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Database } from "@/components/ui/icons";

export const EDGE_CASES = [
  { id: "missing-swipe-out", label: "Missing swipe-out", note: "An employee badged in but never out" },
  { id: "duplicate-records", label: "Duplicate records", note: "The same swipe appears twice" },
  { id: "leave-overlap", label: "Leave overlap", note: "Approved leave covering a day with swipes" },
  { id: "malformed-file", label: "Malformed file", note: "A row the parser cannot read" },
  { id: "overnight-shift", label: "Overnight shift", note: "A swipe-out on the following day" },
  { id: "partial-month", label: "Partial month", note: "An employee who joined mid-month" },
] as const;

export type EdgeCaseId = (typeof EDGE_CASES)[number]["id"];

const STORAGE_KEY = "onboarding:safeData";
const MAPPING_KEY = "onboarding:mapping";

type SafeDataPersisted = {
  generated: boolean;
  rowCount: number;
  edgeCases: EdgeCaseId[];
  createdAt: string;
};

type MappingRow = {
  sourceField: string;
  type: string;
  target: string | null;
  include?: boolean;
};

type PreviewColumn = {
  key: string;
  type: string;
};

function readPersisted(): SafeDataPersisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.generated !== true) return null;
    const edgeCases = Array.isArray(obj.edgeCases) ? (obj.edgeCases as EdgeCaseId[]) : [];
    const rowCount = typeof obj.rowCount === "number" ? obj.rowCount : 25;
    const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString();
    return { generated: true, rowCount, edgeCases, createdAt };
  } catch {
    return null;
  }
}

function readMappingColumns(): PreviewColumn[] {
  try {
    const raw = localStorage.getItem(MAPPING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    // Support both array form and { fields: [...] } or { rows: [...] }
    let rows: unknown[] = [];
    if (Array.isArray(parsed)) rows = parsed;
    else if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.fields)) rows = obj.fields as unknown[];
      else if (Array.isArray(obj.rows)) rows = obj.rows as unknown[];
      else if (Array.isArray(obj.mappings)) rows = obj.mappings as unknown[];
    }
    const cols: PreviewColumn[] = [];
    for (const r of rows) {
      if (typeof r !== "object" || r === null) continue;
      const rec = r as Record<string, unknown>;
      const include = rec.include !== false;
      const target = typeof rec.target === "string" ? rec.target : rec.target === null ? null : typeof rec.mapsTo === "string" ? (rec.mapsTo as string) : null;
      const sourceField = typeof rec.sourceField === "string" ? rec.sourceField : typeof rec.source === "string" ? (rec.source as string) : null;
      const type = typeof rec.type === "string" ? rec.type : "text";
      if (!include) continue;
      if (target === null || target === "" || target === "Do not map") continue;
      const key = target || sourceField || "";
      if (!key) continue;
      // Avoid duplicates
      if (cols.some((c) => c.key === key)) continue;
      cols.push({ key, type });
    }
    return cols;
  } catch {
    return [];
  }
}

export function sampleForType(type: string, rowIndex: number): string {
  const t = type.toLowerCase();
  if (t === "text" || t === "string") return rowIndex % 2 === 0 ? "MOCK-A" : "MOCK-B";
  if (t === "date") return rowIndex % 2 === 0 ? "2026-07-14" : "2026-07-21";
  if (t === "timestamp" || t === "timestamptz" || t === "datetime") {
    return rowIndex % 2 === 0 ? "2026-07-14T09:02:00+05:30" : "2026-07-14T18:41:00+05:30";
  }
  if (t === "number" || t === "numeric" || t === "integer" || t === "float" || t === "int") {
    return rowIndex % 2 === 0 ? "1.0" : "0.5";
  }
  if (t === "boolean" || t === "bool") return rowIndex % 2 === 0 ? "true" : "false";
  if (t === "object" || t === "json" || t === "jsonb") return "{}";
  if (t === "binary" || t === "bytea" || t === "file") return rowIndex % 2 === 0 ? "<1 file>" : "<0 files>";
  return rowIndex % 2 === 0 ? "MOCK-A" : "MOCK-B";
}

export function generateMockRows(columns: PreviewColumn[], count: number): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, string> = {};
    for (const col of columns) {
      row[col.key] = sampleForType(col.type, i);
    }
    rows.push(row);
  }
  return rows;
}

export function SafeDataStudio({
  onBack,
  onContinue,
  mappingOverride,
  type,
}: {
  onBack: () => void;
  onContinue?: () => void;
  mappingOverride?: PreviewColumn[] | null;
  type?: string;
}) {
  const [generated, setGenerated] = useState<boolean>(false);
  const [rowCount] = useState<number>(25);
  const [edgeCases, setEdgeCases] = useState<EdgeCaseId[]>([]);
  const [columns, setColumns] = useState<PreviewColumn[]>(() => {
    if (mappingOverride !== undefined && mappingOverride !== null) return mappingOverride;
    return [];
  });

  // Hydrate from storage on mount
  useEffect(() => {
    const persisted = readPersisted();
    if (persisted) {
      setGenerated(true);
      setEdgeCases(persisted.edgeCases);
    }
    if (mappingOverride !== undefined) {
      setColumns(mappingOverride ?? []);
    } else {
      const cols = readMappingColumns();
      setColumns(cols);
    }
  }, [mappingOverride]);

  const persist = useCallback(
    (next: Partial<SafeDataPersisted> & { generated: boolean }) => {
      try {
        const current = readPersisted();
        const merged: SafeDataPersisted = {
          generated: next.generated,
          rowCount: next.rowCount ?? current?.rowCount ?? 25,
          edgeCases: (next.edgeCases as EdgeCaseId[]) ?? current?.edgeCases ?? [],
          createdAt: next.createdAt ?? current?.createdAt ?? new Date().toISOString(),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // ignore
      }
    },
    [],
  );

  const handleGenerate = useCallback(() => {
    setGenerated(true);
    persist({ generated: true, rowCount: 25, edgeCases, createdAt: new Date().toISOString() });
  }, [edgeCases, persist]);

  const toggleEdgeCase = useCallback(
    (id: EdgeCaseId) => {
      setEdgeCases((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        persist({ generated: true, edgeCases: next });
        return next;
      });
    },
    [persist],
  );

  // Derive preview rows when generated
  const previewColumns = columns;
  const previewRows = generated ? generateMockRows(previewColumns, 3) : [];

  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      {!generated ? (
        <>
          <div className="flex flex-col items-center gap-3 px-6 py-20 text-center sm:py-24">
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-bg text-dim">
              <Database s={18} />
            </span>
            <p className="text-sm text-text">This resource needs mock data before it can be published.</p>
            <p className="text-sm text-muted">The AI never sees your real data.</p>
            <div className="pt-2">
              <Button onClick={handleGenerate}>Generate 25 mock rows</Button>
            </div>
          </div>
          <div className="flex pt-2">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-6">
          <p className="text-sm font-medium text-text">25 mock rows generated</p>

          <div>
            <h3 className="text-sm font-semibold text-text">Edge cases to include</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {EDGE_CASES.map((ec) => {
                const checked = edgeCases.includes(ec.id);
                return (
                  <label
                    key={ec.id}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-left transition-colors ${checked ? "border-accent bg-accent/10" : "border-line bg-bg hover:bg-surface-2"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEdgeCase(ec.id)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                      aria-label={ec.label}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text">{ec.label}</span>
                      <span className="block text-xs text-muted">{ec.note}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-text">Preview</h3>
            {previewColumns.length === 0 ? (
              <p className="mt-2 text-sm text-muted">
                Columns follow your mapping — complete the mapping step to see a preview. Values follow each field&apos;s declared type.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="bg-bg text-xs uppercase tracking-label text-muted">
                    <tr>
                      {previewColumns.map((col) => (
                        <th key={col.key} className="px-3 py-2 font-medium">
                          {col.key}
                          <span className="ml-2 font-normal normal-case text-dim">· {col.type}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {previewRows.map((row, idx) => (
                      <tr key={idx} className="bg-surface">
                        {previewColumns.map((col) => (
                          <td key={col.key} className="px-3 py-2 font-mono text-xs text-text">
                            {row[col.key]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-line bg-bg px-3 py-2 text-xs text-muted">
                  Showing 3 of {rowCount} mock rows · columns from your mapping, values from declared types
                </p>
              </div>
            )}
            <p className="mt-2 text-xs text-muted">
              Type-correct samples matter — a timestamp column showing <span className="font-mono">sample-1</span> does not exercise the parser the mock data exists to exercise.
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-line pt-4">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            {onContinue && (
              <Button onClick={onContinue}>Continue to review</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
