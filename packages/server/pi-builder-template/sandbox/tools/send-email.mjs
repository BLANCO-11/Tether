#!/usr/bin/env node
/**
 * Email a finished file or a short note to the person you are talking with. Use it only when they ask to get the result by
 * email; never on your own initiative.
 *
 *   node tools/send-email.mjs --subject "<one line>" --body-file scratch/mail.md [--attach out/report.pdf ...]
 *   node tools/send-email.mjs --subject "<one line>" --body "<short text>" [--attach ...]
 *
 * It emails the person you are talking with, at their own address. You cannot choose the recipient. Files are paths in
 * this chat's folder (usually out/). Allowed types: pdf, xlsx, csv, docx, png, jpg, webp, txt, md.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = [
  'Usage: node tools/send-email.mjs --subject "<one line>" --body-file scratch/mail.md [--attach out/report.pdf ...]',
  '       node tools/send-email.mjs --subject "<one line>" --body "<short text>" [--attach ...]',
];
const usage = () => {
  for (const line of USAGE) console.error(line);
  process.exit(2);
};

const opts = { attach: [] };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  let flag = args[i];
  let value;
  const eq = flag.match(/^(--[a-z-]+)=(.*)$/s);
  if (eq) {
    flag = eq[1];
    value = eq[2];
  }
  const name = flag.startsWith("--") ? flag.slice(2) : "";
  if (!["subject", "body", "body-file", "attach"].includes(name)) usage();
  if (value === undefined) {
    if (i + 1 >= args.length) usage();
    value = args[++i];
  }
  if (name === "attach") opts.attach.push(value);
  else opts[name] = value;
}

const { subject, body: inlineBody, "body-file": bodyFile, attach } = opts;
if (!subject?.trim() || (inlineBody === undefined) === (bodyFile === undefined)) usage();

let body = inlineBody;
if (bodyFile !== undefined) {
  try {
    body = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), bodyFile), "utf8");
  } catch {
    console.error(`Not sent: cannot read ${bodyFile}`);
    process.exit(1);
  }
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(new URL("../.forge-tool.json", import.meta.url), "utf8"));
} catch {
  console.error("Sending email is not available in this conversation.");
  process.exit(1);
}
const payload = { subject, body };
if (attach.length) payload.attachments = attach;
const res = await fetch(`${cfg.url}/mail`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forge-token": cfg.token },
  body: JSON.stringify(payload),
});
const text = await res.text();
if (!res.ok) {
  let why = text;
  try {
    const b = JSON.parse(text);
    why = b.message ?? (typeof b.error === "string" ? b.error : text);
  } catch {
    /* plain text */
  }
  console.error(`Not sent: ${why}`);
  process.exit(1);
}
const out = JSON.parse(text);
console.log(`Sent to ${out.sentTo}`);
for (const a of out.attachments ?? []) console.log(`  attached ${a.name} (${a.bytes} bytes)`);
