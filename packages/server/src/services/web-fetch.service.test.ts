/**
 * `web_fetch`'s rules (2026-10-30). Nothing here reaches the internet: every case is a refusal decided before a
 * byte leaves, a conversion of a fixed string, or the workspace switch against the test database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { webFetches, workspaces } from "../db/schema.js";
import { workspaceRepo } from "../repositories/workspace.repo.js";
import { fetchPublic, guardedLookup, redactUrl, webFetch, WebFetchError } from "./web-fetch.service.js";
import { htmlTitle, htmlToMarkdown } from "./html-markdown.js";

const refusedWith = async (url: string) => {
  try {
    await fetchPublic(url);
  } catch (e) {
    return e as WebFetchError;
  }
  throw new Error(`${url} was not refused`);
};

describe("addresses web_fetch will not read", () => {
  it.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://localhost:4000/api/health", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "link-local"],
    ["http://10.0.0.5/", "private"],
    ["http://[::1]/", "loopback"],
    // the same loopback address spelled as one number — a literal check that only knew dotted quads would miss it
    ["http://2130706433/", "loopback"],
  ])("refuses %s", async (url, said) => {
    const e = await refusedWith(url);
    expect(e).toBeInstanceOf(WebFetchError);
    expect(e.statusCode).toBe(403);
    expect(e.message).toContain(said);
  });

  it("refuses what is not a public web address, saying what to give instead", async () => {
    expect((await refusedWith("ftp://example.com/x")).statusCode).toBe(400);
    expect((await refusedWith("not an address")).message).toContain("https://");
    expect((await refusedWith("https://user:pw@example.com/")).message).toContain("does not sign in");
  });

  it("the lookup a connection uses refuses a name that resolves somewhere private — checked when the socket opens", async () => {
    const err = await new Promise<Error | null>((resolve) => guardedLookup("localhost", {}, (e) => resolve(e)));
    expect(err).toBeInstanceOf(WebFetchError);
    expect(err!.message).toContain("loopback");
  });
});

describe("what a fetch records", () => {
  it("keeps the address but not a credential in it", () => {
    expect(redactUrl("https://api.example.com/v1/items?q=news&api_key=abc123&token=t")).toBe(
      "https://api.example.com/v1/items?q=news&api_key=%5Bredacted%5D&token=%5Bredacted%5D",
    );
  });
});

describe("a web page as Markdown", () => {
  const page = `<!doctype html><html><head><title>Tech &amp; News</title><style>.x{}</style><script>alert(1)</script></head>
    <body><nav><a href="/home">Home</a></nav>
    <h1>Latest</h1><p>First <strong>story</strong> &mdash; <a href="/a/1">read it</a></p>
    <ul><li>One</li><li>Two</li></ul>
    <table><tr><th>Name</th><th>Price</th></tr><tr><td>A</td><td>1</td></tr></table>
    <footer>© 2026</footer></body></html>`;

  it("keeps the words, the headings, the lists and the links (made absolute); drops scripts, styles and furniture", () => {
    const md = htmlToMarkdown(page, "https://news.example.com/today");
    expect(md).toContain("# Latest");
    expect(md).toContain("First **story** — [read it](https://news.example.com/a/1)");
    expect(md).toContain("- One");
    expect(md).toContain("| Name | Price |");
    expect(md).not.toContain("alert");
    expect(md).not.toContain(".x{}");
    expect(md).not.toContain("Home"); // nav
    expect(md).not.toContain("2026"); // footer
    expect(htmlTitle(page)).toBe("Tech & News");
  });
});

describe("the workspace's web access", () => {
  const stamp = Date.now().toString(36);
  let wsId = "";
  afterAll(async () => {
    if (wsId) await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("switched off: refused before anything is dialled, with who can switch it on — and recorded", async () => {
    const ws = await workspaceRepo.create({ name: `web ${stamp}`, tenantSlug: "webtest", slug: `web-${stamp}` });
    wsId = ws!.id;
    await db.update(workspaces).set({ webAccess: false }).where(eq(workspaces.id, wsId));
    const e = (await webFetch(wsId, "https://example.com/", { sessionId: "s1" }).catch((x: unknown) => x)) as WebFetchError;
    expect(e).toBeInstanceOf(WebFetchError);
    expect(e.statusCode).toBe(403);
    expect(e.message).toContain("admins can switch it on");
    const rows = await db.select().from(webFetches).where(eq(webFetches.workspaceId, wsId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.sessionId).toBe("s1");
  });

  it("switched on: the address rules still hold, and the refusal is recorded too", async () => {
    await db.update(workspaces).set({ webAccess: true }).where(eq(workspaces.id, wsId));
    const e = (await webFetch(wsId, "http://169.254.169.254/latest/meta-data/", { executionId: null, stepId: "read" }).catch((x: unknown) => x)) as WebFetchError;
    expect(e.statusCode).toBe(403);
    const rows = await db.select().from(webFetches).where(eq(webFetches.workspaceId, wsId));
    expect(rows.map((r) => r.ok)).toEqual([false, false]);
    expect(rows.find((r) => r.stepId === "read")!.error).toContain("link-local");
  });
});
