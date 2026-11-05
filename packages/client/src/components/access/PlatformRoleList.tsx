"use client";

// The deployment's roles and who holds each (admin simplify, phase 6). Read-only: a platform role is given or taken
// away on the person's page, the one place it is changed. Holders come from the People view, so a name here is the
// same person as a row there.

import Link from "next/link";
import { useAsync } from "@/lib/hooks";
import { foundryApi } from "@/lib/foundry-client";
import { displayName } from "@/lib/people";
import type { PlatformRole } from "@/lib/types";

export function PlatformRoleList() {
  const roles = useAsync(async () => (await foundryApi.listPlatformRoles()).roles as unknown as PlatformRole[], []);
  const view = useAsync(() => foundryApi.getPeople(), []);
  const failed = roles.error ?? view.error;

  return (
    <section className="pane overflow-hidden" aria-labelledby="platform-roles-head">
      <div className="border-b border-line px-4 py-3">
        <h2 id="platform-roles-head" className="text-body font-semibold">Platform roles</h2>
        <p className="mt-0.5 text-caption text-dim">Held across the whole deployment, not in one workspace. Given on a person's page.</p>
      </div>
      {failed ? (
        <p className="px-4 py-3 text-caption text-warn">The platform roles could not be read. ({failed})</p>
      ) : !roles.data || !view.data ? (
        <p className="px-4 py-3 text-caption text-muted">Reading…</p>
      ) : (
        <ul>
          {roles.data.map((r) => {
            const holders = view.data!.people.filter((p) => p.platformRoles.includes(r.key));
            return (
              <li key={r.key} className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-text">{r.name}</span>
                  {r.description && <span className="block text-caption text-muted">{r.description}</span>}
                </div>
                <div className="text-caption text-muted">
                  {holders.length === 0
                    ? "Nobody"
                    : holders.map((p, i) => (
                        <span key={p.subject}>
                          {i > 0 && ", "}
                          <Link href={`/admin/people/${encodeURIComponent(p.subject)}`} className="text-text hover:underline">
                            {displayName(p)}
                          </Link>
                        </span>
                      ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
