// src/app/(app)/flows/[id]/page.tsx — one workflow: what it asks for, what each step does, how its runs went, and
// approving / turning off / running it for real. The page itself is `PiFlowOverview`; this file loads it.
//
// ── 2026-10-11: Kestra is out of the builder ────────────────────────────────────────────────────────────────────
//
// This file was ~1,560 lines: a four-tab page (Overview, Versions, API, Settings) for workflows compiled to Kestra,
// with the Forge overview as an early return. The compiled builder and every door that created such a workflow are
// deleted, so that page is too — and with it a hardcoded branch that showed INVENTED figures ("142 employees
// evaluated") for one workflow id, and a "View all" link to a `?versions=1` nothing read. A workflow whose `runtime`
// is not `foundry` is said, not rendered in a page that cannot read it.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getFlowDetail, getFlowReview, renameFlow } from "@/lib/api";
import { isLive } from "@/lib/flow-stream";
import type { PiWorkflow } from "@/lib/pi-builder";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { PiFlowOverview, PiFlowOverviewSkeleton } from "@/components/pi-builder/PiFlowOverview";

type Detail = NonNullable<Awaited<ReturnType<typeof getFlowDetail>>>;

// ⚠ The id comes from `useParams()`, NOT from a `params` prop and NOT from `use(params)`. `params` is a plain object on
// Next 14, a Promise on 15 and Promise-only on 16; `use(params)` threw React error #438 on Next 14 (it survived two days,
// because nothing in the server suites renders a page) and does not exist at all on the React 18 this repo pins.
// `useParams()` is the form that is valid on all three, returns a plain object, and is what `data-sources/[id]` already did.
// `record-pages.test.tsx` asserts the id reaches the loader.
export default function FlowPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [workflow, setWorkflow] = useState<PiWorkflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await getFlowDetail(id);
      if (!d) {
        setError("This workflow no longer exists.");
        return;
      }
      setDetail(d);
      if (d.flow.runtime === "foundry") {
        try {
          const review = await getFlowReview(id, d.flow.draftRevision);
          setWorkflow(((review.model as { workflow?: PiWorkflow } | null)?.workflow ?? null) as PiWorkflow | null);
        } catch {
          // The overview says "this workflow's steps could not be read" for a null workflow.
          setWorkflow(null);
        }
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read while a run is still going, so its outcome lands without a reload; stops when the last one settles.
  const anyRunLive = !!(detail?.runs ?? []).some((r) => r.engineStatus == null || isLive(r.engineStatus));
  useEffect(() => {
    if (!anyRunLive) return;
    const poll = setInterval(() => void load(), 3000);
    return () => clearInterval(poll);
  }, [anyRunLive, load]);

  if (error && !detail) {
    return (
      <Page>
        <PageHeader eyebrow="Workflows" title="Workflow" />
        <Zone name="notices">
          <Notice tone="danger" title="Could not load this workflow">
            {error}
          </Notice>
        </Zone>
      </Page>
    );
  }
  if (!detail) return <PiFlowOverviewSkeleton />;

  const { flow } = detail;
  if (flow.runtime !== "foundry") {
    return (
      <Page>
        <PageHeader eyebrow="Workflows" title={flow.name} />
        <Zone name="notices">
          <Notice
            tone="info"
            title="This workflow was built with the retired builder"
            action={<Link href="/flows" className="text-caption text-accent hover:underline">Back to workflows</Link>}
          >
            It cannot be opened or edited here any more. Build it again in Forge, or delete it from the workflows list.
          </Notice>
        </Zone>
      </Page>
    );
  }

  return (
    <PiFlowOverview
      flow={flow}
      workflow={workflow}
      runs={detail.runs ?? []}
      access={{ canChange: detail.canChange, canManage: detail.canManage, canChangeOwner: detail.canChangeOwner }}
      selfEnable={detail.selfEnable}
      onRename={async (name) => {
        await renameFlow(flow.id, name);
        await load();
      }}
      onChanged={load}
    />
  );
}
