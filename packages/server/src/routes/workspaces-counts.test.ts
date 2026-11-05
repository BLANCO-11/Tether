/**
 * `GET /api/workspaces?with=counts` — what each workspace holds, for the Workspaces page's cards.
 *
 * The property that matters is that each count belongs to ITS workspace: a count joined on the wrong key reads as
 * plausible numbers on every card. So two workspaces, different contents, and each asserted separately.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { workspaceMembers, workspaces } from "../db/schema.js";
import { countsFor } from "./workspaces.js";

const created: string[] = [];

beforeAll(async () => {
  const rows = await db
    .insert(workspaces)
    .values([{ name: `counts test A ${Date.now()}` }, { name: `counts test B ${Date.now()}` }])
    .returning();
  created.push(...rows.map((r) => r.id));
  await db.insert(workspaceMembers).values([
    { workspaceId: created[0]!, subject: "s-1", email: "a@acme.example", role: "author", grantedBy: "test" },
    { workspaceId: created[0]!, subject: "s-2", email: "b@acme.example", role: "admin", grantedBy: "test" },
  ]);
});

afterAll(async () => {
  if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
});

describe("countsFor", () => {
  it("counts each workspace's own rows, and zeroes a workspace that holds nothing", async () => {
    const c = await countsFor(created);
    expect(c[created[0]!]).toEqual({ workflows: 0, live: 0, datasources: 0, members: 2, lastRunAt: null });
    // The control: B holds nothing, so a count joined on the wrong key would show here.
    expect(c[created[1]!]).toEqual({ workflows: 0, live: 0, datasources: 0, members: 0, lastRunAt: null });
  });

  it("asks nothing for no workspaces", async () => {
    expect(await countsFor([])).toEqual({});
  });
});
