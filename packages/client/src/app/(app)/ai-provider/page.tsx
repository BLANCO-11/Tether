// src/app/(app)/ai-provider/page.tsx — the model connection for the
// deployment: which gateway, which key, which models may be used.
//
// ── Three things this page is deliberately careful about ────────────────────
//
//  1. **The key is write-only.** It is posted once, stored encrypted in Foundry, and
//     never returned by any route. What comes back is a `keyFingerprint` — eight
//     hex characters of a salted digest, enough to tell two keys apart and not
//     enough to reconstruct either. This is the same rule `/keys` follows for
//     workspace secrets, and a settings page is exactly where it gets broken "so
//     the operator can check what they pasted".
//
//  2. **A populated model list is NOT a working configuration.** Listing models
//     proves the gateway answered a GET. A gateway enumerates models happily for
//     a key with no quota, no access to any of them and no billing attached —
//     which is precisely the documented `llmConnected: true` false green on
//     a health probe that "verifies" an LLM by listing models.
//     So the two actions are separate, labelled differently, and only "Run a
//     test completion" is presented as evidence.
//
//  3. **The allowlist is a spend control, not a convenience.** A flow may name a
//     model; anything off this list is refused by name. Ticking every box
//     available is a decision about what a caller may bill, so the page says so
//     rather than defaulting to all.
//
// ── 2026-11-04: ONE model connection ────────────────────────────────────────
//
// One gateway, one enabled-model list and one default for the whole deployment,
// set here and used by workflow steps (llm_complete), the builder and Forge
// chats. The old Runtime/Builder split (D-35) was reversed by the product owner.
// Three steps (connection, models, save); the Costs tab holds model prices.

"use client";

import { Suspense } from "react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { foundryApi, type FALlmProvider, type FALlmTest } from "@/lib/foundry-client";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { Search } from "@/components/ui/icons";
import { ModelPricingPanel } from "@/components/ops/ModelPricingPanel";

type Tab = "models" | "pricing";

function AiProviderPageContent() {
  const provider = useAsync<FALlmProvider>(() => foundryApi.getLlmProvider());
  const params = useSearchParams();
  const router = useRouter();
  const tab: Tab = params.get("tab") === "pricing" ? "pricing" : "models";

  const p = provider.data;

  return (
    <Page>
      <PageHeader
        eyebrow="Admin"
        title="AI models"
        purpose="One connection for the whole deployment. Workflows, the builder and Forge chats all use the models you enable here."
      />

      <Zone name="notices">
        {provider.error && <Notice tone="danger" title="Could not read the model connection">{provider.error}</Notice>}
        {p?.forgeReachable === false && p.forgeWarning && (
          <Notice tone="warn" title="Forge chats cannot reach this gateway">{p.forgeWarning}</Notice>
        )}
      </Zone>

      <Zone name="content">
        <div role="tablist" aria-label="Which model" className="-mb-2 flex items-center gap-1 border-b border-line px-1">
          {(
            [
              ["models", "Models"],
              ["pricing", "Costs"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => router.replace(key === "models" ? "/ai-provider" : `/ai-provider?tab=${key}`)}
              className={`-mb-px border-b-2 px-3 py-2 text-body transition-colors duration-150 ${
                tab === key ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "pricing" ? (
          <ModelPricingPanel
            knownModels={p?.allowedModels ?? []}
            inUse={p?.defaultModel ? { [p.defaultModel]: ["Default"] } : {}}
          />
        ) : p ? (
          <ModelSettings p={p} reload={provider.reload} />
        ) : provider.error ? null : (
          <div className="pane p-4"><Skeleton rows={6} /></div>
        )}
      </Zone>
    </Page>
  );
}

/** A numbered step heading inside a settings pane. */
function Step({ n, title, hint, children, action }: { n: number; title: string; hint?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4 last:border-0">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-caption tabular-nums text-muted">{n}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-medium text-text">{title}</h3>
          {hint && <p className="text-caption text-dim">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="pl-9">{children}</div>
    </section>
  );
}

/** One line of evidence from a test completion: ✓ model · latency · tokens, or ✕ and why. */
function TestLine({ test }: { test: FALlmTest }) {
  return test.ok ? (
    <p className="mt-3 text-caption text-ok" role="status">
      ✓ A real completion succeeded — {test.model} answered “{test.text}” in {test.latencyMs}ms ({test.promptTokens} prompt /{" "}
      {test.completionTokens} completion tokens).
    </p>
  ) : (
    <p className="mt-3 text-caption text-danger" role="status">✕ The test completion failed.</p>
  );
}

function ModelSettings({ p, reload }: { p: FALlmProvider; reload: () => void }) {
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [caveat, setCaveat] = useState<string | null>(null);
  const [test, setTest] = useState<FALlmTest | null>(null);
  const [busy, setBusy] = useState<"" | "models" | "test" | "save" | "clear">("");
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  // Seed the form from the server once it arrives. The key box stays empty: the server never sends it, and
  // pre-filling a placeholder would make "leave blank to keep the existing key" impossible to express.
  useEffect(() => {
    setBaseUrl(p.baseUrl);
    setDefaultModel(p.defaultModel);
    setAllowed(p.allowedModels);
  }, [p]);

  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>): Promise<T | null> => {
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

  const discover = () =>
    run("models", async () => {
      const r = await foundryApi.llmModels({ baseUrl, apiKey: apiKey || undefined });
      setDiscovered(r.models);
      setCaveat(r.caveat);
      // Discovering does not enable anything. Enabling is a spend decision and stays an explicit choice.
      return r;
    });

  const runTest = () =>
    run("test", async () => {
      setTest(null);
      const r = await foundryApi.llmTest({ baseUrl, apiKey: apiKey || undefined, model: defaultModel || undefined });
      setTest(r);
      return r;
    });

  const save = () =>
    run("save", async () => {
      const saved = await foundryApi.saveLlmProvider({
        baseUrl: baseUrl.trim(),
        // Empty means "keep the stored key", which is what makes changing the model list possible without
        // re-pasting a credential.
        apiKey: apiKey.trim() || undefined,
        defaultModel,
        allowedModels: allowed,
      });
      setApiKey("");
      toast.success("Models saved");
      reload();
      return saved;
    });

  const clear = () =>
    run("clear", async () => {
      const r = await foundryApi.clearLlmProvider();
      setApiKey("");
      toast.success("Cleared — falling back to the environment");
      reload();
      return r;
    });

  // Back to what is saved: the form only, nothing is sent.
  const resetForm = () => {
    setBaseUrl(p.baseUrl);
    setApiKey("");
    setDefaultModel(p.defaultModel);
    setAllowed(p.allowedModels);
    setError(null);
  };

  const toggle = (model: string) =>
    setAllowed((prev) => {
      const next = prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model];
      // A default that is not on the list is refused by the server, so turning the default off clears it here
      // rather than letting the save fail.
      if (!next.includes(defaultModel)) setDefaultModel(next[0] ?? "");
      return next;
    });

  // What can be picked: whatever the gateway advertised, plus anything already enabled (so a saved model does not
  // vanish before anyone has fetched the list).
  const choices = useMemo(() => [...new Set([...(discovered ?? []), ...allowed])].sort(), [discovered, allowed]);
  const shown = choices.filter((m) => !q.trim() || m.toLowerCase().includes(q.trim().toLowerCase()));
  const dirty =
    baseUrl !== p.baseUrl ||
    apiKey !== "" ||
    defaultModel !== p.defaultModel ||
    allowed.slice().sort().join("|") !== p.allowedModels.slice().sort().join("|");

  return (
    <div className="pane">
      <Step n={1} title="Connection" hint="The OpenAI-compatible gateway every model call goes through: workflow steps, the builder and Forge chats.">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Gateway base URL">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://gateway.example/v1" />
          </Field>
          <Field label="API key" hint={p.keyFingerprint ? `Stored key ${p.keyFingerprint}. Leave blank to keep it.` : "Leave blank to keep the stored key."}>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={p.configured ? "•••••••• (unchanged)" : "paste a key"}
              autoComplete="off"
            />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={runTest} disabled={busy !== "" || !baseUrl}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </Button>
          <span className="text-caption text-dim">Runs one real completion with the default model.</span>
        </div>
        {test && <TestLine test={test} />}
      </Step>

      <Step
        n={2}
        title="Models"
        hint={`${allowed.length} of ${choices.length} enabled. Forge chats and workflow steps can only choose enabled models; the default is used when none is chosen.`}
        action={
          <Button size="sm" variant="ghost" onClick={discover} disabled={busy !== "" || !baseUrl}>
            {busy === "models" ? "Fetching…" : "Fetch models"}
          </Button>
        }
      >
        {/* ⚠ Rendered from the payload, never paraphrased: a model list proves the gateway answered a GET. */}
        {caveat && <p className="mb-3 text-caption text-warn">{caveat}</p>}
        {choices.length === 0 ? (
          <p className="text-caption text-muted">No models yet — fetch them from the gateway.</p>
        ) : (
          <>
            {choices.length > 8 && (
              <div className="relative mb-2 w-64">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"><Search s={13} /></span>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter models" aria-label="Filter models" className="pl-8" />
              </div>
            )}
            <ul className="max-h-80 divide-y divide-line overflow-auto rounded-md border border-line">
              {shown.map((m) => {
                const on = allowed.includes(m);
                return (
                  <li key={m} className="flex items-center gap-3 px-3 py-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2.5">
                      <input type="checkbox" checked={on} onChange={() => toggle(m)} className="size-4 accent-accent" aria-label={`Enable ${m}`} />
                      <code className={`truncate font-mono text-caption ${on ? "text-text" : "text-muted"}`}>{m}</code>
                    </label>
                    <label className={`flex shrink-0 items-center gap-1.5 text-caption ${on ? "text-muted" : "text-dim opacity-50"}`}>
                      <input
                        type="radio"
                        name="default-model"
                        checked={defaultModel === m}
                        disabled={!on}
                        onChange={() => setDefaultModel(m)}
                        className="accent-accent"
                      />
                      Default
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Step>

      {error && (
        <div className="px-4 pt-4">
          <Notice tone="danger" title="That did not save">{error}</Notice>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-line bg-surface-2 px-4 py-3">
        <span className={`mr-auto text-caption ${dirty ? "text-warn" : "text-dim"}`} aria-live="polite">
          {dirty ? "Unsaved changes" : "No unsaved changes."}
          {/* Back to the deployment's own settings: a real choice, kept quiet beside the everyday Reset. */}
          {!dirty && p.source === "configured" && (
            <>
              {" "}
              <button type="button" onClick={clear} disabled={busy !== ""} className="text-accent hover:underline disabled:text-dim">
                Use the environment's settings instead
              </button>
            </>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={resetForm} disabled={busy !== "" || !dirty}>
          Reset to saved
        </Button>
        <Button size="sm" onClick={save} disabled={busy !== "" || !baseUrl || allowed.length === 0 || !dirty}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ⚠ `useSearchParams()` makes a statically prerendered page bail out to the client, and Next 15 refuses to BUILD one that does
// so outside a Suspense boundary ("Missing Suspense boundary with useSearchParams"). The boundary is here, around the page, so
// the page's own loading and error states are untouched.
export default function AiProviderPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <AiProviderPageContent />
    </Suspense>
  );
}
