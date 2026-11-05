// src/app/(app)/triggers/page.tsx — the Triggers page. Shows each trigger as a card and
// lets you create, test, open, edit, enable or disable, and delete triggers.
//
// ── THE PROOF PAGE FOR THE ZONE LAYOUT (ui-upgrade Phase 2.7) ───────────────
//
// This is the one page Phase 2 migrates. Its content was SORTED into the zones,
// not rewritten: the header keeps its words, the load-failure banner became the
// `<Notice>` it was already imitating, and the cards are untouched below.
//
// ⚠ Three of the five zones, not five. The plan expected all five; the page has
// no controls (zone 3) and no related block (zone 5), and inventing either to
// fill the slot would be building a feature inside a layout phase and calling the
// result evidence. `issues.md` I-83 records it, and asks Phase 4 to migrate
// `/keys` first — the page D-77 was actually written about.
//
// ⚠ The two blocked-reason sentences on a card stay TWO sentences and stay on the
// card (D-88). "It has never run" is fixed by running it; "it has no approved
// revision" is fixed by a second person. They are per-trigger facts, so they are
// not zone-2 notices — a page-level banner cannot say which card it means.
//
// ── GROUPED BY AUTOMATION (ui-upgrade Phase 7.2, D-109) ─────────────────────
//
// Two of the three sentences a card can carry are facts about the AUTOMATION,
// not about the trigger — so a flat list repeated one approval state once per
// trigger and gave the reader nothing to see they were the same fact. Three
// triggers on one unapproved flow said "waiting on approval" three times and
// looked like three problems. `lib/trigger-groups.ts` does the grouping and the
// ordering; this file renders it.
//
// ⚠ A THIRD sentence arrived with Phase 7 and it is a WARNING, not a gate
// (D-108): `inputsWarning` says the automation requires an input nobody
// supplies. Its fix is typing a value, so it must not be dressed as a refusal —
// a sentence that looks like a control and controls nothing is I-38 from the
// other side.
//
// The `"Available"` branch that used to live here is gone: no `Trigger` can ever
// carry that state (`issues.md` I-81).
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listTriggers, createTrigger, testTrigger, updateTrigger, deleteTrigger, setTriggerLive } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useActivityEpoch } from "@/lib/activity";
import { useToast } from "@/lib/toast";
import type { Trigger } from "@/lib/types";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { groupByAutomation } from "@/lib/trigger-groups";
import { CREATABLE, SCHEDULE_SPEC, UNAVAILABLE, type TriggerKind } from "@/lib/trigger-kinds";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { StatusPill, StatusWordPill } from "@/components/ui/Badge";
import { TriggerInputs, TriggerInputsEditor } from "@/components/automation/TriggerInputs";
import { FireTriggerDialog } from "@/components/automation/FireTriggerDialog";
import { Modal } from "@/components/ui/Modal";
import { Confirm } from "@/components/ui/Confirm";
import { Field, Input, Select } from "@/components/ui/Field";
import { TriggerFires } from "@/components/automation/TriggerFires";
import { Plus, Check } from "@/components/ui/icons";

/**
 * The mock's kind chip (D-02): the kind word in mono uppercase with a hue dot —
 * `k k-tool` in the mock, which uses the tool hue for every trigger kind. The
 * WORD is the carrier; the colour is decoration, so a colour-blind reader loses
 * nothing when the hues collapse.
 */
function KindChip({ kind }: { kind: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-micro uppercase tracking-label"
      style={{ color: "var(--k-tool)" }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: "var(--k-tool)" }} />
      {kind}
    </span>
  );
}

/**
 * ⚠ The four per-kind ICONS are gone with the card layout. The frozen mock's
 * trigger-card rows lead with a kind CHIP (mono uppercase word + hue dot,
 * `KindChip` below) instead of an icon tile — the word is the carrier, the
 * colour is decoration, which is the colour-blind-safe direction the mock
 * froze (D-02). `schedule` stays in the icon union for legacy rows; the chip
 * renders `t.kind` verbatim, whatever the server stored.
 */

// The outcome of firing a trigger: a one-line summary and the log the server's
// answer produced. ⚠ No `payload` and no `dataLabel` — those framed a fabricated
// sample ("A sample email was delivered and read by AI") for work that never
// happened, on kinds that could not exist.
type TestResult = { name: string; log: string[] };

export default function TriggersPage() {
  // A trigger's "last fired" and its readiness both move when a run happens.
  const epoch = useActivityEpoch();
  const { data: triggers, loading, error, reload } = useAsync(listTriggers, [epoch]);
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  // ⚠ `TriggerKind`, not `Trigger["icon"]`. The icon union still carries
  // `schedule` for rows that predate the server's refusal of one — and a
  // pre-selection is a thing to CREATE, so it may only be a creatable type.
  const [createKind, setCreateKind] = useState<TriggerKind | undefined>(undefined);
  const [result, setResult] = useState<TestResult | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Trigger | null>(null);
  const [firing, setFiring] = useState<Trigger | null>(null);
  const [editing, setEditing] = useState<Trigger | null>(null);
  const [confirmDel, setConfirmDel] = useState<Trigger | null>(null);

  const openCreate = (kind?: TriggerKind) => { setCreateKind(kind); setCreating(true); };
  /**
   * Fire the trigger for real. `fileName` is gone: it fed the mock path, which
   * fabricated per-kind sample payloads and log lines ("Delivered a sample email
   * to …", "Replied 200 OK") for work that never happened. Firing starts the
   * flow's approved live revision, or is refused — and the refusal is the useful
   * answer, because a flow with no approved revision cannot run.
   *
   * ⚠ `testFraming(t.icon)` is gone with it (I-94). It supplied a per-kind
   * summary sentence — *"A sample email was delivered and read by AI"* — for
   * five kinds that could not exist, over a log the server had already written.
   * The log is the answer; a headline written client-side from the icon is a
   * second, unverified account of the same event.
   */
  const runTest = async (t: Trigger) => {
    // A trigger that declares inputs needs per-fire values — the run sheet
    // asks for them. One that declares none fires exactly as before.
    if ((t.declaredInputs ?? []).length > 0) {
      setFiring(t);
      return;
    }
    setTestingId(t.id);
    const r = await testTrigger(t.id);
    setResult({ name: t.name, log: r.log });
    setTestingId(null);
  };
  // A file-upload trigger used to open a file picker here, purely so the mock had
  // a filename to echo back. A real fire takes its inputs from the trigger's own
  // stored config, never from a browser upload, so there is nothing to pick.
  // `clearValidation(t.id)` was here, clearing `lib/validation.ts` — a per-browser
  // localStorage store for the OLD go-live gate. That gate moved server-side to
  // `triggerService.enableReadiness()`, and the module was left behind in a state
  // worth noticing: nothing wrote to the store any more and nothing read it for
  // gating, so this line deleted from a record that was always empty. Both are gone.
  const remove = async (t: Trigger) => { await deleteTrigger(t.id); toast.success(`Deleted "${t.name}"`); reload(); };
  // Going live is gated SERVER-SIDE (WS-H0.2): the bound automation must have
  // finished generating AND completed at least one successful run. The previous
  // gate here was a per-browser localStorage record — and it was keyed on the
  // trigger id while the builder recorded the AUTOMATION id, so it could never
  // match and go-live was permanently blocked with a misleading message. The
  // server owns the rule now; this only reports its answer. Pausing stays free.
  const flipLive = async (t: Trigger) => {
    const goingLive = t.state !== "Live";
    if (goingLive && t.enableReady === false) {
      toast.warn(t.enableBlockedReason ?? `"${t.name}" cannot go live yet.`);
      return;
    }
    try {
      await setTriggerLive(t.id, goingLive);
      toast.success(`"${t.name}" is now ${goingLive ? "live" : "a draft"}`);
    } catch (e) {
      // The server is the authority, so a refusal here is the real reason.
      toast.error(e instanceof Error ? e.message : `Could not update "${t.name}".`);
    }
    reload();
  };

  return (
    <>
      <Page>
      {/* Zone 1. One action, and it is a verb — the header cannot hold a control
          even if this page later grows one (D-93). */}
      <PageHeader
        eyebrow="Connect"
        title="Triggers"
        // ⚠ It used to end "run a safe test any time — testing never touches
        // real data", which was false in the most expensive direction
        // (`issues.md` I-95): firing starts the approved LIVE revision.
        // The frozen mock's sentence (D-02): the three kinds in scope, and the
        // fact that the draft agent can create them (Phase 6 wires that).
        purpose="What starts an automation — time, webhook, API. Triggers are components the draft agent can create."
        actions={[{ label: "Create trigger", icon: <Plus s={15} />, onClick: () => openCreate() }]}
      />

      {/* Zone 2. Page level and full width: this is the whole page failing, not
          one card. It was written inline at its own recipe — one of the four
          `<Notice>` exists to replace. */}
      {error && (
        <Zone name="notices">
          <Notice
            tone="danger"
            title="Could not load triggers"
            action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}
          >
            {error}
          </Notice>
        </Zone>
      )}

      {/* Zone 4. Zones 3 and 5 are absent, not forgotten — see the header. */}
      <Zone name="content" gap="none">
      {error ? null : loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (triggers ?? []).length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-5 py-6 text-center text-sm text-muted">No triggers yet. Select “Create trigger” to create your first one.</p>
      ) : (
        <div className="space-y-8">
        {groupByAutomation(triggers ?? []).map((g) => (
        <section key={g.key} className="space-y-3">
          {/* The group header: the AUTOMATION, its own status, and the two
              sentences that are facts about it rather than about any one
              trigger below (D-109). The name is the doc's GROUP HEADER — an
              eyebrow (11px uppercase dim; mono because a flow name is an
              identifier the manifest references), matching the mock's
              `h2.eyebrow`. The status pill is a badge and carries its own
              weight beside it. The count and the model-cron are supporting
              facts, so they sit on their own line below — never larger than
              the header. */}
          <div className="space-y-2 border-b border-line pb-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {g.flowId ? (
                <Link
                  href={`/flows/${g.flowId}`}
                  className="font-mono text-caption uppercase tracking-label text-dim hover:text-accent"
                >
                  {g.automation ?? "Untitled automation"}
                </Link>
              ) : (
                <span className="font-mono text-caption uppercase tracking-label text-dim">Bound to nothing</span>
              )}
              <StatusWordPill word={g.status} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>
                {g.triggers.length} {g.triggers.length === 1 ? "trigger" : "triggers"}
              </span>
              {/* The cron lives on the automation's MODEL and is deployed by
                  approving a revision (D-18). Said here, where it is true —
                  never copied onto a trigger row. */}
              {g.scheduleCron && (
                <span>
                  also runs <span className="font-mono text-text">{g.scheduleCron}</span> once approved
                </span>
              )}
            </div>
            {/* ⚠ Gate 1 and gate 2, still TWO sentences (D-88). Moved from the
                card to the automation because that is what each is about — not
                merged, which is the thing that would make one of them wrong. */}
            {g.enableBlockedReason && (
              <p className="text-xs text-muted">
                <span className="font-medium text-text">Cannot go live yet. </span>
                {g.enableBlockedReason}
              </p>
            )}
            {g.approvalBlockedReason && (
              <p className="text-xs text-muted">
                <span className="font-medium text-text">Waiting on approval. </span>
                {g.approvalBlockedReason}{" "}
                {g.flowId && (
                  <Link href={`/flows/${g.flowId}`} className="text-accent underline-offset-2 hover:underline">
                    Review it
                  </Link>
                )}
              </p>
            )}
          </div>

        <div className="space-y-3">
          {g.triggers.map((t) => {
            // Undefined for offline/mock triggers, which have no server gate.
            const ready = t.enableReady !== false;
            // The POST address for webhook AND api triggers, as the server
            // stores it — both ride the same `webhookPath` field, the api
            // receiver being `/api/triggers/<token>/api` (Phase 6 contract).
            // The mock shows a full URL; there is no public base URL in the
            // client (the parent server's address is server-side env), so the
            // path is rendered as stored and "Copy URL" is not offered — see
            // the report.
            const address = t.rows.find((r) => r.label === "Address")?.value;
            return (
              <div key={t.id} className="rounded-lg border border-line bg-surface px-4 py-3">
                {/* Row 1: the mock's kind chip + mono name + status badge. The
                    mock's card keeps its actions in the bottom btn-sm row, so
                    there is no kebab up here — a kebab Edit beside a row-3 Edit
                    would be the same action offered twice. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <KindChip kind={t.kind} />
                  <span className="font-mono text-sm font-semibold text-text">{t.name}</span>
                  <StatusPill status={t.stateStatus}>{t.state}</StatusPill>
                </div>

                {/* Row 2: the mock's per-kind detail line. Only facts the data
                    carries — no invented timezones or future-fire claims. */}
                {t.icon === "schedule" ? (
                  <p className="mt-1.5 text-xs text-muted">
                    Cron <span className="font-mono text-text">{t.scheduleCron ?? "—"}</span>
                    {t.lastStarted && t.lastStarted !== "never" ? ` · last fired ${t.lastStarted}` : ""}
                  </p>
                ) : (t.icon === "webhook" || t.icon === "api") && address ? (
                  <p className="mt-1.5 text-xs text-muted">
                    POST <span className="font-mono text-text">{address}</span>
                    <span className="ml-1 text-caption text-dim">
                      {/**
                        * ⚠ **CORRECTED 2026-09-06, and the old text was not a
                        * wording problem.** It said a webhook was "signed by
                        * the webhook secret". `routes/triggers.ts`'s receiver
                        * resolves the token out of the PATH and fires — there
                        * is no signature, no secret and no header checked. So
                        * the screen claimed a control that does not exist, on
                        * the one endpoint in the product that answers an
                        * anonymous caller and then does work. Measured at the
                        * wire: a bare POST to the URL, no headers, fired a run.
                        *
                        * The api receiver DOES check a Bearer, and it is the
                        * same value that is in the path — so it is a second
                        * place to present the token, not a second factor.
                        *
                        * And where the inputs come from differs by kind, which
                        * nothing said: a webhook never reads its body (it is
                        * attacker-controlled on a public URL), an api caller
                        * must supply them there. Getting that wrong is a 422
                        * naming an input the trigger visibly has a value for.
                        */}
                      {t.icon === "webhook"
                        ? "— anyone holding this URL can fire it: the token in the path is the credential. " +
                          "Inputs come from the values saved on this trigger, never from the request body."
                        : "— the token in the path is also the Bearer credential. " +
                          "Inputs must be supplied in the request body."}
                    </span>
                  </p>
                ) : t.icon === "poll" ? (
                  <p className="mt-1.5 text-xs text-muted">
                    Hash-based — starts when the watched address&apos;s response changes · unchanged
                    in this update
                  </p>
                ) : null}

                {/* ⚠ The THIRD sentence, and it is a WARNING (D-108). Its fix is
                    typing a value here, so it is deliberately NOT styled like the
                    two blocked-reason paragraphs: it refuses nothing, and a
                    sentence dressed as a control that controls nothing is I-38
                    from the other side. */}
                {t.inputsWarning && (
                  <p className="mt-1.5 text-xs text-warn">{t.inputsWarning}</p>
                )}
                {/* An armed flow with a newer draft is the §6.5 guarantee in
                    action, not a problem — say which revision actually fires. */}
                {t.draftAhead && t.armedRevision != null && (
                  <p className="mt-1.5 text-xs text-muted">
                    Fires revision <span className="font-mono text-text">v{t.armedRevision}</span>. A newer
                    draft is not approved and will not run.
                  </p>
                )}
                {t.lastStarted && t.lastStarted !== "never" && (
                  <p className="mt-1.5 text-xs text-muted">Last started {t.lastStarted}</p>
                )}

                {/* What this trigger sends — the one editable fact about it. */}
                <TriggerInputs trigger={t} />

                {/* Row 3: the mock's Edit + Copy-URL pair, PLUS the real
                    controls the mock omits but behaviour must keep: Fire now,
                    the ready check and the LiveSwitch (D-02 divergence, on
                    record). Copy URL is not offered: only the path is known.
                    Remove sits here (not in a kebab) so the card's actions
                    live in one row, like the tools table's Edit/Remove pair —
                    the kebab's Delete moved down with the same label shape. */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>Edit</Button>
                  <Button variant="subtle" size="sm" disabled={testingId === t.id} onClick={() => runTest(t)}>{testingId === t.id ? "Firing…" : "Fire now"}</Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDel(t)} className="text-danger hover:bg-danger-bg">Remove</Button>
                  <div className="ml-auto flex items-center gap-2">
                    {ready ? (
                      <span className="flex items-center gap-1 text-xs text-ok" title="The bound automation has completed at least one successful run">
                        <Check s={12} /> Ran successfully
                      </span>
                    ) : (
                      <span className="text-xs text-muted" title={t.enableBlockedReason ?? undefined}>Not ready</span>
                    )}
                    <LiveSwitch live={t.state === "Live"} validated={ready} blockedReason={t.enableBlockedReason} name={t.name} onClick={() => flipLive(t)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </section>
        ))}
        </div>
      )}
      </Zone>
      </Page>

      {/* ⚠ Overlays sit OUTSIDE `<Page>`, and that is the rule rather than an
          exception: D-77 says nothing renders outside a zone, and a modal is not
          page content — it is a layer over the whole page. Putting one in a zone
          would give it the zone gap and make the zone's own spacing depend on
          whether a dialog happens to be open. */}
      <NewTriggerModal open={creating} initialKind={createKind} onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); toast.success(`Created "${name}"`); reload(); }} />
      <FireResultModal result={result} onClose={() => setResult(null)} />
      <TriggerDetailModal trigger={detail} onClose={() => setDetail(null)} />

      {/* Edit a trigger's name and description. */}
      {editing && <EditTriggerModal trigger={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast.success("Trigger updated"); reload(); }} />}

      <Confirm
        open={!!confirmDel}
        title="Delete trigger?"
        body={confirmDel ? `"${confirmDel.name}" will be removed. Automations that start from it will no longer run.` : ""}
        confirmLabel="Delete" danger
        onConfirm={() => confirmDel && remove(confirmDel)}
        onClose={() => setConfirmDel(null)}
      />
      {firing && (
        <FireTriggerDialog
          key={firing.id}
          trigger={firing}
          open
          onClose={() => setFiring(null)}
          onFired={(fired) => {
            setFiring(null);
            setResult({ name: firing.name, log: [`Fired — run started (fire ${fired.fireId}).`, "Open History to watch it step by step."] });
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Create a trigger: choose what starts it, name it, and fill in only what the
 * runtime actually reads.
 *
 * ⚠ **The catalogue is `lib/trigger-kinds.ts` and it mirrors the server**
 * (`issues.md` I-94). This modal used to offer seven kinds against a server that
 * accepts three: Email and File upload silently became webhooks, Kafka and
 * RabbitMQ became `poll` triggers with no url — which the scheduler skips with a
 * bare `continue`, so they never fired and logged nothing — and Scheduled job
 * and Cron were refused with a 409 that `save()` had no `catch` for.
 *
 * ⚠ **`save()` now catches**, and that is half the fix. A create that fails must
 * say so; the version without it left the modal open with no message, which
 * reads as a slow request rather than a refusal.
 */
function NewTriggerModal({ open, initialKind, onClose, onCreated }: { open: boolean; initialKind?: TriggerKind; onClose: () => void; onCreated: (name: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [idx, setIdx] = useState(0);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const k = CREATABLE[idx];

  // Reset each time it opens, honouring a pre-selected kind.
  useEffect(() => {
    if (!open) return;
    const i = initialKind ? Math.max(0, CREATABLE.findIndex((kk) => kk.type === initialKind)) : 0;
    setIdx(i); setName(""); setConfig({});
  }, [open, initialKind]);

  const pickKind = (i: number) => { setIdx(i); setConfig({}); };

  const save = async () => {
    const nm = name.trim() || k.label;
    setSaving(true);
    try {
      await createTrigger({
        name: nm,
        type: k.type,
        // ⚠ Keyed by what the RUNTIME reads (`config.url`, `config.intervalSeconds`),
        // never by the display label. The old version built the config out of the
        // card's rows, so the key depended on how the row happened to be titled.
        config: Object.fromEntries(k.config.map((c) => [c.key, config[c.key] ?? ""]).filter(([, v]) => v !== "")),
      });
      onCreated(nm);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the trigger.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create trigger">
      <div className="space-y-4">
        <Field label="What starts it?" hint={k.quote}>
          <Select value={idx} onChange={(e) => pickKind(Number(e.target.value))}>
            {CREATABLE.map((kk, i) => <option key={kk.type} value={i}>{kk.label}</option>)}
            {/* ⚠ The schedule OPTION, disabled here because this modal has no
                flow in hand. A schedule is not a trigger row — it lives on the
                flow's model and approving a revision deploys it (D-18) — so a
                global create would have nothing to attach to. The flow-scoped
                "Add trigger" on /flows/[id] offers the same option LIVE and
                opens the flow's Schedule pane instead. */}
            <option
              value={CREATABLE.length}
              disabled
              title="Schedules live on the flow, not the trigger list — set it on the automation's page."
            >
              {SCHEDULE_SPEC.label} — set on the flow
            </option>
          </Select>
        </Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${k.label}`} /></Field>

        {k.config.map((c) => (
          <Field key={c.key} label={c.label} hint={c.hint}>
            <Input value={config[c.key] ?? ""} onChange={(e) => setConfig((v) => ({ ...v, [c.key]: e.target.value }))} placeholder={c.placeholder} />
          </Field>
        ))}

        {k.type === "webhook" && (
          <p className="text-xs text-muted">
            Foundry generates the address when the trigger is created, and shows it on the card.
            There is nothing to type here.
          </p>
        )}

        {k.type === "api" && (
          <p className="text-xs text-muted">
            Foundry generates the token and address when the trigger is created, and shows them on
            the card exactly like a webhook&apos;s. There is nothing to type here.
          </p>
        )}

        {/* ⚠ What is NOT offered, and why — never a silent gap. A schedule used
            to live here; since Phase 6 it sits IN the picker above, disabled,
            because it is not a trigger row at all (D-18). What remains below is
            the connectors Foundry has no implementation for. */}
        <div className="space-y-2 border-t border-line pt-3">
          <div className="text-caption uppercase tracking-label text-dim">Not available here</div>
          {UNAVAILABLE.map((u) => (
            <p key={u.label} className="text-xs text-muted">
              <span className="font-medium text-text">{u.label}. </span>{u.reason}
            </p>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={save}>{saving ? "Creating…" : "Create"}</Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Edit a trigger's name, and the values it sends.
 *
 * ⚠ **The "Description" field is GONE, and it was a control that did nothing**
 * (`issues.md` I-93). It wrote `quote`, which `updateTrigger` has never sent to
 * the server and which the adapter DERIVES from the automation's name and the
 * trigger type on every load — so the box accepted a sentence, closed on a
 * "Trigger updated" toast, and reloaded showing the old text. Removing it beats
 * making it savable: `quote` is one sentence generated from two facts, and a
 * hand-written override of it is a second description that can go stale against
 * the automation it names.
 */
function EditTriggerModal({ trigger, onClose, onSaved }: { trigger: Trigger; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(trigger.name);
  const save = async () => { await updateTrigger(trigger.id, { name }); onSaved(); };
  return (
    <Modal open onClose={onClose} title="Edit trigger">
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>

        {/* Phase 7.4. The one place a person can change what this trigger sends
            — and the editor is the SAME component `/flows/[id]` uses, so the two
            screens cannot disagree about who supplies which input. It saves on
            its own button rather than on this modal's, because it writes through
            its own route. */}
        <div className="space-y-2 border-t border-line pt-4">
          <div className="text-caption uppercase tracking-label text-dim">Values it sends</div>
          <TriggerInputsEditor trigger={trigger} onSaved={onSaved} />
        </div>

        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save}>Save name</Button></div>
      </div>
    </Modal>
  );
}

/**
 * A plain-words explanation of how a trigger works.
 *
 * ⚠ It reads the trigger's TYPE, not a display row. The old version searched
 * `t.rows` for a label containing "mailbox" or "address" and interpolated
 * whatever it found — so the sentence described a mailbox nothing watched, on a
 * kind that could not exist (`issues.md` I-94).
 */
function howItWorks(t: Trigger): string {
  switch (t.icon) {
    case "manual":
      return "Someone starts this automation from Foundry. Nothing fires it on its own.";
    case "webhook":
      return "When another system posts to the address below, Foundry starts the automation's approved revision.";
    case "api":
      return "When another system POSTs to the address below, Foundry starts the automation's approved revision. The address carries the trigger's token — the same mechanism as a webhook, for programmatic callers.";
    case "poll":
      return "Foundry fetches the address below on a timer and starts the automation when what it returns changes.";
    case "schedule":
      return "This trigger predates Foundry refusing flow-bound schedules. A schedule now lives on the automation itself and is deployed by approving a revision.";
  }
  return "";
}

/** Show a trigger's full details: how it works, what it sends, and its fire history. */
function TriggerDetailModal({ trigger, onClose }: { trigger: Trigger | null; onClose: () => void }) {
  const started = trigger?.lastStarted && trigger.lastStarted !== "never";
  return (
    <Modal open={!!trigger} onClose={onClose} title={trigger?.name ?? ""}>
      {trigger && (
        <div className="space-y-4 text-sm">
          <div className="rounded-md bg-accent/10 px-3 py-2 text-accent">&ldquo;{trigger.quote}&rdquo;</div>

          <div>
            <div className="mb-1 text-caption uppercase tracking-label text-dim">How it works</div>
            <p>{howItWorks(trigger)}</p>
            {trigger.note && <p className="mt-1 text-xs text-muted">{trigger.note}</p>}
          </div>

          {trigger.rows.length > 0 && (
            <div>
              <div className="mb-1 text-caption uppercase tracking-label text-dim">Setup</div>
              <div className="space-y-1">
                {trigger.rows.map((r) => <div key={r.label} className="flex gap-2"><span className="text-muted">{r.label}</span><span className={r.mono ? "font-mono text-accent" : ""}>{r.value}</span></div>)}
              </div>
            </div>
          )}

          {/* ⚠ "Details read from each message" is GONE. It listed
              `adapterFields`, which the create form collected and `createTrigger`
              never sent anywhere — so the modal displayed a schema no server had
              and no runtime applied (`issues.md` I-94). What a trigger really
              sends is below. */}
          <TriggerInputs trigger={trigger} />
          {trigger.inputsWarning && <p className="text-xs text-warn">{trigger.inputsWarning}</p>}

          {/* The fire audit trail. Rendered inside the open modal — and only
              there — so the request is made when someone asks the question,
              rather than once per card on every page load. "Last started" above
              says a fire happened; this says whether anything RAN, which is a
              different fact and the one a silent automation turns on. */}
          <div className="border-t border-line pt-3">
            <TriggerFires triggerId={trigger.id} />
          </div>

          <div className="flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
            <span>{started ? `Last started ${trigger.lastStarted}` : "Not started yet"}</span>
            <StatusPill status={trigger.stateStatus}>{trigger.state}</StatusPill>
          </div>

          <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
        </div>
      )}
    </Modal>
  );
}

/**
 * What firing the trigger did.
 *
 * ⚠ **The two sentences claiming safety are GONE** (`issues.md` I-95). This
 * modal opened with a green banner and *"This was a safe test — no real data was
 * touched."* Firing a trigger starts the automation's **approved live revision**
 * against the real datasource, sends the real emails and writes the real rows —
 * the one thing on this page that is unambiguously production. A reassurance
 * printed over that is worse than no message at all.
 *
 * ⚠ The fabricated `payload` block went with them. It rendered a per-kind sample
 * the client invented for work that never happened.
 */
function FireResultModal({ result, onClose }: { result: TestResult | null; onClose: () => void }) {
  return (
    <Modal open={!!result} onClose={onClose} title={result ? `Fired: ${result.name}` : ""}>
      {result && (
        <div>
          <p className="text-sm text-muted">
            This started the automation&rsquo;s approved live revision, or was refused. What the
            server answered:
          </p>
          <ul className="mt-2 space-y-0.5 rounded-md border border-line bg-bg p-3 text-xs text-muted">{result.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <p className="mt-2 text-xs text-muted">
            A fire that started nothing still leaves a row in the trigger&rsquo;s history — open the
            trigger to see whether anything ran.
          </p>
          <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      )}
    </Modal>
  );
}

/** A small Live/Draft switch for a trigger card. Going live is disabled until the
    bound automation has completed one successful run (WS-H0.2, enforced by the
    server); pausing stays free. */
function LiveSwitch({ live, validated, blockedReason, name, onClick }: { live: boolean; validated: boolean; blockedReason?: string | null; name: string; onClick: () => void }) {
  const blocked = !live && !validated;
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span>{live ? "Live" : "Draft"}</span>
      <button
        role="switch"
        aria-checked={live}
        disabled={blocked}
        title={blocked ? (blockedReason ?? "The bound automation must complete one successful run first") : undefined}
        aria-label={`Set "${name}" ${live ? "to draft" : "live"}`}
        onClick={onClick}
        className={`h-5 w-9 rounded-full p-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${live ? "bg-ok" : "bg-surface-2"} ${blocked ? "cursor-not-allowed opacity-40" : ""}`}
      >
        <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${live ? "translate-x-4" : ""}`} />
      </button>
    </label>
  );
}
