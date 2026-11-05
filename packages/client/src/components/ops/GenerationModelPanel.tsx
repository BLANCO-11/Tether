// src/components/ops/GenerationModelPanel.tsx — which model DESIGNS automations.
// `breaking-2026-08-07/plan-provider-and-scope.md` Part A · **F2**
//
// ── ⚠ THE DEFECT THIS PANEL EXISTS FOR WAS HALF A MISSING FEATURE ───────────
//
// Reported: *"I changed to 5.4-mini for better speed and it is still slow."*
// Measured at the wire — the runtime provider row said `gpt-5.4-mini` and
// generation carried on running `google/gemma-4-26B-A4B-it`. The page above
// configures the `llm_complete` **tool**; the generation model was settable
// only by editing `.env`.
//
// ⚠ **The other half is copy, and adding this panel alone would not have fixed
// it.** The page's header said *"the language model behind the llm_complete
// tool"* — accurate about one path, read against the other. That is I-95's
// shape, and a second panel without correcting the first sentence leaves the
// same trap with one more place to fall into it.
//
// ── ⚠ WHY THE ENDPOINT AND KEY ARE READ-ONLY HERE ───────────────────────────
//
// Decided 2026-08-07: the two paths share a GATEWAY, not a CREDENTIAL. The
// parent's generation key stays in its own environment; a parent that fetched
// it from ops-api would invert the boundary Stage 5 exists to draw. D-35 —
// *"runtime and generation inference must not be merged"* — stays structural
// rather than becoming a convention, because there is no shared store to merge.
//
// ⚠ **The cost is paid in copy, and it is the `differs` block below.** The
// runtime endpoint is editable and this one is not, so the two can now diverge
// silently. That sentence is the only thing standing between "one gateway" and
// "two, and nobody noticed".
//
// ⚠ 2026-10-12: the page now reads the generation provider (its summary card needs it) and hands it in, and the
// "different gateways" sentence moved to the page's notices, where it sits above BOTH models rather than inside one.

"use client";

import { useEffect, useState } from "react";
import { foundryApi, type FAGenerationProvider } from "@/lib/foundry-client";
import { useToast } from "@/lib/toast";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Sparkle } from "@/components/ui/icons";

const when = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function GenerationModelPanel({ g, reload }: { g: FAGenerationProvider; reload: () => void }) {
  const toast = useToast();
  const [model, setModel] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [caveat, setCaveat] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; model?: string; ms: number; reply?: string; message?: string } | null>(null);
  const [busy, setBusy] = useState<"" | "models" | "test" | "save" | "clear">("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModel(g.defaultModel);
    setChoices((prev) => [...new Set([...prev, ...g.allowedModels, g.defaultModel])].filter(Boolean).sort());
  }, [g]);

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>) => {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy("");
    }
  };

  const setBy = g.source === "environment" ? "the deployment's environment" : `${g.updatedByName ?? "someone here"} · ${when(g.updatedAt)}`;

  return (
    <div className="pane">
      <section className="border-b border-line px-4 py-4">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-caption tabular-nums text-muted">1</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-body font-medium text-text">Builder model</h3>
            <p className="text-caption text-dim">This model helps turn a request into a workflow. It&rsquo;s separate from the model used when workflows run.</p>
          </div>
        </div>
        <div className="space-y-3 pl-9">
          {!g.baseUrl && (
            <Notice tone="warn" title="No builder gateway is configured">
              Building falls back to the agent runtime, which adds turns after the model answers — so a refusal that names
              what a step is missing arrives as &ldquo;the drafter returned no JSON object&rdquo; and gets retried instead of
              reported.
            </Notice>
          )}
          {/* What it is today. */}
          <div className="flex items-start gap-3 rounded-lg border border-line bg-bg p-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
              <Sparkle s={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-body text-text">{g.defaultModel}</p>
              <p className="mb-2.5 text-caption text-muted">Selected for the workflow builder.</p>
              <dl className="space-y-1 text-caption">
                {/* ⚠ `environment` is the DEFAULT, not a degraded state. Rendering the two alike is how "I set this and
                    it did nothing" happens a second time. A person's name, never their sign-in id. */}
                <Row k="Set by">{setBy}</Row>
                <Row k="Gateway">
                  <code className="font-mono">{g.baseUrl ?? "not set"}</code> <span className="text-dim">· read-only here</span>
                </Row>
                {g.keyFingerprint && (
                  <Row k="Key">
                    <code className="font-mono">{g.keyFingerprint}</code>
                  </Row>
                )}
              </dl>
            </div>
          </div>
          {/* Changing it. */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1">
              {choices.length ? (
                <select
                  aria-label="Builder model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-bg px-3 font-mono text-caption text-text focus:border-accent focus:outline-none"
                >
                  {choices.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                // ⚠ A picker, not a text box, wherever there is a list — a free-typed model name is a 404 discovered
                // at generation time, minutes later, reported as a failed draft.
                <p className="text-caption text-muted">Fetch the gateway&rsquo;s models to choose one.</p>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== "" || !g.baseUrl}
              onClick={() =>
                run("models", async () => {
                  const r = await foundryApi.generationModels();
                  setChoices((prev) => [...new Set([...prev, ...r.models])].sort());
                  setCaveat(r.caveat);
                  return r;
                })
              }
            >
              {busy === "models" ? "Fetching…" : "Fetch models"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== ""}
              onClick={() =>
                run("test", async () => {
                  setTest(null);
                  const r = await foundryApi.generationTest();
                  setTest(r);
                  return r;
                })
              }
            >
              {busy === "test" ? "Testing…" : "Test"}
            </Button>
          </div>
          {/* ⚠ Rendered from the payload, never paraphrased. A model list proves the gateway answered a GET. */}
          {caveat && <p className="text-caption text-warn">{caveat}</p>}
          {test &&
            (test.ok ? (
              <p className="text-caption text-ok" role="status">
                ✓ A real completion succeeded — <code className="font-mono">{test.model}</code> answered in {test.ms}ms.
              </p>
            ) : (
              <p className="text-caption text-danger" role="status">✕ The test completion failed: {test.message}</p>
            ))}
        </div>
      </section>

      <section className="border-b border-line px-4 py-4">
        <div className="rounded-lg border border-line bg-surface-2 px-3.5 py-3 text-caption text-muted">
          <strong className="font-medium text-text">Separate settings.</strong> Changing the Builder model won&rsquo;t change
          the Runtime model used inside workflows. Its gateway and key come from the deployment&rsquo;s environment; a new
          model takes effect on the next design and changes no workflow that already exists.
        </div>
      </section>

      {error && (
        <div className="px-4 pt-4">
          <Notice tone="danger" title="That did not save">{error}</Notice>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl bg-surface-2 px-4 py-3">
        <span className={`mr-auto text-caption ${model !== g.defaultModel ? "text-warn" : "text-dim"}`} aria-live="polite">
          {model !== g.defaultModel ? "Unsaved changes" : "No unsaved changes."}
          {/* ⚠ Named rather than "reset to default" — a button whose outcome is unstated is one nobody presses. */}
          {model === g.defaultModel && g.source === "configured" && (
            <>
              {" "}
              <button
                type="button"
                disabled={busy !== ""}
                className="text-accent hover:underline disabled:text-dim"
                onClick={() =>
                  run("clear", async () => {
                    const r = await foundryApi.clearGenerationProvider();
                    toast.success(`Back to the deployment default (${g.environmentModel})`);
                    reload();
                    return r;
                  })
                }
              >
                Use the deployment default ({g.environmentModel}) instead
              </button>
            </>
          )}
        </span>
        <Button size="sm" variant="ghost" disabled={busy !== "" || model === g.defaultModel} onClick={() => setModel(g.defaultModel)}>
          Reset to saved
        </Button>
        <Button
          size="sm"
          disabled={busy !== "" || !model || model === g.defaultModel}
          onClick={() =>
            run("save", async () => {
              const r = await foundryApi.saveGenerationProvider({ defaultModel: model, allowedModels: choices });
              toast.success("Builder model saved");
              reload();
              return r;
            })
          }
        >
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-dim">{k}</dt>
      <dd className="min-w-0 break-words text-text">{children}</dd>
    </div>
  );
}
