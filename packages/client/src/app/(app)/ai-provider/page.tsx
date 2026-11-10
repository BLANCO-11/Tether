// src/app/(app)/ai-provider/page.tsx — your AI connection (personal BYOK).
//
// Layout follows the Connection mockup sections (tabs, stepped provider → models,
// status chip, provider picker) — Foundry theme, not the mockup palette.
//
//  1. The key is write-only (fingerprint only on read).
//  2. A populated model list is not a working config — Test runs a completion.
//  3. The allowlist is a spend control.

"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

type Tab = "connection" | "pricing";

function statusLabel(p: FALlmProvider | null | undefined): { text: string; on: boolean; tone: "ok" | "build" | "off" } {
  if (p?.configured) {
    return { text: p.keyFingerprint ? `Connected · ${p.keyFingerprint}` : "Connected", on: true, tone: "ok" };
  }
  const d = p?.deploymentDefault;
  if (d?.baseUrl && (d.defaultModel || d.keyFingerprint)) {
    const model = d.defaultModel || "model set";
    return { text: `Build default · ${model}`, on: true, tone: "build" };
  }
  // Env-sourced singleton (non-BYOK empty personal shouldn't look connected without deploymentDefault).
  if (p?.source === "env" && p.baseUrl && p.defaultModel) {
    return { text: `Build default · ${p.defaultModel}`, on: true, tone: "build" };
  }
  return { text: "Not connected", on: false, tone: "off" };
}

function AiProviderPageContent() {
  const provider = useAsync<FALlmProvider>(() => foundryApi.getLlmProvider());
  const params = useSearchParams();
  const router = useRouter();
  const tab: Tab = params.get("tab") === "pricing" ? "pricing" : "connection";
  const p = provider.data;
  const status = statusLabel(p);

  return (
    <Page>
      <PageHeader
        eyebrow="Settings / AI"
        title="Your AI connection"
        purpose="Connect a provider for your chats and workflows. Your key stays private to your account."
        badge={
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-caption font-normal normal-case tracking-normal text-muted" role="status">
            <span
              className={`size-1.5 rounded-full ${status.tone === "ok" ? "bg-ok" : status.tone === "build" ? "bg-accent" : "bg-dim"}`}
              aria-hidden
            />
            {status.text}
          </span>
        }
      />

      <Zone name="notices">
        {provider.error && <Notice tone="danger" title="Could not read your AI connection">{provider.error}</Notice>}
        {p?.forgeReachable === false && p.forgeWarning && (
          <Notice tone="warn" title="Forge chats cannot reach this gateway">{p.forgeWarning}</Notice>
        )}
        {p && !p.configured && p.deploymentDefault?.baseUrl ? (
          <Notice tone="info" title="Using the build default">
            This deployment already has a model from its environment settings
            {p.deploymentDefault.defaultModel ? (
              <>
                {" "}
                (<code className="font-mono text-caption">{p.deploymentDefault.defaultModel}</code>
                {p.deploymentDefault.keyFingerprint ? <> · key {p.deploymentDefault.keyFingerprint}</> : null})
              </>
            ) : null}
            . Gateway <code className="font-mono text-caption">{p.deploymentDefault.baseUrl}</code>. Connect your own key below to override it for your account.
          </Notice>
        ) : null}
      </Zone>

      <Zone name="content">
        <div role="tablist" aria-label="AI settings" className="mb-5 flex items-center gap-6 border-b border-line">
          {(
            [
              ["connection", "Connection"],
              ["pricing", "Costs"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => router.replace(key === "connection" ? "/ai-provider" : `/ai-provider?tab=pricing`)}
              className={`relative -mb-px pb-3 text-body transition-colors ${
                tab === key ? "font-medium text-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-muted hover:text-text"
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
          <div className="pane p-4">
            <Skeleton rows={6} />
          </div>
        )}
      </Zone>
    </Page>
  );
}

function Step({ n, title, hint, children, action }: { n: number; title: string; hint?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-5 last:border-0">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line text-caption tabular-nums text-accent">{n}</span>
          <div className="min-w-0">
            <h3 className="text-body font-semibold text-text">{title}</h3>
            {hint ? <p className="text-caption text-dim">{hint}</p> : null}
          </div>
        </div>
        {action}
      </div>
      <div className="pl-9">{children}</div>
    </section>
  );
}

function TestLine({ test }: { test: FALlmTest }) {
  return test.ok ? (
    <p className="text-caption text-ok" role="status">
      Connected — {test.model} answered in {test.latencyMs}ms.
    </p>
  ) : (
    <p className="text-caption text-danger" role="status">
      The test completion failed.
    </p>
  );
}

function ProviderPicker({
  presets,
  providerId,
  onPick,
}: {
  presets: FALlmProviderPreset[];
  providerId: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const current = presets.find((x) => x.id === providerId) ?? presets[presets.length - 1];
  const shown = presets.filter(
    (pr) => !q.trim() || `${pr.label} ${pr.blurb}`.toLowerCase().includes(q.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const mark = (label: string) => (label.trim()[0] ?? "?").toUpperCase();

  return (
    <div ref={box} className="relative max-w-xl">
      <button
        type="button"
        className="flex w-full min-h-[64px] items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left transition-colors hover:border-muted"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-caption font-semibold text-accent">
          {mark(current?.label ?? "?")}
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block text-body font-semibold text-text">{current?.label ?? "Choose a provider"}</strong>
          <small className="block truncate text-caption text-muted">{current?.blurb}</small>
        </span>
        <span className="text-muted" aria-hidden>
          ⌄
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 right-0 z-20 mt-2 rounded-xl border border-line bg-surface p-2 shadow-raised" role="listbox" aria-label="AI providers">
          <div className="relative mb-1.5">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim">
              <Search s={13} />
            </span>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search providers…" aria-label="Search providers" className="pl-8" />
          </div>
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-caption text-muted">No providers match. Try another search.</p>
          ) : (
            shown.map((pr) => {
              const on = providerId === pr.id;
              return (
                <button
                  key={pr.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-2 ${on ? "bg-accent/5" : ""}`}
                  onClick={() => {
                    onPick(pr.id);
                    setOpen(false);
                    setQ("");
                  }}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-[11px] font-semibold text-accent">
                    {mark(pr.label)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-caption font-medium text-text">{pr.label}</strong>
                    <small className="block truncate text-[11px] text-dim">{pr.blurb}</small>
                  </span>
                  {on ? <span className="text-accent">✓</span> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function ModelSettings({ p, reload }: { p: FALlmProvider; reload: () => void }) {
  const toast = useToast();
  const presets = p.presets ?? [];
  const [providerId, setProviderId] = useState<FALlmProviderPresetId | string>(p.providerId || "openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
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
    const prev = presets.find((x) => x.id === providerId);
    setProviderId(id);
    const next = presets.find((x) => x.id === id);
    if (next && !next.baseUrlEditable && next.baseUrl) setBaseUrl(next.baseUrl);
    else if (next?.baseUrlEditable && prev && !prev.baseUrlEditable) setBaseUrl(next.id === p.providerId ? p.baseUrl : "");
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

  const build = !p.configured ? p.deploymentDefault : null;

  return (
    <div className="pane">
      {build ? (
        <section className="border-b border-line bg-surface-2/40 px-4 py-4" aria-label="Build default model">
          <p className="text-[11px] font-medium uppercase tracking-wide text-dim">Build default (from deployment)</p>
          <dl className="mt-2 grid gap-2 text-caption text-muted sm:grid-cols-2">
            <div>
              <dt className="text-dim">Gateway</dt>
              <dd className="mt-0.5 truncate font-mono text-text" title={build.baseUrl}>
                {build.baseUrl}
              </dd>
            </div>
            <div>
              <dt className="text-dim">Default model</dt>
              <dd className="mt-0.5 font-mono text-text">{build.defaultModel || "—"}</dd>
            </div>
            <div>
              <dt className="text-dim">Key</dt>
              <dd className="mt-0.5 font-mono text-text">{build.keyFingerprint ? `${build.keyFingerprint} (deployment)` : "—"}</dd>
            </div>
            <div>
              <dt className="text-dim">Enabled models</dt>
              <dd className="mt-0.5 text-text">
                {build.allowedModels.length ? build.allowedModels.join(", ") : "—"}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-caption text-dim">Greyed fields below are your override. Until you save a key, chats use this build setting where the runtime allows it.</p>
        </section>
      ) : null}
      <Step n={1} title="Choose a provider" hint="Use the provider where your API key is set up.">
        {presets.length > 0 ? <ProviderPicker presets={presets} providerId={String(providerId)} onPick={pickPreset} /> : null}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label="Gateway URL" hint={baseUrlEditable ? "Optional — filled for known providers." : "Filled by the provider you picked."}>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={build?.baseUrl || preset?.baseUrl || "https://gateway.example/v1"}
              disabled={!baseUrlEditable}
              readOnly={!baseUrlEditable}
            />
          </Field>
          <Field
            label="API key"
            hint={
              p.keyFingerprint
                ? `Stored key ${p.keyFingerprint}. Leave blank to keep it.`
                : build?.keyFingerprint
                  ? `Deployment key ${build.keyFingerprint}. Paste your own to override.`
                  : preset?.keyHint || "Stored privately."
            }
          >
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={p.configured ? "•••••••• (unchanged)" : "Paste your API key"}
                autoComplete="off"
                className="pr-16"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] text-muted hover:text-text"
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant="ghost" onClick={runTest} disabled={busy !== "" || !effectiveBase}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </Button>
          {test ? <TestLine test={test} /> : <span className="text-caption text-dim">A quick test checks that your key works.</span>}
        </div>
      </Step>

      <Step
        n={2}
        title="Choose models"
        hint="Pick which models chats and workflow steps can use."
        action={
          <Button size="sm" variant="ghost" onClick={discover} disabled={busy !== "" || !effectiveBase}>
            {busy === "models" ? "Fetching…" : "Fetch models"}
          </Button>
        }
      >
        {caveat && <p className="mb-3 text-caption text-warn">{caveat}</p>}
        {choices.length === 0 && build?.allowedModels.length ? (
          <ul className="grid gap-2 opacity-60" aria-label="Build default models">
            {build.allowedModels.map((m) => (
              <li key={m} className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                <span className="truncate font-mono text-caption text-muted">{m}</span>
                <span className="shrink-0 text-[11px] text-dim">{m === build.defaultModel ? "Default · build" : "Build"}</span>
              </li>
            ))}
          </ul>
        ) : choices.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-3.5 text-caption text-muted">
            Connect and test your provider to see available models.
          </p>
        ) : (
          <>
            {choices.length > 8 && (
              <div className="relative mb-2 w-64">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim">
                  <Search s={13} />
                </span>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter models" aria-label="Filter models" className="pl-8" />
              </div>
            )}
            <ul className="grid max-h-80 gap-2 overflow-auto">
              {shown.map((m) => {
                const on = allowed.includes(m);
                return (
                  <li key={m} className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface px-3 py-2.5">
                    <label className="flex min-w-0 flex-1 items-center gap-2.5">
                      <input type="checkbox" checked={on} onChange={() => toggle(m)} className="size-4 accent-accent" aria-label={`Enable ${m}`} />
                      <span className={`truncate text-body ${on ? "font-medium text-text" : "text-muted"}`}>{m}</span>
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
          <Notice tone="danger" title="That did not save">
            {error}
          </Notice>
        </div>
      )}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 rounded-b-xl border-t border-line bg-surface/95 px-4 py-3 backdrop-blur">
        <span className={`text-caption ${dirty ? "text-warn" : "text-dim"}`} aria-live="polite">
          {dirty ? (
            <span className="inline-flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              Unsaved changes
            </span>
          ) : (
            <>
              No unsaved changes.
              {p.source === "configured" ? (
                <>
                  {" "}
                  <button type="button" onClick={clear} disabled={busy !== ""} className="text-accent hover:underline disabled:text-dim">
                    Disconnect
                  </button>
                </>
              ) : null}
            </>
          )}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={resetForm} disabled={busy !== "" || !dirty}>
            Reset to saved
          </Button>
          <Button size="sm" onClick={save} disabled={busy !== "" || !effectiveBase || allowed.length === 0 || !dirty}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </div>
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
