"use client";

/**
 * What a TEST run of this datasource reads.
 *
 * ── Why this panel exists at all ─────────────────────────────────────────────
 *
 * Until Stage 4 a draft run read the tenant's real database, and gate 1 requires
 * a successful run before a flow may be armed — so a flow with an `agent` step
 * sent real rows to an external model before anyone had approved anything. The
 * fix is structural (the Kestra namespace selects the DSN), but the state it
 * produces is per datasource, and a person about to press "Run a test now" has
 * no other place to learn which of the two they are about to do.
 *
 * ⚠ **Both answers are rendered, and the absence of a sandbox is the LOUD one.**
 * The temptation is to show a green tick when a sandbox exists and nothing
 * otherwise — which reads as "fine" for every datasource that has never been
 * given one, i.e. all of them on day one. The exposure sentence is the server's
 * own wording, rendered verbatim, and it names the command that fixes it.
 */

import { useAsync } from "@/lib/hooks";
import { getDatasourceSandbox } from "@/lib/api";
import { Alert } from "@/components/ui/icons";

/**
 * How long this build has been running, in words — or null when the row carries
 * no start time (a datasource provisioned before that column existed).
 *
 * ⚠ **Shown instead of "around two minutes", never beside it.** Three
 * datasources on this deployment read "building…" for SEVEN DAYS against that
 * promise, because a build is a detached promise in the API process and a
 * restart orphans the row (`reconcileAbandonedBuilds` is the fix; this is the
 * half that makes a slow build legible while it is genuinely running). An
 * estimate that cannot be wrong about the elapsed time is worth more than one
 * that is right about the typical case, because the typical case is not what
 * anybody is staring at.
 */
function elapsedWords(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return null;
  const mins = Math.floor((Date.now() - started) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function SandboxPanel({ datasourceId }: { datasourceId: string }) {
  const { data, loading, error } = useAsync(() => getDatasourceSandbox(datasourceId), [datasourceId]);
  const startedAgo = elapsedWords(data?.buildStartedAt);

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      {/* The frozen mock's pane-head (D-02): title + Read-only badge. The mock's
          SQL editor/run is illustrative of the query surface; the real panel
          below reports what a TEST RUN reads — the one fact that decides whether
          a draft run touches real rows. */}
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold text-text">Sandbox</h2>
        <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">Read-only</span>
        {data && (
          <span
            className={
              "ml-auto rounded-full px-2.5 py-0.5 text-xs " +
              (data.hasSandbox
                ? "border border-line text-muted"
                : "bg-warn-bg text-warn")
            }
          >
            {data.hasSandbox
              ? "sandbox fixtures"
              : data.buildStatus === "building"
                ? "building…"
                : "production data"}
          </span>
        )}
      </header>

      <div className="space-y-3 p-4">
        {loading && <p className="text-xs text-muted">Loading…</p>}

        {/* An unreadable state is an ERROR, never an empty panel: "we could not
            ask" and "there is no sandbox" are different facts, and rendering the
            second for the first is the faFallback mistake in miniature. */}
        {error && (
          <p className="text-xs text-danger">
            Could not read the sandbox state: {error}
          </p>
        )}

        {/*
          ⚠ THREE STATES BELOW `hasSandbox === false`, AND COLLAPSING THEM IS THE
          MISTAKE. "nobody has asked" / "a build is running" / "a build failed,
          here is why" call for three different actions, and the last two are
          the ones a person can act on. Rendering `failed` as the first turns an
          error into an absence — the deleted `faFallback` shape.

          ⚠ **The exposure sentence is shown in ALL THREE.** It is what says a
          draft run reads production, and that is true while a build is running
          and true after one fails. Suppressing it during a build would be the
          one moment it is most likely to be read and least likely to be there.
        */}
        {data && !data.hasSandbox && data.buildStatus === "building" && (
          <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
            Building a synthetic copy of this schema{startedAgo ? ` — started ${startedAgo}` : " — around two minutes"}.
            The rows are written from the <strong>schema only</strong>; the generator is never shown
            real data. Until it lands, a test run reads production.
          </p>
        )}

        {/*
          ⚠ **ONE BOX, NOT TWO — 2026-09-17.** A failed build used to render its
          own danger-red panel and then the warn panel below it, and both ended
          on the same fact: *a draft run reads production*. Stacked, they read as
          two problems, the red one looked like a crash, and its sentence
          restarted mid-flow in lower case ("could not be built. the build was
          interrupted…") because the server reason was written to follow a bold
          lead-in and then also had to stand alone.

          ⚠ **The exposure is still the LOAD-BEARING half and still renders in
          every state**, which is the property the old arrangement was protecting
          — it is what says a draft run touches real rows, and it is true while a
          build runs and after one fails. What changed is that the failure is now
          a REASON attached to it rather than a second, louder panel about the
          same thing. Severity follows the exposure, which is the same whether a
          build failed or was never asked for, so the box stays `warn`: red for a
          build that did not happen overstates it beside the sentence saying real
          data is in play.
        */}
        {data && !data.hasSandbox && (
          <div className="flex gap-2 rounded-md border border-warn-line bg-warn-bg p-3">
            <Alert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <div className="space-y-1.5 text-xs leading-relaxed text-warn">
              <p>{data.exposure}</p>
              {data.buildStatus === "failed" && (
                <p>
                  <strong>The last build did not finish.</strong>{" "}
                  {data.buildError ?? "No reason was recorded."}
                </p>
              )}
            </div>
          </div>
        )}

        {data?.hasSandbox && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted">
              A run in the <strong>draft</strong> namespace reads generated fixtures in{" "}
              <code className="font-mono">{data.dbName}</code>; a run of the approved revision reads
              the tenant&rsquo;s database. The namespace decides, so nothing about a single run can
              change it.{" "}
              <strong>
                A green run against fixtures does not mean the flow is correct against production.
              </strong>
            </p>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted">fixture</dt>
                <dd className="font-mono">v{data.fixtureVersion}</dd>
              </div>
              <div>
                <dt className="text-muted">written by</dt>
                <dd className="font-mono">{data.generatedBy}</dd>
              </div>
              <div>
                <dt className="text-muted">frozen</dt>
                <dd className="font-mono">{data.frozenAt?.slice(0, 10) ?? "—"}</dd>
              </div>
              <div>
                {/* The first confusing thing about a sandbox: a flow asking for a
                    period outside this window reads zero rows and looks broken. */}
                <dt className="text-muted">dates cover</dt>
                <dd className="font-mono">
                  {data.dateRange ? `${data.dateRange.from} → ${data.dateRange.to}` : "no dates"}
                </dd>
              </div>
            </dl>

            {data.drift && (
              <div className="flex gap-2 rounded-md border border-warn-line bg-warn-bg p-3">
                <Alert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                <p className="text-xs leading-relaxed text-warn">
                  <strong>The source schema has moved.</strong> This fixture was written for a
                  different shape, so a test run is exercising a table layout production no longer
                  has. Regenerate it.
                </p>
              </div>
            )}

            {/*
              ⚠ **`Array.isArray`, not truthiness — 2026-09-17.** This read
              `data.taxonomy &&` and then `.items.map(...)`, and the column
              behind it legitimately holds `{}` (a mock-built fixture runs no
              taxonomy). `{}` is truthy, so the guard passed and `.items.map`
              threw — taking the WHOLE datasource page down, not just this
              panel. The server no longer sends that shape (`taxonomyOf`
              normalises it), and this stays anyway: a panel must not be one
              unexpected server shape away from a blank screen, which is the
              worst of the available failures.
            */}
            {Array.isArray(data.taxonomy?.items) && data.taxonomy.items.length > 0 ? (
              <ul className="space-y-1">
                {data.taxonomy.items.map((i) => (
                  <li key={i.id} className="flex gap-2 text-xs">
                    <span className={i.satisfied ? "text-ok" : "text-danger"}>
                      {i.satisfied ? "✓" : "✗"}
                    </span>
                    <span className="font-mono text-muted">{i.id}</span>
                    {/* The evidence, not the promise. A tick beside a category name
                        says the check ran; the table, column and values say what it
                        found — and only the second can be argued with. */}
                    <span className="flex-1 text-muted">{i.evidence ?? i.title}</span>
                  </li>
                ))}
              </ul>
            ) : (
              /* ⚠ An absent list is NOT a pass, and rendering nothing would let
                 it read as one. Every satisfied category carries evidence for
                 exactly this reason (D-54): a category asked for and never
                 verified looks identical to one that was checked. A mock-built
                 fixture records no report, and this is the sentence that says
                 so rather than leaving a confident gap. */
              <p className="text-xs leading-relaxed text-muted">
                No edge-case checks were recorded for this fixture, so nothing here says whether it
                holds the boundary values a flow needs to be exercised against.
              </p>
            )}
          </div>
        )}

        {/* The mock's sandbox caption (D-02) — true of every query surface in
            this product, not just the sandbox: the server refuses writes and
            multi-statements before anything runs. */}
        <p className="border-t border-line pt-3 text-caption text-dim">
          Writes and multi-statements are refused.
        </p>
      </div>
    </section>
  );
}
