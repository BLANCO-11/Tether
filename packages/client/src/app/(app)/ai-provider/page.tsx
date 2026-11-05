// src/app/(app)/ai-provider/page.tsx — your AI connection (personal BYOK).
//
// ── Three things this page is deliberately careful about ────────────────────
//
//  1. **The key is write-only.** It is posted once, stored encrypted in Foundry, and
//     never returned by any route. What comes back is a `keyFingerprint` — eight
//     hex characters of a salted digest, enough to tell two keys apart and not
//     enough to reconstruct either.
//
//  2. **A populated model list is NOT a working configuration.** Listing models
//     proves the gateway answered a GET. Only "Test connection" runs a completion.
//
//  3. **The allowlist is a spend control.** Forge chats and workflow steps can only
//     choose enabled models; ticking every box is a billing decision.
//
// Personal product: each signed-in person owns one OpenAI-compatible connection
// (OpenAI, OpenRouter for Claude, OpenCode, Groq, or Custom). Native Anthropic
// is out of scope — use OpenRouter for Claude models.

"use client";

import { Suspense } from "react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  foundryApi,
  type FALlmProvider,
  type FALlmProviderPreset,
  type FALlmProviderPresetId,
  type FALlmTest,
} from "@/lib/foundry-client";
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
        eyebrow="Settings"
        title="Your AI connection"
        purpose="Paste your own API key. Chats, the builder and workflow AI steps use this connection — not a shared deployment key."
      />

      <Zone name="notices">
        {provider.error && <Notice tone="danger" title="Could not read your AI connection">{provider.error}</Notice>}
        {p?.forgeReachable === false && p.forgeWarning && (
          <Notice tone="warn" title="Forge chats cannot reach this gateway">{p.forgeWarning}</Notice>
        )}
        {p && !p.configured && (
          <Notice tone="info" title="Not connected yet">
            Pick a provider below and paste your API key. Until then, chats will ask you to connect here first.
          </Notice>
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
  const presets = p.presets ?? [];
  const [providerId, setProviderId] = useState<FALlmProviderPresetId | string>(p.providerId || "openai");
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

  const preset: FALlmProviderPreset | undefined = presets.find((x) => x.id === providerId) ?? presets[presets.length - 1];

  useEffect(() => {
    setProviderId(p.providerId || "openai");
    setBaseUrl(p.baseUrl);
    setDefaultModel(p.defaultModel);
    setAllowed(p.allowedModels);
  }, [p]);

  const pickPreset = (id: string) => {
    setProviderId(id);
    const next = presets.find((x) => x.id === id);
    if (next && !next.baseUrlEditable && next.baseUrl) setBaseUrl(next.baseUrl);
    else if (next?.id === "custom" && !p.configured) setBaseUrl("");
    setDiscovered(null);
    setCaveat(null);
    setTest(null);
  };

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

  const probe = () => ({
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
    providerId: String(providerId),
  });

  const discover = () =>
    run("models", async () => {
      const r = await foundryApi.llmModels(probe());
      setDiscovered(r.models);
      setCaveat(r.caveat);
      return r;
    });

  const runTest = () =>
    run("test", async () => {
      setTest(null);
      const r = await foundryApi.llmTest({ ...probe(), model: defaultModel || undefined });
      setTest(r);
      return r;
    });

  const save = () =>
    run("save", async () => {
      const saved = await foundryApi.saveLlmProvider({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        defaultModel,
        allowedModels: allowed,
        providerId: String(providerId),
      });
      setApiKey("");
      toast.success("AI connection saved");
      reload();
      return saved;
    });

  const clear = () =>
    run("clear", async () => {
      const r = await foundryApi.clearLlmProvider();
      setApiKey("");
      toast.success("Cleared — connect a provider again when you need AI");
      reload();
      return r;
    });

  const resetForm = () => {
    setProviderId(p.providerId || "openai");
    setBaseUrl(p.baseUrl);
    setApiKey("");
    setDefaultModel(p.defaultModel);
    setAllowed(p.allowedModels);
    setError(null);
  };

  const toggle = (model: string) =>
    setAllowed((prev) => {
      const next = prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model];
      if (!next.includes(defaultModel)) setDefaultModel(next[0] ?? "");
      return next;
    });

  const choices = useMemo(() => [...new Set([...(discovered ?? []), ...allowed])].sort(), [discovered, allowed]);
  const shown = choices.filter((m) => !q.trim() || m.toLowerCase().includes(q.trim().toLowerCase()));
  const dirty =
    String(providerId) !== (p.providerId || "openai") ||
    baseUrl !== p.baseUrl ||
    apiKey !== "" ||
    defaultModel !== p.defaultModel ||
    allowed.slice().sort().join("|") !== p.allowedModels.slice().sort().join("|");

  const baseUrlEditable = preset?.baseUrlEditable !== false;
  const effectiveBase = baseUrl || preset?.baseUrl || "";

  return (
    <div className="pane">
      <Step n={1} title="Provider" hint="OpenAI-compatible gateways only. For Claude / Anthropic models, choose OpenRouter.">
        {presets.length > 0 ? (
          <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="AI provider">
            {presets.map((pr) => {
              const on = providerId === pr.id;
              return (
                <button
                  key={pr.id}
                  type="button"
                  role="radio"
                  aria-label={pr.label}
                  aria-checked={on}
                  onClick={() => pickPreset(pr.id)}
                  className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                    on ? "border-accent bg-accent/5" : "border-line hover:border-muted"
                  }`}
                >
                  <div className="text-body font-medium text-text">{pr.label}</div>
                  <p className="mt-1 text-caption text-dim">{pr.blurb}</p>
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Gateway base URL" hint={baseUrlEditable ? undefined : "Filled by the provider you picked."}>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset?.baseUrl || "https://gateway.example/v1"}
              disabled={!baseUrlEditable}
              readOnly={!baseUrlEditable}
            />
          </Field>
          <Field
            label="API key"
            hint={
              p.keyFingerprint
                ? `Stored key ${p.keyFingerprint}. Leave blank to keep it.`
                : preset?.keyHint || "Paste your API key."
            }
          >
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
          <Button size="sm" variant="ghost" onClick={runTest} disabled={busy !== "" || !effectiveBase}>
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
          <Button size="sm" variant="ghost" onClick={discover} disabled={busy !== "" || !effectiveBase}>
            {busy === "models" ? "Fetching…" : "Fetch models"}
          </Button>
        }
      >
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
          {!dirty && p.source === "configured" && (
            <>
              {" "}
              <button type="button" onClick={clear} disabled={busy !== ""} className="text-accent hover:underline disabled:text-dim">
                Disconnect
              </button>
            </>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={resetForm} disabled={busy !== "" || !dirty}>
          Reset to saved
        </Button>
        <Button size="sm" onClick={save} disabled={busy !== "" || !effectiveBase || allowed.length === 0 || !dirty}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export default function AiProviderPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6" />}>
      <AiProviderPageContent />
    </Suspense>
  );
}
