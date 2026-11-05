"use client";

import Link from "next/link";
import { useAsync } from "@/lib/hooks";
import { getMe, listWorkspaces } from "@/lib/api";
import { noAccessCopy } from "@/lib/permission-copy";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";

/**
 * Where a person lands when they hold nothing anywhere.
 *
 * ⚠ **FR-016 / SC-013 — IT NAMES WHO CAN GRANT ACCESS, AND IT IS NEVER AN EMPTY PICKER.**
 * Before this feature, a person with no grant met a workspace switcher with nothing in it
 * and no explanation: a dead end that reads as a broken product. The whole point of this
 * page is that the next step is on it.
 *
 * ⚠ **The advice DIFFERS, because the fix does** (the two-refusals rule again):
 *   - somebody can add you → ask them
 *   - **no super admin is configured** → nobody can grant anything yet, and the fix is an
 *     environment variable on the API server, not a person
 *
 * ⚠ **This page needs NO permission**, and cannot. Needing access in order to discover
 * you have none is a bootstrap nobody can escape. It reads `GET /api/me` and the filtered
 * workspace list, both identity-only.
 *
 * ⚠ **Three states, and the third is "we could not check".** A failed read renders as
 * unreadable, never as "you have no access" — telling somebody they have been refused
 * when the truth is that the check did not run is the failure this repo keeps writing
 * down.
 */
export default function NoAccessPage() {
  const me = useAsync(() => getMe(), []);
  const workspaces = useAsync(() => listWorkspaces(), []);

  if (me.loading || workspaces.loading) {
    return (
      <Page>
        <Zone name="content">
          <p className="text-sm text-muted">Checking your access…</p>
        </Zone>
      </Page>
    );
  }

  // ⚠ The third state. Not "you have no access" — we do not know that.
  if (me.error || workspaces.error) {
    return (
      <Page>
        <PageHeader
            eyebrow="Access"
            title="We could not check your access"
            purpose="The check did not run, so this says nothing about what you can do."
          />
        <Zone name="content">
          <p className="text-sm text-text">
            The check itself did not run, so this is not a statement about what you can do.
            Try again in a moment; if it keeps happening, the API may be unreachable.
          </p>
        </Zone>
      </Page>
    );
  }

  const count = workspaces.data?.length ?? 0;
  const copy = noAccessCopy({
    superAdminConfigured: me.data?.superAdminConfigured ?? false,
    workspaceCount: count,
  });

  return (
    <Page>
      <PageHeader eyebrow="Access" title={copy.title} purpose={copy.body} />
      <Zone name="content">
        {count > 0 ? (
          <ul className="space-y-2" data-testid="no-access-workspaces">
            {workspaces.data!.map((w) => (
              <li key={w.id}>
                <Link className="text-sm text-accent underline" href="/dashboard">
                  {w.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-6 text-xs text-dim">
          Signed in as {me.data?.email ?? "an unknown account"}.
        </p>
      </Zone>
    </Page>
  );
}
