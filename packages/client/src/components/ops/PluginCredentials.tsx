// src/components/ops/PluginCredentials.tsx — how a person sets a plugin up, in
// three steps, and the sentence that stops the panel from lying.
//
// ── ⚠ THE FIELDS ARE READ FROM THE ENGINE ───────────────────────────────────
//
// Kestra marks each property of a task with a `$group`, and `"connection"` is
// the one its authors use for the fields that authenticate — Slack's `url`,
// AWS's `accessKeyId`/`secretKeyId`/`region`. The server unions those across the
// plugin's classes. A hand-written map of "what Slack needs" would be correct
// the day it was typed and silently wrong after the next version bump, with no
// test able to notice.
//
// ── ⚠ AND WHY THERE IS STILL NO CREDENTIAL FIELD HERE ───────────────────────
//
// **No automation in this product can call any of these plugins.**
// `flow-compiler.service.ts` is the sole YAML emitter (R8) and emits seven class
// types, none of them from a plugin — every non-core card on `/apps` honestly
// reads "0 of N". A box that accepted a Slack token here would store a
// credential that nothing reads, on a screen whose entire appearance promises
// otherwise. That is the shape `CLAUDE.md` names twice: *inert is worse than
// refused* (the connector catalogue, I-94's trigger kinds). A refusal names its
// reason in front of the person who chose it; an inert control surfaces weeks
// later as an automation that does not work.
//
// ⚠ `ui-honesty-check.sh` asserts this file calls no `createSecret`, and that
// assertion is the control — **do not satisfy a request for a credential box by
// moving the write into a sibling component.** That is widening a guard to
// permit the thing it guards against (I-62), and the guard would still be green.
// The condition for a real box is that a plugin capability becomes emittable;
// `platform-coherence/plan.md` Phase 8 is that work, and `usableToday` is
// the flag that flips this panel when it lands.
//
// ── ⚠ WHAT IT DOES INSTEAD, AND WHY THAT IS NOT A CONSOLATION PRIZE ─────────
//
// It answers the question a person actually has — *how do I set this up?* — as
// three ordered steps, with the blocked one named rather than hidden:
//
//   1. get the credential from the vendor  (the engine's own field list)
//   2. store it as a workspace secret      (REAL, and reachable from here)
//   3. have an admin enable the capability (blocked, and it says why)
//
// Step 2 is genuinely available today: workspace secrets exist, are encrypted
// per workspace, and are referenced by env-var name. So this is not a mock of a
// setup flow — it is two-thirds of a real one with the missing third named. The
// alternative, a page that says only "not supported", hides the fact that the
// credential has a real home and that putting it there now is not wasted work.
"use client";

import { pluginCredentials } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { Notice } from "@/components/ui/Notice";
import { AllowRequest } from "@/components/ops/AllowRequest";
import { secretNameFor, setupSteps } from "@/lib/plugin-setup";
import Link from "next/link";

/** One numbered step. The number is a real ordinal — step 3 needs step 2 done. */
function Step({
  n,
  title,
  because,
  children,
}: {
  n: number;
  title: string;
  because: string | null;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-caption font-medium " +
          (because ? "border-line bg-surface-2 text-dim" : "border-accent-line bg-accent-bg text-accent")
        }
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-body font-medium">{title}</span>
        {/* ⚠ The reason travels with the step, never as a footnote under the
            list. A greyed step with the explanation elsewhere reads as "not
            available yet" — which is the same sentence for "coming soon" and
            for "this cannot work the way you think". */}
        {because && <p className="mt-1 text-xs text-muted">{because}</p>}
        {children}
      </div>
    </li>
  );
}

export function PluginCredentials({
  plugin,
  label,
  group,
  version,
}: {
  plugin: string;
  label: string;
  /** The Java package and version — carried so step 3's request names the exact artefact. */
  group: string | null;
  version: string | null;
}) {
  const { data, loading, error } = useAsync(() => pluginCredentials(plugin), [plugin]);
  const steps = setupSteps(data ?? null, label);

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-body font-semibold text-text">Setting up {label}</h3>

      {/* ⚠ An error is shown, never swallowed into "no credentials needed" —
          those are opposite answers and look identical as an empty panel. */}
      {error && (
        <p className="mt-2 rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger">
          Could not read the engine&rsquo;s schema for this plugin: {error}. That is a failure to
          ask, not an answer that it needs nothing.
        </p>
      )}

      {!error && loading && !data && (
        <p className="mt-2 text-body text-muted">Reading the engine&rsquo;s schema…</p>
      )}

      {!error && data && !data.reachable && (
        <p className="mt-2 rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-danger">
          {data.detail ?? "The engine did not answer."}
        </p>
      )}

      {!error && data?.reachable && (
        <>
          {/* ⚠ FIRST, above the steps. Below them it reads as a footnote to a
              procedure somebody has already started following. */}
          {!data.usableToday && (
            <div className="mt-3">
              <Notice tone="warn" title="You can prepare this, but you cannot finish it here">
                Foundry writes every automation&rsquo;s definition itself and can only emit a fixed
                set of step types — none of them from this plugin. Steps 1 and 2 below are real and
                worth doing; step 3 needs an administrator, and until it happens a stored credential
                sits unused rather than starting to work.
              </Notice>
            </div>
          )}

          <ol className="mt-3 space-y-3">
            <Step n={steps[0]!.n} title={steps[0]!.title} because={steps[0]!.because}>
              {data.fields.length === 0 ? (
                <p className="mt-1 text-xs text-muted">
                  This plugin declares no connection fields — either it needs no credential, or it
                  takes one somewhere the engine does not mark as part of connecting.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted">
                    Read from the engine&rsquo;s own schema. Obtain these from {label}:
                  </p>
                  <ul className="mt-2 space-y-2">
                    {data.fields.map((f) => (
                      <li key={f.name} className="border-l-2 border-line pl-3">
                        <span className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-xs">{f.name}</span>
                          <span className="text-caption text-dim">{f.type}</span>
                          {f.required ? (
                            <span className="text-caption text-warn">required</span>
                          ) : (
                            <span className="text-caption text-dim">optional</span>
                          )}
                          {/* ⚠ How this field was ESTABLISHED, on the field
                              itself. `declared` is the plugin author's own
                              classification; `recognised` is a NAME match, used
                              only where the plugin classifies nothing — AWS is
                              the case, where `accessKeyId` carries no group at
                              all. A guess presented as the author's word is the
                              failure mode, and it is not one a footnote fixes. */}
                          <span
                            className="text-micro text-dim"
                            title={
                              f.source === "declared"
                                ? "The plugin's own author marked this as part of connecting."
                                : "Matched by name. This plugin classifies none of its properties, so this is a good guess rather than the author's word."
                            }
                          >
                            {f.source === "declared" ? "declared" : "recognised by name"}
                          </span>
                        </span>
                        {f.title && <span className="block text-xs text-muted">{f.title}</span>}
                        {f.description && (
                          <span className="block text-xs text-dim">{f.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Step>

            <Step n={steps[1]!.n} title={steps[1]!.title} because={steps[1]!.because}>
              <p className="mt-1 text-xs text-muted">
                Credentials in Foundry are <b className="font-medium">workspace secrets</b> — stored
                by name, encrypted per workspace, injected at execution, and never returned by any
                endpoint. They are added on{" "}
                <Link href="/keys" className="text-accent hover:underline">
                  Keys &amp; passwords
                </Link>
                , which is the one place in the product that holds a value.
              </p>
              {data.fields.length > 0 && (
                <>
                  <p className="mt-2 text-xs text-dim">
                    Names that would read correctly here — a suggestion, not a requirement, since
                    nothing binds a plugin to a secret yet:
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {data.fields.map((f) => (
                      <li
                        key={f.name}
                        className="rounded border border-line bg-surface-2 px-2 py-0.5 font-mono text-caption text-muted"
                      >
                        {secretNameFor(label, f.name)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Step>

            <Step n={steps[2]!.n} title={steps[2]!.title} because={steps[2]!.because}>
              {/* ⚠ The ask lives INSIDE step 3 rather than as a panel of its
                  own. As a sibling it read as an alternative to setting the
                  plugin up; it is the last step of setting it up. */}
              {!data.usableToday && (
                <div className="mt-2">
                  <AllowRequest label={label} group={group} version={version} />
                </div>
              )}
            </Step>
          </ol>

          {/* The server's own sentences, rendered rather than paraphrased —
              including the one that says how much of the plugin was read. A
              bound nobody is told about reads as a complete answer. */}
          <ul className="mt-3 space-y-1 border-t border-line pt-3">
            {data.notes.map((n, i) => (
              <li key={i} className="text-xs text-dim">
                {n}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
