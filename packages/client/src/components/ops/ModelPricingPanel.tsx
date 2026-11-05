"use client";

// Model costs (rbac-observability, 2026-10-15): what each model costs per 1 million tokens, in US dollars, and what
// the deployment has spent on each.
//
// - Prices: input, output, and the two cached-prompt prices. Cached tokens are PART of the input tokens a model
//   reports; a cache read and a cache write are charged at their own price when set, else at the input price.
// - A price applies from when it is saved. Past usage keeps the price it had — or, from before any price, the cost
//   the gateway reported. Removing a price makes the reported cost apply again from then on.
// - Spend: per model over a window, split by where the figure came from (a price set here, or the reported cost),
//   with the calls NOTHING costed called out — they are missing from every total until somebody sets a price.
//
// Anybody signed in can read the prices (a member sees their own cost, so what it is built from is readable). Setting
// one needs `platform.generation.write`; the deployment's spend needs `platform.signals.read`.

import { Fragment, useMemo, useState } from "react";
import { foundryApi, type FAModelPrice, type FAModelPricing, type FAModelSpend } from "@/lib/foundry-client";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useCanPlatform } from "@/components/access/Can";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tag } from "@/components/ui/Badge";

/** "" → null; anything else must be a non-negative number. */
export function parsePrice(raw: string): number | null | "bad" {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : "bad";
}

/** "$1,234.56", with cents shown below a dollar so a cheap model does not read as free. */
export function usd(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) < 1) return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 1234567 → "1.23M". */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

const PRICE_FIELDS = [
  { key: "inputPer1m", label: "Input" },
  { key: "cachedInputPer1m", label: "Cached input" },
  { key: "cacheWritePer1m", label: "Cache write" },
  { key: "outputPer1m", label: "Output" },
] as const;
type PriceKey = (typeof PRICE_FIELDS)[number]["key"];

/** One price for the history list, in words. */
function priceWords(p: FAModelPrice): string {
  if (p.inputPer1m == null && p.outputPer1m == null) return "Price removed — reported cost used";
  const part = (label: string, v: number | null | undefined) => (v == null ? null : `${label} ${usd(v)}`);
  return [
    part("input", p.inputPer1m),
    part("cached", p.cachedInputPer1m),
    part("cache write", p.cacheWritePer1m),
    part("output", p.outputPer1m),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ModelPricingPanel({
  knownModels,
  inUse = {},
}: {
  knownModels: string[];
  /** The models configured right now, and what for: "Workflows" (the runtime model) or "Builder". */
  inUse?: Record<string, string[]>;
}) {
  const pricing = useAsync<FAModelPricing>(() => foundryApi.getModelPricing());
  const edit = useCanPlatform("platform.generation.write");
  const [added, setAdded] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  // Only the SELECTED models — the ones in use (each provider's chosen model) — plus any that already carries a price,
  // so a price set here never disappears, and one added here this visit. A model merely allowed, or seen in usage, is
  // not listed; its spend still shows under "Spend by model". `knownModels` is what "Add model" may offer.
  const models = useMemo(() => {
    const all = new Set<string>([...Object.keys(inUse), ...extra]);
    for (const p of pricing.data?.prices ?? []) all.add(p.model);
    return [...all].filter(Boolean).sort();
  }, [inUse, extra, pricing.data]);

  if (pricing.error) return <Notice tone="danger" title="Could not read the model prices">{pricing.error}</Notice>;
  if (!pricing.data) return <div className="pane p-4"><Skeleton rows={4} /></div>;

  const priceOf = (m: string) => pricing.data!.prices.find((p) => p.model === m);
  const historyOf = (m: string) => (pricing.data!.history ?? []).filter((h) => h.model === m);

  return (
    <div className="space-y-4">
      <section className="pane">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-body font-semibold text-text">Prices</h2>
          <p className="mt-0.5 text-caption text-muted">
            US dollars per 1 million tokens. Cached input is a prompt read from the model&apos;s cache, and a cache
            write is one stored in it; leave either empty to charge it at the input price. Reports use the price in
            effect when the usage happened, and a model with no price shows the cost the gateway reported. A change
            applies from now on and never rewrites past usage.
          </p>
          {!edit.allowed ? (
            <p className="mt-1 text-caption text-dim">Only an administrator who can change the models can set prices.</p>
          ) : null}
        </div>
        {models.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">No models yet. Add one below.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption text-dim">
                  <th className="px-4 py-2 font-medium">Model</th>
                  {PRICE_FIELDS.map((f) => (
                    <th key={f.key} className="px-2 py-2 font-medium">{f.label}, per 1M</th>
                  ))}
                  <th className="px-4 py-2 font-medium" aria-label="Actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {models.map((m) => (
                  <Fragment key={m}>
                    <PriceRow
                      model={m}
                      price={priceOf(m)}
                      uses={inUse[m] ?? []}
                      changes={historyOf(m).length}
                      historyOpen={openHistory === m}
                      onToggleHistory={() => setOpenHistory((cur) => (cur === m ? null : m))}
                      canEdit={edit.allowed}
                      onSaved={pricing.reload}
                    />
                    {openHistory === m ? (
                      <tr>
                        <td colSpan={PRICE_FIELDS.length + 2} className="bg-surface-2 px-4 py-2">
                          <ul className="space-y-1 text-caption" aria-label={`Price history of ${m}`}>
                            {historyOf(m).map((h, i) => (
                              <li key={`${h.effectiveFrom}-${i}`} className="flex flex-wrap gap-x-3">
                                <span className="tabular-nums text-dim">{new Date(h.effectiveFrom).toLocaleString()}</span>
                                <span className="text-text">{priceWords(h)}</span>
                                {h.updatedBy ? <span className="text-dim">by {h.updatedBy}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {edit.allowed ? (
          <div className="flex items-center gap-2 border-t border-line px-4 py-3">
            <Input
              aria-label="Add a model to price"
              placeholder="Model name, exactly as the gateway names it"
              value={added}
              onChange={(e) => setAdded(e.target.value)}
              className="max-w-sm"
              list="pricing-known-models"
            />
            <datalist id="pricing-known-models">
              {[...new Set(knownModels)].filter((m) => m && !models.includes(m)).sort().map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Button
              variant="subtle"
              disabled={!added.trim() || models.includes(added.trim())}
              onClick={() => {
                setExtra((x) => [...x, added.trim()]);
                setAdded("");
              }}
            >
              Add model
            </Button>
          </div>
        ) : null}
      </section>
      <SpendSection />
    </div>
  );
}

function PriceRow({
  model,
  price,
  uses,
  changes,
  historyOpen,
  onToggleHistory,
  canEdit,
  onSaved,
}: {
  model: string;
  price: FAModelPrice | undefined;
  uses: string[];
  changes: number;
  historyOpen: boolean;
  onToggleHistory: () => void;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const initial = (k: PriceKey) => (price?.[k] != null ? String(price[k]) : "");
  const [values, setValues] = useState<Record<PriceKey, string>>({
    inputPer1m: initial("inputPer1m"),
    cachedInputPer1m: initial("cachedInputPer1m"),
    cacheWritePer1m: initial("cacheWritePer1m"),
    outputPer1m: initial("outputPer1m"),
  });
  const [saving, setSaving] = useState(false);
  const parsed = Object.fromEntries(PRICE_FIELDS.map((f) => [f.key, parsePrice(values[f.key])])) as Record<PriceKey, number | null | "bad">;
  const bad = Object.values(parsed).some((v) => v === "bad");
  const unchanged = PRICE_FIELDS.every((f) => (parsed[f.key] ?? null) === (price?.[f.key] ?? null));
  // A cached price with nothing to fall back to is not a price: input or output must be set.
  const empty = parsed.inputPer1m == null && parsed.outputPer1m == null;

  async function save(remove: boolean) {
    setSaving(true);
    try {
      await foundryApi.setModelPrice(
        remove
          ? { model, inputPer1m: null, outputPer1m: null }
          : {
              model,
              inputPer1m: parsed.inputPer1m as number | null,
              outputPer1m: parsed.outputPer1m as number | null,
              cachedInputPer1m: parsed.cachedInputPer1m as number | null,
              cacheWritePer1m: parsed.cacheWritePer1m as number | null,
            },
      );
      toast.success(remove ? `Price removed for ${model}.` : `Price saved for ${model}.`);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr>
      <td className="px-4 py-2 align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="font-mono text-text">{model}</code>
          {uses.map((u) => (
            <Tag key={u}>{u}</Tag>
          ))}
        </div>
        <div className="text-caption text-dim">
          {price ? `since ${new Date(price.effectiveFrom).toLocaleDateString()}` : "no price — reported cost is used"}
          {changes > 0 ? (
            <>
              {" · "}
              <button type="button" onClick={onToggleHistory} aria-expanded={historyOpen} className="text-accent hover:underline">
                {historyOpen ? "Hide history" : `History (${changes})`}
              </button>
            </>
          ) : null}
        </div>
      </td>
      {PRICE_FIELDS.map((f) => (
        <td key={f.key} className="px-2 py-2 align-top">
          <Input
            aria-label={`${model} ${f.label.toLowerCase()} price per 1M tokens`}
            inputMode="decimal"
            placeholder={f.key === "cachedInputPer1m" || f.key === "cacheWritePer1m" ? "= input" : "—"}
            value={values[f.key]}
            disabled={!canEdit}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className="w-24"
          />
        </td>
      ))}
      <td className="px-4 py-2 text-right align-top">
        {canEdit ? (
          <div className="inline-flex gap-2">
            <Button size="sm" disabled={saving || bad || unchanged || empty} onClick={() => save(false)}>
              Save
            </Button>
            {price ? (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => save(true)}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
        {bad ? <div className="mt-1 text-caption text-danger">A price is a number, zero or more.</div> : null}
        {!bad && empty && !unchanged ? (
          <div className="mt-1 text-caption text-danger">Set an input or an output price.</div>
        ) : null}
      </td>
    </tr>
  );
}

const WINDOWS = [7, 30, 90] as const;

/** What the deployment spent on each model. Only for someone who may read the deployment's usage. */
function SpendSection() {
  const read = useCanPlatform("platform.signals.read");
  const [days, setDays] = useState<number>(30);
  const spend = useAsync(() => (read.allowed ? foundryApi.getModelSpend(days) : Promise.resolve(null)), [days, read.allowed]);
  if (!read.allowed) return null;

  const rows: FAModelSpend[] = spend.data?.models ?? [];
  const total = rows.reduce((a, r) => a + r.costUsd, 0);
  const uncosted = rows.filter((r) => r.uncostedCalls > 0);

  return (
    <section className="pane" aria-labelledby="spend-head">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-line px-4 py-3">
        <h2 id="spend-head" className="text-body font-semibold text-text">Spend by model</h2>
        <span className="text-caption text-muted">Every workspace. Cost from a price set here, else the reported cost.</span>
        <label className="ml-auto flex items-center gap-2 text-caption text-muted">
          Last
          <Select aria-label="Spend window" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="h-8 w-28">
            {WINDOWS.map((d) => (
              <option key={d} value={d}>{d} days</option>
            ))}
          </Select>
        </label>
      </div>
      {spend.error ? (
        <p role="alert" className="px-4 py-3 text-caption text-danger">The spend could not be read: {spend.error}</p>
      ) : !spend.data ? (
        <div className="p-4"><Skeleton rows={3} /></div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-caption text-muted">No model was called in the last {days} days.</p>
      ) : (
        <>
          {uncosted.length ? (
            <div role="status" className="border-b border-line bg-warn/10 px-4 py-2 text-caption text-text">
              {uncosted.reduce((a, r) => a + r.uncostedCalls, 0)} call(s) to {uncosted.map((r) => r.model).join(", ")} have no
              price and no reported cost, so they are missing from every total. Set a price above to cost them.
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-caption text-dim">
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-2 py-2 text-right font-medium">Calls</th>
                  <th className="px-2 py-2 text-right font-medium">Input</th>
                  <th className="px-2 py-2 text-right font-medium">of it cached</th>
                  <th className="px-2 py-2 text-right font-medium">Output</th>
                  <th className="px-2 py-2 text-right font-medium">From prices</th>
                  <th className="px-2 py-2 text-right font-medium">Reported</th>
                  <th className="px-4 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular-nums">
                {rows.map((r) => (
                  <tr key={r.model}>
                    <td className="px-4 py-2"><code className="font-mono text-text">{r.model}</code></td>
                    <td className="px-2 py-2 text-right">{r.calls}</td>
                    <td className="px-2 py-2 text-right">{tokens(r.tokensIn)}</td>
                    <td className="px-2 py-2 text-right text-muted">{tokens(r.tokensCached)}</td>
                    <td className="px-2 py-2 text-right">{tokens(r.tokensOut)}</td>
                    <td className="px-2 py-2 text-right text-muted">{usd(r.pricedUsd)}</td>
                    <td className="px-2 py-2 text-right text-muted">{usd(r.reportedUsd)}</td>
                    <td className="px-4 py-2 text-right font-medium text-text">
                      {usd(r.costUsd)}
                      {r.uncostedCalls ? <span className="ml-1 text-caption text-warn">+{r.uncostedCalls} uncosted</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line">
                  <td className="px-4 py-2 text-caption text-dim" colSpan={7}>Total, last {days} days</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums text-text">{usd(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
