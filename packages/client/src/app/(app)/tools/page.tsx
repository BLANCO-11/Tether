// src/app/(app)/tools/page.tsx — the workspace's callable catalogue.
//
// ── Table, per the old app's structure — with one column's history worth reading ──
//
// This used to be cards (2026-08-04 → 2026-08-05), because three of the old
// table's six columns carried no information: App is derived from the
// endpoint's host and every tool in a workspace shares one host; Used by was
// hardcoded "—" by `toolFromFA`; Status is `isActive`, which nothing in this UI
// exposes a control to flip.
//
// ⚠ **"Used by" was DELETED** (platform-coherence Phase 2.3, I-104) because it
// was a dash on every row in every workspace — a header promising information
// nobody was ever going to get. It came BACK in Phase 7 because the data is now
// real: the server computes `tool.usedBy` (distinct flows referencing the tool,
// from `flow_steps.manifest_refs_json`) and the column renders that number. A
// zero-count row shows "—", but that dash is a rendering of a genuine zero, not
// a placeholder — `ui-honesty-check.sh` pins the page to the real field and to
// the `> 0` guard, and `page.test.tsx` asserts the column by rendering.
//
// The other two stay because they carry a fact, however thin: App is a real
// (derived) grouping, and Status reflects stored `isActive` rather than a
// placeholder.
//
// What the cards added — the parameter chips, the "N tools have an undescribed
// parameter" nudge, and per-tool endpoint/credential info — is NOT dropped: it
// is what a row expands to show. A tool's parameter descriptions are what the
// flow drafter reads to decide whether the tool fits (I-40), and that stays on
// screen, just one click down instead of always-on.
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  listTools, createTool, updateTool, deleteTool, listSecrets, createSecret,
  listPromptBoundaryWarnings, probeTool,
} from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import type { Tool, ToolParam, DataType, ToolProbe, ToolProbeMode } from "@/lib/types";
import {
  defaultModeFor, isLiveProbeOffered, liveConfirmBody, markLine, preflightFindings, probeCopy,
  requestSummary, sampleParamsToSend,
} from "@/lib/tool-probe";
import { paramsToJsonSchema } from "@/lib/adapters";
import {
  AUTH_STYLES, HTTP_METHODS, authFindings, authStyleToStore, fingerprintFieldsOf,
  hasStoredValue, movedFingerprintFields, needsAuthParamName, secretNameOptions,
  suspensionWarning, typeForMethod,
  type AuthStyle, type HttpMethod,
} from "@/lib/tool-edit";
import { parseCurl, type CurlTool } from "@/lib/curl-parse";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Notice } from "@/components/ui/Notice";
import { DataTable, type DataRow } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { TypeTag, StatusPill } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Confirm } from "@/components/ui/Confirm";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Search, ChevronDown, ChevronRight, Plus, Trash, Wrench } from "@/components/ui/icons";
import { PromptBoundaryWarnings } from "@/components/PromptBoundaryWarnings";

// ⚠ `TYPES` WAS HERE — a three-value dropdown (`read-only`, `read-only send`,
// `changes data`) whose value was never sent anywhere. `toolInputToFA` turned it
// into a method (`"changes data" ? "POST" : "GET"`) and `toolFromFA` derives it
// back FROM the stored method, so two of its three values could not survive a
// reload and `read-only send` could not be produced by the adapter at all. The
// method is now asked for directly and the type is SHOWN, derived — see
// `typeForMethod`. Same rule as the deleted "Used by" column: a control carries
// a fact or it does not exist.
const DATA_TYPES: DataType[] = ["string", "integer", "float", "boolean", "array"];

export default function ToolsPage() {
  const { data: tools, loading, error, reload } = useAsync(listTools);
  /**
   * The prompt-boundary detector's findings for this workspace (guardrail port
   * V4). ⚠ **This page is the placement decision** CLAUDE.md recorded as
   * outstanding: the detector has been correct and unseen since the port,
   * because nothing in the client read the manifest at all. Every warning names
   * a tool, a datasource or a schema entity, and this is the page where the
   * person who can edit one already is.
   *
   * A SECOND `useAsync` rather than a field on the first: a failure to read the
   * manifest must not empty the tools table, and a failure to list tools must not
   * be reported as "no flagged content". Two questions, two answers, two errors.
   */
  const { data: promptWarnings, error: promptWarningsError } = useAsync(listPromptBoundaryWarnings);
  const toast = useToast();
  const [q, setQ] = useState("");
  const [auth, setAuth] = useState("all");
  const [form, setForm] = useState<Tool | "new" | null>(null); // "new" = create; Tool = edit
  // `/tools?new=1` — Resources' "Add tool" lands here with the form already open.
  // Read once from the location rather than through the router, so this page
  // keeps rendering where no router is mounted.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("new") === "1") setForm("new");
    } catch {
      /* no location to read */
    }
  }, []);
  const [confirmDel, setConfirmDel] = useState<Tool | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /**
   * A probe launched from a ROW (tool-probe P3 · T22) — one at a time, keyed by
   * tool id.
   *
   * ⚠ **One, not a map.** Two probes in flight would race to be the newest fact on
   * screen, and the loser would sit under a row it does not describe. A person
   * testing two tools does them one after the other; the state says so.
   *
   * ⚠ Not merged into the row data: `tools` is what the server said, and this is
   * what just happened. Keeping them separate is why a stale `lastProbe` and a
   * fresh result cannot be confused for each other.
   */
  const [rowProbe, setRowProbe] = useState<
    { toolId: string; busy: boolean; probe: ToolProbe | null; error: string | null } | null
  >(null);
  /**
   * ⚠ **One clock reading for the whole render.** Twelve rows each calling
   * `Date.now()` can straddle a minute boundary, and two rows probed in the same
   * second would then disagree about how long ago that was.
   */
  const now = Date.now();

  const list = (tools ?? []).filter((t) => {
    // Search covers the PARAMETERS too, names and descriptions both. "recipient"
    // and "which address does this go to" should both find `mail_send`, and the
    // second one is how somebody who does not know the catalogue would ask.
    const haystack = [
      t.name,
      t.description,
      ...(t.params ?? []).flatMap((p) => [p.name, p.description ?? ""]),
    ]
      .join(" ")
      .toLowerCase();
    const matchQ = haystack.includes(q.toLowerCase());
    const matchAuth =
      auth === "all" ||
      (auth === "apikey"
        ? t.authStyle === "header" || t.authStyle === "query"
        : auth === "oauth2"
          ? t.authStyle === "oauth2_client_credentials"
          : (t.authStyle ?? "none") === auth);
    return matchQ && matchAuth;
  });

  /** How many tools are missing parameter descriptions — the one number worth surfacing. */
  const undocumented = (tools ?? []).filter((t) =>
    (t.params ?? []).some((p) => !p.description?.trim()),
  ).length;

  const remove = async (t: Tool) => { await deleteTool(t.id); toast.success(`Removed "${t.name}"`); reload(); };
  const toggleExpanded = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * Probe a SAVED tool from its row.
   *
   * ⚠ **By `toolId`, not by a draft rebuilt from the row.** The question here is
   * "does the tool as stored work", which is a different question from the form's
   * "will what I have typed work" — and rebuilding a draft from a `Tool` would
   * quietly probe whatever the adapter happened to preserve.
   *
   * ⚠ **The mode is the default for the stored method**, so a `POST` tool gets a
   * reachability check and nothing on this page can fire a mutating call without
   * the form's confirmation. There is deliberately no live escalation in a row:
   * the confirmation names the sample parameters, and a row has none to name.
   *
   * ⚠ `reload()` on the way out so the marker line reflects the probe that just
   * happened — including when it FAILED, because a red marker is a fact.
   */
  const probeRow = async (t: Tool) => {
    setRowProbe({ toolId: t.id, busy: true, probe: null, error: null });
    try {
      const probe = await probeTool({ toolId: t.id, mode: defaultModeFor(t.method) });
      setRowProbe({ toolId: t.id, busy: false, probe, error: null });
    } catch (e) {
      // ⚠ An error, never a verdict — the same rule as the panel's.
      setRowProbe({
        toolId: t.id,
        busy: false,
        probe: null,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      reload();
    }
  };

  const rows: DataRow<"tool">[] = list.map((t) => toolRow(t, {
    open: expanded.has(t.id),
    onToggle: () => toggleExpanded(t.id),
    onEdit: () => setForm(t),
    onDelete: () => setConfirmDel(t),
    now,
    onProbe: () => void probeRow(t),
    probeState: rowProbe?.toolId === t.id ? rowProbe : null,
  }));

  return (
    <Page>
      <PageHeader
        eyebrow="Connect"
        title="Tools"
        purpose="Connect any API — auth styles, per-parameter descriptions, visible to the LLM."
        actions={[{ label: "Add tool", icon: <Plus s={15} />, onClick: () => setForm("new") }]}
      />

      <Zone name="notices">
        {/* ⚠ Advisory and above the table on purpose — it is about the rows
            below it, and a person editing a tool description is the one who can
            act on it. It renders NOTHING when nothing matched (an absence of
            findings is not a safety claim) and renders a stated failure when the
            check could not run at all. */}
        <PromptBoundaryWarnings warnings={promptWarnings ?? null} error={promptWarningsError} />

        {/* An honest nudge, and only when there is something to nudge about. A
            parameter with no description reaches the drafter as a bare name and a
            type — which is exactly the condition that produces an
            `insufficient_contract` refusal, or worse, a guess. */}
        {undocumented > 0 && !loading && !error && (
          <Notice
            tone="warn"
            title={`${undocumented} ${undocumented === 1 ? "tool has" : "tools have"} a parameter with no description`}
          >
            Foundry reads these when it designs a flow — an undescribed parameter is one it has to
            guess at. Expand a row below to see which.
          </Notice>
        )}
        {error && (
          <Notice
            tone="danger"
            title="Could not load tools"
            action={<Button variant="ghost" size="sm" onClick={reload}>Try again</Button>}
          >
            {error}
          </Notice>
        )}
      </Zone>

      {/* ⚠ Zone 3, and this page is why the rule exists. The search box and the
          filter select used to sit in the header's action slot beside the title,
          where a control reads as part of the page's identity rather than as
          something you operate. `PageHeader`'s action type cannot express an
          input at all now (D-93), so this is enforced rather than remembered.

          The app and type filters are GONE (the mock has one filter: auth).
          App was derived from the endpoint's host and every tool in a workspace
          mostly shared one host; type was derived from the method. Neither
          narrowed anything a person could not already see — auth is the one
          filter that answers a real question ("which of these sign in how?").
          The mock's "OAuth2 client credentials" option is offered here since
          Phase 7, when the server union gained the style (the filter mirrors
          `AUTH_STYLES`'s "API key" collapse: `header`/`query` are one option,
          and oauth2 is its own — a style whose token flow is nothing like
          presenting a stored value). */}
      <Zone name="controls" gap="tight">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-bg px-3 text-sm text-muted sm:w-72 sm:flex-none">
            <Search s={15} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search tools"
              className="w-full min-w-0 bg-transparent text-text outline-none placeholder:text-muted"
              placeholder="Search tools…"
            />
          </div>
          <FilterSelect
            label="Filter by auth"
            value={auth}
            onChange={setAuth}
            options={[
              ["all", "All auth styles"],
              ["bearer", "Bearer"],
              ["oauth2", "OAuth2 client credentials"],
              ["apikey", "API key"],
              ["basic", "Basic"],
              ["none", "None"],
            ]}
          />
        </div>
      </Zone>

      {!error && (
        <Zone name="content">
          <DataTable
            set="tool"
            caption="Tools this workspace can call"
            // ⚠ The frozen mock's six-column table (D-02), complete:
            // Name / Description / Auth / Parameters / Used by / Actions. App
            // and Type are gone — both were derived values that carried nothing
            // the row's own fields did not already say (see the controls
            // comment). "Used by" is back because the data is real (Phase 7,
            // I-104 landing): the server computes the count from
            // `flow_steps.manifest_refs_json`, so the column shows a number,
            // and the "—" on a zero-count row is a rendering of a genuine zero,
            // not the hardcoded dash that deleted the column the first time.
            heads={{
              identity: "Name",
              meaning: "Description",
              auth: "Auth",
              params: "Parameters",
              usedBy: "Used by",
              // The mock's header names the column, right-aligned — the set's
              // `actions` role is end-aligned, so DataTable puts the word where
              // the buttons sit.
              actions: "Actions",
            }}
            rows={rows}
            // Loading gets the footprint-stable skeleton (mock D-16) — the
            // shimmer bars occupy the same space as the rows coming, so the
            // page does not jump from a spinner line to a full table. Four
            // bars, matching the mock's `skel-row` × 4.
            empty={
              loading ? <Skeleton rows={4} />
              : (tools ?? []).length === 0 ? "No tools yet — add one to get started."
              : (
                // The mock's closure empty state (D-16): a query (or auth
                // filter) that matches nothing keeps the table chrome and says
                // why — icon + one line + the same Add tool action the header
                // carries, so the dead end is one click from a way out.
                <EmptyState
                  icon={<Wrench s={16} />}
                  title="No tools match your search."
                  action={
                    <Button variant="ghost" size="sm" onClick={() => setForm("new")}>
                      <Plus s={15} />Add tool
                    </Button>
                  }
                />
              )
            }
          />
        </Zone>
      )}

      {form && (
        <ToolFormModal
          tool={form === "new" ? null : form}
          onClose={() => setForm(null)}
          onSaved={(name) => { setForm(null); toast.success(form === "new" ? `Added "${name}"` : "Tool updated"); reload(); }}
        />
      )}

      <Confirm
        open={!!confirmDel}
        title="Delete tool?"
        body={confirmDel ? `"${confirmDel.name}" will be removed from the catalog. Automations using it will need another tool.` : ""}
        confirmLabel="Delete" danger
        onConfirm={() => confirmDel && remove(confirmDel)}
        onClose={() => setConfirmDel(null)}
      />
    </Page>
  );
}

/**
 * One table row, per the old app's six-column layout, plus an expandable
 * section carrying what the card view added: parameter chips (with an
 * undescribed one marked, not rendered identically to a described one — a
 * catalogue where the two look the same is a catalogue nobody documents),
 * the endpoint's method and path, and the credential's env-var NAME (never
 * its value — there is deliberately no endpoint that returns a secret).
 */
// ⚠ This was `ToolRow`, a component that drew its own six-column grid. It is
// now a row BUILDER: it returns cells keyed by the `tool` set's roles, so the
// column order and widths come from `DataTable` and this page cannot disagree
// with the next page that shows a tool. The expandable panel survives as the
// row's `detail`, which is full-width and outside the grid by construction.
/**
 * Tools Foundry registers and maintains itself.
 * email-send-tool T048
 *
 * ⚠ The server refuses `create`/`update`/`remove` on these names with a 409
 * (`tool.service.ts`'s `assertNotPlatformManaged`). This list exists so the UI does
 * not OFFER an action the API will refuse — a button that always errors is worse
 * than no button, because it reads as a broken page rather than a deliberate rule.
 *
 * Duplicated from the server's `services/platform-tool-names.ts` rather than
 * imported: the client shares no module with the server. The server is the control;
 * this is presentation, and if the two drift the API still refuses.
 */
const PLATFORM_MANAGED_TOOLS = ["foundry_email_send"];
const isPlatformManaged = (name: string) => PLATFORM_MANAGED_TOOLS.includes(name);

function toolRow(
  tool: Tool,
  {
    open,
    onToggle,
    onEdit,
    onDelete,
    now,
    onProbe,
    probeState,
  }: {
    open: boolean;
    onToggle: () => void;
    onEdit: () => void;
    onDelete: () => void;
    /** One clock reading for the whole render — see the page's own note. */
    now: number;
    onProbe: () => void;
    /** The probe launched from THIS row, or `null`. */
    probeState: { busy: boolean; probe: ToolProbe | null; error: string | null } | null;
  },
): DataRow<"tool"> {
  const platformManaged = isPlatformManaged(tool.name);
  const params = tool.params ?? [];
  const missing = params.filter((p) => !p.description?.trim()).length;
  // The path, not the whole URL — every tool in a workspace shares a host.
  let path = tool.endpoint ?? "";
  try {
    path = new URL(tool.endpoint ?? "").pathname;
  } catch {
    /* a malformed URL is shown as stored — hiding it would hide the fault */
  }

  return {
    key: tool.id,
    cells: {
      // ⚠ **ONE LINE, ALWAYS, however long the description is.** A tool's
      // description is prose written for the DRAFTER — it is a chunk of the
      // generation prompt, so the good ones are paragraphs. Rendered whole in a
      // grid cell it sets the row's height from its own length, which is what
      // makes the list unreadable and rows of very different heights look like
      // they overlap.
      //
      // Three things are needed for the truncation to actually bite, and the
      // reported symptom is what a missing one looks like:
      //   · `w-full` on the button — as a block-level flex container its width
      //     is auto, and an `inline-block` default would shrink-to-fit instead;
      //   · `min-w-0 flex-1` on the text column — a flex item's automatic
      //     minimum size is its MIN-CONTENT, and `truncate` sets
      //     `white-space: nowrap`, which makes min-content the whole string;
      //   · `overflow-hidden` on the same element, so the ellipsis has a box.
      // ⚠ Reasoned from the CSS, not confirmed in a browser (I-80). The half
      // that does not depend on any of it is `detail` below, which shows the
      // description in FULL when the row is open — so the text is reachable
      // whichever of these was actually wrong.
      identity: (
        <button
          onClick={onToggle}
          aria-expanded={open}
          title={tool.description || undefined}
          className="flex w-full min-w-0 items-center gap-2 overflow-hidden text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <span className="mt-0.5 shrink-0 text-dim">{open ? <ChevronDown s={14} /> : <ChevronRight s={14} />}</span>
          {/* Mono, per the mock's tool rows — a name a manifest references
              reads best in the same face the manifest uses. `text-body
              font-semibold` (13px/600), per the doc's role map: table names
              are body, never the sm (14px) reserved for pane titles, buttons
              and form labels; the mock's tool rows render the name at the
              table default with weight 600. */}
          <span className="min-w-0 flex-1 truncate font-mono text-body font-semibold text-text">{tool.name}</span>
          {/* ⚠ Says WHY the actions are missing. Without it the row simply has
              fewer buttons than its neighbours, which reads as a rendering bug
              rather than as a rule. */}
          {platformManaged && (
            <span
              className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
              title="Foundry registers and maintains this tool. Run `mail:register` to restore or refresh it."
            >
              Platform
            </span>
          )}
        </button>
      ),
      // The description, ONE truncated line. The mock's second column; the full
      // text lives in the expanded detail, where it is also the words the
      // drafter reads verbatim.
      meaning: (
        <span className="block truncate text-xs text-muted">
          {tool.description || <span className="text-dim">No description — the drafter has nothing to go on.</span>}
        </span>
      ),
      // The mock's auth badges, mapped from the styles this client supports.
      // `oauth2_client_credentials` renders the mock's "OAuth2 client
      // credentials" badge since Phase 7, when the server union gained it.
      auth: <AuthBadge style={tool.authStyle ?? "none"} />,
      // The parameter names as chips IN THE ROW (the mock's Parameters column).
      // An undescribed one is marked, not rendered identically to a described
      // one — a catalogue where the two look the same is a catalogue nobody
      // documents (the notices banner above counts them).
      params:
        params.length === 0 ? (
          <span className="text-xs text-dim">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {params.map((p) => (
              <span
                key={p.name}
                title={p.description?.trim() || "No description — Foundry has to guess what this means."}
                className={
                  "rounded border px-2 py-0.5 font-mono text-caption " +
                  (p.description?.trim()
                    ? "border-line bg-surface-2 text-muted"
                    : "border-warn-line bg-warn-bg text-warn")
                }
              >
                {p.name}
                {p.required && <span className="text-danger">*</span>}
              </span>
            ))}
          </span>
        ),
      // "Used by" — the count of distinct flows referencing this tool, computed
      // server-side from `flow_steps.manifest_refs_json` (Phase 7, I-104
      // landing). The "—" for a zero is a rendering of that genuine zero — a
      // real 0 is not a lie — not the constant dash that deleted this column
      // the first time; `ui-honesty-check.sh` pins the `> 0` guard.
      usedBy:
        tool.usedBy > 0 ? (
          <span className="text-body tabular-nums text-muted">{tool.usedBy}</span>
        ) : (
          <span className="text-body text-dim">—</span>
        ),
      actions: platformManaged ? (
        // ⚠ Not disabled buttons — absent ones. A disabled control invites a
        // hover-and-wonder; the text says which rule applies and what to run.
        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-dim">Managed by Foundry</span>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
          <Button variant="ghost" size="sm" onClick={onDelete} className="text-danger hover:bg-danger-bg">Remove</Button>
        </div>
      ),
    },
    // Undefined when collapsed — `DataTable` holds no expansion state, so the
    // page's `expanded` set stays the one place that decides.
    detail: open ? (
      <>
        {/* ⚠ The description IN FULL, and it is the first thing here. The row
            above shows one truncated line; this is where the rest of it lives,
            and without it a long description is a fact the page holds and never
            shows anybody. It is also the text Foundry sends to the drafter
            verbatim, so it is worth reading in full at least once. */}
        <div className="mb-3">
          <span className="mb-1 block text-micro uppercase tracking-label text-dim">
            What it does — the words the designer reads
          </span>
          {tool.description?.trim() ? (
            <p className="whitespace-pre-wrap text-xs text-muted">{tool.description}</p>
          ) : (
            <p className="text-xs text-warn">
              No description. Foundry has nothing to go on when deciding whether this tool fits a
              goal, so it will either be skipped or called wrongly.
            </p>
          )}
        </div>

        {params.length > 0 ? (
          <div>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="text-micro uppercase tracking-label text-dim">Takes</span>
              {missing > 0 && <span className="text-micro text-warn">{missing} undescribed</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {params.map((p) => (
                <span
                  key={p.name}
                  title={p.description?.trim() || "No description — Foundry has to guess what this means."}
                  className={
                    "rounded border px-2 py-0.5 font-mono text-caption " +
                    (p.description?.trim()
                      ? "border-line bg-surface-2 text-muted"
                      : "border-warn-line bg-warn-bg text-warn")
                  }
                >
                  {p.name}
                  {p.required && <span className="text-danger">*</span>}
                  <span className="ml-1 text-dim">{p.dataType}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-caption text-dim">No parameters.</p>
        )}

        {/* ── The tested marker, and a Test control ────────────────────────
          * `specs/20260818-123807-tool-probe` · P3 · T22
          *
          * ⚠ **NO MARKER ⇒ NOTHING IS RENDERED HERE.** Not "unknown", not a grey
          * pill, and never a table column. The marker is in-process by design
          * (P3 signed off with no schema), so it is genuinely absent after a
          * restart and absent on the other container — and a column of
          * mostly-absent health words is the deleted "Used by" mistake with a
          * tick on it. `page.test.tsx` asserts the absence with a control that
          * the line DOES appear when the field is present, because an absence
          * test alone passes over an empty set.
          *
          * ⚠ Every word of the line comes from `markLine` in
          * `lib/tool-probe.ts`, where it is asserted — including the
          * *"endpoint not invoked"* clause, which is what stops
          * *"tested · host reachable"* being read weeks later as "it works". */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
          <span className="text-caption text-dim">
            {tool.lastProbe ? markLine(tool.lastProbe, now) : null}
          </span>
          {/* ⚠ Absent for a platform-managed tool, matching the row's Edit and
              Remove controls — Foundry maintains those and a test from here
              answers a question about the probe rather than about the tool. */}
          {!platformManaged && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onProbe}
              disabled={probeState?.busy === true}
            >
              {probeState?.busy
                ? "Testing…"
                : defaultModeFor(tool.method) === "live"
                  ? "Test"
                  : "Check reachability"}
            </Button>
          )}
        </div>

        {/* The result of a probe launched from THIS row. Same rules as the
            panel's: the server's sentence verbatim, the un-sent-method caveat
            keyed off `invoked`, and an error rendered as an error. */}
        {probeState?.error && (
          <p className="text-xs text-danger" role="alert">{probeState.error}</p>
        )}
        {probeState?.probe && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={probeCopy(probeState.probe).tone}>
              {probeCopy(probeState.probe).title}
            </StatusPill>
            {!probeState.probe.invoked && (
              <span className="text-xs text-muted">the tool&rsquo;s own call was not made</span>
            )}
            <span className="text-caption text-dim">{probeCopy(probeState.probe).detail}</span>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2.5 text-caption text-dim">
          {tool.method && <span className="font-mono text-muted">{tool.method}</span>}
          <span className="min-w-0 truncate font-mono">{path || "—"}</span>
          <span className="ml-auto shrink-0">
            {tool.secretEnvName ? (
              <span className="font-mono text-muted">{tool.secretEnvName}</span>
            ) : (
              <span className="text-dim">no credential</span>
            )}
          </span>
        </div>
      </>
    ) : undefined,
  };
}

/**
 * The tool onboarding form (create or edit).
 *
 * ── WHAT THIS FORM COULD NOT DO UNTIL foundations Phase 1.2 (I-124) ──────────
 *
 * It collected name, description, app, a three-value type dropdown, an endpoint
 * and parameters — and **no tool created through it could authenticate**. The
 * server has supported seven methods, five auth styles, an auth parameter name
 * and a credential reference since WS-B.4; `applyAuth` implements all five
 * styles and the manifest renders `<auth style= name= env=/>`. The UI exposed
 * none of it.
 *
 * ⚠ The consequence compounded rather than merely limiting. `GET
 * …/secrets/audit` computes `missing` by walking DECLARATIONS, so a workspace
 * whose tools were all created here audited perfectly **clean** while every tool
 * signed in with nothing. The `/keys` banner that would have said so was fully
 * built and could never fire, and `applyAuth`'s deliberate **424** — chosen to be
 * distinguishable from the upstream's 401, which is the exact confusion the audit
 * exists for — only fires when a style IS declared. Every authenticated tool in
 * this repo was created by a seeder or a harness.
 *
 * ⚠ **And the trap in fixing it, which is the most load-bearing thing here.**
 * `refFingerprints()` hashes `{method, url, params, authStyle, authParamName,
 * secretEnvName}` for a tool, so adding a credential to an EXISTING tool moves
 * its fingerprint and the staleness sweep unarms every automation approved
 * against the old shape — on a later poll tick, invisibly, and not undone by
 * putting the old value back. Without the confirmation below this form would be a
 * new way to unarm a live automation by filling in a form. See
 * `lib/tool-edit.ts` for why it names no flow count.
 */
function ToolFormModal({ tool, onClose, onSaved }: {
  tool: Tool | null; onClose: () => void; onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(tool?.name ?? "");
  const [description, setDescription] = useState(tool?.description ?? "");
  const [method, setMethod] = useState<HttpMethod>(
    (HTTP_METHODS as readonly string[]).includes((tool?.method ?? "GET").toUpperCase())
      ? ((tool?.method ?? "GET").toUpperCase() as HttpMethod)
      : "GET",
  );
  const [endpoint, setEndpoint] = useState(tool?.endpoint ?? "");
  const [params, setParams] = useState<ToolParam[]>(tool?.params ?? []);
  const [authStyle, setAuthStyle] = useState<AuthStyle>(tool?.authStyle ?? "none");
  const [secretEnvName, setSecretEnvName] = useState(tool?.secretEnvName ?? "");
  const [authParamName, setAuthParamName] = useState(tool?.authParamName ?? "");
  // Phase 7 — the oauth2_client_credentials fields. Only rendered (and only
  // sent) when the style is oauth2; switching away nulls them in the payload,
  // so a stale value can never survive a save the way a hidden field would.
  const [tokenUrl, setTokenUrl] = useState(tool?.tokenUrl ?? "");
  const [clientIdSecretRef, setClientIdSecretRef] = useState(tool?.clientIdSecretRef ?? "");
  const [clientSecretSecretRef, setClientSecretSecretRef] = useState(tool?.clientSecretSecretRef ?? "");
  /** True once the person has chosen to type a name the workspace does not hold. */
  const [namingNewSecret, setNamingNewSecret] = useState(false);
  /** What a pasted curl command could not read. Cleared only by another paste. */
  const [unread, setUnread] = useState<string[]>([]);

  // The workspace's stored credential names. ⚠ This is what makes the field a
  // PICKER rather than a text box, and the difference is not convenience: a
  // typo'd env name is a tool that fails 424 naming a credential nobody ever
  // stored, and the whole point of referencing a secret by its env-var name is
  // that the manifest, the prompt and the row cannot disagree about it.
  const { data: secrets, error: secretsError } = useAsync(listSecrets);

  const setParam = (i: number, patch: Partial<ToolParam>) => setParams((p) => p.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const addParam = () => setParams((p) => [...p, { name: "", dataType: "string", required: false, description: "" }]);
  const removeParam = (i: number) => setParams((p) => p.filter((_, idx) => idx !== i));

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The probe's state — LOCAL TO THIS MODAL, and that is the point.
   *
   * ⚠ Testing must not save. `createTool`/`updateTool` are not on this path and
   * nothing here touches the row; closing the modal discards the result, which is
   * honest — a probe describes one moment, and a stale verdict on screen after an
   * edit would describe a configuration that no longer exists.
   */
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ToolProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  /** Set when the save is waiting on the unarm confirmation. */
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  /**
   * The sample values for a live probe (P2 · T16) — **keyed by parameter name,
   * and deliberately NOT part of `params` or of `payload`.**
   *
   * ⚠ These are the one thing on this form that must never be persisted. They are
   * a person's real ticket id, real recipient, real customer name, typed in to see
   * whether an endpoint answers; a `sample_value` column would turn a test into a
   * data-retention question, and the spec's no-schema sign-off would be walked
   * back by the migration that added it. `payload` is built from `params` alone,
   * and `tools/page.test.tsx` asserts that a save after filling these carries none
   * of them.
   *
   * ⚠ Held here rather than as a field on each `ToolParam` row for the same
   * reason: a `ToolParam` is what gets written.
   */
  const [sampleValues, setSampleValues] = useState<Record<string, string>>({});
  /** Set when a live probe of a mutating tool is waiting on its confirmation (T17). */
  const [confirmLive, setConfirmLive] = useState(false);

  // A tool IS an HTTP endpoint. Creating one without a URL used to silently make a
  // "dummy" tool whose response was a canned template — so the form let you leave
  // this blank and got something that could never do the job. The server refuses it
  // now; asking here means the message lands next to the field.
  const endpointValid = /^https?:\/\//i.test(endpoint.trim());

  // `createToolSchema.superRefine`'s cross-field rules, arriving beside the
  // field instead of as a 400 whose `path` nothing renders.
  const findings = authFindings({
    authStyle, secretEnvName, authParamName, tokenUrl, clientIdSecretRef, clientSecretSecretRef,
  });
  const findingFor = (
    field: "secretEnvName" | "authParamName" | "tokenUrl" | "clientIdSecretRef" | "clientSecretSecretRef",
  ) => findings.find((f) => f.field === field)?.message;

  // The oauth2 style reads its credentials from the two refs and has NO single
  // `secretEnvName` (the server refuses one for it); every other style reads
  // one credential and rejects the trio. So each side of the switch sends
  // explicit nulls for the other side's fields — the same "sent as null rather
  // than omitted" rule that lets auth be REMOVED from a tool at all.
  const isOauth2 = authStyle === "oauth2_client_credentials";

  const payload = {
    name: name || "New tool",
    description,
    // Derived, not chosen — see the note where `TYPES` used to be.
    type: typeForMethod(method),
    endpoint: endpoint.trim(),
    method,
    // `filters` was collected here and thrown away: `toolInputToFA` never sent
    // it and `toolFromFA` hardcoded `[]`, so the field typed a value, saved,
    // and showed nothing on reload. Removed rather than wired — there is no
    // server column for it, and search already matches name + description.
    params: params.filter((p) => p.name.trim()),
    secretEnvName: isOauth2 ? null : secretEnvName.trim() || null,
    // ⚠ NOT the dropdown's value verbatim. `null` and `"none"` are one thing to
    // `applyAuth` and two different hash inputs to `refFingerprints`, so writing
    // the word back would unarm every flow using a credential-less tool on a save
    // that changed nothing. See `authStyleToStore`.
    authStyle: authStyleToStore(authStyle, tool?.authStyle),
    authParamName: needsAuthParamName(authStyle) ? authParamName.trim() || null : null,
    tokenUrl: isOauth2 ? tokenUrl.trim() || null : null,
    clientIdSecretRef: isOauth2 ? clientIdSecretRef.trim() || null : null,
    clientSecretSecretRef: isOauth2 ? clientSecretSecretRef.trim() || null : null,
  };

  /**
   * Which of the six hashed fields this save moves, and therefore what it unarms.
   *
   * ⚠ Computed only when EDITING. On a create there is nothing approved against
   * the old shape, and a warning that fires when nothing happens is how a
   * warning stops being read.
   */
  const moved = useMemo(
    () =>
      tool
        ? movedFingerprintFields(
            fingerprintFieldsOf(tool, paramsToJsonSchema(tool.params) ?? null),
            fingerprintFieldsOf(
              { ...payload, method: payload.method, endpoint: payload.endpoint },
              paramsToJsonSchema(payload.params) ?? null,
            ),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, endpoint, method, secretEnvName, authStyle, authParamName, JSON.stringify(payload.params)],
  );
  const suspendWarning = suspensionWarning(moved);

  const write = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (tool) await updateTool(tool.id, payload);
      else await createTool(payload);
      onSaved(payload.name);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Ask BEFORE writing when an edit moves the fingerprint.
   *
   * The server would happily do it either way — the confirmation exists because
   * the consequence lands on a later sweep tick and is not undoable by putting
   * the old value back: the approval is closed by then. Same shape as
   * `NamedQueryPanel`'s, and for the same reason.
   */
  const save = () => {
    if (suspendWarning) setConfirmSuspend(true);
    else void write();
  };

  // ── The Test panel's own logic ───────────────────────────────────────────────
  //
  // ⚠ Every rule lives in `lib/tool-probe.ts`; this component chooses nothing.
  // The mode comes from `defaultModeFor`, the words from `probeCopy`, the
  // pre-dial findings from `preflightFindings`. `ui-honesty-check.sh` pins that
  // the page renders probe state only off the response object.

  /**
   * ⚠ The mode is derived from the method IN THE FORM, not from the saved tool.
   * Someone switching `GET` → `POST` in the form must see the button change to
   * "Check reachability" before they press it, or the label describes the row they
   * are editing away from.
   */
  const probeMode: ToolProbeMode = defaultModeFor(method);
  /**
   * ⚠ **Gated on the MODE, not on the tool alone.** `isLiveProbeOffered` answers
   * "may this tool be INVOKED from here", and the first version of this panel used
   * it to disable the button outright — which blocked `foundry_email_send`
   * entirely. That tool is a `POST`, so its default mode is `reachability`, and
   * the server explicitly ALLOWS reachability for a platform-managed tool
   * (`tool-probe.service.test.ts`: *"but REACHABILITY of a platform-managed tool
   * is allowed"*). The client was refusing what the server permits — the same
   * class of client/server disagreement the shared-copy rule exists to prevent,
   * and it would have read as a dead button with a misleading caption.
   */
  const liveOffered = isLiveProbeOffered(name.trim(), method);
  const modeRefused = probeMode === "live" && !liveOffered;
  /**
   * **The escalation (P2).** A mutating tool defaults to `reachability`, and the
   * live call is one confirmed press away — not a mode toggle that remembers what
   * it was last set to.
   *
   * ⚠ Two controls rather than a switch, because a control that carries a fact is
   * worth more than a control that carries a setting: the second button's LABEL is
   * the consequence (`Send a real POST`), so there is no state in which a person
   * presses "Test" and finds out afterwards which of the two it did. The plan's
   * rejected option — probing mutating tools live by default — is *"a Test button
   * that files a ticket on every press"*, and a sticky toggle is that button with
   * one extra step.
   *
   * ⚠ Absent, not disabled, for a platform-managed tool: the server answers 409
   * (`platform_managed_live_probe`) and the caption below says which rule applies.
   */
  const liveEscalationOffered = probeMode === "reachability" && liveOffered;

  /**
   * The sample values, typed (T16). `payload.params` is the same filtered list the
   * save uses, so a half-typed parameter row contributes no input.
   */
  const sample = sampleParamsToSend(payload.params, sampleValues);
  /**
   * ⚠ A malformed value BLOCKS the live press instead of being dropped. Sending
   * the call without what somebody typed and then reporting the endpoint's
   * complaint would be Foundry manufacturing a red verdict.
   */
  const sampleBlocked = sample.findings.some((f) => f.blocking);
  const setSampleValue = (name: string, value: string) =>
    setSampleValues((v) => ({ ...v, [name]: value }));

  const preflight = preflightFindings(
    {
      url: endpoint,
      authStyle,
      secretEnvName: isOauth2 ? null : secretEnvName,
      authParamName,
      tokenUrl: isOauth2 ? tokenUrl : null,
      clientIdSecretRef: isOauth2 ? clientIdSecretRef : null,
      clientSecretSecretRef: isOauth2 ? clientSecretSecretRef : null,
    },
    secrets ?? [],
  );

  const runProbe = async (mode: ToolProbeMode) => {
    setProbing(true);
    setProbeError(null);
    setProbe(null);
    try {
      /**
       * ⚠ **The DRAFT is probed, not the saved row** — even when editing. The
       * question a person is asking is "will what I have typed work", and probing
       * the stored row would answer a different one and answer it confidently.
       */
      setProbe(
        await probeTool({
          draft: {
            name: payload.name,
            url: payload.endpoint,
            method: payload.method,
            authStyle: payload.authStyle,
            authParamName: payload.authParamName,
            secretEnvName: payload.secretEnvName,
            tokenUrl: payload.tokenUrl,
            clientIdSecretRef: payload.clientIdSecretRef,
            clientSecretSecretRef: payload.clientSecretSecretRef,
          },
          mode,
          /**
           * ⚠ Sent ONLY on the live path, and only when something was typed. The
           * server drops them in reachability mode anyway
           * (`tool-probe.service.test.ts`: *"sends no parameters at all in
           * reachability mode"*) — not sending them is so that the request on the
           * wire matches what the panel said it would do.
           */
          ...(mode === "live" && Object.keys(sample.params).length > 0
            ? { sampleParams: sample.params }
            : {}),
        }),
      );
    } catch (e) {
      // ⚠ Rendered as an error, never as a verdict. `api.ts` deliberately has no
      // fallback probe object: Foundry could not ask, and saying "unreachable"
      // here would be Foundry making a statement about someone's endpoint.
      setProbeError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  /** Apply a parsed curl command over the draft. */
  const applyCurl = (parsed: CurlTool) => {
    if (parsed.url) setEndpoint(parsed.url);
    if (parsed.method) setMethod(parsed.method);
    if (parsed.params.length > 0) setParams(parsed.params);
    if (parsed.authStyle) setAuthStyle(parsed.authStyle);
    setAuthParamName(parsed.authParamName ?? "");
    // ⚠ The credential's NAME may be set from the paste; its VALUE never is. It
    // reaches the workspace secret store or nowhere — see `CurlPastePanel`.
    setUnread(parsed.unread);
  };

  return (
    <>
    <Modal open onClose={onClose} title={tool ? "Edit tool" : "Add tool"}>
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
        <Field label="Name" hint="A human name, e.g. “Create a ticket”.">
          <Input value={name} aria-label="Name" onChange={(e) => setName(e.target.value)} placeholder="Create a ticket" />
        </Field>
        <Field label="Description">
          <Input value={description} aria-label="Description" onChange={(e) => setDescription(e.target.value)} placeholder="Opens a new incident for someone" />
        </Field>

        {/* ── the credential ─────────────────────────────────────────────────
            The four fields I-124 is about. `authStyle` alone is inert: without
            `secretEnvName` there is nothing to present, which is why the two
            rules below are the server's own and are mirrored rather than
            re-invented. */}
        <div className="rounded-xl border border-line/60 bg-surface p-4 shadow-sm transition-colors duration-150">
          <div className="mb-2 text-[13px] font-medium text-text">How it signs in</div>
          <p className="mb-3 text-xs text-muted">
            Foundry stores the value once, under a name, and presents it the way you choose here.
            A tool that presents nothing gets whatever the endpoint gives an anonymous caller —
            usually a 401 in the middle of a run.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Style">
              <Select
                value={authStyle}
                aria-label="Auth style"
                onChange={(e) => setAuthStyle(e.target.value as AuthStyle)}
              >
                {AUTH_STYLES.map((s) => (
                  <option key={s} value={s}>{AUTH_STYLE_WORDS[s]}</option>
                ))}
              </Select>
            </Field>
            {/* ⚠ Only for `header` and `query`. `bearer` and `basic` put the
                credential in `Authorization` by definition, so a name field
                beside them is a box whose value is discarded. */}
            {needsAuthParamName(authStyle) && (
              <Field
                label={authStyle === "header" ? "Header name" : "Query parameter name"}
                hint={authStyle === "header" ? "e.g. X-API-Key" : "e.g. api_key"}
              >
                <Input
                  value={authParamName}
                  aria-label="Auth parameter name"
                  invalid={Boolean(findingFor("authParamName"))}
                  onChange={(e) => setAuthParamName(e.target.value)}
                  placeholder={authStyle === "header" ? "X-API-Key" : "api_key"}
                />
              </Field>
            )}
          </div>
          {findingFor("authParamName") && (
            <p className="mt-2 text-xs text-danger">{findingFor("authParamName")}</p>
          )}

          {authStyle === "oauth2_client_credentials" ? (
            <div className="mt-3">
              <span className="mb-1.5 block text-sm font-medium text-text">Client credentials</span>
              {/* Phase 7 — the oauth2 style has NO single credential name; it
                  reads a client id and a client secret, each under its own
                  env-var NAME, and exchanges them at a token endpoint. The
                  picker above belongs to the styles that present one stored
                  value, which is why it is not rendered here. */}
              <div className="space-y-3">
                <Field label="Token URL" hint="The OAuth2 token endpoint Foundry calls with the client credentials.">
                  <Input
                    value={tokenUrl}
                    aria-label="Token URL"
                    invalid={Boolean(findingFor("tokenUrl"))}
                    onChange={(e) => setTokenUrl(e.target.value)}
                    placeholder="https://auth.example.com/oauth2/token"
                    className="font-mono text-body"
                  />
                </Field>
                {findingFor("tokenUrl") && (
                  <p className="text-xs text-danger">{findingFor("tokenUrl")}</p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Field label="Client id secret ref">
                      <Input
                        value={clientIdSecretRef}
                        aria-label="Client id secret ref"
                        invalid={Boolean(findingFor("clientIdSecretRef"))}
                        onChange={(e) => setClientIdSecretRef(e.target.value)}
                        placeholder="CLIENT_ID_SECRET"
                        className="font-mono text-body"
                      />
                    </Field>
                    {findingFor("clientIdSecretRef") && (
                      <p className="mt-1.5 text-xs text-danger">{findingFor("clientIdSecretRef")}</p>
                    )}
                  </div>
                  <div>
                    <Field label="Client secret ref">
                      <Input
                        value={clientSecretSecretRef}
                        aria-label="Client secret ref"
                        invalid={Boolean(findingFor("clientSecretSecretRef"))}
                        onChange={(e) => setClientSecretSecretRef(e.target.value)}
                        placeholder="CLIENT_SECRET"
                        className="font-mono text-body"
                      />
                    </Field>
                    {findingFor("clientSecretSecretRef") && (
                      <p className="mt-1.5 text-xs text-danger">{findingFor("clientSecretSecretRef")}</p>
                    )}
                  </div>
                </div>
                <p className="text-caption text-dim">
                  The refs are workspace secret names — the same vocabulary as the Credentials page.
                  Tokens are fetched at run time and cached briefly.
                </p>
              </div>
            </div>
          ) : authStyle !== "none" ? (
            <div className="mt-3">
              <span className="mb-1.5 block text-sm font-medium text-text">Which credential</span>
              {/* ⚠ A PICKER first and a text box second, and the two modes are
                  switched by a BUTTON rather than by a sentinel option inside the
                  select. A sentinel needs a value no env-var name can ever be,
                  and every candidate for that is either a legal identifier
                  (`__new__` — so a workspace could hold a secret with that name
                  and the picker would stop being able to select it) or a
                  whitespace value a DOM implementation is free to normalise. A
                  button has neither problem. */}
              <div className="flex flex-wrap items-center gap-2">
                {namingNewSecret ? (
                  <Input
                    value={secretEnvName}
                    aria-label="Credential name"
                    invalid={Boolean(findingFor("secretEnvName"))}
                    onChange={(e) => setSecretEnvName(e.target.value)}
                    placeholder="TICKETING_API_KEY"
                    className="min-w-[12rem] flex-1"
                  />
                ) : (
                  <Select
                    value={secretEnvName}
                    aria-label="Credential name"
                    className="min-w-[12rem] flex-1"
                    onChange={(e) => setSecretEnvName(e.target.value)}
                  >
                    <option value="">(choose a credential)</option>
                    {secretNameOptions(secrets?.map((s) => s.name) ?? [], secretEnvName).map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </Select>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNamingNewSecret((v) => !v);
                    if (!namingNewSecret) setSecretEnvName("");
                  }}
                >
                  {namingNewSecret ? "Pick a stored one" : "Name a new one"}
                </Button>
              </div>
              {findingFor("secretEnvName") && (
                <p className="mt-1.5 text-xs text-danger">{findingFor("secretEnvName")}</p>
              )}
              {/* ⚠ Three states, not two. "It has no stored value" and "I could
                  not read the list" are different facts, and reporting the
                  second as the first would send someone to /keys to fix
                  something that is already fine. */}
              {secretsError ? (
                <p className="mt-1.5 text-xs text-warn">
                  Could not read this workspace&apos;s credential names ({secretsError}), so whether
                  a value is stored under this name is unknown. Nothing here is checked against the
                  store.
                </p>
              ) : secretEnvName.trim() && secrets && !hasStoredValue(secrets, secretEnvName) ? (
                <p className="mt-1.5 text-xs text-warn">
                  Nothing is stored under <code>{secretEnvName.trim()}</code> in this workspace yet.
                  The tool will save, and its first call will fail <strong>424</strong> — declared
                  but unstored, deliberately distinct from the endpoint&apos;s own 401.{" "}
                  <Link href="/keys" className="underline">Store the value on Keys &amp; passwords</Link>.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Method"
            hint="Decides whether a step's parameters go in the query string or the body."
          >
            <Select
              value={method}
              aria-label="HTTP method"
              onChange={(e) => setMethod(e.target.value as HttpMethod)}
            >
              {HTTP_METHODS.map((m) => <option key={m}>{m}</option>)}
            </Select>
          </Field>
          {/* Both of these are DERIVED and shown rather than asked for. `type`
              comes from the method and `app` from the endpoint's host — the two
              selects that used to sit here were fields whose value nothing sent
              and whose display contradicted what a reload showed. */}
          <div>
            <span className="mb-1.5 block text-[13px] font-medium text-text">What it is</span>
            <div className="flex h-[38px] items-center gap-2 rounded-md border border-dashed border-line/60 px-3">
              <TypeTag type={typeForMethod(method)} />
              <span className="min-w-0 truncate text-xs text-muted">{hostOf(endpoint) ?? "no host yet"}</span>
            </div>
            <span className="mt-1 block text-xs text-muted">
              Read from the method and the URL, so it cannot disagree with them.
            </span>
          </div>
        </div>
        <Field label="API endpoint" hint="The full URL Foundry calls. Must start with http:// or https://.">
          <Input value={endpoint} aria-label="API endpoint" onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.example.com/incidents" />
        </Field>

        {/* Import from curl — after the fields it fills, so a paste lands in
            fields the person has already seen. The mock's modal names it
            third; here it sits beside the endpoint, which is what it fills. */}
        <CurlPastePanel
          existingSecretNames={(secrets ?? []).map((s) => s.name)}
          onRead={applyCurl}
          onSecretName={(envName) => {
            setSecretEnvName(envName);
            setNamingNewSecret(false);
          }}
        />

        {/* Parameters editor.
            Each row is a small card rather than a wrapping flex line: the
            description is the widest field and the most important one, and it
            has nowhere to sit on a single row. */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-medium text-text">Parameters</span>
            <Button variant="ghost" size="sm" onClick={addParam} className="rounded-full border border-line/60"><Plus s={13} /> Add</Button>
          </div>
          <p className="mb-2 text-xs text-muted">
            Each parameter&apos;s description is what the draft agent sees when it decides how to
            call this tool — a parameter with only a name and a type has to be guessed at.
          </p>
          {params.length === 0 && (
            <p className="rounded-md border border-dashed border-line/60 px-3 py-4 text-center text-xs text-muted">
              No parameters yet. Add one for each field the endpoint accepts.
            </p>
          )}
          <div className="space-y-2">
            {params.map((p, i) => (
              <div key={i} className="rounded-md border border-line/60 bg-surface p-2.5 transition-colors duration-150">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={p.name}
                    onChange={(e) => setParam(i, { name: e.target.value })}
                    placeholder="parameter name"
                    className="min-w-[9rem] flex-1"
                  />
                  <Select value={p.dataType} onChange={(e) => setParam(i, { dataType: e.target.value as DataType })}>
                    {DATA_TYPES.map((d) => <option key={d}>{d}</option>)}
                  </Select>
                  <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
                    <input type="checkbox" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} /> required
                  </label>
                  <button
                    onClick={() => removeParam(i)}
                    aria-label={`Remove parameter ${p.name || i + 1}`}
                    className="rounded-md p-1 text-muted hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <Trash s={15} />
                  </button>
                </div>
                <Input
                  value={p.description ?? ""}
                  onChange={(e) => setParam(i, { description: e.target.value })}
                  placeholder="What it means, e.g. “One address, or an array of up to 50”"
                  className="mt-2 w-full text-xs"
                  aria-label={`Description for ${p.name || `parameter ${i + 1}`}`}
                />
              </div>
            ))}
          </div>
        </div>

        {endpoint.trim() !== "" && !endpointValid && (
          <p className="text-xs text-danger">
            Include the scheme — <code>https://api.example.com/incidents</code>, not a path on its
            own. This is the address Foundry will call.
          </p>
        )}

        {/* ⚠ What the paste could NOT read, by name, with the fields still
            required. A parser that filled these in with a guess would be
            `assembleConnectionString` emitting `s3://host:5432/bucket`. */}
        {unread.length > 0 && (
          <Notice
            tone="warn"
            title={`${unread.length} thing${unread.length === 1 ? "" : "s"} in that command could not be read`}
          >
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {unread.map((u, i) => <li key={i}>{u}</li>)}
            </ul>
            <p className="mt-2">
              Everything above was filled in from the paste; these were not. Fill them in below —
              nothing has been guessed at.
            </p>
          </Notice>
        )}

        {/* The consequence, before the write. Shown in the form as well as in the
            confirmation, because somebody who cancels the dialog should still be
            able to see why it appeared. */}
        {suspendWarning && (
          <Notice tone="warn" title={`This edit changes ${moved.join(", ")}`}>
            {suspendWarning}
          </Notice>
        )}

        {/* ── Test this tool ─────────────────────────────────────────────────
          * `specs/20260818-123807-tool-probe`. One bounded call, reported.
          *
          * ⚠ Every word rendered here comes from the SERVER's response or from
          * `lib/tool-probe.ts`. The page derives no verdict and no tone, and in
          * particular states no verdict word of its own — a `reachable` verdict
          * means the HOST answered a HEAD and the tool's own call was never made,
          * which is the false green this whole feature exists to avoid.
          *
          * ⚠ The continuation lines are `*`-prefixed deliberately:
          * `ui-honesty-check.sh` forbids a hardcoded verdict word in this file and
          * strips only comment lines it can recognise, so an unprefixed line
          * DISCUSSING the forbidden word fails the pin. Measured — this comment
          * failed it once. Reformatting the comment is the fix; widening the pin
          * would have been the I-62 mistake (a guard that cries wolf gets widened
          * until it permits the defect).
          *
          * ⚠ Testing does not save. `createTool`/`updateTool` are not on this
          * path. */}
        <div className="rounded-xl border border-line/60 bg-surface p-4 shadow-sm transition-colors duration-150">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[13px] font-medium text-text">Test this tool</p>
              <p className="mt-0.5 text-xs text-muted">
                {probeMode === "live"
                  ? "Calls the endpoint once, with the credential this tool declares. Nothing is saved."
                  : `Asks the host whether this path exists. Your ${method} will not be sent.`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* Blocked on the FORM's own `findings` as well as on the probe's preflight. The two are deliberately separate: `findings` are already rendered beside their fields, so the panel must block on them without re-printing them. `sampleBlocked` counts only when THIS button is the live one. In reachability mode nothing typed below is sent, so an unusable sample value cannot affect the call and must not disable the check. */}
              <Button
                variant="ghost"
                onClick={() => void runProbe(probeMode)}
                className="rounded-full border border-line/60"
                disabled={
                  probing ||
                  preflight.length > 0 ||
                  findings.length > 0 ||
                  modeRefused ||
                  (probeMode === "live" && sampleBlocked)
                }
              >
                {probing
                  ? "Testing…"
                  : probeMode === "live"
                    ? "Test this tool"
                    : "Check reachability"}
              </Button>

              {/* ⚠ The escalation, and the label IS the consequence. `danger`
                  because the press sends a real mutating request — the same
                  treatment as "Save and unarm", for the same reason. */}
              {liveEscalationOffered && (
                <Button
                  variant="danger"
                  onClick={() => setConfirmLive(true)}
                  className="rounded-full shadow-sm"
                  disabled={probing || preflight.length > 0 || findings.length > 0 || sampleBlocked}
                >
                  Send a real {method.toUpperCase()}
                </Button>
              )}
            </div>
          </div>

          {/* ⚠ A platform-managed tool is not testable live and the control says
              why rather than being silently disabled — a disabled button with no
              reason reads as a broken page. */}
          {!liveOffered && (
            <p className="mt-2 text-xs text-muted">
              {name.trim()} is managed by Foundry, so it is never INVOKED from here
              {modeRefused ? "." : " — this checks the host only."}
            </p>
          )}

          {/* ── Sample values (T16) ───────────────────────────────────
            * Generated from the declared parameters — there is no free-form JSON
            * box, because a body typed by hand is not the body a run would send:
            * a run builds it from these names and types, and testing a different
            * shape answers a different question.
            *
            * ⚠ Rendered whenever a LIVE probe is possible at all, including when
            * the default mode is reachability — the values have to be fillable
            * BEFORE the confirmed press, not after it.
            *
            * ⚠ Empty is allowed and sends no key. Some endpoints need nothing,
            * and `{"since":""}` is a different request from `{}`. */}
          {liveOffered && payload.params.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-xs font-medium">Sample values</p>
              <p className="mt-0.5 mb-2 text-xs text-muted">
                Used for this test only — nothing typed here is saved with the tool. Leave a
                field empty to send nothing for it.
                {probeMode === "reachability" &&
                  ` They are sent only by “Send a real ${method.toUpperCase()}”.`}
              </p>
              <div className="space-y-1.5">
                {payload.params.map((prm) => (
                  <div key={prm.name} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-[9rem] font-mono text-caption text-muted">
                      {prm.name}
                      {prm.required && <span className="text-danger">*</span>}
                      <span className="ml-1 text-dim">{prm.dataType}</span>
                    </span>
                    <Input
                      value={sampleValues[prm.name] ?? ""}
                      onChange={(e) => setSampleValue(prm.name, e.target.value)}
                      aria-label={`Sample value for ${prm.name}`}
                      placeholder={prm.dataType === "array" ? '["a","b"]' : prm.dataType}
                      className="min-w-[10rem] flex-1 text-body"
                    />
                  </div>
                ))}
              </div>
              {/* ⚠ Every finding says what will happen to the value, not just that
                  it is wrong. A blocking one names the fix; a required-and-empty
                  one says the endpoint will most likely refuse — which is a
                  legitimate thing to go and see. */}
              {sample.findings.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-warn">
                  {sample.findings.map((f) => <li key={f.name}>{f.message}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* What is worth saying before dialling — an unstored credential is the
              424 the server would answer, said one round trip earlier. */}
          {preflight.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-warn">
              {preflight.map((f, i) => <li key={i}>{f.message}</li>)}
            </ul>
          )}

          {/* ⚠ An error, NOT a verdict. Foundry could not ask; it is not a
              statement about the endpoint. */}
          {probeError && (
            <p className="mt-2 text-xs text-danger" role="alert">{probeError}</p>
          )}

          {probe && (
            <div className="mt-3 space-y-2 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={probeCopy(probe).tone}>{probeCopy(probe).title}</StatusPill>
                {/* ⚠ Stated wherever the result is, not only on the button: this is
                    the sentence that stops `reachable` being read as "it works". */}
                {!probe.invoked && (
                  <span className="text-xs text-muted">
                    the tool&rsquo;s own call was not made
                  </span>
                )}
              </div>

              {/* The server's sentence, verbatim. */}
              <p className="text-sm">{probeCopy(probe).detail}</p>
              {probeCopy(probe).remedy && (
                <p className="text-xs text-muted">{probeCopy(probe).remedy}</p>
              )}

              <p className="text-caption text-dim">{requestSummary(probe)}</p>
              <p className="break-all text-caption text-dim">{probe.request.urlShown}</p>

              {probe.body && (
                <>
                  <pre className="max-h-40 overflow-auto rounded-md bg-surface p-2 text-caption text-muted">
                    {probe.body.preview}
                  </pre>
                  {/* ⚠ Both flags are stated. `redacted: false` means the body was
                      not JSON, so key-name redaction could not apply — the reader
                      has to know that before pasting it anywhere. */}
                  <p className="text-caption text-dim">
                    {probe.body.redacted
                      ? "Credential-shaped values are redacted."
                      : "Not JSON — shown raw and shortened, with no redaction applied."}
                    {probe.body.truncated ? " Truncated." : ""}
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {saveError && <p className="text-sm text-danger">{saveError}</p>}

        {/* The mock's modal foot (D-02): how many automations use this tool,
            before the save buttons. On a create that is always zero; on an
            edit it is the REAL count from the server — the same number as the
            "Used by" column, which is what makes the caption honest. */}
        <div className="flex items-center justify-between gap-2 pt-2">
          <span className="text-xs text-dim">
            {tool && tool.usedBy > 0
              ? `Used by ${tool.usedBy} ${tool.usedBy === 1 ? "automation" : "automations"}`
              : "Used by 0 automations yet."}
          </span>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} className="rounded-full border border-line/60 bg-surface px-4 shadow-sm transition-colors duration-150">Cancel</Button>
            <Button onClick={save} disabled={!endpointValid || findings.length > 0 || saving} className="rounded-full bg-accent text-on-accent shadow-sm transition-colors duration-150 hover:opacity-90 disabled:opacity-40">
              {saving ? "Saving…" : tool ? "Save" : "Save tool"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>

    {/* ── the consequence, before it happens ─────────────────────────────────
        The `NamedQueryPanel` pattern, minus the flow list it cannot get: there
        is no `GET /tools/:id/impact`, and inferring the list from the flow list
        is what `datasourceQueryService.impact`'s own docblock calls "a
        confidently wrong list". Filed as I-132. */}
    <Confirm
      open={confirmSuspend}
      title="This will unarm live automations"
      body={suspendWarning ?? ""}
      danger
      confirmLabel="Save and unarm"
      onConfirm={() => void write()}
      onClose={() => setConfirmSuspend(false)}
    />

    {/* ── the live probe's confirmation (T17) ──────────────────────────
        Same shape as the unarm confirmation above, and for the same reason: the
        consequence lands somewhere this page cannot see — in somebody else's
        system, and not undoable by pressing Cancel afterwards.

        ⚠ The sentence is built by `liveConfirmBody`, not here: it names the
        method, the host and the parameter KEYS, and `tool-probe.test.ts` asserts
        it promises nothing about what the endpoint will do. Cancelling calls
        nothing — `Confirm` only invokes `onConfirm` from its own button. */}
    <Confirm
      open={confirmLive}
      title={`Send a real ${method.toUpperCase()} to this endpoint?`}
      body={liveConfirmBody({
        method,
        url: payload.endpoint,
        paramNames: Object.keys(sample.params),
      })}
      danger
      confirmLabel={`Send the ${method.toUpperCase()}`}
      onConfirm={() => void runProbe("live")}
      onClose={() => setConfirmLive(false)}
    />
    </>
  );
}

/** The six styles, in the words a person would use for them. */
const AUTH_STYLE_WORDS: Record<AuthStyle, string> = {
  none: "none — the endpoint is open",
  bearer: "bearer — Authorization: Bearer <value>",
  header: "a header — you name which",
  query: "a query parameter — you name which",
  basic: "basic — a user:password pair, encoded for you",
  oauth2_client_credentials: "OAuth2 client credentials — a token fetched for you",
};

/**
 * The mock's auth badge, mapped from the styles this client supports.
 *
 * ⚠ Two client styles collapse into the mock's "API key": `header` (a named
 * header, usually `X-API-Key`) and `query` (a named query parameter, usually
 * `api_key`). That is the mock's vocabulary (D-02) — the expanded row still
 * names the parameter, so the collapse loses nothing the row hides anyway.
 * `oauth2_client_credentials` renders the mock's "OAuth2 client credentials"
 * badge (Phase 7).
 *
 * The badge uses the mock's two vocabularies: `badge-dim` for the every-day
 * styles, `badge-alpha` for oauth2 — the alpha hue marks the style whose token
 * flow is the new one. The WORD is the carrier in both; the hue is decoration,
 * so the colour-blind rule holds (D-02).
 */
function AuthBadge({ style }: { style: string }) {
  const label =
    style === "bearer" ? "Bearer"
    : style === "header" || style === "query" ? "API key"
    : style === "basic" ? "Basic"
    : style === "oauth2_client_credentials" ? "OAuth2 client credentials"
    : "None";
  const alpha = style === "oauth2_client_credentials";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-caption ${
        alpha ? "border-alpha-line bg-alpha-bg text-alpha" : "border-line bg-surface-2 text-muted"
      }`}
    >
      {label}
    </span>
  );
}

// ⚠ There is NO sentinel constant here, and there deliberately is not one.
//
// The "Name a new one" affordance is a BUTTON toggling `namingNewSecret` — see the
// comment on the credential picker above, which argues why: any sentinel value is
// either a legal env-var identifier (so a workspace could hold a secret with that
// name and the picker would stop being able to select it) or a whitespace value a
// DOM implementation is free to normalise.
//
// ⚠ A `NAME_A_NEW_SECRET = "\0new"` constant briefly existed as an earlier attempt,
// and the NUL in it made the WHOLE FILE binary to grep — which silently defeated
// every `absent_code_in` assertion aimed at this file, because grep answers
// "binary file matches" with no line number and the helper filters unnumbered
// lines out. `tsc` and `vitest` do not care about NULs, so every other gate stayed
// green. `ui-honesty-check.sh` now runs `no_binary_sources` FIRST to catch that
// class. **Keep every literal in this file printable.** See `issues.md` I-136.

// ⚠ `secretNameOptions` and `hasStoredValue` live in `lib/tool-edit.ts`, not
// here. A Next page module may only export a fixed set of names, so exporting a
// helper from this file is a typecheck error in `.next/types` that reads as a
// mysterious "not assignable to type never". They are pure and they carry the
// picker's whole correctness argument, so they belong somewhere a test can reach
// them anyway.

/** The endpoint's host, for the derived "what it is" line. */
function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint.trim()).host || null;
  } catch {
    return null;
  }
}

/**
 * Paste a curl command; get a tool draft. foundations Phase 1.7, D-118.
 *
 * ⚠ **The credential's value never leaves this component except to
 * `POST …/secrets`.** It is held in local state, never put in `paramsSchema`
 * (which is rendered into the workspace manifest and fed verbatim to a model),
 * never echoed to the screen, and never sent to a Foundry route that would parse
 * it — which is why the parse is client-side at all. `packages/redact` exists
 * because a key sent as `?api_key=…` was written verbatim into 2000 rows of
 * `api_call_log`.
 *
 * The value is not displayed even masked. There is deliberately no endpoint that
 * returns a stored secret and no `?reveal=`; a form that prints the one it just
 * read from a clipboard is the same disclosure by a different route.
 */
function CurlPastePanel({ existingSecretNames, onRead, onSecretName }: {
  existingSecretNames: string[];
  onRead: (parsed: CurlTool) => void;
  /**
   * The NAME the form should reference — called when a paste suggests one and
   * again when it is actually stored. Deliberately not `onSecretStored`: the name
   * is offered before anything is stored, so the "nothing is stored under this
   * name yet" warning fires straight away rather than after the save.
   */
  onSecretName: (envName: string) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [credential, setCredential] = useState<CurlTool["credential"]>(null);
  const [envName, setEnvName] = useState("");
  const [storing, setStoring] = useState(false);

  const read = () => {
    const parsed = parseCurl(text);
    onRead(parsed);
    setCredential(parsed.credential);
    setEnvName(parsed.credential?.suggestedEnvName ?? "");
    if (parsed.credential) onSecretName(parsed.credential.suggestedEnvName);
  };

  const store = async () => {
    if (!credential) return;
    setStoring(true);
    try {
      await createSecret({ name: envName.trim(), value: credential.value });
      onSecretName(envName.trim());
      // Dropped from state the moment it is stored, so it is not sitting in a
      // component that a re-render could put on screen.
      setCredential(null);
      setText("");
      toast.success(`Stored ${envName.trim()}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStoring(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-dashed border-line px-3 py-2 text-left text-xs text-muted hover:border-accent hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Have a <code>curl</code> command for this endpoint? Paste it and Foundry fills in the URL,
        the method, the parameters and how it signs in.
      </button>
    );
  }

  const alreadyStored = existingSecretNames.includes(envName.trim());

  return (
    <div className="rounded-md border border-line bg-surface-2/40 p-3">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">Paste a curl command</span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Hide</Button>
      </div>
      <p className="mb-2 text-xs text-muted">
        Read in your browser and never sent anywhere. Any credential in it is lifted out and offered
        as a stored secret — it is never written into a parameter, because parameters are rendered
        into the workspace manifest.
      </p>
      <Textarea
        value={text}
        aria-label="curl command"
        onChange={(e) => setText(e.target.value)}
        rows={5}
        className="w-full text-xs"
        placeholder={`curl -X POST https://api.example.com/incidents \\\n  -H "Authorization: Bearer sk-…" \\\n  -d '{"title":"Laptop won'"'"'t boot","priority":2}'`}
      />
      <div className="mt-2 flex justify-end">
        <Button variant="subtle" size="sm" onClick={read} disabled={!text.trim()}>
          Read it
        </Button>
      </div>

      {credential && (
        <div className="mt-3 rounded-md border border-line bg-surface p-2.5">
          <p className="text-xs text-muted">
            A credential was found in {credential.foundIn}. Its value is held here and nowhere else —
            store it under a name and this tool will present it.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              value={envName}
              aria-label="Store the credential as"
              onChange={(e) => setEnvName(e.target.value)}
              className="min-w-[12rem] flex-1 font-mono text-body"
            />
            <Button variant="subtle" size="sm" onClick={store} disabled={storing || !envName.trim()}>
              {storing ? "Storing…" : "Store it"}
            </Button>
          </div>
          {alreadyStored && (
            <p className="mt-1.5 text-xs text-warn">
              This workspace already holds <code>{envName.trim()}</code>, and storing is a 409 rather
              than an overwrite — pick another name, or leave it and reference the one that is there.
              Replacing a value is done on Keys &amp; passwords, where what it breaks is shown first.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A filter styled like the PDF's chevron button, backed by a native select. */
function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <span className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className="h-9 appearance-none rounded-md border border-line bg-transparent pl-3 pr-8 text-sm text-muted hover:bg-surface-2 focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
        {options.map(([v, label]) => <option key={v} value={v} className="bg-surface text-text">{label}</option>)}
      </select>
      <ChevronDown s={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
    </span>
  );
}
