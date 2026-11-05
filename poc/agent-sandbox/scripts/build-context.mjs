#!/usr/bin/env node
/**
 * Build agent-visible context/ from fixtures via openredaction (sole privacy layer).
 * Walks JSON string values so numeric fields are not false-positive-redacted.
 *
 * Note: openredaction ignores RFC 2606 `.example` emails; fixtures use
 * detectable addresses so the library is the real scrubber (not a hand-roll).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SANDBOX = join(ROOT, "sandbox");
const CTX = join(SANDBOX, "context");

async function loadOpenRedaction() {
  const mod = await import("@openredaction/core");
  return mod.OpenRedaction;
}

async function redactString(redactor, text) {
  if (!text || typeof text !== "string") return text;
  const result = await redactor.detect(text);
  return result.redacted ?? text;
}

async function redactDeep(redactor, value) {
  if (typeof value === "string") return redactString(redactor, value);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await redactDeep(redactor, v));
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await redactDeep(redactor, v);
    }
    return out;
  }
  return value;
}

function assertNoRawPii(text, label, forbidden) {
  for (const f of forbidden) {
    if (text.includes(f)) {
      throw new Error(`PII leak in ${label}: ${f}`);
    }
  }
}

export async function buildContext() {
  mkdirSync(CTX, { recursive: true });
  const OpenRedaction = await loadOpenRedaction();
  const redactor = new OpenRedaction({
    redactionMode: "placeholder",
    includeEmails: true,
    includeNames: true,
  });

  const schemaObj = JSON.parse(
    readFileSync(join(SANDBOX, "fixtures", "schema.json"), "utf8"),
  );
  const invoices = JSON.parse(
    readFileSync(join(SANDBOX, "fixtures", "invoices.json"), "utf8"),
  );

  const forbidden = [];
  for (const row of invoices) {
    for (const k of ["customer_name", "customer_email", "billing_email"]) {
      if (row[k]) forbidden.push(String(row[k]));
    }
  }

  const sample = {
    note: "Sample rows (PII redacted via openredaction). Use column names from schema only.",
    overdue_count: invoices.filter((r) => r.status === "overdue").length,
    sample_rows: invoices.slice(0, 2),
  };

  const schemaOut = JSON.stringify(await redactDeep(redactor, schemaObj), null, 2);
  const sampleOut = JSON.stringify(await redactDeep(redactor, sample), null, 2);

  writeFileSync(join(CTX, "schema.json"), schemaOut + "\n", "utf8");
  writeFileSync(join(CTX, "samples.json"), sampleOut + "\n", "utf8");
  writeFileSync(
    join(CTX, "README.md"),
    [
      "# Agent context (PII-scrubbed by openredaction)",
      "",
      "Built by `scripts/build-context.mjs`. Do not read `fixtures/` for values.",
      "",
      "Ambiguity: both `customer_email` and `billing_email` exist.",
      "Ask via `questions.json` which to use for notification `to`.",
      "",
    ].join("\n"),
    "utf8",
  );

  assertNoRawPii(schemaOut + "\n" + sampleOut, "context", forbidden);
  return { ok: true, files: ["schema.json", "samples.json", "README.md"], scrubbed: forbidden.length };
}

async function main() {
  try {
    const r = await buildContext();
    console.log(`CONTEXT OK — scrubbed ${r.scrubbed} PII values via openredaction`);
    process.exit(0);
  } catch (e) {
    console.error("CONTEXT FAIL:", e.message);
    process.exit(1);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
