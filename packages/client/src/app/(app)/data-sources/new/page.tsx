// src/app/(app)/data-sources/new/page.tsx — Connect a data source, one page.
// pick a connector (from the backend marketplace) → fill the manifest's
// JSON-Schema form → test (hard gate) → connect. There is NO connector-specific
// code here: every field, label, and secret comes from the manifest's
// onboarding_schema.
//
// ── THE WIZARD RAIL IS GONE (D-21, D-13) ──────────────────────────────────
//
// This used to be a five-step journey ("Connector → Sign in → Details → Test →
// Done") with a horizontal step-chip row. Creation surfaces have no rail
// (D-13), so the frozen mock renders ONE page with numbered section eyebrows —
// "1 · Connector", "2 · Details", "3 · Test" — and a footer of Cancel +
// "Connect data source". The steps' machinery (step state, the poll that
// watched discovery on the "Done" screen) is gone with the rail; the connect
// flow itself is unchanged: registration + test + introspection all happen in
// `runTest`, and the footer's primary is gated on the test passing.
//
// ── ⚠ THERE IS NO LONGER A CHOICE ON THE CREDENTIAL, AND THAT IS THE FEATURE ──
//
// Step 2 (in the old wizard) offered "Enter them directly" beside "Fetch from
// a vault", the second with complete field sets for HashiCorp Vault, AWS
// Secrets Manager and Azure Key Vault. Nothing served it: `buildPayload`
// dropped the connector's secret fields and attached `_vault` /
// `_credential_source`, and no server route has ever read either key (measured
// — zero hits across `packages/server/src`). Picking it assembled a
// PASSWORD-LESS DSN, so the person got
// `400 could not verify that this credential is read-only` — true, and
// unreadable as anything but a bug in the gate.
//
// It is REFUSED rather than repaired (D-117, I-122), because it cannot pass the
// gates rather than because it costs three SDKs. `assertRegistrableTarget`
// (D-64) and `assertReadOnly` (D-40) connect at registration, from the
// registering process; a vault-sourced DSN is not known until execution, so a
// vault datasource would be stored **unverified** — the one unverified row in
// the system, on the path carrying the strongest control in the codebase.
//
// The choice is replaced by a panel that says all of that, per the rule
// `lib/connectors.ts`'s header states and MongoDB/S3/GCS were deleted for on
// 2026-08-04: **inert is worse than refused**, because a refusal names the
// reason in front of the person who chose it while inert surfaces weeks later
// as a broken flow. `scripts/ui-honesty-check.sh` holds the deletion in place,
// and `archive/GAPS.md` records it as DELIBERATE so it is not re-found as an
// omission.
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createConnection, listManifests, getConnection,
  testConnection, refreshConnectionSchema, replaceSqliteFile,
} from "@/lib/api";
import { isFileConnector, MAX_SQLITE_BYTES } from "@/lib/connectors";
import { useAsync } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import type { Connection, ConnectorManifest, TestResult } from "@/lib/types";
import {
  jsonSchemaToFields, buildPayload, requiredComplete, initialValues, checkFields,
} from "@/lib/manifest-form";
import { DEFAULT_SCHEMAS, parseSchemaList } from "@/lib/schema-allowlist";
import { ENV_NAME_RE } from "@/lib/secret-edit";
// ⚠ `/rules`, NEVER the package root. `@foundry/shared`'s index re-exports the
// egress module, which imports `node:dns/promises` — webpack cannot bundle it
// and `next build` dies, so the web image simply does not build. The `rules`
// module imports nothing at all, which is what makes the vocabulary safe to
// share rather than mirror. See `lib/secret-edit.ts`.
import {
  ACCESS_POLICIES, ACCESS_POLICY_COPY, type AccessPolicy,
  DATASOURCE_NAME_RE, suggestDatasourceName,
} from "@foundry/shared/rules";
// Shape normalisation, not a generation concern: a 4xx's `findings` arrives as
// objects from `FlowValidationError` and as strings from the drafter, and the
// datasource gates use the object shape. Reusing the one normaliser is
// deliberate — a second copy is how one of them silently stops matching
// (I-100).
import { normaliseFindings } from "@/lib/generation-findings";
import { Page, Zone } from "@/components/layout/Page";
import { PageHeader } from "@/components/layout/PageHeader";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { StatusPill } from "@/components/ui/Badge";
import { DynamicForm } from "@/components/ui/DynamicForm";
import { MockPanel } from "@/components/data/MockPanel";
import { Database } from "@/components/ui/icons";

/** The mock's numbered section eyebrow (view-data-sources-new, D-21): a small
 * numbered circle + the uppercase label. The page is one form, not a wizard,
 * so the numbers say where you are, not which step is next. */
function SectionEyebrow({ n, label, className = "" }: { n: string; label: string; className?: string }) {
  return (
    <div className={`mb-3 flex items-center gap-2 ${className}`}>
      <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full border border-line text-[10px] text-dim">{n}</span>
      <span className="text-xs uppercase tracking-label text-dim">{label}</span>
    </div>
  );
}

export default function NewDataSourcePage() {
  const router = useRouter();
  const toast = useToast();
  const { data: manifests } = useAsync(listManifests);
  const list = manifests ?? [];

  const [connectorId, setConnectorId] = useState<string>("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  // I-123. Both were accepted by `createDatasourceInputSchema` and sent by
  // nothing, so every datasource registered here read `public` only and
  // declared no credential name.
  const [schemasRaw, setSchemasRaw] = useState(DEFAULT_SCHEMAS.join(", "));
  const [secretEnvName, setSecretEnvName] = useState("");
  /**
   * ⚠ Defaults to the NARROWEST, and the default is the important half. Someone
   * who does not read this section gets read-only — which is what every data
   * source on every deployment was before this control existed.
   */
  const [accessPolicy, setAccessPolicy] = useState<AccessPolicy>("read");
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<TestResult | null>(null);
  // ⚠ Kept apart from `tested.message`. A gate refusal carries per-rule
  // findings — which privilege, in which schema, on how many relations — and
  // the message is only their sentence-joined summary. Rendering the summary
  // alone is the last hop where that detail can be lost (see
  // `FoundryApiError.findings`).
  const [refusal, setRefusal] = useState<{ message: string; findings: unknown } | null>(null);
  const [created, setCreated] = useState<Connection | null>(null);
  /** A FILE connector's database file (SQLite), and whether it changed since the row was created. */
  const [file, setFile] = useState<File | null>(null);
  const [fileDirty, setFileDirty] = useState(false);

  // Marketplace search — the search combobox was replaced by the mock's
  // connector card grid (D-02); selection now happens by clicking a card, so
  // there is nothing to filter here.
  const manifest = useMemo<ConnectorManifest | undefined>(() => list.find((m) => m.id === connectorId), [list, connectorId]);
  const authFields = useMemo(() => jsonSchemaToFields(manifest?.onboarding_schema.auth), [manifest]);
  const advancedFields = useMemo(() => jsonSchemaToFields(manifest?.onboarding_schema.advanced), [manifest]);
  const allFields = useMemo(() => [...authFields, ...advancedFields], [authFields, advancedFields]);
  const needsAuth = (manifest?.auth_type ?? "none") !== "none";
  const isFile = isFileConnector(manifest);
  /**
   * ⚠ Checked here as well as on the server, and the server is the authority.
   * This only saves a 50 MB upload that would be refused on arrival; the
   * header and integrity checks are the server's alone.
   */
  const fileProblem =
    !file ? null
    : file.size === 0 ? "The file is empty."
    : file.size > MAX_SQLITE_BYTES ? `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB — a SQLite data source may be at most 50 MB.`
    : null;

  // Selecting a connector seeds its field defaults and clears any prior test.
  const pickConnector = (id: string) => {
    const m = list.find((x) => x.id === id);
    setConnectorId(id);
    const af = jsonSchemaToFields(m?.onboarding_schema.auth);
    const adv = jsonSchemaToFields(m?.onboarding_schema.advanced);
    setValues(initialValues([...af, ...adv]));
    setTested(null); setRefusal(null); setShowAdvanced(false);
    // A file connector is read-only by construction; nothing else can be chosen for it.
    if (isFileConnector(m)) setAccessPolicy("read");
  };

  const setVal = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));

  const payload = useMemo(() => buildPayload(allFields, values), [allFields, values]);

  const schemas = useMemo(() => parseSchemaList(schemasRaw), [schemasRaw]);
  // Blank is legal (the field is optional); anything typed must be an env-var
  // identifier, because the server refuses one that is not and this field's
  // whole purpose is that manifest, prompt and row cannot disagree about the
  // name.
  const envNameInvalid = secretEnvName !== "" && !ENV_NAME_RE.test(secretEnvName);

  /**
   * ⚠ The datasource NAME rule, stated beside the box instead of discovered
   * from a 400. The regex is `@foundry/shared`'s, not a copy — the server
   * enforces the same constant, so this cannot drift into offering a name the
   * server refuses (or refusing one it would take).
   *
   * Blank is not "invalid": an empty box is an unstarted field, and `canAct`
   * already requires a non-empty name. Flagging it red before anybody types
   * would make the form look broken on arrival.
   */
  const nameInvalid = name.trim() !== "" && !DATASOURCE_NAME_RE.test(name.trim());
  const nameSuggestion = useMemo(() => suggestDatasourceName(name), [name]);

  // Validity of the Details section. The allowlist has to be sendable: `[]`
  // would silently become `["public"]` server-side, which is a different
  // answer from the one on screen.
  /**
   * ⚠ The connector schema's OWN bounds, now actually checked (V7).
   *
   * `jsonSchemaToFields` has carried `min`, `max` and `integer` from the
   * backend's JSON Schema since it was written, and nothing read them — so a
   * port field accepted `abc` and a `minimum: 1` field accepted `-5`, and the
   * refusal arrived from the server one action later in the server's words
   * rather than beside the box. This is UX, not a guardrail: every rule is the
   * server's, which is what makes it unable to drift from it.
   */
  const fieldProblems = useMemo(() => checkFields(allFields, values), [allFields, values]);

  // The allowlist has to be sendable: `[]` would silently become `["public"]`
  // server-side, which is a different answer from the one on screen.
  const detailsValid = isFile
    ? Boolean(file) && !fileProblem && !envNameInvalid
    : requiredComplete(allFields, values) &&
      fieldProblems.length === 0 &&
      schemas.ok &&
      !envNameInvalid;

  // The old wizard demanded a name on step 0 before anything else; the single
  // page keeps that gate on the two actions that create or test.
  const canAct = Boolean(connectorId) && name.trim().length > 0 && !nameInvalid && detailsValid;

  /**
   * Register the data source and report what the SERVER said about it.
   *
   * This used to call a `testConnector(connector_id, payload)` that reached
   * nothing at all: it slept 700 ms and returned
   * `{ ok: true, latency_ms: 24, message: "Connection looks reachable." }` — a
   * fixed pass with an invented latency, for a connection nobody had tried.
   * The wizard then gated "Finish" on it, so the one step whose entire job was
   * to prove reachability was the one step that could not fail.
   *
   * The server only tests a datasource that EXISTS, so testing honestly means
   * creating it first. `createConnection` registers it, then tests and
   * introspects server-side; the row comes back carrying the real outcome, and
   * `error_message` is the database's own complaint rather than our
   * paraphrase.
   *
   * Creating here rather than on "Connect data source" is why the footer
   * primary can be gated on the test: a failed test leaves a
   * registered-but-unreachable source, which is a real state the list renders
   * and the person can fix, not a silent dead end.
   *
   * ⚠ Registration can be REFUSED rather than merely fail, and the two read
   * differently on purpose. `assertRegistrableTarget` (D-64) refuses a DSN
   * pointed at Foundry's own state; `assertReadOnly` (D-40) refuses a
   * credential that can write — including in a schema this form just added,
   * which is why widening the allowlist re-runs it. Both attach `findings`,
   * and both mean *nothing was stored*: there is no row to fix afterwards, so
   * the findings are the entire next step and are rendered as themselves.
   */
  const runTest = async () => {
    if (!manifest) return;
    setTesting(true);
    setRefusal(null);
    try {
      const conn = created
        ? isFile && fileDirty && file
          ? await replaceSqliteFile(created.id, file)
          : await testAndReload(created.id)
        : await createConnection({
            name: name || manifest.display_name,
            description: description || undefined,
            connector_id: manifest.id,
            payload,
            secret_env_name: secretEnvName.trim() || undefined,
            accessPolicy,
            ...(isFile ? { file: file ?? undefined } : { schema_allowlist: schemas.schemas }),
          });
      setCreated(conn);
      setFileDirty(false);
      const ok = conn.status === "ready";
      setTested({
        ok,
        message: ok
          ? "Connected, and Foundry could read the schema."
          : conn.error_message ?? "Registered, but the connection could not be made.",
      });
      ok ? toast.success("Connection works") : toast.error("Couldn't connect — check the details.");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A gate refusal carries per-rule `findings`; read them through a guard
      // rather than an unchecked cast, so a shape change fails loudly instead
      // of quietly dropping the only part of a refusal that names the fix.
      const findings =
        e && typeof e === "object" && "findings" in e ? e.findings : undefined;
      setTested({ ok: false, message });
      setRefusal({ message, findings });
      toast.error("Couldn't register the source.");
    } finally {
      setTesting(false);
    }
  };

  /** Re-test an already-registered source, for a second attempt. */
  const testAndReload = async (id: string): Promise<Connection> => {
    await testConnection(id).catch(() => null);
    await refreshConnectionSchema(id).catch(() => null);
    const reloaded = await getConnection(id);
    // A 404 mid-retry is real (removed from another surface); report it as the
    // reason instead of asserting a row exists.
    if (!reloaded) throw new Error("The source disappeared while re-testing.");
    return reloaded;
  };

  // The mock's footer primary. The source is already registered and tested by
  // `runTest` (which is what gates this button) — nothing left to do but leave
  // with the result reported, exactly what the old wizard's "Done" step did.
  const connect = () => {
    toast.success(`${name || manifest?.display_name} added`);
    router.push("/resources?type=datasource");
  };

  return (
    // `form` (680): the frozen mock froze this page at the form measure with
    // numbered section eyebrows — the wizard rail is gone (D-21, D-13).
    <Page measure="form">
      <PageHeader
        title="Connect a data source"
        purpose="Connector, details, test — one page, no wizard rail."
      />

      <Zone name="content">
        {/* ── 1 · Connector ──────────────────────────────────────────────── */}
        <SectionEyebrow n="1" label="Connector" />
        {list.length === 0 ? (
          <p className="text-sm text-muted">Loading connectors…</p>
        ) : (
          <>
            {/* The frozen mock's connector cards (D-02). Clicking a card is the
                SAME selection the search combobox drove — it seeds the manifest
                fields and clears any prior test. */}
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
              {list.map((m) => {
                const selected = connectorId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => pickConnector(m.id)}
                    aria-pressed={selected}
                    className={
                      "flex flex-col items-start gap-3 rounded-xl border p-5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
                      (selected
                        ? "border-accent bg-accent-bg"
                        : "border-line bg-surface hover:border-accent-line hover:bg-surface-2")
                    }
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-accent-bg text-accent">
                      {m.icon ?? <Database s={18} />}
                    </span>
                    <span className="text-sm font-semibold text-text">{m.display_name}</span>
                    {m.description && <span className="text-xs text-muted">{m.description}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* ── 2 · Details ────────────────────────────────────────────────── */}
        <SectionEyebrow n="2" label="Details" className="mt-6" />
        <div className="rounded-lg border border-line bg-surface p-5">
          <div className="space-y-4">
            {/**
             * ⚠ The hint used to say "A friendly name your team will recognise"
             * and the server requires a plain identifier. So the field invited
             * `ML-ZERO-DB`, the server refused it with a 400, and this page
             * rendered that as "Couldn't connect" — a message about the network,
             * for a name. The rule is real (a step ref is
             * `<datasource>.<query>`); what was missing was anybody saying so
             * before the submit.
             */}
            <Field
              label="Name"
              hint="Letters, numbers and underscores — it becomes part of every step reference."
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. hr_database"
                invalid={nameInvalid}
              />
            </Field>
            {nameInvalid && (
              <p className="-mt-2 text-caption text-danger">
                A name can only use letters, numbers and underscores, and cannot start with a number.
                {nameSuggestion && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-text"
                      onClick={() => setName(nameSuggestion)}
                    >
                      Use {nameSuggestion}
                    </button>
                  </>
                )}
              </p>
            )}
            <Field label="Description" hint="Optional — a note about what lives here.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
            </Field>

            {/* The connector's own fields (host / database / user / password /
                whatever the manifest's onboarding_schema declares), laid out by
                the manifest — half fields pair into the mock's 2-column grid. */}
            {manifest && !isFile && <DynamicForm fields={authFields} values={values} set={setVal} />}
            {manifest && isFile && (
              <Field
                label="Database file"
                hint="A SQLite database — .db, .sqlite or .sqlite3 — up to 50 MB. It is checked with SQLite's own integrity check before anything is stored."
              >
                <input
                  type="file"
                  accept=".db,.sqlite,.sqlite3,.db3,application/vnd.sqlite3,application/x-sqlite3"
                  aria-label="Database file"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setFileDirty(true);
                    setTested(null); setRefusal(null);
                  }}
                  className="block w-full text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-text hover:file:bg-surface"
                />
              </Field>
            )}
            {isFile && file && !fileProblem && (
              <p className="-mt-2 text-caption text-muted">
                <span className="font-mono text-text">{file.name}</span> · {(file.size / 1024 / 1024).toFixed(2)} MB
              </p>
            )}
            {isFile && fileProblem && <p className="-mt-2 text-caption text-danger">{fileProblem}</p>}

            {/* ── The two fields the browser could not send until now (I-123) ──
                Both are real server inputs, not preferences: `schemaAllowlist`
                is what `refreshSchema` introspects AND an argument to the
                read-only gate, and `secretEnvName` is the identifier the
                manifest renders and `/keys` audits. */}
            <div className="space-y-5 border-t border-line pt-5">
              {isFile ? (
                <p className="text-xs text-muted">
                  A SQLite database has one schema, <code>main</code>. Every table and view in the file is read.
                </p>
              ) : (<>
              <Field
                label="Schemas to read"
                hint="Separate with commas. Foundry introspects only these, so a table in a schema that is not listed is invisible to every automation."
              >
                <Input
                  value={schemasRaw}
                  onChange={(e) => { setSchemasRaw(e.target.value); setTested(null); setRefusal(null); }}
                  placeholder={DEFAULT_SCHEMAS.join(", ")}
                  invalid={!schemas.ok}
                  aria-label="Schemas to read"
                />
              </Field>
              {schemas.schemas.length > 0 && (
                <div className="-mt-3 flex flex-wrap gap-2">
                  {schemas.schemas.map((s) => (
                    <span key={s} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-xs text-text">{s}</span>
                  ))}
                </div>
              )}
              {schemas.rejected.map((r) => (
                <p key={r.token} className="-mt-3 text-xs text-danger">
                  <span className="font-mono">{r.token}</span> — {r.why}
                </p>
              ))}
              {schemas.schemas.length === 0 && (
                <p className="-mt-3 text-xs text-danger">Name at least one schema — {DEFAULT_SCHEMAS.join(", ")} is the usual answer.</p>
              )}
              {/* ⚠ Stated because it is a refusal a person will meet on the next
                  action and would otherwise read as the form being broken. The
                  credential can be read-only in `public` and an owner in the
                  schema just added, and the gate re-runs over the whole list. */}
              <p className="-mt-2 text-xs text-muted">
                Every schema listed is checked for write access before anything is stored. Adding one can be refused
                on its own — the account may be read-only in <code>public</code> and an owner elsewhere.
              </p>
              </>)}

              {/* ── ⚠ WHAT THIS DATA SOURCE MAY DO ────────────────────────────
                  Until 2026-09-17 there was no choice here: a credential that
                  could write was REFUSED outright, which meant a tenant whose
                  only login is an administrator could not onboard at all.

                  ⚠ **This control is real, not a declaration.** A read-only
                  data source runs every statement inside `BEGIN READ ONLY`, and
                  Postgres refuses the write itself — measured against a
                  SUPERUSER, which is refused on INSERT, UPDATE, DELETE and DDL
                  while SELECT still works. So the copy below can say "even if
                  the credential is an administrator" and mean it. */}
              <Field
                label="What may automations do with this data source?"
                hint="Enforced by the database on every statement, not by a setting automations could talk their way past."
              >
                <div className="flex flex-col gap-2">
                  {ACCESS_POLICIES.filter((p) => !isFile || p === "read").map((p) => (
                    <label key={p} className="flex cursor-pointer items-start gap-2 rounded-md border border-line p-2.5 has-[:checked]:border-accent">
                      <input
                        type="radio"
                        name="accessPolicy"
                        className="mt-0.5"
                        checked={accessPolicy === p}
                        onChange={() => { setAccessPolicy(p); setTested(null); setRefusal(null); }}
                        aria-label={ACCESS_POLICY_COPY[p].title}
                      />
                      <span className="flex flex-col">
                        <span className="text-sm text-text">{ACCESS_POLICY_COPY[p].title}</span>
                        <span className="text-xs text-muted">{ACCESS_POLICY_COPY[p].detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>

              {isFile && (
                <p className="-mt-3 text-xs text-muted">
                  Read-only is the only choice for an uploaded file: Foundry keeps a snapshot, so a write would land
                  in a temporary copy and be lost. SQLite itself refuses the write — the file is always opened read-only.
                </p>
              )}
              <Field
                label="Credential name (optional)"
                hint="An env-var-style name for this connection, e.g. HR_DB_DSN. It is the name automations see in the workspace manifest and the name the Keys page audits — without one, this data source is invisible to that audit."
              >
                <Input
                  value={secretEnvName}
                  onChange={(e) => { setSecretEnvName(e.target.value); setTested(null); setRefusal(null); }}
                  placeholder="HR_DB_DSN"
                  invalid={envNameInvalid}
                  aria-label="Credential name"
                />
              </Field>
              {envNameInvalid && (
                <p className="-mt-3 text-xs text-danger">
                  Letters, digits and underscores only, not starting with a digit — the server refuses anything else,
                  because this name has to be usable as an environment variable.
                </p>
              )}
            </div>

            {advancedFields.length > 0 && (
              <div>
                <button onClick={() => setShowAdvanced((s) => !s)} className="text-sm text-accent hover:underline">
                  {showAdvanced ? "Hide" : "Show"} advanced options
                </button>
                {showAdvanced && <div className="mt-3"><DynamicForm fields={advancedFields} values={values} set={setVal} /></div>}
              </div>
            )}

            {/* ── What happens to the credential ─────────────────────────────
                The old "Sign in" step's content, folded into Details now that
                there is no step for it: the two registration gates are named
                before either can refuse them. Rendered only once a connector
                is picked — before that there is no credential to talk about. */}
            {manifest && isFile ? (
              <p className="rounded-md border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
                The file is this data source&apos;s credential. Foundry encrypts it at rest with the same key as every
                sign-in, never lets anyone download it again — including you — and reads it only through a
                read-only handle. To change the data, upload a new file.
              </p>
            ) : manifest && (needsAuth ? (
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  You type {manifest?.display_name ?? "the database"}&apos;s sign-in once. Foundry encrypts it at rest,
                  never shows it again — including to you — and checks it before storing anything.
                </p>
                <div className="rounded-lg border border-line bg-surface-2 p-4">
                  <div className="text-sm font-medium">Checked at registration, not later</div>
                  <ul className="mt-2 space-y-2 text-sm text-muted">
                    <li>
                      Foundry asks the database <em>who it is</em> and refuses a connection pointed at its own
                      state — a read-only credential on Foundry&apos;s database is exactly the one that would read
                      every workspace&apos;s secrets.
                    </li>
                    <li>
                      Then it reads the credential&apos;s privileges and refuses one that can write, in any schema
                      named above. If the database cannot be reached, it refuses rather than storing and checking
                      later.
                    </li>
                  </ul>
                </div>
                {/* ⚠ THE REFUSAL PANEL — this is where "Fetch from a vault" was.
                    It is an explanation, not an error: nothing has gone wrong
                    and nothing is owed, which is exactly `info` rather than
                    `warn` (see `Notice`'s tone docblock). It states the
                    mechanism, not a roadmap — "coming soon" beside a control
                    that cannot work is the same promise the deleted vault mode
                    was making. */}
                <Notice tone="info" title="Fetching the secret from a vault is not offered, deliberately">
                  <p>
                    HashiCorp Vault, AWS Secrets Manager and Azure Key Vault were pickable here and were wired to
                    nothing: the reference was assembled, sent, and read by no part of the server, so the
                    connection string arrived without a password and registration failed with a message about
                    the read-only check. That was worse than not offering it.
                  </p>
                  <p className="mt-2">
                    It is not offered because of <em>when</em> the checks above have to run. Both of them open the
                    connection at registration, from this process. A vault-sourced connection string is not known
                    until a flow runs, so a vault data source could only be stored unverified — the one row in the
                    product that nothing had checked, on the path that carries its strongest control.
                  </p>
                  <p className="mt-2">
                    Type the credential here instead. Use a database account with <code>SELECT</code> and nothing
                    else; rotate it by changing the sign-in on the data source, which re-runs both checks.
                  </p>
                </Notice>
              </div>
            ) : (
              <p className="rounded-md border border-line bg-surface-2 px-4 py-3 text-sm text-muted">This connector needs no sign-in.</p>
            ))}

            {/* The mock's write-only DSN note (view-data-sources-new, D-21). */}
            <p className="text-caption text-dim">
              Stored encrypted (AES-256-GCM) in this workspace&apos;s credentials — a write-only DSN, never a live
              connection string in the UI.
            </p>
          </div>
        </div>

        {/* ── 3 · Test ───────────────────────────────────────────────────── */}
        <SectionEyebrow n="3" label="Test" className="mt-6" />
        <div className="rounded-lg border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={runTest} disabled={testing || !canAct}>
              {testing ? "Connecting…" : created && !tested?.ok ? "Try again" : "Test connection"}
            </Button>
            {tested && (
              tested.ok ? (
                <StatusPill status="ok">{tested.message}</StatusPill>
              ) : (
                <StatusPill status="danger">Couldn&apos;t add this data source</StatusPill>
              )
            )}
            {/* ⚠ The caption describes what a SUCCESSFUL probe did, so it renders
                only before a verdict and on success. Beside a red pill it read as
                part of the failure — "couldn't connect" and "schema introspected"
                in one sentence — and was reported as the error itself. */}
            {(!tested || tested.ok) && (
              <span className="text-caption text-dim">Read-only probe — the schema is read, nothing is written.</span>
            )}
          </div>
          {tested && !tested.ok && (
            <div className="mt-4 space-y-3">
              {/**
               * ⚠ **WHAT THE SERVER ACTUALLY SAID, and until 2026-09-17 nothing
               * rendered it.** `runTest`'s catch has always captured the message
               * — `setTested({ ok: false, message })` — and the only place it
               * could surface was the findings list below, which renders **only
               * when `findings` is present**. A gate refusal carries findings; a
               * VALIDATION refusal does not. So the entire class of "the server
               * refused your input and said why" displayed as the literal words
               * "Couldn't connect" and nothing else.
               *
               * That is how a datasource named `ml-zero` — refused because the
               * name must be a plain identifier, a rule with a real reason and a
               * one-word fix — presented as a database that could not be
               * reached, sending the reader to check firewalls and credentials.
               *
               * ⚠ It renders the message **verbatim**. Paraphrasing it here
               * would put a second author on the server's own diagnosis, and the
               * paraphrase is what drifts. The findings list below is still the
               * richer surface when there are findings; this is the floor, so
               * that a refusal can never again arrive with nothing to read.
               */}
              {refusal?.message && (
                <div className="rounded-lg border border-line bg-surface p-4">
                  <div className="text-sm font-medium text-text">What the server said</div>
                  <p className="mt-1 text-sm text-muted">{refusal.message}</p>
                </div>
              )}
              {/* ⚠ The findings, as themselves. Each one names the rule that
                  fired and what it saw — `assertReadOnly` reports the privilege
                  and the schema, `assertRegistrableTarget` reports how many of
                  Foundry's own tables it recognised. `message` is only their
                  summary, and a refusal whose detail is summarised sends the
                  reader to the wrong fix. A refusal also means NOTHING was
                  stored, so this list is the whole next step. */}
              {refusal && normaliseFindings(refusal.findings).length > 0 && (
                <div className="rounded-lg border border-danger-line bg-danger-bg p-4">
                  <div className="text-sm font-medium text-danger">Nothing was stored. What the check found:</div>
                  <ul className="mt-2 space-y-2 text-sm text-muted">
                    {normaliseFindings(refusal.findings).map((f, i) => (
                      <li key={i}>
                        {f.rule && <span className="mr-2 font-mono text-xs text-text">{f.rule}</span>}
                        {f.message}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-muted">
                    Change the credential or the schemas it is checked against, then test again. Re-testing sends
                    the same values, so it will be refused the same way.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
        {/* Mock readiness for the source just registered — the build starts at
            onboarding from the schema alone. Shown only once a row exists. */}
        {created && (
          <div className="mt-6">
            <MockPanel datasourceId={created.id} />
          </div>
        )}

        {/* ── footer: Cancel + Connect data source (mock's wizard-foot) ─── */}
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <Button variant="ghost" onClick={() => router.push("/data-sources")}>Cancel</Button>
          <span className="text-sm text-muted">
            The DSN is write-only — the connection string never round-trips to the UI.
          </span>
          <Button onClick={connect} disabled={!tested?.ok || !canAct}>Connect data source</Button>
        </div>
      </Zone>
    </Page>
  );
}
