/**
 * A tool registered with a path template is callable (phase 7, R03).
 * `…/hr/employees/{id}/manager` answered "id must be an integer, got \"{id}\"" on
 * every call from every flow: the value went to the query string instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dialled: Array<{ url: string; init: RequestInit }> = [];
vi.mock("@foundry/shared", async (orig) => {
  const m = await orig<typeof import("@foundry/shared")>();
  return {
    ...m,
    guardedFetch: vi.fn(async (url: URL | string, init: RequestInit) => {
      dialled.push({ url: String(url), init });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  };
});

import { dialTool, fillPathParams } from "./tool-invoke.js";

beforeEach(() => void (dialled.length = 0));

describe("fillPathParams", () => {
  it("fills each {name} from the params, encoded, and keeps the rest for the query or body", () => {
    expect(fillPathParams("t", "http://h/hr/employees/{id}/manager", { id: 2, fields: "x" })).toEqual({
      url: "http://h/hr/employees/2/manager",
      rest: { fields: "x" },
    });
    // A value cannot add a path segment or a query.
    expect(fillPathParams("t", "http://h/x/{code}", { code: "a/b?c" }).url).toBe("http://h/x/a%2Fb%3Fc");
    // A URL with no template is untouched.
    expect(fillPathParams("t", "http://h/x", { id: 1 })).toEqual({ url: "http://h/x", rest: { id: 1 } });
  });
  it("refuses a missing or non-scalar value by name, before anything is sent", () => {
    expect(() => fillPathParams("hr_get_manager", "http://h/e/{id}", {})).toThrow(/needs `id`/);
    expect(() => fillPathParams("t", "http://h/e/{id}", { id: [1, 2] })).toThrow(/single value/);
  });
});

describe("dialTool sends the filled URL", () => {
  it("GET: the id is in the path, not the query string", async () => {
    await dialTool({
      tool: { name: "hr_get_manager", url: "http://h:4004/hr/employees/{id}/manager" } as never,
      auth: { style: "none", paramName: null, value: null } as never,
      method: "GET",
      params: { id: 2 },
    });
    expect(dialled[0]!.url).toBe("http://h:4004/hr/employees/2/manager");
  });
  it("POST: a path parameter does not also travel in the body", async () => {
    await dialTool({
      tool: { name: "t", url: "http://h/orgs/{org}/tickets" } as never,
      auth: { style: "none", paramName: null, value: null } as never,
      method: "POST",
      params: { org: "acme", title: "x" },
    });
    expect(dialled[0]!.url).toBe("http://h/orgs/acme/tickets");
    expect(JSON.parse(String(dialled[0]!.init.body))).toEqual({ title: "x" });
  });
});
