// src/app/(app)/resources/new/page.tsx — S-49/S-50/S-51 Resource onboarding wizard.
// Pack truth: `16-onboarding-type.png` + `S-49.md` + `flows/08-datasource-onboarding.md § Step 1`
// and `17-onboarding-mapping.png` + `S-50.md` + `flows/08 § Step 5` (Review mapping)
// and `18-onboarding-safe-data.png` + `S-51.md` + `flows/08 § Step 6` (safe-data studio).
// Header: S-49 title `Onboard a datasource` (no eyebrow); S-50 eyebrow `POSTGRESQL` · title `Review mapping` · same subtitle `Connect, test, map and create safe data before asking for review.`; S-51 eyebrow `POSTGRESQL` · title `Create safe data`.
// Controls: step strip — all seven pills, current filled accent, completed ticks (S-50), rest outlined dim, step 6 trailing `*`, wrapping to two rows on S-51 (flex-wrap).
// Content: S-49 card "Choose a resource type" 3×2 tiles derived from FIELD_TABLE; S-50 mapping table (S-50 § Table) with CONFIDENCE_THRESHOLD=90 and 5 inferred rows per type; S-51 SafeDataStudio (centred empty state → 25 mock rows generated + edge cases + type-correct preview). Back steps backwards through wizard.
// UI-only: B-23 (no server type catalogue — tiles derived client-side), B-24 (no fixture write — mock rows are local until datasource_fixtures route exists), B-26 (no inferred schema read — mapping is derived client-side from flows/08 § Step 4).
"use client";

import { Suspense } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { WizardSteps } from "@/components/wizard/WizardSteps";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Database, Box, Mail, Link as LinkIcon, Upload, Table } from "@/components/ui/icons";
import { FieldMappingTable, type MappingRow } from "@/components/onboarding/FieldMappingTable";
import { SafeDataStudio } from "@/components/onboarding/SafeDataStudio";
import {
  CONFIDENCE_THRESHOLD,
  FIELD_TABLE,
  INFERRED_FIELDS,
  STEPS,
  STEP_KEYS,
  TILES,
  TYPE_META,
} from "./pack";
import type { ResourceTypeId, StepKey } from "./pack";

function tileMark(id: ResourceTypeId): React.ReactNode {
  if (id === "postgres") return <Database s={14} />;
  if (id === "s3") return <Box s={14} />;
  if (id === "sftp") return <Upload s={14} />;
  if (id === "rest") return <LinkIcon s={14} />;
  if (id === "email") return <Mail s={14} />;
  return <Table s={14} />;
}

function parseStoredMapping(type: ResourceTypeId): MappingRow[] | null {
  try {
    const raw = localStorage.getItem("onboarding:mapping");
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rows = parsed as MappingRow[];
    if (rows.length === 0) return null;
    const expectedSources = INFERRED_FIELDS[type].map((f) => f.source).join(",");
    const storedSources = rows.map((r) => r.source).join(",");
    if (storedSources !== expectedSources) return null;
    return rows;
  } catch {
    return null;
  }
}

function OnboardingTypePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const stepParam = searchParams.get("step") as StepKey | null;
  const currentIndex = (() => {
    const idx = STEP_KEYS.indexOf(stepParam ?? "type");
    return idx >= 0 ? idx : 0;
  })();

  const initialFromQuery = (() => {
    const q = searchParams.get("type") as ResourceTypeId | null;
    if (q && q in FIELD_TABLE) return q;
    return null;
  })();

  const [selected, setSelected] = useState<ResourceTypeId | null>(initialFromQuery ?? "postgres");

  useEffect(() => {
    if (initialFromQuery && initialFromQuery !== selected) setSelected(initialFromQuery);
  }, [initialFromQuery, selected]);

  const selectedLabel = (() => {
    const meta = TYPE_META.find((m) => m.id === selected);
    return meta ? meta.label : "PostgreSQL";
  })();

  const handleSelect = useCallback(
    (id: ResourceTypeId) => {
      if (id !== selected) {
        try {
          localStorage.removeItem("onboarding:answers");
          localStorage.removeItem("onboarding:schema");
          localStorage.removeItem("onboarding:mapping");
          localStorage.removeItem("onboarding:safeData");
        } catch {
          // Storage may be unavailable in test env.
        }
      }
      setSelected(id);
    },
    [selected],
  );

  const handleContinue = useCallback(() => {
    if (!selected) return;
    try {
      localStorage.setItem("onboarding:type", selected);
    } catch {
      // ignore
    }
    // Datasource types have a real working connect flow at /data-sources/new
    // (DynamicForm + onboarding_schema + runTest + introspection). The wizard's
    // connect/test/schema steps are hollow placeholders — delegate there so
    // clicking Onboard never lands on a dead screen. Connectors keep the wizard
    // path for mapping/safe-data.
    const isDatasource = selected === "postgres" || selected === "s3" || selected === "sftp";
    if (isDatasource) {
      router.push(`/data-sources/new?type=${selected}`);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", "connect");
    params.set("type", selected);
    const qs = params.toString();
    router.push(`/resources/new?${qs}`);
  }, [router, searchParams, selected]);

  const isTypeStep = currentIndex === 0;
  const isMappingStep = currentIndex === 4;
  const isSafeDataStep = currentIndex === 5;

  const mappingType: ResourceTypeId = (initialFromQuery ?? selected ?? "postgres") as ResourceTypeId;
  const [mappingRows, setMappingRows] = useState<MappingRow[]>(() => {
    try {
      const stored = parseStoredMapping(mappingType);
      if (stored) return stored;
    } catch {
      // ignore
    }
    return INFERRED_FIELDS[mappingType].map((f) => ({
      source: f.source,
      type: f.type,
      target: f.target,
      confidence: f.confidence,
      include: f.target !== null,
    }));
  });

  useEffect(() => {
    if (!isMappingStep) return;
    try {
      const stored = parseStoredMapping(mappingType);
      if (stored) {
        setMappingRows(stored);
        return;
      }
    } catch {
      // ignore
    }
    const seeded: MappingRow[] = INFERRED_FIELDS[mappingType].map((f) => ({
      source: f.source,
      type: f.type,
      target: f.target,
      confidence: f.confidence,
      include: f.target !== null,
    }));
    setMappingRows(seeded);
  }, [mappingType, isMappingStep]);

  const handleTargetChange = useCallback((idx: number, target: string | null) => {
    setMappingRows((prev) => {
      const next = [...prev];
      const row = next[idx];
      if (!row) return prev;
      next[idx] = { ...row, target, include: target === null ? false : row.include };
      return next;
    });
  }, []);

  const handleIncludeChange = useCallback((idx: number, include: boolean) => {
    setMappingRows((prev) => {
      const next = [...prev];
      const row = next[idx];
      if (!row) return prev;
      next[idx] = { ...row, include };
      return next;
    });
  }, []);

  const needsReview = mappingRows.filter(
    (r) => r.confidence === null || (r.confidence !== null && r.confidence < CONFIDENCE_THRESHOLD),
  ).length;

  const handleBackToSchema = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", "schema");
    params.set("type", mappingType);
    router.push(`/resources/new?${params.toString()}`);
  }, [router, searchParams, mappingType]);

  const handleCreateSafeData = useCallback(() => {
    try {
      localStorage.setItem("onboarding:mapping", JSON.stringify(mappingRows));
      localStorage.setItem("onboarding:type", mappingType);
    } catch {
      // ignore
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", "safe-data");
    params.set("type", mappingType);
    router.push(`/resources/new?${params.toString()}`);
  }, [router, searchParams, mappingRows, mappingType]);

  const headerProps = (() => {
    const subtitle = "Connect, test, map and create safe data before asking for review.";
    if (isMappingStep) {
      return { eyebrow: selectedLabel.toUpperCase(), title: "Review mapping", purpose: subtitle };
    }
    if (isSafeDataStep) {
      return { eyebrow: selectedLabel.toUpperCase(), title: "Create safe data", purpose: subtitle };
    }
    return { title: "Onboard a datasource", purpose: subtitle } as const;
  })();

  return (
    <Page measure="page">
      <Zone name="header">
        <PageHeader {...headerProps} />
      </Zone>

      <Zone name="controls">
        <WizardSteps steps={STEPS} current={currentIndex} />
      </Zone>

      {isMappingStep ? (
        <Zone name="notices">
          <Notice tone="warn" title={`${needsReview} mappings need review`}>
            Anything the assistant placed below {CONFIDENCE_THRESHOLD}% confidence is shown for you to confirm rather than applied silently.
          </Notice>
        </Zone>
      ) : null}

      {isTypeStep ? (
        <Zone name="content">
          <div className="rounded-lg border border-line bg-surface p-6">
            <h2 className="text-sm font-semibold text-text">Choose a resource type</h2>
            <p className="mt-1 text-sm text-muted">
              This decides what the next step asks for. A datasource is read from or written to; a connector is a
              system acted on for you.
            </p>

            <div
              role="radiogroup"
              aria-label="Resource type"
              className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            >
              {TILES.map((tile) => {
                const isSelected = selected === tile.id;
                return (
                  <button
                    key={tile.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={`${tile.label}, ${tile.category} · ${tile.settings} settings`}
                    onClick={() => handleSelect(tile.id)}
                    className={`flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      isSelected
                        ? "border-accent bg-accent/10 ring-1 ring-accent"
                        : "border-line bg-bg hover:bg-surface-2"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded text-dim ${isSelected ? "text-accent" : "text-dim"}`}
                    >
                      {tileMark(tile.id)}
                    </span>
                    <span className="text-sm font-medium text-text">{tile.label}</span>
                    <span className="text-xs text-muted">
                      {tile.category} · {tile.settings} settings
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 flex justify-end border-t border-line pt-4">
              <Button onClick={handleContinue} disabled={!selected}>
                Continue
              </Button>
            </div>
          </div>
        </Zone>
      ) : isMappingStep ? (
        <Zone name="content">
          <FieldMappingTable
            rows={mappingRows}
            onTargetChange={handleTargetChange}
            onIncludeChange={handleIncludeChange}
          />
          <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
            <Button variant="ghost" onClick={handleBackToSchema}>
              Back
            </Button>
            <Button onClick={handleCreateSafeData}>Create safe data</Button>
          </div>
        </Zone>
      ) : isSafeDataStep ? (
        <Zone name="content">
          <SafeDataStudio type={mappingType} onBack={() => router.push(`/resources/new?step=mapping&type=${mappingType}`)} />
        </Zone>
      ) : (
        <Zone name="content">
          <div className="rounded-2xl border border-line/60 bg-surface p-6 shadow-sm">
            <p className="text-sm text-muted">
              Step {currentIndex + 1} — {STEPS[currentIndex]} — connects via the real flow.{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => router.push("/data-sources/new")}
              >
                Connect a datasource
              </button>{" "}
              or return to{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => router.push("/resources/new?step=type")}
              >
                Choose type
              </button>
              .
            </p>
          </div>
        </Zone>
      )}
    </Page>
  );
}

// ⚠ `useSearchParams()` makes a statically prerendered page bail out to the client, and Next 15 refuses to BUILD one that does
// so outside a Suspense boundary ("Missing Suspense boundary with useSearchParams"). The boundary is here, around the page, so
// the page's own loading and error states are untouched.
export default function OnboardingTypePage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <OnboardingTypePageContent />
    </Suspense>
  );
}
