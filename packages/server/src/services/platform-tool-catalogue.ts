/**
 * Tools that are part of the PLATFORM, not of a demo dataset.
 * email-send-tool · US1 · plan.md Decision 6
 *
 * ── Why this is not `demoToolCatalogue()` ────────────────────────────────────
 *
 * `demo/tool-catalogue.ts` describes fifteen tools that exist to make a
 * demonstration work. They are seeded by `demo:seed`, they point at
 * `packages/ops-api` — a simulation — and a workspace without them is simply a
 * workspace with no demo data in it.
 *
 * `tether_email_send` is a different kind of thing. It is a **capability of the
 * product**: real delivery to real mailboxes, available to every workspace,
 * whether or not anyone ever ran a seed. Registering it from the demo catalogue
 * would mean the platform's only real-world side effect arrives as a side effect
 * of loading sample data, and disappears when someone decides not to.
 *
 * ⚠ **The tool points at Foundry, not at Microsoft.** `url` is
 * `${config.mail.selfBase}/api/mail/send`. That is the load-bearing decision of
 * the whole feature (plan.md Decision 1): Graph delivers to whatever the request
 * body names, so a tool aimed at `graph.microsoft.com` would hand the model the
 * destination and no recipient policy could exist.
 */
import type { z } from "zod";
import { config } from "../config/index.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { toolService, createToolSchema } from "./tool.service.js";
import { workspaceSecretService } from "./workspace-secret.service.js";
import { manifestBuilderService } from "./manifest-builder.service.js";
import { mailServiceKey, MAIL_SECRET_ENV, MAIL_KEY_HEADER } from "./mail-service-key.js";
import { EMAIL_TOOL_NAME, LLM_TOOL_NAME, WEB_FETCH_TOOL_NAME } from "./platform-tool-names.js";
import { WEB_KEY_HEADER, WEB_SECRET_ENV, webServiceKey } from "./web-service-key.js";
import { LLM_KEY_HEADER, LLM_SECRET_ENV, llmServiceKey } from "./llm-service-key.js";

type ToolSpec = z.input<typeof createToolSchema>;

/**
 * Re-exported for convenience. The canonical definition is in
 * `platform-tool-names.ts`, which `tool.service.ts` imports for its reserved-name
 * guard — the service cannot import this module, because this module imports the
 * service.
 */
export { EMAIL_TOOL_NAME, LLM_TOOL_NAME, WEB_FETCH_TOOL_NAME };

/**
 * ⚠ **The description is the drafter's only defence against picking the wrong
 * sender.** `mail_send` and `mail_send_template` are in the same manifest and
 * read like they do the same job — one of them delivers nothing. So this one opens
 * by saying it is real, states that omitting `to` is the normal case, and warns
 * that a named address must be allowlisted. The simulated pair open with
 * `SIMULATED (…)` for the same reason (T034).
 *
 * The "leave `to` unset" guidance is not a nicety. It is the only form that works
 * without an allowlist entry, it is what "email me" means, and it is the form in
 * which the model never has to produce an address and therefore cannot get one
 * wrong.
 */
export function platformToolCatalogue(): ToolSpec[] {
  return [
    {
      name: EMAIL_TOOL_NAME,
      method: "POST",
      url: `${config.mail.selfBase}/api/mail/send`,
      authStyle: "header",
      authParamName: MAIL_KEY_HEADER,
      secretEnvName: MAIL_SECRET_ENV,
      /**
       * ⚠ The tool-level description is where rendering guidance belongs, and the
       * reason is mechanical: it is NOT part of the ref fingerprint payload
       * (`refFingerprints()` hashes method, url and `paramsSchema`), so it can be
       * corrected without suspending a single armed flow. See the note on the
       * `body` param below, which cannot.
       */
      description:
        "REAL DELIVERY to a live mailbox — this is not the demo mail service. Sends one email, " +
        "formatted by Tether as a report: pass the upstream step's output in `body` and rows are " +
        "rendered as proper tables. Do NOT write HTML, markup or column padding yourself. Leave " +
        "`to` unset to send to the person who started the run; that is the normal case for 'email " +
        "me the result'. Any address you DO name must be on the workspace's allowed recipient list " +
        "or the call is refused and nothing is sent. There is NO `sender` parameter — the sender is " +
        "the workspace's configured mailbox and is never supplied by the flow. Do NOT pass `sender`, " +
        "`from`, `recipients` or `author`; the declared params are exactly `to`, `cc`, `subject`, " +
        "`body`, `attachments`, `attach_rows`, `attach_name`, `attach_format`. The simplest way to attach a " +
        "step's rows as a file is the three flat params: `attach_rows` = the step's records, `attach_name` " +
        "= the file name, `attach_format` = `csv` or `xlsx` (the extension is added if missing). No rows " +
        "means no file — the email still goes. For several files, pass `attachments` — either the file's TEXT " +
        "(`[{name: \"report.csv\", content: <the file's TEXT>}]`, text files only: .csv, .tsv, .txt, " +
        ".json) or structured ROWS to generate one (`[{name: \"headcount.xlsx\", format: \"xlsx\", " +
        "rows: <this step's records>}]` — format `csv` or `xlsx`; the name must end in the matching " +
        "extension). Generated files are built by Tether from the rows, so attaching a step's " +
        "output needs no hand-written CSV. For a LARGE report (more than a few thousand rows) build the file in the " +
        "step and attach it by path — `[{name: \"report.xlsx\", path: \"report.xlsx\"}]` — never thousands of rows " +
        "as data: one call carries at most 5 MB, a file up to 50 MB. A saved file may be .xlsx, .csv, .pdf, .docx, " +
        ".txt, .json or an image. At most 5 files and 50 MB in total (the param notes below still say 1.5 MB; this " +
        "sentence is current). Returns " +
        "{status, message_id, recipients[], cc[], attachments[]}.",
      paramsSchema: {
        subject: {
          type: "string",
          required: true,
          description: "Single line. Newlines are rejected. Max 250 chars.",
        },
        body: {
          type: "string",
          required: true,
          /**
           * ⚠ **BYTE-IDENTICAL ON PURPOSE — do not improve this sentence.**
           *
           * `refFingerprints()` hashes `paramsSchema` WHOLE
           * (`manifest-builder.service.ts`), and a fingerprint change means STALE:
           * it routes through `checkStaleness` → `markStale` → `status:
           * "suspended"`, which unarms every flow using this tool and removes its
           * Kestra schedule. Rewording a description here would therefore disarm
           * live automations to deliver a clearer sentence.
           *
           * The rendering guidance a drafter needs went into the tool-level
           * `description` above instead — that field is NOT in the fingerprint
           * payload, and it reaches the model through the same manifest.
           */
          description: "Plain-text message body — put the script output here.",
        },
        to: {
          type: "array",
          required: false,
          description:
            "Recipient addresses. OMIT to send to the person who started the run. Every address " +
            "given must pass the allowlist.",
        },
        cc: {
          type: "array",
          required: false,
          description: "Cc addresses. Subject to the same allowlist as `to`.",
        },
        /**
         * ⚠ **Adding this moved the ref fingerprint** — `refFingerprints()` hashes
         * `paramsSchema` whole — so every armed flow using this tool was
         * suspended once, on the deploy that added it, and must be re-approved.
         * The same bargain release/beta accepted; do not reword it casually for
         * the same reason `body`'s sentence above is frozen.
         */
        attachments: {
          type: "array",
          required: false,
          description:
            "Optional files: either text — [{name, content}] where content is the file's TEXT, " +
            "names ending .csv, .tsv, .txt or .json — or generated from rows — [{name, format, " +
            "rows}] with format `csv` or `xlsx` and rows an array of records, which builds the " +
            "file from the step's structured output (the name must end in the matching extension). " +
            "At most 5 files and 1.5 MB in total.",
        },
        /**
         * ⚠ The FLAT attachment — added in the SAME deploy as `attachments`, so the one fingerprint move
         * (and the one re-approval of armed email flows) covers both. Three ports because the engine can
         * bind a step's rows and fill two literals, and cannot build `attachments`' record.
         */
        attach_rows: {
          type: "string",
          required: false,
          description:
            "The records to attach as ONE generated file — pass a step's whole output, as you would to body " +
            "(an array of records works too). Needs attach_name. With no rows, no file is attached and the email is still sent.",
        },
        attach_name: {
          type: "string",
          required: false,
          description: "The attached file's name, e.g. \"overdue invoices\" or \"overdue.xlsx\". The extension is added from attach_format when missing.",
        },
        attach_format: {
          type: "string",
          required: false,
          description: "Attach the data as a file, csv or xlsx: set it when a CSV, Excel, spreadsheet or file report is asked for. Optional when attach_name ends in .csv or .xlsx.",
        },
      },
    },
    /**
     * The summary tool. Foundry's own `/api/llm/complete` (it was ops-api's until 2026-10-30), answered by the runtime
     * model set on the AI models page (not the builder's model, D-115). Its output is TERMINAL (D-34): read by a person,
     * never by a later step.
     */
    {
      name: LLM_TOOL_NAME,
      secretEnvName: LLM_SECRET_ENV,
      authStyle: "header",
      authParamName: LLM_KEY_HEADER,
      method: "POST",
      url: `${config.mail.selfBase}/api/llm/complete`,
      description:
        "Write text with a language model: give it an INSTRUCTION in plain English and the INPUT to work on, and it " +
        "returns {text}: prose or markdown of any length. Use it to summarise, rephrase, explain or draft: an email " +
        "body, a chat update, a written report of something an earlier step already worked out. " +
        "BOTH 'instruction' and 'input' are REQUIRED. 'input' is the data to work on, from an earlier step; never " +
        "invent it. " +
        "The output is NOT deterministic and nothing later may read it to decide anything: do not ask it to " +
        "classify, count, extract fields, choose recipients or return JSON. Do that in code. It also sources " +
        "nothing: it cannot fetch, browse, run code or call other tools, and must not be asked for facts that are " +
        "not in the input. " +
        "422 output_truncated means the answer hit max_tokens: raise it rather than using a partial document. " +
        "429 means the per-minute budget is spent.",
      paramsSchema: {
        instruction: {
          type: "string",
          required: true,
          description: 'What to do with the input, e.g. "summarise these findings in two short paragraphs for an email"',
        },
        input: {
          type: "string",
          required: true,
          description: "The text to work on, typically an earlier step's output. May be empty (nothing to report is a valid input).",
        },
        model: { type: "string", required: false, description: "Optional; must be one the operator enabled. Defaults to the configured model." },
        max_tokens: {
          type: "integer",
          required: false,
          description: "Output ceiling. Too low TRUNCATES and returns 422 rather than a half-written answer, so size it for the document asked for.",
        },
      },
    },
    /**
     * Read one public web address (2026-10-30). A step has no network, so this is how a workflow reads a feed, a page or
     * a public API. Foundry fetches it (`routes/web.ts`): public addresses only, checked when the connection opens; GET
     * or HEAD; the workspace's web access must be on. Every call is recorded.
     */
    {
      name: WEB_FETCH_TOOL_NAME,
      method: "POST",
      url: `${config.mail.selfBase}/api/web/fetch`,
      authStyle: "header",
      authParamName: WEB_KEY_HEADER,
      secretEnvName: WEB_SECRET_ENV,
      description:
        "Read one public web address: a news or RSS feed, a web page, a public JSON API. Returns {url, final_url, status, " +
        "content_type, bytes, truncated, title, text, data}: a JSON response is parsed into `data`; a web page comes back " +
        "in `text` as Markdown (pass raw=true to get its HTML instead); a feed, XML or plain text comes back in `text` " +
        "as it is, to parse in the step. " +
        "Public addresses only: private, internal and local addresses are refused. It reads; it does not sign in, send " +
        "data or submit forms. A site that answers an error fails the call. Large pages are cut at 5 MB (`truncated`). " +
        "Search works only where the site takes the search in its address (a news feed's search, a site's own " +
        "/search?q=). A page drawn by JavaScript in the browser may come back nearly empty: look for the site's feed " +
        "or API instead.",
      paramsSchema: {
        url: { type: "string", required: true, description: "The full address, starting with https:// (or http://)." },
        raw: {
          type: "boolean",
          required: false,
          description: "For a web page: true returns its HTML as it came, to parse in the step, instead of Markdown.",
        },
        method: {
          type: "string",
          required: false,
          description: "GET (the default) reads the address; HEAD only checks it is there and what type it is.",
        },
      },
    },
  ];
}

export type RegisterPlatformToolsResult = {
  created: string[];
  updated: string[];
  secretPut: boolean;
  manifestVersion: number | null;
};

/**
 * Idempotent upsert of the platform tools into one workspace, plus the workspace
 * secret holding the endpoint's derived key.
 *
 * ⚠ **Registered unconditionally, even when Graph is unconfigured** (T032). An
 * absent tool produces "unknown tool" and a wasted redraft cycle; a
 * present-but-unconfigured tool produces the `424` that names exactly which
 * variables to set. The second is a deployment telling the truth about itself.
 *
 * ⚠ The secret name is `FOUNDRY_MAIL_KEY`, deliberately **not** `MAIL_API_KEY` —
 * that name is already the *simulated* mail service's secret in demo workspaces,
 * and a collision would trip `shadowedSecretCollisions` and fail the step with a
 * confusing `409` about a secret the flow author never touched.
 */
export async function registerPlatformTools(
  workspaceId: string,
  opts: { rebuildManifest?: boolean } = {},
): Promise<RegisterPlatformToolsResult> {
  const catalogue = platformToolCatalogue();
  const existing = await toolRepo.listByWorkspace(workspaceId);
  const byName = new Map(existing.map((t) => [t.name, t]));

  const created: string[] = [];
  const updated: string[] = [];

  for (const spec of catalogue) {
    const found = byName.get(spec.name);
    if (found) {
      /**
       * The update path must carry `secretEnvName`/`authStyle`/`authParamName`
       * too. WS-B.5's measured failure: leaving them off the update meant
       * re-provisioning an existing workspace silently produced a tool with no
       * `<auth>` element, and every call 401'd.
       */
      await toolService.update(workspaceId, found.id, {
        url: spec.url,
        method: spec.method,
        description: spec.description,
        paramsSchema: spec.paramsSchema,
        secretEnvName: spec.secretEnvName ?? null,
        authStyle: spec.authStyle ?? null,
        authParamName: spec.authParamName ?? null,
      }, { platform: true });
      updated.push(spec.name);
    } else {
      // Parsed through the schema so zod defaults apply exactly as they would for
      // a request arriving over the API.
      await toolService.create(workspaceId, createToolSchema.parse(spec), { platform: true });
      created.push(spec.name);
    }
  }

  /**
   * The value is derived from `PARENT_API_KEY`, so re-running this puts an
   * identical value and the upsert is a no-op in effect.
   *
   * ⚠ After a `PARENT_API_KEY` rotation the derived key changes and this must be
   * re-run, or every email step answers 401 against a stale stored value.
   */
  await workspaceSecretService.put(
    workspaceId,
    MAIL_SECRET_ENV,
    mailServiceKey(),
    "Derived from PARENT_API_KEY. Authenticates Tether's own /api/mail/send endpoint. " +
      "Re-run `mail:register` after rotating PARENT_API_KEY.",
  );

  /**
   * A registered tool that is absent from the manifest is invisible to the
   * drafter, so the manifest is re-rendered here — matching `provision.ts` step 6.
   *
   * Opt-out exists for callers that register and then rebuild once themselves;
   * bumping the manifest version per tool would make the version a count of
   * registration calls rather than of catalogue changes.
   */
  // The summary tool's credential for Foundry's own /api/llm/complete, derived from PARENT_API_KEY like the mail key.
  await workspaceSecretService.put(
    workspaceId,
    LLM_SECRET_ENV,
    llmServiceKey(),
    "Derived from PARENT_API_KEY. Authenticates the llm_complete tool to Tether's own /api/llm/complete endpoint.",
  );

  // The web_fetch tool's credential for Foundry's own /api/web/fetch, derived from PARENT_API_KEY like the mail key.
  await workspaceSecretService.put(
    workspaceId,
    WEB_SECRET_ENV,
    webServiceKey(),
    "Derived from PARENT_API_KEY. Authenticates the web_fetch tool to Tether's own /api/web/fetch endpoint.",
  );

  let manifestVersion: number | null = null;
  if (opts.rebuildManifest !== false) {
    const manifest = await manifestBuilderService.buildAndPersist(workspaceId);
    manifestVersion = manifest?.version ?? null;
  }

  return { created, updated, secretPut: true, manifestVersion };
}
