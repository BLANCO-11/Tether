/**
 * The server never reads a conversation's file through a link out of its folder (sandbox-fs.ts `confined`): Forge can
 * write anything there, and a link to a server file would have the server read it, show it and store it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SANDBOXES_ROOT } from "./paths.js";
import { confined, readBundle } from "./sandbox-fs.js";
import { outSnapshot, readAttachment } from "./attachments.js";

const ws = `test-${randomUUID()}`;
const a = randomUUID();
const b = randomUUID();
const sbx = (sid: string) => join(SANDBOXES_ROOT, ws, sid, "sandbox");
for (const sid of [a, b]) mkdirSync(join(sbx(sid), "steps", "s1"), { recursive: true });
const secret = join(SANDBOXES_ROOT, ws, "server-secret.txt");
writeFileSync(secret, "PARENT_API_KEY=xyz");
afterAll(() => rmSync(join(SANDBOXES_ROOT, ws), { recursive: true, force: true }));

describe("confined", () => {
  it("is true inside the folder, false through a link out of it or into another conversation", () => {
    writeFileSync(join(sbx(a), "workflow.json"), "{}");
    expect(confined(join(sbx(a), "workflow.json"))).toBe(true);
    symlinkSync(secret, join(sbx(a), "leak.txt"));
    expect(confined(join(sbx(a), "leak.txt"))).toBe(false);
    writeFileSync(join(sbx(b), "theirs.txt"), "b's");
    symlinkSync(join(sbx(b), "theirs.txt"), join(sbx(a), "other.txt"));
    expect(confined(join(sbx(a), "other.txt"))).toBe(false);
  });
});

describe("the server's readers", () => {
  it("leave out a step file that is a link, a workflow.json that is a link, and an out/ folder that is a link", () => {
    writeFileSync(join(sbx(a), "steps", "s1", "main.py"), "print(1)");
    symlinkSync(secret, join(sbx(a), "steps", "s1", "evil.py"));
    const bundle = readBundle(ws, a);
    expect(Object.keys(bundle.files)).toEqual(["steps/s1/main.py"]);

    rmSync(join(sbx(b), "workflow.json"), { force: true });
    symlinkSync(secret, join(sbx(b), "workflow.json"));
    expect(readBundle(ws, b).workflow).toEqual({ steps: [] });

    symlinkSync(join(SANDBOXES_ROOT, ws), join(sbx(b), "out"));
    expect(outSnapshot(ws, b).size).toBe(0);

    mkdirSync(join(sbx(a), "files"), { recursive: true });
    symlinkSync(secret, join(sbx(a), "files", "rates.csv"));
    expect(readAttachment(ws, a, "rates.csv")).toBeNull();
  });
});
