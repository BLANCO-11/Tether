"use client";

import { useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAsync } from "@/lib/hooks";
import { getFlowDetail } from "@/lib/api";
import { PiBuilderWorkbench } from "@/components/pi-builder/PiBuilderWorkbench";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * The builder for one workflow: Forge, the Pi workbench, rebuilt from the workflow's saved draft.
 *
 * ⚠ 2026-10-11 — Kestra is out of the builder. A workflow whose `runtime` is not `foundry` was built by the retired
 * compiled builder; its editor (`BuilderComposer`, the engine canvas) is deleted, so it is SAID rather than opened in
 * a builder that cannot read it. It can still be deleted from the workflows list.
 */
export default function BuilderPage() {
  // The id comes from `useParams()`, not a `params` prop — see `flows/[id]/page.tsx` for why.
  const { id } = useParams<{ id: string }>();
  const load = useCallback(() => getFlowDetail(id), [id]);
  const { data, error, loading } = useAsync(load, [load]);
  if (loading) return <Skeleton className="m-6" />;
  if (error || !data) return <Notice tone="warn" title="This flow could not be opened" className="m-6">{error ?? "It may have been deleted."}</Notice>;
  if (data.flow.runtime !== "foundry") {
    return (
      <Notice
        tone="info"
        title="This workflow was built with the retired builder"
        className="m-6"
        action={<Link href="/flows" className="text-caption text-accent hover:underline">Back to workflows</Link>}
      >
        It cannot be edited here. Build it again in Forge, or delete it from the workflows list.
      </Notice>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PiBuilderWorkbench flowId={id} />
    </div>
  );
}
