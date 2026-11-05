/**
 * A tool's parameter descriptions must survive the edit form.
 *
 * ── The defect this pins ─────────────────────────────────────────────────────
 *
 * `jsonSchemaToParams` read only `type` and `paramsToJsonSchema` wrote only
 * `type`. So opening any tool in the edit modal and pressing Save — with no
 * edits at all — silently deleted every parameter description in it.
 *
 * Two consequences, and the second is why this is a test and not a note:
 *
 *  1. Those descriptions are the only place the flow drafter learns what a
 *     parameter means. `mail_send`'s `recipients` went from "one address or an
 *     array of up to 50" to a bare `array`.
 *  2. `refFingerprints()` hashes the WHOLE `paramsSchema`, so removing keys
 *     changes the tool's fingerprint — and the staleness sweep then marks every
 *     flow using that tool `suspended` and removes its Kestra schedule. Pressing
 *     Save on an unchanged tool disarmed automations.
 *
 * The assertion is therefore an IDENTITY: read a stored schema, write it back
 * unchanged, and require the result to be deep-equal. A test that only checked
 * "description is present" would pass while `required` quietly moved.
 */
import { describe, expect, it } from "vitest";
import { toolFromFA, toolInputToFA } from "./adapters.js";
import type { FATool } from "./foundry-client.js";

/** The flat shape `demo/tool-catalogue.ts` stores and the manifest builder reads. */
const STORED = {
  sender: { type: "string", required: true, description: "From address" },
  recipients: { type: "array", required: true, description: "One address or an array of up to 50" },
  cc: { type: "array", required: false, description: "Optional cc addresses" },
  subject: { type: "string", required: true, description: "Subject line" },
};

const TOOL: FATool = {
  id: "t1",
  workspaceId: "w1",
  name: "mail_send",
  description: "Send one email.",
  url: "http://ops.example/mail/send",
  method: "POST",
  kind: "real",
  isActive: true,
  paramsSchema: STORED,
} as unknown as FATool;

describe("tool parameter descriptions survive the edit form", () => {
  it("reads every description off a stored tool", () => {
    const params = toolFromFA(TOOL).params ?? [];
    expect(params.map((p) => p.name).sort()).toEqual(["cc", "recipients", "sender", "subject"]);
    expect(params.find((p) => p.name === "recipients")?.description).toBe(
      "One address or an array of up to 50",
    );
    expect(params.find((p) => p.name === "cc")?.required).toBe(false);
    expect(params.find((p) => p.name === "sender")?.required).toBe(true);
  });

  it("writes them back BYTE-IDENTICALLY on an untouched save", () => {
    // The whole defect, in one assertion. Anything this loses changes the ref
    // fingerprint and suspends every flow that uses the tool.
    const t = toolFromFA(TOOL);
    const { body } = toolInputToFA({
      name: t.name,
      description: t.description,
      type: t.type,
      endpoint: t.endpoint,
      params: t.params,
    });
    expect(body.paramsSchema).toEqual(STORED);
  });

  it("emits the FLAT shape the manifest builder reads, not a JSON-Schema envelope", () => {
    // `manifest-builder.service.ts` does `Object.entries(paramsSchema)` and reads
    // `type`/`required`/`description` off each value. A `{type, properties}`
    // envelope would render two nonsense params called "type" and "properties".
    const { body } = toolInputToFA({
      name: "x",
      endpoint: "https://api.example/x",
      params: [{ name: "id", dataType: "integer", required: true, description: "Ticket key" }],
    });
    const schema = body.paramsSchema as Record<string, unknown>;
    expect(Object.keys(schema)).toEqual(["id"]);
    expect(schema.id).toEqual({ type: "integer", required: true, description: "Ticket key" });
  });

  it("still reads a JSON-Schema {properties, required} tool", () => {
    // Not hypothetical: this is what the form itself wrote before the fix, so
    // any tool created through the UI is in this shape.
    const legacy = {
      ...TOOL,
      paramsSchema: {
        type: "object",
        properties: { note: { type: "string", description: "Free text" } },
        required: ["note"],
      },
    } as unknown as FATool;
    const params = toolFromFA(legacy).params ?? [];
    expect(params).toEqual([
      { name: "note", dataType: "string", required: true, description: "Free text" },
    ]);
  });

  it("omits an empty description rather than storing a blank string", () => {
    // A blank `description: ""` is a key that was not there before, and adding
    // keys moves the fingerprint just as surely as removing them.
    const { body } = toolInputToFA({
      name: "x",
      endpoint: "https://api.example/x",
      params: [{ name: "id", dataType: "string", required: false, description: "   " }],
    });
    expect(body.paramsSchema).toEqual({ id: { type: "string", required: false } });
  });
});
