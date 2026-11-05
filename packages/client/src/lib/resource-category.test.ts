/**
 * `lib/resource-category.ts` — the ONE category definition.
 *
 * This module exists because `/resources` (the `?type=` tabs) and `/resources/[id]`
 * (whether to show the Schema and DB operations panes) must answer "is this a
 * datasource" identically. These tests pin the answers, including the branch order,
 * so a tidy-up that reorders them fails here rather than silently changing which
 * resources get the panes.
 */
import { describe, expect, it } from "vitest";
import type { Connection } from "./types";
import { categoryFor, isDatasourceResource, VALID_RESOURCE_TYPES } from "./resource-category";

function conn(connector_id: string): Connection {
  return { id: "c", name: "n", connector_id, status: "ready" } as Connection;
}

describe("categoryFor", () => {
  it("treats database engines as datasources", () => {
    for (const id of ["postgres", "postgresql", "mysql", "s3", "sftp"]) {
      expect(categoryFor(conn(id)), id).toBe("datasource");
    }
  });

  it("treats messaging and generic connectors as connectors", () => {
    for (const id of ["email", "rest", "slack", "some-connector"]) {
      expect(categoryFor(conn(id)), id).toBe("connector");
    }
  });

  it("treats tools and apps as tools", () => {
    for (const id of ["tool", "my-tool", "app"]) {
      expect(categoryFor(conn(id)), id).toBe("tool");
    }
  });

  it("falls back to datasource for an unknown connector id", () => {
    expect(categoryFor(conn("something-nobody-has-heard-of"))).toBe("datasource");
  });

  it("is case-insensitive", () => {
    expect(categoryFor(conn("POSTGRES"))).toBe("datasource");
    expect(categoryFor(conn("Slack"))).toBe("connector");
  });

  it("survives a missing connector id rather than throwing", () => {
    expect(categoryFor({ id: "c", name: "n" } as Connection)).toBe("datasource");
  });

  // ⚠ ORDER TRAP: connector is tested before tool. An id carrying both words must
  // keep resolving the way the resources list has always resolved it. If someone
  // reorders the branches "for readability", this is what goes red.
  it("resolves connector before tool when an id carries both words", () => {
    expect(categoryFor(conn("connector-tool"))).toBe("connector");
  });
});

describe("isDatasourceResource", () => {
  it("is true exactly for the datasource category", () => {
    expect(isDatasourceResource(conn("postgres"))).toBe(true);
    // Both directions: a predicate that is never false would pass a one-sided test
    // while showing the datasource panes on every resource in the product.
    expect(isDatasourceResource(conn("slack"))).toBe(false);
    expect(isDatasourceResource(conn("tool"))).toBe(false);
  });
});

describe("VALID_RESOURCE_TYPES", () => {
  it("holds the three categories the tabs offer", () => {
    expect([...VALID_RESOURCE_TYPES]).toEqual(["datasource", "connector", "tool"]);
  });
});
