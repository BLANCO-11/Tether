/**
 * A platform-managed tool cannot be created, repointed or deleted by hand.
 * email-send-tool · T046/T047 · plan.md Decision 1 (applied a second time)
 *
 * ── The exposure this closes ─────────────────────────────────────────────────
 *
 * The tools page offers **Edit** and **Remove** on every row and `routes/tools.ts`
 * backs both with no exemptions. Left alone, `tether_email_send` could be:
 *
 *  - **deleted**, breaking every armed flow that references it by name — a flow
 *    that was approved and is now unrunnable, for a reason the flow does not
 *    mention;
 *  - **repointed** at another host, which the executor would then hand
 *    `FOUNDRY_MAIL_KEY` to on the next email step;
 *  - **pre-empted**, by a user creating their own tool under the name before
 *    `mail:register` runs — after which the registrar would update THEIR row and
 *    the mail key would go wherever they chose.
 *
 * ⚠ None of that is a *new* class of problem: any workspace admin can already
 * repoint any tool and read any secret. That is exactly why the fix is a cheap
 * name check and not a permissions redesign — the realistic event is accidental
 * deletion of a tool nobody knew was platform-managed.
 */
import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { workspaceService } from "./workspace.service.js";
import { toolService, createToolSchema } from "./tool.service.js";
import { toolRepo } from "../repositories/tool.repo.js";
import { EMAIL_TOOL_NAME, LLM_TOOL_NAME, PLATFORM_TOOL_NAMES, WEB_FETCH_TOOL_NAME } from "./platform-tool-names.js";
import { registerPlatformTools } from "./platform-tool-catalogue.js";

const created: string[] = [];

async function makeWorkspace(name: string) {
  const ws = await workspaceService.create({ name });
  created.push(ws.id);
  return ws.id;
}

/** The platform tool's row in a freshly created workspace (registered by T032). */
async function platformTool(workspaceId: string) {
  const tools = await toolRepo.listByWorkspace(workspaceId);
  const found = tools.find((t) => t.name === EMAIL_TOOL_NAME);
  if (!found) throw new Error("platform tool was not registered — T032 regression");
  return found;
}

afterAll(async () => {
  if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  await pool.end();
});

describe("the reserved-name list", () => {
  it("names tether_email_send", () => {
    expect(PLATFORM_TOOL_NAMES).toContain(EMAIL_TOOL_NAME);
  });
});

describe("create", () => {
  it("refuses a hand-created tool under the reserved name", async () => {
    // ⚠ The pre-emption case. Without this, a user could take the name first and
    // `mail:register` would then update their row — pointing the mail key at a
    // host of their choosing.
    const workspaceId = await makeWorkspace("Reserved — create");

    await expect(
      toolService.create(
        workspaceId,
        createToolSchema.parse({
          name: EMAIL_TOOL_NAME,
          method: "POST",
          url: "https://attacker.example/collect",
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("names the remedy in the refusal", async () => {
    const workspaceId = await makeWorkspace("Reserved — create remedy");
    await expect(
      toolService.create(
        workspaceId,
        createToolSchema.parse({
          name: EMAIL_TOOL_NAME,
          method: "POST",
          url: "https://example.com/x",
        }),
      ),
    ).rejects.toThrow(/platform:tools/);
  });

  it("leaves every other name alone", async () => {
    const workspaceId = await makeWorkspace("Reserved — other names ok");
    const tool = await toolService.create(
      workspaceId,
      createToolSchema.parse({
        name: "my_own_mailer",
        method: "POST",
        url: "https://example.com/send",
      }),
    );
    expect(tool.name).toBe("my_own_mailer");
  });
});

describe("update", () => {
  it("refuses an edit to the platform tool", async () => {
    // ⚠ The repointing case: the executor hands this tool `FOUNDRY_MAIL_KEY`, so
    // whoever controls its `url` receives that credential.
    const workspaceId = await makeWorkspace("Reserved — update");
    const tool = await platformTool(workspaceId);

    await expect(
      toolService.update(workspaceId, tool.id, { url: "https://attacker.example/collect" }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // And the row is untouched.
    const after = await platformTool(workspaceId);
    expect(after.url).toBe(tool.url);
  });

  it("refuses a RENAME of the platform tool", async () => {
    // Checked against the target row's name, not the input's — otherwise renaming
    // it to something else would be a way to escape the guard and then edit freely.
    const workspaceId = await makeWorkspace("Reserved — rename away");
    const tool = await platformTool(workspaceId);

    await expect(
      toolService.update(workspaceId, tool.id, { name: "harmless_name" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses renaming an ordinary tool INTO the reserved name", async () => {
    const workspaceId = await makeWorkspace("Reserved — rename into");
    const ordinary = await toolService.create(
      workspaceId,
      createToolSchema.parse({
        name: "ordinary_tool",
        method: "POST",
        url: "https://example.com/x",
      }),
    );

    await expect(
      toolService.update(workspaceId, ordinary.id, { name: EMAIL_TOOL_NAME }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("still allows editing an ordinary tool", async () => {
    const workspaceId = await makeWorkspace("Reserved — ordinary edit");
    const ordinary = await toolService.create(
      workspaceId,
      createToolSchema.parse({
        name: "ordinary_editable",
        method: "POST",
        url: "https://example.com/x",
      }),
    );

    const updated = await toolService.update(workspaceId, ordinary.id, {
      url: "https://example.com/y",
    });
    expect(updated?.url).toBe("https://example.com/y");
  });
});

describe("remove", () => {
  it("refuses deletion of the platform tool", async () => {
    // ⚠ The likely accident, and the reason this task exists. Deleting it breaks
    // every armed flow that references it by name.
    const workspaceId = await makeWorkspace("Reserved — remove");
    const tool = await platformTool(workspaceId);

    await expect(toolService.remove(workspaceId, tool.id)).rejects.toMatchObject({
      statusCode: 409,
    });

    // Still there.
    await expect(platformTool(workspaceId)).resolves.toBeTruthy();
  });

  it("still allows deleting an ordinary tool", async () => {
    const workspaceId = await makeWorkspace("Reserved — ordinary remove");
    const ordinary = await toolService.create(
      workspaceId,
      createToolSchema.parse({
        name: "ordinary_removable",
        method: "POST",
        url: "https://example.com/x",
      }),
    );
    expect(await toolService.remove(workspaceId, ordinary.id)).toBeTruthy();
  });
});

describe("the platform registrar is the one legitimate writer", () => {
  it("registerPlatformTools works despite the guard", async () => {
    // ⚠ The guard would otherwise lock out the only thing allowed to maintain the
    // tool, which would make the whole feature un-provisionable. `{platform: true}`
    // is the explicit, greppable opt-in.
    const workspaceId = await makeWorkspace("Reserved — registrar");
    const r = await registerPlatformTools(workspaceId);
    expect(r.updated).toEqual([EMAIL_TOOL_NAME, LLM_TOOL_NAME, WEB_FETCH_TOOL_NAME]);
  });

  it("recreates the tool after a forced removal, so the remedy in the refusal is true", async () => {
    // The refusal tells the reader to run `mail:register`. That claim is only
    // honest if the registrar can in fact restore a deleted row.
    const workspaceId = await makeWorkspace("Reserved — restore");
    const tool = await platformTool(workspaceId);

    // Bypassing the guard the way the registrar does, to simulate a row that is
    // gone (a direct DB delete, or a deletion from before the guard existed).
    await toolService.remove(workspaceId, tool.id, { platform: true });
    const gone = await toolRepo.listByWorkspace(workspaceId);
    expect(gone.find((t) => t.name === EMAIL_TOOL_NAME)).toBeUndefined();

    const r = await registerPlatformTools(workspaceId);
    expect(r.created).toEqual([EMAIL_TOOL_NAME]);
    await expect(platformTool(workspaceId)).resolves.toBeTruthy();
  });
});
